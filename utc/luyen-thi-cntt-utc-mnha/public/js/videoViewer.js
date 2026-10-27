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
    var list = document.getElementById('vdList');
    var index = document.getElementById('vdIndex');
    var pager = document.getElementById('vdPager');
    var prev = document.getElementById('vdPrev');
    var next = document.getElementById('vdNext');
    var pos = document.getElementById('vdPos');
    var modeAll = document.getElementById('vdModeAll');
    var modeOne = document.getElementById('vdModeOne');
    var videos = Array.isArray(vd.videos) ? vd.videos : [];
    var MODE_KEY = 'vdMode';
    var mode = 'all', cur = 0;
    try { if (localStorage.getItem(MODE_KEY) === 'one') mode = 'one'; } catch (e) { /* ignore */ }

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
        modeAll.className = 'vd-chip' + (mode === 'all' ? ' on' : '');
        modeOne.className = 'vd-chip' + (mode === 'one' ? ' on' : '');
        modeAll.setAttribute('aria-pressed', mode === 'all' ? 'true' : 'false');
        modeOne.setAttribute('aria-pressed', mode === 'one' ? 'true' : 'false');
        // chỉ có 1 video → không cần chuyển chế độ
        modeAll.parentNode.hidden = videos.length < 2;
        renderIndex();
    }

    function setMode(m) {
        mode = m;
        try { localStorage.setItem(MODE_KEY, m); } catch (e) { /* ignore */ }
        render();
    }
    modeAll.addEventListener('click', function () { setMode('all'); });
    modeOne.addEventListener('click', function () { setMode('one'); });
    prev.addEventListener('click', function () { cur--; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
    next.addEventListener('click', function () { cur++; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
    document.addEventListener('keydown', function (e) {
        if (mode !== 'one' || e.altKey || e.ctrlKey || e.metaKey) return;
        var t = e.target && e.target.tagName;
        if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return;
        if (e.key === 'ArrowLeft' && cur > 0) { cur--; render(); }
        else if (e.key === 'ArrowRight' && cur < videos.length - 1) { cur++; render(); }
    });

    render();
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
})();
