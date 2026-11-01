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

    /* ---- DẤU CHỐNG SAO CHÉP cho video NHÚNG KHÁC (Vimeo, Drive, Bunny, Facebook…) — giống dấu của video YouTube ----
     *  • Email + IP người xem lấy từ vd.email / vd.ip trong #vdData (server đặt cho MỌI video, không chỉ YouTube).
     *  • 2 lớp: (1) dấu cố định góc PHẢI TRÊN, (2) dấu mờ NỔI đổi chỗ mỗi WM_EVERY ms.
     *  • Nằm trong chính khung (.vd-frame) nên vẫn hiện khi bấm ⛶ của web (toàn màn hình) — xem OWN_FULLSCREEN bên dưới.
     *  • Không bắt chuột; xoá / sửa bằng DevTools ⇒ tự dựng lại (MutationObserver). Chỉ là rào cản, không tuyệt đối. */
    var WM_OP = 0.3, WM_EVERY = 9000, WM_TOP = 44, WM_BOTTOM = 64;
    /* OWN_FULLSCREEN = true: bỏ nút toàn màn hình GỐC của trình phát nhúng (nó đưa riêng iframe lên toàn màn hình → dấu bị che mất)
     * và thay bằng nút ⛶ của web (phóng cả khung + dấu). false: giữ nút gốc nhưng dấu sẽ KHÔNG hiện khi xem toàn màn hình. */
    var OWN_FULLSCREEN = true;

    var WM_BASE = 'position:absolute!important;z-index:2147483000!important;display:block!important;visibility:visible!important;transform:none!important;' +
        'pointer-events:none!important;user-select:none!important;-webkit-user-select:none!important;mix-blend-mode:normal!important;white-space:nowrap!important;' +
        'color:#fff!important;overflow:hidden!important;text-overflow:ellipsis!important;';
    var WM_A = WM_BASE + 'right:12px!important;left:auto!important;bottom:auto!important;top:10px!important;opacity:.78!important;text-align:right!important;max-width:70%!important;' +
        'font:600 clamp(10px,1.05vw,13px)/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif!important;text-shadow:0 0 3px #000,0 1px 2px #000,0 0 6px rgba(0,0,0,.9)!important;';
    var WM_B = WM_BASE + 'max-width:90%!important;font:500 clamp(11px,1.15vw,16px)/1.3 system-ui,-apple-system,Segoe UI,Roboto,sans-serif!important;' +
        'text-shadow:0 0 2px rgba(0,0,0,.85),0 0 5px rgba(0,0,0,.6)!important;transition:opacity .6s ease;';

    function addWatermark(box) {
        var email = String(vd.email || vd.viewerEmail || ''), ip = String(vd.ip || vd.viewerIp || '');
        var lines = [email, ip ? 'IP: ' + ip : ''].filter(Boolean);
        if (!lines.length) return null;
        var one = lines.join('  \u00b7  ');
        var dead = false, x = 12, y = WM_TOP, op = WM_OP, tCycle = null, tFade = null, moA = null, moB = null, moBox = null;
        var a = el('div', 'vd-wm'), b = el('div', 'vd-wm2');

        function fillA() {
            var same = a.childNodes.length === lines.length;
            for (var i = 0; same && i < lines.length; i++) { if (a.childNodes[i].textContent !== lines[i]) same = false; }
            if (same) return;
            while (a.firstChild) a.removeChild(a.firstChild);
            lines.forEach(function (t) { a.appendChild(el('div', '', t)); });
        }
        function applyA() {
            fillA();
            a.style.cssText = WM_A;
            if (a.className !== 'vd-wm') a.className = 'vd-wm';
            a.hidden = false;
            if (moA) moA.takeRecords();
        }
        function applyB() {
            if (b.textContent !== one) b.textContent = one;
            b.style.cssText = WM_B + 'left:' + x + 'px!important;top:' + y + 'px!important;opacity:' + op + '!important;';
            if (b.className !== 'vd-wm2') b.className = 'vd-wm2';
            b.hidden = false;
            if (moB) moB.takeRecords();
        }
        function moveB() {
            var r = box.getBoundingClientRect(), w = b.offsetWidth || 220, h = b.offsetHeight || 20;
            var maxX = Math.max(10, Math.floor(r.width - w - 10)), maxY = Math.max(WM_TOP, Math.floor(r.height - h - WM_BOTTOM));
            x = Math.round(10 + Math.random() * (maxX - 10));
            y = Math.round(WM_TOP + Math.random() * (maxY - WM_TOP));
        }
        function cycle() {
            if (dead) return;
            op = 0; applyB();                                              // mờ hẳn → đổi chỗ → hiện lại
            clearTimeout(tFade);
            tFade = setTimeout(function () { if (dead) return; moveB(); op = WM_OP; applyB(); }, 700);
        }

        applyA(); box.appendChild(a);
        applyB(); box.appendChild(b); moveB(); applyB();
        tCycle = setInterval(cycle, WM_EVERY);

        if (typeof MutationObserver === 'function') {
            var opt = { attributes: true, childList: true, subtree: true, characterData: true };
            moA = new MutationObserver(function () { if (dead) return; if (a.parentNode !== box) box.appendChild(a); applyA(); });
            moA.observe(a, opt);
            moB = new MutationObserver(function () { if (dead) return; if (b.parentNode !== box) box.appendChild(b); applyB(); });
            moB.observe(b, opt);
            moBox = new MutationObserver(function () {
                if (dead) return;
                if (a.parentNode !== box) { box.appendChild(a); applyA(); }
                if (b.parentNode !== box) { box.appendChild(b); applyB(); }
            });
            moBox.observe(box, { childList: true });
        }
        return function destroy() {
            dead = true; clearInterval(tCycle); clearTimeout(tFade);
            [moA, moB, moBox].forEach(function (m) { if (m) { try { m.disconnect(); } catch (e) { /* ignore */ } } });
        };
    }

    /* Toàn màn hình do WEB điều khiển cho video nhúng khác (phóng cả khung chứa iframe + dấu). */
    function addOwnFullscreen(box) {
        if (!document.getElementById('vdFsStyle')) {
            var st = document.createElement('style'); st.id = 'vdFsStyle';
            st.textContent = '.vd-frame.vd-fs-x{position:relative}' +
                '.vd-frame.vd-fs-x:fullscreen{width:100vw!important;height:100vh!important;aspect-ratio:auto!important;background:#000}' +
                '.vd-frame.vd-fs-x:-webkit-full-screen{width:100vw!important;height:100vh!important;aspect-ratio:auto!important;background:#000}' +
                '.vd-frame.vd-fs-x.vd-pfsx{position:fixed!important;left:0!important;top:0!important;width:100vw!important;height:100vh!important;height:100dvh!important;aspect-ratio:auto!important;margin:0!important;z-index:2147482000;background:#000}' +
                '.vd-frame.vd-fs-x:fullscreen iframe,.vd-frame.vd-fs-x.vd-pfsx iframe{width:100%!important;height:100%!important}' +
                '.vd-frame.vd-fs-x:-webkit-full-screen iframe{width:100%!important;height:100%!important}';
            document.head.appendChild(st);
        }
        box.classList.add('vd-fs-x');
        var btn = el('button', 'vd-fs-btn', '\u26F6'); btn.type = 'button'; btn.title = 'Toàn màn hình'; btn.setAttribute('aria-label', 'Toàn màn hình');
        btn.style.cssText = 'position:absolute;right:8px;top:46px;z-index:2147483001;width:34px;height:34px;border:0;border-radius:8px;background:rgba(0,0,0,.55);color:#fff;font-size:18px;line-height:1;cursor:pointer;';
        function fsEl() { return document.fullscreenElement || document.webkitFullscreenElement; }
        btn.addEventListener('click', function () {
            if (box.classList.contains('vd-pfsx')) { box.classList.remove('vd-pfsx'); return; }
            if (fsEl() === box) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
            var f = box.requestFullscreen || box.webkitRequestFullscreen;
            if (f) { try { var p = f.call(box); if (p && p.catch) p.catch(function () { box.classList.add('vd-pfsx'); }); } catch (e) { box.classList.add('vd-pfsx'); } }
            else box.classList.add('vd-pfsx');                              // iPhone: không có fullscreen cho phần tử → phóng giả bằng CSS
        });
        box.appendChild(btn);
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
        if (OWN_FULLSCREEN) {
            var allow = String(vd.iframeAllow || '').split(';').map(function (x) { return x.trim(); })
                .filter(function (x) { return x && !/^fullscreen\b/i.test(x); }).join('; ');
            if (allow) f.setAttribute('allow', allow);
        } else {
            f.setAttribute('allow', vd.iframeAllow || 'fullscreen');
            f.setAttribute('allowfullscreen', '');
        }
        f.setAttribute('referrerpolicy', vd.iframeReferrer || 'strict-origin-when-cross-origin');
        f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox');
        f.setAttribute('loading', 'lazy');
        box.appendChild(f);
        if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
        if (OWN_FULLSCREEN) addOwnFullscreen(box);
        var wmOff = addWatermark(box);                  // dấu email + IP cho mọi video nhúng không phải YouTube
        if (wmOff) box._destroy = wmOff;
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
