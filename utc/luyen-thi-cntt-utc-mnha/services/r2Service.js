// services/r2Service.js — Cloudflare R2 (API tương thích S3) cho Slide bài học / Tài liệu học tập: TRÌNH DUYỆT up THẲNG lên R2.
//
//   Vì sao: file đi qua Vercel (up khung → server gom lại → ghi GitHub) tốn băng thông Vercel 2–3 lần dung lượng file.
//   Ở đây server chỉ KÝ URL PUT cho từng file-phần (đúng 1 key, hết hạn sau PUT_TTL giây, khoá R2 không rời server);
//   trình duyệt mã hoá (SLD2) rồi PUT thẳng lên R2. Server chỉ HEAD + đọc vài chục byte header để kiểm tra.
//
//   Biến môi trường (thiếu 1 trong 4 biến đầu → isConfigured() = false → dùng luồng GitHub cũ):
//     R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
//     R2_ENDPOINT      (tuỳ chọn, mặc định https://<account>.r2.cloudflarestorage.com)
//     R2_PUBLIC_BASE   (tuỳ chọn: bucket bật Public / custom domain → trình duyệt tải thẳng, không cần ký GET)
//     STUDYFILE_DIRECT=off   tắt up thẳng dù đã có R2
//   Bucket phải bật CORS (GET, PUT, HEAD từ domain web) — xem STUDYFILES.md.
'use strict';
const crypto = require('crypto');

const env = (k) => String(process.env[k] || '').trim();
const PUT_TTL = 2 * 60 * 60;        // URL PUT sống 2 giờ (file 100MB trên mạng chậm vẫn kịp)
const GET_TTL = 6 * 60 * 60;
const trim = (u) => String(u || '').replace(/\/+$/, '');
const encPath = (k) => String(k).split('/').map(encodeURIComponent).join('/');

function config() {
    const accountId = env('R2_ACCOUNT_ID'), bucket = env('R2_BUCKET');
    const accessKeyId = env('R2_ACCESS_KEY_ID'), secretAccessKey = env('R2_SECRET_ACCESS_KEY');
    if (!accountId || !bucket || !accessKeyId || !secretAccessKey) return null;
    return {
        accountId, bucket, accessKeyId, secretAccessKey, region: env('R2_REGION') || 'auto',
        endpoint: trim(env('R2_ENDPOINT')) || `https://${accountId}.r2.cloudflarestorage.com`,
        publicBase: trim(env('R2_PUBLIC_BASE'))
    };
}
const isConfigured = () => env('STUDYFILE_DIRECT') !== 'off' && !!config();
const need = () => { const c = config(); if (!c) throw new Error('Chưa cấu hình Cloudflare R2 (R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY).'); return c; };

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const qs = (o) => Object.keys(o).sort().map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(o[k]))).join('&');

/** URL ký sẵn (SigV4, query string) cho 1 method + 1 key. Chỉ ký header host nên trình duyệt gửi header nào cũng được. */
function presign(method, key, expires = GET_TTL, now = new Date()) {
    const c = need();
    const url = `${c.endpoint}/${encodeURIComponent(c.bucket)}/${encPath(key)}`;
    const u = new URL(url);
    const z = (n) => String(n).padStart(2, '0');
    const day = `${now.getUTCFullYear()}${z(now.getUTCMonth() + 1)}${z(now.getUTCDate())}`;
    const stamp = `${day}T${z(now.getUTCHours())}${z(now.getUTCMinutes())}${z(now.getUTCSeconds())}Z`;
    const scope = `${day}/${c.region}/s3/aws4_request`;
    const q = qs({
        'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${c.accessKeyId}/${scope}`, 'X-Amz-Date': stamp,
        'X-Amz-Expires': Math.max(60, Math.min(7 * 24 * 3600, Number(expires) || GET_TTL)), 'X-Amz-SignedHeaders': 'host'
    });
    const canonical = [method, u.pathname, q, 'host:' + u.host + '\n', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
    const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n');
    const kSign = hmac(hmac(hmac(hmac('AWS4' + c.secretAccessKey, day), c.region), 's3'), 'aws4_request');
    return `${url}?${q}&X-Amz-Signature=${crypto.createHmac('sha256', kSign).update(toSign).digest('hex')}`;
}

const putUrl = (key) => presign('PUT', key, PUT_TTL);
/** URL để trình duyệt ĐỌC file-phần: public (nếu có R2_PUBLIC_BASE) hoặc URL GET ký sẵn. */
function getUrl(key) {
    const c = need();
    return c.publicBase ? `${c.publicBase}/${encPath(key)}` : presign('GET', key, GET_TTL);
}

async function call(method, key, opt = {}) {
    const res = await fetch(presign(method, key, 300), { method, headers: opt.headers, signal: AbortSignal.timeout(opt.timeout || 20000) });
    return res;
}
/** { size } hoặc null nếu chưa có. */
async function head(key) {
    const r = await call('HEAD', key);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`R2 lỗi ${r.status} khi HEAD ${key}`);
    return { size: Number(r.headers.get('content-length')) || 0 };
}
/** Đọc [start, start+len) — kiểm header mà không tải cả file-phần. */
async function readRange(key, start, len) {
    const r = await call('GET', key, { headers: { Range: `bytes=${start}-${start + len - 1}` } });
    if (r.status === 404) return null;
    if (!r.ok && r.status !== 206) throw new Error(`R2 lỗi ${r.status} khi đọc Range ${key}`);
    return Buffer.from(await r.arrayBuffer()).subarray(0, len);
}
/** Cả object (đường dự phòng: server giải mã khi trình duyệt không tự giải mã được). */
async function getBuffer(key) {
    const r = await call('GET', key, { timeout: 55000 });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`R2 lỗi ${r.status} khi đọc ${key}`);
    return Buffer.from(await r.arrayBuffer());
}
async function remove(key) {
    const r = await call('DELETE', key);
    if (!r.ok && r.status !== 404) throw new Error(`R2 lỗi ${r.status} khi xoá ${key}`);
}

module.exports = { isConfigured, config, presign, putUrl, getUrl, head, readRange, getBuffer, remove, PUT_TTL };
