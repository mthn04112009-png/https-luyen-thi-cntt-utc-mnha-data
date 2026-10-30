/* ============================================================
 * videoViewer.js — trang xem Video bài giảng (/videos/study/:id)
 * Dữ liệu từ <script id="vdData" type="application/json">: { videos:[{ n, id, title, src, ratio, frameTitle, error }], iframeAllow, iframeReferrer }
 * Server đã giải mã + kiểm tra mã nhúng; ở đây chỉ DỰNG thẻ <iframe> bằng DOM (không innerHTML) với thuộc tính do web đặt.
 * Mỗi khung giữ tỉ lệ width/height của video (aspect-ratio) nên tự co giãn theo bề rộng màn hình.
 * ============================================================ */
(function () {
    'use strict';
    var dataEl = document.getElementById('vdData');
    if (!dataEl) return;
    var vd;
    try { vd = JSON.parse(dataEl.textContent); } catch (e) { return; }

    /* ---- Hạn chế soi trang (chỉ là rào cản với người xem thường, không phải bảo mật tuyệt đối) ----
     *  • Chặn chuột phải trên cả trang.
     *  • Bấm phím mở DevTools (Ctrl+Shift+I/J/C, F12; macOS: Cmd+Option+I/J/C) ⇒ chuyển về danh sách môn học. */
    var blocked = (function guard() {
        if (vd.admin === true) return false;      // tài khoản admin (server đặt vd.admin) được mở DevTools / chuột phải thoải mái
        var HOME = (vd.base ? vd.base : '/videos') + '/subjects';
        function leave() { try { window.location.replace(HOME); } catch (e) { window.location.href = HOME; } }
        document.addEventListener('contextmenu', function (e) { e.preventDefault(); }, true);
        document.addEventListener('keydown', function (e) {
            var c = e.code, tools = (c === 'KeyI' || c === 'KeyJ' || c === 'KeyC');
            var hit = c === 'F12' || (e.ctrlKey && e.shiftKey && tools) || (e.metaKey && e.altKey && tools);
            if (hit) { e.preventDefault(); e.stopPropagation(); leave(); }
        }, true);

        /* DevTools ĐÃ MỞ SẴN trước khi vào trang (hoặc mở bằng menu trình duyệt, không qua phím tắt) ⇒ chuyển về danh sách môn học.
         * Bỏ qua điện thoại / máy tính bảng (không có F12; thanh trình duyệt làm lệch kích thước). */
        if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return false;
        var SIZE_GAP = 200;                       // lệch outer/inner quá mức này ⇒ DevTools gắn cạnh/đáy cửa sổ (tăng nếu bị nhận nhầm do zoom)
        function bySize() {
            return (window.outerWidth - window.innerWidth > SIZE_GAP) || (window.outerHeight - window.innerHeight > SIZE_GAP);
        }
        function byDebugger() {                   // DevTools tách rời cửa sổ: lệnh debugger chỉ làm trang dừng khi DevTools đang mở
            var t = performance.now();
            debugger;
            return performance.now() - t > 100;
        }
        /* Lớp 3 — không phụ thuộc breakpoint (vẫn bắt được khi người xem bấm "Deactivate breakpoints" làm lệnh debugger vô hiệu):
         * in 1 phần tử có thuộc tính id dạng getter ra console; DevTools đang mở sẽ đọc id để vẽ xem trước ⇒ getter chạy.
         * Kết quả có thể đến trễ nên đọc ở vòng kiểm tra sau. */
        var consoleHit = false, probe = new Image();
        try { Object.defineProperty(probe, 'id', { get: function () { consoleHit = true; return ''; } }); } catch (e) { /* ignore */ }
        function ping() { try { console.debug(probe); } catch (e) { /* ignore */ } }
        function open() { var hit = consoleHit || bySize() || byDebugger(); ping(); return hit; }
        if (open()) { leave(); return true; }     // F12 đã mở lúc dán link
        setTimeout(function () { if (consoleHit) leave(); }, 400);
        setInterval(function () { if (open()) leave(); }, 1000);   // mở F12 sau khi trang đã tải
        return false;
    })();
    if (blocked) return;                          // không dựng trình phát khi đang bị chuyển hướng

    /* ---- Watermark: hiện email + IP người xem ở góc phải dưới màn hình ----
     * Dữ liệu do SERVER đặt trong vdData: vd.email, vd.ip (trình duyệt không tự biết IP thật). Thiếu cả hai thì không hiện.
     * Khi vào toàn màn hình, phần tử được chuyển vào chính phần tử đang fullscreen để vẫn hiện; thoát ra thì trả về <body>.
     * Bị xoá khỏi DOM (F12) ⇒ tự gắn lại. Không bắt chuột nên không cản thao tác. */
    (function watermark() {
        var parts = [];
        if (vd.email) parts.push(String(vd.email));
        if (vd.ip) parts.push('IP ' + String(vd.ip));
        if (!parts.length) return;
        var wm = document.createElement('div');
        wm.id = 'vdWatermark';
        wm.textContent = parts.join(' · ');
        wm.style.cssText = 'position:fixed;right:10px;bottom:8px;z-index:2147483000;max-width:80vw;padding:3px 8px;border-radius:6px;' +
            'font:12px/1.3 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:rgba(255,255,255,.75);background:rgba(0,0,0,.35);' +
            'text-shadow:0 1px 2px rgba(0,0,0,.8);pointer-events:none;user-select:none;-webkit-user-select:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        function host() { return document.fullscreenElement || document.webkitFullscreenElement || document.body; }
        function attach() { var h = host(); if (wm.parentNode !== h) h.appendChild(wm); }
        attach();
        document.addEventListener('fullscreenchange', attach);
        document.addEventListener('webkitfullscreenchange', attach);
        try {
            new MutationObserver(function () { if (!wm.isConnected) attach(); })
                .observe(document.documentElement, { childList: true, subtree: true });
        } catch (e) { /* ignore */ }
    })();
    var list = document.getElementById('vdList');
    var index = document.getElementById('vdIndex');
    var pager = document.getElementById('vdPager');
    var prev = document.getElementById('vdPrev');
    var next = document.getElementById('vdNext');
    var pos = document.getElementById('vdPos');
    var modeAll = document.getElementById('vdModeAll');
    var modeOne = document.getElementById('vdModeOne');
    var videos = Array.isArray(vd.videos) ? vd.videos : [];
    var mode = 'one', cur = 0;      // chỉ còn chế độ "Từng video" (đã bỏ "Xem tất cả")

    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    function buildFrame(v) {
        if (v.player === 'yt' && !v.error && window.VdYT) return window.VdYT.create(v, vd);
        var box = el('div', 'vd-frame');
        if (v.error || !v.src) {
            box.className = 'vd-err';
            box.textContent = v.error || 'Video này không có nguồn phát.';
            return box;
        }
        var r = Number(v.ratio);
        if (r > 0 && isFinite(r)) box.style.aspectRatio = String(r);
        var f = document.createElement('iframe');
        f.src = v.src;
        f.title = v.frameTitle || v.title || ('Video ' + v.n);
        f.setAttribute('allow', vd.iframeAllow || 'fullscreen');
        f.setAttribute('allowfullscreen', '');
        f.setAttribute('referrerpolicy', vd.iframeReferrer || 'strict-origin-when-cross-origin');
        f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox');
        f.setAttribute('loading', 'lazy');
        box.appendChild(f);
        return box;
    }

    function buildItem(v, i) {
        var item = el('section', 'vd-item');
        item.id = 'v' + (i + 1);
        var h = el('h2', 'vd-item-h');
        h.appendChild(el('span', 'n', String(i + 1)));
        h.appendChild(el('span', '', v.title || ('Video ' + (i + 1))));
        item.appendChild(h);
        item.appendChild(buildFrame(v));
        return item;
    }

    function clearList() {
        var olds = list.querySelectorAll('.vd-frame');
        for (var k = 0; k < olds.length; k++) { if (olds[k]._destroy) olds[k]._destroy(); }
        while (list.firstChild) list.removeChild(list.firstChild);
    }

    function renderIndex() {
        while (index.firstChild) index.removeChild(index.firstChild);
        if (videos.length < 2) return;
        videos.forEach(function (v, i) {
            var b = el('button', i === cur && mode === 'one' ? 'on' : '', (i + 1) + '. ' + (v.title || 'Video ' + (i + 1)));
            b.type = 'button';
            b.title = v.title || ('Video ' + (i + 1));
            b.addEventListener('click', function () {
                if (mode === 'one') { cur = i; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
                else {
                    var t = document.getElementById('v' + (i + 1));
                    if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            });
            index.appendChild(b);
        });
    }

    function render() {
        clearList();
        if (!videos.length) { list.appendChild(el('div', 'vd-empty', 'Bài này chưa có video.')); pager.hidden = true; return; }
        if (mode === 'one') {
            if (cur < 0) cur = 0;
            if (cur > videos.length - 1) cur = videos.length - 1;
            list.appendChild(buildItem(videos[cur], cur));
            pager.hidden = videos.length < 2;
            prev.disabled = cur === 0;
            next.disabled = cur === videos.length - 1;
            pos.textContent = 'Video ' + (cur + 1) + ' / ' + videos.length;
        } else {
            videos.forEach(function (v, i) { list.appendChild(buildItem(v, i)); });
            pager.hidden = true;
        }
        // ẩn cụm nút chuyển chế độ (không còn chế độ nào khác để chọn)
        if (modeAll && modeAll.parentNode) modeAll.parentNode.hidden = true;
        renderIndex();
    }

    prev.addEventListener('click', function () { cur--; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
    next.addEventListener('click', function () { cur++; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
    /* Phím ← / → đã dành cho TUA video (xử lý trong videoYtPlayer.js), không còn chuyển video trước/sau nữa. */

    render();
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
})();
