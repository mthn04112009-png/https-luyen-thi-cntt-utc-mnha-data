/* ============================================================
 * pptxPlayer.js — Đọc và TRÌNH CHIẾU file .pptx ngay trên trình duyệt (không cần Office, không gửi file ra ngoài)
 *
 * Hỗ trợ:
 *   • Bố cục: slide / layout / master (vị trí, nền, chữ kế thừa từ placeholder), theme màu + font
 *   • Hình: chữ nhật, bo góc, elip, đường, mũi tên, tam giác, hình thoi, ngũ giác, lục giác, sao, freeform (custGeom)…
 *   • Chữ: cỡ, đậm/nghiêng/gạch chân, màu, font, căn lề, bullet, giãn dòng, vị trí chữ trong khung, autofit co chữ
 *   • Ảnh (có cắt xén, xoay, lật; PNG/JPG/GIF/SVG/WebP/BMP và cả EMF/WMF/EMZ/WMZ — tự dựng lại thành SVG), nhóm (group), bảng, nền (màu / gradient / ảnh)
 *   • CHUYỂN CẢNH: fade, push, cover, pull(uncover), wipe, split, zoom, circle, diamond, plus, cut, random + nhóm p14 (gần đúng)
 *   • HIỆU ỨNG: entrance / exit / emphasis / motion path — appear, fly in/out, fade, wipe, zoom, box, circle, diamond, split, spin,
 *     grow/shrink, pulse… theo ĐÚNG thứ tự click / cùng lúc / sau hiệu ứng trước và độ trễ, độ dài trong file; hiệu ứng theo đoạn văn
 *   • Tự chuyển slide theo thời gian (advTm) — tuỳ chọn
 * Chưa hỗ trợ (hiển thị khung trống/gần đúng): biểu đồ, SmartArt, video/âm thanh nhúng, WordArt, hiệu ứng blinds/checker/strips/wheel/wedge
 * (được thay bằng fade), một số hình hiếm.
 *
 * Dùng:  var deck = await PptxPlayer.load(arrayBuffer, JSZip);
 *        var player = new PptxPlayer.Player(containerEl, deck, { onChange: fn });  await player.show(0);
 *        player.next(); player.prev(); player.goto(i); player.resize(); player.setZoom(1.35); player.destroy();
 * ============================================================ */
(function (global) {
    'use strict';

    var NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
    var NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
    var NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    var NS_MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
    var NS_P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main';
    var EMU = 9525;                        // 1px (96dpi) = 9525 EMU
    var PT = 12700 / 9525;                 // 1pt = 1.3333px

    // ------------------------------------------------------------
    // XML helpers
    // ------------------------------------------------------------
    function parseXml(str) {
        var d = new DOMParser().parseFromString(str, 'application/xml');
        if (d.getElementsByTagName('parsererror').length) throw new Error('XML không hợp lệ');
        return d.documentElement;
    }
    function kids(n, ns, name) {
        var out = [];
        if (!n) return out;
        for (var c = n.firstElementChild; c; c = c.nextElementSibling) {
            if ((!name || c.localName === name) && (!ns || c.namespaceURI === ns)) out.push(c);
        }
        return out;
    }
    function kid(n, ns, name) { return kids(n, ns, name)[0] || null; }
    function path(n) {                       // kid(kid(n,…),…) — path('a:b','a:c'): bỏ qua tiền tố, dùng localName
        var cur = n;
        for (var i = 1; i < arguments.length && cur; i++) {
            var seg = arguments[i];
            var local = seg.split(':').pop();
            var found = null;
            for (var c = cur.firstElementChild; c; c = c.nextElementSibling) { if (c.localName === local) { found = c; break; } }
            cur = found;
        }
        return cur;
    }
    function desc(n, name) {                // mọi hậu duệ theo localName
        var out = [];
        if (!n) return out;
        var all = n.getElementsByTagName('*');
        for (var i = 0; i < all.length; i++) if (all[i].localName === name) out.push(all[i]);
        return out;
    }
    function num(v, d) { var x = parseFloat(v); return isNaN(x) ? d : x; }
    function attrNum(n, a, d) { return n && n.hasAttribute(a) ? num(n.getAttribute(a), d) : d; }

    function resolvePath(base, target) {
        if (target.charAt(0) === '/') return target.slice(1);
        var parts = base.split('/'); parts.pop();
        target.split('/').forEach(function (seg) {
            if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg);
        });
        return parts.join('/');
    }

    // ------------------------------------------------------------
    // Màu
    // ------------------------------------------------------------
    var PRESET_COLORS = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', gray: '808080', grey: '808080', orange: 'FFA500', purple: '800080', cyan: '00FFFF', magenta: 'FF00FF', lime: '00FF00', navy: '000080', teal: '008080', maroon: '800000', silver: 'C0C0C0', darkBlue: '00008B', darkGreen: '006400', darkRed: '8B0000', lightGray: 'D3D3D3', darkGray: 'A9A9A9' };

    function hex2rgb(h) { h = String(h).replace('#', ''); if (h.length === 3) h = h.replace(/./g, '$&$&'); return [parseInt(h.substr(0, 2), 16) || 0, parseInt(h.substr(2, 2), 16) || 0, parseInt(h.substr(4, 2), 16) || 0]; }
    function rgb2hsl(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        var max = Math.max(r, g, b), min = Math.min(r, g, b), h = 0, s = 0, l = (max + min) / 2;
        if (max !== min) {
            var d = max - min; s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            if (max === r) h = (g - b) / d + (g < b ? 6 : 0); else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
            h /= 6;
        }
        return [h, s, l];
    }
    function hsl2rgb(h, s, l) {
        function f(p, q, t) { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; }
        if (s === 0) { var v = Math.round(l * 255); return [v, v, v]; }
        var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
        return [Math.round(f(p, q, h + 1 / 3) * 255), Math.round(f(p, q, h) * 255), Math.round(f(p, q, h - 1 / 3) * 255)];
    }

    /** node = phần tử chứa 1 phần tử màu (a:solidFill, a:schemeClr…) hoặc chính phần tử màu. → { rgb:[r,g,b], a:0..1 } | null */
    function readColor(node, T) {
        if (!node) return null;
        var names = { srgbClr: 1, schemeClr: 1, sysClr: 1, prstClr: 1, hslClr: 1, scrgbClr: 1 };
        var c = names[node.localName] ? node : null;
        if (!c) { for (var k = node.firstElementChild; k; k = k.nextElementSibling) if (names[k.localName]) { c = k; break; } }
        if (!c) return null;
        var rgb = [0, 0, 0], a = 1;
        switch (c.localName) {
            case 'srgbClr': rgb = hex2rgb(c.getAttribute('val') || '000000'); break;
            case 'sysClr': rgb = hex2rgb(c.getAttribute('lastClr') || (c.getAttribute('val') === 'window' ? 'FFFFFF' : '000000')); break;
            case 'prstClr': rgb = hex2rgb(PRESET_COLORS[c.getAttribute('val')] || '000000'); break;
            case 'scrgbClr': rgb = [attrNum(c, 'r', 0), attrNum(c, 'g', 0), attrNum(c, 'b', 0)].map(function (x) { return Math.round(x / 100000 * 255); }); break;
            case 'hslClr': rgb = hsl2rgb(attrNum(c, 'hue', 0) / 21600000, attrNum(c, 'sat', 0) / 100000, attrNum(c, 'lum', 0) / 100000); break;
            case 'schemeClr':
                var v = c.getAttribute('val');
                if (v === 'phClr') { if (T && T.phClr) { rgb = T.phClr.rgb.slice(); a = T.phClr.a; } break; }
                var map = (T && T.clrMap) || {};
                var key = map[v] || v;
                var col = T && T.theme && T.theme.colors[key];
                rgb = col ? col.slice() : [0, 0, 0];
                break;
        }
        for (var m = c.firstElementChild; m; m = m.nextElementSibling) {
            var val = attrNum(m, 'val', 0) / 100000;
            switch (m.localName) {
                case 'alpha': a = val; break;
                case 'lumMod': case 'lumOff': case 'satMod': case 'satOff': {
                    var hsl = rgb2hsl(rgb[0], rgb[1], rgb[2]);
                    if (m.localName === 'lumMod') hsl[2] = Math.min(1, hsl[2] * val);
                    else if (m.localName === 'lumOff') hsl[2] = Math.min(1, Math.max(0, hsl[2] + val));
                    else if (m.localName === 'satMod') hsl[1] = Math.min(1, hsl[1] * val);
                    else hsl[1] = Math.min(1, Math.max(0, hsl[1] + val));
                    rgb = hsl2rgb(hsl[0], hsl[1], hsl[2]); break;
                }
                case 'tint': rgb = rgb.map(function (x) { return Math.round(x * val + 255 * (1 - val)); }); break;
                case 'shade': rgb = rgb.map(function (x) { return Math.round(x * val); }); break;
                case 'lum': { var h2 = rgb2hsl(rgb[0], rgb[1], rgb[2]); rgb = hsl2rgb(h2[0], h2[1], val); break; }
                case 'inv': rgb = rgb.map(function (x) { return 255 - x; }); break;
                case 'gray': { var g = Math.round(0.3 * rgb[0] + 0.59 * rgb[1] + 0.11 * rgb[2]); rgb = [g, g, g]; break; }
            }
        }
        return { rgb: rgb, a: a };
    }
    function css(c) { return c ? 'rgba(' + c.rgb[0] + ',' + c.rgb[1] + ',' + c.rgb[2] + ',' + c.a + ')' : 'transparent'; }

    // ------------------------------------------------------------
    // Metafile (EMF / WMF) → SVG
    // PowerPoint lưu ảnh vector dán từ Office / Illustrator / Visio / EPS… dưới dạng .emf / .wmf. Trình duyệt KHÔNG đọc được hai định dạng này
    // (<img> trỏ tới blob EMF chỉ ra khung trống) nên ở đây tự đọc dãy lệnh GDI rồi dựng lại thành SVG, chạy hoàn toàn trên trình duyệt.
    //   • EMF: đường (path) / bezier / đa giác / hình chữ nhật / elip / cung / hình bo góc, bút & cọ (đặc, rỗng, kẻ sọc, mẫu bitmap), nét đứt,
    //     clip (path / vùng / chữ nhật), world transform + các chế độ ánh xạ, bitmap DIB (mọi độ sâu bit, RLE, PNG/JPEG nhúng, alpha), chữ, gradient.
    //   • WMF (có / không có header placeable): tập lệnh tương đương.
    // Không hỗ trợ: EMF+ "Only" (không có lệnh GDI dự phòng), raster-op đặc biệt (XOR/INVERT…) — các lệnh này bị bỏ qua, phần còn lại vẫn được vẽ.
    // ------------------------------------------------------------
    var Metafile = (function () {
        var PI = Math.PI;

        function n3(v) { return String(Math.round(v * 1000) / 1000); }
        function nm(v) { return String(+(+v).toPrecision(9)); }           // ma trận cần nhiều chữ số hơn toạ độ
        function xe(s) { return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
        function hh(v) { v &= 255; return (v < 16 ? '0' : '') + v.toString(16); }
        function cref(c) { return '#' + hh(c) + hh(c >> 8) + hh(c >> 16); }       // COLORREF 0x00BBGGRR → #rrggbb
        function b64(u8) {
            if (typeof Buffer !== 'undefined' && Buffer.from) return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
            var s = '', i, CH = 0x8000;
            for (i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
            return btoa(s);
        }

        // ---------- PNG (dùng canvas khi có; không thì tự ghi PNG không nén) ----------
        var crcT = null;
        function crc32(u8) {
            var i, n, k, c;
            if (!crcT) { crcT = new Int32Array(256); for (n = 0; n < 256; n++) { c = n; for (k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); crcT[n] = c; } }
            c = -1; for (i = 0; i < u8.length; i++) c = crcT[(c ^ u8[i]) & 255] ^ (c >>> 8);
            return (c ^ -1) >>> 0;
        }
        function pngChunk(type, data) {
            var out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer), i;
            dv.setUint32(0, data.length);
            for (i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
            out.set(data, 8);
            dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
            return out;
        }
        function pngStored(w, h, rgba) {
            var rowLen = w * 4 + 1, raw = new Uint8Array(rowLen * h), y, i;
            for (y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * rowLen + 1);
            var nb = Math.max(1, Math.ceil(raw.length / 65535)), z = new Uint8Array(2 + raw.length + nb * 5 + 4), p = 2, o = 0, b;
            z[0] = 0x78; z[1] = 0x01;
            for (b = 0; b < nb; b++) {
                var n = Math.min(65535, raw.length - o);
                z[p++] = b === nb - 1 ? 1 : 0; z[p++] = n & 255; z[p++] = n >> 8; z[p++] = (~n) & 255; z[p++] = ((~n) >> 8) & 255;
                z.set(raw.subarray(o, o + n), p); p += n; o += n;
            }
            var s1 = 1, s2 = 0;
            for (i = 0; i < raw.length;) { var e = Math.min(i + 5552, raw.length); for (; i < e; i++) { s1 += raw[i]; s2 += s1; } s1 %= 65521; s2 %= 65521; }
            z[p++] = s2 >> 8; z[p++] = s2 & 255; z[p++] = s1 >> 8; z[p++] = s1 & 255;
            var ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
            dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6;
            var parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', z), pngChunk('IEND', new Uint8Array(0))];
            var tot = 0; parts.forEach(function (q) { tot += q.length; });
            var res = new Uint8Array(tot), q0 = 0; parts.forEach(function (q) { res.set(q, q0); q0 += q.length; });
            return res;
        }
        function rgbaToUri(w, h, rgba) {
            if (typeof document !== 'undefined' && document.createElement) {
                try {
                    var c = document.createElement('canvas'); c.width = w; c.height = h;
                    var cx = c.getContext('2d'), id = cx.createImageData(w, h);
                    id.data.set(rgba); cx.putImageData(id, 0, 0);
                    var u = c.toDataURL('image/png');
                    if (u && u.length > 30) return u;
                } catch (e) { /* rơi xuống bộ ghi PNG thuần */ }
            }
            return 'data:image/png;base64,' + b64(pngStored(w, h, rgba));
        }

        // ---------- DIB (BITMAPINFO + bit) → ảnh ----------
        function maskInfo(m) {
            m = m >>> 0; if (!m) return null;
            var s = 0, bits = 0; while (!((m >>> s) & 1)) s++; while ((m >>> (s + bits)) & 1) bits++;
            return { m: m, s: s, bits: bits };
        }
        function mget(v, mi) { if (!mi) return 255; var x = (v & mi.m) >>> mi.s; return mi.bits === 8 ? x : Math.round(x * 255 / ((1 << mi.bits) - 1)); }

        /** dv: DataView của cả bản ghi/tệp; trả về { w, h, uri, bottomUp } hoặc null. opts: { alpha: dùng kênh alpha 32bit, key: COLORREF làm trong suốt } */
        function decodeDib(dv, bmiOff, cbBmi, bitsOff, cbBits, opts) {
            opts = opts || {};
            var u8 = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
            if (bmiOff < 0 || bmiOff + 12 > u8.length) return null;
            var hs = dv.getUint32(bmiOff, true), w, h, bpp, comp = 0, clrUsed = 0, x, y, i;
            if (hs === 12) { w = dv.getUint16(bmiOff + 4, true); h = dv.getInt16(bmiOff + 6, true); bpp = dv.getUint16(bmiOff + 10, true); }
            else { w = dv.getInt32(bmiOff + 4, true); h = dv.getInt32(bmiOff + 8, true); bpp = dv.getUint16(bmiOff + 14, true); comp = dv.getUint32(bmiOff + 16, true); clrUsed = dv.getUint32(bmiOff + 32, true); }
            var ah = Math.abs(h), topDown = h < 0;
            if (w <= 0 || ah <= 0 || w > 32768 || ah > 32768) return null;
            if (bitsOff + cbBits > u8.length) cbBits = Math.max(0, u8.length - bitsOff);
            if (comp === 4 || comp === 5) {           // JPEG / PNG nhúng nguyên trong DIB
                return { w: w, h: ah, uri: 'data:image/' + (comp === 4 ? 'jpeg' : 'png') + ';base64,' + b64(u8.subarray(bitsOff, bitsOff + cbBits)), bottomUp: false };
            }
            // mặt nạ bit (16/32 bpp)
            var rM = null, gM = null, bM = null, aM = null, palOff = bmiOff + hs;
            if (comp === 3 || comp === 6 || (hs >= 52 && (bpp === 16 || bpp === 32) && comp !== 0)) {
                var mo = hs >= 52 ? bmiOff + 40 : bmiOff + hs;
                rM = maskInfo(dv.getUint32(mo, true)); gM = maskInfo(dv.getUint32(mo + 4, true)); bM = maskInfo(dv.getUint32(mo + 8, true));
                if (hs >= 56) aM = maskInfo(dv.getUint32(bmiOff + 52, true)); else if (comp === 6) aM = maskInfo(dv.getUint32(mo + 12, true));
                if (hs < 52) palOff += comp === 6 ? 16 : 12;
            }
            var nCol = clrUsed || (bpp <= 8 ? (1 << bpp) : 0), pe = hs === 12 ? 3 : 4, pal = [];
            for (i = 0; i < nCol; i++) {
                var po = palOff + i * pe;
                if (po + pe > u8.length) break;
                pal.push([u8[po + 2], u8[po + 1], u8[po], 255]);
            }
            var rgba = new Uint8ClampedArray(w * ah * 4), stride = ((w * bpp + 31) >>> 5) << 2;
            var kr = -1, kg = -1, kb = -1;
            if (opts.key != null) { kr = opts.key & 255; kg = (opts.key >> 8) & 255; kb = (opts.key >> 16) & 255; }

            function put(o, r, g, b, a) {
                if (r === kr && g === kg && b === kb) a = 0;
                rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
            }
            if (comp === 1 || comp === 2) {           // RLE8 / RLE4 (luôn bottom-up)
                var idx = new Int16Array(w * ah).fill(-1), p = bitsOff, end = bitsOff + cbBits, cx = 0, cy = 0, c, v, n, k;
                while (p + 1 < end && cy < ah) {
                    c = u8[p++]; v = u8[p++];
                    if (c > 0) {
                        for (k = 0; k < c; k++) {
                            var pv = comp === 1 ? v : ((k & 1) ? (v & 15) : (v >> 4));
                            if (cx < w) idx[cy * w + cx] = pv; cx++;
                        }
                    } else if (v === 0) { cx = 0; cy++; }
                    else if (v === 1) break;
                    else if (v === 2) { cx += u8[p++]; cy += u8[p++]; }
                    else {
                        n = v;
                        var nb = comp === 1 ? n : ((n + 1) >> 1);
                        for (k = 0; k < n; k++) {
                            var q = comp === 1 ? u8[p + k] : ((k & 1) ? (u8[p + (k >> 1)] & 15) : (u8[p + (k >> 1)] >> 4));
                            if (cx < w && cy < ah) idx[cy * w + cx] = q; cx++;
                        }
                        p += nb + (nb & 1);
                    }
                }
                for (y = 0; y < ah; y++) for (x = 0; x < w; x++) {
                    var ix = idx[y * w + x], o = ((ah - 1 - y) * w + x) * 4, pc = ix >= 0 ? pal[ix] : null;
                    if (pc) put(o, pc[0], pc[1], pc[2], 255);
                }
                return { w: w, h: ah, uri: rgbaToUri(w, ah, rgba), bottomUp: true };
            }
            for (y = 0; y < ah; y++) {
                var row = topDown ? y : ah - 1 - y, base = bitsOff + row * stride;
                if (base + stride > bitsOff + cbBits + 3 && base >= u8.length) continue;
                for (x = 0; x < w; x++) {
                    var o2 = (y * w + x) * 4, px, r, g, b, a = 255;
                    switch (bpp) {
                        case 1: px = (u8[base + (x >> 3)] >> (7 - (x & 7))) & 1; break;
                        case 4: px = (u8[base + (x >> 1)] >> ((x & 1) ? 0 : 4)) & 15; break;
                        case 8: px = u8[base + x]; break;
                        case 16:
                            if (base + x * 2 + 1 >= u8.length) continue;
                            v = dv.getUint16(base + x * 2, true);
                            if (rM) { r = mget(v, rM); g = mget(v, gM); b = mget(v, bM); a = aM ? mget(v, aM) : 255; }
                            else { r = ((v >> 10) & 31) * 255 / 31; g = ((v >> 5) & 31) * 255 / 31; b = (v & 31) * 255 / 31; }
                            put(o2, r, g, b, a); continue;
                        case 24:
                            if (base + x * 3 + 2 >= u8.length) continue;
                            put(o2, u8[base + x * 3 + 2], u8[base + x * 3 + 1], u8[base + x * 3], 255); continue;
                        case 32:
                            if (base + x * 4 + 3 >= u8.length) continue;
                            if (rM) { v = dv.getUint32(base + x * 4, true); r = mget(v, rM); g = mget(v, gM); b = mget(v, bM); a = aM ? mget(v, aM) : 255; }
                            else { b = u8[base + x * 4]; g = u8[base + x * 4 + 1]; r = u8[base + x * 4 + 2]; a = u8[base + x * 4 + 3]; }
                            if (!opts.alpha) a = 255;
                            else if (a > 0 && a < 255) { r = Math.min(255, r * 255 / a); g = Math.min(255, g * 255 / a); b = Math.min(255, b * 255 / a); }   // bỏ premultiply
                            put(o2, r, g, b, a); continue;
                        default: continue;
                    }
                    var pc2 = pal[px]; if (pc2) put(o2, pc2[0], pc2[1], pc2[2], 255);
                }
            }
            return { w: w, h: ah, uri: rgbaToUri(w, ah, rgba), bottomUp: true };
        }
        /** DIB gói liền (WMF): header + bảng màu + bit nằm kế nhau → tính cbBmi để dùng chung decodeDib. */
        function dibPacked(dv, off, end) {
            var hs = dv.getUint32(off, true), bpp, comp = 0, clr = 0;
            if (hs === 12) { bpp = dv.getUint16(off + 10, true); }
            else { bpp = dv.getUint16(off + 14, true); comp = dv.getUint32(off + 16, true); clr = dv.getUint32(off + 32, true); }
            var nCol = clr || (bpp <= 8 ? (1 << bpp) : 0), extra = (hs === 40 && (comp === 3 || comp === 6)) ? (comp === 6 ? 16 : 12) : 0;
            var cb = hs + extra + nCol * (hs === 12 ? 3 : 4);
            return { bmiOff: off, cbBmi: cb, bitsOff: off + cb, cbBits: Math.max(0, end - off - cb) };
        }

        // ---------- Font / chữ ----------
        var SYM_UP = 'ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ', SYM_LO = 'αβχδεφγηιϕκλμνοπθρστυϖωξψζ';
        var SYM_X = { 0xA3: '≤', 0xB3: '≥', 0xB1: '±', 0xB4: '×', 0xB8: '÷', 0xB9: '≠', 0xBB: '≈', 0xA5: '∞', 0xD6: '√', 0xE5: '∑', 0xF2: '∫', 0xB7: '•', 0xAE: '→', 0xAC: '←', 0xAD: '↑', 0xAF: '↓', 0xDE: '⇒', 0xDB: '⇔', 0xCE: '∈', 0xB6: '∂', 0xD1: '∇', 0xC7: '∩', 0xC8: '∪', 0xCC: '⊂', 0xC9: '⊃', 0xD5: '∏', 0xB0: '°', 0x22: '∀', 0x24: '∃', 0x2D: '−', 0x2A: '∗', 0x5C: '∴', 0x40: '≅', 0x7E: '∼', 0xD7: '⋅' };
        function symbolMap(str) {
            var o = '', i, c;
            for (i = 0; i < str.length; i++) {
                c = str.charCodeAt(i);
                if (c >= 0xF000) c -= 0xF000;
                if (c >= 65 && c <= 90) o += SYM_UP.charAt(c - 65);
                else if (c >= 97 && c <= 122) o += SYM_LO.charAt(c - 97);
                else o += SYM_X[c] || String.fromCharCode(c);
            }
            return o;
        }
        var CHARSET_ENC = { 0: 'windows-1252', 128: 'shift_jis', 129: 'euc-kr', 134: 'gb2312', 136: 'big5', 161: 'windows-1253', 162: 'windows-1254', 163: 'windows-1258', 177: 'windows-1255', 178: 'windows-1256', 186: 'windows-1257', 204: 'windows-1251', 222: 'windows-874', 238: 'windows-1250' };
        function decodeAnsi(u8, charset) {
            try { if (typeof TextDecoder !== 'undefined') return new TextDecoder(CHARSET_ENC[charset] || 'windows-1252').decode(u8); } catch (e) { /* encoding lạ */ }
            var s = '', i; for (i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return s;
        }
        function utf16(dv, off, n) { var s = '', i; for (i = 0; i < n; i++) s += String.fromCharCode(dv.getUint16(off + i * 2, true)); return s; }
        function fontCss(f) {
            var fam = f.face ? "'" + f.face.replace(/['"\\]/g, '') + "'" : '';
            var gen = (f.pitch & 3) === 1 ? 'monospace' : ({ 16: 'serif', 32: 'sans-serif', 48: 'monospace', 64: 'cursive', 80: 'fantasy' }[f.pitch & 0xF0] || 'sans-serif');
            return (fam ? fam + ',' : '') + gen;
        }

        // ---------- Đối tượng GDI mặc định ----------
        var STOCK_BRUSH = [{ k: 'brush', style: 0, color: '#ffffff' }, { k: 'brush', style: 0, color: '#c0c0c0' }, { k: 'brush', style: 0, color: '#808080' }, { k: 'brush', style: 0, color: '#404040' }, { k: 'brush', style: 0, color: '#000000' }, { k: 'brush', style: 1 }];
        var STOCK_PEN = [{ k: 'pen', style: 0, width: 0, color: '#ffffff', cosmetic: true, cap: 'butt', join: 'round' }, { k: 'pen', style: 0, width: 0, color: '#000000', cosmetic: true, cap: 'butt', join: 'round' }, { k: 'pen', style: 5 }];
        var DEFAULT_FONT = { k: 'font', height: -12, esc: 0, weight: 400, italic: false, underline: false, strike: false, charset: 0, face: '', pitch: 0 };

        // ---------- Phép biến đổi ----------
        function compose(f, s) {          // áp f rồi mới áp s (ma trận kiểu SVG [a b c d e f])
            return [s[0] * f[0] + s[2] * f[1], s[1] * f[0] + s[3] * f[1], s[0] * f[2] + s[2] * f[3], s[1] * f[2] + s[3] * f[3], s[0] * f[4] + s[2] * f[5] + s[4], s[1] * f[4] + s[3] * f[5] + s[5]];
        }
        function M(a, m, x, y) { a.push('M' + n3(m[0] * x + m[2] * y + m[4]) + ' ' + n3(m[1] * x + m[3] * y + m[5])); }
        function L(a, m, x, y) { a.push('L' + n3(m[0] * x + m[2] * y + m[4]) + ' ' + n3(m[1] * x + m[3] * y + m[5])); }
        function C(a, m, x1, y1, x2, y2, x3, y3) {
            a.push('C' + n3(m[0] * x1 + m[2] * y1 + m[4]) + ' ' + n3(m[1] * x1 + m[3] * y1 + m[5]) + ' ' + n3(m[0] * x2 + m[2] * y2 + m[4]) + ' ' + n3(m[1] * x2 + m[3] * y2 + m[5]) + ' ' + n3(m[0] * x3 + m[2] * y3 + m[4]) + ' ' + n3(m[1] * x3 + m[3] * y3 + m[5]));
        }

        // ============================================================
        // Gdi: trạng thái thiết bị (DC) + dựng SVG theo toạ độ thiết bị
        // ============================================================
        function Gdi(dev, view, hair) {
            this.dev = dev; this.view = view; this.hair = hair || 1;
            this.body = []; this.defs = []; this.uid = 0; this.open = []; this.pats = {};
            this.objs = []; this.stack = []; this.cx = 0; this.cy = 0; this.path = null; this.pathDone = null; this.drawn = 0; this._m = null; this.emfPlus = false;
            this.st = { mapMode: 1, wo: [0, 0], we: [1, 1], vo: [0, 0], ve: [1, 1], xf: [1, 0, 0, 1, 0, 0], pen: STOCK_PEN[1], brush: STOCK_BRUSH[0], font: DEFAULT_FONT, tc: '#000000', bc: '#ffffff', bm: 2, fill: 1, align: 0, clip: [], miter: 10, arcDir: 1, dcPen: '#000000', dcBrush: '#ffffff' };
        }
        Gdi.prototype.touch = function () { this._m = null; };
        Gdi.prototype.id = function (p) { return (p || 'm') + (++this.uid); };
        Gdi.prototype.mat = function () {
            if (this._m) return this._m;
            var s = this.st, d = this.dev, px = d.w / d.mw, py = d.h / d.mh, sx = 1, sy = 1;
            switch (s.mapMode) {
                case 2: sx = px * 0.1; sy = -py * 0.1; break;
                case 3: sx = px * 0.01; sy = -py * 0.01; break;
                case 4: sx = px * 0.254; sy = -py * 0.254; break;
                case 5: sx = px * 0.0254; sy = -py * 0.0254; break;
                case 6: sx = px * 25.4 / 1440; sy = -py * 25.4 / 1440; break;
                case 7: case 8: sx = s.we[0] ? s.ve[0] / s.we[0] : 1; sy = s.we[1] ? s.ve[1] / s.we[1] : 1; break;
            }
            var x = s.xf;
            return (this._m = [sx * x[0], sy * x[1], sx * x[2], sy * x[3], sx * (x[4] - s.wo[0]) + s.vo[0], sy * (x[5] - s.wo[1]) + s.vo[1]]);
        };
        Gdi.prototype.save = function () {
            var s = this.st, c = {}, k;
            for (k in s) c[k] = s[k];
            c.wo = s.wo.slice(); c.we = s.we.slice(); c.vo = s.vo.slice(); c.ve = s.ve.slice(); c.xf = s.xf.slice(); c.clip = s.clip.slice();
            this.stack.push(c);
        };
        Gdi.prototype.restore = function (n) {
            n = n || -1;
            var i = n < 0 ? this.stack.length + n : n - 1;      // n<0: tương đối; n>0: tuyệt đối (1-based)
            if (i < 0 || i >= this.stack.length) return;
            this.st = this.stack[i]; this.stack.length = i; this.touch();
        };
        /** Đóng/mở các <g clip-path> cho khớp vùng clip hiện hành (giữ phần đầu chung để khỏi mở lại). */
        Gdi.prototype.sync = function () {
            var want = this.st.clip, open = this.open, i = 0;
            while (i < open.length && i < want.length && open[i] === want[i]) i++;
            while (open.length > i) { this.body.push('</g>'); open.pop(); }
            for (; i < want.length; i++) { this.body.push('<g clip-path="url(#' + want[i] + ')">'); open.push(want[i]); }
        };
        Gdi.prototype.setClip = function (mode, d, rule) {
            // mode: 1 AND, 2 OR, 3 XOR, 4 DIFF, 5 COPY. d rỗng + COPY = bỏ clip.
            var s = this.st;
            if (mode === 5 && !d) { s.clip = []; return; }
            if (!d) return;
            var id = this.id('c');
            if (mode === 4) {
                var v = this.view;
                d = 'M' + n3(v.x - 1) + ' ' + n3(v.y - 1) + 'h' + n3(v.w + 2) + 'v' + n3(v.h + 2) + 'h' + n3(-v.w - 2) + 'z ' + d; rule = 1;
            } else if (mode === 2 || mode === 3) return;       // hợp / loại trừ: hiếm gặp, giữ nguyên clip cũ
            this.defs.push('<clipPath id="' + id + '"><path d="' + d + '" clip-rule="' + (rule === 1 ? 'evenodd' : 'nonzero') + '"/></clipPath>');
            if (mode === 5) s.clip = [id]; else s.clip = s.clip.concat([id]);
        };

        // ----- bút / cọ -----
        Gdi.prototype.brushPaint = function (b) {
            if (b.style === 0) return b.color;
            var key, id, s = this.st;
            if (b.style === 2) {                              // kẻ sọc
                key = 'h' + b.hatch + b.color + (s.bm === 2 ? s.bc : '');
                if (this.pats[key]) return 'url(#' + this.pats[key] + ')';
                id = this.id('p'); this.pats[key] = id;
                var H = 'M0 4H8', V = 'M4 0V8', F = 'M0 0L8 8', B = 'M0 8L8 0', dd = [H, V, F, B, H + V, F + B][b.hatch] || H;
                this.defs.push('<pattern id="' + id + '" patternUnits="userSpaceOnUse" width="8" height="8">' + (s.bm === 2 ? '<rect width="8" height="8" fill="' + s.bc + '"/>' : '') + '<path d="' + dd + '" stroke="' + b.color + '" stroke-width="1" fill="none"/></pattern>');
                return 'url(#' + id + ')';
            }
            if (b.dib) {
                key = b.dib.key;
                if (this.pats[key]) return 'url(#' + this.pats[key] + ')';
                id = this.id('p'); this.pats[key] = id;
                this.defs.push('<pattern id="' + id + '" patternUnits="userSpaceOnUse" width="' + b.dib.w + '" height="' + b.dib.h + '"><image width="' + b.dib.w + '" height="' + b.dib.h + '" preserveAspectRatio="none" xlink:href="' + b.dib.uri + '"/></pattern>');
                return 'url(#' + id + ')';
            }
            return b.color || '#000000';
        };
        Gdi.prototype.fillAttr = function () {
            var b = this.st.brush;
            if (!b || b.style === 1) return 'fill="none"';
            return 'fill="' + this.brushPaint(b) + '"' + (this.st.fill === 1 ? ' fill-rule="evenodd"' : '');
        };
        Gdi.prototype.strokeAttr = function (m) {
            var p = this.st.pen;
            if (!p || p.style === 5) return 'stroke="none"';
            var sc = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])), w = (p.cosmetic || !p.width) ? this.hair : p.width * sc;
            var o = 'stroke="' + p.color + '" stroke-width="' + nm(w) + '"';
            if (p.cap && p.cap !== 'butt') o += ' stroke-linecap="' + p.cap + '"';
            if (p.join && p.join !== 'miter') o += ' stroke-linejoin="' + p.join + '"';
            if (p.join === 'miter') o += ' stroke-miterlimit="' + n3(this.st.miter) + '"';
            var ds = p.style & 15, u = Math.max(w, this.hair), da = null;
            if (ds === 1) da = [4, 2]; else if (ds === 2) da = [1, 2]; else if (ds === 3) da = [4, 2, 1, 2]; else if (ds === 4) da = [4, 2, 1, 2, 1, 2];
            if (da) o += ' stroke-dasharray="' + da.map(function (v) { return nm(v * u); }).join(' ') + '"';
            else if (ds === 7 && p.dashes && p.dashes.length) o += ' stroke-dasharray="' + p.dashes.map(function (v) { return nm(Math.max(v * sc, 0.01)); }).join(' ') + '"';
            return o;
        };
        Gdi.prototype.paint = function (d, fill, stroke) {
            var m = this.mat(), f = fill ? this.fillAttr() : 'fill="none"', s = stroke ? this.strokeAttr(m) : 'stroke="none"';
            if (f === 'fill="none"' && s === 'stroke="none"') return;
            this.drawn++; this.sync();
            this.body.push('<path d="' + d + '" ' + f + ' ' + s + '/>');
        };
        /** Thêm một nhóm lệnh path: trong khung BEGINPATH thì gộp vào path, ngoài khung thì vẽ ngay. */
        Gdi.prototype.emit = function (a, fill, stroke) {
            if (this.path) { for (var i = 0; i < a.length; i++) this.path.a.push(a[i]); this.path.open = false; return; }
            this.paint(a.join(' '), fill, stroke);
        };
        Gdi.prototype.moveTo = function (x, y) { this.cx = x; this.cy = y; if (this.path) this.path.open = false; };
        Gdi.prototype.startFig = function (tgt, m) {
            if (this.path) { if (this.path.open) return; this.path.open = true; this.path.sx = this.cx; this.path.sy = this.cy; }
            M(tgt, m, this.cx, this.cy);
        };
        Gdi.prototype.lineTo = function (pts) {
            var m = this.mat(), a = [], tgt = this.path ? this.path.a : a, i;
            this.startFig(tgt, m);
            for (i = 0; i + 1 < pts.length; i += 2) L(tgt, m, pts[i], pts[i + 1]);
            if (pts.length >= 2) { this.cx = pts[pts.length - 2]; this.cy = pts[pts.length - 1]; }
            if (!this.path) this.paint(a.join(' '), false, true);
        };
        Gdi.prototype.bezTo = function (pts) {
            var m = this.mat(), a = [], tgt = this.path ? this.path.a : a, i;
            this.startFig(tgt, m);
            for (i = 0; i + 5 < pts.length; i += 6) C(tgt, m, pts[i], pts[i + 1], pts[i + 2], pts[i + 3], pts[i + 4], pts[i + 5]);
            if (pts.length >= 6) { this.cx = pts[pts.length - 2]; this.cy = pts[pts.length - 1]; }
            if (!this.path) this.paint(a.join(' '), false, true);
        };
        Gdi.prototype.bezier = function (pts) {          // POLYBEZIER: điểm đầu là điểm xuất phát
            var m = this.mat(), a = [], i;
            if (pts.length < 8) return;
            M(a, m, pts[0], pts[1]);
            for (i = 2; i + 5 < pts.length; i += 6) C(a, m, pts[i], pts[i + 1], pts[i + 2], pts[i + 3], pts[i + 4], pts[i + 5]);
            this.emit(a, false, true);
        };
        Gdi.prototype.poly = function (pts, closed, fill, stroke) {
            var m = this.mat(), a = [], n = pts.length >> 1, i;
            if (n < 1) return;
            M(a, m, pts[0], pts[1]);
            for (i = 1; i < n; i++) L(a, m, pts[2 * i], pts[2 * i + 1]);
            if (closed) a.push('Z');
            this.emit(a, fill, stroke);
        };
        Gdi.prototype.polyDraw = function (pts, types) {
            var m = this.mat(), a = [], i, n = types.length, t;
            for (i = 0; i < n; i++) {
                t = types[i] & ~1;
                if (t === 6) { M(a, m, pts[2 * i], pts[2 * i + 1]); this.cx = pts[2 * i]; this.cy = pts[2 * i + 1]; }
                else if (t === 2) { if (!a.length) M(a, m, this.cx, this.cy); L(a, m, pts[2 * i], pts[2 * i + 1]); this.cx = pts[2 * i]; this.cy = pts[2 * i + 1]; }
                else if (t === 4 && i + 2 < n) { if (!a.length) M(a, m, this.cx, this.cy); C(a, m, pts[2 * i], pts[2 * i + 1], pts[2 * i + 2], pts[2 * i + 3], pts[2 * i + 4], pts[2 * i + 5]); i += 2; this.cx = pts[2 * i]; this.cy = pts[2 * i + 1]; }
                if (types[i] & 1) a.push('Z');
            }
            this.emit(a, true, true);
        };
        Gdi.prototype.closeFig = function () {
            if (this.path && this.path.open) { this.path.a.push('Z'); this.path.open = false; this.cx = this.path.sx; this.cy = this.path.sy; }
        };
        // ----- hình học: cung / elip -----
        Gdi.prototype.arcSegs = function (a, m, cx, cy, rx, ry, t0, da, moveFirst) {
            var n = Math.max(1, Math.ceil(Math.abs(da) / (PI / 2) - 1e-9)), step = da / n, k = 4 / 3 * Math.tan(step / 4), i, t1;
            var x0 = cx + rx * Math.cos(t0), y0 = cy + ry * Math.sin(t0);
            if (moveFirst) M(a, m, x0, y0); else L(a, m, x0, y0);
            var ex = x0, ey = y0;
            for (i = 0; i < n; i++) {
                t1 = t0 + step;
                ex = cx + rx * Math.cos(t1); ey = cy + ry * Math.sin(t1);
                C(a, m, cx + rx * (Math.cos(t0) - k * Math.sin(t0)), cy + ry * (Math.sin(t0) + k * Math.cos(t0)), cx + rx * (Math.cos(t1) + k * Math.sin(t1)), cy + ry * (Math.sin(t1) - k * Math.cos(t1)), ex, ey);
                t0 = t1;
            }
            return [ex, ey];
        };
        Gdi.prototype.arcSweep = function (t0, t1) {
            var m = this.mat(), flip = (m[0] * m[3] - m[1] * m[2]) < 0, dec = (this.st.arcDir === 1) !== flip, da = t1 - t0;
            if (dec) { while (da > 0) da -= 2 * PI; while (da <= -2 * PI) da += 2 * PI; }
            else { while (da < 0) da += 2 * PI; while (da >= 2 * PI) da -= 2 * PI; }
            if (Math.abs(da) < 1e-9) da = dec ? -2 * PI : 2 * PI;
            return da;
        };
        Gdi.prototype.ellipse = function (l, t, r, b) {
            var m = this.mat(), a = [];
            this.arcSegs(a, m, (l + r) / 2, (t + b) / 2, Math.abs(r - l) / 2, Math.abs(b - t) / 2, 0, 2 * PI, true); a.push('Z');
            this.emit(a, true, true);
        };
        Gdi.prototype.rect = function (l, t, r, b) {
            var m = this.mat(), a = [];
            M(a, m, l, t); L(a, m, r, t); L(a, m, r, b); L(a, m, l, b); a.push('Z');
            this.emit(a, true, true);
        };
        Gdi.prototype.roundRect = function (l, t, r, b, cw, ch) {
            var m = this.mat(), a = [], x0 = Math.min(l, r), x1 = Math.max(l, r), y0 = Math.min(t, b), y1 = Math.max(t, b);
            var rx = Math.min(Math.abs(cw) / 2, (x1 - x0) / 2), ry = Math.min(Math.abs(ch) / 2, (y1 - y0) / 2);
            M(a, m, x0 + rx, y0);
            this.arcSegs(a, m, x1 - rx, y0 + ry, rx, ry, -PI / 2, PI / 2, false);
            this.arcSegs(a, m, x1 - rx, y1 - ry, rx, ry, 0, PI / 2, false);
            this.arcSegs(a, m, x0 + rx, y1 - ry, rx, ry, PI / 2, PI / 2, false);
            this.arcSegs(a, m, x0 + rx, y0 + ry, rx, ry, PI, PI / 2, false);
            a.push('Z');
            this.emit(a, true, true);
        };
        /** kind: 'arc' | 'pie' | 'chord' | 'arcto' */
        Gdi.prototype.arcShape = function (kind, l, t, r, b, xs, ys, xe_, ye) {
            var m = this.mat(), a = [], cx = (l + r) / 2, cy = (t + b) / 2, rx = Math.abs(r - l) / 2 || 1e-6, ry = Math.abs(b - t) / 2 || 1e-6;
            var t0 = Math.atan2((ys - cy) / ry, (xs - cx) / rx), t1 = Math.atan2((ye - cy) / ry, (xe_ - cx) / rx), da = this.arcSweep(t0, t1), end;
            if (kind === 'arcto') {
                var tgt = this.path ? this.path.a : a; this.startFig(tgt, m);
                end = this.arcSegs(tgt, m, cx, cy, rx, ry, t0, da, false); this.cx = end[0]; this.cy = end[1];
                if (!this.path) this.paint(a.join(' '), false, true);
                return;
            }
            end = this.arcSegs(a, m, cx, cy, rx, ry, t0, da, true);
            if (kind === 'pie') { L(a, m, cx, cy); a.push('Z'); } else if (kind === 'chord') a.push('Z');
            this.emit(a, kind !== 'arc', true);
        };
        Gdi.prototype.angleArc = function (x, y, r, a0, sw) {
            var m = this.mat(), a = [], flip = (m[0] * m[3] - m[1] * m[2]) < 0, sg = flip ? 1 : -1, tgt = this.path ? this.path.a : a;
            this.startFig(tgt, m);
            var end = this.arcSegs(tgt, m, x, y, r, r, sg * a0 * PI / 180, sg * sw * PI / 180, false);
            this.cx = end[0]; this.cy = end[1];
            if (!this.path) this.paint(a.join(' '), false, true);
        };
        // ----- vùng (region) -----
        Gdi.prototype.rectsPath = function (rects) {
            var m = this.mat(), a = [];
            rects.forEach(function (q) { M(a, m, q[0], q[1]); L(a, m, q[2], q[1]); L(a, m, q[2], q[3]); L(a, m, q[0], q[3]); a.push('Z'); });
            return a.join(' ');
        };
        // ----- bitmap -----
        Gdi.prototype.blit = function (img, xd, yd, wd, hd, xs, ys, ws, hs, o) {
            if (!img || !wd || !hd) return;
            o = o || {};
            if (ws == null) { xs = 0; ys = 0; ws = img.w; hs = img.h; }
            ws = Math.abs(ws); hs = Math.abs(hs);
            if (!ws || !hs) return;
            if (img.bottomUp) ys = img.h - ys - hs;          // gốc toạ độ nguồn của DIB bottom-up nằm ở góc dưới trái
            var m = this.mat(), sgx = wd < 0 ? -1 : 1, sgy = hd < 0 ? -1 : 1;
            var t = [m[0] * sgx, m[1] * sgx, m[2] * sgy, m[3] * sgy, m[4] + m[0] * xd + m[2] * yd, m[5] + m[1] * xd + m[3] * yd];
            this.drawn++; this.sync();
            var extra = (o.opacity != null && o.opacity < 1 ? ' opacity="' + n3(o.opacity) + '"' : '') + (o.blend ? ' style="mix-blend-mode:' + o.blend + '"' : '');
            this.body.push('<g transform="matrix(' + t.map(nm).join(' ') + ')"' + extra + '><svg width="' + nm(Math.abs(wd)) + '" height="' + nm(Math.abs(hd)) + '" viewBox="' + xs + ' ' + ys + ' ' + ws + ' ' + hs + '" preserveAspectRatio="none"><image width="' + img.w + '" height="' + img.h + '" preserveAspectRatio="none" xlink:href="' + img.uri + '"/></svg></g>');
        };
        // ----- chữ -----
        Gdi.prototype.text = function (x, y, str, dx, rcl, eto) {
            var s = this.st, f = s.font || DEFAULT_FONT, m = this.mat();
            if (!str) return;
            if (s.align & 1) { x = this.cx; y = this.cy; }
            var sxm = Math.sqrt(m[0] * m[0] + m[1] * m[1]), sym = Math.sqrt(m[2] * m[2] + m[3] * m[3]);
            var fs = (f.height < 0 ? -f.height : (f.height ? f.height * 0.85 : 12)) * sym;
            if (!(fs > 0)) return;
            if (/symbol/i.test(f.face) || f.charset === 2) str = symbolMap(str);
            var rx = m[0] * x + m[2] * y + m[4], ry = m[1] * x + m[3] * y + m[5];
            var rot = Math.atan2(m[1], m[0]) * 180 / PI - (f.esc || 0) / 10, h = s.align & 6, v = s.align & 24, i;
            this.drawn++; this.sync();
            if ((eto & 2) && rcl) { var a = [], mm = m; M(a, mm, rcl[0], rcl[1]); L(a, mm, rcl[2], rcl[1]); L(a, mm, rcl[2], rcl[3]); L(a, mm, rcl[0], rcl[3]); a.push('Z'); this.body.push('<path d="' + a.join(' ') + '" fill="' + s.bc + '"/>'); }
            var xs = '', anchor = h === 0 ? 'start' : (h === 2 ? 'end' : 'middle'), total = 0;
            if (dx && dx.length >= str.length) {
                var cum = 0, arr = [];
                for (i = 0; i < str.length; i++) { arr.push(cum); cum += dx[i] * sxm; }
                total = cum;
                var shift = h === 0 ? 0 : (h === 2 ? -total : -total / 2);
                xs = ' x="' + arr.map(function (q) { return n3(q + shift); }).join(' ') + '"'; anchor = 'start';
            }
            var yo = v === 24 ? 0 : (v === 8 ? -fs * 0.2 : fs * 0.8);
            var at = ' font-family="' + xe(fontCss(f)) + '" font-size="' + n3(fs) + '"' + (f.weight >= 600 ? ' font-weight="700"' : '') + (f.italic ? ' font-style="italic"' : '') + (f.underline || f.strike ? ' text-decoration="' + (f.underline ? 'underline ' : '') + (f.strike ? 'line-through' : '') + '"' : '');
            this.body.push('<text transform="translate(' + n3(rx) + ' ' + n3(ry) + ') rotate(' + n3(rot) + ')"' + (xs || ' x="0"') + ' y="' + n3(yo) + '" text-anchor="' + anchor + '" fill="' + s.tc + '"' + at + ' xml:space="preserve">' + xe(str) + '</text>');
            if ((s.align & 1) && dx && sxm) { var sum = 0; for (i = 0; i < str.length; i++) sum += dx[i]; this.cx = x + sum; }
        };
        // ----- gradient (GRADIENTFILL) -----
        Gdi.prototype.gradRect = function (v0, v1, vertical) {
            var m = this.mat(), a = [], id = this.id('g'), x0 = Math.min(v0.x, v1.x), x1 = Math.max(v0.x, v1.x), y0 = Math.min(v0.y, v1.y), y1 = Math.max(v0.y, v1.y);
            var p0 = vertical ? [(x0 + x1) / 2, v0.y] : [v0.x, (y0 + y1) / 2], p1 = vertical ? [(x0 + x1) / 2, v1.y] : [v1.x, (y0 + y1) / 2];
            var q0 = [m[0] * p0[0] + m[2] * p0[1] + m[4], m[1] * p0[0] + m[3] * p0[1] + m[5]], q1 = [m[0] * p1[0] + m[2] * p1[1] + m[4], m[1] * p1[0] + m[3] * p1[1] + m[5]];
            this.defs.push('<linearGradient id="' + id + '" gradientUnits="userSpaceOnUse" x1="' + n3(q0[0]) + '" y1="' + n3(q0[1]) + '" x2="' + n3(q1[0]) + '" y2="' + n3(q1[1]) + '"><stop offset="0" stop-color="' + v0.c + '"/><stop offset="1" stop-color="' + v1.c + '"/></linearGradient>');
            M(a, m, x0, y0); L(a, m, x1, y0); L(a, m, x1, y1); L(a, m, x0, y1); a.push('Z');
            this.drawn++; this.sync();
            this.body.push('<path d="' + a.join(' ') + '" fill="url(#' + id + ')"/>');
        };
        Gdi.prototype.svg = function () {
            while (this.open.length) { this.body.push('</g>'); this.open.pop(); }
            var v = this.view;
            return '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="' + n3(v.w) + '" height="' + n3(v.h) + '" viewBox="' + n3(v.x) + ' ' + n3(v.y) + ' ' + n3(v.w) + ' ' + n3(v.h) + '" preserveAspectRatio="none">' +
                (this.defs.length ? '<defs>' + this.defs.join('') + '</defs>' : '') + this.body.join('') + '</svg>';
        };
        // ----- bảng đối tượng -----
        Gdi.prototype.selectObj = function (ih) {
            var s = this.st;
            if (ih & 0x80000000) {                           // đối tượng "stock"
                var i = ih & 0x7fffffff;
                if (i <= 5) s.brush = STOCK_BRUSH[i];
                else if (i === 18) s.brush = { k: 'brush', style: 0, color: s.dcBrush };
                else if (i === 6 || i === 7 || i === 8) s.pen = STOCK_PEN[i - 6];
                else if (i === 19) s.pen = { k: 'pen', style: 0, width: 0, color: s.dcPen, cosmetic: true, cap: 'butt', join: 'round' };
                else if (i >= 10 && i <= 17) s.font = DEFAULT_FONT;
                return;
            }
            var o = this.objs[ih]; if (!o) return;
            if (o.k === 'pen') s.pen = o; else if (o.k === 'brush') s.brush = o; else if (o.k === 'font') s.font = o;
        };

        // ============================================================
        // Bộ đọc EMF
        // ============================================================
        function readPts(dv, off, n, is16) {
            var out = new Array(n * 2), i;
            if (is16) for (i = 0; i < n * 2; i++) out[i] = dv.getInt16(off + i * 2, true);
            else for (i = 0; i < n * 2; i++) out[i] = dv.getInt32(off + i * 4, true);
            return out;
        }
        function rgnRects(dv, off) {
            var n = dv.getUint32(off + 8, true), out = [], i, b;
            for (i = 0; i < n; i++) { b = off + 32 + i * 16; out.push([dv.getInt32(b, true), dv.getInt32(b + 4, true), dv.getInt32(b + 8, true), dv.getInt32(b + 12, true)]); }
            return out;
        }
        function emfToSvg(u8) {
            var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), len = u8.length;
            if (len < 88 || dv.getUint32(0, true) !== 1) return null;
            var bl = dv.getInt32(8, true), bt = dv.getInt32(12, true), br = dv.getInt32(16, true), bb = dv.getInt32(20, true);
            var fl = dv.getInt32(24, true), ft = dv.getInt32(28, true), fr = dv.getInt32(32, true), fb = dv.getInt32(36, true);
            var dw = dv.getInt32(72, true), dh = dv.getInt32(76, true), mw = dv.getInt32(80, true), mh = dv.getInt32(84, true);
            if (dw <= 0 || dh <= 0 || mw <= 0 || mh <= 0) { dw = 1280; dh = 1024; mw = 338; mh = 270; }
            var kx = dw / mw / 100, ky = dh / mh / 100;             // rclFrame tính bằng 0.01mm → đơn vị thiết bị
            var view = { x: fl * kx, y: ft * ky, w: (fr - fl) * kx, h: (fb - ft) * ky };
            if (!(view.w > 0 && view.h > 0)) view = { x: bl, y: bt, w: br - bl + 1, h: bb - bt + 1 };
            if (!(view.w > 0 && view.h > 0)) return null;
            var g = new Gdi({ w: dw, h: dh, mw: mw, mh: mh }, view, 1);
            var off = 0, errs = 0;
            while (off + 8 <= len) {
                var type = dv.getUint32(off, true), size = dv.getUint32(off + 4, true);
                if (size < 8 || off + size > len) break;
                try { emfRecord(g, dv, u8, off, type, size); } catch (e) { errs++; }
                off += size;
                if (type === 14) break;
            }
            if (g.drawn === 0) return null;                          // rỗng / EMF+ Only → để phía trên báo "không hiển thị được"
            return g.svg();
        }
        function emfRecord(g, dv, u8, off, type, size) {
            var s = g.st, i, n, p, is16, pts, m;
            function I(o) { return dv.getInt32(off + o, true); }
            function U(o) { return dv.getUint32(off + o, true); }
            function F(o) { return dv.getFloat32(off + o, true); }
            function dib(oBmi, cbBmi, oBits, cbBits, opts) {
                if (!cbBmi || !cbBits) return null;
                return decodeDib(dv, off + oBmi, cbBmi, off + oBits, cbBits, opts);
            }
            switch (type) {
                // --- trạng thái ---
                case 17: s.mapMode = U(8); g.touch(); break;
                case 9: s.we = [I(8), I(12)]; g.touch(); break;
                case 10: s.wo = [I(8), I(12)]; g.touch(); break;
                case 11: s.ve = [I(8), I(12)]; g.touch(); break;
                case 12: s.vo = [I(8), I(12)]; g.touch(); break;
                case 31: if (I(12) && I(20)) { s.ve = [s.ve[0] * I(8) / I(12), s.ve[1] * I(16) / I(20)]; g.touch(); } break;
                case 32: if (I(12) && I(20)) { s.we = [s.we[0] * I(8) / I(12), s.we[1] * I(16) / I(20)]; g.touch(); } break;
                case 35: s.xf = [F(8), F(12), F(16), F(20), F(24), F(28)]; g.touch(); break;
                case 36:
                    var x = [F(8), F(12), F(16), F(20), F(24), F(28)], md = U(32);
                    if (md === 1) s.xf = [1, 0, 0, 1, 0, 0]; else if (md === 2) s.xf = compose(x, s.xf); else if (md === 3) s.xf = compose(s.xf, x); else if (md === 4) s.xf = x;
                    g.touch(); break;
                case 18: s.bm = U(8); break;
                case 19: s.fill = U(8); break;
                case 22: s.align = U(8); break;
                case 24: s.tc = cref(U(8)); break;
                case 25: s.bc = cref(U(8)); break;
                case 57: s.arcDir = U(8); break;
                case 58: s.miter = U(8) || 10; break;
                case 33: g.save(); break;
                case 34: g.restore(I(8)); break;
                case 37: g.selectObj(U(8)); break;
                case 40: g.objs[U(8)] = null; break;
                // --- tạo đối tượng ---
                case 38: {
                    var w0 = I(16), st0 = U(12);
                    g.objs[U(8)] = { k: 'pen', style: st0 & 15, width: w0, color: cref(U(24)), cosmetic: false, cap: w0 > 1 ? 'round' : 'butt', join: 'round' };
                    break;
                }
                case 95: {
                    var ps = U(28), wd = U(32), geo = (ps & 0xF0000) === 0x10000, cb = U(48), cap = ps & 0xF00, jn = ps & 0xF000, dsh = [];
                    for (i = 0; i < cb && i < 16; i++) dsh.push(U(52 + i * 4));
                    var pen = { k: 'pen', style: ps & 15, width: wd, color: cref(U(40)), cosmetic: !geo, cap: geo ? (cap === 0x100 ? 'square' : cap === 0x200 ? 'butt' : 'round') : 'butt', join: geo ? (jn === 0x1000 ? 'bevel' : jn === 0x2000 ? 'miter' : 'round') : 'round', dashes: dsh };
                    if (U(36) === 1) pen.style = 5;                  // bút có cọ rỗng
                    g.objs[U(8)] = pen; break;
                }
                case 39: g.objs[U(8)] = { k: 'brush', style: U(12) === 1 ? 1 : (U(12) === 2 ? 2 : 0), color: cref(U(16)), hatch: U(20) }; break;
                case 94: case 93: {
                    var d0 = dib(U(16), U(20), U(24), U(28), {});
                    g.objs[U(8)] = d0 ? { k: 'brush', style: 3, color: '#808080', dib: { w: d0.w, h: d0.h, uri: d0.uri, key: 'd' + U(8) + '_' + g.uid + '_' + off } } : { k: 'brush', style: 0, color: '#808080' };
                    break;
                }
                case 82: {
                    g.objs[U(8)] = { k: 'font', height: I(12), esc: I(20), weight: I(28), italic: u8[off + 32] !== 0, underline: u8[off + 33] !== 0, strike: u8[off + 34] !== 0, charset: u8[off + 35], pitch: u8[off + 39], face: utf16(dv, off + 40, 32).replace(/\u0000.*$/, '') };
                    break;
                }
                // --- đường / đa giác ---
                case 27: g.moveTo(I(8), I(12)); break;
                case 54: g.lineTo([I(8), I(12)]); break;
                case 2: case 85: case 3: case 86: case 4: case 87: case 5: case 88: case 6: case 89:
                    is16 = type >= 85; n = U(24); pts = readPts(dv, off + 28, n, is16);
                    switch (type - (is16 ? 83 : 0)) {
                        case 2: g.bezier(pts); break;
                        case 3: g.poly(pts, true, true, true); break;
                        case 4: g.poly(pts, false, false, true); break;
                        case 5: g.bezTo(pts); break;
                        case 6: g.lineTo(pts); break;
                    }
                    break;
                case 7: case 8: case 90: case 91: {
                    is16 = type >= 90; var np = U(24), cnts = [], q = off + 32;
                    for (i = 0; i < np; i++) cnts.push(U(32 + i * 4));
                    q = off + 32 + np * 4;
                    var closed = (type === 8 || type === 91);
                    for (i = 0; i < np; i++) {
                        pts = readPts(dv, q, cnts[i], is16); q += cnts[i] * (is16 ? 4 : 8);
                        if (closed) g.poly(pts, true, true, true); else g.poly(pts, false, false, true);
                    }
                    break;
                }
                case 56: case 92: {
                    is16 = type === 92; n = U(24); pts = readPts(dv, off + 28, n, is16);
                    var types = [], tb = off + 28 + n * (is16 ? 4 : 8);
                    for (i = 0; i < n; i++) types.push(u8[tb + i]);
                    g.polyDraw(pts, types); break;
                }
                case 43: g.rect(I(8), I(12), I(16), I(20)); break;
                case 42: g.ellipse(I(8), I(12), I(16), I(20)); break;
                case 44: g.roundRect(I(8), I(12), I(16), I(20), I(24), I(28)); break;
                case 45: g.arcShape('arc', I(8), I(12), I(16), I(20), I(24), I(28), I(32), I(36)); break;
                case 46: g.arcShape('chord', I(8), I(12), I(16), I(20), I(24), I(28), I(32), I(36)); break;
                case 47: g.arcShape('pie', I(8), I(12), I(16), I(20), I(24), I(28), I(32), I(36)); break;
                case 55: g.arcShape('arcto', I(8), I(12), I(16), I(20), I(24), I(28), I(32), I(36)); break;
                case 41: g.angleArc(I(8), I(12), U(16), F(20), F(24)); break;
                // --- khung path ---
                case 59: g.path = { a: [], open: false, sx: 0, sy: 0 }; break;
                case 60: if (g.path) { g.pathDone = g.path; g.path = null; } break;
                case 68: g.path = null; g.pathDone = null; break;
                case 61: g.closeFig(); break;
                case 62: case 63: case 64:
                    if (g.pathDone && g.pathDone.a.length) g.paint(g.pathDone.a.join(' '), type !== 64, type !== 62);
                    g.pathDone = null; break;
                case 67:
                    if (g.pathDone) { g.setClip(U(8), g.pathDone.a.join(' '), s.fill); g.pathDone = null; }
                    break;
                // --- clip ---
                case 30: { var rr = [[I(8), I(12), I(16), I(20)]]; g.setClip(1, g.rectsPath(rr), 2); break; }
                case 29: { var rr2 = [[I(8), I(12), I(16), I(20)]]; g.setClip(4, g.rectsPath(rr2), 2); break; }
                case 75: {
                    var cbr = U(8), mode = U(12);
                    if (!cbr) { if (mode === 5) s.clip = []; }
                    else g.setClip(mode, g.rectsPath(rgnRects(dv, off + 16)), 2);
                    break;
                }
                case 71: case 74: {                              // FILLRGN / PAINTRGN
                    var cr = U(24), bo = type === 71 ? 32 : 28;
                    if (cr) {
                        var old = s.brush, d1 = g.rectsPath(rgnRects(dv, off + bo));
                        if (type === 71) { var o = g.objs[U(28)]; if (o && o.k === 'brush') s.brush = o; }
                        g.paint(d1, true, false); s.brush = old;
                    }
                    break;
                }
                // --- bitmap ---
                case 81: {                                        // STRETCHDIBITS
                    var im = dib(U(48), U(52), U(56), U(60), {}), rop = U(68);
                    if (im) g.blit(im, I(24), I(28), I(72), I(76), I(32), I(36), I(40), I(44), { blend: rop === 0x008800C6 ? 'multiply' : rop === 0x00EE0086 ? 'screen' : null });
                    break;
                }
                case 80: {                                        // SETDIBITSTODEVICE
                    var im2 = dib(U(48), U(52), U(56), U(60), {});
                    if (im2) g.blit(im2, I(24), I(28), I(40), I(44), I(32), I(36), I(40), I(44));
                    break;
                }
                case 76: case 77: {                               // BITBLT / STRETCHBLT
                    var rop2 = U(40), cxs = type === 77 ? I(100) : I(32), cys = type === 77 ? I(104) : I(36);
                    var im3 = dib(U(84), U(88), U(92), U(96), {});
                    if (im3) g.blit(im3, I(24), I(28), I(32), I(36), I(44), I(48), cxs, cys, { blend: rop2 === 0x008800C6 ? 'multiply' : rop2 === 0x00EE0086 ? 'screen' : null });
                    else if (rop2 === 0x00F00021 || rop2 === 0x00000042 || rop2 === 0x00FF0062) {      // PATCOPY / BLACKNESS / WHITENESS: tô khối màu
                        var old2 = s.brush, oldp = s.pen;
                        if (rop2 === 0x42) s.brush = STOCK_BRUSH[4]; else if (rop2 === 0xFF0062) s.brush = STOCK_BRUSH[0];
                        s.pen = STOCK_PEN[2]; g.rect(I(24), I(28), I(24) + I(32), I(28) + I(36)); s.brush = old2; s.pen = oldp;
                    }
                    break;
                }
                case 114: case 116: {                             // ALPHABLEND / TRANSPARENTBLT
                    var bf = U(40), isAlpha = type === 114, af = (bf >>> 24) & 255, ca = (bf >>> 16) & 255;
                    var im4 = dib(U(84), U(88), U(92), U(96), { alpha: isAlpha && (af & 1) === 1, key: isAlpha ? null : bf });
                    if (im4) g.blit(im4, I(24), I(28), I(32), I(36), I(44), I(48), I(100), I(104), { opacity: isAlpha ? ca / 255 : 1 });
                    break;
                }
                case 118: {                                       // GRADIENTFILL
                    var nv = U(24), nt = U(28), mdg = U(32), vs = [], q2 = off + 36;
                    for (i = 0; i < nv; i++) { var vb = off + 36 + i * 16; vs.push({ x: dv.getInt32(vb, true), y: dv.getInt32(vb + 4, true), c: '#' + hh(dv.getUint16(vb + 8, true) >> 8) + hh(dv.getUint16(vb + 10, true) >> 8) + hh(dv.getUint16(vb + 12, true) >> 8) }); }
                    q2 = off + 36 + nv * 16;
                    for (i = 0; i < nt; i++) {
                        if (mdg < 2) { var a0 = vs[dv.getUint32(q2 + i * 8, true)], a1 = vs[dv.getUint32(q2 + i * 8 + 4, true)]; if (a0 && a1) g.gradRect(a0, a1, mdg === 1); }
                        else {
                            var t0 = vs[dv.getUint32(q2 + i * 12, true)], t1 = vs[dv.getUint32(q2 + i * 12 + 4, true)], t2 = vs[dv.getUint32(q2 + i * 12 + 8, true)];
                            if (t0 && t1 && t2) { var ob = s.brush, op = s.pen; s.brush = { k: 'brush', style: 0, color: t0.c }; s.pen = STOCK_PEN[2]; g.poly([t0.x, t0.y, t1.x, t1.y, t2.x, t2.y], true, true, false); s.brush = ob; s.pen = op; }
                        }
                    }
                    break;
                }
                // --- chữ ---
                case 83: case 84: {                               // EXTTEXTOUTA / W
                    var wide = type === 84, nch = U(44), offStr = U(48), opt = U(52), offDx = U(72), str;
                    if (wide) str = utf16(dv, off + offStr, nch);
                    else str = decodeAnsi(u8.subarray(off + offStr, off + offStr + nch), s.font ? s.font.charset : 0);
                    var dxs = null;
                    if (offDx && offDx + nch * 4 <= size) {
                        dxs = []; var pdy = (opt & 0x2000) ? 2 : 1;
                        for (i = 0; i < nch; i++) dxs.push(dv.getInt32(off + offDx + i * 4 * pdy, true));
                    }
                    if (opt & 0x10) break;                         // ETO_GLYPH_INDEX: không ánh xạ được chỉ số glyph
                    g.text(I(36), I(40), str, dxs, [I(56), I(60), I(64), I(68)], opt);
                    break;
                }
                case 70: if (U(8) >= 4 && u8[off + 12] === 0x45 && u8[off + 13] === 0x4D && u8[off + 14] === 0x46 && u8[off + 15] === 0x2B) g.emfPlus = true; break;
                default: break;                                    // lệnh còn lại không ảnh hưởng hình
            }
        }

        // ============================================================
        // Bộ đọc WMF
        // ============================================================
        function wmfToSvg(u8) {
            var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), len = u8.length, p = 0, bl = 0, bt = 0, br = 0, bb = 0, inch = 0, placeable = false;
            if (len < 18) return null;
            if (dv.getUint32(0, true) === 0x9AC6CDD7) {
                placeable = true; bl = dv.getInt16(6, true); bt = dv.getInt16(8, true); br = dv.getInt16(10, true); bb = dv.getInt16(12, true); inch = dv.getUint16(14, true); p = 22;
            }
            var hs = dv.getUint16(p + 2, true) * 2;
            p += hs || 18;
            var view = placeable ? { x: Math.min(bl, br), y: Math.min(bt, bb), w: Math.abs(br - bl), h: Math.abs(bb - bt) } : null;
            if (view && !(view.w > 0 && view.h > 0)) view = null;
            // Không có placeable: dùng cửa sổ logic do SETWINDOWORG/EXT khai báo (quét trước)
            var wox = 0, woy = 0, wex = 0, wey = 0, q = p, rs, fn;
            while (q + 6 <= len) {
                rs = dv.getUint32(q, true) * 2; fn = dv.getUint16(q + 4, true);
                if (rs < 6 || q + rs > len) break;
                if (fn === 0x020B) { woy = dv.getInt16(q + 6, true); wox = dv.getInt16(q + 8, true); }
                else if (fn === 0x020C) { wey = dv.getInt16(q + 6, true); wex = dv.getInt16(q + 8, true); }
                if (fn === 0) break; q += rs;
            }
            if (!view) { if (!wex || !wey) return null; view = { x: Math.min(wox, wox + wex), y: Math.min(woy, woy + wey), w: Math.abs(wex), h: Math.abs(wey) }; }
            var g = new Gdi({ w: 1, h: 1, mw: 1, mh: 1 }, view, inch ? inch / 96 : Math.max(view.w, view.h) / 600);
            var s = g.st; s.mapMode = 8; s.wo = [view.x, view.y]; s.we = [view.w, view.h]; s.vo = [view.x, view.y]; s.ve = [view.w, view.h];
            if (wex && wey) { s.we = [wex, wey]; s.wo = [wox, woy]; }
            g.touch();
            function newObj(o) { var i = 0; while (g.objs[i]) i++; g.objs[i] = o; }
            var errs = 0;
            q = p;
            while (q + 6 <= len) {
                rs = dv.getUint32(q, true) * 2; fn = dv.getUint16(q + 4, true);
                if (rs < 6 || q + rs > len) break;
                if (fn === 0) break;
                try { wmfRecord(g, dv, u8, q, rs, fn, newObj); } catch (e) { errs++; }
                q += rs;
            }
            if (g.drawn === 0) return null;
            return g.svg();
        }
        function wmfRecord(g, dv, u8, q, rs, fn, newObj) {
            var s = g.st, o = q + 6, i, n;
            function S(k) { return dv.getInt16(o + k * 2, true); }
            function W(k) { return dv.getUint16(o + k * 2, true); }
            function D(k) { return dv.getUint32(o + k * 2, true); }
            function pts16(at, cnt) { var r = [], j; for (j = 0; j < cnt * 2; j++) r.push(dv.getInt16(at + j * 2, true)); return r; }
            switch (fn) {
                case 0x0103: s.mapMode = W(0); g.touch(); break;
                case 0x020B: s.wo = [S(1), S(0)]; g.touch(); break;
                case 0x020C: s.we = [S(1), S(0)]; g.touch(); break;
                case 0x020F: s.wo = [s.wo[0] - S(1), s.wo[1] - S(0)]; g.touch(); break;
                case 0x0410: if (S(0) && S(2)) { s.we = [s.we[0] * S(3) / S(2), s.we[1] * S(1) / S(0)]; g.touch(); } break;
                case 0x001E: g.save(); break;
                case 0x0127: g.restore(S(0)); break;
                case 0x0102: s.bm = W(0); break;
                case 0x0106: s.fill = W(0); break;
                case 0x012E: s.align = W(0); break;
                case 0x0209: s.tc = cref(D(0)); break;
                case 0x0201: s.bc = cref(D(0)); break;
                case 0x012D: g.selectObj(W(0)); break;
                case 0x01F0: g.objs[W(0)] = null; break;
                case 0x02FA: { var w0 = S(1); newObj({ k: 'pen', style: W(0) & 15, width: w0, color: cref(D(3)), cosmetic: false, cap: w0 > 1 ? 'round' : 'butt', join: 'round' }); break; }
                case 0x02FC: newObj({ k: 'brush', style: W(0) === 1 ? 1 : (W(0) === 2 ? 2 : 0), color: cref(D(1)), hatch: W(3) }); break;
                case 0x02FB: {
                    var fo = o, face = '';
                    for (i = 0; i < 32; i++) { var ch = u8[fo + 18 + i]; if (!ch) break; face += String.fromCharCode(ch); }
                    newObj({ k: 'font', height: dv.getInt16(fo, true), esc: dv.getInt16(fo + 4, true), weight: dv.getInt16(fo + 8, true), italic: u8[fo + 10] !== 0, underline: u8[fo + 11] !== 0, strike: u8[fo + 12] !== 0, charset: u8[fo + 13], pitch: u8[fo + 17], face: face });
                    break;
                }
                case 0x00F7: case 0x01F9: case 0x06FF: case 0x0142: newObj({ k: 'other' }); break;
                case 0x0214: g.moveTo(S(1), S(0)); break;
                case 0x0213: g.lineTo([S(1), S(0)]); break;
                case 0x0324: n = S(0); g.poly(pts16(o + 2, n), true, true, true); break;
                case 0x0325: n = S(0); g.poly(pts16(o + 2, n), false, false, true); break;
                case 0x0538: {
                    var np = S(0), cnt = [], at;
                    for (i = 0; i < np; i++) cnt.push(W(1 + i));
                    at = o + 2 + np * 2;
                    for (i = 0; i < np; i++) { g.poly(pts16(at, cnt[i]), true, true, true); at += cnt[i] * 4; }
                    break;
                }
                case 0x041B: g.rect(S(3), S(2), S(1), S(0)); break;
                case 0x0418: g.ellipse(S(3), S(2), S(1), S(0)); break;
                case 0x061C: g.roundRect(S(5), S(4), S(3), S(2), S(1), S(0)); break;
                case 0x0817: g.arcShape('arc', S(7), S(6), S(5), S(4), S(3), S(2), S(1), S(0)); break;
                case 0x081A: g.arcShape('pie', S(7), S(6), S(5), S(4), S(3), S(2), S(1), S(0)); break;
                case 0x0830: g.arcShape('chord', S(7), S(6), S(5), S(4), S(3), S(2), S(1), S(0)); break;
                case 0x0416: g.setClip(1, g.rectsPath([[S(3), S(2), S(1), S(0)]]), 2); break;
                case 0x0415: g.setClip(4, g.rectsPath([[S(3), S(2), S(1), S(0)]]), 2); break;
                case 0x0521: {                                    // TEXTOUT
                    var sl = S(0), sb = u8.subarray(o + 2, o + 2 + sl), at2 = o + 2 + ((sl + 1) & ~1);
                    g.text(dv.getInt16(at2 + 2, true), dv.getInt16(at2, true), decodeAnsi(sb, s.font ? s.font.charset : 0), null, null, 0);
                    break;
                }
                case 0x0A32: {                                    // EXTTEXTOUT
                    var ty = S(0), tx = S(1), tl = S(2), opt = W(3), at3 = o + 8, rc = null;
                    if (opt & 6) { rc = [S(4), S(5), S(6), S(7)]; at3 += 8; }
                    var str = decodeAnsi(u8.subarray(at3, at3 + tl), s.font ? s.font.charset : 0), dxa = null, da = at3 + ((tl + 1) & ~1);
                    if (da + tl * 2 <= q + rs) { dxa = []; for (i = 0; i < tl; i++) dxa.push(dv.getInt16(da + i * 2, true)); }
                    g.text(tx, ty, str, dxa, rc, opt);
                    break;
                }
                case 0x0F43: {                                    // STRETCHDIB
                    var rop = D(0), ds = dibPacked(dv, o + 22, q + rs);
                    var im = decodeDib(dv, ds.bmiOff, ds.cbBmi, ds.bitsOff, ds.cbBits, {});
                    if (im) g.blit(im, S(10), S(9), S(8), S(7), S(6), S(5), S(4), S(3), { blend: rop === 0x008800C6 ? 'multiply' : rop === 0x00EE0086 ? 'screen' : null });
                    break;
                }
                case 0x0B41: {                                    // DIBSTRETCHBLT
                    if (rs <= 6 + 20) break;
                    var rop2 = D(0), ds2 = dibPacked(dv, o + 20, q + rs);
                    var im2 = decodeDib(dv, ds2.bmiOff, ds2.cbBmi, ds2.bitsOff, ds2.cbBits, {});
                    if (im2) g.blit(im2, S(9), S(8), S(7), S(6), S(5), S(4), S(3), S(2), { blend: rop2 === 0x008800C6 ? 'multiply' : rop2 === 0x00EE0086 ? 'screen' : null });
                    break;
                }
                case 0x0D33: {                                    // SETDIBTODEV
                    var ds3 = dibPacked(dv, o + 18, q + rs);
                    var im3 = decodeDib(dv, ds3.bmiOff, ds3.cbBmi, ds3.bitsOff, ds3.cbBits, {});
                    if (im3) g.blit(im3, S(8), S(7), S(6), S(5), S(4), S(3), S(6), S(5));
                    break;
                }
                default: break;
            }
        }

        // ============================================================
        // Nhận dạng & API
        // ============================================================
        /** Đoán loại tệp theo nội dung: 'emf' | 'wmf' | 'gzip' | mime ảnh | null */
        function sniff(u8) {
            var n = u8.length;
            if (n < 4) return null;
            if (n >= 44 && u8[0] === 1 && u8[1] === 0 && u8[2] === 0 && u8[3] === 0 && u8[40] === 0x20 && u8[41] === 0x45 && u8[42] === 0x4D && u8[43] === 0x46) return 'emf';
            if (u8[0] === 0xD7 && u8[1] === 0xCD && u8[2] === 0xC6 && u8[3] === 0x9A) return 'wmf';
            if ((u8[0] === 1 || u8[0] === 2) && u8[1] === 0 && u8[2] === 9 && u8[3] === 0 && (u8[4] === 0 || u8[4] === 1 || u8[4] === 3) && u8[5] === 3) return 'wmf';
            if (u8[0] === 0x1F && u8[1] === 0x8B) return 'gzip';
            if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) return 'image/png';
            if (u8[0] === 0xFF && u8[1] === 0xD8 && u8[2] === 0xFF) return 'image/jpeg';
            if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x38) return 'image/gif';
            if (u8[0] === 0x42 && u8[1] === 0x4D) return 'image/bmp';
            if (n > 12 && u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 && u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) return 'image/webp';
            if (n > 12 && u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70 && u8[8] === 0x61 && u8[9] === 0x76 && u8[10] === 0x69) return 'image/avif';
            return null;
        }
        /** Chuyển bytes EMF/WMF thành chuỗi SVG; null nếu không phải metafile hoặc không dựng được hình. */
        function toSvg(u8) {
            var kind = sniff(u8);
            try {
                if (kind === 'emf') return emfToSvg(u8);
                if (kind === 'wmf') return wmfToSvg(u8);
            } catch (e) { if (typeof console !== 'undefined') console.warn('[pptxPlayer] Không giải mã được metafile:', e); }
            return null;
        }
        return { toSvg: toSvg, sniff: sniff };
    })();

    // ------------------------------------------------------------
    // Nạp file
    // ------------------------------------------------------------
    function Zip(zip) { this.zip = zip; this.cache = {}; this.blobs = {}; }
    Zip.prototype.text = function (p) {
        var self = this;
        if (self.cache[p]) return self.cache[p];
        var f = self.zip.file(p);
        self.cache[p] = f ? f.async('string') : Promise.resolve(null);
        return self.cache[p];
    };
    Zip.prototype.xml = function (p) { return this.text(p).then(function (t) { return t ? parseXml(t) : null; }); };
    Zip.prototype.rels = function (p) {
        var dir = p.split('/'); var file = dir.pop();
        var rp = dir.concat(['_rels', file + '.rels']).join('/');
        return this.xml(rp).then(function (root) {
            var out = {};
            kids(root, null, 'Relationship').forEach(function (r) {
                out[r.getAttribute('Id')] = { type: (r.getAttribute('Type') || '').split('/').pop(), target: (/^[a-z][a-z0-9+.\-]*:/i.test(r.getAttribute('Target') || '') || r.getAttribute('TargetMode') === 'External') ? (r.getAttribute('Target') || '') : resolvePath(p, r.getAttribute('Target') || ''), mode: r.getAttribute('TargetMode') };
            });
            return out;
        });
    };
    var MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', jfif: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif', ico: 'image/x-icon' };
    /** .emz / .wmz (EMF/WMF nén gzip): giải nén bằng DecompressionStream nếu trình duyệt có. */
    function gunzipIfNeeded(buf) {
        var u8 = new Uint8Array(buf);
        if (!(u8[0] === 0x1F && u8[1] === 0x8B) || typeof DecompressionStream === 'undefined' || typeof Response === 'undefined') return Promise.resolve(buf);
        return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer().catch(function () { return buf; });
    }
    /**
     * Trả về blob URL dùng được cho <img> / SVG <image>, hoặc null nếu không hiển thị được.
     * Loại ảnh được nhận dạng theo NỘI DUNG tệp (không tin đuôi tệp). EMF/WMF được dựng lại thành SVG vì trình duyệt không đọc được.
     */
    Zip.prototype.blobUrl = function (p) {
        var self = this;
        if (self.blobs[p]) return self.blobs[p];
        var f = self.zip.file(p);
        if (!f) { self.blobs[p] = Promise.resolve(null); return self.blobs[p]; }
        var ext = (p.split('.').pop() || '').toLowerCase();
        self.blobs[p] = f.async('arraybuffer').then(gunzipIfNeeded).then(function (buf) {
            var u8 = new Uint8Array(buf), kind = Metafile.sniff(u8);
            if (kind === 'emf' || kind === 'wmf') {
                var svg = Metafile.toSvg(u8);
                if (!svg) { if (global.console) console.warn('[pptxPlayer] Không dựng được ảnh ' + kind.toUpperCase() + ': ' + p); return null; }
                return URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
            }
            var mime = (kind && kind.indexOf('image/') === 0) ? kind : MIME[ext];
            if (!mime) { if (global.console) console.warn('[pptxPlayer] Định dạng ảnh chưa hỗ trợ: ' + p); return null; }
            return URL.createObjectURL(new Blob([u8], { type: mime }));
        }).catch(function (e) { if (global.console) console.warn('[pptxPlayer] Lỗi đọc ảnh ' + p, e); return null; });
        return self.blobs[p];
    };

    function parseTheme(root) {
        var t = { colors: {}, major: null, minor: null, fills: [], lines: [] };
        if (!root) return t;
        var cs = desc(root, 'clrScheme')[0];
        kids(cs).forEach(function (c) {
            var k = c.localName, v = c.firstElementChild;
            if (!v) return;
            t.colors[k] = v.localName === 'sysClr' ? hex2rgb(v.getAttribute('lastClr') || '000000') : hex2rgb(v.getAttribute('val') || '000000');
        });
        var fs = desc(root, 'fontScheme')[0];
        if (fs) {
            var mj = path(fs, 'a:majorFont', 'a:latin'), mn = path(fs, 'a:minorFont', 'a:latin');
            t.major = mj && mj.getAttribute('typeface'); t.minor = mn && mn.getAttribute('typeface');
        }
        var fmt = desc(root, 'fmtScheme')[0];
        if (fmt) {
            t.fills = kids(kid(fmt, NS_A, 'fillStyleLst'));
            t.lines = kids(kid(fmt, NS_A, 'lnStyleLst'));
            t.bgFills = kids(kid(fmt, NS_A, 'bgFillStyleLst'));
        }
        return t;
    }

    function clrMapOf(master) {
        var m = {}, cm = kid(master, NS_P, 'clrMap');
        if (cm) for (var i = 0; i < cm.attributes.length; i++) m[cm.attributes[i].name] = cm.attributes[i].value;
        if (!m.bg1) { m = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2', accent1: 'accent1', accent2: 'accent2', accent3: 'accent3', accent4: 'accent4', accent5: 'accent5', accent6: 'accent6', hlink: 'hlink', folHlink: 'folHlink' }; }
        return m;
    }

    /** Đọc cả file → deck (chưa dựng DOM). */
    function load(buf, JSZip) {
        return JSZip.loadAsync(buf).then(function (zip) {
            var Z = new Zip(zip);
            return Z.xml('ppt/presentation.xml').then(function (pres) {
                if (!pres) throw new Error('Không phải file .pptx hợp lệ (thiếu ppt/presentation.xml).');
                return Z.rels('ppt/presentation.xml').then(function (prels) {
                    var sz = kid(pres, NS_P, 'sldSz');
                    var deck = { zip: Z, width: attrNum(sz, 'cx', 9144000) / EMU, height: attrNum(sz, 'cy', 6858000) / EMU, slides: [], defaultText: kid(pres, NS_P, 'defaultTextStyle'), _themes: {}, _masters: {}, _layouts: {} };
                    var ids = kids(kid(pres, NS_P, 'sldIdLst'), NS_P, 'sldId');
                    var jobs = ids.map(function (s, i) {
                        var rid = s.getAttributeNS(NS_R, 'id');
                        var rel = prels[rid];
                        return rel ? loadSlide(deck, rel.target, i + 1) : null;
                    }).filter(Boolean);
                    return Promise.all(jobs).then(function (slides) {
                        deck.slides = slides.filter(function (s) { return !s.hidden; });
                        deck.slides.forEach(function (s, i) { s.index = i; });
                        if (!deck.slides.length) throw new Error('File .pptx không có slide nào.');
                        return deck;
                    });
                });
            });
        });
    }

    function loadMaster(deck, p) {
        if (deck._masters[p]) return deck._masters[p];
        deck._masters[p] = deck.zip.xml(p).then(function (root) {
            return deck.zip.rels(p).then(function (rels) {
                var themeRel = Object.keys(rels).map(function (k) { return rels[k]; }).filter(function (r) { return r.type === 'theme'; })[0];
                var themeP = deck.zip.xml(themeRel ? themeRel.target : '__none__').then(parseTheme);
                return themeP.then(function (theme) { return { path: p, root: root, rels: rels, theme: theme, clrMap: clrMapOf(root) }; });
            });
        });
        return deck._masters[p];
    }
    function loadLayout(deck, p) {
        if (deck._layouts[p]) return deck._layouts[p];
        deck._layouts[p] = deck.zip.xml(p).then(function (root) {
            return deck.zip.rels(p).then(function (rels) {
                var mRel = Object.keys(rels).map(function (k) { return rels[k]; }).filter(function (r) { return r.type === 'slideMaster'; })[0];
                return loadMaster(deck, mRel.target).then(function (master) { return { path: p, root: root, rels: rels, master: master }; });
            });
        });
        return deck._layouts[p];
    }
    function loadSlide(deck, p, n) {
        return Promise.all([deck.zip.xml(p), deck.zip.rels(p)]).then(function (r) {
            var root = r[0], rels = r[1];
            var lRel = Object.keys(rels).map(function (k) { return rels[k]; }).filter(function (x) { return x.type === 'slideLayout'; })[0];
            return loadLayout(deck, lRel.target).then(function (layout) {
                return {
                    path: p, root: root, rels: rels, layout: layout, master: layout.master, number: n,
                    hidden: root.getAttribute('show') === '0',
                    transition: parseTransition(root), timing: parseTiming(root), rendered: null
                };
            });
        });
    }

    // ------------------------------------------------------------
    // Chuyển cảnh (parse)
    // ------------------------------------------------------------
    var TRANS_P14 = { vortex: 'push', switch: 'push', flip: 'push', ripple: 'fade', honeycomb: 'fade', glitter: 'fade', flash: 'fade', shred: 'fade', prism: 'fade', orbit: 'fade', ferris: 'push', gallery: 'push', conveyor: 'push', pan: 'push', warp: 'fade', flythrough: 'zoom', doors: 'split', window: 'split', reveal: 'fade', wheelReverse: 'fade' };
    function parseTransition(root) {
        var cands = desc(root, 'transition');
        if (!cands.length) return null;
        // ưu tiên bản chuẩn (con trực tiếp của p:sld hoặc trong mc:Fallback); nếu không có thì lấy bản đầu tiên
        var pick = null;
        cands.forEach(function (t) {
            var par = t.parentNode;
            if (!pick && (par === root || (par.localName === 'Fallback'))) pick = t;
        });
        pick = pick || cands[0];
        var el = pick.firstElementChild;
        var type = el ? el.localName : 'cut';
        var dur = null;
        var d14 = pick.getAttributeNS(NS_P14, 'dur');
        if (d14) dur = num(d14, null);
        if (type in TRANS_P14) type = TRANS_P14[type];
        var spd = pick.getAttribute('spd');
        if (dur === null) dur = spd === 'fast' ? 500 : spd === 'slow' ? 1000 : 750;
        return {
            type: type, dir: el && el.getAttribute('dir'), orient: el && el.getAttribute('orient'), thruBlk: el && el.getAttribute('thruBlk') === '1',
            dur: dur, advClick: pick.getAttribute('advClick') !== '0',
            advTm: pick.hasAttribute('advTm') ? num(pick.getAttribute('advTm'), null) : null
        };
    }

    // ------------------------------------------------------------
    // Hiệu ứng (parse p:timing)
    // ------------------------------------------------------------
    function condDelay(cTn) {
        var l = kid(cTn, NS_P, 'stCondLst'), d = 0, indef = false, onBegin = false;
        kids(l, NS_P, 'cond').forEach(function (c) {
            var v = c.getAttribute('delay');
            if (v === 'indefinite') indef = true; else if (v) d = Math.max(d, num(v, 0));
            if (c.getAttribute('evt') === 'onBegin') onBegin = true;
        });
        return { delay: d, indefinite: indef, onBegin: onBegin };
    }
    function parseMotionPath(s, W, H) {
        var tok = String(s || '').trim().split(/\s+/), pts = [], i = 0, cur = [0, 0];
        function pt(x, y) { return [parseFloat(x) * W, parseFloat(y) * H]; }
        while (i < tok.length) {
            var c = tok[i++];
            if (c === 'M' || c === 'L') { cur = pt(tok[i], tok[i + 1]); i += 2; pts.push(cur); }
            else if (c === 'C') {
                var p0 = cur, p1 = pt(tok[i], tok[i + 1]), p2 = pt(tok[i + 2], tok[i + 3]), p3 = pt(tok[i + 4], tok[i + 5]); i += 6;
                for (var k = 1; k <= 8; k++) {
                    var t = k / 8, u = 1 - t;
                    pts.push([u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]);
                }
                cur = p3;
            }
            else if (c === 'E' || c === 'Z' || c === 'z') { /* kết thúc */ }
            else if (!isNaN(parseFloat(c))) { /* số lạc */ }
        }
        return pts;
    }
    function parseTiming(root) {
        var tm = desc(root, 'timing')[0];
        if (!tm) return { steps: [], auto: false, hiddenInit: {} };
        var main = null;
        desc(tm, 'cTn').forEach(function (c) { if (!main && c.getAttribute('nodeType') === 'mainSeq') main = c; });
        if (!main) return { steps: [], auto: false, hiddenInit: {} };
        var stepPars = kids(kid(main, NS_P, 'childTnLst'), NS_P, 'par');
        var steps = [], auto = false, firstSeen = {}, hiddenInit = {};
        stepPars.forEach(function (sp, si) {
            var outer = kid(sp, NS_P, 'cTn');
            var oc = condDelay(outer);
            if (si === 0 && !oc.indefinite) auto = true; else if (si === 0 && oc.onBegin) auto = true;
            var effects = [];
            kids(kid(outer, NS_P, 'childTnLst'), NS_P, 'par').forEach(function (gp) {
                var gT = kid(gp, NS_P, 'cTn'), gd = condDelay(gT).delay;
                kids(kid(gT, NS_P, 'childTnLst'), NS_P, 'par').forEach(function (ep) {
                    var eT = kid(ep, NS_P, 'cTn');
                    if (!eT || !eT.hasAttribute('presetClass')) return;
                    var ed = condDelay(eT).delay;
                    var behaviors = kids(kid(eT, NS_P, 'childTnLst'));
                    var spid = null, para = null, dur = 0, extra = {};
                    behaviors.forEach(function (b) {
                        var tgt = desc(b, 'spTgt')[0];
                        if (tgt && spid === null) {
                            spid = tgt.getAttribute('spid');
                            var pr = desc(tgt, 'pRg')[0];
                            if (pr) para = [attrNum(pr, 'st', 0), attrNum(pr, 'end', 0)];
                        }
                        var bT = path(b, 'p:cBhvr', 'p:cTn') || (b.localName === 'cmd' ? null : null);
                        var d = bT ? attrNum(bT, 'dur', 0) : 0;
                        if (b.localName === 'set' && d <= 1) d = 0;
                        dur = Math.max(dur, d);
                        if (b.localName === 'animMotion') extra.path = b.getAttribute('path');
                        if (b.localName === 'animRot') extra.rot = attrNum(b, 'by', 0) / 60000;
                        if (b.localName === 'animScale') { var by = kid(b, NS_P, 'by'); if (by) extra.scale = [attrNum(by, 'x', 100000) / 100000, attrNum(by, 'y', 100000) / 100000]; }
                        if (b.localName === 'animEffect') extra.filter = b.getAttribute('filter');
                    });
                    if (spid === null) return;
                    effects.push({
                        spid: spid, para: para, cls: eT.getAttribute('presetClass'), preset: attrNum(eT, 'presetID', 0), subtype: attrNum(eT, 'presetSubtype', 0),
                        node: eT.getAttribute('nodeType'), start: gd + ed, dur: dur, extra: extra
                    });
                    var key = spid + (para ? ':' + para[0] : '');
                    if (!(key in firstSeen)) { firstSeen[key] = true; if (eT.getAttribute('presetClass') === 'entr') hiddenInit[key] = { spid: spid, para: para }; }
                });
            });
            if (effects.length) steps.push({ effects: effects });
        });
        return { steps: steps, auto: auto && steps.length > 0, hiddenInit: hiddenInit };
    }

    // ------------------------------------------------------------
    // Dựng slide → DOM
    // ------------------------------------------------------------
    var gradSeq = 0;
    var SVGNS = 'http://www.w3.org/2000/svg';
    function svgEl(name, attrs) { var e = document.createElementNS(SVGNS, name); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }

    function normPh(t) {
        if (t === 'ctrTitle') return 'title';
        if (!t || t === 'body' || t === 'obj' || t === 'subTitle' || t === 'tbl' || t === 'chart' || t === 'pic' || t === 'media' || t === 'dgm' || t === 'clipArt') return 'body';
        return t;
    }
    function phInfo(sp) {
        var ph = path(sp, 'p:nvSpPr', 'p:nvPr', 'p:ph') || path(sp, 'p:nvPicPr', 'p:nvPr', 'p:ph') || path(sp, 'p:nvGraphicFramePr', 'p:nvPr', 'p:ph');
        if (!ph) return null;
        return { type: ph.getAttribute('type'), idx: ph.hasAttribute('idx') ? ph.getAttribute('idx') : null };
    }
    function treeShapes(root) {
        var tree = path(root, 'p:cSld', 'p:spTree');
        return kids(tree).filter(function (n) { return n.namespaceURI === NS_P && /^(sp|pic|grpSp|graphicFrame|cxnSp)$/.test(n.localName); });
    }
    function findPh(shapes, ph, loose) {
        if (!ph) return null;
        var i, s, p;
        if (ph.idx !== null) {
            for (i = 0; i < shapes.length; i++) { p = phInfo(shapes[i]); if (p && p.idx === ph.idx && (loose || normPh(p.type) === normPh(ph.type))) return shapes[i]; }
        }
        for (i = 0; i < shapes.length; i++) { p = phInfo(shapes[i]); if (p && normPh(p.type) === normPh(ph.type) && (ph.idx === null || p.idx === null || loose)) return shapes[i]; }
        return null;
    }

    function xfrmOf(shape) {
        var x = path(shape, 'p:spPr', 'a:xfrm') || path(shape, 'p:grpSpPr', 'a:xfrm') || path(shape, 'p:xfrm');
        if (!x) return null;
        var off = kid(x, NS_A, 'off'), ext = kid(x, NS_A, 'ext');
        if (!off || !ext) return null;
        var o = {
            x: attrNum(off, 'x', 0) / EMU, y: attrNum(off, 'y', 0) / EMU, w: attrNum(ext, 'cx', 0) / EMU, h: attrNum(ext, 'cy', 0) / EMU,
            rot: attrNum(x, 'rot', 0) / 60000, flipH: x.getAttribute('flipH') === '1', flipV: x.getAttribute('flipV') === '1'
        };
        var chOff = kid(x, NS_A, 'chOff'), chExt = kid(x, NS_A, 'chExt');
        if (chOff && chExt) { o.chX = attrNum(chOff, 'x', 0) / EMU; o.chY = attrNum(chOff, 'y', 0) / EMU; o.chW = attrNum(chExt, 'cx', 0) / EMU; o.chH = attrNum(chExt, 'cy', 0) / EMU; }
        return o;
    }

    function Ctx(deck, slide, player) {
        this.deck = deck; this.slide = slide; this.master = slide.master; this.layout = slide.layout;
        this.theme = slide.master.theme; this.clrMap = slide.master.clrMap;
        this.layoutShapes = treeShapes(slide.layout.root); this.masterShapes = treeShapes(slide.master.root);
        this.player = player; this.spMap = {}; this.pending = [];
    }
    Ctx.prototype.T = function (phClr) { return { theme: this.theme, clrMap: this.clrMap, phClr: phClr || null }; };

    // --- Văn bản: chuỗi kế thừa kiểu ---
    function lvlProps(lstStyle, lvl) {
        // trả về { pPr: attrs, defRPr: node, node: lvlNpPr }
        var n = lstStyle && path(lstStyle, 'a:lvl' + lvl + 'pPr');
        return n || null;
    }
    function mergePPr(into, n) {
        if (!n) return into;
        ['algn', 'marL', 'marR', 'indent'].forEach(function (k) { if (n.hasAttribute(k)) into[k] = n.getAttribute(k); });
        for (var c = n.firstElementChild; c; c = c.nextElementSibling) {
            if (c.localName === 'lnSpc' || c.localName === 'spcBef' || c.localName === 'spcAft') into[c.localName] = c;
            else if (/^bu(Char|AutoNum|None|Blip)$/.test(c.localName)) { into.bu = c; }
            else if (c.localName === 'buClr') into.buClr = c;
            else if (c.localName === 'buSzPct') into.buSzPct = c;
            else if (c.localName === 'buFont') into.buFont = c;
            else if (c.localName === 'defRPr') mergeRPr(into.r, c);
        }
        return into;
    }
    function mergeRPr(into, n) {
        if (!n) return into;
        ['sz', 'b', 'i', 'u', 'strike', 'baseline', 'cap', 'spc'].forEach(function (k) { if (n.hasAttribute(k)) into[k] = n.getAttribute(k); });
        for (var c = n.firstElementChild; c; c = c.nextElementSibling) {
            if (c.localName === 'solidFill') into.fill = c;
            else if (c.localName === 'latin') into.font = c.getAttribute('typeface');
            else if (c.localName === 'highlight') into.highlight = c;
        }
        return into;
    }
    function txStyleNode(master, kind) {
        var ts = path(master.root, 'p:txStyles');
        return ts && kid(ts, NS_P, kind);
    }
    /** chuỗi lstStyle áp cho 1 shape (thấp → cao) */
    Ctx.prototype.textChain = function (shape, ph) {
        var chain = [];
        var d = this.deck.defaultText; if (d) chain.push(d);
        if (ph) {
            var t = normPh(ph.type);
            chain.push(txStyleNode(this.master, t === 'title' ? 'titleStyle' : t === 'body' ? 'bodyStyle' : 'otherStyle'));
            var lp = findPh(this.layoutShapes, ph, false), mp = findPh(this.masterShapes, { type: ph.type, idx: null }, false);
            if (mp) chain.push(path(mp, 'p:txBody', 'a:lstStyle'));
            if (lp) chain.push(path(lp, 'p:txBody', 'a:lstStyle'));
        }
        chain.push(path(shape, 'p:txBody', 'a:lstStyle'));
        return chain.filter(Boolean);
    };

    Ctx.prototype.paraProps = function (chain, lvl, pPr, fontRefColor) {
        var out = { r: {} };
        chain.forEach(function (ls, i) {
            // màu chữ theo p:style/fontRef của hình (vd. chữ trắng trong hình có nền) thắng mặc định của presentation, nhưng thua cấu hình riêng của hình/đoạn/run
            if (fontRefColor && i === chain.length - 1) delete out.r.fill;
            mergePPr(out, lvlProps(ls, lvl));
        });
        if (fontRefColor && chain.length === 0) delete out.r.fill;
        if (pPr) mergePPr(out, pPr);
        out.fontRefColor = fontRefColor || null;
        return out;
    };

    Ctx.prototype.fontFamily = function (name) {
        var th = this.theme;
        if (!name) name = th.minor;
        if (name === '+mj-lt') name = th.major; else if (name === '+mn-lt') name = th.minor;
        if (!name || name.charAt(0) === '+') name = th.minor || 'Calibri';
        return '"' + name.replace(/"/g, '') + '", Calibri, "Segoe UI", Arial, sans-serif';
    };

    Ctx.prototype.styleRefColor = function (shape, which) {
        var st = kid(shape, NS_P, 'style'); if (!st) return null;
        var ref = kid(st, NS_A, which); if (!ref) return null;
        return readColor(ref, this.T());
    };

    Ctx.prototype.renderText = function (shape, box, ph, opts) {
        var tb = kid(shape, NS_P, 'txBody') || kid(shape, NS_A, 'txBody');
        var lp = ph ? findPh(this.layoutShapes, ph, false) : null, mp = ph ? findPh(this.masterShapes, { type: ph.type, idx: null }, false) : null;
        var bodyPr = (tb && kid(tb, NS_A, 'bodyPr')) || null;
        function bp(attr, def) {
            var srcs = [bodyPr, lp && path(lp, 'p:txBody', 'a:bodyPr'), mp && path(mp, 'p:txBody', 'a:bodyPr')];
            for (var i = 0; i < srcs.length; i++) if (srcs[i] && srcs[i].hasAttribute(attr)) return srcs[i].getAttribute(attr);
            return def;
        }
        if (!tb) return null;
        var paras = kids(tb, NS_A, 'p');
        var chain = this.textChain(shape, ph);
        var fontRefColor = this.styleRefColor(shape, 'fontRef');
        var fs = 1;
        var af = bodyPr && kid(bodyPr, NS_A, 'normAutofit');
        // normAutofit có thể kế thừa từ layout/master (PowerPoint tự co chữ cho vừa khung)
        var autoShrink = false;
        [bodyPr, lp && path(lp, 'p:txBody', 'a:bodyPr'), mp && path(mp, 'p:txBody', 'a:bodyPr')].some(function (src) {
            if (!src) return false;
            if (kid(src, NS_A, 'normAutofit')) { autoShrink = true; return true; }
            if (kid(src, NS_A, 'noAutofit') || kid(src, NS_A, 'spAutoFit')) return true;
            return false;
        });
        // Khung nội dung (không phải tiêu đề/số trang/ngày/chân trang) cũng tự co khi chữ tràn — dù file không bật autofit. Tiêu đề giữ nguyên.
        if (ph && !/^(title|ctrTitle|subTitle|sldNum|dt|ftr)$/.test(ph.type || '')) autoShrink = true;
        if (af && af.hasAttribute('fontScale')) fs = num(af.getAttribute('fontScale'), 100000) / 100000;
        var lnRed = af && af.hasAttribute('lnSpcReduction') ? num(af.getAttribute('lnSpcReduction'), 0) / 100000 : 0;

        var wrap = document.createElement('div');
        wrap.className = 'pp-text';
        if (autoShrink) wrap.setAttribute('data-autofit', '1');
        // mọi khung chữ (trừ tiêu đề / số trang / ngày / chân trang) chỉnh được cỡ chữ bằng A− / A+, kể cả slide thiết kế sẵn không có placeholder
        if (!(ph && /^(title|ctrTitle|sldNum|dt|ftr)$/.test(ph.type || ''))) wrap.setAttribute('data-ts', '1');
        var L = num(bp('lIns', 91440), 91440) / EMU, T = num(bp('tIns', 45720), 45720) / EMU, R = num(bp('rIns', 91440), 91440) / EMU, B = num(bp('bIns', 45720), 45720) / EMU;
        var anchor = bp('anchor', 't');
        var st = wrap.style;
        st.position = 'absolute'; st.left = '0'; st.top = '0'; st.width = box.w + 'px'; st.height = box.h + 'px';
        st.boxSizing = 'border-box'; st.padding = T + 'px ' + R + 'px ' + B + 'px ' + L + 'px';
        st.display = 'flex'; st.flexDirection = 'column';
        st.justifyContent = anchor === 'ctr' ? 'center' : anchor === 'b' ? 'flex-end' : 'flex-start';
        var vert = bp('vert', 'horz');
        if (vert === 'vert' || vert === 'eaVert') { st.writingMode = 'vertical-rl'; }
        else if (vert === 'vert270') { st.writingMode = 'vertical-rl'; st.transform = 'rotate(180deg)'; }
        if (bp('wrap', 'square') === 'none') st.whiteSpace = 'nowrap';
        var self = this, autoNum = {};

        paras.forEach(function (p, pi) {
            var pPr = kid(p, NS_A, 'pPr');
            var lvl = (pPr && pPr.hasAttribute('lvl') ? num(pPr.getAttribute('lvl'), 0) : 0) + 1;
            var pp = self.paraProps(chain, lvl, pPr, fontRefColor);
            var div = document.createElement('div');
            div.className = 'pp-p'; div.setAttribute('data-p', String(pi));
            var ds = div.style;
            ds.margin = '0'; ds.minHeight = '1em'; ds.flexShrink = '0'; ds.wordBreak = 'break-word'; ds.overflowWrap = 'anywhere';
            var algn = pp.algn || 'l';
            ds.textAlign = algn === 'ctr' ? 'center' : algn === 'r' ? 'right' : algn === 'just' ? 'justify' : 'left';
            var marL = num(pp.marL, 0) / EMU, indent = num(pp.indent, 0) / EMU;
            ds.paddingLeft = marL + 'px'; ds.textIndent = indent + 'px';
            var baseSz = pp.r.sz ? num(pp.r.sz, 1800) / 100 : 18;
            // khoảng cách
            function spc(n) { if (!n) return 0; var pc = path(n, 'a:spcPct'), pt = path(n, 'a:spcPts'); return pc ? { pct: num(pc.getAttribute('val'), 0) / 100000 } : pt ? { px: num(pt.getAttribute('val'), 0) / 100 * PT } : 0; }
            var sb = spc(pp.spcBef), sa = spc(pp.spcAft), ls = spc(pp.lnSpc);
            ds.marginTop = pi === 0 ? '0' : (sb ? (sb.px !== undefined ? sb.px : sb.pct * baseSz * fs * PT * 1.2) : 0) + 'px';
            ds.marginBottom = (sa ? (sa.px !== undefined ? sa.px : sa.pct * baseSz * fs * PT * 1.2) : 0) + 'px';
            ds.lineHeight = ls ? (ls.px !== undefined ? ls.px + 'px' : Math.max(0.5, (ls.pct - lnRed)) * 1.2) : (1.2 - lnRed * 1.2);

            // bullet
            var buNode = pp.bu, hasText = false, bulletText = '', symbolFont = false;
            var runs = [];
            kids(p).forEach(function (c) { if (/^(r|br|fld)$/.test(c.localName)) runs.push(c); });
            runs.forEach(function (r) { if (r.localName !== 'br' && (path(r, 'a:t') || {}).textContent) hasText = true; });
            if (buNode && buNode.localName === 'buChar' && hasText) {
                bulletText = buNode.getAttribute('char') || '•';
                var symFont = pp.buFont && pp.buFont.getAttribute('typeface'), symCh = symbolBullet(symFont, bulletText);
                if (symCh) { bulletText = symCh; symbolFont = true; }
            }
            else if (buNode && buNode.localName === 'buAutoNum' && hasText) {
                autoNum[lvl] = (autoNum[lvl] || 0) + 1;
                for (var k in autoNum) if (+k > lvl) autoNum[k] = 0;
                var type = buNode.getAttribute('type') || 'arabicPeriod', n = autoNum[lvl] + (num(buNode.getAttribute('startAt'), 1) - 1);
                bulletText = (/alpha/i.test(type) ? String.fromCharCode(96 + ((n - 1) % 26) + 1) : /roman/i.test(type) ? ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'][(n - 1) % 10] : String(n)) + (/Paren/.test(type) ? ')' : /Period/.test(type) ? '.' : '');
                if (/UcAlpha|UcRoman/.test(type)) bulletText = bulletText.toUpperCase();
            }
            else if (!buNode || buNode.localName === 'buNone') { /* không bullet */ }
            if (hasText && !(buNode && /^bu(Char|AutoNum)$/.test(buNode.localName))) autoNum[lvl] = 0;

            function runStyle(el, rp) {
                var s = el.style;
                var sz = (rp.sz ? num(rp.sz, 1800) / 100 : 18) * fs;
                s.fontSize = (sz * PT) + 'px';
                if (rp.b === '1') s.fontWeight = '700';
                if (rp.i === '1') s.fontStyle = 'italic';
                var deco = [];
                if (rp.u && rp.u !== 'none') deco.push('underline');
                if (rp.strike && rp.strike !== 'noStrike') deco.push('line-through');
                if (deco.length) s.textDecoration = deco.join(' ');
                if (rp.cap === 'all') s.textTransform = 'uppercase'; else if (rp.cap === 'small') s.fontVariant = 'small-caps';
                if (rp.spc) s.letterSpacing = (num(rp.spc, 0) / 100 * PT) + 'px';
                if (rp.baseline) { var bl = num(rp.baseline, 0); if (bl) { s.verticalAlign = bl > 0 ? 'super' : 'sub'; s.fontSize = (sz * PT * 0.66) + 'px'; } }
                var col = rp.fill ? readColor(rp.fill, self.T()) : (pp.fontRefColor || null);
                if (!col) col = readColor({ localName: 'schemeClr', firstElementChild: null, getAttribute: function () { return 'tx1'; }, hasAttribute: function () { return true; } }, self.T());
                s.color = css(col);
                s.fontFamily = self.fontFamily(rp.font);
                if (rp.highlight) s.backgroundColor = css(readColor(rp.highlight, self.T()));
            }

            if (bulletText) {
                var bu = document.createElement('span');
                bu.textContent = bulletText;
                var bw = indent < 0 ? -indent : 0;
                bu.style.display = 'inline-block'; bu.style.width = bw ? bw + 'px' : 'auto'; bu.style.textIndent = '0';
                if (!bw) bu.style.marginRight = '0.4em';
                var brp = JSON.parse(JSON.stringify({ sz: pp.r.sz, font: null })); brp.fill = pp.buClr || pp.r.fill; brp.b = null;
                runStyle(bu, brp);
                if (symbolFont) bu.style.fontFamily = '"Segoe UI Symbol", "Noto Sans Symbols2", "Noto Sans Symbols", "DejaVu Sans", Arial, sans-serif';
                else if (pp.buFont && pp.buFont.getAttribute('typeface') && !/^\+/.test(pp.buFont.getAttribute('typeface'))) bu.style.fontFamily = '"' + pp.buFont.getAttribute('typeface') + '", Arial, sans-serif';
                if (pp.buSzPct) bu.style.fontSize = (parseFloat(bu.style.fontSize) * num(pp.buSzPct.getAttribute('val'), 100000) / 100000) + 'px';
                div.appendChild(bu);
            }
            var any = false;
            runs.forEach(function (r) {
                if (r.localName === 'br') { div.appendChild(document.createElement('br')); any = true; return; }
                var rp = {}; for (var kk in pp.r) rp[kk] = pp.r[kk];
                mergeRPr(rp, kid(r, NS_A, 'rPr'));
                var span = document.createElement('span');
                var t = (path(r, 'a:t') || {}).textContent || '';
                if (r.localName === 'fld' && /slidenum/i.test(r.getAttribute('type') || '')) t = String(self.slide.number);
                span.textContent = t; span.style.whiteSpace = 'pre-wrap';
                runStyle(span, rp);
                var hl = kid(kid(r, NS_A, 'rPr'), NS_A, 'hlinkClick');
                if (hl) {                                           // ★ chữ có liên kết ngoài: bấm mở tab mới
                    var hrel = self.slideRels && self.slideRels[hl.getAttributeNS(NS_R, 'id')];
                    if (hrel && /^https?:\/\//i.test(hrel.target)) {
                        span.style.cursor = 'pointer'; span.title = 'Mở liên kết: ' + hrel.target;
                        span.addEventListener('click', function (e) { e.stopPropagation(); window.open(hrel.target, '_blank', 'noopener,noreferrer'); });
                    }
                }
                div.appendChild(span); any = true;
            });
            if (!any) {                          // đoạn trống: giữ chiều cao theo endParaRPr
                var rp2 = {}; for (var k2 in pp.r) rp2[k2] = pp.r[k2];
                mergeRPr(rp2, kid(p, NS_A, 'endParaRPr'));
                var sp = document.createElement('span'); sp.innerHTML = '&nbsp;'; runStyle(sp, rp2); div.appendChild(sp);
            }
            wrap.appendChild(div);
        });
        return wrap;
    };


    // ------------------------------------------------------------
    // Bullet dùng font ký hiệu (Wingdings, Wingdings 2/3, Symbol, Webdings): trình duyệt không có các font này nên
    // ký tự gốc ("q", "Ø", "§"…) hiện nguyên chữ. Đổi sang ký tự Unicode tương ứng.
    // ------------------------------------------------------------
    var SYMBOL_BULLETS = {
        wingdings: { 'l': '\u25CF', 'm': '\u274D', 'n': '\u25A0', 'o': '\u25A1', 'p': '\u25A1', 'q': '\u2751', 'r': '\u2752', 's': '\u2B27', 't': '\u29EB', 'u': '\u25C6', 'v': '\u2756', 'w': '\u2B25', 'x': '\u2327',
            '\u00A7': '\u25AA', '\u00A1': '\u25CB', '\u00A8': '\u25FB', '\u00D8': '\u27A2', '\u00DE': '\u21E8', '\u00E8': '\u2794', '\u00E0': '\u2794', '\u00FC': '\u2713', '\u00FB': '\u2717', '\u00FD': '\u2612', '\u00FE': '\u2611',
            'J': '\u263A', 'K': '\uD83D\uDE10', 'L': '\u2639', 'F': '\u2691', 'N': '\u2620', 'P': '\u2756', '\u00B7': '\u2022', '\u00AB': '\u2605', '\u00AC': '\u2606', 'S': '\u2744', 'T': '\u271E', '\u00D5': '\u21E8' },
        wingdings2: { 'P': '\u25CF', 'Q': '\u25CB', 'R': '\u25A0', 'S': '\u25A1', '\u00A3': '\u25CF', '\u00A4': '\u25C9', '\u00A5': '\u25CE', '\u00AB': '\u2605', '\u00AC': '\u2606', '\u00F8': '\u2714', '\u00FC': '\u2714', '\u00FB': '\u2718', '\u00FE': '\u2611', '\u00FD': '\u2612' },
        wingdings3: { 'p': '\u25B2', 'q': '\u25BC', 'u': '\u25B6', 't': '\u25C0', '\u00A7': '\u25B6', '\u00D8': '\u25B6', '\u0075': '\u25B6', '\u0076': '\u25C0', 'f': '\u25B6', 'g': '\u25C0' },
        symbol: { '\u00B7': '\u2022', '\u00A8': '\u2666', '\u00D8': '\u2205', '-': '\u2013', '\u00DE': '\u21D2', '\u00AE': '\u2192', '\u00B0': '\u00B0', 'o': '\u25CB', '\u00A7': '\u2663' },
        webdings: { 'i': '\u25CF', 'g': '\u25CF', '4': '\u25B6', '3': '\u25C0', 'a': '\u2713', '\u00FC': '\u2713' }
    };
    function symbolBullet(font, ch) {
        var key = String(font || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!/^(wingdings[23]?|symbol|webdings)$/.test(key)) return null;
        var code = ch ? ch.charCodeAt(0) : 0;
        if (code >= 0xF000 && code <= 0xF0FF) ch = String.fromCharCode(code - 0xF000);   // PowerPoint hay lưu ký hiệu ở vùng riêng U+F0xx
        var map = SYMBOL_BULLETS[key] || {};
        return map[ch] || (ch && ch.charCodeAt(0) > 0x2000 ? ch : '\u2022');
    }

    // --- Hình học ---
    function polyPoints(prst, w, h, adj) {
        var P = function (arr) { return arr.map(function (p) { return (p[0] * w) + ',' + (p[1] * h); }).join(' '); };
        var a = adj || {};
        switch (prst) {
            case 'triangle': return P([[0.5, 0], [1, 1], [0, 1]]);
            case 'rtTriangle': return P([[0, 0], [1, 1], [0, 1]]);
            case 'diamond': case 'flowChartDecision': return P([[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]);
            case 'parallelogram': return P([[0.25, 0], [1, 0], [0.75, 1], [0, 1]]);
            case 'trapezoid': return P([[0.2, 0], [0.8, 0], [1, 1], [0, 1]]);
            case 'pentagon': case 'regularPentagon': return P([[0.5, 0], [1, 0.38], [0.81, 1], [0.19, 1], [0, 0.38]]);
            case 'hexagon': return P([[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]]);
            case 'octagon': return P([[0.29, 0], [0.71, 0], [1, 0.29], [1, 0.71], [0.71, 1], [0.29, 1], [0, 0.71], [0, 0.29]]);
            case 'homePlate': return P([[0, 0], [0.8, 0], [1, 0.5], [0.8, 1], [0, 1]]);
            case 'chevron': return P([[0, 0], [0.7, 0], [1, 0.5], [0.7, 1], [0, 1], [0.3, 0.5]]);
            case 'rightArrow': return P([[0, 0.25], [0.6, 0.25], [0.6, 0], [1, 0.5], [0.6, 1], [0.6, 0.75], [0, 0.75]]);
            case 'leftArrow': return P([[1, 0.25], [0.4, 0.25], [0.4, 0], [0, 0.5], [0.4, 1], [0.4, 0.75], [1, 0.75]]);
            case 'upArrow': return P([[0.25, 1], [0.25, 0.4], [0, 0.4], [0.5, 0], [1, 0.4], [0.75, 0.4], [0.75, 1]]);
            case 'downArrow': return P([[0.25, 0], [0.75, 0], [0.75, 0.6], [1, 0.6], [0.5, 1], [0, 0.6], [0.25, 0.6]]);
            case 'plus': case 'mathPlus': return P([[0.33, 0], [0.67, 0], [0.67, 0.33], [1, 0.33], [1, 0.67], [0.67, 0.67], [0.67, 1], [0.33, 1], [0.33, 0.67], [0, 0.67], [0, 0.33], [0.33, 0.33]]);
            case 'star4': return P([[0.5, 0], [0.62, 0.38], [1, 0.5], [0.62, 0.62], [0.5, 1], [0.38, 0.62], [0, 0.5], [0.38, 0.38]]);
            case 'star5': return P([[0.5, 0], [0.62, 0.38], [1, 0.38], [0.69, 0.62], [0.81, 1], [0.5, 0.77], [0.19, 1], [0.31, 0.62], [0, 0.38], [0.38, 0.38]]);
            case 'flowChartPreparation': return P([[0.2, 0], [0.8, 0], [1, 0.5], [0.8, 1], [0.2, 1], [0, 0.5]]);
            case 'flowChartInputOutput': return P([[0.2, 0], [1, 0], [0.8, 1], [0, 1]]);
            case 'flowChartManualOperation': return P([[0, 0], [1, 0], [0.8, 1], [0.2, 1]]);
            case 'flowChartMerge': return P([[0, 0], [1, 0], [0.5, 1]]);
            case 'flowChartExtract': return P([[0.5, 0], [1, 1], [0, 1]]);
            case 'flowChartTerminator': return null;
            default: return undefined;
        }
    }
    function roundRectPath(w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        return 'M' + r + ',0 H' + (w - r) + ' A' + r + ',' + r + ' 0 0 1 ' + w + ',' + r + ' V' + (h - r) + ' A' + r + ',' + r + ' 0 0 1 ' + (w - r) + ',' + h + ' H' + r + ' A' + r + ',' + r + ' 0 0 1 0,' + (h - r) + ' V' + r + ' A' + r + ',' + r + ' 0 0 1 ' + r + ',0 Z';
    }
    function custGeomPath(cg, w, h) {
        var out = [];
        kids(path(cg, 'a:pathLst'), NS_A, 'path').forEach(function (p) {
            var pw = attrNum(p, 'w', 0) || w, ph = attrNum(p, 'h', 0) || h;
            var sx = w / pw, sy = h / ph, d = '';
            function pt(n) { return (attrNum(n, 'x', 0) * sx) + ',' + (attrNum(n, 'y', 0) * sy); }
            kids(p).forEach(function (c) {
                var pts = kids(c, NS_A, 'pt');
                if (c.localName === 'moveTo') d += 'M' + pt(pts[0]) + ' ';
                else if (c.localName === 'lnTo') d += 'L' + pt(pts[0]) + ' ';
                else if (c.localName === 'cubicBezTo') d += 'C' + pts.map(pt).join(' ') + ' ';
                else if (c.localName === 'quadBezTo') d += 'Q' + pts.map(pt).join(' ') + ' ';
                else if (c.localName === 'close') d += 'Z ';
            });
            out.push({ d: d, fill: p.getAttribute('fill') !== 'none', stroke: p.getAttribute('stroke') !== '0' });
        });
        return out;
    }

    Ctx.prototype.fillSpec = function (spPr, shape, ph, defs) {
        // trả về { kind:'none' } | { kind:'solid', c } | { kind:'grad', id }
        var self = this;
        function fromNode(n) {
            if (!n) return null;
            switch (n.localName) {
                case 'noFill': return { kind: 'none' };
                case 'solidFill': return { kind: 'solid', c: readColor(n, self.T()) };
                case 'gradFill': return self.gradient(n, defs, null);
                case 'pattFill': return { kind: 'solid', c: readColor(kid(n, NS_A, 'fgClr'), self.T()) };
                case 'blipFill': return self.blipFill(n);       // ★ ảnh làm nền shape (Google Slides xuất ảnh dạng này) — trước đây bị vẽ thành ô xám
                case 'grpFill': return null;
            }
            return null;
        }
        var order = [spPr];
        if (ph) {
            var lp = findPh(this.layoutShapes, ph, false), mp = findPh(this.masterShapes, { type: ph.type, idx: null }, false);
            if (lp) order.push(kid(lp, NS_P, 'spPr')); if (mp) order.push(kid(mp, NS_P, 'spPr'));
        }
        for (var i = 0; i < order.length; i++) {
            var sp = order[i]; if (!sp) continue;
            for (var c = sp.firstElementChild; c; c = c.nextElementSibling) {
                if (/^(noFill|solidFill|gradFill|pattFill|blipFill|grpFill)$/.test(c.localName)) { var r = fromNode(c); if (r) return r; }
            }
        }
        // theo p:style > a:fillRef
        var st = kid(shape, NS_P, 'style'), fr = st && kid(st, NS_A, 'fillRef');
        if (fr) {
            var idx = num(fr.getAttribute('idx'), 0);
            if (idx === 0) return { kind: 'none' };
            var ph2 = readColor(fr, this.T());
            var style = this.theme.fills[idx - 1];
            if (style && style.localName === 'solidFill') return { kind: 'solid', c: readColor(style, this.T(ph2)) };
            if (style && style.localName === 'gradFill') return this.gradient(style, defs, ph2);
            return ph2 ? { kind: 'solid', c: ph2 } : null;
        }
        return { kind: 'none' };
    };

    /** Đọc <a:blipFill> của shape: ảnh (rel), phần cắt (srcRect) và độ trong (alphaModFix). Tìm rel theo phần chứa nút (slide/layout/master). */
    Ctx.prototype.blipFill = function (n) {
        var blip = kid(n, NS_A, 'blip'), rid = blip && blip.getAttributeNS(NS_R, 'embed');
        var doc = n.ownerDocument, rels = null;
        if (doc === this.slide.root.ownerDocument) rels = this.slideRels;
        else if (doc === this.layout.root.ownerDocument) rels = this.layout.rels;
        else if (doc === this.master.root.ownerDocument) rels = this.master.rels;
        var sr = kid(n, NS_A, 'srcRect'), am = blip && kid(blip, NS_A, 'alphaModFix');
        function g(a) { return sr ? attrNum(sr, a, 0) / 100000 : 0; }
        return { kind: 'blip', rel: (rels && rid && rels[rid]) || null, l: g('l'), t: g('t'), r: g('r'), b: g('b'), alpha: am ? attrNum(am, 'amt', 100000) / 100000 : 1 };
    };
    /** Biến blipFill thành <pattern> SVG phủ đúng khung shape (stretch + cắt srcRect); ảnh nạp bất đồng bộ qua pending. */
    Ctx.prototype.blipPattern = function (f, defs, w, h) {
        if (!f.rel) return { kind: 'none' };
        var id = 'ppi' + (++gradSeq);
        var iw = Math.max(1 - f.l - f.r, 0.01), ih = Math.max(1 - f.t - f.b, 0.01);
        var pat = svgEl('pattern', { id: id, patternUnits: 'userSpaceOnUse', x: 0, y: 0, width: w, height: h });
        var im = svgEl('image', { x: -f.l / iw * w, y: -f.t / ih * h, width: w / iw, height: h / ih, preserveAspectRatio: 'none' });
        if (f.alpha < 1) im.setAttribute('opacity', f.alpha);
        pat.appendChild(im); defs.appendChild(pat);
        this.pending.push(this.deck.zip.blobUrl(f.rel.target).then(function (u) {
            if (u) { im.setAttribute('href', u); im.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', u); }
        }));
        return { kind: 'pat', id: id };
    };

    Ctx.prototype.gradient = function (n, defs, phClr) {
        var self = this, id = 'ppg' + (++gradSeq);
        var stops = kids(kid(n, NS_A, 'gsLst'), NS_A, 'gs');
        if (!stops.length) return { kind: 'none' };
        var lin = kid(n, NS_A, 'lin'), pathN = kid(n, NS_A, 'path');
        var g;
        if (pathN) g = svgEl('radialGradient', { id: id, cx: '50%', cy: '50%', r: '70%' });
        else {
            var ang = lin ? attrNum(lin, 'ang', 0) / 60000 : 90, rad = ang * Math.PI / 180;
            var x = Math.cos(rad) / 2, y = Math.sin(rad) / 2;
            g = svgEl('linearGradient', { id: id, x1: (50 - x * 100) + '%', y1: (50 - y * 100) + '%', x2: (50 + x * 100) + '%', y2: (50 + y * 100) + '%' });
        }
        stops.forEach(function (s) {
            var c = readColor(s, self.T(phClr));
            g.appendChild(svgEl('stop', { offset: (attrNum(s, 'pos', 0) / 1000) + '%', 'stop-color': 'rgb(' + c.rgb.join(',') + ')', 'stop-opacity': String(c.a) }));
        });
        defs.appendChild(g);
        return { kind: 'grad', id: id };
    };

    Ctx.prototype.lineSpec = function (spPr, shape, defs) {
        var ln = spPr && kid(spPr, NS_A, 'ln'), self = this;
        var w = null, c = null, dash = null, none = false, head = null, tail = null, headSz = null, tailSz = null;
        function applyLn(l) {
            if (!l) return;
            if (l.hasAttribute('w')) w = attrNum(l, 'w', 0) / EMU;
            var nf = kid(l, NS_A, 'noFill'), sf = kid(l, NS_A, 'solidFill'), gf = kid(l, NS_A, 'gradFill');
            if (nf) none = true;
            if (sf) { c = readColor(sf, self.T()); none = false; }
            if (gf) { var g = kid(kid(gf, NS_A, 'gsLst'), NS_A, 'gs'); if (g) { c = readColor(g, self.T()); none = false; } }
            var pd = kid(l, NS_A, 'prstDash'); if (pd) dash = pd.getAttribute('val');
            var he = kid(l, NS_A, 'headEnd'), te = kid(l, NS_A, 'tailEnd');
            if (he && he.getAttribute('type') && he.getAttribute('type') !== 'none') { head = he.getAttribute('type'); headSz = { w: he.getAttribute('w') || 'med', l: he.getAttribute('len') || 'med' }; }
            if (te && te.getAttribute('type') && te.getAttribute('type') !== 'none') { tail = te.getAttribute('type'); tailSz = { w: te.getAttribute('w') || 'med', l: te.getAttribute('len') || 'med' }; }
        }
        var st = kid(shape, NS_P, 'style'), lr = st && kid(st, NS_A, 'lnRef');
        if (lr) {
            var idx = num(lr.getAttribute('idx'), 0);
            if (idx > 0) {
                var base = this.theme.lines[idx - 1];
                var pc = readColor(lr, this.T());
                if (base) { w = attrNum(base, 'w', 9525) / EMU; var sf0 = kid(base, NS_A, 'solidFill'); c = sf0 ? readColor(sf0, this.T(pc)) : pc; }
                else { c = pc; w = 1; }
            } else none = true;
        }
        applyLn(ln);
        // ⚠️ ĐỪNG SỬA LẠI (lỗi viền đen quanh mọi khung chữ, đã sửa 2026-11-12):
        // PPTX do html2pptx/pptxgenjs tạo ra ghi `<a:ln/>` RỖNG (không màu, không <a:noFill/>, không <p:style>) cho hộp chữ/hình.
        // Theo chuẩn OOXML + PowerPoint, `<a:ln/>` rỗng = KHÔNG CÓ VIỀN. Bản cũ chỉ `return null` khi `!c && !ln`
        // rồi gán màu ĐEN mặc định khi `!c` → mọi khung chữ bị viền đen (chồng nhãn 2|3, 7|8, 16|17 trên biểu đồ Gantt, khung tiêu đề, đề bài…).
        // Quy tắc: chỉ vẽ viền khi CÓ MÀU thật (từ <a:ln><a:solidFill|gradFill> hoặc <p:style><a:lnRef idx>0). Không có màu → null. KHÔNG tự thêm màu đen.
        if (none || !c) return null;
        return { w: w === null ? 1 : Math.max(w, 0.5), c: c, dash: dash, head: head, tail: tail, headSz: headSz, tailSz: tailSz };
    };

    var DASH = { dash: '6 3', sysDash: '3 2', dot: '1.5 2', sysDot: '1.5 1.5', lgDash: '9 4', dashDot: '6 3 1.5 3', lgDashDot: '9 4 1.5 4', lgDashDotDot: '9 4 1.5 4 1.5 4' };

    Ctx.prototype.shapeGeometry = function (shape, box, ph, isLine) {
        var spPr = kid(shape, NS_P, 'spPr');
        var w = Math.max(box.w, 0.01), h = Math.max(box.h, 0.01);
        var pg0 = spPr && kid(spPr, NS_A, 'prstGeom'), prst0 = pg0 ? pg0.getAttribute('prst') : '';
        var lineish = isLine || /^(line|straightConnector1|bentConnector[2-5]|curvedConnector[2-5]|lineInv)$/.test(prst0);
        // Đường nối thẳng đứng/nằm ngang có cx hoặc cy = 0: svg rộng 0.01px bị Chromium bỏ qua → không thấy đường. Cho khung svg ≥ 1px, nét vẫn vẽ đúng toạ độ cũ.
        var sw = lineish ? Math.max(w, 1) : w, sh = lineish ? Math.max(h, 1) : h;
        var svg = svgEl('svg', { width: sw, height: sh, viewBox: '0 0 ' + sw + ' ' + sh });
        svg.style.cssText = 'position:absolute;left:0;top:0;overflow:visible';
        var defs = svgEl('defs', {}); svg.appendChild(defs);
        var fill = this.fillSpec(spPr, shape, ph, defs), line = this.lineSpec(spPr, shape, defs);
        if (fill && fill.kind === 'blip') fill = this.blipPattern(fill, defs, w, h);
        var cg = spPr && kid(spPr, NS_A, 'custGeom'), pg = spPr && kid(spPr, NS_A, 'prstGeom');
        var prst = pg ? pg.getAttribute('prst') : (cg ? 'custom' : 'rect');
        var adjNode = pg && kid(kid(pg, NS_A, 'avLst'), NS_A, 'gd');
        var adj1 = adjNode ? num((adjNode.getAttribute('fmla') || '').replace(/[^0-9-]/g, ''), null) : null;
        var adjN = {};   // adj1, adj2, adj3 theo tên (đường nối gấp khúc cần nhiều tham số)
        if (pg) kids(kid(pg, NS_A, 'avLst'), NS_A, 'gd').forEach(function (gd) { adjN[gd.getAttribute('name')] = num((gd.getAttribute('fmla') || '').replace(/[^0-9-]/g, ''), null); });
        var fillAttr = fill && fill.kind === 'solid' ? 'rgb(' + fill.c.rgb.join(',') + ')' : fill && (fill.kind === 'grad' || fill.kind === 'pat') ? 'url(#' + fill.id + ')' : 'none';
        var fillOp = fill && fill.kind === 'solid' ? fill.c.a : 1;
        var common = { fill: fillAttr, 'fill-opacity': fillOp };
        if (line) { common.stroke = 'rgb(' + line.c.rgb.join(',') + ')'; common['stroke-opacity'] = line.c.a; common['stroke-width'] = line.w; if (line.dash && DASH[line.dash]) common['stroke-dasharray'] = DASH[line.dash]; common['stroke-linejoin'] = 'round'; }
        else common.stroke = 'none';

        var el = null;
        if (cg) {
            custGeomPath(cg, w, h).forEach(function (p) {
                var e = svgEl('path', Object.assign({}, common, { d: p.d })); if (!p.fill) e.setAttribute('fill', 'none'); if (!p.stroke) e.setAttribute('stroke', 'none'); svg.appendChild(e);
            });
        } else if (isLine || /^(line|straightConnector1|bentConnector[2-5]|curvedConnector[2-5]|lineInv)$/.test(prst)) {
            var ln2 = line || { w: 1, c: { rgb: [0, 0, 0], a: 1 } };
            var seg = null;
            if (prst === 'bentConnector2') seg = 'M0,0 L' + w + ',0 L' + w + ',' + h;
            else if (prst === 'bentConnector3') { var ax = w * (adj1 !== null ? adj1 : 50000) / 100000; seg = 'M0,0 L' + ax + ',0 L' + ax + ',' + h + ' L' + w + ',' + h; }
            else if (prst === 'bentConnector4') {
                var bx1 = w * (adjN.adj1 != null ? adjN.adj1 : 50000) / 100000, by2 = h * (adjN.adj2 != null ? adjN.adj2 : 50000) / 100000;
                seg = 'M0,0 L' + bx1 + ',0 L' + bx1 + ',' + by2 + ' L' + w + ',' + by2 + ' L' + w + ',' + h;
            } else if (prst === 'bentConnector5') {
                var cx1 = w * (adjN.adj1 != null ? adjN.adj1 : 50000) / 100000, cy2 = h * (adjN.adj2 != null ? adjN.adj2 : 50000) / 100000, cx3 = w * (adjN.adj3 != null ? adjN.adj3 : 50000) / 100000;
                seg = 'M0,0 L' + cx1 + ',0 L' + cx1 + ',' + cy2 + ' L' + cx3 + ',' + cy2 + ' L' + cx3 + ',' + h + ' L' + w + ',' + h;
            }
            var lAttrs = { stroke: 'rgb(' + ln2.c.rgb.join(',') + ')', 'stroke-opacity': ln2.c.a, 'stroke-width': ln2.w };
            var l = seg ? svgEl('path', Object.assign({ d: seg, fill: 'none', 'stroke-linejoin': 'miter' }, lAttrs)) : svgEl('line', Object.assign({ x1: 0, y1: 0, x2: w, y2: h }, lAttrs));
            if (ln2.dash && DASH[ln2.dash]) l.setAttribute('stroke-dasharray', DASH[ln2.dash]);
            var mid = 'ppm' + (++gradSeq);
            // Cỡ mũi tên theo PowerPoint: sm=2, med=3, lg=5 × bề dày nét (nét mỏng hơn 2pt vẫn tính như 2pt). Trước đây = 8 × bề dày → to gấp ~2,7 lần.
            var ARROW = { sm: 2, med: 3, lg: 5 }, abase = Math.max(ln2.w, 2.67);
            function marker(type, atEnd, sz) {
                var mw = (ARROW[sz && sz.w] || 3) * abase, ml = (ARROW[sz && sz.l] || 3) * abase;
                var m = svgEl('marker', { id: mid + (atEnd ? 't' : 'h'), viewBox: '0 0 8 8', preserveAspectRatio: 'none', markerWidth: ml, markerHeight: mw, refX: 6, refY: 4, orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse' });
                m.appendChild(svgEl('path', { d: type === 'oval' ? 'M1,4 a3,3 0 1,0 6,0 a3,3 0 1,0 -6,0' : 'M0,0 L8,4 L0,8 Z', fill: 'rgb(' + ln2.c.rgb.join(',') + ')' }));
                defs.appendChild(m); return 'url(#' + mid + (atEnd ? 't' : 'h') + ')';
            }
            if (ln2.tail) l.setAttribute('marker-end', marker(ln2.tail, true, ln2.tailSz));
            if (ln2.head) l.setAttribute('marker-start', marker(ln2.head, false, ln2.headSz));
            svg.appendChild(l);
        } else if (prst === 'ellipse' || prst === 'flowChartConnector') {
            svg.appendChild(svgEl('ellipse', Object.assign({}, common, { cx: w / 2, cy: h / 2, rx: w / 2, ry: h / 2 })));
        } else if (prst === 'roundRect' || prst === 'flowChartTerminator' || prst === 'round2SameRect' || prst === 'round1Rect' || prst === 'snipRoundRect') {
            var r = prst === 'flowChartTerminator' ? Math.min(w, h) / 2 : Math.min(w, h) * (adj1 !== null ? adj1 : 16667) / 100000;
            svg.appendChild(svgEl('path', Object.assign({}, common, { d: roundRectPath(w, h, r) })));
        } else {
            var pts = polyPoints(prst, w, h);
            if (pts) svg.appendChild(svgEl('polygon', Object.assign({}, common, { points: pts })));
            else svg.appendChild(svgEl('rect', Object.assign({}, common, { x: 0, y: 0, width: w, height: h })));
        }
        return svg;
    };

    // --- Một shape ---
    Ctx.prototype.resolveBox = function (shape) {
        var x = xfrmOf(shape);
        if (x) return x;
        var ph = phInfo(shape);
        if (ph) {
            var lp = findPh(this.layoutShapes, ph, false) || findPh(this.layoutShapes, ph, true);
            var lx = lp && xfrmOf(lp);
            if (lx) return lx;
            var mp = findPh(this.masterShapes, { type: (lp && phInfo(lp) ? phInfo(lp).type : ph.type), idx: null }, false);
            var mx = mp && xfrmOf(mp);
            if (mx) return mx;
        }
        return { x: 0, y: 0, w: 0, h: 0, rot: 0, flipH: false, flipV: false };
    };

    Ctx.prototype.renderShape = function (shape, parentEl, opts, map) {
        var self = this, ln = shape.localName;
        var cNvPr = path(shape, 'p:nvSpPr', 'p:cNvPr') || path(shape, 'p:nvPicPr', 'p:cNvPr') || path(shape, 'p:nvGrpSpPr', 'p:cNvPr') || path(shape, 'p:nvGraphicFramePr', 'p:cNvPr') || path(shape, 'p:nvCxnSpPr', 'p:cNvPr');
        if (cNvPr && cNvPr.getAttribute('hidden') === '1') return null;
        var spid = cNvPr ? cNvPr.getAttribute('id') : null;
        var ph = phInfo(shape);
        var box = this.resolveBox(shape);
        // Con của nhóm: toạ độ nằm trong không gian chOff/chExt → đổi sang px của nhóm cha (PowerPoint chỉ co giãn HÌNH HỌC,
        // không co giãn cỡ chữ / bề dày nét — trước đây scale() cả nhóm làm chữ & nét to lên hàng nghìn lần khi chExt rất nhỏ).
        if (map) box = Object.assign({}, box, { x: (box.x - map.cx) * map.sx, y: (box.y - map.cy) * map.sy, w: box.w * map.sx, h: box.h * map.sy });

        var outer = document.createElement('div');
        outer.className = 'pp-sh';
        var os = outer.style;
        os.position = 'absolute'; os.left = box.x + 'px'; os.top = box.y + 'px'; os.width = box.w + 'px'; os.height = box.h + 'px';
        var inner = document.createElement('div');
        inner.className = 'pp-in';
        var is = inner.style;
        is.position = 'absolute'; is.left = '0'; is.top = '0'; is.width = '100%'; is.height = '100%';
        var tf = [];
        if (box.rot) tf.push('rotate(' + box.rot + 'deg)');
        if (box.flipH || box.flipV) tf.push('scale(' + (box.flipH ? -1 : 1) + ',' + (box.flipV ? -1 : 1) + ')');
        if (tf.length) is.transform = tf.join(' ');
        outer.appendChild(inner);

        if (ln === 'grpSp') {
            var g = document.createElement('div');
            var hasCh = box.chW > 0 && box.chH > 0;
            var cmap = hasCh ? { cx: box.chX || 0, cy: box.chY || 0, sx: box.w / box.chW, sy: box.h / box.chH } : { cx: 0, cy: 0, sx: 1, sy: 1 };
            g.style.cssText = 'position:absolute;left:0;top:0;width:' + box.w + 'px;height:' + box.h + 'px';
            kids(shape).forEach(function (c) { if (c.namespaceURI === NS_P && /^(sp|pic|grpSp|graphicFrame|cxnSp)$/.test(c.localName)) self.renderShape(c, g, undefined, cmap); });
            inner.appendChild(g);
        } else if (ln === 'pic') {
            this.renderPicture(shape, box, inner);
        } else if (ln === 'graphicFrame') {
            this.renderFrame(shape, box, inner);
        } else {
            var isCxn = ln === 'cxnSp';
            inner.appendChild(this.shapeGeometry(shape, box, ph, isCxn));
            var tx = this.renderText(shape, box, ph);
            if (tx && !isCxn) {
                var hasAnyText = tx.textContent.replace(/\u00a0/g, '').trim().length > 0 || (kid(shape, NS_P, 'txBody') && desc(kid(shape, NS_P, 'txBody'), 'r').length);
                if (hasAnyText) inner.appendChild(tx);
            }
        }
        // chiều dọc cho đường kẻ: line có flipV/rot đã xử lý ở transform
        parentEl.appendChild(outer);
        if (spid && !opts) this.spMap[spid] = outer;
        else if (spid && this.spMap[spid] === undefined) this.spMap[spid] = outer;
        return outer;
    };

    /** Địa chỉ YouTube (watch?v=, youtu.be/, /embed/, /shorts/, /live/) → { id, start(giây) } hoặc null. */
    function parseYouTube(url) {
        var u; try { u = new URL(String(url), 'https://x.invalid'); } catch (e) { return null; }
        var h = u.hostname.replace(/^(www|m|music)\./, ''), id = null, m;
        if (h === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
        else if (h === 'youtube.com' || h === 'youtube-nocookie.com') {
            if (u.pathname === '/watch') id = u.searchParams.get('v');
            else if ((m = /^\/(embed|shorts|live|v)\/([^/?#]+)/.exec(u.pathname))) id = m[2];
        }
        if (!id || !/^[A-Za-z0-9_-]{6,20}$/.test(id)) return null;
        var t = u.searchParams.get('t') || u.searchParams.get('start') || '', start = 0, tm = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(t);
        if (tm) start = (+tm[1] || 0) * 3600 + (+tm[2] || 0) * 60 + (+tm[3] || 0);
        return { id: id, start: start };
    }
    /** Ảnh có liên kết/nhúng YouTube (Google Slides xuất video thành ảnh + hlinkClick; PowerPoint dùng a:videoFile) → nút phát tại chỗ. */
    Ctx.prototype.attachYouTube = function (pic, holder) {
        var cNv = path(pic, 'p:nvPicPr', 'p:cNvPr'), nvPr = path(pic, 'p:nvPicPr', 'p:nvPr');
        var hl = cNv && kid(cNv, NS_A, 'hlinkClick'), vf = nvPr && kid(nvPr, NS_A, 'videoFile');
        var rels = this.slideRels || {}, url = '';
        var rid1 = hl && hl.getAttributeNS(NS_R, 'id'), rid2 = vf && vf.getAttributeNS(NS_R, 'link');
        if (rid1 && rels[rid1]) url = rels[rid1].target;
        var yt = parseYouTube(url);
        if (!yt && rid2 && rels[rid2]) { url = rels[rid2].target; yt = parseYouTube(url); }
        if (!yt) {                                                   // ★ ảnh có liên kết thường (vd. biểu tượng loa → Google Drive): bấm mở tab mới
            var link = rid1 && rels[rid1] ? rels[rid1].target : '';
            if (/^https?:\/\//i.test(link)) {
                holder.style.cursor = 'pointer'; holder.setAttribute('role', 'link');
                holder.setAttribute('aria-label', 'Mở liên kết: ' + link); holder.title = 'Mở liên kết: ' + link;
                holder.addEventListener('click', function (e) {
                    e.stopPropagation(); e.preventDefault();         // không để thao tác "bấm = sang slide kế"
                    window.open(link, '_blank', 'noopener,noreferrer');
                });
            }
            return;
        }
        var title = (cNv && cNv.getAttribute('title')) || 'Video YouTube';
        holder.style.cursor = 'pointer'; holder.setAttribute('role', 'button'); holder.setAttribute('aria-label', 'Phát video: ' + title); holder.title = 'Bấm để phát video';
        var btn = document.createElement('div');
        btn.style.cssText = 'position:absolute;left:50%;top:50%;width:68px;height:48px;margin:-24px 0 0 -34px;border-radius:12px;background:rgba(220,38,38,.92);box-shadow:0 2px 10px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center';
        btn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="#fff"/></svg>';
        var open = document.createElement('a');
        open.href = 'https://www.youtube.com/watch?v=' + yt.id + (yt.start ? '&t=' + yt.start + 's' : ''); open.target = '_blank'; open.rel = 'noopener noreferrer'; open.textContent = '↗ YouTube';
        open.style.cssText = 'position:absolute;right:8px;bottom:8px;padding:3px 8px;border-radius:6px;background:rgba(0,0,0,.6);color:#fff;font:600 12px/1.4 system-ui,sans-serif;text-decoration:none';
        open.addEventListener('click', function (e) { e.stopPropagation(); });
        holder.appendChild(btn); holder.appendChild(open);
        holder.addEventListener('click', function (e) {
            e.stopPropagation(); e.preventDefault();                 // không để thao tác "bấm = sang slide kế"
            if (holder.querySelector('iframe')) return;
            var ifr = document.createElement('iframe');
            ifr.src = 'https://www.youtube.com/embed/' + yt.id + '?autoplay=1&rel=0&playsinline=1' + (yt.start ? '&start=' + yt.start : '');
            ifr.title = title; ifr.setAttribute('allowfullscreen', '');
            ifr.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen';
            ifr.referrerPolicy = 'strict-origin-when-cross-origin';
            ifr.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;border:0;background:#000;z-index:2';
            holder.innerHTML = ''; holder.appendChild(ifr);
            holder.style.cursor = 'default'; holder.removeAttribute('title'); holder.removeAttribute('role');
        });
    };

    Ctx.prototype.renderPicture = function (pic, box, inner) {
        var self = this;
        var blip = path(pic, 'p:blipFill', 'a:blip');
        if (!blip) return;
        var rid = blip.getAttributeNS(NS_R, 'embed');
        var rel = this.slideRels && this.slideRels[rid];
        var holder = document.createElement('div');
        holder.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;overflow:hidden';
        var img = document.createElement('img');
        img.alt = ''; img.draggable = false;
        var src = path(pic, 'p:blipFill', 'a:srcRect');
        var l = src ? attrNum(src, 'l', 0) / 100000 : 0, t = src ? attrNum(src, 't', 0) / 100000 : 0, r = src ? attrNum(src, 'r', 0) / 100000 : 0, b = src ? attrNum(src, 'b', 0) / 100000 : 0;
        var iw = 1 - l - r, ih = 1 - t - b;
        img.style.cssText = 'position:absolute;max-width:none;width:' + (100 / Math.max(iw, 0.01)) + '%;height:' + (100 / Math.max(ih, 0.01)) + '%;left:' + (-l / Math.max(iw, 0.01) * 100) + '%;top:' + (-t / Math.max(ih, 0.01) * 100) + '%;object-fit:fill;user-select:none';
        holder.appendChild(img);
        inner.appendChild(holder);
        var spPr = kid(pic, NS_P, 'spPr'), pg = spPr && kid(spPr, NS_A, 'prstGeom');
        if (pg && pg.getAttribute('prst') === 'ellipse') holder.style.borderRadius = '50%';
        else if (pg && pg.getAttribute('prst') === 'roundRect') holder.style.borderRadius = (Math.min(box.w, box.h) * 0.16667) + 'px';
        var line = this.lineSpec(spPr, pic, null);
        if (line && spPr && kid(spPr, NS_A, 'ln')) holder.style.outline = line.w + 'px solid ' + css(line.c);
        // Ảnh không đọc/giải mã được → hiện khung báo lỗi (có tên tệp) thay vì để trống, để người dùng biết ảnh nào hỏng.
        function failed(target) {
            if (img.parentNode) img.parentNode.removeChild(img);
            holder.style.background = 'rgba(0,0,0,0.04)';
            holder.style.display = 'flex'; holder.style.alignItems = 'center'; holder.style.justifyContent = 'center';
            var lb = document.createElement('div');
            lb.style.cssText = 'color:#9ca3af;font:12px sans-serif;text-align:center;padding:4px';
            lb.textContent = '(Không hiển thị được ảnh' + (target ? ' ' + target.split('/').pop() : '') + ')';
            holder.appendChild(lb);
        }
        if (rel) {
            img.onerror = function () { failed(rel.target); };
            this.pending.push(self.deck.zip.blobUrl(rel.target).then(function (u) { if (u) img.src = u; else failed(rel.target); }));
        }
        this.attachYouTube(pic, holder);
    };

    Ctx.prototype.renderFrame = function (gf, box, inner) {
        var gd = path(gf, 'a:graphic', 'a:graphicData');
        var tbl = gd && kid(gd, NS_A, 'tbl');
        if (tbl) { this.renderTable(tbl, box, inner); return; }
        // Đối tượng OLE (vd. Paint.Picture, Equation…): file lưu sẵn ảnh xem trước dạng <p:pic> trong mc:Fallback → vẽ ảnh đó
        // (trước đây hiện khung xám "Đối tượng nhúng — chưa hỗ trợ").
        var oPic = gd && desc(gd, 'pic')[0];
        if (oPic) { this.renderPicture(oPic, box, inner); return; }
        var ph = document.createElement('div');
        ph.style.cssText = 'position:absolute;inset:0;border:1px dashed rgba(100,100,100,.5);background:rgba(240,240,240,.6);display:flex;align-items:center;justify-content:center;color:#6b7280;font:14px sans-serif;text-align:center;padding:8px';
        var uri = gd ? (gd.getAttribute('uri') || '') : '';
        ph.textContent = /chart/.test(uri) ? '(Biểu đồ — chưa hỗ trợ hiển thị)' : /diagram/.test(uri) ? '(SmartArt — chưa hỗ trợ hiển thị)' : '(Đối tượng nhúng — chưa hỗ trợ hiển thị)';
        inner.appendChild(ph);
    };

    Ctx.prototype.renderTable = function (tbl, box, inner) {
        var self = this;
        var cols = kids(kid(tbl, NS_A, 'tblGrid'), NS_A, 'gridCol').map(function (c) { return attrNum(c, 'w', 0) / EMU; });
        var pr = kid(tbl, NS_A, 'tblPr');
        var firstRow = pr && pr.getAttribute('firstRow') === '1', band = pr && pr.getAttribute('bandRow') === '1';
        var table = document.createElement('table');
        table.style.cssText = 'position:absolute;left:0;top:0;border-collapse:collapse;table-layout:fixed;width:' + cols.reduce(function (a, b) { return a + b; }, 0) + 'px';
        var cg = document.createElement('colgroup');
        cols.forEach(function (w) { var c = document.createElement('col'); c.style.width = w + 'px'; cg.appendChild(c); });
        table.appendChild(cg);
        var accent = this.T();
        var acc1 = readColor({ localName: 'schemeClr', firstElementChild: null, getAttribute: function () { return 'accent1'; }, hasAttribute: function () { return true; } }, accent);
        var fakeShape = document.createElement('div');
        kids(tbl, NS_A, 'tr').forEach(function (tr, ri) {
            var row = document.createElement('tr');
            row.style.height = (attrNum(tr, 'h', 0) / EMU) + 'px';
            kids(tr, NS_A, 'tc').forEach(function (tc) {
                if (tc.getAttribute('hMerge') === '1' || tc.getAttribute('vMerge') === '1') return;
                var td = document.createElement('td');
                if (tc.hasAttribute('gridSpan')) td.colSpan = num(tc.getAttribute('gridSpan'), 1);
                if (tc.hasAttribute('rowSpan')) td.rowSpan = num(tc.getAttribute('rowSpan'), 1);
                td.style.cssText = 'padding:3px 6px;vertical-align:top;overflow:hidden;border:1px solid rgba(255,255,255,.9);box-sizing:border-box';
                var tcPr = kid(tc, NS_A, 'tcPr');
                var sf = tcPr && kid(tcPr, NS_A, 'solidFill');
                var bg = sf ? readColor(sf, self.T()) : null;
                var isHead = firstRow && ri === 0;
                var white = false;
                if (!bg && pr && pr.getAttribute('tableStyleId') !== undefined) {
                    if (isHead) { bg = acc1; white = true; }
                    else if (band) { bg = { rgb: acc1.rgb.map(function (x) { return Math.round(x * (ri % 2 ? 0.2 : 0.4) + 255 * (ri % 2 ? 0.8 : 0.6)); }), a: 1 }; }
                    else bg = { rgb: acc1.rgb.map(function (x) { return Math.round(x * 0.2 + 204); }), a: 1 };
                }
                if (bg) td.style.background = css(bg);
                if (tcPr && tcPr.getAttribute('anchor') === 'ctr') td.style.verticalAlign = 'middle';
                // chữ trong ô: dùng renderText với shape giả
                var txb = kid(tc, NS_A, 'txBody');
                if (txb) {
                    var fake = document.createElementNS(NS_P, 'p:sp');
                    var cloned = txb.cloneNode(true);
                    fake.appendChild(document.createElementNS(NS_P, 'p:spPr'));
                    var tb2 = document.createElementNS(NS_P, 'p:txBody');
                    while (cloned.firstChild) tb2.appendChild(cloned.firstChild);
                    fake.appendChild(tb2);
                    var t = self.renderText(fake, { w: 0, h: 0 }, null);
                    if (t) {
                        t.style.cssText = 'position:static;display:block;padding:0;width:auto;height:auto';
                        if (white) t.querySelectorAll('span').forEach(function (s) { s.style.color = '#fff'; s.style.fontWeight = '700'; });
                        td.appendChild(t);
                    }
                }
                row.appendChild(td);
            });
            table.appendChild(row);
        });
        inner.appendChild(table);
    };

    // --- Nền ---
    Ctx.prototype.renderBackground = function (stageEl, W, H) {
        var self = this;
        var sources = [this.slide.root, this.layout.root, this.master.root];
        for (var i = 0; i < sources.length; i++) {
            var bg = path(sources[i], 'p:cSld', 'p:bg');
            if (!bg) continue;
            var pr = kid(bg, NS_P, 'bgPr'), ref = kid(bg, NS_P, 'bgRef');
            if (pr) {
                var sf = kid(pr, NS_A, 'solidFill'), gf = kid(pr, NS_A, 'gradFill'), bf = kid(pr, NS_A, 'blipFill');
                if (sf) { stageEl.style.background = css(readColor(sf, this.T())); return; }
                if (gf) { stageEl.style.background = this.cssGradient(gf); return; }
                if (bf) {
                    var blip = kid(bf, NS_A, 'blip'), rid = blip && blip.getAttributeNS(NS_R, 'embed');
                    var rels = sources[i] === this.slide.root ? this.slideRels : sources[i] === this.layout.root ? this.layout.rels : this.master.rels;
                    if (rels && rels[rid]) this.pending.push(this.deck.zip.blobUrl(rels[rid].target).then(function (u) { if (u) stageEl.style.background = 'url("' + u + '") 0 0/100% 100% no-repeat'; }));
                    return;
                }
            } else if (ref) {
                var idx = num(ref.getAttribute('idx'), 1001), clr = readColor(ref, this.T());
                var st = this.theme.bgFills && this.theme.bgFills[idx - 1001];
                if (st && st.localName === 'solidFill') { stageEl.style.background = css(readColor(st, this.T(clr))); return; }
                if (st && st.localName === 'gradFill') { stageEl.style.background = this.cssGradient(st, clr); return; }
                if (clr) { stageEl.style.background = css(clr); return; }
            }
        }
        stageEl.style.background = '#fff';
    };
    Ctx.prototype.cssGradient = function (gf, phClr) {
        var self = this;
        var stops = kids(kid(gf, NS_A, 'gsLst'), NS_A, 'gs').map(function (s) { return css(readColor(s, self.T(phClr))) + ' ' + (attrNum(s, 'pos', 0) / 1000) + '%'; });
        var lin = kid(gf, NS_A, 'lin'), pathN = kid(gf, NS_A, 'path');
        if (pathN) return 'radial-gradient(circle at 50% 50%, ' + stops.join(',') + ')';
        return 'linear-gradient(' + ((lin ? attrNum(lin, 'ang', 0) / 60000 : 90) + 90) + 'deg,' + stops.join(',') + ')';
    };

    /** Dựng 1 slide thành DOM (lazy, lưu cache). */
    function renderSlide(deck, slide, player) {
        if (slide.rendered) return slide.rendered;
        slide.rendered = (function () {
            var ctx = new Ctx(deck, slide, player);
            ctx.slideRels = slide.rels;
            var root = document.createElement('div');
            root.className = 'pp-slide';
            root.style.cssText = 'position:absolute;left:0;top:0;width:' + deck.width + 'px;height:' + deck.height + 'px;overflow:hidden;transform-origin:0 0';
            ctx.renderBackground(root, deck.width, deck.height);
            // master → layout → slide (bỏ placeholder của master/layout)
            function layer(shapes, rels) {
                var c = new Ctx(deck, slide, player); c.slideRels = rels;
                shapes.forEach(function (s) {
                    if (phInfo(s)) return;
                    var el = c.renderShape(s, root, { nomap: true });
                });
                ctx.pending = ctx.pending.concat(c.pending);
            }
            var showMaster = slide.layout.root.getAttribute('showMasterSp') !== '0' && slide.root.getAttribute('showMasterSp') !== '0';
            if (showMaster) layer(ctx.masterShapes, slide.master.rels);
            layer(ctx.layoutShapes, slide.layout.rels);
            kids(path(slide.root, 'p:cSld', 'p:spTree')).forEach(function (s) {
                if (s.namespaceURI === NS_P && /^(sp|pic|grpSp|graphicFrame|cxnSp)$/.test(s.localName)) ctx.renderShape(s, root);
            });
            return Promise.all(ctx.pending).then(function () { return { el: root, spMap: ctx.spMap }; });
        })();
        return slide.rendered;
    }

    // ------------------------------------------------------------
    // Chuyển cảnh (chạy)
    // ------------------------------------------------------------
    var EASE = 'cubic-bezier(.4,0,.2,1)';
    function dirVec(dir) { return { l: [-1, 0], r: [1, 0], u: [0, -1], d: [0, 1], lu: [-1, -1], ru: [1, -1], ld: [-1, 1], rd: [1, 1] }[dir] || [-1, 0]; }

    function runTransition(tr, fromEl, toEl, W, H, done) {
        var anims = [], dur = tr.dur || 750, finished = false;
        function end() { if (finished) return; finished = true; anims.forEach(function (a) { try { a.cancel(); } catch (e) { } }); done(); }
        function an(el, kf, opt) { var a = el.animate(kf, Object.assign({ duration: dur, easing: EASE, fill: 'both' }, opt || {})); anims.push(a); return a; }
        var type = tr.type, v = dirVec(tr.dir);
        if (type === 'random') type = ['fade', 'push', 'wipe', 'zoom', 'circle', 'cover'][Math.floor(Math.random() * 6)];
        var last = null;
        switch (type) {
            case 'cut': end(); return { finish: end };
            case 'push':
                // dir = hướng CHUYỂN ĐỘNG (u: đẩy lên → slide cũ đi lên, slide mới từ dưới vào)
                an(fromEl, [{ transform: 'translate(0,0)' }, { transform: 'translate(' + (v[0] * W) + 'px,' + (v[1] * H) + 'px)' }]);
                last = an(toEl, [{ transform: 'translate(' + (-v[0] * W) + 'px,' + (-v[1] * H) + 'px)' }, { transform: 'translate(0,0)' }]);
                break;
            case 'cover':
                last = an(toEl, [{ transform: 'translate(' + (-v[0] * W) + 'px,' + (-v[1] * H) + 'px)' }, { transform: 'translate(0,0)' }]);
                break;
            case 'pull':
                toEl.style.zIndex = '0'; fromEl.style.zIndex = '1';
                last = an(fromEl, [{ transform: 'translate(0,0)' }, { transform: 'translate(' + (v[0] * W) + 'px,' + (v[1] * H) + 'px)' }]);
                break;
            case 'wipe': {
                var s0 = { r: 'inset(0 100% 0 0)', l: 'inset(0 0 0 100%)', d: 'inset(0 0 100% 0)', u: 'inset(100% 0 0 0)' }[tr.dir] || 'inset(0 100% 0 0)';
                last = an(toEl, [{ clipPath: s0 }, { clipPath: 'inset(0 0 0 0)' }]);
                break;
            }
            case 'split': {
                var vert = tr.orient === 'vert', out = tr.dir !== 'in';
                var a0 = vert ? 'inset(0 50% 0 50%)' : 'inset(50% 0 50% 0)', a1 = 'inset(0 0 0 0)';
                last = an(toEl, out ? [{ clipPath: a0 }, { clipPath: a1 }] : [{ clipPath: a1 }, { clipPath: a1 }]);
                if (!out) { toEl.style.zIndex = '0'; fromEl.style.zIndex = '1'; last = an(fromEl, [{ clipPath: a1 }, { clipPath: a0 }]); }
                break;
            }
            case 'zoom':
                if (tr.dir === 'out') { toEl.style.zIndex = '0'; fromEl.style.zIndex = '1'; last = an(fromEl, [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0.1)', opacity: 0 }]); }
                else { last = an(toEl, [{ transform: 'scale(0.1)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { transformOrigin: '50% 50%' }); toEl.style.transformOrigin = '50% 50%'; }
                break;
            case 'circle':
                last = an(toEl, [{ clipPath: 'circle(0% at 50% 50%)' }, { clipPath: 'circle(75% at 50% 50%)' }]); break;
            case 'diamond':
                last = an(toEl, [{ clipPath: 'polygon(50% 50%,50% 50%,50% 50%,50% 50%)' }, { clipPath: 'polygon(50% -50%,150% 50%,50% 150%,-50% 50%)' }]); break;
            case 'plus':
                last = an(toEl, [{ clipPath: 'polygon(50% 50%,50% 50%,50% 50%,50% 50%,50% 50%,50% 50%,50% 50%,50% 50%,50% 50%,50% 50%,50% 50%,50% 50%)' },
                    { clipPath: 'polygon(33% 0,67% 0,67% 33%,100% 33%,100% 67%,67% 67%,67% 100%,33% 100%,33% 67%,0 67%,0 33%,33% 33%)' }]);
                break;
            case 'fade': default:
                if (tr.thruBlk) {
                    fromEl.parentNode.style.background = '#000';
                    an(fromEl, [{ opacity: 1 }, { opacity: 0 }], { duration: dur / 2 });
                    last = an(toEl, [{ opacity: 0 }, { opacity: 0 }, { opacity: 1 }], { offset: undefined });
                } else last = an(toEl, [{ opacity: 0 }, { opacity: 1 }]);
        }
        if (last) last.onfinish = end;
        var safety = setTimeout(end, dur + 500);
        return { finish: function () { clearTimeout(safety); end(); } };
    }

    // ------------------------------------------------------------
    // Hiệu ứng (chạy)
    // ------------------------------------------------------------
    function fmtPx(n) { return Math.round(n * 100) / 100 + 'px'; }


    // ------------------------------------------------------------
    // Hiệu ứng dạng mặt nạ: Blinds, Checkerboard, Random Bars, Strips, Wedge, Wheel.
    // Dùng thuộc tính CSS đã đăng ký (--ppP phần trăm, --ppA góc) để Web Animations nội suy được trong mask-image.
    // ------------------------------------------------------------
    var maskReady = null;
    function maskSupported() {
        if (maskReady !== null) return maskReady;
        maskReady = false;
        try {
            if (global.CSS && CSS.registerProperty && CSS.supports && (CSS.supports('mask-image', 'linear-gradient(#000,#000)') || CSS.supports('-webkit-mask-image', 'linear-gradient(#000,#000)'))) {
                [{ name: '--ppP', syntax: '<percentage>', initialValue: '0%' }, { name: '--ppA', syntax: '<angle>', initialValue: '0deg' }].forEach(function (d) {
                    try { CSS.registerProperty({ name: d.name, syntax: d.syntax, inherits: false, initialValue: d.initialValue }); } catch (e) { /* đã đăng ký rồi */ }
                });
                maskReady = true;
            }
        } catch (e) { maskReady = false; }
        return maskReady;
    }
    function maskEffect(id, st) {
        if (!maskSupported()) return null;
        var img, prop, p0, p1;
        if (id === 3 || id === 5 || id === 14) {            // blinds / checkerboard / random bars: các thanh mở dần
            var dir = (st === 10 || (id !== 3 && st === 5)) ? 'to bottom' : 'to right';
            if (id === 3 && st === 5) dir = 'to right';
            var per = id === 14 ? 6.25 : 12.5;
            img = 'repeating-linear-gradient(' + dir + ', #000 0, #000 var(--ppP), transparent var(--ppP), transparent ' + per + '%)';
            prop = '--ppP'; p0 = '0%'; p1 = per + '%';
        } else if (id === 18) {                             // strips: thanh chéo
            var ang = (st === 3 || st === 12) ? '45deg' : '135deg';
            img = 'repeating-linear-gradient(' + ang + ', #000 0, #000 var(--ppP), transparent var(--ppP), transparent 10%)';
            prop = '--ppP'; p0 = '0%'; p1 = '10%';
        } else if (id === 20) {                             // wedge: mở từ giữa-trên ra hai bên
            img = 'conic-gradient(from calc(0deg - var(--ppA)) at 50% 50%, #000 0deg, #000 calc(2 * var(--ppA)), transparent calc(2 * var(--ppA)))';
            prop = '--ppA'; p0 = '0deg'; p1 = '180deg';
        } else {                                            // wheel (21): st = số nan quạt (1,2,3,4,8)
            var n = [1, 2, 3, 4, 8].indexOf(st) >= 0 ? st : 1;
            img = 'repeating-conic-gradient(from 0deg at 50% 50%, #000 0deg, #000 var(--ppA), transparent var(--ppA), transparent ' + (360 / n) + 'deg)';
            prop = '--ppA'; p0 = '0deg'; p1 = (360 / n) + 'deg';
        }
        var k0 = { maskImage: img, webkitMaskImage: img }, k1 = { maskImage: img, webkitMaskImage: img };
        k0[prop] = p0; k1[prop] = p1;
        return { kf: [k0, k1] };
    }

    function effectKeyframes(e, el, W, H) {
        // trả về { kf: [...], opt:{...}, persist: fn|null } — kf mô tả trạng thái BẮT ĐẦU → KẾT THÚC của entr (exit sẽ đảo chiều)
        var left = el.offsetLeft, top = el.offsetTop, w = el.offsetWidth, h = el.offsetHeight;
        var id = e.preset, st = e.subtype;
        var from = function (st2) {   // 1 top, 2 right, 4 bottom, 8 left
            var dx = 0, dy = 0;
            if (st2 & 8) dx = -(left + w); if (st2 & 2) dx = W - left;
            if (st2 & 1) dy = -(top + h); if (st2 & 4) dy = H - top;
            return 'translate(' + fmtPx(dx) + ',' + fmtPx(dy) + ')';
        };
        switch (id) {
            case 1: return { kf: [{ opacity: 0 }, { opacity: 0, offset: 0.99 }, { opacity: 1 }], dur: 1, appear: true };   // ẩn tới đúng lúc bắt đầu (delay) rồi hiện hẳn
            case 2: return { kf: [{ transform: from(st || 4) }, { transform: 'translate(0,0)' }] };
            case 3: case 5: case 14: case 18: case 20: case 21: {    // blinds / checkerboard / random bars / strips / wedge / wheel → mặt nạ (mask) động; trình duyệt cũ không có → fade
                var mk = maskEffect(id, st);
                return mk || { kf: [{ opacity: 0 }, { opacity: 1 }] };
            }
            case 4: return { kf: [{ clipPath: st === 32 ? 'inset(0)' : 'inset(50%)' }, { clipPath: 'inset(0%)' }] };
            case 6: return { kf: [{ clipPath: 'circle(0% at 50% 50%)' }, { clipPath: 'circle(75% at 50% 50%)' }] };
            case 8: return { kf: [{ clipPath: 'polygon(50% 50%,50% 50%,50% 50%,50% 50%)' }, { clipPath: 'polygon(50% -50%,150% 50%,50% 150%,-50% 50%)' }] };
            case 13: return { kf: [{ clipPath: 'polygon(50% 50%,50% 50%,50% 50%,50% 50%,50% 50%,50% 50%,50% 50%,50% 50%,50% 50%,50% 50%,50% 50%,50% 50%)' }, { clipPath: 'polygon(33% 0,67% 0,67% 33%,100% 33%,100% 67%,67% 67%,67% 100%,33% 100%,33% 67%,0 67%,0 33%,33% 33%)' }] };
            case 22: case 12: {      // wipe / peek in
                var m = { 1: 'inset(0 0 100% 0)', 2: 'inset(0 0 0 100%)', 4: 'inset(100% 0 0 0)', 8: 'inset(0 100% 0 0)' };
                return { kf: [{ clipPath: m[st] || m[8] }, { clipPath: 'inset(0 0 0 0)' }] };
            }
            case 16: return { kf: [{ clipPath: (st & 16 || st === 26 || st === 10) ? 'inset(0 50% 0 50%)' : 'inset(50% 0 50% 0)' }, { clipPath: 'inset(0 0 0 0)' }] };
            case 17: return { kf: [{ transform: 'scale(0,1)' }, { transform: 'scale(1,1)' }] };
            case 7: return { kf: [{ transform: 'translateX(' + fmtPx(-30) + ')', opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }] };
            case 10: return { kf: [{ opacity: 0 }, { opacity: 1 }] };
            case 23: case 53: return { kf: [{ transform: 'scale(0.01)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }] };
            case 26: return { kf: [{ transform: 'scale(0.3)', opacity: 0 }, { transform: 'scale(1.08)', opacity: 1, offset: 0.7 }, { transform: 'scale(1)', opacity: 1 }] };
            default: return { kf: [{ opacity: 0 }, { opacity: 1 }] };
        }
    }

    function targetEls(e, spMap) {
        var el = spMap[e.spid];
        if (!el) return [];
        if (e.para) {
            var ps = el.querySelectorAll('.pp-p'), out = [];
            for (var i = e.para[0]; i <= e.para[1]; i++) if (ps[i]) out.push(ps[i]);
            return out.length ? out : [el];
        }
        return [el];
    }

    // ------------------------------------------------------------
    // Player
    // ------------------------------------------------------------
    function Player(container, deck, opts) {
        this.container = container; this.deck = deck; this.opts = opts || {};
        this.cur = -1; this.step = 0; this.live = []; this.busy = false; this.timers = [];
        this.autoAdvance = !!this.opts.autoAdvance;
        container.classList.add('pp-container');
        this.frame = document.createElement('div');
        this.frame.className = 'pp-frame';
        this.frame.style.cssText = 'position:relative;overflow:hidden;background:#000;margin:auto;flex:none;transform-origin:0 0';
        this.fh = deck.height; this.textScale = Number(this.opts.textScale) || 1;   // fh: chiều cao khung (cao hơn slide khi chữ phóng to quá khung)
        this.frame.style.width = deck.width + 'px'; this.frame.style.height = deck.height + 'px';
        container.appendChild(this.frame);
        this.scale = 1; this.zoom = Math.max(0.25, Math.min(4, Number(this.opts.zoom) || 1));
        this.resize();
        var self = this;
        this._ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(function () { self.resize(); }) : null;
        if (this._ro) this._ro.observe(container);
    }

    Player.prototype.resize = function () {
        var c = this.container, W = this.deck.width, H = this.fh || this.deck.height;
        var cw = c.clientWidth, ch = c.clientHeight;
        if (!cw || !ch) return;
        var s = (H > this.deck.height ? cw / W : Math.min(cw / W, ch / H)) * (this.zoom || 1);   // slide bị kéo dài (chữ to) → vừa chiều ngang, cuộn dọc      // zoom 1 = vừa khung; > 1 = to hơn khung (khung tự cuộn)
        this.scale = s;
        this.frame.style.transform = 'scale(' + s + ')';
        this.frame.style.marginLeft = Math.max(0, (cw - W * s) / 2) + 'px';
        this.frame.style.marginTop = Math.max(0, (ch - H * s) / 2) + 'px';
        this.frame.style.marginRight = (-(W - W * s)) + 'px'; this.frame.style.marginBottom = (-(H - H * s)) + 'px';
    };

    /** Phóng to / thu nhỏ so với mức "vừa khung" (1 = 100%). Giữ nguyên tâm đang xem. */
    Player.prototype.setZoom = function (z) {
        var c = this.container;
        var fx = c.scrollWidth ? (c.scrollLeft + c.clientWidth / 2) / c.scrollWidth : 0.5;
        var fy = c.scrollHeight ? (c.scrollTop + c.clientHeight / 2) / c.scrollHeight : 0.5;
        this.zoom = Math.max(0.25, Math.min(4, z));
        this.resize();
        c.scrollLeft = fx * c.scrollWidth - c.clientWidth / 2;
        c.scrollTop = fy * c.scrollHeight - c.clientHeight / 2;
        return this.zoom;
    };

    Player.prototype._info = function () {
        var s = this.deck.slides[this.cur];
        return { index: this.cur, count: this.deck.slides.length, step: this.step, steps: s ? s.timing.steps.length : 0 };
    };
    Player.prototype._emit = function () { if (this.opts.onChange) this.opts.onChange(this._info()); };

    Player.prototype._clearTimers = function () { this.timers.forEach(clearTimeout); this.timers = []; };
    Player.prototype._cancelAnims = function () { this.live.forEach(function (a) { try { a.cancel(); } catch (e) { } }); this.live = []; };

    /** Đặt trạng thái ban đầu rồi áp kết quả cuối của `k` bước đầu (không animation). */
    Player.prototype._setState = function (rs, slide, k) {
        var spMap = rs.spMap, tm = slide.timing;
        Object.keys(spMap).forEach(function (id) { var el = spMap[id]; el.style.visibility = ''; el.style.transform = ''; el.style.opacity = ''; el.style.clipPath = ''; });
        rs.el.querySelectorAll('.pp-p').forEach(function (p) { p.style.visibility = ''; });
        Object.keys(tm.hiddenInit).forEach(function (key) {
            var h = tm.hiddenInit[key];
            targetEls({ spid: h.spid, para: h.para }, spMap).forEach(function (el) { el.style.visibility = 'hidden'; });
        });
        for (var i = 0; i < k; i++) this._applyEnd(tm.steps[i], rs, W2(this));
    };
    function W2(p) { return { W: p.deck.width, H: p.deck.height }; }

    Player.prototype._applyEnd = function (step, rs, WH) {
        step.effects.forEach(function (e) {
            targetEls(e, rs.spMap).forEach(function (el) {
                if (e.cls === 'entr') el.style.visibility = 'visible';
                else if (e.cls === 'exit') el.style.visibility = 'hidden';
                else if (e.cls === 'path' && e.extra.path) {
                    var pts = parseMotionPath(e.extra.path, WH.W, WH.H);
                    if (pts.length) { var last = pts[pts.length - 1]; el.style.transform = 'translate(' + fmtPx(last[0]) + ',' + fmtPx(last[1]) + ')'; }
                }
            });
        });
    };

    Player.prototype._playStep = function (step, rs, done) {
        var self = this, W = this.deck.width, H = this.deck.height, maxEnd = 0, pending = 0, finished = false;
        function fin() { if (finished) return; finished = true; self._applyEnd(step, rs, { W: W, H: H }); self._cancelAnims(); self.busy = false; self._stepDone = null; done && done(); }
        this.busy = true; this._stepDone = fin;
        step.effects.forEach(function (e) {
            targetEls(e, rs.spMap).forEach(function (el) {
                var total = e.start + Math.max(e.dur, e.preset === 1 && e.cls === 'entr' ? 1 : 0);
                maxEnd = Math.max(maxEnd, total);
                var opts = { duration: Math.max(1, e.dur), delay: e.start, fill: 'both', easing: 'ease-in-out' };
                var a = null;
                if (e.cls === 'entr' || e.cls === 'exit') {
                    var k = effectKeyframes(e, el, W, H);
                    if (e.cls === 'entr') { el.style.visibility = 'visible'; }
                    // ⚠️ composite 'add' chỉ đúng với transform. Với opacity thì 'add' CỘNG vào giá trị gốc (1 + 0…1 → luôn bị cắt về 1)
                    //    nên Fade/Zoom… không mờ dần mà hiện ra tức thì. → tách: transform = 'add', opacity/clipPath = 'replace'.
                    var tKf = [], oKf = [], hasT = false, hasO = false;
                    k.kf.forEach(function (f) {
                        var tf = {}, of = {};
                        Object.keys(f).forEach(function (p) {
                            if (p === 'transform') { tf.transform = f[p]; hasT = true; }
                            else if (p === 'offset') { tf.offset = f[p]; of.offset = f[p]; }
                            else { of[p] = f[p]; hasO = true; }
                        });
                        tKf.push(tf); oKf.push(of);
                    });
                    var dirOpt = { direction: e.cls === 'exit' ? 'reverse' : 'normal' };
                    var animsHere = [];
                    if (hasT) animsHere.push(el.animate(tKf, Object.assign({}, opts, dirOpt, { composite: 'add' })));
                    if (hasO) animsHere.push(el.animate(oKf, Object.assign({}, opts, dirOpt, { composite: 'replace' })));
                    animsHere.forEach(function (x) { self.live.push(x); });
                    a = animsHere[animsHere.length - 1] || null;
                } else if (e.cls === 'emph') {
                    var kfs;
                    if (e.extra.rot) kfs = [{ transform: 'rotate(0deg)' }, { transform: 'rotate(' + e.extra.rot + 'deg)' }];
                    else if (e.extra.scale) kfs = [{ transform: 'scale(1,1)' }, { transform: 'scale(' + e.extra.scale[0] + ',' + e.extra.scale[1] + ')' }];
                    else kfs = [{ transform: 'scale(1)' }, { transform: 'scale(1.1)', offset: 0.5 }, { transform: 'scale(1)' }];
                    a = el.animate(kfs, Object.assign({}, opts, { composite: 'add', direction: e.extra.rot || e.extra.scale ? 'normal' : 'normal' }));
                } else if (e.cls === 'path' && e.extra.path) {
                    var pts = parseMotionPath(e.extra.path, W, H);
                    if (pts.length > 1) a = el.animate(pts.map(function (p) { return { transform: 'translate(' + fmtPx(p[0]) + ',' + fmtPx(p[1]) + ')' }; }), Object.assign({}, opts, { easing: 'linear', composite: 'add' }));
                }
                if (a) { self.live.push(a); pending++; a.onfinish = function () { pending--; }; }
            });
        });
        var t = setTimeout(fin, Math.max(maxEnd, 1) + 60);
        this.timers.push(t);
    };

    Player.prototype.show = function (index, opts) {
        opts = opts || {};
        var self = this, deck = this.deck;
        index = Math.max(0, Math.min(deck.slides.length - 1, index));
        var token = this._token = (this._token || 0) + 1;
        this._finishTransition && this._finishTransition();
        this._clearTimers(); this._cancelAnims(); this.busy = false;
        var slide = deck.slides[index];
        return renderSlide(deck, slide, this).then(function (rs) {
            if (token !== self._token) return;
            var prev = self.cur >= 0 ? deck.slides[self.cur] : null;
            var prevRs = prev && prev.rendered ? self._prevEl : null;
            var el = rs.el;
            var k = opts.stepsDone || 0;
            self._setState(rs, slide, k);
            el.style.zIndex = '2'; el.style.opacity = '';
            // gỡ slide cũ sau chuyển cảnh
            var old = self._shown;
            if (el.parentNode !== self.frame) self.frame.appendChild(el);
            self._shown = el; self.cur = index; self.step = k; self._rs = rs;
            try { self._autoFit(rs); } catch (e) { if (window.console) console.error('[pptx] autofit:', e && e.message); }
            var tr = opts.transition !== false && slide.transition && old && old !== el && opts.forward !== false ? slide.transition : null;
            function after() {
                if (old && old !== el && old.parentNode) old.parentNode.removeChild(old);
                el.style.zIndex = ''; el.style.transform = ''; el.style.clipPath = ''; el.style.opacity = '';
                self.frame.style.background = '#000';
                self._finishTransition = null;
                self._emit();
                self._afterShown(slide, rs, k);
            }
            if (old && old !== el) {
                old.style.zIndex = '1';
                if (tr && tr.type !== 'cut') {
                    var t = runTransition(tr, old, el, deck.width, deck.height, after);
                    self._finishTransition = t.finish;
                } else if (!tr && opts.forward === false) {
                    after();
                } else after();
            } else after();
        });
    };

    /** Chữ nội dung (không phải tiêu đề): co cho vừa khung (như PowerPoint) rồi nhân thêm cỡ chữ người dùng chọn (A− / A+). Tiêu đề giữ nguyên. */
    Player.prototype._autoFit = function (rs) {
        if (!rs.fits) {
            rs.fits = [];
            var root = rs.el, H = this.deck.height, rr = root.getBoundingClientRect(), sc = this.scale || 1;
            root.querySelectorAll('.pp-text[data-ts]').forEach(function (wrap) {
                if (!wrap.textContent.trim() || getComputedStyle(wrap).writingMode !== 'horizontal-tb') return;
                var cs = getComputedStyle(wrap);
                var padT = parseFloat(cs.paddingTop) || 0, padB = parseFloat(cs.paddingBottom) || 0, padL = parseFloat(cs.paddingLeft) || 0, padR = parseFloat(cs.paddingRight) || 0;
                var top = (wrap.getBoundingClientRect().top - rr.top) / sc;           // đỉnh khung chữ trong slide (px gốc)
                var availH = Math.min(wrap.clientHeight, H - top) - padT - padB;
                var availW = wrap.clientWidth - padL - padR;
                if (availH < 20 || availW < 20 || !wrap.firstChild) return;
                var inner = document.createElement('div');
                inner.className = 'pp-fit';
                while (wrap.firstChild) inner.appendChild(wrap.firstChild);
                wrap.appendChild(inner);
                inner.style.cssText = 'transform-origin:0 0;flex:none;width:' + availW + 'px';
                var k = 1, h = inner.offsetHeight;
                while (wrap.hasAttribute('data-autofit') && h > availH + 1 && k > 0.4) {                                   // co dần đến khi vừa
                    k = Math.max(0.4, k - 0.025);
                    inner.style.width = (availW / k) + 'px';
                    h = inner.offsetHeight * k;
                }
                rs.fits.push({ inner: inner, availW: availW, k0: k });
            });
        }
        this._applyTextScale();
    };

    Player.prototype._applyTextScale = function () {
        var rs = this._rs; if (!rs || !rs.fits) return;
        var t = this.textScale || 1, H0 = this.deck.height;
        rs.fits.forEach(function (f) {
            var k = f.k0 * t;
            f.inner.style.width = (f.availW / k) + 'px';
            f.inner.style.transform = k === 1 ? '' : 'scale(' + k + ')';
            f.inner.style.marginBottom = k === 1 ? '' : (-(f.inner.offsetHeight * (1 - k))) + 'px';
        });
        // chữ phóng to quá khung → kéo dài slide xuống (nền giữ nguyên), khung xem tự cuộn dọc
        var el = rs.el, H = H0;
        el.style.height = H0 + 'px';
        if (t > 1) H = Math.min(Math.max(H0, Math.ceil(el.scrollHeight) + 10), H0 * 3);
        el.style.height = H + 'px';
        this.fh = H; this.frame.style.height = H + 'px';
        this.resize();
    };

    /** Đổi cỡ chữ nội dung (1 = vừa khung, 1.2 = 120% …). */
    Player.prototype.setTextScale = function (t) {
        this.textScale = Math.max(0.5, Math.min(3, t));
        this._applyTextScale();
        this.container.scrollTop = 0;
        return this.textScale;
    };

    Player.prototype._afterShown = function (slide, rs, k) {
        var self = this;
        // hiệu ứng tự chạy khi slide bắt đầu ("After previous"/"With previous" ở bước đầu)
        if (k === 0 && slide.timing.auto && slide.timing.steps.length) {
            this.step = 1; this._emit();
            this._playStep(slide.timing.steps[0], rs, function () { self._emit(); self._scheduleAuto(slide); });
        } else this._scheduleAuto(slide);
    };

    Player.prototype._scheduleAuto = function (slide) {
        var self = this;
        if (!this.autoAdvance || !slide.transition || slide.transition.advTm === null || slide.transition.advTm === undefined) return;
        if (this.step < slide.timing.steps.length) return;
        var t = setTimeout(function () { if (self.autoAdvance && self.cur < self.deck.slides.length - 1) self.next(); }, slide.transition.advTm);
        this.timers.push(t);
    };

    Player.prototype.next = function () {
        if (this._finishTransition) { this._finishTransition(); return Promise.resolve(); }
        // Click khi hiệu ứng đang chạy: hoàn tất ngay hiệu ứng đó RỒI chạy tiếp bước kế (như PowerPoint).
        // Trước đây click chỉ "chốt" hiệu ứng đang chạy và bị nuốt → phải bấm 2 lần mới sang bước sau.
        if (this.busy && this._stepDone) this._stepDone();
        var slide = this.deck.slides[this.cur];
        if (slide && this.step < slide.timing.steps.length) {
            var self = this, st = slide.timing.steps[this.step];
            this.step++; this._emit();
            this._playStep(st, this._rs, function () { self._emit(); self._scheduleAuto(slide); });
            return Promise.resolve();
        }
        if (this.cur < this.deck.slides.length - 1) return this.show(this.cur + 1, { forward: true });
        return Promise.resolve();
    };

    Player.prototype.prev = function () {
        if (this._finishTransition) this._finishTransition();
        if (this.busy && this._stepDone) this._stepDone();
        if (this.step > 0) { this._clearTimers(); this._cancelAnims(); this._setState(this._rs, this.deck.slides[this.cur], this.step - 1); this.step--; this._emit(); return Promise.resolve(); }
        if (this.cur > 0) {
            var p = this.deck.slides[this.cur - 1];
            return this.show(this.cur - 1, { forward: false, stepsDone: p.timing.steps.length, transition: false });
        }
        return Promise.resolve();
    };

    Player.prototype.goto = function (i) { return this.show(i, { forward: i >= this.cur, transition: false }); };
    Player.prototype.setAutoAdvance = function (v) { this.autoAdvance = !!v; this._clearTimers(); if (v && this._rs) this._scheduleAuto(this.deck.slides[this.cur]); };
    Player.prototype.destroy = function () {
        this._clearTimers(); this._cancelAnims();
        if (this._ro) this._ro.disconnect();
        if (this.frame.parentNode) this.frame.parentNode.removeChild(this.frame);
        var z = this.deck.zip.blobs;
        Object.keys(z).forEach(function (k) { z[k].then(function (u) { if (u) URL.revokeObjectURL(u); }); });
    };

    global.PptxPlayer = { load: load, Player: Player, _parseMotionPath: parseMotionPath };
})(typeof window !== 'undefined' ? window : this);
