/* ============================================================
 * pdfToImage.js — đổi các trang PDF bài làm thành MỘT ảnh JPEG (các trang xếp dọc)
 * để đi qua đúng luồng "hình vẽ tay" hiện có (kiểm duyệt Cloudinary → AI đọc ảnh → chấm).
 * ------------------------------------------------------------
 *  • Chạy hoàn toàn trên trình duyệt (pdf.js từ cdnjs). KHÔNG sửa file gốc: chỉ đọc, vẽ ra canvas.
 *  • Nén "vừa phải": thử chất lượng cao trước; chỉ khi ảnh vượt MAX_BYTES mới giảm chất lượng,
 *    rồi giảm bề rộng, cuối cùng mới bớt trang (có báo lại cho người dùng quyết định).
 *  • PDF lỗi / có mật khẩu / không đọc được → ném lỗi rõ ràng, không đưa dữ liệu hỏng đi tiếp.
 *
 *    const r = await PdfToImage.convert(file, { onProgress });
 *    r = { dataUrl, blob, bytes, width, height, pages, totalPages, truncated, originalBytes }
 *    const m = await PdfToImage.merge(r, drawingImageOrNull)   // ghép thêm bản vẽ tay (nếu có) bên dưới
 * ============================================================ */
(function (global) {
    "use strict";

    var PDFJS_VER = "3.11.174";
    var PDFJS_SRC = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/" + PDFJS_VER + "/pdf.min.js";
    var PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/" + PDFJS_VER + "/pdf.worker.min.js";

    var MAX_BYTES = 800 * 1024;          // GitHub Contents API chỉ đọc lại file ≤ 1MB (giống DrawingPad)
    var MAX_FILE_BYTES = 30 * 1024 * 1024;
    var MAX_PAGES = 6;                   // ảnh xếp dọc quá dài thì AI đọc kém + canvas trình duyệt có giới hạn
    var RENDER_W = 1100;                 // bề rộng trang khi dựng (đủ rõ chữ viết tay)
    var WIDTHS = [1100, 950, 820, 700];  // bề rộng thử khi nén
    var QUALITIES = [0.82, 0.7, 0.6];
    var GAP = 10;

    var libPromise = null;
    function loadLib() {
        if (global.pdfjsLib) {
            if (!global.pdfjsLib.GlobalWorkerOptions.workerSrc) global.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;   // trang khác đã nạp pdf.js → dùng lại cấu hình sẵn có
            return Promise.resolve(global.pdfjsLib);
        }
        if (libPromise) return libPromise;
        libPromise = new Promise(function (resolve, reject) {
            var s = document.createElement("script");
            s.src = PDFJS_SRC; s.async = true;
            s.onload = function () {
                if (!global.pdfjsLib) { reject(new Error("Không khởi tạo được bộ đọc PDF.")); return; }
                global.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
                resolve(global.pdfjsLib);
            };
            s.onerror = function () { libPromise = null; reject(new Error("Không tải được bộ đọc PDF (kiểm tra mạng rồi thử lại).")); };
            document.head.appendChild(s);
        });
        return libPromise;
    }

    function readBuffer(file) {
        return new Promise(function (resolve, reject) {
            var fr = new FileReader();
            fr.onload = function () { resolve(fr.result); };
            fr.onerror = function () { reject(new Error("Không đọc được file PDF.")); };
            fr.readAsArrayBuffer(file);
        });
    }

    function isPdfBytes(buf) {
        var u = new Uint8Array(buf, 0, Math.min(1024, buf.byteLength));
        for (var i = 0; i + 4 <= u.length; i++) {
            if (u[i] === 0x25 && u[i + 1] === 0x50 && u[i + 2] === 0x44 && u[i + 3] === 0x46) return true;   // "%PDF"
        }
        return false;
    }

    function toBlob(canvas, quality) {
        return new Promise(function (resolve) { canvas.toBlob(resolve, "image/jpeg", quality); });
    }
    function blobToDataUrl(blob) {
        return new Promise(function (resolve, reject) {
            var fr = new FileReader();
            fr.onload = function () { resolve(fr.result); };
            fr.onerror = function () { reject(new Error("Không đọc được ảnh vừa tạo.")); };
            fr.readAsDataURL(blob);
        });
    }
    function nextFrame() { return new Promise(function (r) { setTimeout(r, 0); }); }

    /** Xếp các canvas (và ảnh phụ nếu có) dọc theo bề rộng w → 1 canvas nền trắng. */
    function stack(parts, w) {
        var items = parts.map(function (p) {
            var sw = p.width, sh = p.height;
            return { src: p, h: Math.max(1, Math.round(sh * (w / sw))) };
        });
        var total = items.reduce(function (n, it) { return n + it.h; }, 0) + GAP * (items.length - 1);
        var c = document.createElement("canvas");
        c.width = w; c.height = total;
        var ctx = c.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, total);
        ctx.imageSmoothingQuality = "high";
        var y = 0;
        items.forEach(function (it, i) {
            ctx.drawImage(it.src, 0, y, w, it.h);
            y += it.h;
            if (i < items.length - 1) {            // vạch xám mảnh ngăn các trang
                ctx.fillStyle = "#d1d5db";
                ctx.fillRect(0, y + Math.floor(GAP / 2) - 1, w, 2);
                y += GAP;
            }
        });
        return c;
    }

    /**
     * Tìm cách mã hoá JPEG ≤ MAX_BYTES: giữ chất lượng cao trước → giảm chất lượng → giảm bề rộng → bớt trang.
     * @param parts  mảng canvas/ảnh (trang PDF…, có thể kèm ảnh bản vẽ ở cuối)
     * @param nPdf   số phần đầu là trang PDF (chỉ các phần này mới được bớt)
     */
    async function fit(parts, nPdf) {
        var pdfParts = parts.slice(0, nPdf), extras = parts.slice(nPdf);
        for (var keep = nPdf; keep >= 1; keep--) {
            var use = pdfParts.slice(0, keep).concat(extras);
            for (var wi = 0; wi < WIDTHS.length; wi++) {
                var c = stack(use, WIDTHS[wi]);
                if (c.height > 14000) continue;              // vượt giới hạn canvas an toàn của trình duyệt
                for (var qi = 0; qi < QUALITIES.length; qi++) {
                    var blob = await toBlob(c, QUALITIES[qi]);
                    if (blob && blob.size <= MAX_BYTES) {
                        return { blob: blob, width: c.width, height: c.height, pdfPages: keep };
                    }
                }
                await nextFrame();
            }
        }
        return null;
    }

    function imgFromDataUrl(url) {
        return new Promise(function (resolve, reject) {
            var im = new Image();
            im.onload = function () { resolve(im); };
            im.onerror = function () { reject(new Error("Không đọc được ảnh bản vẽ.")); };
            im.src = url;
        });
    }

    async function convert(file, opts) {
        opts = opts || {};
        var say = typeof opts.onProgress === "function" ? opts.onProgress : function () {};
        if (!file) throw new Error("Chưa chọn file PDF.");
        if (file.size > MAX_FILE_BYTES) throw new Error("PDF nặng " + (file.size / 1048576).toFixed(1) + "MB, tối đa 30MB.");

        var buf = await readBuffer(file);
        if (!isPdfBytes(buf)) throw new Error("File này không phải PDF hợp lệ.");

        say("Đang mở PDF...");
        var lib = await loadLib();
        var doc;
        try {
            doc = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
        } catch (e) {
            if (e && e.name === "PasswordException") throw new Error("PDF có mật khẩu. Hãy bỏ mật khẩu rồi tải lại.");
            throw new Error("Không đọc được PDF (file có thể bị hỏng).");
        }

        var total = doc.numPages;
        if (!total) throw new Error("PDF không có trang nào.");
        var take = Math.min(total, MAX_PAGES);
        var canvases = [];
        try {
            for (var p = 1; p <= take; p++) {
                say("Đang dựng trang " + p + "/" + take + "...");
                var page = await doc.getPage(p);
                var base = page.getViewport({ scale: 1 });
                var scale = RENDER_W / base.width;
                var vp = page.getViewport({ scale: scale });
                var c = document.createElement("canvas");
                c.width = Math.max(1, Math.round(vp.width));
                c.height = Math.max(1, Math.round(vp.height));
                var ctx = c.getContext("2d");
                ctx.fillStyle = "#ffffff";                    // PDF trong suốt → nền trắng
                ctx.fillRect(0, 0, c.width, c.height);
                await page.render({ canvasContext: ctx, viewport: vp }).promise;
                canvases.push(c);
                if (page.cleanup) page.cleanup();
                await nextFrame();
            }
        } catch (e) {
            throw new Error("Không dựng được trang PDF: " + (e && e.message ? e.message : "lỗi không rõ"));
        } finally {
            try { doc.destroy(); } catch (_) { /* bỏ qua */ }
        }

        say("Đang nén ảnh (≤ " + Math.round(MAX_BYTES / 1024) + "KB)...");
        var out = await fit(canvases, canvases.length);
        if (!out) throw new Error("PDF quá phức tạp để nén ≤ " + Math.round(MAX_BYTES / 1024) + "KB. Hãy tách bớt trang rồi tải lại.");

        return {
            blob: out.blob, bytes: out.blob.size, width: out.width, height: out.height,
            dataUrl: await blobToDataUrl(out.blob), mime: "image/jpeg",
            pages: out.pdfPages, totalPages: total,
            truncated: out.pdfPages < total,
            originalBytes: file.size,
            _canvases: canvases.slice(0, out.pdfPages)
        };
    }

    /**
     * Ghép thêm bản vẽ tay (kết quả DrawingPad.exportImage) bên dưới các trang PDF, nén lại ≤ MAX_BYTES.
     * drawing = null → trả luôn ảnh PDF đã có.
     */
    async function merge(pdf, drawing) {
        if (!pdf) return drawing || null;
        if (!drawing || !drawing.dataUrl) return pdf;
        var img = await imgFromDataUrl(drawing.dataUrl);
        var parts = pdf._canvases.concat([img]);
        var out = await fit(parts, pdf._canvases.length);
        if (out && out.pdfPages < pdf._canvases.length) out = null;    // không âm thầm bỏ trang khi ghép thêm bản vẽ
        if (!out) throw new Error("PDF + bản vẽ quá nặng để nén ≤ " + Math.round(MAX_BYTES / 1024) + "KB. Hãy bỏ bớt trang PDF hoặc vẽ gọn hơn.");
        return {
            blob: out.blob, bytes: out.blob.size, width: out.width, height: out.height,
            dataUrl: await blobToDataUrl(out.blob), mime: "image/jpeg"
        };
    }

    global.PdfToImage = { convert: convert, merge: merge, MAX_BYTES: MAX_BYTES, MAX_PAGES: MAX_PAGES };
})(window);
