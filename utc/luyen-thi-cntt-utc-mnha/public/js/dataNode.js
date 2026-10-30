/* dataNode.js — trình duyệt up / tải dữ liệu THẲNG qua "web kết nối" (web dữ liệu), không qua web chính.
 *
 *   MnhaData.fetch(path, init)  path dạng '/slides/dashboard/upload-chunk' hoặc '/documents/file/<id>?chunk=0'
 *     • Có web kết nối khả dụng (chạy trên Vercel): xin "vé" ở /api/data-ticket rồi gọi
 *       <web kết nối>/api/node/data<path> với Authorization: Bearer <vé>.
 *     • Chạy localhost / chưa có web kết nối / web kết nối lỗi mạng hoặc 5xx → tự quay về chính web này (không làm hỏng thao tác).
 *   MnhaData.label()  tên web đang được dùng (hiện ở huy hiệu và thanh tiến trình).
 */
(function () {
    'use strict';
    if (window.MnhaData) return;
    var ticket = null, negUntil = 0, pending = null, usedName = '', usedId = '';

    function isLocalHost() { return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname); }

    function paint(info) {
        var name, id, cls;
        if (info && info.node) { name = info.node.name; id = info.node.id; }
        else if (info && info.self) { name = info.self.name; id = info.self.id; }
        else { name = location.hostname; id = location.hostname; }
        usedName = name; usedId = id;
        var els = document.querySelectorAll('[data-data-badge]');
        for (var i = 0; i < els.length; i++) {
            var n = els[i].querySelector('[data-role="name"]'), d = els[i].querySelector('[data-role="id"]');
            if (n) n.textContent = name;
            if (d) d.textContent = '(' + id + (isLocalHost() ? ' · localhost' : '') + ')';
        }
    }

    function getTicket() {
        if (isLocalHost()) { paint({ self: { name: 'localhost', id: 'localhost' } }); return Promise.resolve(null); }
        if (ticket && ticket.exp - 60000 > Date.now()) return Promise.resolve(ticket);
        if (Date.now() < negUntil) return Promise.resolve(null);
        if (pending) return pending;
        pending = fetch('/api/data-ticket', { credentials: 'same-origin', headers: { Accept: 'application/json' }, cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                if (d && d.ok && d.node && d.ticket) { ticket = d; paint(d); }
                else { ticket = null; negUntil = Date.now() + 60000; paint(d); }
                return ticket;
            })
            .catch(function () { negUntil = Date.now() + 30000; paint(null); return null; })
            .then(function (t) { pending = null; return t; });
        return pending;
    }

    function reportFail(t) {
        try {
            fetch('/api/data-ticket/fail', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: t.node.id }) });
        } catch (e) { /* bỏ qua */ }
        ticket = null; negUntil = 0;
    }

    function viaNode(t, path, init) {
        var o = {}; for (var k in init) if (Object.prototype.hasOwnProperty.call(init, k)) o[k] = init[k];
        o.credentials = 'omit';
        o.headers = {}; var h = init && init.headers ? init.headers : {};
        for (var hk in h) if (Object.prototype.hasOwnProperty.call(h, hk)) o.headers[hk] = h[hk];
        o.headers['Authorization'] = 'Bearer ' + t.ticket;
        return fetch(t.node.url + '/api/node/data' + path, o);
    }

    function dataFetch(path, init) {
        init = init || {};
        return getTicket().then(function (t) {
            var local = function () { return fetch(path, Object.assign({ credentials: 'same-origin' }, init)); };
            if (!t) return local();
            return viaNode(t, path, init).then(function (res) {
                // Chỉ quay về web hiện tại khi LỖI VÉ / LỖI MẠNG CỦA WEB KẾT NỐI — lỗi nghiệp vụ (vd 403 không có quyền) giữ nguyên.
                if (res.headers.get('X-Data-Ticket-Error') || res.status === 502 || res.status === 503 || res.status === 504) {
                    reportFail(t);
                    return local();
                }
                return res;
            }, function () { reportFail(t); return local(); });
        });
    }

    window.MnhaData = {
        fetch: dataFetch,
        ticket: getTicket,
        label: function () { return usedName; },
        info: function () { return usedName ? { name: usedName, id: usedId, local: isLocalHost() } : null; }
    };

    // Huy hiệu trên trang: xin vé sớm để hiện đúng tên web kết nối ngay khi mở trang.
    function init() { if (document.querySelector('[data-data-badge]')) getTicket(); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
