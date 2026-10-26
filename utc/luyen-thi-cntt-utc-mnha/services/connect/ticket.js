// services/connect/ticket.js — "vé" cho trình duyệt gọi THẲNG web kết nối (web dữ liệu) để up / tải file.
//
//   Web chính CHỈ nối backend + frontend: cấp vé ngắn hạn (HMAC bằng KHOÁ KẾT NỐI RIÊNG của web dữ liệu),
//   còn dữ liệu lớn (up từng phần, tải file đã giải mã) đi thẳng trình duyệt ⇄ web kết nối → lưu lượng tính ở web kết nối.
//   Vé gắn với: người dùng (uid) + web dữ liệu đích (nid) + hạn dùng. Web khác / hết hạn → từ chối.
'use strict';
const cc = require('./crypto');

const TTL_MS = Number(process.env.CONNECT_TICKET_TTL_MS) > 0 ? Number(process.env.CONNECT_TICKET_TTL_MS) : 30 * 60 * 1000;
const b64u = (s) => Buffer.from(s, 'utf8').toString('base64url');

function sign(nodeKey, { uid, nid }) {
    const exp = Date.now() + TTL_MS;
    const p = b64u(JSON.stringify({ t: 'data', u: String(uid), n: String(nid), e: exp }));
    return { ticket: p + '.' + cc.hmacWithKey(nodeKey, 'ticket|' + p), exp };
}

/** acceptIds: các id hợp lệ của web này. Ném lỗi {status} nếu vé sai/hết hạn. */
function verify(nodeKey, acceptIds, ticket) {
    const bad = (m, status = 401) => Object.assign(new Error(m), { status });
    const [p, sig] = String(ticket || '').split('.');
    if (!p || !sig) throw bad('Thiếu vé truy cập web kết nối.');
    if (!cc.safeEqual(cc.hmacWithKey(nodeKey, 'ticket|' + p), sig)) throw bad('Vé không hợp lệ.', 403);
    let d;
    try { d = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch (_) { throw bad('Vé hỏng.'); }
    if (!d || d.t !== 'data' || !d.u) throw bad('Vé hỏng.');
    if (!(Number(d.e) > Date.now())) throw bad('Vé đã hết hạn — tải lại trang.');
    if (!acceptIds.has(String(d.n))) throw bad('Vé không dành cho web này.', 403);
    return { uid: String(d.u), nid: String(d.n), exp: Number(d.e) };
}

module.exports = { sign, verify, TTL_MS };
