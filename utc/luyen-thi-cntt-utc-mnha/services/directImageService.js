// ============================================================
// UP ẢNH THẲNG TỪ TRÌNH DUYỆT — Cloudinary (kiểm duyệt) rồi GitHub, KHÔNG đưa bytes ảnh qua máy chủ
// ------------------------------------------------------------
//  Luồng cũ : trình duyệt → máy chủ (base64) → Cloudinary duyệt → máy chủ ghi GitHub   (Vercel ≤ 4.5MB, tốn băng thông)
//  Luồng mới: giống cách Slide / Tài liệu up thẳng GitHub bằng token tạm (GitHub App):
//
//   1. init    máy chủ (JSON nhỏ) ký sẵn tham số upload cho TỪNG tài khoản Cloudinary đã chọn
//              (api_secret không rời máy chủ; tham số `moderation` do máy chủ ấn định nên trình duyệt không bỏ được)
//   2. trình duyệt POST ảnh THẲNG lên api.cloudinary.com (type private) — Cloudinary kiểm duyệt đồng bộ
//   3. verify  máy chủ hỏi LẠI Cloudinary (Admin API) xem ảnh có thật + được duyệt chưa (không tin lời trình duyệt),
//              rồi XOÁ bản trên Cloudinary. Chỉ khi TẤT CẢ tài khoản duyệt mới cấp TOKEN TẠM GitHub (1 giờ, 1 repo, Contents:write)
//   4. trình duyệt PUT ảnh THẲNG lên api.github.com (Contents API) bằng token tạm
//   5. done    máy chủ đọc lại file vừa commit, so với ảnh đã duyệt (kích thước + MD5/etag của Cloudinary).
//              Khác → xoá file vừa ghi và báo lỗi (chặn việc "gửi ảnh sạch đi duyệt, ghi ảnh khác lên GitHub").
//              quiz → trả link raw · drawing → trả token HMAC như luồng cũ (submission.controller dùng nguyên không đổi)
//
//  Cần: GitHub App đã nhập ở /connect (hoặc GITHUB_APP_*) — thiếu thì isAvailable() = false và trình duyệt tự dùng luồng cũ.
//  Tắt: IMAGE_DIRECT=off (hoặc GH_DIRECT=off / STUDYFILE_DIRECT=off).
//  Env tuỳ chọn:
//    IMAGE_DIRECT_TRUST_CLIENT_MODERATION=1  nếu Admin API của Cloudinary không trả trạng thái duyệt cho add-on của bạn,
//                                            tin kết quả duyệt do trình duyệt báo (VẪN kiểm ảnh tồn tại + etag). Mặc định TẮT (fail-closed).
//    IMAGE_DIRECT_STRICT_HASH=off            chỉ so kích thước + magic bytes, bỏ so MD5 (nếu Cloudinary không trả etag đúng MD5 file gốc).
// ============================================================
'use strict';
const crypto = require('crypto');

const githubService = require('./githubService');
const moderation = require('./imageModerationService');
const cloudinaryAccounts = require('./cloudinaryAccountService');
const appTok = () => require('./githubAppToken');

const CLOUD_API = () => String(process.env.CLOUDINARY_API_BASE || 'https://api.cloudinary.com/v1_1').replace(/\/+$/, '');
const INIT_TTL_MS = 30 * 60 * 1000;      // từ lúc init đến lúc verify
const GH_TTL_MS = 55 * 60 * 1000;        // token tạm GitHub sống 1 giờ
const HEX24 = /^[a-f0-9]{24}$/;

const KINDS = {
    quiz: { exts: ['png', 'jpg', 'webp', 'gif', 'bmp', 'avif'], rateMax: 30 },
    drawing: { exts: ['png', 'jpg', 'webp'], rateMax: 12 }
};
const MIME_OK = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/avif': 'avif'
};

function fail(message, status, code) {
    const e = new Error(message);
    e.status = status;
    if (code) e.code = code;
    return e;
}

// ---------------- bật/tắt ----------------
function switchedOff() {
    return ['IMAGE_DIRECT', 'GH_DIRECT', 'STUDYFILE_DIRECT'].some((k) => process.env[k] === 'off');
}
async function isAvailable() {
    if (switchedOff()) return false;
    if (!githubService.isConfigured) return false;
    try { return !!(await appTok().isConfigured()); } catch (_) { return false; }
}

// ---------------- giới hạn tần suất (add-on kiểm duyệt có hạn mức free nhỏ) ----------------
const RATE_WINDOW_MS = 10 * 60 * 1000;
const _hits = new Map();
function rateLimited(kind, userId) {
    const key = kind + ':' + userId, now = Date.now();
    const arr = (_hits.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
    if (arr.length >= KINDS[kind].rateMax) { _hits.set(key, arr); return true; }
    arr.push(now); _hits.set(key, arr);
    return false;
}

// ---------------- Cloudinary ----------------
/** Chữ ký upload: SHA-1 hex của "k1=v1&k2=v2…" (khoá xếp A→Z, bỏ file/cloud_name/resource_type/api_key) + api_secret. */
function signParams(params, apiSecret) {
    const str = Object.keys(params).filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '').sort()
        .map((k) => `${k}=${params[k]}`).join('&');
    return crypto.createHash('sha1').update(str + apiSecret).digest('hex');
}
const basicAuth = (a) => 'Basic ' + Buffer.from(`${a.apiKey}:${a.apiSecret}`).toString('base64');

/** Chi tiết 1 ảnh private trên Cloudinary (Admin API). 404 → null. */
async function cloudResource(account, publicId) {
    const url = `${CLOUD_API()}/${encodeURIComponent(account.cloudName)}/resources/image/private/${encodeURIComponent(publicId)}?moderation=true`;
    let r;
    try { r = await fetch(url, { headers: { Authorization: basicAuth(account) }, signal: AbortSignal.timeout(15000) }); }
    catch (e) { throw fail(`Không hỏi được Cloudinary "${account.cloudName}": ${e.message}`, 502, 'CLOUD_UNREACHABLE'); }
    if (r.status === 404) return null;
    if (r.status === 401 || r.status === 403) throw fail(`Cloudinary "${account.cloudName}" từ chối kết nối (sai cloud name / API key / secret). Báo admin kiểm tra lại.`, 502, 'CLOUD_AUTH');
    if (!r.ok) throw fail(`Cloudinary "${account.cloudName}" trả HTTP ${r.status}.`, 502, 'CLOUD_ERROR');
    return r.json();
}

/** Xoá ảnh khỏi Cloudinary (không bao giờ ném lỗi). */
async function destroyQuietly(account, publicId) {
    try {
        const p = { invalidate: 'true', public_id: publicId, timestamp: Math.floor(Date.now() / 1000), type: 'private' };
        const body = new URLSearchParams({ ...p, api_key: account.apiKey, signature: signParams(p, account.apiSecret) });
        const r = await fetch(`${CLOUD_API()}/${encodeURIComponent(account.cloudName)}/image/destroy`, { method: 'POST', body, signal: AbortSignal.timeout(15000) });
        if (!r.ok) console.warn(`[directImage] Xoá ảnh Cloudinary (${account.cloudName}) HTTP ${r.status}`);
    } catch (e) {
        console.warn(`[directImage] Không xoá được ảnh Cloudinary (${account.cloudName}) ${publicId}: ${e.message || e}`);
    }
}

/** 'approved' | 'rejected' | 'pending' | 'missing' — đọc cả dạng mảng `moderation` lẫn `moderation_status`. */
function verdictFromResource(res) {
    if (!res) return 'missing';
    if (Array.isArray(res.moderation) && res.moderation.length) return moderation.verdictOf(res);
    const st = String(res.moderation_status || '').toLowerCase();
    if (st === 'approved' || st === 'rejected' || st === 'pending') return st;
    return 'missing';
}

// ---------------- repo GitHub nhận ảnh ----------------
async function activeRepo() {
    let rec = { owner: githubService.owner, repo: githubService.repo, branch: githubService.branch };
    try {
        if (githubService.pooled && githubService.pool && typeof githubService.pool.active === 'function') {
            const a = await githubService.pool.active();
            if (a && a.owner && a.repo) rec = { owner: a.owner, repo: a.repo, branch: a.branch || rec.branch };
        }
    } catch (_) { /* dùng repo chính */ }
    if (!rec.owner || !rec.repo) throw fail('Chưa xác định được repo GitHub để nhận ảnh.', 503);
    return { owner: rec.owner, repo: rec.repo, branch: rec.branch || 'main' };
}

const safeSegment = (v) => String(v).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);

/** Đường dẫn file ảnh trên GitHub. quiz: cache/image/<timestamp>.<ext> · drawing: drawing-uploads/<userId>/<uploadId>.<ext> (khớp luồng cũ). */
async function targetPath(kind, userId, uploadId, ext) {
    if (kind === 'drawing') return `drawing-uploads/${safeSegment(userId)}/${uploadId}.${ext}`;
    const ts = Date.now();
    let path = `cache/image/${ts}.${ext}`;
    for (let i = 1; i <= 5 && (await githubService.fileExists(path)); i++) path = `cache/image/${ts}-${i}.${ext}`;
    return path;
}

const rawUrl = (t) => `https://raw.githubusercontent.com/${t.owner}/${t.repo}/${t.branch}/${t.path}`;

// ---------------- 1) init ----------------
/**
 * @returns {{ ticket:string, clouds:{cloudName:string,url:string,fields:object}[], maxBytes:number }}
 */
async function init({ kind, userId, names, mime, size }) {
    const K = KINDS[kind];
    if (!K) throw fail('Loại upload không hợp lệ.', 400);
    if (!(await isAvailable())) throw fail('Chưa bật up thẳng (cần GitHub App ở /connect) — dùng cách up thường.', 503, 'DIRECT_OFF');
    const ext = MIME_OK[String(mime || '').toLowerCase()];
    if (!ext || !K.exts.includes(ext)) throw fail(`Chỉ nhận ảnh ${K.exts.map((x) => x.toUpperCase()).join(' / ')}.`, 400);
    const bytes = Number(size);
    if (!Number.isInteger(bytes) || bytes <= 0) throw fail('Ảnh rỗng hoặc kích thước không hợp lệ.', 400);
    if (bytes > moderation.MAX_UPLOAD_BYTES) throw fail('Ảnh quá nặng.', 413);
    if (rateLimited(kind, userId)) throw fail('Bạn tải ảnh quá nhiều lần. Vui lòng thử lại sau ít phút.', 429);

    const accounts = await cloudinaryAccounts.resolveAccounts(names);   // 400 nếu chọn sai
    const uploadId = crypto.randomBytes(12).toString('hex');
    const ts = Math.floor(Date.now() / 1000);
    const clouds = [], ticketAccounts = [];
    for (const a of accounts) {
        const publicId = 'mnha_' + crypto.randomBytes(16).toString('hex');   // không có dấu "/" để gọi Admin API an toàn
        const params = { moderation: moderation.MODERATION, overwrite: 'false', public_id: publicId, timestamp: ts, type: 'private' };
        clouds.push({
            cloudName: a.cloudName,
            url: `${CLOUD_API()}/${encodeURIComponent(a.cloudName)}/image/upload`,
            fields: { ...params, api_key: a.apiKey, signature: signParams(params, a.apiSecret) }
        });
        ticketAccounts.push({ c: a.cloudName, p: publicId });
    }
    const ticket = moderation.sealJson({ s: 'init', k: kind, u: String(userId), id: uploadId, a: ticketAccounts, b: bytes, x: ext, exp: Date.now() + INIT_TTL_MS });
    return { ticket, clouds, maxBytes: moderation.MAX_UPLOAD_BYTES };
}

// ---------------- 3) verify ----------------
const _used = new Set();   // phiếu init đã dùng (trong RAM từng instance — chỉ giảm lặp lại, không phải chốt chặn chính)

/**
 * @param reported  [{ cloudName, moderation:[…] }] — kết quả trình duyệt nhận từ Cloudinary (chỉ dùng khi bật IMAGE_DIRECT_TRUST_CLIENT_MODERATION)
 * @returns {{ gh:{owner,repo,branch,token,expiresAt}, path:string, ticket:string, moderatedBy:string[] }}
 */
async function verify({ kind, userId, ticket, reported }) {
    const t = moderation.openJson(ticket);
    if (!t || t.s !== 'init' || t.k !== kind || String(t.u) !== String(userId) || !Array.isArray(t.a) || !t.a.length) {
        throw fail('Phiên tải ảnh không hợp lệ hoặc đã hết hạn. Hãy chọn ảnh lại.', 400, 'BAD_TICKET');
    }
    if (_used.has(ticket)) throw fail('Phiên tải ảnh này đã dùng rồi. Hãy chọn ảnh lại.', 400, 'BAD_TICKET');
    _used.add(ticket);
    if (_used.size > 500) _used.delete(_used.values().next().value);

    const accounts = await cloudinaryAccounts.resolveAccounts(t.a.map((x) => x.c));
    const byName = new Map(accounts.map((a) => [a.cloudName, a]));
    const trustClient = process.env.IMAGE_DIRECT_TRUST_CLIENT_MODERATION === '1';
    const rep = new Map((Array.isArray(reported) ? reported : []).map((r) => [String(r && r.cloudName), r]));

    let first = null;
    try {
        for (const item of t.a) {
            const acc = byName.get(item.c);
            const res = await cloudResource(acc, item.p);
            if (!res) throw fail(`Ảnh chưa có trên Cloudinary "${item.c}" (tải lên chưa xong hoặc bị từ chối).`, 400, 'NOT_UPLOADED');
            let verdict = verdictFromResource(res);
            if (verdict === 'missing' && trustClient) {
                const r = rep.get(item.c);
                verdict = moderation.verdictOf({ moderation: r && r.moderation });
            }
            if (verdict === 'rejected') {
                console.warn(`[directImage] ẢNH NHẠY CẢM bị chặn bởi "${item.c}"`);
                throw fail('Ảnh bị từ chối vì có nội dung nhạy cảm. Vui lòng chọn ảnh khác.', 422, 'SENSITIVE_IMAGE');
            }
            if (verdict !== 'approved') {
                console.error(`[directImage] "${item.c}": kết quả kiểm duyệt "${verdict}" — add-on "${moderation.MODERATION}" đã bật chưa? Admin API có trả trạng thái duyệt không?`);
                throw fail(`Cloudinary "${item.c}" chưa xác nhận được kết quả kiểm duyệt ảnh.`, 503, 'MOD_UNVERIFIED');
            }
            if (!first) first = res;
        }
    } finally {
        // Dù duyệt xong, bị chặn hay lỗi giữa chừng → luôn xoá ảnh khỏi mọi tài khoản đã chọn
        await Promise.all(t.a.map((item) => destroyQuietly(byName.get(item.c), item.p)));
    }

    const K = KINDS[kind];
    let ext = String(first.format || '').toLowerCase();
    if (ext === 'jpeg') ext = 'jpg';
    if (!K.exts.includes(ext)) throw fail('File không phải ảnh hợp lệ.', 400, 'BAD_FORMAT');
    const bytes = Number(first.bytes) || t.b;
    if (bytes > moderation.MAX_UPLOAD_BYTES) throw fail('Ảnh quá nặng.', 413);

    const repo = await activeRepo();
    const path = await targetPath(kind, userId, t.id, ext);
    let tok;
    try { tok = await appTok().mintForRepo(repo.owner, repo.repo); }
    catch (e) { throw fail('Không cấp được token tạm cho GitHub: ' + e.message, 503, 'GH_TOKEN'); }

    const commitTicket = moderation.sealJson({
        s: 'gh', k: kind, u: String(userId), id: t.id, path, x: ext, b: bytes,
        e: first.etag || '', o: repo.owner, r: repo.repo, br: repo.branch, exp: Date.now() + GH_TTL_MS
    });
    return {
        gh: { owner: repo.owner, repo: repo.repo, branch: repo.branch, token: tok.token, expiresAt: tok.expiresAt },
        path, ext, ticket: commitTicket, moderatedBy: t.a.map((x) => x.c)
    };
}

// ---------------- 5) done ----------------
async function removeQuietly(path, why) {
    try { await githubService.deleteFile(path, `[Direct image] xoá ảnh không khớp: ${why}`); }
    catch (e) { console.warn('[directImage] không xoá được file lỗi:', path, e.message || e); }
}

/**
 * Máy chủ đọc lại file trình duyệt vừa commit và so với ảnh đã được duyệt.
 * @returns {{ path, url, ext, mime, bytes, uploadId, owner, repo, branch }}
 */
async function done({ kind, userId, ticket }) {
    const t = moderation.openJson(ticket);
    if (!t || t.s !== 'gh' || t.k !== kind || String(t.u) !== String(userId) || !t.path) {
        throw fail('Phiên lưu ảnh không hợp lệ hoặc đã hết hạn. Hãy chọn ảnh lại.', 400, 'BAD_TICKET');
    }
    try { githubService.pool && githubService.pool.invalidateTree && githubService.pool.invalidateTree(); } catch (_) { /* không quan trọng */ }

    let buf = null;
    for (let i = 0; i < 3 && !buf; i++) {
        try { buf = await (githubService.readBinaryFileLarge || githubService.readBinaryFile)(t.path); } catch (_) { buf = null; }
        if (!buf) await new Promise((ok) => setTimeout(ok, 500 * (i + 1)));
    }
    if (!Buffer.isBuffer(buf) || !buf.length) throw fail('Không thấy ảnh trên GitHub — tải lên GitHub chưa thành công.', 400, 'NOT_ON_GITHUB');

    const kindInfo = moderation.sniffImage(buf);
    const strict = process.env.IMAGE_DIRECT_STRICT_HASH !== 'off';
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    const sameSize = buf.length === Number(t.b);
    const sameHash = !strict || !t.e || md5 === String(t.e).toLowerCase();
    if (!kindInfo || !KINDS[kind].exts.includes(kindInfo.ext) || !sameSize || !sameHash) {
        console.warn(`[directImage] ẢNH KHÔNG KHỚP ${t.path}: sniff=${kindInfo && kindInfo.ext} size=${buf.length}/${t.b} md5=${md5}/${t.e}`);
        await removeQuietly(t.path, 'khác ảnh đã kiểm duyệt');
        throw fail('Ảnh lưu lên GitHub khác với ảnh đã kiểm duyệt — đã xoá. Hãy chọn ảnh lại.', 422, 'IMAGE_MISMATCH');
    }
    return {
        path: t.path, ext: kindInfo.ext, mime: kindInfo.mime, bytes: buf.length, uploadId: t.id,
        owner: t.o, repo: t.r, branch: t.br, url: rawUrl({ owner: t.o, repo: t.r, branch: t.br, path: t.path })
    };
}

module.exports = { KINDS, isAvailable, init, verify, done, signParams, verdictFromResource, _resetForTest: () => { _used.clear(); _hits.clear(); } };
