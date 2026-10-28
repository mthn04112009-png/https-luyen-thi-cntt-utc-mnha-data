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
    var NATIVE_CONTROLS = true;
    /* Lớp chắn PHỦ TOÀN BỘ khung (chặn chuột phải, tiêu đề, logo, link…) trừ vài "lỗ" đúng chỗ các nút gốc của YouTube cần bấm.
     * Mỗi lỗ là [trái, trên, phải, dưới] tính theo % khung (các lỗ không được chồng lên nhau). Chỉ trong các lỗ này chuột phải mới ra menu YouTube
     * — không tránh được vì iframe khác trang: muốn bấm được nút của nó thì chuột phải trên chính nút đó cũng tới được nó.
     * Theo bố cục YouTube hiện tại: trên-phải = âm lượng, CC, ⚙ ; đáy = thanh tua và ⛶. Lệch thì chỉnh số ở đây. */
    var NATIVE_HOLES = [
        [80, 0, 99.5, 11],      // âm lượng · CC · ⚙ (góc trên phải)
        [93, 76, 99, 84],       // ⛶ toàn màn hình
        [2, 84, 98, 92]         // thanh tua (+ thời gian)
    ];
    function shieldClip(holes) {
        var pts = ['0% 0%'];
        holes.forEach(function (h) {
            var x1 = h[0] + '%', y1 = h[1] + '%', x2 = h[2] + '%', y2 = h[3] + '%';
            pts.push(x1 + ' ' + y1, x2 + ' ' + y1, x2 + ' ' + y2, x1 + ' ' + y2, x1 + ' ' + y1, '0% 0%');
        });
        pts.push('100% 0%', '100% 100%', '0% 100%', '0% 0%');
        return 'polygon(evenodd, ' + pts.join(', ') + ')';
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
        var bFs = el('button', 'vd-yt-b', '⛶'); bFs.type = 'button'; bFs.setAttribute('aria-label', 'Toàn màn hình');
        [bPlay, tCur, seek, tDur, bMute, vol, rate, qual, bFs].forEach(function (x) { bar.appendChild(x); });

        var note = el('div', 'vd-yt-note'); note.hidden = true;
        box.appendChild(stage); box.appendChild(shield); box.appendChild(cover); box.appendChild(note); box.appendChild(bar);
        box.classList.add('is-idle-state');          // chưa tải: chỉ hiện nút ▶ lớn
        if (NATIVE_CONTROLS) {
            box.classList.add('vd-native');          // ẩn thanh tự dựng; lớp chắn chừa dải điều khiển gốc ở đáy khung (xem CSS)
            bar.style.display = 'none';
            var clip = shieldClip(NATIVE_HOLES);
            shield.style.clipPath = clip; shield.style.webkitClipPath = clip;      // khoét lỗ cho các nút gốc; còn lại chắn hết
            if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) shield.style.display = 'none';   // cảm ứng: chạm vào hình để hiện thanh gốc
        }

        var videoId = '', startAt = 0, chosenQ = 'auto', noteTimer = null, qChecking = null, firstPlay = true, soundChecked = false, noQ = {}, qSeq = 0, qPending = false, restoreSound = null, restoreRate = 0, ro = null;
        if (!NATIVE_CONTROLS) { try { var sq = localStorage.getItem(QKEY); if (sq && QLABEL[sq]) chosenQ = sq; } catch (e) { /* ignore */ } }
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
            if (NATIVE_CONTROLS && mode === 'paused') mode = 'hidden';      // để lộ thanh điều khiển gốc khi đang dừng
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
            if (playing()) hideTimer = setTimeout(function () { box.classList.add('is-idle'); }, 2600);
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
        function inFs() { return (document.fullscreenElement || document.webkitFullscreenElement) === box; }
        function sizeFrame(q) {
            var avail = box.parentElement ? box.parentElement.clientWidth : 0;
            if (inFs() || !q || q === 'auto' || !QHEIGHT[q] || !avail) { box.style.width = ''; box.style.marginLeft = ''; box.style.marginRight = ''; return null; }
            var dpr = window.devicePixelRatio || 1;
            var ratio = Number(item.ratio) > 0 ? Number(item.ratio) : 16 / 9;
            var need = Math.ceil(QHEIGHT[q] * 1.04 / dpr * ratio);          // bề rộng CSS cần có để có QHEIGHT[q] điểm ảnh vật lý theo chiều cao (+4% dư)
            var w = Math.min(need, avail);
            box.style.width = w + 'px'; box.style.marginLeft = 'auto'; box.style.marginRight = 'auto';
            return { need: need, w: w, limited: need > avail + 1 };
        }
        function applyQuality(q, userChoice, silent) {
            if (!ready) return;
            chosenQ = q; qPending = false;
            if (userChoice) { try { localStorage.setItem(QKEY, q); } catch (e) { /* ignore */ } }
            clearTimeout(qChecking);
            var seqId = ++qSeq;
            var info = sizeFrame(q);
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
                    if (got === q || (QHEIGHT[got] || 0) > (QHEIGHT[q] || 0)) { return; }
                    waited += 500;
                    if (waited < 10000) { poll(); return; }
                    try { console.info('[VdYT] chất lượng', { muonXem: q, dangPhat: got, khungCSS: info, dpr: window.devicePixelRatio }); } catch (e) { /* ignore */ }
                    if (!silent) {
                        showNote(info && info.limited
                            ? 'Khung chỉ rộng ' + info.w + 'px nên YouTube chỉ lên tới ' + (QLABEL[got] || got) + '. Bấm ⛶ toàn màn hình để xem nét hơn.'
                            : 'YouTube đang phát ' + (QLABEL[got] || got) + ' (mạng chưa đủ nhanh hoặc video không có mức ' + QLABEL[q] + ').');
                    }
                    if (qual.querySelector('option[value="' + got + '"]')) qual.value = got;
                }, 500);
            })();
        }

        function onState(e) {
            var S = window.YT.PlayerState;
            if (e.data === S.PLAYING) {
                if (firstPlay) { firstPlay = false; fillQualities(); if (chosenQ !== 'auto' && qual.querySelector('option[value="' + chosenQ + '"]')) { applyQuality(chosenQ, false, true); } else { chosenQ = 'auto'; sizeFrame('auto'); } }
                if (!firstPlay && qPending && chosenQ !== 'auto') applyQuality(chosenQ, false, true);
                reflectAuto();
                if (!soundChecked) { soundChecked = true; setTimeout(function () { if (!destroyed && ready && player.isMuted()) doUnmute(false); }, 300); }
                players.forEach(function (p) { if (p !== me) p.pause(); });
                setCover('hidden'); box.classList.remove('is-idle-state'); wake();
            } else if (e.data === S.PAUSED) { setCover('paused'); box.classList.remove('is-idle'); }
            else if (e.data === S.ENDED) { setCover('ended'); box.classList.remove('is-idle'); }
            else if (e.data === S.BUFFERING && !wantPlay) { /* giữ nguyên */ }
            syncUi();
        }
        function fail(msg) { loading = false; ready = false; setCover('error', msg || 'Không phát được video này.'); big.hidden = false; big.textContent = '↻'; }

        /** Tạo trình phát YouTube. */
        function buildPlayer(id, startSec) {
            var target;
            if (NATIVE_CONTROLS) {
                var qs = ['enablejsapi=1', 'controls=1', 'fs=1', 'rel=0', 'modestbranding=1', 'iv_load_policy=3', 'playsinline=1', 'cc_load_policy=0', 'hl=vi',
                    'start=' + Math.floor(startSec || 0), 'origin=' + encodeURIComponent(window.location.origin)].join('&');
                target = document.createElement('iframe');
                target.src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(id) + '?' + qs;
                target.title = item.frameTitle || item.title || 'Video';
                target.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
                target.setAttribute('allowfullscreen', '');
                target.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
                // KHÔNG có allow-popups / allow-top-navigation ⇒ logo, tiêu đề, "Xem trên YouTube", chia sẻ… không mở được tab/trang mới
                target.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
            } else { target = el('div'); }
            stage.textContent = ''; stage.appendChild(target);
            player = new window.YT.Player(target, {
                width: '100%', height: '100%', videoId: id, host: 'https://www.youtube-nocookie.com',
                playerVars: { controls: 0, disablekb: 1, fs: 0, rel: 0, modestbranding: 1, iv_load_policy: 3, playsinline: 1, cc_load_policy: 0, hl: 'vi', start: Math.floor(startSec || 0), origin: window.location.origin },
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
                    onPlaybackQualityChange: function () { reflectAuto(); },
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
            if (fsEl === box) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); }
            else { var f = box.requestFullscreen || box.webkitRequestFullscreen; if (f) f.call(box); }
        }

        shield.addEventListener('click', function () { toggle(); wake(); });
        cover.addEventListener('click', function (e) { if (e.target === cover || e.target === big || e.target === coverTitle || e.target === status) { toggle(); } });
        bPlay.addEventListener('click', toggle);
        bMute.addEventListener('click', toggleMute);
        vol.addEventListener('input', function () { changeVol(Number(vol.value)); });
        qual.addEventListener('change', function () { applyQuality(qual.value, true); });
        rate.addEventListener('change', function () { if (ready) player.setPlaybackRate(Number(rate.value)); });
        bFs.addEventListener('click', toggleFs);
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
            wake();
        });

        box._destroy = function () {
            document.removeEventListener('fullscreenchange', onFs); document.removeEventListener('webkitfullscreenchange', onFs); window.removeEventListener('resize', onWinResize); window.removeEventListener('blur', onWinBlur);
            destroyed = true; clearInterval(timer); clearTimeout(hideTimer); clearTimeout(noteTimer); clearTimeout(qChecking); clearTimeout(unmuteCheck); if (ro) { try { ro.disconnect(); } catch (e) { /* ignore */ } }
            var i = players.indexOf(me); if (i >= 0) players.splice(i, 1);
            if (player && player.destroy) { try { player.destroy(); } catch (e) { /* ignore */ } }
            player = null; ready = false;
        };

        var nativeActive = false;
        function releaseShield() { if (!nativeActive) return; nativeActive = false; shield.style.pointerEvents = ''; try { var f = frameEl(); if (f) f.blur(); } catch (e) { /* ignore */ } }
        function onWinBlur() {      // bấm vào iframe (thanh gốc) ⇒ cửa sổ mất focus, iframe thành phần tử đang focus
            if (!NATIVE_CONTROLS) return;
            setTimeout(function () { var f = frameEl(); if (f && document.activeElement === f) { nativeActive = true; shield.style.pointerEvents = 'none'; } }, 0);
        }
        if (NATIVE_CONTROLS) { window.addEventListener('blur', onWinBlur); box.addEventListener('mouseleave', releaseShield); }
        function onFs() { sizeFrame(inFs() ? 'auto' : chosenQ); }     // toàn màn hình: khung = cả màn hình; thoát ra: trả về bề rộng theo chất lượng đã chọn
        function onWinResize() { if (!inFs()) sizeFrame(chosenQ); }
        document.addEventListener('fullscreenchange', onFs);
        document.addEventListener('webkitfullscreenchange', onFs);
        window.addEventListener('resize', onWinResize);

        setCover('idle');
        return box;
    }

    window.VdYT = { create: create };
})();
