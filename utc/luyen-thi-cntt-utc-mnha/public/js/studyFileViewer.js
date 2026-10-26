/* ============================================================
 * studyFileViewer.js — Trang XEM  (/slides/study/:id  và  /documents/study/:id)
 *
 *  1. Tải file ĐÃ GIẢI MÃ từ {fileUrl}?chunk=i theo từng phần ≤ 4MB rồi ghép lại
 *     (Vercel cắt response > 4.5MB; server tự nối các file-phần ≤ 23MB trên GitHub).
 *  2. Hiển thị theo loại:
 *     • documents (PDF)      → cuộn dọc liên tục như PDF thường, phóng to/nhỏ (nút, Ctrl+lăn chuột, chụm 2 ngón), đúng khổ ngang/dọc
 *     • slides + PDF         → từng trang như slide (◀ ▶, phím, vuốt, zoom, toàn màn hình)
 *     • slides + PPTX        → trình chiếu có CHUYỂN CẢNH + HIỆU ỨNG (js/pptxPlayer.js)
 *     • slides + PPT (cũ)    → không xem trực tiếp được trên trình duyệt: hướng dẫn tải xuống
 *  3. PDF.js / JSZip nạp từ cdnjs; PDF.js lỗi → dự phòng <iframe> của trình duyệt.
 *  Nút "Tải xuống": file > 4MB tải theo phần rồi lưu bằng Blob (qua được giới hạn Vercel).
 * ============================================================ */
(function () {
    'use strict';

    var $ = function (id) { return document.getElementById(id); };
    var D = JSON.parse($('slData').textContent);
    var pane = $('slPane'), loading = $('slLoading');

    var PDFJS_VER = '3.11.174';
    var URLS = {
        pdfjs: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/' + PDFJS_VER + '/pdf.min.js',
        pdfjsWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/' + PDFJS_VER + '/pdf.worker.min.js',
        jszip: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
        pptx: '/js/pptxPlayer.js'
    };
    // cho phép test ghi đè địa chỉ thư viện
    if (window.__STUDYFILE_URLS__) for (var k in window.__STUDYFILE_URLS__) URLS[k] = window.__STUDYFILE_URLS__[k];

    function setLoading(text, isErr) {
        loading.hidden = false; loading.textContent = text; loading.className = 'sl-loading' + (isErr ? ' err' : '');
    }
    function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }
    function btn(id, label, title) { var b = el('button'); b.type = 'button'; b.id = id; b.textContent = label; b.setAttribute('aria-label', title || label); b.title = title || label; return b; }
    function sep() { return el('span', 'sl-sep'); }

    // ------------------------------------------------------------
    // Tải file theo phần
    // ------------------------------------------------------------
    function fetchChunk(i) {
        return (window.MnhaData ? window.MnhaData.fetch : fetch)(D.fileUrl + '?chunk=' + i, { credentials: 'same-origin', cache: 'no-store' }).then(function (r) {
            if (!r.ok) return r.text().then(function (t) { throw new Error(t && t.length < 200 ? t : 'Máy chủ trả HTTP ' + r.status); });
            var count = Number(r.headers.get('X-Chunk-Count')) || 1;
            return r.arrayBuffer().then(function (buf) { return { buf: buf, count: count }; });
        });
    }
    function fetchBytes(onProgress) {
        return fetchChunk(0).then(function (first) {
            var parts = [first.buf], count = first.count;
            function loop(i) {
                if (i >= count) return Promise.resolve();
                if (onProgress) onProgress(i, count);
                return fetchChunk(i).then(function (c) { parts.push(c.buf); return loop(i + 1); });
            }
            return loop(1).then(function () {
                var total = parts.reduce(function (n, b) { return n + b.byteLength; }, 0);
                var out = new Uint8Array(total), off = 0;
                parts.forEach(function (b) { out.set(new Uint8Array(b), off); off += b.byteLength; });
                return out;
            });
        });
    }
    var bytesCache = null;
    function getBytes(onProgress) {
        if (bytesCache) return Promise.resolve(bytesCache);
        return fetchBytes(onProgress).then(function (b) { bytesCache = b; return b; });
    }

    // ------------------------------------------------------------
    // Tải xuống
    // ------------------------------------------------------------
    var dl = $('slDownload');
    dl.addEventListener('click', function (e) {
        if (!D.size || D.size <= 4 * 1000 * 1000) return;       // nhỏ: tải trực tiếp qua ?download=1
        e.preventDefault();
        var label = dl.querySelector('span'), old = label.textContent;
        label.textContent = 'Đang chuẩn bị…';
        getBytes(function (i, n) { label.textContent = 'Đang tải ' + (i + 1) + '/' + n + '…'; }).then(function (bytes) {
            var url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
            var a = document.createElement('a');
            a.href = url; a.download = D.fileName || 'file';
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
            label.textContent = old;
        }).catch(function (err) { label.textContent = old; alert('Không tải xuống được: ' + (err.message || err)); });
    });

    // ------------------------------------------------------------
    // Nạp thư viện
    // ------------------------------------------------------------
    var scriptCache = {};
    function loadScript(src, testGlobal) {
        if (testGlobal && window[testGlobal]) return Promise.resolve();
        if (scriptCache[src]) return scriptCache[src];
        scriptCache[src] = new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = src; s.async = true;
            s.onload = function () { (!testGlobal || window[testGlobal]) ? resolve() : reject(new Error('Thư viện không khởi tạo được: ' + testGlobal)); };
            s.onerror = function () { reject(new Error('Không tải được thư viện (' + src.split('/').pop() + ')')); };
            document.head.appendChild(s);
        });
        return scriptCache[src];
    }
    function loadPdfJs() {
        return loadScript(URLS.pdfjs, 'pdfjsLib').then(function () {
            window.pdfjsLib.GlobalWorkerOptions.workerSrc = URLS.pdfjsWorker;
            return window.pdfjsLib;
        });
    }
    function fullscreenToggle(target, after) {
        if (document.fullscreenElement) { document.exitFullscreen(); return; }
        if (target.requestFullscreen) target.requestFullscreen().catch(function () { });
    }
    function isTyping(e) { return /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || ''); }

    // ------------------------------------------------------------
    // Dự phòng: nhúng PDF bằng trình duyệt
    // ------------------------------------------------------------
    function iframeFallback(bytes) {
        pane.innerHTML = '';
        var stage = el('div', 'sl-stage');
        var url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        var f = el('iframe', 'sl-frame'); f.src = url; f.title = D.title;
        stage.appendChild(f); pane.appendChild(stage);
        pane.appendChild(el('p', 'sl-note', 'Nếu không thấy nội dung, hãy bấm "Tải xuống" để mở bằng ứng dụng đọc PDF.'));
    }

    // ============================================================
    // 1) PDF dạng SLIDE: từng trang
    // ============================================================
    function pdfPageMode(bytes) {
        return loadPdfJs().then(function (lib) { return lib.getDocument({ data: bytes.slice(0) }).promise; }).then(function (pdf) {
            pane.innerHTML = '';
            var bar = el('div', 'sl-bar'), stage = el('div', 'sl-stage'), canvas = el('canvas');
            var prev = btn('slPrev', '◀', 'Trang trước'), next = btn('slNext', '▶', 'Trang sau');
            var pageNo = el('input'); pageNo.type = 'number'; pageNo.min = '1'; pageNo.value = '1'; pageNo.id = 'slPageNo'; pageNo.setAttribute('aria-label', 'Số trang');
            var total = el('b'); total.textContent = String(pdf.numPages);
            var pg = el('span', 'sl-page'); pg.appendChild(pageNo); pg.appendChild(document.createTextNode(' / ')); pg.appendChild(total);
            var zo = btn('slZoomOut', '−', 'Thu nhỏ'), zr = btn('slZoomReset', '100%', 'Vừa khung'), zi = btn('slZoomIn', '+', 'Phóng to'), fs = btn('slFull', '⛶', 'Toàn màn hình');
            [prev, pg, next, sep(), zo, zr, zi, sep(), fs].forEach(function (n) { bar.appendChild(n); });
            stage.appendChild(canvas); pane.appendChild(bar); pane.appendChild(stage);

            var page = 1, zoom = 1, rendering = false, pending = null, ctx = canvas.getContext('2d');
            function render(n) {
                if (rendering) { pending = n; return; }
                rendering = true;
                pdf.getPage(n).then(function (pg) {
                    var base = pg.getViewport({ scale: 1 });
                    var fit = Math.max(0.1, Math.min((stage.clientWidth - 16) / base.width, (stage.clientHeight - 16) / base.height));
                    var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
                    var vp = pg.getViewport({ scale: fit * zoom * dpr });
                    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
                    canvas.style.width = Math.floor(vp.width / dpr) + 'px'; canvas.style.height = Math.floor(vp.height / dpr) + 'px';
                    return pg.render({ canvasContext: ctx, viewport: vp }).promise;
                }).catch(function (e) { setLoading('Không hiển thị được trang này: ' + (e.message || e), true); })
                    .then(function () { rendering = false; if (pending !== null) { var p = pending; pending = null; render(p); } });
            }
            function go(n) { page = Math.max(1, Math.min(pdf.numPages, Math.round(n) || 1)); pageNo.value = String(page); stage.scrollTop = 0; stage.scrollLeft = 0; render(page); }
            function setZoom(z) { zoom = Math.max(0.5, Math.min(4, z)); zr.textContent = Math.round(zoom * 100) + '%'; render(page); }
            prev.onclick = function () { go(page - 1); }; next.onclick = function () { go(page + 1); };
            pageNo.onchange = function () { go(Number(pageNo.value)); };
            zi.onclick = function () { setZoom(zoom + 0.25); }; zo.onclick = function () { setZoom(zoom - 0.25); }; zr.onclick = function () { setZoom(1); };
            fs.onclick = function () { fullscreenToggle(pane); };
            document.addEventListener('fullscreenchange', function () { setTimeout(function () { render(page); }, 120); });
            document.addEventListener('keydown', function (e) {
                if (isTyping(e)) return;
                if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); go(page + 1); }
                else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(page - 1); }
                else if (e.key === 'Home') go(1); else if (e.key === 'End') go(pdf.numPages);
                else if (e.key === '+' || e.key === '=') setZoom(zoom + 0.25); else if (e.key === '-') setZoom(zoom - 0.25);
            });
            var tx = 0, ty = 0, tt = 0;
            stage.addEventListener('touchstart', function (e) { if (e.touches.length === 1) { tx = e.touches[0].clientX; ty = e.touches[0].clientY; tt = Date.now(); } }, { passive: true });
            stage.addEventListener('touchend', function (e) {
                if (zoom !== 1 || !e.changedTouches.length) return;
                var dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty;
                if (Date.now() - tt < 600 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(page + (dx < 0 ? 1 : -1));
            }, { passive: true });
            var rt = null; window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { render(page); }, 150); });
            loading.hidden = true; pane.appendChild(loading);
            go(1);
        });
    }

    // ============================================================
    // 2) PDF dạng TÀI LIỆU: cuộn dọc liên tục, zoom, đúng khổ ngang/dọc
    // ============================================================
    function pdfScrollMode(bytes) {
        return loadPdfJs().then(function (lib) { return lib.getDocument({ data: bytes.slice(0) }).promise; }).then(function (pdf) {
            pane.innerHTML = '';
            var bar = el('div', 'sl-bar'), stage = el('div', 'sl-stage sl-scroll'), pagesEl = el('div', 'sl-pages');
            var pageNo = el('input'); pageNo.type = 'number'; pageNo.min = '1'; pageNo.max = String(pdf.numPages); pageNo.value = '1'; pageNo.id = 'slPageNo'; pageNo.setAttribute('aria-label', 'Số trang');
            var total = el('b'); total.textContent = String(pdf.numPages);
            var pg = el('span', 'sl-page'); pg.appendChild(pageNo); pg.appendChild(document.createTextNode(' / ')); pg.appendChild(total);
            var zo = btn('slZoomOut', '−', 'Thu nhỏ'), zr = btn('slZoomReset', '100%', 'Vừa chiều rộng'), zi = btn('slZoomIn', '+', 'Phóng to'), fs = btn('slFull', '⛶', 'Toàn màn hình');
            [pg, sep(), zo, zr, zi, sep(), fs].forEach(function (n) { bar.appendChild(n); });
            stage.appendChild(pagesEl); pane.appendChild(bar); pane.appendChild(stage);
            loading.hidden = true; pane.appendChild(loading);

            var n = pdf.numPages, zoom = 1, sizes = new Array(n + 1), boxes = [null], maxW = 0, state = {};   // state[i] = { scale }
            var GAP = 12;

            function fitWidth() { return Math.max(0.1, (stage.clientWidth - 2 * GAP) / (maxW || 612)); }
            function scaleNow() { return fitWidth() * zoom; }
            function layoutOne(i) {
                var sz = sizes[i] || sizes[1] || { w: 612, h: 792 }, s = scaleNow(), b = boxes[i];
                b.style.width = Math.floor(sz.w * s) + 'px'; b.style.height = Math.floor(sz.h * s) + 'px';
            }
            function layoutAll() { for (var i = 1; i <= n; i++) layoutOne(i); }

            for (var i = 1; i <= n; i++) {
                var b = el('div', 'sl-pagebox'); b.setAttribute('data-n', String(i));
                b.appendChild(el('span', 'sl-pn', String(i)));
                boxes.push(b); pagesEl.appendChild(b);
            }

            // render lười: chỉ vẽ trang gần khung nhìn; trang xa thì giải phóng canvas
            var io = new IntersectionObserver(function (entries) {
                entries.forEach(function (en) {
                    var i = Number(en.target.getAttribute('data-n'));
                    if (en.isIntersecting) renderPage(i); else release(i);
                });
            }, { root: stage, rootMargin: '900px 0px' });
            function release(i) { var b = boxes[i], c = b.querySelector('canvas'); if (c) { c.width = 0; c.height = 0; c.remove(); } state[i] = null; }
            var token = {};
            function renderPage(i) {
                var s = scaleNow(), st = state[i];
                if (st && st.scale === s) return;
                state[i] = { scale: s };
                pdf.getPage(i).then(function (p) {
                    if (!state[i] || state[i].scale !== s) return;
                    var vp1 = p.getViewport({ scale: 1 });
                    if (!sizes[i]) { sizes[i] = { w: vp1.width, h: vp1.height }; if (vp1.width > maxW) { maxW = vp1.width; layoutAll(); } else layoutOne(i); }
                    var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
                    var area = vp1.width * vp1.height * s * s * dpr * dpr;
                    if (area > 16e6) dpr = dpr * Math.sqrt(16e6 / area);          // tránh canvas quá lớn khi zoom cao
                    var vp = p.getViewport({ scale: s * dpr });
                    var c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
                    return p.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise.then(function () {
                        if (!state[i] || state[i].scale !== s) return;
                        var old = boxes[i].querySelector('canvas'); if (old) old.remove();
                        boxes[i].appendChild(c);
                    });
                }).catch(function (e) { state[i] = null; if (window.console) console.error('[studyFile] render trang ' + i + ':', e && e.message); });
            }
            // đọc kích thước tất cả trang (nền) để bố cục đúng khổ ngang/dọc của TỪNG trang
            function readSizes(from) {
                if (from > n) return;
                var jobs = [], to = Math.min(n, from + 14);
                for (var k = from; k <= to; k++) (function (k) {
                    jobs.push(pdf.getPage(k).then(function (p) { var v = p.getViewport({ scale: 1 }); sizes[k] = { w: v.width, h: v.height }; if (v.width > maxW) maxW = v.width; }).catch(function () { }));
                })(k);
                Promise.all(jobs).then(function () { layoutAll(); setTimeout(function () { readSizes(to + 1); }, 0); });
            }
            pdf.getPage(1).then(function (p) {
                var v = p.getViewport({ scale: 1 }); sizes[1] = { w: v.width, h: v.height }; maxW = v.width;
                layoutAll();
                boxes.forEach(function (b, i) { if (i) io.observe(b); });
                readSizes(2);
            });

            function restoreAnchor(fn) {       // giữ nguyên vị trí đang đọc khi đổi zoom
                var cur = currentPage(), b = boxes[cur], off = b ? (stage.scrollTop - b.offsetTop) / Math.max(1, b.offsetHeight) : 0;
                fn();
                var nb = boxes[cur]; if (nb) stage.scrollTop = nb.offsetTop + off * nb.offsetHeight;
            }
            function refreshVisible() { boxes.forEach(function (b, i) { if (i && state[i] && state[i].scale !== scaleNow()) { var s = state[i]; state[i] = null; if (b.querySelector('canvas')) renderPage(i); } }); }
            function setZoom(z) {
                zoom = Math.max(0.4, Math.min(5, z)); zr.textContent = Math.round(zoom * 100) + '%';
                restoreAnchor(layoutAll); refreshVisible();
            }
            function currentPage() {
                var mid = stage.scrollTop + stage.clientHeight * 0.35, lo = 1, hi = n;
                while (lo < hi) { var m = (lo + hi + 1) >> 1; if (boxes[m].offsetTop <= mid) lo = m; else hi = m - 1; }
                return lo;
            }
            var st = null;
            stage.addEventListener('scroll', function () { cancelAnimationFrame(st); st = requestAnimationFrame(function () { if (document.activeElement !== pageNo) pageNo.value = String(currentPage()); }); }, { passive: true });
            function go(p) { p = Math.max(1, Math.min(n, Math.round(p) || 1)); stage.scrollTop = boxes[p].offsetTop - GAP; pageNo.value = String(p); }
            pageNo.onchange = function () { go(Number(pageNo.value)); };
            zi.onclick = function () { setZoom(zoom * 1.25); }; zo.onclick = function () { setZoom(zoom / 1.25); }; zr.onclick = function () { setZoom(1); };
            fs.onclick = function () { fullscreenToggle(pane); };
            document.addEventListener('fullscreenchange', function () { setTimeout(function () { restoreAnchor(layoutAll); refreshVisible(); }, 120); });
            var rt = null; window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { restoreAnchor(layoutAll); refreshVisible(); }, 150); });

            // Ctrl + lăn chuột = zoom (không zoom cả trang web)
            stage.addEventListener('wheel', function (e) { if (e.ctrlKey) { e.preventDefault(); setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); } }, { passive: false });
            document.addEventListener('keydown', function (e) {
                if (isTyping(e)) return;
                if (e.key === '+' || e.key === '=') setZoom(zoom * 1.25); else if (e.key === '-') setZoom(zoom / 1.25); else if (e.key === '0') setZoom(1);
                else if (e.key === 'Home') go(1); else if (e.key === 'End') go(n);
                else if (e.key === 'PageDown') { e.preventDefault(); stage.scrollBy({ top: stage.clientHeight * 0.9 }); } else if (e.key === 'PageUp') { e.preventDefault(); stage.scrollBy({ top: -stage.clientHeight * 0.9 }); }
            });
            // Chụm 2 ngón để zoom (xem trước bằng CSS transform, chốt khi thả tay)
            var pinch = null;
            function dist(t) { var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY; return Math.sqrt(dx * dx + dy * dy); }
            stage.addEventListener('touchstart', function (e) { if (e.touches.length === 2) pinch = { d: dist(e.touches), r: 1 }; }, { passive: true });
            stage.addEventListener('touchmove', function (e) {
                if (pinch && e.touches.length === 2) {
                    e.preventDefault();
                    pinch.r = Math.max(0.4 / zoom, Math.min(5 / zoom, dist(e.touches) / pinch.d));
                    pagesEl.style.transform = 'scale(' + pinch.r + ')';
                }
            }, { passive: false });
            stage.addEventListener('touchend', function () {
                if (pinch && pinch.r !== 1) { var r = pinch.r; pagesEl.style.transform = ''; pinch = null; setZoom(zoom * r); } else pinch = null;
            }, { passive: true });
            window.__scrollViewer = { go: go, setZoom: setZoom, pages: function () { return boxes; }, zoom: function () { return zoom; } };   // phục vụ test
        });
    }

    // ============================================================
    // 3) PPTX: trình chiếu
    // ============================================================
    function pptxMode(bytes) {
        return Promise.all([loadScript(URLS.jszip, 'JSZip'), loadScript(URLS.pptx, 'PptxPlayer')]).then(function () {
            return window.PptxPlayer.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), window.JSZip);
        }).then(function (deck) {
            pane.innerHTML = '';
            var bar = el('div', 'sl-bar'), stage = el('div', 'sl-stage pp-stage');
            var prev = btn('slPrev', '◀', 'Lùi (←)'), next = btn('slNext', '▶', 'Tiếp / chạy hiệu ứng (→, Space, click)');
            var pageNo = el('input'); pageNo.type = 'number'; pageNo.min = '1'; pageNo.max = String(deck.slides.length); pageNo.value = '1'; pageNo.id = 'slPageNo'; pageNo.setAttribute('aria-label', 'Số slide');
            var total = el('b'); total.textContent = String(deck.slides.length);
            var pg = el('span', 'sl-page'); pg.appendChild(pageNo); pg.appendChild(document.createTextNode(' / ')); pg.appendChild(total);
            var stat = el('span', 'sl-stat'); stat.id = 'slStat';
            var play = btn('slFull', '▶ Trình chiếu', 'Trình chiếu toàn màn hình');
            [prev, pg, next, sep()].forEach(function (x) { bar.appendChild(x); });
            var hasAuto = deck.slides.some(function (s) { return s.transition && s.transition.advTm !== null && s.transition.advTm !== undefined; });
            var auto = null;
            if (hasAuto) { auto = btn('slAuto', '⏱ Tự chuyển', 'Tự chuyển slide theo thời gian đã cài trong file'); bar.appendChild(auto); bar.appendChild(sep()); }
            bar.appendChild(play); bar.appendChild(stat);
            pane.appendChild(bar); pane.appendChild(stage); loading.hidden = true; pane.appendChild(loading);

            var player = new window.PptxPlayer.Player(stage, deck, {
                onChange: function (i) {
                    pageNo.value = String(i.index + 1);
                    stat.textContent = i.steps ? 'hiệu ứng ' + i.step + '/' + i.steps : '';
                }
            });
            player.show(0).then(function () { player.resize(); });
            prev.onclick = function () { player.prev(); }; next.onclick = function () { player.next(); };
            pageNo.onchange = function () { player.goto(Number(pageNo.value) - 1); };
            stage.addEventListener('click', function () { player.next(); });
            play.onclick = function () { fullscreenToggle(pane); };
            if (auto) auto.onclick = function () { var on = !auto.classList.contains('on'); auto.classList.toggle('on', on); player.setAutoAdvance(on); };
            document.addEventListener('fullscreenchange', function () { setTimeout(function () { player.resize(); }, 150); });
            document.addEventListener('keydown', function (e) {
                if (isTyping(e)) return;
                if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); player.next(); }
                else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Backspace') { e.preventDefault(); player.prev(); }
                else if (e.key === 'Home') player.goto(0); else if (e.key === 'End') player.goto(deck.slides.length - 1);
            });
            var tx = 0, ty = 0, tt = 0;
            stage.addEventListener('touchstart', function (e) { if (e.touches.length === 1) { tx = e.touches[0].clientX; ty = e.touches[0].clientY; tt = Date.now(); } }, { passive: true });
            stage.addEventListener('touchend', function (e) {
                if (!e.changedTouches.length) return;
                var dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty;
                if (Date.now() - tt < 600 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) { e.preventDefault(); dx < 0 ? player.next() : player.prev(); }
            }, { passive: false });
            window.__pptxPlayer = player;      // phục vụ test
        });
    }

    // ============================================================
    // 4) PPT cũ (.ppt): không xem được trong trình duyệt
    // ============================================================
    function pptLegacy() {
        pane.innerHTML = '';
        var box = el('div', 'sl-unsupported');
        box.innerHTML = '<h2>Định dạng .ppt (PowerPoint 97–2003) chưa xem trực tiếp được</h2>' +
            '<p>Trình duyệt không đọc được định dạng .ppt cũ. Bạn vẫn có thể bấm <b>Tải xuống</b> ở trên để mở bằng PowerPoint / LibreOffice.</p>' +
            '<p>Muốn xem ngay trên web (kèm chuyển cảnh và hiệu ứng), hãy lưu lại file thành <b>.pptx</b> rồi up lại.</p>';
        pane.appendChild(box);
    }

    // ------------------------------------------------------------
    // Khởi động
    // ------------------------------------------------------------
    function start() {
        if (D.ext === 'ppt') { pptLegacy(); return; }
        setLoading('Đang tải và giải mã…');
        var bytes = null;
        getBytes(function (i, n) { setLoading('Đang tải phần ' + (i + 1) + '/' + n + '…'); }).then(function (b) {
            bytes = b;
            if (D.ext === 'pptx') return pptxMode(b);
            return D.viewer === 'document' ? pdfScrollMode(b) : pdfPageMode(b);
        }).catch(function (e) {
            if (bytes && D.ext === 'pdf') { iframeFallback(bytes); return; }
            if (!pane.contains(loading)) pane.appendChild(loading);
            setLoading('Không mở được: ' + (e.message || e), true);
        });
    }
    start();
})();
