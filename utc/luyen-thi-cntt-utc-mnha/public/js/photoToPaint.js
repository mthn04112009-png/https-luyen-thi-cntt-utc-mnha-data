/* ============================================================
 * photoToPaint.js — chuyển ẢNH CHỤP chữ/hình viết tay thành NÉT ĐEN trên nền trong suốt
 * để đưa vào bảng vẽ JS Paint (DrawingPad.importBitmap).
 * ------------------------------------------------------------
 *  Mạng tích chập (CNN) nhỏ, trọng số CỐ ĐỊNH (không cần tải model, không tốn băng thông):
 *    Lớp 1  conv2d 5×5 (Gaussian)  → khử nhiễu hạt/giấy
 *    Lớp 2  avgPool k×k            → "độ sáng nền cục bộ" quanh mỗi điểm (bỏ qua bóng/đèn không đều)
 *    Đầu ra mực = nền cục bộ − điểm ảnh > ngưỡng  (tương đương lọc DoG + ngưỡng thích ứng)
 *    Hậu xử lý: lọc đốm nhiễu 1px
 *
 *  Package free: TensorFlow.js (tf.conv2d / tf.avgPool) nạp từ CDN jsDelivr khi cần.
 *  Không nạp được (offline/bị chặn) → tự chạy bản JS thuần cho kết quả giống hệt.
 *
 *    const r = await PhotoToPaint.convert(fileOrBlob, { sensitivity: 14 });
 *    r = { canvas, width, height, engine: "tfjs" | "js", inkRatio }
 * ============================================================ */
(function (global) {
    "use strict";

    var FIT_W = 1120;   // vừa tờ giấy 1200×1800 của DrawingPad (đã trừ lề)
    var FIT_H = 1720;
    var TF_URL = "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js";
    var G1 = [1, 4, 6, 4, 1];      // Gaussian 1D, tổng 16
    var DEFAULT_SENS = 14;         // độ chênh sáng (0–255) tối thiểu để coi là nét mực

    // ---------- nạp TensorFlow.js (tuỳ chọn) ----------
    var tfPromise = null;
    function loadTf() {
        if (global.tf && global.tf.conv2d) return Promise.resolve(global.tf);
        if (tfPromise) return tfPromise;
        tfPromise = new Promise(function (resolve) {
            var done = false;
            function finish(v) { if (!done) { done = true; resolve(v); } }
            var sc = document.createElement("script");
            sc.src = TF_URL;
            sc.async = true;
            sc.onload = function () { finish(global.tf && global.tf.conv2d ? global.tf : null); };
            sc.onerror = function () { finish(null); };
            setTimeout(function () { finish(null); }, 8000);
            document.head.appendChild(sc);
        });
        return tfPromise;
    }

    // ---------- đọc ảnh ----------
    function decode(file) {
        if (global.createImageBitmap) {
            return global.createImageBitmap(file).catch(function () { return decodeViaImg(file); });
        }
        return decodeViaImg(file);
    }
    function decodeViaImg(file) {
        return new Promise(function (resolve, reject) {
            var url = URL.createObjectURL(file);
            var img = new Image();
            img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
            img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("Không đọc được ảnh (định dạng không hỗ trợ).")); };
            img.src = url;
        });
    }

    function nextFrame() { return new Promise(function (r) { setTimeout(r, 0); }); }

    // ---------- tiện ích mảng ----------
    function padReplicate(src, w, h, p) {
        var W = w + 2 * p, H = h + 2 * p;
        var out = new Float32Array(W * H);
        for (var y = 0; y < H; y++) {
            var sy = Math.min(h - 1, Math.max(0, y - p));
            var row = sy * w;
            var o = y * W;
            for (var x = 0; x < W; x++) {
                out[o + x] = src[row + Math.min(w - 1, Math.max(0, x - p))];
            }
        }
        return out;
    }

    // ---------- bản JS thuần ----------
    function gaussJs(pad, W, H) {          // 'valid': (W-4)×(H-4)
        var w = W - 4, h = H - 4, x, y;
        var tmp = new Float32Array(w * H);
        for (y = 0; y < H; y++) {
            for (x = 0; x < w; x++) {
                var i = y * W + x;
                tmp[y * w + x] = (pad[i] + 4 * pad[i + 1] + 6 * pad[i + 2] + 4 * pad[i + 3] + pad[i + 4]) / 16;
            }
        }
        var out = new Float32Array(w * h);
        for (y = 0; y < h; y++) {
            for (x = 0; x < w; x++) {
                var j = y * w + x;
                out[j] = (tmp[j] + 4 * tmp[j + w] + 6 * tmp[j + 2 * w] + 4 * tmp[j + 3 * w] + tmp[j + 4 * w]) / 16;
            }
        }
        return out;
    }

    function boxMeanJs(pad, W, H, k) {     // 'valid': (W-k+1)×(H-k+1), trung bình k×k bằng ảnh tích phân
        var w = W - k + 1, h = H - k + 1, x, y;
        var S = W + 1;
        var integ = new Float64Array(S * (H + 1));
        for (y = 0; y < H; y++) {
            var run = 0;
            for (x = 0; x < W; x++) {
                run += pad[y * W + x];
                integ[(y + 1) * S + (x + 1)] = integ[y * S + (x + 1)] + run;
            }
        }
        var out = new Float32Array(w * h);
        var area = k * k;
        for (y = 0; y < h; y++) {
            for (x = 0; x < w; x++) {
                var s = integ[(y + k) * S + (x + k)] - integ[y * S + (x + k)] - integ[(y + k) * S + x] + integ[y * S + x];
                out[y * w + x] = s / area;
            }
        }
        return out;
    }

    // ---------- bản TensorFlow.js ----------
    function gaussTf(tf, pad, W, H) {
        var k2 = new Float32Array(25);
        for (var a = 0; a < 5; a++) for (var b = 0; b < 5; b++) k2[a * 5 + b] = (G1[a] * G1[b]) / 256;
        var out = null;
        tf.tidy(function () {
            var x = tf.tensor4d(pad, [1, H, W, 1]);
            var k = tf.tensor4d(k2, [5, 5, 1, 1]);
            out = tf.conv2d(x, k, 1, "valid").dataSync();
        });
        return new Float32Array(out);
    }

    function boxMeanTf(tf, pad, W, H, k) {
        var out = null;
        tf.tidy(function () {
            var x = tf.tensor4d(pad, [1, H, W, 1]);
            out = tf.avgPool(x, [k, k], 1, "valid").dataSync();
        });
        return new Float32Array(out);
    }

    // ---------- hậu xử lý ----------
    function despeckle(ink, w, h) {
        var out = new Uint8Array(ink.length);
        for (var y = 0; y < h; y++) {
            for (var x = 0; x < w; x++) {
                var i = y * w + x;
                if (!ink[i]) continue;
                var n = 0;
                for (var dy = -1; dy <= 1; dy++) {
                    var yy = y + dy;
                    if (yy < 0 || yy >= h) continue;
                    for (var dx = -1; dx <= 1; dx++) {
                        if (!dx && !dy) continue;
                        var xx = x + dx;
                        if (xx < 0 || xx >= w) continue;
                        n += ink[yy * w + xx];
                    }
                }
                if (n >= 2) out[i] = 1;
            }
        }
        return out;
    }

    function windowSize(w, h) {
        var k = Math.round(Math.min(w, h) / 18);
        k = Math.max(15, Math.min(41, k));
        return k % 2 ? k : k + 1;
    }

    /**
     * Phần tính toán thuần (kiểm thử được): gray → mảng mực 0/1.
     * @param {Float32Array} gray  w*h, 0..255
     * @returns {{ink:Uint8Array, engine:string}}
     */
    async function inkFromGray(gray, w, h, opts) {
        opts = opts || {};
        var sens = typeof opts.sensitivity === "number" ? opts.sensitivity : DEFAULT_SENS;
        var k = windowSize(w, h);
        var p = (k - 1) / 2;
        var tf = opts.forceJs ? null : await loadTf();
        var engine = "js", smooth, local;

        if (tf) {
            try {
                var padG = padReplicate(gray, w, h, 2);
                smooth = gaussTf(tf, padG, w + 4, h + 4);
                var padS = padReplicate(smooth, w, h, p);
                local = boxMeanTf(tf, padS, w + 2 * p, h + 2 * p, k);
                if (smooth.length !== w * h || local.length !== w * h) throw new Error("tfjs: kích thước đầu ra lạ");
                engine = "tfjs";
            } catch (e) {
                if (global.console) console.warn("[photoToPaint] tfjs lỗi, dùng bản JS:", e && e.message);
                smooth = null;
            }
        }
        if (!smooth) {
            smooth = gaussJs(padReplicate(gray, w, h, 2), w + 4, h + 4);
            local = boxMeanJs(padReplicate(smooth, w, h, p), w + 2 * p, h + 2 * p, k);
            engine = "js";
        }

        var ink = new Uint8Array(w * h);
        for (var i = 0; i < ink.length; i++) {
            if (local[i] - smooth[i] > sens && smooth[i] < 225) ink[i] = 1;
        }
        return { ink: despeckle(ink, w, h), engine: engine };
    }

    /** Chuyển ảnh (File/Blob) thành canvas nét đen nền trong suốt. */
    async function convert(file, opts) {
        opts = opts || {};
        var bmp = await decode(file);
        var sw = bmp.width || bmp.naturalWidth, sh = bmp.height || bmp.naturalHeight;
        if (!sw || !sh) throw new Error("Ảnh rỗng.");

        var scale = Math.min(FIT_W / sw, FIT_H / sh, 1);
        var w = Math.max(1, Math.round(sw * scale));
        var h = Math.max(1, Math.round(sh * scale));

        var work = document.createElement("canvas");
        work.width = w; work.height = h;
        var wctx = work.getContext("2d", { willReadFrequently: true });
        wctx.fillStyle = "#ffffff";           // PNG trong suốt → nền trắng
        wctx.fillRect(0, 0, w, h);
        wctx.imageSmoothingQuality = "high";
        wctx.drawImage(bmp, 0, 0, w, h);
        if (bmp.close) bmp.close();

        var px = wctx.getImageData(0, 0, w, h).data;
        var gray = new Float32Array(w * h);
        for (var i = 0, j = 0; i < gray.length; i++, j += 4) {
            gray[i] = 0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2];
        }
        await nextFrame();

        var res = await inkFromGray(gray, w, h, opts);

        var out = document.createElement("canvas");
        out.width = w; out.height = h;
        var octx = out.getContext("2d");
        var img = octx.createImageData(w, h);
        var count = 0;
        for (var n = 0, m = 0; n < res.ink.length; n++, m += 4) {
            if (res.ink[n]) { img.data[m + 3] = 255; count++; }   // đen (0,0,0) + alpha 255
        }
        octx.putImageData(img, 0, 0);

        return { canvas: out, width: w, height: h, engine: res.engine, inkRatio: count / (w * h) };
    }

    global.PhotoToPaint = { convert: convert, inkFromGray: inkFromGray, loadTf: loadTf };
})(window);
