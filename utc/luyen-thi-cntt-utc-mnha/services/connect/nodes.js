// services/connect/nodes.js — kiểm tra "web kết nối" LẦN LƯỢT theo thứ tự đã thêm (cũ → mới).
//
//   • Mỗi lần bấm "Kiểm tra tất cả": kiểm tra web #1, #2, #3… và lưu trạng thái vào v-s/index.json.
//   • Endpoint /api/node/health là công khai (không lộ khoá); /api/node/status ký HMAC bằng
//     khoá kết nối riêng của từng web.
//   • Web vừa lỗi bị "nghỉ" 90 giây để không thử lại liên tục.
'use strict';
const cc = require('./crypto');
const registry = require('./registry');

const PROBE_TIMEOUT_MS = Number(process.env.CONNECT_PROBE_TIMEOUT_MS) > 0 ? Number(process.env.CONNECT_PROBE_TIMEOUT_MS) : 4000;
const HEALTH_TTL_MS = 60 * 1000;
const COOLDOWN_MS = 90 * 1000;

const healthCache = new Map();     // id → { at, ok, ms, error, info }
const cooldown = new Map();        // id → thời điểm hết nghỉ

const now = () => Date.now();

async function fetchJson(url, { method = 'GET', headers = {}, body, timeout = PROBE_TIMEOUT_MS } = {}) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), Math.max(500, timeout));
    try {
        const res = await fetch(url, {
            method,
            headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
            body: body ? JSON.stringify(body) : undefined,
            signal: ac.signal
        });
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
        return { res, data, text };
    } finally { clearTimeout(t); }
}

/** Chữ ký yêu cầu web chính → web dữ liệu (không gửi khoá, chỉ gửi HMAC). */
function signatureHeaders(node, key, method, path, bodyObj) {
    const ts = String(now());
    const bodyHash = require('crypto').createHash('sha256').update(bodyObj ? JSON.stringify(bodyObj) : '').digest('hex');
    const sig = cc.hmacWithKey(key, [node.id, ts, String(method).toUpperCase(), path, bodyHash].join('\n'));
    return { 'X-MNHA-Node': node.id, 'X-MNHA-Ts': ts, 'X-MNHA-Sig': sig };
}

/** Kiểm tra 1 web bằng endpoint công khai /api/node/health (không lộ khoá). */
async function probe(node, { force = false } = {}) {
    const hit = healthCache.get(node.id);
    if (!force && hit && now() - hit.at < HEALTH_TTL_MS) return hit;
    const t0 = now();
    let out;
    try {
        const { res, data } = await fetchJson(String(node.url).replace(/\/+$/, '') + '/api/node/health');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        if (!data || data.ok !== true) throw new Error((data && data.error) || 'web trả lời không hợp lệ');
        // Chấp nhận id cấu hình (NODE_ID) hoặc id suy ra từ URL — admin có thể đã thêm web
        // bằng URL trước, còn web dữ liệu đặt NODE_ID tuỳ ý.
        const expected = new Set([String(node.id)]);
        try { expected.add(registry.idForUrl(registry.cleanUrl(node.url))); } catch (_) { /* ignore */ }
        if (data.id && !expected.has(String(data.id))) throw new Error('mã web không khớp (' + data.id + ' ≠ ' + node.id + ')');
        out = { at: now(), ok: true, ms: now() - t0, error: null, info: data };
        cooldown.delete(node.id);
    } catch (e) {
        const msg = e.name === 'AbortError' ? 'quá thời gian chờ' : (e.message || 'không kết nối được');
        out = { at: now(), ok: false, ms: now() - t0, error: msg, info: null };
    }
    healthCache.set(node.id, out);
    return out;
}

/** Trạng thái chi tiết (ký bằng khoá kết nối): lưu lượng + cấu hình web. */
async function status(node, { timeout = 8000 } = {}) {
    const key = registry.nodeKey(node);
    const path = '/api/node/status';
    const { res, data } = await fetchJson(String(node.url).replace(/\/+$/, '') + path, {
        method: 'POST', headers: signatureHeaders(node, key, 'POST', path, null), timeout
    });
    if (!res.ok || !data || data.ok !== true) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data;
}

const keyCache = new Map();        // id → { at, ok, error }
const KEY_TTL_MS = 60 * 1000;

/**
 * Kiểm tra KHOÁ KẾT NỐI: web chính ký yêu cầu bằng khoá lưu trong v-s/index.json,
 * web dữ liệu đối chiếu với khoá của chính nó. Sai khoá → báo lỗi rõ ràng.
 */
async function verifyKey(node, { force = false } = {}) {
    const hit = keyCache.get(node.id);
    if (!force && hit && now() - hit.at < KEY_TTL_MS) return hit;
    let out;
    try {
        const key = registry.nodeKey(node);
        const path = '/api/node/ping';
        const { res, data } = await fetchJson(String(node.url).replace(/\/+$/, '') + path, {
            method: 'POST', headers: signatureHeaders(node, key, 'POST', path, null)
        });
        if (res.ok && data && data.ok === true) out = { at: now(), ok: true, error: null };
        else out = { at: now(), ok: false, error: res.status === 403 ? 'sai khoá kết nối' : ((data && data.error) || ('HTTP ' + res.status)) };
    } catch (e) {
        out = { at: now(), ok: false, error: e.name === 'AbortError' ? 'quá thời gian chờ' : (e.message || 'không kiểm tra được khoá') };
    }
    keyCache.set(node.id, out);
    return out;
}

/** Kiểm tra lần lượt toàn bộ web (cũ → mới), cập nhật trạng thái vào v-s/index.json. */
async function checkAll({ force = true, withStatus = true } = {}) {
    const list = await registry.list();
    const out = [];
    for (const node of list) {                    // TUẦN TỰ, đúng thứ tự thêm
        const h = await probe(node, { force });
        let st = null, err = null;
        if (h.ok && withStatus) { try { st = await status(node); } catch (e) { err = e.message; } }
        const health = { ok: h.ok, ms: h.ms, error: h.error || err, statusOk: !!st, version: h.info && h.info.v ? h.info.v : null };
        await registry.setHealth(node.id, health);
        out.push({ id: node.id, name: node.name, url: node.url, ...health, status: st });
    }
    return out;
}

/** Trình duyệt/người vận hành báo web đang lỗi → cho web đó nghỉ, lần sau chuyển sang web kế tiếp. */
function markFailed(id) { if (id) cooldown.set(String(id), now() + COOLDOWN_MS); }
function clearFailed(id) { if (id) cooldown.delete(String(id)); }
function cooldownLeft(id) { return Math.max(0, (cooldown.get(String(id)) || 0) - now()); }

module.exports = {
    probe, verifyKey, status, checkAll, signatureHeaders, fetchJson,
    markFailed, clearFailed, cooldownLeft, COOLDOWN_MS
};
