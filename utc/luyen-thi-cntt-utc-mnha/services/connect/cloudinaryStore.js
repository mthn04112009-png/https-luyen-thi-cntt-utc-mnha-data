// services/connect/cloudinaryStore.js — tài khoản Cloudinary nhập ở trang /connect (giống GitHub App), lưu ở REPO CHÍNH, không cần .env / MongoDB.
//
//   • File: v-s/cloudinary.json (đổi bằng CLOUDINARY_INDEX_PATH). apiKey + apiSecret được MÃ HOÁ 2 CHIỀU bằng services/connect/crypto.js
//     (AES-256-GCM, AAD riêng cho từng tài khoản) — lộ file json cũng không lấy được khoá. Trang /connect chỉ hiện cloud name + 4 ký tự cuối API key.
//   • Dùng để KIỂM DUYỆT ảnh trước khi lưu lên GitHub (cả luồng trình duyệt tải thẳng lẫn luồng cũ qua máy chủ).
//     services/cloudinaryAccountService.js gộp 3 nguồn: MongoDB (trang Quản trị) + repo chính (file này) + .env.
//   • Web kết nối (Vercel khác) cũng đọc cùng file ở repo chính nên không phải chép khoá vào từng web.
'use strict';
const cc = require('./crypto');

const FILE = () => process.env.CLOUDINARY_INDEX_PATH || 'v-s/cloudinary.json';
const TTL_MS = 30 * 1000;
const NAME_RE = /^[A-Za-z0-9_-]{2,64}$/;
const gh = () => require('../githubService');
const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const aad = (cloudName, field) => `cloudinary|${cloudName}|${field}`;

let _doc = null, _at = 0, _promise = null;
function invalidate() { _doc = null; _at = 0; }

function normalize(raw) {
    const d = raw && typeof raw === 'object' ? raw : {};
    d.v = 1;
    d.accounts = Array.isArray(d.accounts) ? d.accounts.filter((a) => a && NAME_RE.test(String(a.cloudName || ''))) : [];
    return d;
}
async function load({ force = false } = {}) {
    if (!force && _doc && Date.now() - _at < TTL_MS) return _doc;
    if (_promise) return _promise;
    _promise = (async () => {
        const raw = await gh().readJsonFile(FILE()).catch(() => null);
        _doc = normalize(raw); _at = Date.now();
        return _doc;
    })();
    try { return await _promise; } finally { _promise = null; }
}

/** Tên cloud đang bật (không chứa khoá). Lỗi GitHub → danh sách rỗng, không làm hỏng trang. */
async function names() {
    try { return (await load()).accounts.filter((a) => a.enabled !== false).map((a) => a.cloudName); } catch (_) { return []; }
}

/** Tài khoản đã giải mã { cloudName, apiKey, apiSecret } theo tên (chỉ dùng trong RAM của máy chủ). Không có → null. */
async function get(cloudName) {
    let doc;
    try { doc = await load(); } catch (_) { return null; }
    const a = doc.accounts.find((x) => x.cloudName === cloudName && x.enabled !== false);
    if (!a || !a.apiKeyEnc || !a.apiSecretEnc) return null;
    try {
        return {
            cloudName: a.cloudName,
            apiKey: String(cc.decrypt(a.apiKeyEnc, aad(a.cloudName, 'apiKey'))),
            apiSecret: String(cc.decrypt(a.apiSecretEnc, aad(a.cloudName, 'apiSecret')))
        };
    } catch (e) {
        console.error(`[cloudinaryStore] Giải mã "${cloudName}" lỗi:`, e.message);
        throw bad(`Không đọc được cấu hình Cloudinary "${cloudName}" ở repo chính. Hãy nhập lại ở /connect.`, 503);
    }
}

async function summary() {
    const d = await load({ force: true }).catch(() => normalize(null));
    return {
        path: FILE(),
        accounts: d.accounts.map((a) => ({ cloudName: a.cloudName, keyHint: a.keyHint || '', enabled: a.enabled !== false, updatedAt: a.updatedAt || null }))
    };
}

async function mutate(fn, msg) {
    let last = null;
    for (let attempt = 0; attempt < 5; attempt++) {
        const cur = await gh().readJsonFileWithSha(FILE());
        const d = normalize(cur ? cur.data : {});
        fn(d);
        d.updatedAt = new Date().toISOString();
        try { await gh().writeJsonFileIfSha(FILE(), d, cur ? cur.sha : null, msg); invalidate(); return summary(); }
        catch (e) { last = e; if (e.name === 'HttpError' || e.code !== 'SHA_CONFLICT') throw e; await new Promise((ok) => setTimeout(ok, 220)); }
    }
    throw last || bad('Không lưu được cấu hình Cloudinary (xung đột, thử lại).', 409);
}

/** Thêm / cập nhật 1 tài khoản. Ô API key hoặc API secret để trống = GIỮ bản cũ (khi cập nhật). */
async function saveAccount({ cloudName, apiKey, apiSecret } = {}) {
    const name = String(cloudName || '').trim(), key = String(apiKey || '').trim(), secret = String(apiSecret || '').trim();
    if (!NAME_RE.test(name)) throw bad('Cloud name chỉ gồm chữ, số, dấu - và _ (2–64 ký tự).');
    return mutate((d) => {
        let a = d.accounts.find((x) => x.cloudName === name);
        if (!a) { a = { cloudName: name }; d.accounts.push(a); }
        if (key) { a.apiKeyEnc = cc.encrypt(key, aad(name, 'apiKey')); a.keyHint = key.slice(-4); }
        if (secret) a.apiSecretEnc = cc.encrypt(secret, aad(name, 'apiSecret'));
        if (!a.apiKeyEnc) throw bad('Nhập API key.');
        if (!a.apiSecretEnc) throw bad('Nhập API secret.');
        a.enabled = true;
    }, `connect: Cloudinary ${name}`);
}

async function removeAccount(cloudName) {
    const name = String(cloudName || '').trim();
    return mutate((d) => { d.accounts = d.accounts.filter((a) => a.cloudName !== name); }, `connect: xoá Cloudinary ${name}`);
}

/** Thử đăng nhập Cloudinary (GET /ping, không đổi dữ liệu). */
async function test(cloudName) {
    const a = await get(String(cloudName || '').trim());
    if (!a) throw bad('Chưa có tài khoản Cloudinary này ở repo chính.');
    const r = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(a.cloudName)}/ping`, {
        headers: { Authorization: 'Basic ' + Buffer.from(`${a.apiKey}:${a.apiSecret}`).toString('base64') },
        signal: AbortSignal.timeout(10000)
    }).catch((e) => { throw bad('Không gọi được Cloudinary: ' + e.message, 502); });
    if (!r.ok) throw bad(`Cloudinary từ chối (HTTP ${r.status}) — kiểm tra lại cloud name / API key / secret.`, 502);
    return { ok: true, cloudName: a.cloudName };
}

module.exports = { FILE, NAME_RE, load, names, get, summary, saveAccount, removeAccount, test, invalidate };
