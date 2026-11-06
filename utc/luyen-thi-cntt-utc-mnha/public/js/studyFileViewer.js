/* ============================================================
 * studyFileViewer.js — Trang XEM  (/slides/study/:id  và  /documents/study/:id)
 *
 *  1. Tải file ĐÃ GIẢI MÃ từ {fileUrl}?chunk=i theo từng phần ≤ 4MB rồi ghép lại
 *     (Vercel cắt response > 4.5MB; server tự nối các file-phần ≤ 23MB trên GitHub).
 *  2. Hiển thị theo loại:
 *     • documents (PDF)      → cuộn dọc liên tục như PDF thường, phóng to/nhỏ (nút, Ctrl+lăn chuột, chụm 2 ngón), đúng khổ ngang/dọc
 *     • slides + PDF         → từng trang như slide (◀ ▶, phím, vuốt, zoom, toàn màn hình)
 *     • slides + PPTX        → lõi tự viết js/pptxPlayer.js (khuyến nghị: đổi PPTX → PDF bằng converter/server.py khi up, form tự làm; file cũ vẫn xem bằng lõi này)
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
        pptx: '/js/pptxPlayer.js'                                   // lõi dự phòng (tự viết)
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
    function fetchBytesServer(onProgress) {
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

    // ------------------------------------------------------------
    // ★ Giải mã TẠI TRÌNH DUYỆT (ưu tiên): tải thẳng file mã hoá từ GitHub (raw, repo public), VỪA TẢI VỪA GIẢI MÃ
    //   từng khung (~2MB) → xin khoá từng khung ở {keyUrl} bằng token 2 giờ (khoá gốc không rời server) →
    //   giải mã bằng Web Crypto → đẩy vào "đích" (RAM / Blob / ghi thẳng xuống đĩa). Không bao giờ giữ cả file mã hoá.
    //   Mọi lỗi (GitHub/CORS/token hết hạn/trình duyệt cũ) → tự quay về đường cũ qua máy chủ (?chunk=i).
    // ------------------------------------------------------------
    var MAGIC = [0x53, 0x4c, 0x44, 0x32];            // "SLD2"
    var FRAME_HEAD = 12 + 16 + 12 + 16;              // index+total+ctLen | salt | iv | tag
    var KEEP_CACHE_MAX = 30 * 1000 * 1000;           // file lớn hơn: không giữ bản giải mã để dùng lại (tiết kiệm RAM)

    function u32(b, o) { return ((b[o] * 16777216) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]); }
    function toB64u(b) {
        var s = '';
        for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
        return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    function fromB64u(s) {
        s = String(s).replace(/-/g, '+').replace(/_/g, '/');
        while (s.length % 4) s += '=';
        var bin = atob(s), out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    // Hàng đợi byte: gom các mẩu mạng rồi cắt đúng độ dài một khung (chỉ giữ ≤ 1 khung dở dang + 1 mẩu mạng)
    function ByteQueue() { this.chunks = []; this.len = 0; }
    ByteQueue.prototype.push = function (u8) { if (u8.length) { this.chunks.push(u8); this.len += u8.length; } };
    ByteQueue.prototype.peek = function (n) {
        var out = new Uint8Array(n), off = 0;
        for (var i = 0; i < this.chunks.length && off < n; i++) {
            var c = this.chunks[i], k = Math.min(c.length, n - off);
            out.set(k === c.length ? c : c.subarray(0, k), off); off += k;
        }
        return out;
    };
    ByteQueue.prototype.take = function (n) {
        var out = new Uint8Array(n), off = 0;
        while (off < n) {
            var c = this.chunks[0], need = n - off;
            if (c.length <= need) { out.set(c, off); off += c.length; this.chunks.shift(); }
            else { out.set(c.subarray(0, need), off); this.chunks[0] = c.subarray(need); off += need; }
        }
        this.len -= n;
        return out;
    };

    function parseFrame(b) {
        var o = 12, f = { index: u32(b, 0), total: u32(b, 4) };
        f.salt = b.subarray(o, o + 16); o += 16;
        f.iv = b.subarray(o, o + 12); o += 12;
        f.tag = b.subarray(o, o + 16); o += 16;
        f.ct = b.subarray(o);
        return f;
    }
    /** Lấy ra mọi khung đã nhận ĐỦ byte trong hàng đợi (pst: trạng thái của file-phần đang đọc). */
    function drainFrames(q, pst) {
        var frames = [], i;
        if (!pst.magic) {
            if (q.len < 4) return frames;
            var m = q.take(4);
            for (i = 0; i < 4; i++) if (m[i] !== MAGIC[i]) throw new Error('File mã hoá không đúng định dạng.');
            pst.magic = true;
        }
        var maxCt = (D.direct.frameBytes || 2 * 1024 * 1024) * 2 + 1024;
        while (q.len >= FRAME_HEAD) {
            var ctLen = u32(q.peek(FRAME_HEAD), 8);
            if (ctLen > maxCt) throw new Error('Khung mã hoá không hợp lệ.');
            if (q.len < FRAME_HEAD + ctLen) break;
            frames.push(parseFrame(q.take(FRAME_HEAD + ctLen)));
        }
        return frames;
    }
    function frameAad(index, total) {
        var a = new Uint8Array(12);
        a.set(MAGIC, 0);
        a[4] = index >>> 24; a[5] = (index >>> 16) & 255; a[6] = (index >>> 8) & 255; a[7] = index & 255;
        a[8] = total >>> 24; a[9] = (total >>> 16) & 255; a[10] = (total >>> 8) & 255; a[11] = total & 255;
        return a;
    }
    function requestKeys(frames) {
        return fetch(D.direct.keyUrl, {
            method: 'POST', credentials: 'same-origin', cache: 'no-store',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ token: D.direct.token, salts: frames.map(function (f) { return toB64u(f.salt); }) })
        }).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (j) {
                if (!r.ok || !j.keys || j.keys.length !== frames.length) throw new Error(j.message || ('Không xin được khoá (HTTP ' + r.status + ')'));
                return j.keys;
            });
        });
    }
    /** Kiểm tra thứ tự → xin khoá → giải mã từng khung → đẩy vào đích (sink.write). */
    function handleFrames(frames, st, sink) {
        if (!frames.length) return Promise.resolve();
        var i;
        for (i = 0; i < frames.length; i++) {
            if (frames[i].index !== st.expect + i) throw new Error('Thứ tự khung mã hoá không đúng.');
            if (st.total === -1) st.total = frames[i].total;
            if (frames[i].total !== st.total) throw new Error('Số khung mã hoá không đồng nhất.');
        }
        st.expect += frames.length;
        return requestKeys(frames).then(function (keys) {
            var subtle = window.crypto.subtle;
            function one(k) {
                if (k >= frames.length) return Promise.resolve();
                var f = frames[k], data = new Uint8Array(f.ct.length + 16);     // Web Crypto: ciphertext || authTag
                data.set(f.ct, 0); data.set(f.tag, f.ct.length);
                return subtle.importKey('raw', fromB64u(keys[k]), { name: 'AES-GCM' }, false, ['decrypt']).then(function (key) {
                    return subtle.decrypt({ name: 'AES-GCM', iv: f.iv, additionalData: frameAad(f.index, f.total), tagLength: 128 }, key, data);
                }).then(function (plain) { return sink.write(new Uint8Array(plain)); }).then(function () { return one(k + 1); });
            }
            return one(0);
        });
    }
    /** Tải MỘT file-phần từ GitHub theo luồng, giải mã đến đâu đẩy vào đích đến đó. */
    function streamPart(url, st, sink) {
        return fetch(url, { credentials: 'omit', mode: 'cors' }).then(function (r) {
            if (!r.ok) throw new Error('GitHub trả HTTP ' + r.status);
            var q = new ByteQueue(), pst = { magic: false };
            if (!r.body || !r.body.getReader) {                       // trình duyệt cũ không có luồng: tải trọn phần rồi giải mã
                return r.arrayBuffer().then(function (buf) {
                    q.push(new Uint8Array(buf));
                    return handleFrames(drainFrames(q, pst), st, sink).then(function () {
                        if (q.len || !pst.magic) throw new Error('File mã hoá bị cắt cụt.');
                    });
                });
            }
            var reader = r.body.getReader();
            function pump() {
                return reader.read().then(function (res) {
                    if (res.done) { if (q.len || !pst.magic) throw new Error('File mã hoá bị cắt cụt.'); return null; }
                    q.push(res.value);
                    return handleFrames(drainFrames(q, pst), st, sink).then(pump);
                });
            }
            return pump().catch(function (e) { try { reader.cancel(); } catch (_) { /* bỏ qua */ } throw e; });
        });
    }
    function directStream(onProgress, sink) {
        var parts = D.direct.parts || [], st = { expect: 0, total: -1 };
        if (!parts.length) return Promise.reject(new Error('Không có file-phần.'));
        for (var k = 0; k < parts.length; k++) if (!parts[k].url) return Promise.reject(new Error('Thiếu địa chỉ GitHub của file-phần.'));
        function loop(p) {
            if (p >= parts.length) return Promise.resolve();
            if (onProgress) onProgress(p, parts.length);
            return streamPart(parts[p].url, st, sink).then(function () { return loop(p + 1); });
        }
        return loop(0).then(function () {
            if (st.total < 0 || st.expect !== st.total) throw new Error('File mã hoá thiếu khung.');
            return sink.end();
        });
    }

    // Các "đích" của dữ liệu đã giải mã
    function memSink(size) {                // → Uint8Array; biết trước kích thước thì cấp 1 lần, ghi thẳng vào (không ghép lần cuối)
        var buf = size > 0 ? new Uint8Array(size) : null, off = 0, list = [];
        return {
            write: function (u8) {
                if (!buf) { list.push(u8); return; }
                if (off + u8.length > buf.length) throw new Error('Kích thước giải mã vượt dự kiến.');
                buf.set(u8, off); off += u8.length;
            },
            end: function () {
                if (buf) return off === buf.length ? buf : buf.subarray(0, off);
                var total = list.reduce(function (n, b) { return n + b.length; }, 0), out = new Uint8Array(total), o = 0;
                list.forEach(function (b) { out.set(b, o); o += b.length; });
                list = [];
                return out;
            }
        };
    }
    function blobSink() {                   // → Blob (trình duyệt tự đẩy Blob lớn xuống đĩa khi cần)
        var list = [];
        return { write: function (u8) { list.push(u8); }, end: function () { var b = new Blob(list, { type: 'application/octet-stream' }); list = []; return b; } };
    }
    function fileSink(writable) {           // → ghi thẳng xuống đĩa (File System Access API)
        return { write: function (u8) { return writable.write(u8); }, end: function () { return writable.close(); } };
    }

    function fetchBytesDirect(onProgress) { return directStream(onProgress, memSink(D.size)); }
    function fetchBytes(onProgress) {
        if (!D.direct || !window.crypto || !window.crypto.subtle || !window.fetch) return fetchBytesServer(onProgress);
        return fetchBytesDirect(onProgress).catch(function (err) {
            if (window.console) console.warn('[study] giải mã tại trình duyệt lỗi → dùng đường dự phòng qua máy chủ:', err && err.message);
            return fetchBytesServer(onProgress);
        });
    }

    var bytesCache = null;
    function getBytes(onProgress) {
        if (bytesCache) return Promise.resolve(bytesCache);
        return fetchBytes(onProgress).then(function (b) { if (b.length <= KEEP_CACHE_MAX) bytesCache = b; return b; });   // file lớn: không giữ lại (tải xuống sẽ tải lại từ GitHub)
    }

    // ------------------------------------------------------------
    // Tải xuống
    // ------------------------------------------------------------
    var dl = $('slDownload');
    dl.addEventListener('click', function (e) {
        var canDirect = !!(D.direct && window.crypto && window.crypto.subtle && window.fetch);
        if (!canDirect && (!D.size || D.size <= 4 * 1000 * 1000)) return;       // không giải mã tại trình duyệt + file nhỏ: tải trực tiếp qua ?download=1
        e.preventDefault();
        var label = dl.querySelector('span'), old = label.textContent;
        var progress = function (i, n) { label.textContent = 'Đang tải ' + (i + 1) + '/' + n + '…'; };
        var done = function () { label.textContent = old; };
        var fail = function (err) { label.textContent = old; alert('Không tải xuống được: ' + ((err && err.message) || err)); };
        var saveBlob = function (blob) {
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url; a.download = D.fileName || 'file';
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
        };
        var viaBytes = function () {                                              // đường cũ / dự phòng (qua RAM hoặc qua máy chủ)
            return getBytes(progress).then(function (bytes) { saveBlob(new Blob([bytes], { type: 'application/octet-stream' })); });
        };
        label.textContent = 'Đang chuẩn bị…';

        if (bytesCache) { viaBytes().then(done, fail); return; }                  // đã có sẵn bản giải mã trong RAM (file nhỏ)

        if (canDirect && window.showSaveFilePicker) {
            // Chrome/Edge máy tính: ghi thẳng từng khung xuống đĩa — gần như không tốn RAM. (Phải gọi ngay lúc bấm nút.)
            window.showSaveFilePicker({ suggestedName: D.fileName || 'file' }).then(function (h) {
                return h.createWritable().then(function (w) {
                    return directStream(progress, fileSink(w)).catch(function (err) { try { w.abort(); } catch (_) { /* bỏ qua */ } throw err; });
                });
            }).then(done, function (err) {
                if (err && err.name === 'AbortError') { done(); return; }          // người dùng bấm Huỷ ở hộp thoại lưu
                viaBytes().then(done, fail);
            });
            return;
        }
        if (canDirect) {                                                           // trình duyệt khác: gom thành Blob (không ghép mảng lớn)
            directStream(progress, blobSink()).then(saveBlob).then(done, function () { viaBytes().then(done, fail); });
            return;
        }
        viaBytes().then(done, fail);
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
    /** Bản đang nằm trong bytesCache → sao chép (để còn dùng lại); file lớn không cache → đưa thẳng, khỏi nhân đôi RAM. */
    function pdfData(bytes) { return bytes === bytesCache ? bytes.slice(0) : bytes; }
    function pdfPageMode(bytes) {
        return loadPdfJs().then(function (lib) { return lib.getDocument({ data: pdfData(bytes) }).promise; }).then(function (pdf) {
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
        return loadPdfJs().then(function (lib) { return lib.getDocument({ data: pdfData(bytes) }).promise; }).then(function (pdf) {
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
    // PPTX: dùng lõi tự viết pptxPlayer.js. Muốn hiển thị chuẩn nhất → đổi sang PDF (form up Slide tự gọi converter/server.py).
    function pptxMode(bytes) {
        return Promise.all([loadScript(URLS.jszip, 'JSZip'), loadScript(URLS.pptx, 'PptxPlayer')]).then(function () {
            return window.PptxPlayer.load((bytes !== bytesCache && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), window.JSZip);
        }).then(function (deck) {
            pane.innerHTML = '';
            var bar = el('div', 'sl-bar'), stage = el('div', 'sl-stage pp-stage');
            var prev = btn('slPrev', '◀', 'Lùi (←)'), next = btn('slNext', '▶', 'Tiếp / chạy hiệu ứng (→, Space, click)');
            var pageNo = el('input'); pageNo.type = 'number'; pageNo.min = '1'; pageNo.max = String(deck.slides.length); pageNo.value = '1'; pageNo.id = 'slPageNo'; pageNo.setAttribute('aria-label', 'Số slide');
            var total = el('b'); total.textContent = String(deck.slides.length);
            var pg = el('span', 'sl-page'); pg.appendChild(pageNo); pg.appendChild(document.createTextNode(' / ')); pg.appendChild(total);
            var stat = el('span', 'sl-stat'); stat.id = 'slStat';
            var play = btn('slFull', '▶ Trình chiếu', 'Trình chiếu toàn màn hình');
            var zo = btn('slZoomOut', '−', 'Thu nhỏ (−)'), zr = btn('slZoomReset', '100%', 'Về vừa khung (0)'), zi = btn('slZoomIn', '+', 'Phóng to (+)');
            var tdn = btn('slTextDown', 'A−', 'Chữ nhỏ lại'), tr0 = btn('slTextReset', '100%', 'Cỡ chữ vừa khung'), tup = btn('slTextUp', 'A+', 'Chữ to lên');
            [prev, pg, next, sep(), tdn, tr0, tup, sep()].forEach(function (x) { bar.appendChild(x); });
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
            // Zoom: các mức cố định (có 135%); nhớ mức đã chọn cho lần xem sau
            var ZOOMS = [0.5, 0.75, 1, 1.15, 1.35, 1.5, 1.75, 2, 3], ZKEY = 'slPptxZoom';
            function nearest(z) { var b = 2; ZOOMS.forEach(function (v, i) { if (Math.abs(v - z) < Math.abs(ZOOMS[b] - z)) b = i; }); return b; }
            var zi0 = 2;   // luôn vừa khung (không còn zoom; bỏ mức đã lưu cũ)
            try { localStorage.removeItem(ZKEY); } catch (x) { /* bỏ qua */ }
            function applyZoom(i) {
                zi0 = Math.max(0, Math.min(ZOOMS.length - 1, i));
                var z = ZOOMS[zi0];
                player.setZoom(z);
                zr.textContent = Math.round(z * 100) + '%';
                stage.classList.toggle('zoomed', z > 1);
                zo.disabled = zi0 === 0; zi.disabled = zi0 === ZOOMS.length - 1;
                
            }
            // Cỡ chữ nội dung (tiêu đề giữ nguyên): 100% = vừa khung; A+ để chữ to hơn (khung tự cuộn dọc nếu dài)
            var TS = [0.85, 1, 1.2, 1.5, 2], TKEY = 'slPptxText', ti = 1;
            try { var tv = Number(localStorage.getItem(TKEY)); if (tv && TS.indexOf(tv) >= 0) ti = TS.indexOf(tv); } catch (x) { /* bỏ qua */ }
            function applyText(i) {
                ti = Math.max(0, Math.min(TS.length - 1, i));
                player.setTextScale(TS[ti]);
                tr0.textContent = Math.round(TS[ti] * 100) + '%';
                tdn.disabled = ti === 0; tup.disabled = ti === TS.length - 1;
                try { localStorage.setItem(TKEY, String(TS[ti])); } catch (x) { /* bỏ qua */ }
            }
            tdn.onclick = function (e) { e.stopPropagation(); applyText(ti - 1); };
            tup.onclick = function (e) { e.stopPropagation(); applyText(ti + 1); };
            tr0.onclick = function (e) { e.stopPropagation(); applyText(1); };
            player.textScale = TS[ti]; tr0.textContent = Math.round(TS[ti] * 100) + '%'; tdn.disabled = ti === 0; tup.disabled = ti === TS.length - 1;
            player.show(0).then(function () { player.resize(); applyZoom(zi0); stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) / 2; });
            zo.onclick = function (e) { e.stopPropagation(); applyZoom(zi0 - 1); };
            zi.onclick = function (e) { e.stopPropagation(); applyZoom(zi0 + 1); };
            zr.onclick = function (e) { e.stopPropagation(); applyZoom(2); };
            stage.addEventListener('wheel', function (e) {
                return;       // bỏ zoom bằng Ctrl + lăn chuột
                e.preventDefault(); applyZoom(zi0 + (e.deltaY < 0 ? 1 : -1));
            }, { passive: false });
            // kéo để di chuyển khi đang zoom > 100% (nhả chuột không kéo thì vẫn là "tiếp")
            var dragged = false, dx0 = 0, dy0 = 0, sl0 = 0, st0 = 0, down = false;
            stage.addEventListener('mousedown', function (e) { if (e.button !== 0 || ZOOMS[zi0] <= 1) return; down = true; dragged = false; dx0 = e.clientX; dy0 = e.clientY; sl0 = stage.scrollLeft; st0 = stage.scrollTop; });
            window.addEventListener('mousemove', function (e) {
                if (!down) return;
                var mx = e.clientX - dx0, my = e.clientY - dy0;
                if (!dragged && Math.abs(mx) + Math.abs(my) < 5) return;
                dragged = true; stage.classList.add('drag');
                stage.scrollLeft = sl0 - mx; stage.scrollTop = st0 - my;
            });
            window.addEventListener('mouseup', function () { down = false; stage.classList.remove('drag'); });
            prev.onclick = function () { player.prev(); }; next.onclick = function () { player.next(); };
            pageNo.onchange = function () { player.goto(Number(pageNo.value) - 1); };
            stage.addEventListener('click', function () { if (dragged) { dragged = false; return; } player.next(); });
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
                if (ZOOMS[zi0] > 1) return;
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
            if (bytes && D.ext === 'pdf') {
                // PDF.js có thể đã nhận luôn bộ nhớ (file lớn, không cache) → tải lại để dùng khung nhúng của trình duyệt
                (bytes.byteLength ? Promise.resolve(bytes) : fetchBytes()).then(iframeFallback).catch(function (e2) {
                    if (!pane.contains(loading)) pane.appendChild(loading);
                    setLoading('Không mở được: ' + ((e2 && e2.message) || e2), true);
                });
                return;
            }
            if (!pane.contains(loading)) pane.appendChild(loading);
            setLoading('Không mở được: ' + (e.message || e), true);
        });
    }
    start();
})();
