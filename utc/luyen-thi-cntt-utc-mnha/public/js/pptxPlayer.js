/* ============================================================
 * pptxPlayer.js — Đọc và TRÌNH CHIẾU file .pptx ngay trên trình duyệt (không cần Office, không gửi file ra ngoài)
 *
 * Hỗ trợ:
 *   • Bố cục: slide / layout / master (vị trí, nền, chữ kế thừa từ placeholder), theme màu + font
 *   • Hình: chữ nhật, bo góc, elip, đường, mũi tên, tam giác, hình thoi, ngũ giác, lục giác, sao, freeform (custGeom)…
 *   • Chữ: cỡ, đậm/nghiêng/gạch chân, màu, font, căn lề, bullet, giãn dòng, vị trí chữ trong khung, autofit co chữ
 *   • Ảnh (có cắt xén, xoay, lật), nhóm (group), bảng, nền (màu / gradient / ảnh)
 *   • CHUYỂN CẢNH: fade, push, cover, pull(uncover), wipe, split, zoom, circle, diamond, plus, cut, random + nhóm p14 (gần đúng)
 *   • HIỆU ỨNG: entrance / exit / emphasis / motion path — appear, fly in/out, fade, wipe, zoom, box, circle, diamond, split, spin,
 *     grow/shrink, pulse… theo ĐÚNG thứ tự click / cùng lúc / sau hiệu ứng trước và độ trễ, độ dài trong file; hiệu ứng theo đoạn văn
 *   • Tự chuyển slide theo thời gian (advTm) — tuỳ chọn
 * Chưa hỗ trợ (hiển thị khung trống/gần đúng): biểu đồ, SmartArt, video/âm thanh nhúng, WordArt, hiệu ứng blinds/checker/strips/wheel/wedge
 * (được thay bằng fade), một số hình hiếm.
 *
 * Dùng:  var deck = await PptxPlayer.load(arrayBuffer, JSZip);
 *        var player = new PptxPlayer.Player(containerEl, deck, { onChange: fn });  await player.show(0);
 *        player.next(); player.prev(); player.goto(i); player.resize(); player.destroy();
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
                out[r.getAttribute('Id')] = { type: (r.getAttribute('Type') || '').split('/').pop(), target: resolvePath(p, r.getAttribute('Target') || ''), mode: r.getAttribute('TargetMode') };
            });
            return out;
        });
    };
    var MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp' };
    Zip.prototype.blobUrl = function (p) {
        var self = this;
        if (self.blobs[p]) return self.blobs[p];
        var ext = (p.split('.').pop() || '').toLowerCase();
        var f = self.zip.file(p);
        if (!f || !MIME[ext]) { self.blobs[p] = Promise.resolve(null); return self.blobs[p]; }
        self.blobs[p] = f.async('arraybuffer').then(function (buf) { return URL.createObjectURL(new Blob([buf], { type: MIME[ext] })); });
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
        if (af && af.hasAttribute('fontScale')) fs = num(af.getAttribute('fontScale'), 100000) / 100000;
        var lnRed = af && af.hasAttribute('lnSpcReduction') ? num(af.getAttribute('lnSpcReduction'), 0) / 100000 : 0;

        var wrap = document.createElement('div');
        wrap.className = 'pp-text';
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
            ds.margin = '0'; ds.minHeight = '1em'; ds.wordBreak = 'break-word'; ds.overflowWrap = 'anywhere';
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
            var buNode = pp.bu, hasText = false, bulletText = '';
            var runs = [];
            kids(p).forEach(function (c) { if (/^(r|br|fld)$/.test(c.localName)) runs.push(c); });
            runs.forEach(function (r) { if (r.localName !== 'br' && (path(r, 'a:t') || {}).textContent) hasText = true; });
            if (buNode && buNode.localName === 'buChar' && hasText) bulletText = buNode.getAttribute('char') || '•';
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
                if (pp.buFont && pp.buFont.getAttribute('typeface') && !/^\+/.test(pp.buFont.getAttribute('typeface'))) bu.style.fontFamily = '"' + pp.buFont.getAttribute('typeface') + '", Arial, sans-serif';
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
                case 'blipFill': return { kind: 'solid', c: { rgb: [200, 200, 200], a: 1 } };
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
        var w = null, c = null, dash = null, none = false, head = null, tail = null;
        function applyLn(l) {
            if (!l) return;
            if (l.hasAttribute('w')) w = attrNum(l, 'w', 0) / EMU;
            var nf = kid(l, NS_A, 'noFill'), sf = kid(l, NS_A, 'solidFill'), gf = kid(l, NS_A, 'gradFill');
            if (nf) none = true;
            if (sf) { c = readColor(sf, self.T()); none = false; }
            if (gf) { var g = kid(kid(gf, NS_A, 'gsLst'), NS_A, 'gs'); if (g) { c = readColor(g, self.T()); none = false; } }
            var pd = kid(l, NS_A, 'prstDash'); if (pd) dash = pd.getAttribute('val');
            var he = kid(l, NS_A, 'headEnd'), te = kid(l, NS_A, 'tailEnd');
            if (he && he.getAttribute('type') && he.getAttribute('type') !== 'none') head = he.getAttribute('type');
            if (te && te.getAttribute('type') && te.getAttribute('type') !== 'none') tail = te.getAttribute('type');
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
        if (none || (!c && !ln)) return null;
        if (!c) c = { rgb: [0, 0, 0], a: 1 };
        return { w: w === null ? 1 : Math.max(w, 0.5), c: c, dash: dash, head: head, tail: tail };
    };

    var DASH = { dash: '6 3', sysDash: '3 2', dot: '1.5 2', sysDot: '1.5 1.5', lgDash: '9 4', dashDot: '6 3 1.5 3', lgDashDot: '9 4 1.5 4', lgDashDotDot: '9 4 1.5 4 1.5 4' };

    Ctx.prototype.shapeGeometry = function (shape, box, ph, isLine) {
        var spPr = kid(shape, NS_P, 'spPr');
        var w = Math.max(box.w, 0.01), h = Math.max(box.h, 0.01);
        var svg = svgEl('svg', { width: w, height: h, viewBox: '0 0 ' + w + ' ' + h });
        svg.style.cssText = 'position:absolute;left:0;top:0;overflow:visible';
        var defs = svgEl('defs', {}); svg.appendChild(defs);
        var fill = this.fillSpec(spPr, shape, ph, defs), line = this.lineSpec(spPr, shape, defs);
        var cg = spPr && kid(spPr, NS_A, 'custGeom'), pg = spPr && kid(spPr, NS_A, 'prstGeom');
        var prst = pg ? pg.getAttribute('prst') : (cg ? 'custom' : 'rect');
        var adjNode = pg && kid(kid(pg, NS_A, 'avLst'), NS_A, 'gd');
        var adj1 = adjNode ? num((adjNode.getAttribute('fmla') || '').replace(/[^0-9-]/g, ''), null) : null;
        var fillAttr = fill && fill.kind === 'solid' ? 'rgb(' + fill.c.rgb.join(',') + ')' : fill && fill.kind === 'grad' ? 'url(#' + fill.id + ')' : 'none';
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
            var attrs = { x1: 0, y1: 0, x2: w, y2: h }; var ln2 = line || { w: 1, c: { rgb: [0, 0, 0], a: 1 } };
            var l = svgEl('line', { x1: 0, y1: 0, x2: w, y2: h, stroke: 'rgb(' + ln2.c.rgb.join(',') + ')', 'stroke-opacity': ln2.c.a, 'stroke-width': ln2.w });
            if (ln2.dash && DASH[ln2.dash]) l.setAttribute('stroke-dasharray', DASH[ln2.dash]);
            var mid = 'ppm' + (++gradSeq);
            function marker(type, atEnd) {
                var m = svgEl('marker', { id: mid + (atEnd ? 't' : 'h'), markerWidth: 8, markerHeight: 8, refX: atEnd ? 7 : 1, refY: 4, orient: 'auto-start-reverse', markerUnits: 'strokeWidth' });
                m.appendChild(svgEl('path', { d: type === 'oval' ? 'M1,4 a3,3 0 1,0 6,0 a3,3 0 1,0 -6,0' : 'M0,0 L8,4 L0,8 Z', fill: 'rgb(' + ln2.c.rgb.join(',') + ')' }));
                defs.appendChild(m); return 'url(#' + mid + (atEnd ? 't' : 'h') + ')';
            }
            if (ln2.tail) l.setAttribute('marker-end', marker(ln2.tail, true));
            if (ln2.head) l.setAttribute('marker-start', marker(ln2.head, false));
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

    Ctx.prototype.renderShape = function (shape, parentEl, opts) {
        var self = this, ln = shape.localName;
        var cNvPr = path(shape, 'p:nvSpPr', 'p:cNvPr') || path(shape, 'p:nvPicPr', 'p:cNvPr') || path(shape, 'p:nvGrpSpPr', 'p:cNvPr') || path(shape, 'p:nvGraphicFramePr', 'p:cNvPr') || path(shape, 'p:nvCxnSpPr', 'p:cNvPr');
        if (cNvPr && cNvPr.getAttribute('hidden') === '1') return null;
        var spid = cNvPr ? cNvPr.getAttribute('id') : null;
        var ph = phInfo(shape);
        var box = this.resolveBox(shape);

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
            var gw = box.chW || box.w, gh = box.chH || box.h;
            g.style.cssText = 'position:absolute;left:0;top:0;width:' + gw + 'px;height:' + gh + 'px;transform-origin:0 0;transform:scale(' + (gw ? box.w / gw : 1) + ',' + (gh ? box.h / gh : 1) + ') translate(' + (-(box.chX || 0)) + 'px,' + (-(box.chY || 0)) + 'px)';
            kids(shape).forEach(function (c) { if (c.namespaceURI === NS_P && /^(sp|pic|grpSp|graphicFrame|cxnSp)$/.test(c.localName)) self.renderShape(c, g); });
            // group: tọa độ con nằm trong không gian chOff → dời về 0 rồi scale
            g.style.transform = 'scale(' + (gw ? box.w / gw : 1) + ',' + (gh ? box.h / gh : 1) + ') translate(' + (-(box.chX || 0)) + 'px,' + (-(box.chY || 0)) + 'px)';
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
        if (rel) {
            this.pending.push(self.deck.zip.blobUrl(rel.target).then(function (u) { if (u) img.src = u; else holder.style.background = 'rgba(0,0,0,0.04)'; }));
        }
    };

    Ctx.prototype.renderFrame = function (gf, box, inner) {
        var gd = path(gf, 'a:graphic', 'a:graphicData');
        var tbl = gd && kid(gd, NS_A, 'tbl');
        if (tbl) { this.renderTable(tbl, box, inner); return; }
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
                    if (rels && rels[rid]) this.pending.push(this.deck.zip.blobUrl(rels[rid].target).then(function (u) { if (u) stageEl.style.background = 'url("' + u + '") center/cover no-repeat'; }));
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
            case 1: return { kf: [{ opacity: 0 }, { opacity: 0 }], dur: 1, appear: true };
            case 2: return { kf: [{ transform: from(st || 4) }, { transform: 'translate(0,0)' }] };
            case 3: case 5: case 14: case 18: case 20: case 21: return { kf: [{ opacity: 0 }, { opacity: 1 }] };   // blinds/checker/bars/strips/wedge/wheel → fade
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
        this.frame.style.width = deck.width + 'px'; this.frame.style.height = deck.height + 'px';
        container.appendChild(this.frame);
        this.scale = 1;
        this.resize();
        var self = this;
        this._ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(function () { self.resize(); }) : null;
        if (this._ro) this._ro.observe(container);
    }

    Player.prototype.resize = function () {
        var c = this.container, W = this.deck.width, H = this.deck.height;
        var cw = c.clientWidth, ch = c.clientHeight;
        if (!cw || !ch) return;
        var s = Math.min(cw / W, ch / H);
        this.scale = s;
        this.frame.style.transform = 'scale(' + s + ')';
        this.frame.style.marginLeft = Math.max(0, (cw - W * s) / 2) + 'px';
        this.frame.style.marginTop = Math.max(0, (ch - H * s) / 2) + 'px';
        this.frame.style.marginRight = (-(W - W * s)) + 'px'; this.frame.style.marginBottom = (-(H - H * s)) + 'px';
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
                    var kf = k.kf.slice();
                    a = el.animate(kf, Object.assign({}, opts, { direction: e.cls === 'exit' ? 'reverse' : 'normal', composite: 'add' }));
                    if (k.appear) { opts.duration = 1; }
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
        if (this.busy && this._stepDone) { this._stepDone(); return Promise.resolve(); }
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
