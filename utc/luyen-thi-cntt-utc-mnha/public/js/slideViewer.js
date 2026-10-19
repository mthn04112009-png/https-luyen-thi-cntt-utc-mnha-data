/* ============================================================
 * slideViewer.js — Trang XEM slide (/slides/study/:id)
 *  1. Tải PDF ĐÃ GIẢI MÃ từ /slides/file/:id theo từng phần (?chunk=i) rồi ghép lại
 *     (Vercel cắt response > 4.5MB nên không tải 1 lần được file lớn).
 *  2. Hiển thị bằng PDF.js (cdnjs): từng trang như slide — nút ◀ ▶, phím ←/→, vuốt ngang, zoom, toàn màn hình.
 *  3. PDF.js tải lỗi → dự phòng nhúng PDF bằng <iframe> của trình duyệt.
 *  Nút "Tải xuống PDF": file > 4MB tải theo phần rồi lưu bằng Blob (qua được giới hạn Vercel).
 * ============================================================ */
(function () {
    'use strict';

    var $ = function (id) { return document.getElementById(id); };
    var D = JSON.parse($('slData').textContent);

    var PDFJS_VER = '3.11.174';
    var PDFJS_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/' + PDFJS_VER + '/pdf.min.js';
    var PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/' + PDFJS_VER + '/pdf.worker.min.js';

    var stage = $('slStage'), canvas = $('slCanvas'), loading = $('slLoading');
    var pageNo = $('slPageNo'), pageTotal = $('slPageTotal');
    var ctx = canvas.getContext('2d');

    var pdf = null, page = 1, zoom = 1, rendering = false, pending = null, blobCache = null;

    function setLoading(text, isErr) {
        loading.hidden = false;
        loading.textContent = text;
        loading.className = 'sl-loading' + (isErr ? ' err' : '');
        canvas.hidden = true;
    }

    // ------------------------------------------------------------
    // Tải PDF theo phần → ArrayBuffer
    // ------------------------------------------------------------
    function fetchChunk(i) {
        return fetch(D.fileUrl + '?chunk=' + i, { credentials: 'same-origin', cache: 'no-store' }).then(function (r) {
            if (!r.ok) {
                return r.text().then(function (t) { throw new Error(t && t.length < 200 ? t : 'Máy chủ trả HTTP ' + r.status); });
            }
            var count = Number(r.headers.get('X-Chunk-Count')) || 1;
            return r.arrayBuffer().then(function (buf) { return { buf: buf, count: count }; });
        });
    }

    function fetchPdfBuffer(onProgress) {
        return fetchChunk(0).then(function (first) {
            var parts = [first.buf];
            var count = first.count;
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

    function getBlob(onProgress) {
        if (blobCache) return Promise.resolve(blobCache);
        return fetchPdfBuffer(onProgress).then(function (bytes) {
            blobCache = bytes;
            return bytes;
        });
    }

    // ------------------------------------------------------------
    // Tải xuống
    // ------------------------------------------------------------
    var dl = $('slDownload');
    dl.addEventListener('click', function (e) {
        // File nhỏ (≤ 4MB): để trình duyệt tải trực tiếp qua ?download=1
        if (!D.size || D.size <= 4 * 1024 * 1024) return;
        e.preventDefault();
        var label = dl.querySelector('span');
        var old = label.textContent;
        label.textContent = 'Đang chuẩn bị…';
        getBlob(function (i, n) { label.textContent = 'Đang tải ' + (i + 1) + '/' + n + '…'; }).then(function (bytes) {
            var url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
            var a = document.createElement('a');
            a.href = url; a.download = D.fileName || 'slide.pdf';
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
            label.textContent = old;
        }).catch(function (err) {
            label.textContent = old;
            alert('Không tải xuống được: ' + (err.message || err));
        });
    });

    // ------------------------------------------------------------
    // PDF.js
    // ------------------------------------------------------------
    function loadScript(src) {
        return new Promise(function (resolve, reject) {
            if (window.pdfjsLib) { resolve(); return; }
            var s = document.createElement('script');
            s.src = src; s.async = true;
            s.onload = function () { window.pdfjsLib ? resolve() : reject(new Error('PDF.js không khởi tạo được')); };
            s.onerror = function () { reject(new Error('Không tải được PDF.js')); };
            document.head.appendChild(s);
        });
    }

    function fitScale(vp) {
        var w = stage.clientWidth - 16, h = stage.clientHeight - 16;
        return Math.max(0.1, Math.min(w / vp.width, h / vp.height));
    }

    function render(n) {
        if (!pdf) return;
        if (rendering) { pending = n; return; }
        rendering = true;
        pdf.getPage(n).then(function (pg) {
            var base = pg.getViewport({ scale: 1 });
            var css = fitScale(base) * zoom;
            var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
            var vp = pg.getViewport({ scale: css * dpr });
            canvas.width = Math.floor(vp.width);
            canvas.height = Math.floor(vp.height);
            canvas.style.width = Math.floor(vp.width / dpr) + 'px';
            canvas.style.height = Math.floor(vp.height / dpr) + 'px';
            return pg.render({ canvasContext: ctx, viewport: vp }).promise;
        }).then(function () {
            loading.hidden = true;
            canvas.hidden = false;
        }).catch(function (e) {
            setLoading('Không hiển thị được trang này: ' + (e.message || e), true);
        }).then(function () {
            rendering = false;
            if (pending !== null) { var p = pending; pending = null; render(p); }
        });
    }

    function go(n) {
        if (!pdf) return;
        n = Math.max(1, Math.min(pdf.numPages, Math.round(n) || 1));
        page = n;
        pageNo.value = String(n);
        stage.scrollTop = 0; stage.scrollLeft = 0;
        render(n);
    }

    function setZoom(z) {
        zoom = Math.max(0.5, Math.min(4, z));
        $('slZoomReset').textContent = Math.round(zoom * 100) + '%';
        render(page);
    }

    // ------------------------------------------------------------
    // Dự phòng: nhúng PDF bằng trình duyệt
    // ------------------------------------------------------------
    function iframeFallback(bytes) {
        $('slBar').hidden = true;
        stage.innerHTML = '';
        var url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        var f = document.createElement('iframe');
        f.src = url; f.title = D.title; f.className = 'sl-frame';
        stage.appendChild(f);
        var note = document.createElement('p');
        note.className = 'sl-note';
        note.textContent = 'Nếu không thấy slide, hãy bấm "Tải xuống PDF" để mở bằng ứng dụng đọc PDF.';
        stage.parentNode.appendChild(note);
    }

    // ------------------------------------------------------------
    // Khởi động
    // ------------------------------------------------------------
    setLoading('Đang tải và giải mã slide…');
    var bytes = null;

    getBlob(function (i, n) { setLoading('Đang tải phần ' + (i + 1) + '/' + n + '…'); }).then(function (b) {
        bytes = b;
        return loadScript(PDFJS_SRC).then(function () {
            window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
            // slice(): PDF.js chuyển quyền sở hữu buffer sang worker → giữ bản gốc cho tải xuống / iframe
            return window.pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
        });
    }).then(function (doc) {
        pdf = doc;
        pageTotal.textContent = String(doc.numPages);
        pageNo.max = String(doc.numPages);
        go(1);
    }).catch(function (e) {
        if (bytes) { iframeFallback(bytes); return; }
        setLoading('Không tải được slide: ' + (e.message || e), true);
    });

    // ------------------------------------------------------------
    // Điều khiển
    // ------------------------------------------------------------
    $('slPrev').addEventListener('click', function () { go(page - 1); });
    $('slNext').addEventListener('click', function () { go(page + 1); });
    pageNo.addEventListener('change', function () { go(Number(pageNo.value)); });
    $('slZoomIn').addEventListener('click', function () { setZoom(zoom + 0.25); });
    $('slZoomOut').addEventListener('click', function () { setZoom(zoom - 0.25); });
    $('slZoomReset').addEventListener('click', function () { setZoom(1); });

    $('slFull').addEventListener('click', function () {
        var pane = stage.parentNode;
        if (document.fullscreenElement) { document.exitFullscreen(); return; }
        if (pane.requestFullscreen) pane.requestFullscreen().catch(function () {});
    });
    document.addEventListener('fullscreenchange', function () { setTimeout(function () { render(page); }, 120); });

    document.addEventListener('keydown', function (e) {
        if (!pdf || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '')) return;
        if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); go(page + 1); }
        else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(page - 1); }
        else if (e.key === 'Home') { go(1); }
        else if (e.key === 'End') { go(pdf.numPages); }
        else if (e.key === '+' || e.key === '=') { setZoom(zoom + 0.25); }
        else if (e.key === '-') { setZoom(zoom - 0.25); }
    });

    // Vuốt ngang để lật trang (chỉ khi đang vừa khung)
    var tx = 0, ty = 0, tt = 0;
    stage.addEventListener('touchstart', function (e) {
        if (e.touches.length !== 1) return;
        tx = e.touches[0].clientX; ty = e.touches[0].clientY; tt = Date.now();
    }, { passive: true });
    stage.addEventListener('touchend', function (e) {
        if (zoom !== 1 || !e.changedTouches.length) return;
        var dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty;
        if (Date.now() - tt < 600 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(page + (dx < 0 ? 1 : -1));
    }, { passive: true });

    var rt = null;
    window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { render(page); }, 150); });
})();
