// services/githubAppToken.js — cấp TOKEN TẠM cho TRÌNH DUYỆT tự tải bản mã lên GitHub (không qua Vercel), KHÔNG lộ token thật.
//
//   • Dùng GitHub App (installation token): hết hạn sau 1 giờ (GitHub quy định), chỉ gắn với ĐÚNG 1 repo và chỉ quyền Contents:write.
//     PAT / khoá App không bao giờ rời máy chủ; trình duyệt chỉ nhận token tạm của lần tải lên đó (giống cách cấp khoá giải mã tạm cho từng file).
//   • Cấu hình: ưu tiên nhập ở trang /connect (lưu MÃ HOÁ trong repo chính: v-s/github-app.json — services/connect/githubApp.js), không phụ thuộc giới hạn .env.
//     Chưa có thì đọc biến môi trường (dự phòng):
//       GITHUB_APP_ID               số App ID
//       GITHUB_APP_PRIVATE_KEY      nội dung file .pem (cho phép viết 1 dòng với \n, hoặc base64 của file .pem)
//       GITHUB_APP_INSTALLATION_ID  (tuỳ chọn) nếu thiếu sẽ tự dò theo repo: GET /repos/{owner}/{repo}/installation
//   • Tạo App: GitHub → Settings → Developer settings → GitHub Apps → New. Repository permissions: Contents = Read and write (không cần quyền khác).
//     Cài App lên tài khoản chứa repo dữ liệu và chọn "All repositories" (để repo <repo>-1, -2… do nhóm repo tự tạo cũng được cấp token).
'use strict';
const crypto = require('crypto');

const API = () => String(process.env.GITHUB_API_BASE || 'https://api.github.com').replace(/\/+$/, '');
const b64u = (b) => Buffer.from(b).toString('base64url');

function parseEnvKey() {
    let k = String(process.env.GITHUB_APP_PRIVATE_KEY || '').trim();
    if (!k) return null;
    if (!/-----BEGIN/.test(k)) { try { k = Buffer.from(k, 'base64').toString('utf8'); } catch (_) { return null; } }
    k = k.replace(/\\n/g, '\n');
    return /-----BEGIN/.test(k) ? k : null;
}
/** { appId, privateKey, installationId } — repo chính (mã hoá) trước, .env sau; null nếu chưa cấu hình. */
async function creds() {
    try {
        const r = await require('./connect/githubApp').runtime();
        if (r) return r;
    } catch (_) { /* rơi xuống .env */ }
    const appId = String(process.env.GITHUB_APP_ID || '').trim(), privateKey = parseEnvKey();
    return appId && privateKey ? { appId, privateKey, installationId: String(process.env.GITHUB_APP_INSTALLATION_ID || '').trim() } : null;
}
const isConfigured = async () => !!(await creds());

/** JWT của App (RS256, sống 9 phút) — chỉ dùng để xin installation token. */
function appJwt(c, now = Math.floor(Date.now() / 1000)) {
    const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const body = b64u(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: c.appId }));
    const sig = crypto.createSign('RSA-SHA256').update(head + '.' + body).sign(c.privateKey);
    return head + '.' + body + '.' + b64u(sig);
}

async function gh(method, path, jwt, body) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10000);
    let r;
    try {
        r = await fetch(API() + path, {
            method, signal: ac.signal,
            headers: { Authorization: 'Bearer ' + jwt, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'mnha-app-token' },
            body: body ? JSON.stringify(body) : undefined
        });
    } catch (e) { throw new Error('Không gọi được GitHub để cấp token tạm: ' + e.message); } finally { clearTimeout(timer); }
    const text = await r.text().catch(() => '');
    let j = null; try { j = JSON.parse(text); } catch (_) { /* không phải JSON */ }
    if (!r.ok) throw Object.assign(new Error('GitHub App: HTTP ' + r.status + ((j && j.message) ? ' — ' + j.message : '')), { status: r.status });
    return j || {};
}

const _inst = new Map();     // owner/repo → installation id (không đổi nên nhớ lại)
async function installationId(owner, repo, jwt, c) {
    if (c.installationId) return c.installationId;
    const k = owner + '/' + repo;
    if (_inst.has(k)) return _inst.get(k);
    const j = await gh('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`, jwt);
    if (!j.id) throw new Error('GitHub App chưa được cài lên repo ' + k + '.');
    _inst.set(k, String(j.id));
    return String(j.id);
}

/**
 * Token tạm cho 1 repo: { token, expiresAt }. Quyền tối thiểu: Contents:write, đúng 1 repo.
 * Lỗi (App chưa cài lên repo, khoá sai…) → ném Error có thông điệp rõ để hiện lý do cho người dùng.
 */
async function mintForRepo(owner, repo) {
    const c = await creds();
    if (!c) throw new Error('Chưa cấu hình GitHub App (nhập ở /connect → GitHub App, hoặc đặt GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY).');
    const jwt = appJwt(c);
    const id = await installationId(owner, repo, jwt, c);
    const j = await gh('POST', `/app/installations/${encodeURIComponent(id)}/access_tokens`, jwt, { repositories: [repo], permissions: { contents: 'write' } });
    if (!j.token) throw new Error('GitHub không trả token tạm.');
    return { token: j.token, expiresAt: j.expires_at || null };
}

module.exports = { isConfigured, mintForRepo, appJwt, _reset: () => _inst.clear() };
