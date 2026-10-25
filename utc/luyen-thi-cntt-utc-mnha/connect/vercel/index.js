// connect/vercel/index.js — phần chạy trên từng "web dữ liệu" Vercel.
//
//   Cùng một codebase với web chính; chỉ khác .env:
//       DATA_NODE=on
//       NODE_ID=luyen-thi-cntt-data-1
//       NODE_URL=https://luyen-thi-cntt-data-1.vercel.app
//       NODE_NAME=Web dữ liệu 1
//
//   Nhiệm vụ:
//     • Chỉ admin MẶC ĐỊNH (role=admin, userKey=null) được đăng nhập (xem server.js + auth.controller).
//     • Lần đăng nhập đầu: tự tạo "khoá kết nối", mã hoá 2 chiều rồi ghi vào v-s/index.json
//       của repo GitHub chính (registry.upsertNode) — khoá KHÔNG gửi cho người dùng thường.
//     • /api/node/health   công khai: web chính kiểm tra web này còn sống.
//     • /api/node/ping     ký HMAC bằng khoá kết nối: xác nhận khoá đúng.
//     • /api/node/status   ký HMAC: trả lưu lượng + cấu hình web.
//     • /connect           trang quản trị của web dữ liệu (khoá, đăng ký, .env mẫu, lưu lượng).
'use strict';
const crypto = require('crypto');
const express = require('express');
const pkg = require('../../package.json');
const registry = require('../../services/connect/registry');
const cc = require('../../services/connect/crypto');
const usage = require('../../services/connect/usage');
const { envTemplate } = require('../../services/connect/envTemplate');
const { requireDefaultAdmin } = require('../../middleware/userKeyGuard');

const isDataNode = () => String(process.env.DATA_NODE || '').toLowerCase() === 'on';
const isDefaultUser = (u) => !!u && u.role === 'admin' && !u.userKey;
const startedAt = Date.now();

function nodeId() {
    if (process.env.NODE_ID) return String(process.env.NODE_ID);
    if (process.env.NODE_URL) {
        try {
            // Giống hệt registry.idForUrl (dùng URL gốc) → khớp id web chính đã thêm tay.
            return registry.idForUrl(registry.cleanUrl(process.env.NODE_URL));
        } catch (_) {
            try { return registry.idForUrl(String(process.env.NODE_URL).replace(/\/+$/, '')); } catch (__) { /* ignore */ }
        }
    }
    return 'data-node';
}
function nodeName() {
    return String(process.env.NODE_NAME || process.env.NODE_ID || nodeId());
}
function nodeUrl(req) {
    if (process.env.NODE_URL) return String(process.env.NODE_URL).replace(/\/+$/, '');
    if (!req) return '';
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
    return `${proto}://${req.get('host')}`.replace(/\/+$/, '');
}

function json(res, status, obj) {
    res.status(status).type('application/json').send(JSON.stringify(obj));
}
const bad = (m, status = 400) => Object.assign(new Error(m), { status });

// ------------------------------------------------------------------ đăng ký web
/**
 * Bảo đảm web này có mặt trong v-s/index.json. Chỉ tạo khoá mới khi chưa có
 * (hoặc force=true). Khoá gốc chỉ lưu trong session của admin mặc định để hiện 1 lần.
 */
async function ensureRegistered({ req, force = false } = {}) {
    const id = nodeId(), url = nodeUrl(req), name = nodeName();
    const doc = await registry.load();
    const found = doc.nodes.find((n) => n && (n.id === id || n.url === url)) || null;
    if (found && found.keyEnc && !force) {
        // Đã đăng ký: cập nhật tên/URL nếu đổi, giữ nguyên khoá.
        const r = await registry.upsertNode({ id, url, name, createdBy: 'data-node' });
        return { ok: true, created: false, node: r.node, key: null };
    }
    if (!url) throw new Error('Thiếu NODE_URL — không biết địa chỉ web này để đăng ký.');
    const key = cc.newKey();
    const r = await registry.upsertNode({ id, url, name, key, createdBy: 'data-node' });
    if (req && req.session) {
        req.session.nodeSetup = {
            id, url, name, created: true, at: new Date().toISOString(),
            // Khoá vừa tạo — chỉ giữ trong session để hiện MỘT LẦN ở /connect.
            key
        };
    }
    return { ok: true, created: true, node: r.node, key };
}

/** Gọi sau khi admin mặc định đăng nhập thành công (controllers/auth.controller.js). */
async function onAdminLogin(req, user) {
    if (!isDataNode()) return { skipped: true };
    if (!isDefaultUser(user)) return { skipped: true };
    try {
        const r = await ensureRegistered({ req });
        console.log('[connect/vercel] đăng ký web ' + nodeId() + ': ' + (r.created ? 'tạo khoá mới' : 'đã có'));
        return r;
    } catch (e) {
        console.warn('[connect/vercel] không đăng ký được:', e.message);
        if (req.session) req.session.nodeSetup = { id: nodeId(), url: nodeUrl(req), error: e.message, at: new Date().toISOString() };
        return { error: e.message };
    }
}

// ------------------------------------------------------------------ chữ ký web chính → web dữ liệu
// Khoá riêng của web này (giải mã từ v-s/index.json), nhớ 60 giây để khỏi đọc GitHub mỗi lần.
let _keyCache = null;
async function ownKey(req) {
    if (_keyCache && Date.now() - _keyCache.at < 60 * 1000) return _keyCache.key;
    const doc = await registry.load();
    const ids = new Set([nodeId()]);
    try { ids.add(registry.idForUrl(registry.cleanUrl(nodeUrl(req)))); } catch (_) { /* ignore */ }
    const node = doc.nodes.find((n) => n && (ids.has(n.id) || n.url === nodeUrl(req)));
    const key = registry.nodeKey(node);
    _keyCache = { at: Date.now(), key };
    return key;
}

async function verifyNodeSignature(req, path = '/api/node/status') {
    const id = String(req.headers['x-mnha-node'] || '');
    const ts = String(req.headers['x-mnha-ts'] || '');
    const sig = String(req.headers['x-mnha-sig'] || '');
    if (!id || !ts || !sig) throw bad('Thiếu chữ ký.', 401);
    if (Math.abs(Date.now() - Number(ts)) > 5 * 60 * 1000) throw bad('Chữ ký đã hết hạn.', 401);
    // Chấp nhận id đang cấu hình HOẶC id suy ra từ URL (trường hợp web chính thêm tay URL trước).
    const accepted = new Set([nodeId()]);
    try { accepted.add(registry.idForUrl(registry.cleanUrl(nodeUrl(req)))); } catch (_) { /* ignore */ }
    if (!accepted.has(id)) throw bad('Sai mã web.', 403);
    const bodyHash = crypto.createHash('sha256').update('').digest('hex');
    // Ký bằng KHOÁ KẾT NỐI RIÊNG của web này — không đủ nếu chỉ biết CONNECT_ENC_KEY dùng chung.
    let key;
    try { key = await ownKey(req); } catch (e) { throw bad('Web này chưa có khoá kết nối: ' + e.message, 409); }
    const expect = cc.hmacWithKey(key, [id, ts, 'POST', path, bodyHash].join('\n'));
    if (!cc.safeEqual(expect, sig)) { _keyCache = null; throw bad('Chữ ký không hợp lệ.', 403); }
}

// ------------------------------------------------------------------ router
function createRouter() {
    const router = express.Router();

    // CORS cho trình duyệt gọi thẳng từ web chính sang web dữ liệu (không cookie).
    router.use('/api/node', (req, res, next) => {
        // Có MAIN_URL → chỉ web chính được gọi từ trình duyệt; không có thì giữ hành vi cũ.
        const main = String(process.env.MAIN_URL || '').replace(/\/+$/, '');
        const origin = req.headers.origin || '';
        if (main && origin && origin.replace(/\/+$/, '') !== main) return res.status(403).json({ error: 'Origin không được phép.' });
        res.setHeader('Access-Control-Allow-Origin', main || origin || '*');
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-MNHA-Node, X-MNHA-Ts, X-MNHA-Sig');
        res.setHeader('Access-Control-Max-Age', '600');
        if (req.method === 'OPTIONS') return res.status(204).end();
        next();
    });

    // ---- công khai: web chính dò tuần tự
    router.get('/api/node/health', (req, res) => {
        json(res, 200, {
            ok: true, id: nodeId(), name: nodeName(), url: nodeUrl(req),
            v: pkg.version, time: new Date().toISOString(),
            uptime: Math.round((Date.now() - startedAt) / 1000)
        });
    });

    // ---- ký bằng khoá kết nối: chỉ xác nhận "khoá đúng" (nhẹ, web chính gọi khi kiểm tra)
    router.post('/api/node/ping', (req, res) => {
        Promise.resolve().then(() => verifyNodeSignature(req, '/api/node/ping'))
            .then(() => json(res, 200, { ok: true, id: nodeId(), time: new Date().toISOString() }))
            .catch((e) => json(res, e.status || 401, { ok: false, error: e.message }));
    });

    // ---- ký HMAC: lưu lượng + cấu hình
    router.post('/api/node/status', (req, res) => {
        Promise.resolve().then(() => verifyNodeSignature(req)).then(() => {
            Promise.resolve()
                .then(() => usage.flush().catch(() => { /* đã log */ }))
                .then(() => usage.snapshot(nodeId()).catch(() => null))
                .then((use) => json(res, 200, {
                    ok: true, id: nodeId(), name: nodeName(), url: nodeUrl(req),
                    v: pkg.version, time: new Date().toISOString(),
                    uptime: Math.round((Date.now() - startedAt) / 1000),
                    dataNode: isDataNode(), usage: use,
                    features: {
                        sharedGithub: true,
                        sharedMongo: true
                    }
                })).catch((e) => json(res, 500, { ok: false, error: e.message }));
        }).catch((e) => json(res, e.status || 401, { ok: false, error: e.message }));
    });

    // ---- trang quản trị của web dữ liệu
    router.get('/connect', requireDefaultAdmin, async (req, res, next) => {
        try {
            let setup = req.session && req.session.nodeSetup ? req.session.nodeSetup : null;
            let node = null, error = null;
            try {
                const doc = await registry.load();
                node = doc.nodes.find((n) => n && (n.id === nodeId() || n.url === nodeUrl(req))) || null;
                if (!node || !node.keyEnc) {
                    const r = await ensureRegistered({ req });
                    node = r.node;
                    setup = req.session && req.session.nodeSetup ? req.session.nodeSetup : setup;
                }
            } catch (e) { error = e.message; }
            // Khoá gốc chỉ hiện MỘT LẦN ngay sau khi tạo/đổi — sau đó xoá khỏi session.
            const setupKey = setup && setup.key ? String(setup.key) : null;
            if (setupKey && req.session) {
                req.session.nodeSetup = Object.assign({}, setup, { key: null, shown: true, shownAt: new Date().toISOString() });
            }
            await usage.flush().catch(() => { /* đã log */ });
            const use = await usage.snapshot(nodeId()).catch(() => null);
            const hist = await usage.history(nodeId(), { week: usage.clampWeek(req.query && req.query.w) }).catch(() => null);
            const template = envTemplate({ id: nodeId(), url: nodeUrl(req), name: nodeName(), dataNode: true });
            res.render('connect/node', {
                title: 'Web dữ liệu — ' + nodeName(), user: req.user,
                nodeId: nodeId(), nodeUrl: nodeUrl(req), nodeName: nodeName(),
                node: registry.publicNode(node),
                setup, setupKey, error, use, hist, template, registryPath: registry.PATH(), usagePath: usage.FILE(), fmt: usage.formatBytes
            });
        } catch (e) { next(e); }
    });

    // ---- trang KHOÁ KẾT NỐI: xem/sao chép khoá (hỏi lại mật khẩu), tự kiểm tra khoá có đúng không
    const revealFails = new Map();            // userId → { n, until }
    async function keyPage(req, res, o = {}) {
        let node = null, selfCheck = null, error = o.error || null;
        try {
            const doc = await registry.load();
            node = doc.nodes.find((n) => n && (n.id === nodeId() || n.url === nodeUrl(req))) || null;
            if (node && node.keyEnc) {
                try {
                    const k = registry.nodeKey(node);
                    // Tự kiểm tra: ký rồi xác minh lại bằng đúng cơ chế web chính dùng.
                    const sig = cc.hmacWithKey(k, 'self-check');
                    const sigOk = cc.safeEqual(sig, cc.hmacWithKey(k, 'self-check'))
                        && !cc.safeEqual(sig, cc.hmacWithKey(k + 'x', 'self-check'));
                    selfCheck = { decrypt: true, signature: sigOk };
                } catch (e) { selfCheck = { decrypt: false, error: e.message }; }
            }
        } catch (e) { error = error || e.message; }
        res.status(o.status || 200).render('connect/key', {
            title: 'Khoá kết nối — ' + nodeName(), user: req.user, nodeId: nodeId(), nodeUrl: nodeUrl(req), nodeName: nodeName(),
            node: registry.publicNode(node), selfCheck, error, revealed: o.revealed || null, registryPath: registry.PATH()
        });
    }
    router.get('/connect/key', requireDefaultAdmin, (req, res, next) => keyPage(req, res).catch(next));
    router.post('/connect/key/reveal', requireDefaultAdmin, async (req, res, next) => {
        try {
            const uid = String(req.user._id || req.user.id), st = revealFails.get(uid) || { n: 0, until: 0 };
            if (st.until > Date.now()) return keyPage(req, res, { status: 429, error: 'Nhập sai quá nhiều lần — thử lại sau ít phút.' });
            const User = require('../../models/User');
            const bcrypt = require('bcrypt');
            const u = await User.findById(uid).select('+password');
            const ok = u && await bcrypt.compare(String((req.body || {}).password || ''), u.password);
            if (!ok) {
                st.n += 1; if (st.n >= 5) { st.until = Date.now() + 10 * 60 * 1000; st.n = 0; }
                revealFails.set(uid, st);
                return keyPage(req, res, { status: 403, error: 'Mật khẩu không đúng.' });
            }
            revealFails.delete(uid);
            const doc = await registry.load();
            const node = doc.nodes.find((n) => n && (n.id === nodeId() || n.url === nodeUrl(req)));
            res.set('Cache-Control', 'no-store');
            return keyPage(req, res, { revealed: registry.nodeKey(node) });
        } catch (e) { next(e); }
    });

    router.post('/connect/register', requireDefaultAdmin, async (req, res, next) => {
        try {
            await ensureRegistered({ req });
            res.redirect('/connect');
        } catch (e) { next(e); }
    });

    router.post('/connect/rotate-key', requireDefaultAdmin, async (req, res, next) => {
        try {
            _keyCache = null;
            const r = await ensureRegistered({ req, force: true });
            if (req.session) req.session.nodeSetup = { id: nodeId(), url: nodeUrl(req), name: nodeName(), created: true, at: new Date().toISOString(), key: r.key };
            res.redirect('/connect');
        } catch (e) { next(e); }
    });

    return router;
}

/** Gắn router vào app Express (server.js gọi khi DATA_NODE=on). */
function mount(app) {
    app.use(createRouter());
}

module.exports = {
    createRouter, mount, isDataNode, isDefaultUser, onAdminLogin, ensureRegistered,
    nodeId, nodeName, nodeUrl, verifyNodeSignature, ownKey
};
