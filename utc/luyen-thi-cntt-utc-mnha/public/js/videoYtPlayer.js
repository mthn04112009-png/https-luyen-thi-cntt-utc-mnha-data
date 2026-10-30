/* ============================================================
 * videoYtPlayer.js — TRÌNH PHÁT RIÊNG cho video YouTube (Video bài giảng)
 * ------------------------------------------------------------
 *  • Trang KHÔNG chứa iframe/link/mã video YouTube. Chỉ khi người xem bấm ▶ mới gọi
 *    GET /videos/play/:bài/:video (cần đăng nhập + đúng quyền, no-store) để lấy mã, rồi dựng YouTube IFrame API.
 *  • Tắt toàn bộ giao diện của YouTube (controls=0, fs=0, disablekb=1…) và phủ 1 lớp "shield" lên khung phát:
 *    mọi cú nhấp đều vào lớp này nên không bấm được tiêu đề / logo YouTube / "Xem trên YouTube" / chia sẻ / video gợi ý.
 *  • Thanh điều khiển riêng: phát/dừng, tua, âm lượng, tốc độ, toàn màn hình. Chuột phải bị tắt trên khung phát.
 * GIỚI HẠN (không thể khắc phục ở trình duyệt): người rành kỹ thuật vẫn thấy mã video trong tab Network/DevTools
 *    khi video đang phát. Cách này chặn người xem thường, không phải bảo mật tuyệt đối.
 * API: window.VdYT.create(item, vd) → phần tử .vd-frame (có _destroy)
 * ============================================================ */
(function () {
    'use strict';
    /* NATIVE_CONTROLS = true: dùng thanh điều khiển GỐC của YouTube (chọn chất lượng, tua, phụ đề, tốc độ… bấm được như trên YouTube).
     *   Chỉ chặn: chuyển trang / mở tab YouTube (iframe sandbox KHÔNG có allow-popups, allow-top-navigation) và chuột phải trên vùng hình.
     * false: quay lại thanh điều khiển tự dựng (không chọn được chất lượng thật). */
    /* Điện thoại / máy tính bảng (chạm): KHÔNG dùng thanh gốc của YouTube (nó có nút sao chép link, ⋮, "Xem trên YouTube", logo… bấm được).
     * Thay vào đó che KÍN cả khung và dùng thanh điều khiển tự dựng của web. Máy tính (chuột) giữ thanh gốc + các lỗ như cũ. */
    var IS_TOUCH = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    /* LUÔN dùng thanh điều khiển riêng + che kín khung (giống điện thoại) cho mọi thiết bị.
     * Lý do: nút ⛶ gốc của YouTube đưa CHÍNH iframe lên toàn màn hình → lớp chắn của web nằm dưới, không che được link/logo/tiêu đề nữa.
     * Giờ iframe không có nút ⛶ gốc (fs=0, không allowfullscreen); nút ⛶ của web phóng to cả khung (iframe + lớp chắn + thanh riêng). */
    var NATIVE_CONTROLS = false;
    /* Lớp chắn PHỦ TOÀN BỘ khung (chặn chuột phải, tiêu đề, logo, link…) trừ vài "lỗ" đúng chỗ các nút gốc của YouTube cần bấm.
     * Mỗi lỗ là [trái, trên, phải, dưới] tính theo % khung (các lỗ không được chồng lên nhau). Chỉ trong các lỗ này chuột phải mới ra menu YouTube
     * — không tránh được vì iframe khác trang: muốn bấm được nút của nó thì chuột phải trên chính nút đó cũng tới được nó.
     * Theo bố cục YouTube hiện tại: trên-phải = âm lượng, CC, ⚙ ; đáy = thanh tua và ⛶. Lệch thì chỉnh số ở đây. */
    /* Hiệu chỉnh: mở trang với ?vddebug=1 ⇒ lớp chắn tô đỏ nhạt, các LỖ trong suốt hiện rõ để căn cho khớp từng nút.
     * Giữ lỗ vừa khít nút: lỗ càng rộng thì càng dễ chạm vào link YouTube (logo ở góc dưới phải, tiêu đề ở trên trái) ⇒ hiện URL ở thanh trạng thái. */
    /* Các nút gốc của YouTube có kích thước/vị trí CỐ ĐỊNH theo px tính từ mép khung (không đổi theo % khi phóng to), nên lớp chắn cũng tính theo px:
     *   • TOP_H     : dải trên che avatar + tiêu đề (link YouTube) — cao 66px.
     *   • HOLE_R_FAR / HOLE_R_NEAR : lỗ trên-phải (âm lượng · CC · ⚙) nằm cách mép PHẢI từ 214px đến 22px.
     *   • BOTTOM_H  : dải dưới che nút sao chép link + logo YouTube — cao 74px (thanh tua nằm ngay trên dải này).
     * Phần giữa khung để trống. Thường và toàn màn hình đều cùng số px ⇒ căn y hệt nhau trên mọi màn hình. Lệch thì chỉnh 4 số này (xem bằng ?vddebug=1). */
    var TOP_H = 66, BOTTOM_H = 74, HOLE_R_FAR = 214, HOLE_R_NEAR = 22;
    /* TOÀN MÀN HÌNH: YouTube vẽ giao diện to hơn (tiêu đề/avatar cao hơn, nút lớn hơn) nên vùng có link cũng rộng hơn → dải che dày hơn, và
     * CHE THÊM phần giữa-trái của hình (bấm vào đó vẫn phát/dừng nhờ lớp chắn). Chỉ chừa: dải điều khiển dưới (thanh tua, giờ, ⛶),
     * cột phải rộng FS_RIGHT (âm lượng · CC · ⚙ và menu ⚙ bung ra). */
    var FS_TOP_H = 104, FS_BOTTOM_H = 84, FS_BAND = 90, FS_RIGHT = 340;
    function piecesFor(fs) {
        if (!fs) return [
            'left:0;top:0;right:' + HOLE_R_FAR + 'px;height:' + TOP_H + 'px;',          // trên-trái: avatar + tiêu đề
            'right:0;top:0;width:' + HOLE_R_NEAR + 'px;height:' + TOP_H + 'px;',        // mép phải trên
            'left:0;right:0;bottom:0;height:' + BOTTOM_H + 'px;'                        // dải dưới: link + logo
        ];
        return [
            'left:0;top:0;right:' + HOLE_R_FAR + 'px;height:' + FS_TOP_H + 'px;',                                              // trên-trái: avatar + tiêu đề (cao hơn)
            'right:0;top:0;width:' + HOLE_R_NEAR + 'px;height:' + TOP_H + 'px;',                                              // mép phải trên
            'left:0;right:0;bottom:0;height:' + FS_BOTTOM_H + 'px;',                                                          // dải dưới: link + logo
            'left:0;right:' + FS_RIGHT + 'px;top:' + FS_TOP_H + 'px;bottom:' + (FS_BOTTOM_H + FS_BAND) + 'px;'                // giữa-trái của hình
        ];
    }
    /* ---- HYBRID (chỉ máy có chuột) ----
     * Giữ thanh điều khiển + lớp chắn của web, nhưng chừa 1 lỗ đúng nút ⚙ gốc của YouTube để người xem chọn "Chất lượng" THẬT.
     * Bấm ⚙ ⇒ bảng menu YouTube bung ra GIỮA-ĐÁY khung (rộng ~500px) và nút ✕ ở GIỮA-ĐỈNH ⇒ lúc đó mở thêm lỗ cho bảng + ✕
     * (mọi chỗ khác vẫn bị che; bấm ra ngoài bảng ⇒ thoát chế độ menu). Thanh web vẫn hiện. Căn lại bằng ?vddebug=1. */
    var HYBRID = !IS_TOUCH && !NATIVE_CONTROLS;
    var GEAR_R_FAR = 116, GEAR_R_NEAR = 24;    // lỗ CC + ⚙: cách mép PHẢI từ 24px đến 116px (⚙ ≈ 28–62, CC ≈ 77–111; nút âm lượng gốc ≈ 126–158 nằm NGOÀI lỗ nên bị che)
    var MENU_HALF = 270, MENU_X_HALF = 60, MENU_H = 340;   // nửa bề rộng bảng menu (500/2 + dư) · nửa bề rộng vùng nút ✕ giữa-đỉnh · chiều cao vùng chừa cho bảng menu (kể cả danh sách chất lượng)
    function hybridPieces(menuOpen, fs) {
        var th = fs ? FS_TOP_H : TOP_H, bh = fs ? FS_BOTTOM_H : BOTTOM_H;
        if (!menuOpen) return [
            'left:0;top:0;right:' + GEAR_R_FAR + 'px;height:' + th + 'px;',          // trên-trái: avatar + tiêu đề
            'right:0;top:0;width:' + GEAR_R_NEAR + 'px;height:' + th + 'px;',        // mép phải trên
            'left:0;right:0;top:' + th + 'px;bottom:0;'                              // phần còn lại của khung
        ];
        var side = 'max(0px,calc(50% - ' + MENU_HALF + 'px))', xs = 'max(0px,calc(50% - ' + MENU_X_HALF + 'px))', xe = 'calc(50% + ' + MENU_X_HALF + 'px)';
        return [
            'left:0;top:0;width:' + xs + ';height:' + th + 'px;',                                      // trên-trái: tiêu đề (chừa ✕ ở giữa)
            'left:' + xe + ';top:0;right:' + GEAR_R_FAR + 'px;height:' + th + 'px;',                    // trên giữa → trước lỗ CC/⚙ (chừa ✕)
            'right:0;top:0;width:' + GEAR_R_NEAR + 'px;height:' + th + 'px;',                           // mép phải trên
            'left:0;right:0;top:' + th + 'px;bottom:' + MENU_H + 'px;',                                 // dải giữa: bấm vào đây = thoát menu + phát/dừng của web
            'left:0;bottom:0;width:' + side + ';height:' + MENU_H + 'px;',                              // trái bảng menu
            'right:0;bottom:0;width:' + side + ';height:' + MENU_H + 'px;'                              // phải bảng menu
        ];
    }
    var NATIVE_HOLES = null;
    /* Máy tính: phần GIỮA khung để trống (bấm/chuột phải tới thẳng YouTube). Điện thoại/máy tính bảng thì che kín cả khung (xem IS_TOUCH). */
    /* Khi người xem BẤM vào nút gốc (⚙ …) menu của YouTube bung ra phía trên thanh điều khiển → cần thêm 1 lỗ lớn cho menu.
     * Chỉ MỞ THÊM lỗ này, KHÔNG tắt cả lớp chắn: tiêu đề (trên-trái) và logo (đáy) vẫn được che. Các lỗ không chồng nhau. */
    var NATIVE_HOLES_MENU = NATIVE_HOLES;      // vùng giữa đã trống nên menu ⚙ không cần khoét thêm
    /* Chia phần CÒN LẠI của khung (trừ các lỗ) thành các hình chữ nhật rời; mỗi mảnh là một div trong suốt bắt chuột.
     * Chuột chỉ chạm iframe YouTube ở đúng các lỗ ⇒ ở mọi nơi khác trình duyệt KHÔNG thấy link của YouTube nên không hiện URL ở thanh trạng thái. */
    function shieldRects(holes) {
        var ys = [0, 100], rects = [];
        holes.forEach(function (h) { ys.push(h[1], h[3]); });
        ys = ys.filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; });
        for (var i = 0; i < ys.length - 1; i++) {
            var y1 = ys[i], y2 = ys[i + 1], ym = (y1 + y2) / 2, x = 0;
            holes.filter(function (h) { return h[1] <= ym && ym < h[3]; }).map(function (h) { return [h[0], h[2]]; })
                .sort(function (a, b) { return a[0] - b[0]; })
                .forEach(function (c) { if (c[0] > x) rects.push([x, y1, c[0], y2]); x = Math.max(x, c[1]); });
            if (x < 100) rects.push([x, y1, 100, y2]);
        }
        return rects;
    }
    var apiPromise = null;
    var QKEY = 'vdYtQuality';
    var QLABEL = { highres: 'Cao nhất', hd2880: '2880p', hd2160: '2160p', hd1440: '1440p', hd1080: '1080p', hd720: '720p', large: '480p', medium: '360p', small: '240p', tiny: '144p', auto: 'Tự động' };
    var QORDER = ['highres', 'hd2880', 'hd2160', 'hd1440', 'hd1080', 'hd720', 'large', 'medium', 'small', 'tiny'];
    var QHEIGHT = { hd2880: 2880, hd2160: 2160, hd1440: 1440, hd1080: 1080, hd720: 720, large: 480, medium: 360, small: 240, tiny: 144 };
    var players = [];           // các trình phát đang sống — khi 1 cái phát thì tạm dừng các cái còn lại

    function loadApi() {
        if (window.YT && window.YT.Player) return Promise.resolve();
        if (apiPromise) return apiPromise;
        apiPromise = new Promise(function (resolve, reject) {
            var prev = window.onYouTubeIframeAPIReady;
            window.onYouTubeIframeAPIReady = function () { if (typeof prev === 'function') { try { prev(); } catch (e) { /* ignore */ } } resolve(); };
            var s = document.createElement('script');
            s.src = 'https://www.youtube.com/iframe_api';
            s.async = true;
            s.onerror = function () { apiPromise = null; reject(new Error('Không tải được trình phát (có thể bị chặn mạng).')); };
            document.head.appendChild(s);
            setTimeout(function () { if (!(window.YT && window.YT.Player)) { apiPromise = null; reject(new Error('Tải trình phát quá lâu, thử lại.')); } }, 15000);
        });
        return apiPromise;
    }

    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }
    function fmt(t) {
        t = Math.max(0, Math.floor(t || 0));
        var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
        var p = function (n) { return n < 10 ? '0' + n : '' + n; };
        return h ? h + ':' + p(m) + ':' + p(s) : m + ':' + p(s);
    }

    function create(item, vd) {
        var box = el('div', 'vd-frame vd-yt');
        box.tabIndex = 0;
        box.setAttribute('role', 'region');
        box.setAttribute('aria-label', item.frameTitle || item.title || 'Video');
        var r = Number(item.ratio);
        if (r > 0 && isFinite(r)) box.style.aspectRatio = String(r);

        var buildPieces = null;
        var stage = el('div', 'vd-yt-stage');
        var shield = el('div', 'vd-yt-shield');                  // nuốt mọi cú nhấp/chuột phải vào khung YouTube
        var cover = el('div', 'vd-yt-cover');                    // màn chờ / đang tải / tạm dừng / lỗi
        var coverTitle = el('div', 'vd-yt-cover-t', item.title || '');
        var big = el('button', 'vd-yt-big', '▶'); big.type = 'button'; big.setAttribute('aria-label', 'Phát video');
        var status = el('div', 'vd-yt-status');
        cover.appendChild(coverTitle); cover.appendChild(big); cover.appendChild(status);

        var bar = el('div', 'vd-yt-bar');
        var bPlay = el('button', 'vd-yt-b', '▶'); bPlay.type = 'button'; bPlay.setAttribute('aria-label', 'Phát / dừng');
        var tCur = el('span', 'vd-yt-t', '0:00');
        var seek = el('input', 'vd-yt-seek'); seek.type = 'range'; seek.min = '0'; seek.max = '1000'; seek.value = '0'; seek.setAttribute('aria-label', 'Tua');
        var tDur = el('span', 'vd-yt-t', '0:00');
        var bMute = el('button', 'vd-yt-b', '🔊'); bMute.type = 'button'; bMute.setAttribute('aria-label', 'Tắt / bật tiếng');
        var vol = el('input', 'vd-yt-vol'); vol.type = 'range'; vol.min = '0'; vol.max = '100'; vol.value = '100'; vol.setAttribute('aria-label', 'Âm lượng');
        var rate = el('select', 'vd-yt-rate'); rate.setAttribute('aria-label', 'Tốc độ phát');
        [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].forEach(function (x) { var o = el('option', '', x + 'x'); o.value = String(x); if (x === 1) o.selected = true; rate.appendChild(o); });
        var qual = el('select', 'vd-yt-rate vd-yt-q'); qual.setAttribute('aria-label', 'Chất lượng hình ảnh');
        var qo = el('option', '', 'Tự động'); qo.value = 'auto'; qual.appendChild(qo);
        var bTh = el('button', 'vd-yt-b', '▭'); bTh.type = 'button'; bTh.setAttribute('aria-label', 'Chế độ rạp'); bTh.title = 'Chế độ rạp (T)';
        var bFs = el('button', 'vd-yt-b', '⛶'); bFs.type = 'button'; bFs.setAttribute('aria-label', 'Toàn màn hình');
        [bPlay, tCur, seek, tDur, bMute, vol, rate, qual].concat(IS_TOUCH ? [] : [bTh], [bFs]).forEach(function (x) { bar.appendChild(x); });

        var note = el('div', 'vd-yt-note'); note.hidden = true;
        box.appendChild(stage); box.appendChild(shield); box.appendChild(cover); box.appendChild(note); box.appendChild(bar);

        /* ---- DẤU CHỐNG SAO CHÉP: web + email + IP người xem, góc PHẢI DƯỚI khung phát ----
         * • Thanh điều khiển ẨN  ⇒ dấu nằm sát đáy khung.   • Thanh điều khiển HIỆN ⇒ dấu nằm NGAY TRÊN thanh tua / thanh điều khiển.
         * • Nằm trong chính khung (box) nên vẫn hiện khi toàn màn hình / chế độ rạp; không bắt chuột (pointer-events:none).
         * • Dữ liệu do server đặt: vd.email, vd.ip (trong #vdData) và/hoặc d.email, d.ip (trong kết quả GET /play/…).
         * • Chống gỡ: xoá phần tử / sửa style / sửa chữ bằng DevTools ⇒ tự dựng lại ngay (MutationObserver). Chỉ là rào cản, không tuyệt đối. */
        var wmEmail = String(vd.email || vd.viewerEmail || ''), wmIp = String(vd.ip || vd.viewerIp || '');
        var wm = el('div', 'vd-yt-wm'), wmBottom = -1, wmTimer = null, wmMo = null, wmMoBox = null;
        var WM_CSS = 'position:absolute!important;right:12px!important;left:auto!important;top:auto!important;z-index:2147483000!important;display:block!important;visibility:visible!important;opacity:.78!important;' +
            'transform:none!important;pointer-events:none!important;user-select:none!important;-webkit-user-select:none!important;text-align:right!important;max-width:70%!important;' +
            'font:600 clamp(10px,1.05vw,13px)/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif!important;color:#fff!important;mix-blend-mode:normal!important;' +
            'text-shadow:0 0 3px #000,0 1px 2px #000,0 0 6px rgba(0,0,0,.9)!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important;transition:bottom .2s ease;';
        function wmLines() { return [wmEmail, wmIp ? 'IP: ' + wmIp : ''].filter(Boolean); }
        function wmFill() {
            var ls = wmLines(), same = wm.childNodes.length === ls.length;
            for (var i = 0; same && i < ls.length; i++) { if (wm.childNodes[i].textContent !== ls[i]) same = false; }
            if (same) return;
            while (wm.firstChild) wm.removeChild(wm.firstChild);
            ls.forEach(function (t) { wm.appendChild(el('div', '', t)); });
        }
        function wmApply() { wm.style.cssText = WM_CSS + 'bottom:' + (wmBottom < 0 ? 10 : wmBottom) + 'px!important;'; if (wm.className !== 'vd-yt-wm') wm.className = 'vd-yt-wm'; wm.hidden = false; if (wmMo) wmMo.takeRecords(); }
        function wmPlace() {
            if (destroyed) return;
            wmFill();
            var b = box.getBoundingClientRect(), r = bar.getBoundingClientRect(), cs = window.getComputedStyle(bar);
            var vis = cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05 && r.height > 0 && r.top < b.bottom - 4;
            var nb = vis ? Math.round(Math.max(0, b.bottom - r.top)) + 6 : 10;      // thanh hiện: nằm trên thanh · thanh ẩn: sát đáy
            if (nb !== wmBottom || !wm.getAttribute('style')) { wmBottom = nb; wmApply(); }
        }
        wmFill(); wmApply(); box.appendChild(wm);
        wmTimer = setInterval(wmPlace, 250);
        if (typeof MutationObserver === 'function') {
            wmMo = new MutationObserver(function () {
                if (destroyed) return;
                if (wm.parentNode !== box) box.appendChild(wm);
                wmFill(); wmApply();
            });
            wmMo.observe(wm, { attributes: true, childList: true, subtree: true, characterData: true });
            wmMoBox = new MutationObserver(function () { if (!destroyed && wm.parentNode !== box) { box.appendChild(wm); wmFill(); wmApply(); } });
            wmMoBox.observe(box, { childList: true });
        }
        shield.style.webkitTouchCallout = 'none'; shield.style.webkitUserSelect = 'none'; shield.style.userSelect = 'none';
        ['contextmenu', 'dragstart', 'selectstart'].forEach(function (t) { shield.addEventListener(t, function (e) { e.preventDefault(); }); });
        box.classList.add('is-idle-state');          // chưa tải: chỉ hiện nút ▶ lớn
        if (NATIVE_CONTROLS) {
            box.classList.add('vd-native');          // ẩn thanh tự dựng; lớp chắn chừa dải điều khiển gốc ở đáy khung (xem CSS)
            bar.style.display = 'none';
            shield.style.pointerEvents = 'none';     // khung chứa không bắt chuột; chỉ các mảnh con bắt (chừa các lỗ cho nút gốc)
            var dbg = /[?&]vddebug=1/.test(window.location.search);     // ?vddebug=1: tô đỏ nhạt các mảnh chắn để căn lỗ (xem NATIVE_HOLES)
            buildPieces = function () {
                while (shield.firstChild) shield.removeChild(shield.firstChild);
                piecesFor(inFs()).forEach(function (css) {
                    var d = el('div', 'vd-yt-piece');
                    d.style.cssText = 'position:absolute;pointer-events:auto;cursor:pointer;' + css + (dbg ? 'background:rgba(255,0,0,.28);' : '');
                    shield.appendChild(d);
                });
            };
            buildPieces(NATIVE_HOLES);
            ['contextmenu', 'dragstart', 'selectstart', 'auxclick'].forEach(function (t) { shield.addEventListener(t, function (e) { e.preventDefault(); }); });
            shield.style.webkitUserSelect = 'none'; shield.style.userSelect = 'none'; shield.style.webkitTouchCallout = 'none';
        }

        if (HYBRID) {
            shield.style.pointerEvents = 'none';     // chỉ các mảnh con bắt chuột; lỗ ⚙ để trống cho YouTube
            var dbgH = /[?&]vddebug=1/.test(window.location.search);
            buildPieces = function (menuOpen) {
                while (shield.firstChild) shield.removeChild(shield.firstChild);
                hybridPieces(!!menuOpen, inFs()).forEach(function (css) {
                    var d = el('div', 'vd-yt-piece');
                    d.style.cssText = 'position:absolute;pointer-events:auto;cursor:pointer;' + css + (dbgH ? 'background:rgba(255,0,0,.28);' : '');
                    shield.appendChild(d);
                });
            };
            buildPieces(false);
            qual.style.display = 'none';             // chất lượng chọn bằng ⚙ gốc của YouTube

            /* Mặt nạ che THANH ĐIỀU KHIỂN GỐC của YouTube (giờ + thanh tua + nút sao chép link + logo ở đáy) để chỉ còn thanh của web.
             * Không thể ẩn bằng CSS vì iframe khác trang ⇒ chỉ có thể phủ mảng đen lên đúng chỗ. Các thành phần gốc có vị trí CỐ ĐỊNH theo px
             * tính từ đáy khung (cùng số ở khung thường và toàn màn hình). Mặt nạ CHỈ hiện khi thanh gốc có thể hiện (đang dừng / thanh web đang hiện);
             * đang xem mà thanh web ẩn thì mặt nạ ẩn nên phụ đề / chữ ở đáy hình không bị che. Lệch thì chỉnh số bên dưới (xem bằng ?vddebug=1). */
            var MASK_ENABLED = false;                // true = bật lại các mảng đen che thanh gốc (đổi lại thành false để ẩn hết)
            var MASK = [
                'left:0;bottom:84px;width:150px;height:34px;',   // giờ "0:38 / 11:00:10" gốc (px CSS tính từ đáy: ≈ 91–111)
                'left:0;width:max(0px,calc(50% - 270px));bottom:58px;height:30px;',                                   // thanh tua gốc + chấm đỏ: nửa trái
                'left:max(0px,calc(50% - 270px));right:max(0px,calc(50% - 270px));bottom:58px;height:30px;|mid',     // đoạn giữa (ẩn khi mở menu để lộ bảng menu)
                'right:0;width:max(0px,calc(50% - 270px));bottom:58px;height:30px;',                                  // nửa phải
                'left:0;bottom:8px;width:90px;height:50px;',      // nút sao chép link (≈ 18–50)
                'right:0;bottom:12px;width:150px;height:46px;'    // logo YouTube (≈ 25–45; rộng ≈ 54–138 tính từ mép phải)
            ];
            var maskSt = document.getElementById('vdYtMaskStyle');
            if (!maskSt) {
                maskSt = document.createElement('style'); maskSt.id = 'vdYtMaskStyle';
                maskSt.textContent = '.vd-yt .vd-yt-mask{display:none;position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none}' +
                    '.vd-yt.vd-mask-on .vd-yt-mask{display:block}.vd-yt.vd-menu-open .vd-yt-mask i.mid{display:none}' +
                    '.vd-yt-mask i{position:absolute;background:#000;pointer-events:none}';
                document.head.appendChild(maskSt);
            }
            var mask = el('div', 'vd-yt-mask');
            MASK.forEach(function (css) { var parts = css.split('|'), m = document.createElement('i'); m.style.cssText = parts[0] + (dbgH ? 'background:rgba(0,80,255,.45);' : ''); if (parts[1]) m.className = parts[1]; mask.appendChild(m); });
            if (MASK_ENABLED) box.insertBefore(mask, cover);           // sau lớp chắn, TRƯỚC thanh web ⇒ thanh web nằm đè lên mặt nạ
            var pausedNow = false;
        }
        function maskSync() {                        // mặt nạ bật khi thanh gốc có thể hiện: đang dừng/hết video, hoặc thanh web đang hiện
            if (!HYBRID) return;
            box.classList.toggle('vd-mask-on', !firstPlay && (pausedNow || !box.classList.contains('is-idle')));
        }

        var videoId = '', startAt = 0, chosenQ = 'auto', noteTimer = null, qChecking = null, firstPlay = true, soundChecked = false, noQ = {}, qSeq = 0, qPending = false, restoreSound = null, restoreRate = 0, ro = null;
        if (!NATIVE_CONTROLS && !HYBRID) { try { var sq = localStorage.getItem(QKEY); if (sq && QLABEL[sq]) chosenQ = sq; } catch (e) { /* ignore */ } }
        var player = null, ready = false, loading = false, destroyed = false, dragging = false, timer = null, hideTimer = null, wantPlay = false;
        var me = { pause: function () { if (player && ready) { try { player.pauseVideo(); } catch (e) { /* ignore */ } } } };
        players.push(me);

        /* ---- Âm thanh ----
         * Lỗi cũ: kéo thanh âm lượng về 0 rồi bấm nút loa → isMuted() vẫn false nên chỉ "mute" thêm, bấm lại thì unMute()
         * nhưng âm lượng vẫn 0 ⇒ bật tiếng mà không có tiếng. Ngoài ra YouTube xử lý unMute/setVolume bất đồng bộ và trình duyệt
         * có thể tự tắt tiếng khi tự phát, nên ta: nhớ âm lượng trước đó, luôn đặt lại âm lượng > 0 khi bật tiếng và kiểm tra lại. */
        var lastVol = 100, unmuteCheck = null;
        function curVol() { try { var v = player.getVolume(); return isFinite(v) ? v : 100; } catch (e) { return 100; } }
        function isSilent() { try { return player.isMuted() || curVol() === 0; } catch (e) { return false; } }
        function doUnmute(fromUser) {
            if (!ready) return;
            var v = curVol(); if (!(v > 0)) v = lastVol > 0 ? lastVol : 100;
            lastVol = v;
            try { player.unMute(); } catch (e) { /* ignore */ }
            try { player.setVolume(v); } catch (e) { /* ignore */ }
            vol.value = String(v);
            clearTimeout(unmuteCheck);
            unmuteCheck = setTimeout(function () {
                if (destroyed || !ready) return;
                if (isSilent()) { try { player.unMute(); player.setVolume(v); } catch (e) { /* ignore */ } }
                syncUi();
                if (fromUser && isSilent()) showNote('Trình duyệt đang chặn tiếng — hãy bấm lại nút loa hoặc kéo thanh âm lượng.');
            }, 350);
        }
        function doMute() {
            if (!ready) return;
            var v = curVol(); if (v > 0) lastVol = v;
            try { player.mute(); } catch (e) { /* ignore */ }
        }
        function toggleMute() { if (!ready) return; if (isSilent()) doUnmute(true); else doMute(); syncUi(); }
        function changeVol(v) {
            if (!ready) return;
            v = Math.max(0, Math.min(100, v));
            if (v > 0) { lastVol = v; if (player.isMuted()) { try { player.unMute(); } catch (e) { /* ignore */ } } }
            try { player.setVolume(v); } catch (e) { /* ignore */ }
            vol.value = String(v);
            syncUi();
        }

        function setCover(mode, msg) {                // mode: idle | loading | paused | ended | error | hidden
            if ((NATIVE_CONTROLS || HYBRID) && mode === 'paused') mode = 'hidden';      // để lộ thanh điều khiển gốc khi đang dừng
            box.setAttribute('data-state', mode);
            status.textContent = msg || '';
            big.textContent = mode === 'ended' ? '↻' : '▶';
            big.hidden = mode === 'loading' || mode === 'hidden';
            cover.hidden = mode === 'hidden';
        }
        function playing() { return ready && player.getPlayerState && player.getPlayerState() === 1; }
        function syncUi() {
            if (!ready) return;
            var st = player.getPlayerState();
            bPlay.textContent = st === 1 ? '❚❚' : '▶';
            var d = player.getDuration() || 0, c = player.getCurrentTime() || 0;
            tDur.textContent = fmt(d);
            if (!dragging) { tCur.textContent = fmt(c); seek.value = d > 0 ? String(Math.round(c / d * 1000)) : '0'; }
            var silent = isSilent(); bMute.textContent = silent ? '🔇' : '🔊';
            if (document.activeElement !== vol) vol.value = player.isMuted() ? '0' : String(curVol());
        }
        function wake() {
            box.classList.remove('is-idle');
            clearTimeout(hideTimer);
            maskSync(); wmPlace();
            if (playing()) hideTimer = setTimeout(function () { box.classList.add('is-idle'); maskSync(); setTimeout(wmPlace, 260); }, 2600);
        }

        function showNote(msg) {
            note.textContent = msg; note.hidden = false;
            clearTimeout(noteTimer); noteTimer = setTimeout(function () { note.hidden = true; }, 4500);
        }
        function curQ() { try { return player.getPlaybackQuality(); } catch (e) { return ''; } }
        /* YouTube chỉ báo các mức "vừa với kích thước khung hiện tại" nên lúc mới phát (khung nhỏ) danh sách thường THIẾU 1080p/720p.
         * Vì vậy luôn đưa các mức phổ biến vào danh sách (noQ = mức đã kiểm chứng là video không có), sau đó xác minh khi người dùng chọn. */
        var BASE_Q = ['hd1080', 'hd720', 'large', 'medium', 'small', 'tiny'];
        function fillQualities() {
            var list = [];
            try { list = player.getAvailableQualityLevels() || []; } catch (e) { /* ignore */ }
            var have = QORDER.filter(function (q) { return q !== 'highres' && !noQ[q] && (list.indexOf(q) >= 0 || BASE_Q.indexOf(q) >= 0); });
            var keep = chosenQ;
            qual.textContent = '';
            var a = el('option', '', 'Tự động'); a.value = 'auto'; qual.appendChild(a);
            have.forEach(function (q) { var o = el('option', '', QLABEL[q]); o.value = q; qual.appendChild(o); });
            qual.value = have.indexOf(keep) >= 0 ? keep : 'auto';
            labelQualities();
        }
        function reflectAuto() {
            if (chosenQ !== 'auto') return;
            var c = curQ(), a = qual.querySelector('option[value="auto"]');
            if (a) a.textContent = QLABEL[c] ? 'Tự động (' + QLABEL[c] + ')' : 'Tự động';
        }
        /* ---- Đổi chất lượng ----
         * YouTube đã bỏ hiệu lực của setPlaybackQuality. Ở chế độ tự động, YouTube chọn độ phân giải theo KÍCH THƯỚC khung phát,
         * nên ta cho iframe một kích thước ảo đúng bằng độ phân giải muốn xem (vd 1920×1080) rồi thu nhỏ bằng CSS cho vừa khung. */
        function frameEl() { try { return player.getIframe(); } catch (e) { return null; } }
        /* ---- Đổi chất lượng ----
         * YouTube KHÔNG cho trang web ép độ phân giải bằng lệnh (setPlaybackQuality đã vô hiệu) và cũng không tin kích thước "ảo" (iframe to rồi thu nhỏ
         * bằng transform: chỉ khung đổi, độ phân giải không đổi). Ở chế độ tự động YouTube chọn theo kích thước HIỂN THỊ THẬT × devicePixelRatio.
         * Nên ở đây chất lượng được điều khiển bằng chính bề rộng thật của khung phát: chọn 720p ⇒ khung rộng đủ ~720 điểm ảnh vật lý cao, v.v.
         * Khung không thể rộng hơn cột chứa nó; muốn nét hơn nữa thì bấm toàn màn hình (khung = cả màn hình). */
        function frameEl() { try { return player.getIframe(); } catch (e) { return null; } }
        function layoutFrame() { var f = frameEl(); if (f && f.getAttribute('style')) f.removeAttribute('style'); }      // iframe luôn đúng kích thước thật (CSS: 100%)
        var pseudoFs = false;
        if (!document.getElementById('vdYtPfsStyle')) {
            var pst = document.createElement('style'); pst.id = 'vdYtPfsStyle';
            pst.textContent = '.vd-yt.vd-pfs{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;height:100dvh!important;max-height:none!important;aspect-ratio:auto!important;margin:0!important;z-index:2147483000;background:#000}';
            document.head.appendChild(pst);
        }
        /* ---- Chế độ rạp ----
         * Phóng khung ra TOÀN BỀ RỘNG cửa sổ (nền đen che phần còn lại của trang), chưa vào toàn màn hình thật.
         * Khung rộng hơn cột chứa nên YouTube chọn độ phân giải cao hơn (đặc biệt trên máy tính có tỉ lệ điểm ảnh = 1). */
        var theater = false, spacer = null;
        if (!document.getElementById('vdYtTheaterStyle')) {
            var tst = document.createElement('style'); tst.id = 'vdYtTheaterStyle';
            tst.textContent = '.vd-yt.vd-theater{position:fixed!important;left:0!important;top:50%!important;transform:translateY(-50%)!important;width:100vw!important;max-width:none!important;max-height:100vh!important;margin:0!important;z-index:2147482000;box-shadow:0 0 0 100vmax #000}' +
                '.vd-yt.vd-theater:fullscreen{top:0!important;transform:none!important;box-shadow:none!important}' +
                '.vd-yt.vd-theater:-webkit-full-screen{top:0!important;transform:none!important;box-shadow:none!important}';
            document.head.appendChild(tst);
        }
        function onTheaterKey(e) { if (e.key === 'Escape' && theater && !inFs()) { e.preventDefault(); setTheater(false); } }
        function setTheater(on) {
            if (on === theater) return;
            if (on) {
                spacer = document.createElement('div');                       // giữ chỗ cho khung để trang không bị nhảy
                spacer.style.cssText = 'width:100%;height:' + box.offsetHeight + 'px;';
                if (box.parentNode) box.parentNode.insertBefore(spacer, box);
                try { document.documentElement.style.overflow = 'hidden'; } catch (e) { /* ignore */ }
            } else {
                if (spacer && spacer.parentNode) spacer.parentNode.removeChild(spacer);
                spacer = null;
                try { document.documentElement.style.overflow = ''; } catch (e) { /* ignore */ }
            }
            theater = on;
            box.classList.toggle('vd-theater', on);
            bTh.textContent = on ? '▣' : '▭';
            bTh.title = on ? 'Thoát chế độ rạp (T / Esc)' : 'Chế độ rạp (T)';
            sizeFrame(on ? 'auto' : chosenQ); labelQualities();
            if (on) document.addEventListener('keydown', onTheaterKey); else document.removeEventListener('keydown', onTheaterKey);
            if (ready && chosenQ !== 'auto') { qPending = true; }
            wake();
        }
        function setPseudoFs(on) { pseudoFs = on; box.classList.toggle('vd-pfs', on); sizeFrame(on ? 'auto' : chosenQ); labelQualities(); if (buildPieces) buildPieces(); }
        function inFs() { return pseudoFs || (document.fullscreenElement || document.webkitFullscreenElement) === box; }
        function sizeFrame(q) {
            var avail = box.parentElement ? box.parentElement.clientWidth : 0;
            if (inFs() || theater || !q || q === 'auto' || !QHEIGHT[q] || !avail) { box.style.width = ''; box.style.marginLeft = ''; box.style.marginRight = ''; return null; }
            var dpr = window.devicePixelRatio || 1;
            var ratio = Number(item.ratio) > 0 ? Number(item.ratio) : 16 / 9;
            var need = Math.ceil(QHEIGHT[q] * 1.04 / dpr * ratio);          // bề rộng CSS cần có để có QHEIGHT[q] điểm ảnh vật lý theo chiều cao (+4% dư)
            var w = Math.min(need, avail);
            box.style.width = w + 'px'; box.style.marginLeft = 'auto'; box.style.marginRight = 'auto';
            return { need: need, w: w, limited: need > avail + 1 };
        }
        /* Máy tính (devicePixelRatio=1) cần khung RỘNG HƠN cột chứa để YouTube chọn 720p/1080p.
         * Mức nào không vừa trong trang → gắn ⛶ và khi chọn sẽ tự vào toàn màn hình (khung = cả màn hình nên mới phát nét). */
        function fitsFrame(q) {
            if (!QHEIGHT[q] || inFs()) return true;
            var avail = theater ? window.innerWidth : (box.parentElement ? box.parentElement.clientWidth : 0);
            if (!avail) return true;
            var dpr = window.devicePixelRatio || 1, ratio = Number(item.ratio) > 0 ? Number(item.ratio) : 16 / 9;
            return Math.ceil(QHEIGHT[q] * 1.04 / dpr * ratio) <= avail + 1;
        }
        function labelQualities() {
            for (var k = 0; k < qual.options.length; k++) {
                var o = qual.options[k], v = o.value;
                if (v === 'auto' || !QLABEL[v]) continue;
                o.textContent = QLABEL[v] + (fitsFrame(v) ? '' : ' \u26F6');
            }
        }
        function applyQuality(q, userChoice, silent) {
            if (!ready) return;
            chosenQ = q; qPending = false;
            if (userChoice) { try { localStorage.setItem(QKEY, q); } catch (e) { /* ignore */ } }
            clearTimeout(qChecking);
            var seqId = ++qSeq;
            var info = sizeFrame(q);
            if (userChoice && info && info.limited && !inFs() && !theater) {
                toggleFs();                                    // đang là thao tác của người xem nên trình duyệt cho phép vào toàn màn hình
                showNote('Đã chuyển sang toàn màn hình để xem ' + (QLABEL[q] || q) + ' (khung trong trang quá hẹp để YouTube phát mức này).');
                silent = true;
            }
            if (q === 'auto') {
                try { player.setPlaybackQualityRange('tiny', 'highres'); } catch (e) { /* ignore */ }
                try { player.setPlaybackQuality('default'); } catch (e) { /* ignore */ }
                qChecking = setTimeout(reflectAuto, 2500);
                return;
            }
            try { player.setPlaybackQualityRange(q, q); } catch (e) { /* ignore */ }      // có bản YouTube còn nhận; không thì bỏ qua
            try { player.setPlaybackQuality(q); } catch (e) { /* ignore */ }
            var t = 0; try { t = player.getCurrentTime() || 0; } catch (e) { /* ignore */ }
            if (playing()) { setTimeout(function () { if (!destroyed && ready && seqId === qSeq && playing()) { try { player.seekTo(t, true); } catch (e) { /* ignore */ } } }, 300); }   // đợi khung đổi xong rồi buộc chọn lại
            var waited = 0;
            (function poll() {
                qChecking = setTimeout(function () {
                    if (destroyed || !ready || seqId !== qSeq) return;
                    var st = -1; try { st = player.getPlayerState(); } catch (e) { /* ignore */ }
                    if (st !== 1 && st !== 3) { qPending = true; return; }          // đang dừng: kiểm chứng khi phát tiếp
                    var got = curQ();
                    if (!QHEIGHT[got]) { return; }      // getPlaybackQuality đã bị YouTube vô hiệu (trả 'auto'/rỗng) → không kiểm chứng được, giữ nguyên lựa chọn của người xem
                    if (got === q || (QHEIGHT[got] || 0) > (QHEIGHT[q] || 0)) { return; }
                    waited += 500;
                    if (waited < 10000) { poll(); return; }
                    try { console.info('[VdYT] chất lượng', { muonXem: q, dangPhat: got, khungCSS: info, dpr: window.devicePixelRatio }); } catch (e) { /* ignore */ }
                    if (!silent) {
                        showNote(inFs()
                            ? 'YouTube đang phát ' + (QLABEL[got] || got) + ' (độ phân giải màn hình hoặc tốc độ mạng chưa đủ cho ' + QLABEL[q] + ').'
                            : (info && info.limited
                                ? 'Khung chỉ rộng ' + info.w + 'px nên YouTube chỉ lên tới ' + (QLABEL[got] || got) + '. Bấm ⛶ toàn màn hình để xem nét hơn.'
                                : 'YouTube đang phát ' + (QLABEL[got] || got) + ' (mạng chưa đủ nhanh hoặc video không có mức ' + QLABEL[q] + ').'));
                    }
                }, 500);
            })();
        }

        function onState(e) {
            var S = window.YT.PlayerState;
            if (e.data === S.PLAYING) {
                if (firstPlay) { firstPlay = false; if (HYBRID) showNote('Đổi chất lượng: bấm ⚙ ở góc trên bên phải khung hình.'); fillQualities(); if (chosenQ !== 'auto' && qual.querySelector('option[value="' + chosenQ + '"]')) { applyQuality(chosenQ, false, true); } else { chosenQ = 'auto'; sizeFrame('auto'); } }
                if (!firstPlay && qPending && chosenQ !== 'auto') applyQuality(chosenQ, false, true);
                reflectAuto();
                if (!soundChecked) { soundChecked = true; setTimeout(function () { if (!destroyed && ready && player.isMuted()) doUnmute(false); }, 300); }
                players.forEach(function (p) { if (p !== me) p.pause(); });
                pausedNow = false;
                setCover('hidden'); box.classList.remove('is-idle-state'); wake();
            } else if (e.data === S.PAUSED) { pausedNow = true; setCover('paused'); box.classList.remove('is-idle'); }
            else if (e.data === S.ENDED) { pausedNow = true; setCover('ended'); box.classList.remove('is-idle'); }
            else if (e.data === S.BUFFERING && !wantPlay) { /* giữ nguyên */ }
            maskSync();
            syncUi();
        }
        function fail(msg) { loading = false; ready = false; setCover('error', msg || 'Không phát được video này.'); big.hidden = false; big.textContent = '↻'; }

        /** Tạo trình phát YouTube. */
        function buildPlayer(id, startSec) {
            var target;
            {
                var qs = ['enablejsapi=1', 'controls=' + ((NATIVE_CONTROLS || HYBRID) ? 1 : 0), 'fs=' + (NATIVE_CONTROLS ? 1 : 0), 'disablekb=' + (NATIVE_CONTROLS ? 0 : 1), 'rel=0', 'modestbranding=1', 'iv_load_policy=3', 'playsinline=1', 'cc_load_policy=0', 'hl=vi',
                    'start=' + Math.floor(startSec || 0), 'origin=' + encodeURIComponent(window.location.origin)].join('&');
                target = document.createElement('iframe');
                target.src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(id) + '?' + qs;
                target.title = item.frameTitle || item.title || 'Video';
                target.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
                target.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
                // KHÔNG có allow-popups / allow-top-navigation ⇒ logo, tiêu đề, "Xem trên YouTube", chia sẻ… không mở được tab/trang mới
                target.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
            }
            stage.textContent = ''; stage.appendChild(target);
            player = new window.YT.Player(target, {
                width: '100%', height: '100%', videoId: id, host: 'https://www.youtube-nocookie.com',
                playerVars: { controls: (NATIVE_CONTROLS || HYBRID) ? 1 : 0, disablekb: 1, fs: 0, rel: 0, modestbranding: 1, iv_load_policy: 3, playsinline: 1, cc_load_policy: 0, hl: 'vi', start: Math.floor(startSec || 0), origin: window.location.origin },
                events: {
                    onReady: function () {
                        ready = true; loading = false;
                        try { var v0 = player.getVolume(); vol.value = String(v0); if (v0 > 0) lastVol = v0; } catch (e) { /* ignore */ }
                        if (restoreSound) {                                   // vừa tạo lại trình phát → giữ nguyên âm lượng / tắt tiếng
                            try { player.setVolume(restoreSound.vol); if (restoreSound.muted) player.mute(); else player.unMute(); } catch (e) { /* ignore */ }
                            restoreSound = null;
                        }
                        try {
                            var rates = player.getAvailablePlaybackRates();
                            if (rates && rates.length) { rate.textContent = ''; rates.forEach(function (x) { var o = el('option', '', x + 'x'); o.value = String(x); if (x === (restoreRate || 1)) o.selected = true; rate.appendChild(o); }); }
                            if (restoreRate) { player.setPlaybackRate(restoreRate); restoreRate = 0; }
                        } catch (e) { /* ignore */ }
                        clearInterval(timer); timer = setInterval(syncUi, 250);
                        layoutFrame();
                        if (ro) { try { ro.disconnect(); } catch (e) { /* ignore */ } }
                        if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(layoutFrame); ro.observe(stage); }
                        if (wantPlay) { try { player.playVideo(); } catch (e) { /* ignore */ } }
                        setTimeout(function () {                               // trình duyệt chặn tự phát → hiện nút ▶ thay vì kẹt ở "đang tải"
                            if (destroyed || !ready || box.getAttribute('data-state') !== 'loading') return;
                            var st = -1; try { st = player.getPlayerState(); } catch (e) { /* ignore */ }
                            if (st !== 1 && st !== 3) setCover('paused');
                        }, 3000);
                        syncUi();
                    },
                    onStateChange: onState,
                    onPlaybackQualityChange: function () { reflectAuto(); if (HYBRID && nativeActive) { clearTimeout(menuTimer); menuTimer = setTimeout(function () { menuMode(false); }, 700); } },
                    onError: function () { fail('Video không phát được (đã bị gỡ hoặc không cho phép nhúng).'); }
                }
            });
        }

        function start() {
            if (destroyed || loading) return;
            if (ready) { try { player.playVideo(); } catch (e) { /* ignore */ } return; }
            loading = true; wantPlay = true; setCover('loading', 'Đang tải video…');
            var url = vd.base ? vd.base : '/videos';
            Promise.all([
                fetch(url + '/play/' + encodeURIComponent(vd.id) + '/' + encodeURIComponent(item.id), { credentials: 'same-origin', headers: { 'Accept': 'application/json' }, cache: 'no-store' })
                    .then(function (res) { return res.json().catch(function () { return { success: false, message: 'Máy chủ trả lỗi ' + res.status }; }); }),
                loadApi()
            ]).then(function (out) {
                var d = out[0];
                if (destroyed) return;
                if (!d || !d.success) return fail((d && d.message) || 'Không tải được video.');
                videoId = d.id; startAt = d.start || 0;
                if (d.email) wmEmail = String(d.email); if (d.ip) wmIp = String(d.ip); wmFill(); wmPlace();     // server gửi kèm email + IP người xem
                if (chosenQ !== 'auto') sizeFrame(chosenQ);      // áp chất lượng đã lưu NGAY: chỉnh bề rộng thật của khung trước khi tải video
                buildPlayer(d.id, d.start || 0);
            }).catch(function (err) { fail(err && err.message ? err.message : 'Không tải được video.'); });
        }

        function toggle() {
            if (!ready) { start(); return; }
            var st = player.getPlayerState();
            if (st === 1) { wantPlay = false; player.pauseVideo(); }
            else { wantPlay = true; if (st === 0) player.seekTo(0, true); player.playVideo(); }
        }
        function seekBy(sec) { if (!ready) return; var d = player.getDuration() || 0; player.seekTo(Math.max(0, Math.min(d, player.getCurrentTime() + sec)), true); syncUi(); }
        function toggleFs() {
            var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
            if (pseudoFs) { setPseudoFs(false); return; }
            if (fsEl === box) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); }
            else { var f = box.requestFullscreen || box.webkitRequestFullscreen; if (f) f.call(box); else setPseudoFs(true); }
        }

        shield.addEventListener('click', function () {
            if (IS_TOUCH && ready && playing() && box.classList.contains('is-idle')) { wake(); return; }     // chạm khi thanh đang ẩn: chỉ hiện thanh
            toggle(); wake();
        });
        cover.addEventListener('click', function (e) { if (e.target === cover || e.target === big || e.target === coverTitle || e.target === status) { toggle(); } });
        bPlay.addEventListener('click', toggle);
        bMute.addEventListener('click', toggleMute);
        vol.addEventListener('input', function () { changeVol(Number(vol.value)); });
        qual.addEventListener('change', function () { applyQuality(qual.value, true); });
        rate.addEventListener('change', function () { if (ready) player.setPlaybackRate(Number(rate.value)); });
        bFs.addEventListener('click', toggleFs);
        bTh.addEventListener('click', function () { setTheater(!theater); });
        seek.addEventListener('input', function () { dragging = true; if (ready) tCur.textContent = fmt((player.getDuration() || 0) * Number(seek.value) / 1000); });
        seek.addEventListener('change', function () { if (ready) player.seekTo((player.getDuration() || 0) * Number(seek.value) / 1000, true); dragging = false; syncUi(); });
        box.addEventListener('contextmenu', function (e) { e.preventDefault(); });
        box.addEventListener('mousemove', wake);
        box.addEventListener('touchstart', wake, { passive: true });
        box.addEventListener('keydown', function (e) {
            if (e.altKey || e.ctrlKey || e.metaKey) return;
            var t = e.target && e.target.tagName;
            if (t === 'SELECT' || (t === 'INPUT' && e.key !== ' ' && e.key.indexOf('Arrow') !== 0)) return;
            if (e.key === ' ' || e.key === 'k') { e.preventDefault(); toggle(); }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); seekBy(-5); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); seekBy(5); }
            else if (e.key === 'ArrowUp' && ready) { e.preventDefault(); changeVol((player.isMuted() ? 0 : curVol()) + 10); }
            else if (e.key === 'ArrowDown' && ready) { e.preventDefault(); changeVol((player.isMuted() ? 0 : curVol()) - 10); }
            else if (e.key === 'm' && ready) { toggleMute(); }
            else if (e.key === 'f') { e.preventDefault(); toggleFs(); }
            else if ((e.key === 't' || e.key === 'T') && !IS_TOUCH) { e.preventDefault(); setTheater(!theater); }
            wake();
        });

        /* Phím tắt kiểu YouTube trên máy tính — chạy ở cấp TRANG nên không cần bấm vào khung phát trước:
         *   ← tua lùi 5 giây · → tua tiến 5 giây · J lùi 10 giây · L tiến 10 giây.
         * Bỏ qua khi đang gõ ở ô nhập; bỏ qua nếu handler của khung (ở trên) đã xử lý (defaultPrevented) để không tua 2 lần. */
        function onDocKey(e) {
            if (destroyed || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
            if (!box.isConnected) return;
            var tg = e.target, t = tg && tg.tagName;
            if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || (tg && tg.isContentEditable)) return;
            var k = e.key, d = 0;
            if (k === 'ArrowLeft') d = -5;
            else if (k === 'ArrowRight') d = 5;
            else if (k === 'j' || k === 'J') d = -10;
            else if (k === 'l' || k === 'L') d = 10;
            if (!d) return;
            e.preventDefault(); seekBy(d); wake();
        }
        document.addEventListener('keydown', onDocKey);

        box._destroy = function () {
            document.removeEventListener('keydown', onDocKey);
            document.removeEventListener('fullscreenchange', onFs); document.removeEventListener('webkitfullscreenchange', onFs); window.removeEventListener('resize', onWinResize); window.removeEventListener('blur', onWinBlur); window.removeEventListener('focus', releaseShield);
            if (theater) setTheater(false); document.removeEventListener('keydown', onTheaterKey);
            destroyed = true; clearInterval(wmTimer); if (wmMo) { try { wmMo.disconnect(); } catch (e) { /* ignore */ } } if (wmMoBox) { try { wmMoBox.disconnect(); } catch (e) { /* ignore */ } } clearInterval(actTimer); clearInterval(timer); clearTimeout(hideTimer); clearTimeout(noteTimer); clearTimeout(qChecking); clearTimeout(unmuteCheck); clearTimeout(menuTimer); if (ro) { try { ro.disconnect(); } catch (e) { /* ignore */ } }
            var i = players.indexOf(me); if (i >= 0) players.splice(i, 1);
            if (player && player.destroy) { try { player.destroy(); } catch (e) { /* ignore */ } }
            player = null; ready = false;
        };

        /* Lớp chắn KHÔNG bao giờ bị ẩn. Chỉ khi người xem THẬT SỰ bấm vào nút gốc (chuột đang nằm trong 1 lỗ) mới mở thêm lỗ cho menu ⚙;
         * lớp chắn vẫn che tiêu đề / logo. Iframe tự lấy focus lúc bắt đầu phát (autoplay) thì bỏ qua — lỗi cũ: lúc đó cả lớp chắn bị ẩn nên chỉ che được giây đầu. */
        var nativeActive = false, menuTimer = null;
        /* Bật/tắt "chế độ menu": chừa lỗ cho bảng menu + ✕ của YouTube (thanh web vẫn hiện, chỉ đè lên phần đệm đáy bảng).
         * Không có tín hiệu báo bảng đã đóng nên tự thoát khi: đổi chất lượng xong · chuột rời khung · bấm vào lớp chắn · quá 15 giây. */
        function menuMode(on) {
            nativeActive = on; clearTimeout(menuTimer);
            if (HYBRID) box.classList.toggle('vd-menu-open', on);
            if (buildPieces) buildPieces(on);
            if (on) { if (HYBRID) menuTimer = setTimeout(function () { if (nativeActive) menuMode(false); }, 15000); return; }
            try { var f = frameEl(); if (f) f.blur(); } catch (e) { /* ignore */ }
        }
        function releaseShield() { if (!nativeActive) return; menuMode(false); }
        var actTimer = null;
        function checkNativeFocus() {
            var f = frameEl();
            if (!f || nativeActive || destroyed || document.activeElement !== f) return;
            if (!cover.hidden) return;                        // đang hiện màn chờ/tải: focus là do tự phát
            var over = false, ps = shield.children;
            for (var k = 0; k < ps.length; k++) { if (ps[k].matches(':hover')) { over = true; break; } }
            if (over || !box.matches(':hover')) return;      // chuột không nằm trong lỗ nào ⇒ focus tự nhảy, không phải bấm nút gốc
            menuMode(true);
        }
        function onWinBlur() { if (!(NATIVE_CONTROLS || HYBRID)) return; setTimeout(checkNativeFocus, 0); }
        if (NATIVE_CONTROLS || HYBRID) { window.addEventListener('blur', onWinBlur); window.addEventListener('focus', releaseShield); shield.addEventListener('mousedown', releaseShield); box.addEventListener('mouseleave', releaseShield); box.addEventListener('mouseenter', function () { clearInterval(actTimer); actTimer = setInterval(checkNativeFocus, 250); }); box.addEventListener('mouseleave', function () { clearInterval(actTimer); actTimer = null; }); }
        function onFs() { sizeFrame(inFs() ? 'auto' : chosenQ); labelQualities(); nativeActive = false; clearTimeout(menuTimer); box.classList.remove('vd-menu-open'); if (buildPieces) buildPieces(false); }     // toàn màn hình: khung = cả màn hình; thoát ra: trả về bề rộng theo chất lượng đã chọn
        function onWinResize() { if (!inFs()) sizeFrame(chosenQ); labelQualities(); }
        document.addEventListener('fullscreenchange', onFs);
        document.addEventListener('webkitfullscreenchange', onFs);
        window.addEventListener('resize', onWinResize);

        setCover('idle');
        return box;
    }

    window.VdYT = { create: create };
})();
