/* quizEncImage.js — TỰ GIẢI MÃ ảnh câu hỏi đã mã hoá (nút "🔒 Tải ảnh (mã hoá)" ở /admin/quiz).
 *
 * Ảnh mã hoá có link dạng  https://raw.githubusercontent.com/<owner>/<repo>/<branch>/cache/image/<ts>.enc
 * Script này theo dõi mọi <img> trên trang (kể cả ảnh được vẽ thêm khi sang câu mới / xem lại bài / xem trước ở trình soạn):
 *   thấy <img src="…/cache/image/*.enc"> → tải bản mã → xin khoá ở POST /api/quiz-image/keys (cần đăng nhập + được duyệt)
 *   → giải mã bằng Web Crypto (AES-256-GCM) → gán ảnh thật (blob:) vào <img>. Không cần kiểm duyệt vì bản lưu trên GitHub luôn là bản mã.
 * Định dạng file: "QIM1"(4) | salt(16) | iv(12) | authTag(16) | ciphertext ; AAD = "QIM1" (xem services/quizImageCryptoService.js).
 */
(function () {
    'use strict';
    if (window.MnhaQuizEncImage) return;

    var ENC_RE = /^https:\/\/raw\.githubusercontent\.com\/[^?#]+\/cache\/image\/[^\/?#]+\.enc(?:[?#].*)?$/i;
    var BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
    var MAGIC = [0x51, 0x49, 0x4d, 0x31];   // "QIM1"
    var SUBTLE = window.crypto && window.crypto.subtle;

    function fromB64u(str) {
        var b = atob(String(str).replace(/-/g, '+').replace(/_/g, '/'));
        var u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
        return u;
    }
    function toB64u(u8) {
        var s = ''; for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
        return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    function sniffMime(u) {
        if (u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47) return 'image/png';
        if (u[0] === 0xff && u[1] === 0xd8) return 'image/jpeg';
        if (u[0] === 0x47 && u[1] === 0x49 && u[2] === 0x46) return 'image/gif';
        if (u[0] === 0x42 && u[1] === 0x4d) return 'image/bmp';
        if (u[0] === 0x52 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x46 && u[8] === 0x57 && u[9] === 0x45) return 'image/webp';
        if (u[4] === 0x66 && u[5] === 0x74 && u[6] === 0x79 && u[7] === 0x70) return 'image/avif';
        return 'image/png';
    }

    // ---- xin khoá: gom nhiều ảnh xuất hiện cùng lúc vào 1 request ----
    var keyCache = {};          // salt(b64u) → Promise<khoá b64u>
    var pending = [];           // [{ salt, resolve, reject }]
    var timer = null;
    function postKeys(salts) {
        var f = window.MnhaData && window.MnhaData.fetch ? window.MnhaData.fetch : fetch;
        return f('/api/quiz-image/keys', {
            method: 'POST', credentials: 'same-origin', cache: 'no-store',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ salts: salts })
        }).then(function (r) {
            return r.text().then(function (t) {
                var j = null; try { j = JSON.parse(t); } catch (e) { j = null; }
                if (!r.ok || !j || !j.success || !j.keys || j.keys.length !== salts.length) {
                    throw new Error((j && j.message) || ('Không xin được khoá giải mã ảnh (HTTP ' + r.status + ')'));
                }
                return j.keys;
            });
        });
    }
    function flushKeys() {
        timer = null;
        var batch = pending; pending = [];
        for (var i = 0; i < batch.length; i += 24) {
            (function (part) {
                postKeys(part.map(function (x) { return x.salt; })).then(function (keys) {
                    part.forEach(function (x, k) { x.resolve(keys[k]); });
                }, function (e) { part.forEach(function (x) { delete keyCache[x.salt]; x.reject(e); }); });
            })(batch.slice(i, i + 24));
        }
    }
    function getKey(salt) {
        if (!keyCache[salt]) {
            keyCache[salt] = new Promise(function (resolve, reject) {
                pending.push({ salt: salt, resolve: resolve, reject: reject });
                if (!timer) timer = setTimeout(flushKeys, 30);
            });
        }
        return keyCache[salt];
    }

    // ---- tải + giải mã 1 ảnh (cache theo link: cùng ảnh ở nhiều chỗ chỉ giải mã 1 lần) ----
    var imgCache = {};          // link → Promise<blob URL>
    function decryptUrl(url) {
        if (imgCache[url]) return imgCache[url];
        var p = fetch(url, { cache: 'force-cache', referrerPolicy: 'no-referrer' }).then(function (r) {
            if (!r.ok) throw new Error('Không tải được ảnh mã hoá (HTTP ' + r.status + ')');
            return r.arrayBuffer();
        }).then(function (buf) {
            var u = new Uint8Array(buf);
            if (u.length < 48 + 1 || u[0] !== MAGIC[0] || u[1] !== MAGIC[1] || u[2] !== MAGIC[2] || u[3] !== MAGIC[3]) {
                throw new Error('File ảnh không đúng định dạng mã hoá.');
            }
            var salt = u.subarray(4, 20), iv = u.slice(20, 32), tag = u.subarray(32, 48), ct = u.subarray(48);
            var data = new Uint8Array(ct.length + 16); data.set(ct, 0); data.set(tag, ct.length);   // Web Crypto: ciphertext || tag
            return getKey(toB64u(salt)).then(function (k) {
                return SUBTLE.importKey('raw', fromB64u(k), { name: 'AES-GCM' }, false, ['decrypt']);
            }).then(function (key) {
                return SUBTLE.decrypt({ name: 'AES-GCM', iv: iv, additionalData: new Uint8Array(MAGIC), tagLength: 128 }, key, data);
            }).then(function (plain) {
                var pu = new Uint8Array(plain);
                return URL.createObjectURL(new Blob([pu], { type: sniffMime(pu) }));
            });
        });
        imgCache[url] = p;
        p.catch(function () { delete imgCache[url]; });   // lần sau thử lại được
        return p;
    }

    function handle(img) {
        if (!img || img.tagName !== 'IMG') return;
        var src = img.getAttribute('src') || '';
        if (!ENC_RE.test(src)) return;
        img.setAttribute('data-enc-src', src);
        img.src = BLANK;                       // chặn trình duyệt tự tải file mã hoá làm ảnh
        img.classList.add('enc-loading');
        img.classList.remove('enc-failed');
        if (!SUBTLE) { fail(img, 'Trình duyệt không hỗ trợ giải mã (cần HTTPS).'); return; }
        decryptUrl(src).then(function (blobUrl) {
            if (img.getAttribute('data-enc-src') !== src) return;     // ảnh đã bị đổi sang link khác trong lúc chờ
            img.classList.remove('enc-loading');
            img.src = blobUrl;
        }, function (e) { fail(img, e && e.message); });
    }
    function fail(img, msg) {
        img.classList.remove('enc-loading');
        img.classList.add('enc-failed');
        img.alt = '⚠ Không giải mã được ảnh' + (msg ? ' — ' + msg : '');
        img.title = img.alt;
        if (window.console) console.warn('[quizEncImage]', msg);
    }

    function scan(root) {
        if (!root || root.nodeType !== 1) return;
        if (root.tagName === 'IMG') { handle(root); return; }
        var list = root.querySelectorAll ? root.querySelectorAll('img') : [];
        for (var i = 0; i < list.length; i++) handle(list[i]);
    }

    function start() {
        scan(document.body);
        new MutationObserver(function (muts) {
            for (var i = 0; i < muts.length; i++) {
                var m = muts[i];
                if (m.type === 'attributes') handle(m.target);
                else for (var j = 0; j < m.addedNodes.length; j++) scan(m.addedNodes[j]);
            }
        }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    }

    var style = document.createElement('style');
    style.textContent = 'img.enc-loading{min-height:48px;min-width:48px;background:#f3f4f6;border-radius:8px}img.enc-failed{color:#b91c1c;font-size:12px}';
    document.head.appendChild(style);

    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
    window.MnhaQuizEncImage = { isEnc: function (u) { return ENC_RE.test(String(u || '')); }, decryptUrl: decryptUrl };
})();
