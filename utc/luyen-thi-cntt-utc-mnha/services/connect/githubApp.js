// services/connect/githubApp.js — cấu hình GitHub App (cấp TOKEN TẠM cho trình duyệt tải thẳng lên GitHub) lưu ở REPO CHÍNH, không cần .env.
//
//   • File: v-s/github-app.json (đổi bằng GITHUB_APP_INDEX_PATH). Private key (.pem) được MÃ HOÁ 2 CHIỀU bằng services/connect/crypto.js (AES-256-GCM, AAD riêng) —
//     cùng cách với khoá R2: lộ file json cũng không lấy được khoá. Trang /connect chỉ hiện App ID, Installation ID và 4 ký tự dấu vân tay của khoá.
//   • Web kết nối (Vercel khác) cũng đọc cấu hình này từ repo chính nên không phải chép biến môi trường vào từng web.
//   • Nếu CHƯA có cấu hình ở đây, services/githubAppToken.js vẫn đọc GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_APP_INSTALLATION_ID từ .env như trước.
'use strict';
const crypto = require('crypto');
const cc = require('./crypto');

const FILE = () => process.env.GITHUB_APP_INDEX_PATH || 'v-s/github-app.json';
const TTL_MS = 30 * 1000;
const gh = () => require('../githubService');
const bad = (m, status = 400) => Object.assign(new Error(m), { status });

let _doc = null, _at = 0, _promise = null;
function invalidate() { _doc = null; _at = 0; }

function normalize(raw) {
    const d = raw && typeof raw === 'object' ? raw : {};
    d.v = 1;
    if (d.enabled == null) d.enabled = true;
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

/** PEM từ ô nhập: chấp nhận nguyên file .pem, dạng 1 dòng có \n, hoặc base64 của file .pem. Trả { pem, fingerprint } hoặc ném lỗi dễ hiểu. */
function parsePem(input) {
    let k = String(input || '').trim();
    if (!k) return null;
    if (!/-----BEGIN/.test(k)) { try { k = Buffer.from(k, 'base64').toString('utf8'); } catch (_) { /* báo lỗi bên dưới */ } }
    k = k.replace(/\\n/g, '\n').trim() + '\n';
    let key;
    try { key = crypto.createPrivateKey(k); } catch (_) { throw bad('Private key không đọc được — hãy dán NGUYÊN nội dung file .pem (từ -----BEGIN … đến -----END …).'); }
    if (key.asymmetricKeyType !== 'rsa') throw bad('Private key của GitHub App phải là RSA.');
    return { pem: k, fingerprint: crypto.createHash('sha256').update(k).digest('hex').slice(-4) };
}

/** Cấu hình đang dùng (đã giải mã) hoặc null. Chỉ dùng ở máy chủ. */
async function runtime({ force = false } = {}) {
    let doc;
    try { doc = await load({ force }); } catch (_) { return null; }
    if (!doc || doc.enabled === false || !doc.appId || !doc.privateKeyEnc) return null;
    try {
        const privateKey = cc.decrypt(doc.privateKeyEnc, 'githubApp|privateKey');
        if (!privateKey) return null;
        return { appId: String(doc.appId), installationId: doc.installationId ? String(doc.installationId) : '', privateKey: String(privateKey) };
    } catch (_) { return null; }
}

async function summary() {
    const d = await load({ force: true }).catch(() => normalize(null));
    const env = !!(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY);
    return {
        ok: true, enabled: d.enabled !== false, appId: d.appId || '', installationId: d.installationId || '',
        keySaved: !!d.privateKeyEnc, keyHint: d.keyHint || null, updatedAt: d.updatedAt || null,
        source: d.appId && d.privateKeyEnc && d.enabled !== false ? 'repo' : (env ? 'env' : null), path: FILE()
    };
}

/** Lưu cấu hình. Ô private key để trống = GIỮ bản cũ. clear=1 → xoá hẳn. */
async function saveConfig(b = {}) {
    const appId = String(b.appId == null ? '' : b.appId).trim();
    const installationId = String(b.installationId == null ? '' : b.installationId).trim();
    if (appId && !/^\d{1,20}$/.test(appId)) throw bad('App ID phải là số (xem ở trang GitHub App → About).');
    if (installationId && !/^\d{1,20}$/.test(installationId)) throw bad('Installation ID phải là số (để trống để tự dò theo repo).');
    const pem = parsePem(b.privateKey);
    let last = null;
    for (let attempt = 0; attempt < 5; attempt++) {
        const cur = await gh().readJsonFileWithSha(FILE());
        const d = normalize(cur ? cur.data : {});
        if (b.clear === true || b.clear === '1') {
            const next = normalize({ enabled: false }); next.updatedAt = new Date().toISOString();
            try { await gh().writeJsonFileIfSha(FILE(), next, cur ? cur.sha : null, 'connect: xoá cấu hình GitHub App'); invalidate(); return summary(); }
            catch (e) { last = e; if (e.name === 'HttpError' || e.code !== 'SHA_CONFLICT') throw e; await new Promise((ok) => setTimeout(ok, 220)); continue; }
        }
        d.enabled = b.enabled === false || b.enabled === '0' ? false : true;
        if ('appId' in b) d.appId = appId;
        if ('installationId' in b) d.installationId = installationId;
        if (pem) { d.privateKeyEnc = cc.encrypt(pem.pem, 'githubApp|privateKey'); d.keyHint = pem.fingerprint; }
        if (!d.appId) throw bad('Nhập App ID.');
        if (!d.privateKeyEnc) throw bad('Dán private key (.pem) của GitHub App.');
        d.updatedAt = new Date().toISOString();
        try { await gh().writeJsonFileIfSha(FILE(), d, cur ? cur.sha : null, 'connect: cấu hình GitHub App'); invalidate(); return summary(); }
        catch (e) { last = e; if (e.name === 'HttpError' || e.code !== 'SHA_CONFLICT') throw e; await new Promise((ok) => setTimeout(ok, 220)); }
    }
    throw last || bad('Không lưu được cấu hình GitHub App (xung đột, thử lại).', 409);
}

/** Thử cấp token tạm cho repo đang nhận file (không trả token ra ngoài). */
async function test() {
    const app = require('../githubAppToken');
    const g = gh();
    let rec = { owner: g.owner, repo: g.repo };
    try { if (g.pooled && g.pool && g.pool.active) { const a = await g.pool.active(); if (a && a.owner && a.repo) rec = { owner: a.owner, repo: a.repo }; } } catch (_) { /* dùng repo chính */ }
    const t = await app.mintForRepo(rec.owner, rec.repo);
    return { ok: true, repo: rec.owner + '/' + rec.repo, expiresAt: t.expiresAt };
}

module.exports = { FILE, load, runtime, summary, saveConfig, test, invalidate, parsePem };
