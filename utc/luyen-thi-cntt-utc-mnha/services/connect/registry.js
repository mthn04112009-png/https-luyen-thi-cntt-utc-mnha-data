// services/connect/registry.js — sổ đăng ký "web kết nối" (data web) lưu trên GitHub chính:
//     v-s/index.json
//
//   Mỗi web dữ liệu (vd https://luyen-thi-cntt-data-1.vercel.app) tự đăng ký khi admin mặc định
//   đăng nhập lần đầu. Khoá kết nối được MÃ HOÁ 2 CHIỀU (services/connect/crypto.js) trước khi ghi,
//   nên lộ file index cũng không lấy được khoá. File này là nguồn DUY NHẤT cho:
//     • danh sách web để kiểm tra / dự phòng (thứ tự thêm: cũ → mới)
//     • khoá ký yêu cầu kiểm tra trạng thái / số liệu
//     • số liệu Vercel nhập tay (Fast Data Transfer / Fast Origin Transfer)
//
//   Ghi an toàn: đọc SHA → sửa → ghi kèm SHA; lệch SHA (web khác vừa ghi) thì đọc lại và làm lại.
'use strict';
const cc = require('./crypto');

const PATH = () => process.env.CONNECT_INDEX_PATH || 'v-s/index.json';
const SCHEMA = 1;

const bad = (m, status = 400) => Object.assign(new Error(m), { status });

function normalize(raw) {
    const d = raw && typeof raw === 'object' ? raw : {};
    if (!Array.isArray(d.nodes)) d.nodes = [];
    d.v = SCHEMA;
    return d;
}

function gh() { return require('../githubService'); }

/** Đọc sổ đăng ký (chưa có file → sổ rỗng). */
async function load() {
    const data = await gh().readJsonFile(PATH());
    return normalize(data);
}

/** Ghi đè toàn bộ (chỉ dùng khi biết chắc; các thao tác thường dùng mutate()). */
async function save(doc, message = 'connect: cập nhật sổ web kết nối') {
    const next = normalize(doc);
    next.updatedAt = new Date().toISOString();
    await gh().writeJsonFile(PATH(), next, message);
    return next;
}

/**
 * Đọc → sửa → ghi. `fn` nhận bản hiện tại, trả bản mới (hoặc sửa tại chỗ).
 * Tự thử lại khi SHA bị đổi (nhiều web cùng đăng ký một lúc).
 */
async function mutate(fn, message = 'connect: cập nhật sổ web kết nối') {
    let last = null;
    for (let attempt = 0; attempt < 6; attempt++) {
        const cur = await gh().readJsonFileWithSha(PATH());
        const base = normalize(cur ? cur.data : {});
        if (!base.createdAt) base.createdAt = new Date().toISOString();
        const next = normalize((await fn(base)) || base);
        next.updatedAt = new Date().toISOString();
        try {
            await gh().writeJsonFileIfSha(PATH(), next, cur ? cur.sha : null, message);
            return next;
        } catch (e) {
            last = e;
            if (e.code !== 'SHA_CONFLICT') throw e;
            await new Promise((ok) => setTimeout(ok, 250 * (attempt + 1)));
        }
    }
    throw last || new Error('Không ghi được sổ web kết nối (xung đột SHA).');
}

// ---------------------------------------------------------------- tiện ích
function slug(s) {
    return String(s || '').toLowerCase()
        .replace(/^https?:\/\//, '').replace(/\/+$/, '')
        .replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'node';
}

function cleanUrl(u) {
    let s = String(u || '').trim();
    if (!s) throw bad('Thiếu địa chỉ web (URL).');
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    let url;
    try { url = new URL(s); } catch (_) { throw bad('Địa chỉ web không hợp lệ.'); }
    if (!/^https?:$/.test(url.protocol)) throw bad('Địa chỉ web không hợp lệ.');
    if (url.pathname && url.pathname !== '/') throw bad('Chỉ nhập địa chỉ gốc của web, ví dụ https://luyen-thi-cntt-data-1.vercel.app');
    return url.origin;
}

/** Id ổn định theo URL: luyen-thi-cntt-data-1.vercel.app → luyen-thi-cntt-data-1 */
function idForUrl(url) {
    const host = (() => { try { return new URL(url).host; } catch (_) { return url; } })();
    return slug(host.replace(/\.vercel\.app$/i, ''));
}

function publicNode(n) {
    if (!n) return null;
    return {
        id: n.id, name: n.name || n.id, url: n.url, enabled: n.enabled !== false,
        createdAt: n.createdAt, keyHint: n.keyHint || null,
        createdBy: n.createdBy || null, health: n.health || null,
        vercel: n.vercel || null, note: n.note || ''
    };
}

/** Danh sách web, thứ tự THÊM (cũ → mới) — đúng thứ tự kiểm tra. */
async function list({ enabledOnly = false } = {}) {
    const d = await load();
    return d.nodes
        .filter((n) => n && n.id && (!enabledOnly || n.enabled !== false))
        .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)));
}

/** Thêm web bằng tay (URL + khoá đã tạo ở web dữ liệu). */
async function addNode({ url, key, name, note, createdBy } = {}) {
    const clean = cleanUrl(url);
    const k = String(key || '').trim();
    if (k.length < 32) throw bad('Khoá kết nối phải dài ít nhất 32 ký tự.');
    const id = idForUrl(clean);
    let created = null;
    await mutate((d) => {
        if (d.nodes.some((n) => n.id === id || n.url === clean)) throw bad('Web này đã có trong danh sách.');
        created = {
            id, url: clean, name: String(name || '').trim() || new URL(clean).host,
            enabled: true, createdAt: new Date().toISOString(),
            keyEnc: cc.encrypt(k, 'connect|' + id), keyHint: cc.hint(k),
            createdBy: createdBy || null, note: String(note || '').slice(0, 300),
            vercel: { fastDataTransferGb: null, fastOriginTransferGb: null, updatedAt: null },
            health: null
        };
        d.nodes.push(created);
        return d;
    }, 'connect: thêm web ' + clean);
    return publicNode(created);
}

/**
 * Web dữ liệu tự đăng ký (gọi từ connect/vercel). Nếu URL đã có thì cập nhật tên/khoá mới.
 * Trả bản public + cờ created.
 */
async function upsertNode({ id, url, key, name, note, createdBy } = {}) {
    const clean = cleanUrl(url);
    const nodeId = String(id || '').trim() || idForUrl(clean);
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(nodeId)) throw bad('Mã web không hợp lệ.');
    const k = String(key || '').trim();
    if (k && k.length < 32) throw bad('Khoá kết nối phải dài ít nhất 32 ký tự.');
    let out = null, wasCreated = false;
    await mutate((d) => {
        let n = d.nodes.find((x) => x.id === nodeId || x.url === clean);
        const now = new Date().toISOString();
        if (!n) {
            n = { id: nodeId, url: clean, createdAt: now, enabled: true, health: null };
            d.nodes.push(n);
            wasCreated = true;
        }
        if (n.url !== clean && d.nodes.some((x) => x !== n && x.url === clean)) throw bad('URL này đã thuộc một web khác.');
        n.url = clean;
        n.name = String(name || n.name || '').trim() || new URL(clean).host;
        n.enabled = n.enabled !== false;
        n.note = typeof note === 'string' ? note.slice(0, 300) : (n.note || '');
        if (k) { n.keyEnc = cc.encrypt(k, 'connect|' + n.id); n.keyHint = cc.hint(k); }
        if (createdBy && !n.createdBy) n.createdBy = createdBy;
        n.updatedAt = now;
        out = n;
        return d;
    }, 'connect: web tự đăng ký ' + clean);
    return { node: publicNode(out), created: wasCreated };
}

async function setEnabled(id, enabled) {
    let out = null;
    await mutate((d) => {
        const n = d.nodes.find((x) => x.id === id);
        if (!n) throw bad('Không tìm thấy web.', 404);
        n.enabled = !!enabled;
        n.updatedAt = new Date().toISOString();
        out = n;
        return d;
    }, 'connect: ' + (enabled ? 'bật' : 'tắt') + ' web ' + id);
    return publicNode(out);
}

async function removeNode(id) {
    await mutate((d) => {
        const i = d.nodes.findIndex((x) => x.id === id);
        if (i < 0) throw bad('Không tìm thấy web.', 404);
        d.nodes.splice(i, 1);
        return d;
    }, 'connect: xoá web ' + id);
    return { ok: true };
}

async function renameNode(id, name, note) {
    let out = null;
    await mutate((d) => {
        const n = d.nodes.find((x) => x.id === id);
        if (!n) throw bad('Không tìm thấy web.', 404);
        n.name = String(name || '').trim().slice(0, 80) || n.name;
        if (typeof note === 'string') n.note = note.slice(0, 300);
        n.updatedAt = new Date().toISOString();
        out = n;
        return d;
    }, 'connect: đổi tên web ' + id);
    return publicNode(out);
}

/** Lưu kết quả kiểm tra (gọi tuần tự khi bấm Kiểm tra). */
async function setHealth(id, health) {
    try {
        await mutate((d) => {
            const n = d.nodes.find((x) => x.id === id);
            if (n) n.health = { ...health, at: new Date().toISOString() };
            return d;
        }, 'connect: trạng thái web ' + id);
    } catch (e) { console.warn('[connect] lưu trạng thái:', e.message); }
}

/** Số liệu Vercel nhập tay (GB) — API Vercel không có endpoint công khai cho 2 chỉ số này. */
async function setVercelUsage(id, { fastDataTransferGb, fastOriginTransferGb, note } = {}) {
    const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Math.max(0, Number(v)));
    let out = null;
    await mutate((d) => {
        const n = d.nodes.find((x) => x.id === id);
        if (!n) throw bad('Không tìm thấy web.', 404);
        n.vercel = {
            fastDataTransferGb: num(fastDataTransferGb),
            fastOriginTransferGb: num(fastOriginTransferGb),
            updatedAt: new Date().toISOString(),
            note: String(note || '').slice(0, 200)
        };
        out = n;
        return d;
    }, 'connect: số liệu Vercel ' + id);
    return publicNode(out);
}

/** Khoá kết nối đã giải mã (chỉ dùng ở máy chủ). */
function nodeKey(node) {
    if (!node || !node.keyEnc) throw bad('Web này chưa có khoá kết nối — hãy đăng nhập admin mặc định ở web đó để tạo.', 409);
    try {
        return cc.decrypt(node.keyEnc, 'connect|' + node.id);
    } catch (e) {
        if (e && e.code === 'DECRYPT_FAILED') {
            throw bad('Không giải mã được khoá kết nối của web "' + node.id + '": CONNECT_ENC_KEY (hoặc SESSION_ENC_KEY / ENCRYPTION_MASTER_KEY) ở web này khác với web đã ghi khoá. Hãy đặt giống hệt nhau ở mọi web, hoặc nhập lại khoá ở /connect.', 409);
        }
        throw e;
    }
}

module.exports = {
    PATH, load, save, mutate, list, addNode, upsertNode, setEnabled, removeNode, renameNode,
    setHealth, setVercelUsage, nodeKey, publicNode, cleanUrl, idForUrl, normalize
};
