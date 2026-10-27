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
    var apiPromise = null;
    var QKEY = 'vdYtQuality';
    var QLABEL = { highres: 'Cao nhất', hd2880: '2880p', hd2160: '2160p', hd1440: '1440p', hd1080: '1080p', hd720: '720p', large: '480p', medium: '360p', small: '240p', tiny: '144p', auto: 'Tự động' };
    var QORDER = ['highres', 'hd2880', 'hd2160', 'hd1440', 'hd1080', 'hd720', 'large', 'medium', 'small', 'tiny'];
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

        var videoId = '', startAt = 0, chosenQ = 'auto', noteTimer = null, qChecking = null, pauseAfterLoad = false, firstPlay = true;
        try { var sq = localStorage.getItem(QKEY); if (sq && QLABEL[sq]) chosenQ = sq; } catch (e) { /* ignore */ }
        var player = null, ready = false, loading = false, destroyed = false, dragging = false, timer = null, hideTimer = null, wantPlay = false;
        var me = { pause: function () { if (player && ready) { try { player.pauseVideo(); } catch (e) { /* ignore */ } } } };
        players.push(me);

        function setCover(mode, msg) {                // mode: idle | loading | paused | ended | error | hidden
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
            var muted = player.isMuted(); bMute.textContent = muted || player.getVolume() === 0 ? '🔇' : '🔊';
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
        function fillQualities() {
            var list = [];
            try { list = player.getAvailableQualityLevels() || []; } catch (e) { /* ignore */ }
            var have = QORDER.filter(function (q) { return list.indexOf(q) >= 0 && q !== 'highres'; });
            if (!have.length) return;                                // YouTube chưa báo danh sách → giữ "Tự động"
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
        /** Đổi chất lượng: YouTube chỉ coi đây là "gợi ý", nên đặt xong tải lại video đúng giây hiện tại để áp dụng; kiểm tra lại sau đó. */
        function applyQuality(q, userChoice) {
            if (!ready || !videoId) return;
            chosenQ = q;
            if (userChoice) { try { localStorage.setItem(QKEY, q); } catch (e) { /* ignore */ } }
            var t = 0, was = false;
            try { t = player.getCurrentTime() || 0; was = playing(); } catch (e) { /* ignore */ }
            pauseAfterLoad = !was;
            try { player.setPlaybackQuality(q === 'auto' ? 'default' : q); } catch (e) { /* ignore */ }
            try { player.loadVideoById({ videoId: videoId, startSeconds: t, suggestedQuality: q === 'auto' ? 'default' : q }); } catch (e) { /* ignore */ }
            clearTimeout(qChecking);
            qChecking = setTimeout(function () {
                if (destroyed || !ready || q === 'auto') { reflectAuto(); return; }
                var got = curQ();
                if (got && got !== q) {
                    showNote('YouTube chưa cho đổi sang ' + QLABEL[q] + ' với video này (đang phát ' + (QLABEL[got] || got) + ').');
                    if (qual.querySelector('option[value="' + got + '"]')) qual.value = got;
                }
            }, 3000);
        }

        function onState(e) {
            var S = window.YT.PlayerState;
            if (e.data === S.PLAYING && pauseAfterLoad) { pauseAfterLoad = false; try { player.pauseVideo(); } catch (x) { /* ignore */ } return; }
            if (e.data === S.PLAYING) {
                try { player.setPlaybackRate(Number(rate.value)); } catch (x) { /* ignore */ }   // loadVideoById đặt lại tốc độ
                if (firstPlay) { firstPlay = false; fillQualities(); }
                reflectAuto();
                players.forEach(function (p) { if (p !== me) p.pause(); });
                setCover('hidden'); box.classList.remove('is-idle-state'); wake();
            } else if (e.data === S.PAUSED) { setCover('paused'); box.classList.remove('is-idle'); }
            else if (e.data === S.ENDED) { setCover('ended'); box.classList.remove('is-idle'); }
            else if (e.data === S.BUFFERING && !wantPlay) { /* giữ nguyên */ }
            syncUi();
        }
        function fail(msg) { loading = false; ready = false; setCover('error', msg || 'Không phát được video này.'); big.hidden = false; big.textContent = '↻'; }

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
                var target = el('div'); stage.textContent = ''; stage.appendChild(target);
                player = new window.YT.Player(target, {
                    width: '100%', height: '100%', videoId: d.id, host: 'https://www.youtube-nocookie.com',
                    playerVars: { controls: 0, disablekb: 1, fs: 0, rel: 0, modestbranding: 1, iv_load_policy: 3, playsinline: 1, cc_load_policy: 0, hl: 'vi', start: d.start || 0, origin: window.location.origin },
                    events: {
                        onReady: function () {
                            ready = true; loading = false;
                            try { vol.value = String(player.getVolume()); } catch (e) { /* ignore */ }
                            try {
                                var rates = player.getAvailablePlaybackRates();
                                if (rates && rates.length) { rate.textContent = ''; rates.forEach(function (x) { var o = el('option', '', x + 'x'); o.value = String(x); if (x === 1) o.selected = true; rate.appendChild(o); }); }
                            } catch (e) { /* ignore */ }
                            timer = setInterval(syncUi, 250);
                            if (wantPlay) {
                                // đã chọn chất lượng từ trước → bắt đầu thẳng ở chất lượng đó (không phải tải lại)
                                if (chosenQ !== 'auto') { try { player.loadVideoById({ videoId: videoId, startSeconds: startAt, suggestedQuality: chosenQ }); } catch (e) { /* ignore */ } }
                                else { try { player.playVideo(); } catch (e) { /* ignore */ } }
                            }
                            syncUi();
                        },
                        onStateChange: onState,
                        onPlaybackQualityChange: function () { reflectAuto(); },
                        onError: function () { fail('Video không phát được (đã bị gỡ hoặc không cho phép nhúng).'); }
                    }
                });
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
        bMute.addEventListener('click', function () { if (!ready) return; if (player.isMuted()) { player.unMute(); } else { player.mute(); } syncUi(); });
        vol.addEventListener('input', function () { if (!ready) return; var v = Number(vol.value); player.setVolume(v); if (v > 0 && player.isMuted()) player.unMute(); syncUi(); });
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
            else if (e.key === 'ArrowUp' && ready) { e.preventDefault(); player.setVolume(Math.min(100, player.getVolume() + 10)); syncUi(); }
            else if (e.key === 'ArrowDown' && ready) { e.preventDefault(); player.setVolume(Math.max(0, player.getVolume() - 10)); syncUi(); }
            else if (e.key === 'm' && ready) { if (player.isMuted()) player.unMute(); else player.mute(); syncUi(); }
            else if (e.key === 'f') { e.preventDefault(); toggleFs(); }
            wake();
        });

        box._destroy = function () {
            destroyed = true; clearInterval(timer); clearTimeout(hideTimer); clearTimeout(noteTimer); clearTimeout(qChecking);
            var i = players.indexOf(me); if (i >= 0) players.splice(i, 1);
            if (player && player.destroy) { try { player.destroy(); } catch (e) { /* ignore */ } }
            player = null; ready = false;
        };

        setCover('idle');
        return box;
    }

    window.VdYT = { create: create };
})();
