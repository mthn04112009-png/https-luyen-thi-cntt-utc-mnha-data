// services/connect/dataNodes.js — phía WEB CHÍNH: chọn web kết nối (web dữ liệu) để trình duyệt up / tải dữ liệu.
//   • Chạy localhost (không có VERCEL) hoặc không có web kết nối khả dụng → trả null → trình duyệt dùng chính web này.
//   • Thứ tự ưu tiên: cũ → mới (đúng thứ tự kiểm tra ở /connect); bỏ web tắt / chưa có khoá / vừa báo lỗi / kiểm tra gần nhất lỗi.
'use strict';
const registry = require('./registry');
const nodes = require('./nodes');
const ticket = require('./ticket');

const CACHE_MS = 60 * 1000;
let cache = null;   // { at, list }

const enabled = () => !!process.env.VERCEL && String(process.env.DATA_NODE || '').toLowerCase() !== 'on';

async function usable() {
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.list;
    let list = [];
    try { list = await registry.list({ enabledOnly: true }); } catch (e) { console.warn('[connect/dataNodes]', e.message); }
    cache = { at: Date.now(), list };
    return list;
}
function invalidate() { cache = null; }

async function pick() {
    if (!enabled()) return null;
    const list = await usable();
    return list.find((n) => n.keyEnc && !(n.health && n.health.ok === false) && nodes.cooldownLeft(n.id) === 0) || null;
}

/** Số web kết nối đang bật (dùng để quyết định có hiện dòng của chính web này ở /connect không). */
async function countEnabled() { return (await usable()).length; }

/** Vé cho người dùng `uid` → { node:{id,name,url}, ticket, exp } hoặc null (dùng web hiện tại). */
async function issue(uid) {
    const n = await pick();
    if (!n) return null;
    const t = ticket.sign(registry.nodeKey(n), { uid, nid: n.id });
    return { node: { id: n.id, name: n.name || n.id, url: String(n.url).replace(/\/+$/, '') }, ticket: t.ticket, exp: t.exp };
}

module.exports = { enabled, pick, issue, countEnabled, invalidate };
