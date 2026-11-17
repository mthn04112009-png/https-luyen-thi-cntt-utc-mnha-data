/* ============================================================
 * studyFileForm.js — Trang UP / SỬA  Slide bài học (/slides)  và  Tài liệu học tập (/documents)
 *
 *  File lớn không gửi được 1 request (Vercel cắt > 4.5MB) và mỗi file lưu trên GitHub phải ≤ 23MB, nên:
 *   1. Cắt file thành phần 2MB → xin khoá khung ở {base}/dashboard/upload-keys → MÃ HOÁ NGAY TRONG TRÌNH DUYỆT (Web Crypto, AES-256-GCM)
 *      → POST {base}/dashboard/upload-chunk (khung nhị phân đã mã hoá; server KHÔNG mã hoá, chỉ lưu tạm thành blob, trả sha)
 *   2. Gom các khung thành file-phần ≤ 23MB (cùng công thức với server: config/studyFileConfig.js groupFrames)
 *      → POST {base}/dashboard/upload-part  (mỗi file-phần 1 request: *.pdf  hoặc  *-1.pdf, *-2.pdf, …)
 *   3. POST {base}/dashboard (tạo) | {base}/dashboard/:id (sửa) kèm danh sách file-phần → server ghi JSON
 *
 *  Khi server đã cấu hình Cloudflare R2 (S.direct): bỏ bước 1–2 — trình duyệt mã hoá, ghép từng file-phần rồi PUT THẲNG lên R2 bằng URL ký sẵn
 *  ({base}/dashboard/direct-init → PUT R2 → {base}/dashboard/direct-done), dữ liệu không đi qua Vercel. Lỗi → tự quay về cách cũ.
 * ============================================================ */
(function () {
    'use strict';

    /** Chia các khung thành file-phần: mỗi file ≤ partMaxBytes. PHẢI giống groupFrames() của server. */
    function groupFrames(sizes, S) {
        var parts = [], start = 0, bytes = S.magicBytes, count = 0;
        for (var i = 0; i < sizes.length; i++) {
            var f = sizes[i] + S.frameOverhead;
            if (count > 0 && bytes + f > S.partMaxBytes) { parts.push({ startFrame: start, count: count }); start = i; bytes = S.magicBytes; count = 0; }
            bytes += f; count++;
        }
        if (count > 0) parts.push({ startFrame: start, count: count });
        return parts;
    }

    function frameSizes(total, S) {
        var n = Math.max(1, Math.ceil(total / S.frameBytes)), out = [];
        for (var i = 0; i < n; i++) out.push(Math.min(S.frameBytes, total - i * S.frameBytes));
        return out;
    }

    // ------------------------------------------------------------
    // MÃ HOÁ NGAY TRONG TRÌNH DUYỆT (Web Crypto, AES-256-GCM) — cùng định dạng "SLD2" với services/slideCryptoService.js
    //   khung = index(4,BE) | total(4,BE) | ctLen(4,BE) | salt(16) | iv(12) | authTag(16) | ciphertext
    //   AAD   = "SLD2" | index(4,BE) | total(4,BE)
    //   khoá khung = HKDF(master, salt) do SERVER tính rồi trả về (POST /dashboard/upload-keys); khoá gốc không rời server.
    // ------------------------------------------------------------
    var SUBTLE = (function () { var c = (typeof window !== 'undefined' ? window.crypto : globalThis.crypto); return c && c.subtle ? c : null; })();
    var MAGIC = [0x53, 0x4c, 0x44, 0x32];   // "SLD2"
    function putU32(a, o, n) { a[o] = n >>> 24; a[o + 1] = (n >>> 16) & 255; a[o + 2] = (n >>> 8) & 255; a[o + 3] = n & 255; }
    function toB64u(u8) {
        var s = ''; for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
        return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    function fromB64u(str) {
        var b = atob(String(str).replace(/-/g, '+').replace(/_/g, '/'));
        var u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
        return u;
    }
    function frameAad(index, total) {
        var a = new Uint8Array(12); a.set(MAGIC, 0); putU32(a, 4, index); putU32(a, 8, total); return a;
    }
    function newSalt() { var s = new Uint8Array(16); SUBTLE.getRandomValues(s); return s; }
    /** plain: ArrayBuffer | Uint8Array; keyB64u: khoá 32 byte của salt này → Promise<Uint8Array khung hoàn chỉnh> */
    function encryptFrame(plain, index, total, salt, keyB64u) {
        var iv = new Uint8Array(12); SUBTLE.getRandomValues(iv);
        return SUBTLE.subtle.importKey('raw', fromB64u(keyB64u), { name: 'AES-GCM' }, false, ['encrypt']).then(function (k) {
            return SUBTLE.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: frameAad(index, total), tagLength: 128 }, k, plain);
        }).then(function (buf) {
            var out = new Uint8Array(buf), ctLen = out.length - 16;     // Web Crypto trả ciphertext || tag
            var frame = new Uint8Array(12 + 16 + 12 + 16 + ctLen);
            putU32(frame, 0, index); putU32(frame, 4, total); putU32(frame, 8, ctLen);
            frame.set(salt, 12); frame.set(iv, 28); frame.set(out.subarray(ctLen), 40); frame.set(out.subarray(0, ctLen), 56);
            return frame;
        });
    }

    var api = { groupFrames: groupFrames, frameSizes: frameSizes, encryptFrame: encryptFrame, newSalt: newSalt, toB64u: toB64u, fromB64u: fromB64u };
    if (typeof window !== 'undefined') window.StudyFileForm = api;
    var stateEl = typeof document !== 'undefined' && document.getElementById('slState');
    if (!stateEl) return;

    var $ = function (id) { return document.getElementById(id); };
    var S = JSON.parse(stateEl.textContent);

    var els = {
        subject: $('slSubject'), title: $('slTitle'), desc: $('slDesc'), pub: $('slPub'), file: $('slFile'),
        info: $('slFileInfo'), current: $('slCurrent'), msg: $('slMsg'), save: $('slSave'),
        prog: $('slProgress'), bar: $('slBar'), progText: $('slProgressText')
    };

    els.subject.value = S.subjectId || '';
    els.title.value = S.title || '';
    els.desc.value = S.description || '';
    els.pub.checked = S.isPublished !== false;

    function mbText(n) { return (n / 1e6).toFixed(n >= 10e6 ? 0 : 1) + 'MB'; }
    function extOf(name) { var m = /\.([a-z0-9]+)$/i.exec(name || ''); return m ? m[1].toLowerCase() : ''; }
    var extList = S.exts.map(function (x) { return '.' + x; }).join(', ');
    var hint = 'Chỉ nhận ' + extList + ', tối đa ' + mbText(S.maxBytes) + '. File lớn hơn ' + mbText(S.partMaxBytes) + ' được chia nhỏ khi lưu.';
    if (els.current && S.fileName) {
        els.current.textContent = 'File hiện tại: ' + S.fileName + (S.fileSize ? ' (' + mbText(S.fileSize) + (S.fileParts > 1 ? ', chia ' + S.fileParts + ' file' : '') + ')' : '');
    }
    els.info.textContent = hint;

    function showMsg(kind, text) {
        els.msg.className = 'mb-4 p-4 rounded-xl text-sm ' + (kind === 'ok'
            ? 'bg-green-50 border border-green-200 text-green-800' : 'bg-red-50 border border-red-200 text-red-800');
        els.msg.textContent = text;
        els.msg.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    function hideMsg() { els.msg.className = 'hidden'; }
    function servedTag() { var n = window.MnhaData && window.MnhaData.label(); return n ? '  · qua web kết nối: ' + n : ''; }
    function setProgress(pct, text) {
        els.prog.classList.remove('hidden');
        els.bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
        els.progText.textContent = (text || '') + (text ? servedTag() : '');
    }

    if (!S.encryptionReady) showMsg('err', 'Máy chủ chưa cấu hình ENCRYPTION_MASTER_KEY (64 ký tự hex) nên chưa thể mã hoá và lưu file.');

    els.file.addEventListener('change', function () {
        var f = els.file.files && els.file.files[0];
        if (!f) { els.info.textContent = hint; return; }
        var ext = extOf(f.name);
        if (S.exts.indexOf(ext) === -1) { els.info.textContent = '❌ Chỉ nhận ' + extList + '.'; els.file.value = ''; return; }
        if (f.size > S.maxBytes) { els.info.textContent = '❌ File ' + mbText(f.size) + ' vượt giới hạn ' + mbText(S.maxBytes) + '.'; els.file.value = ''; return; }
        if (wantsConvert(ext)) { els.info.textContent = f.name + ' — ' + mbText(f.size) + ' → sẽ tự đổi sang PDF rồi mới up.'; return; }
        var n = groupFrames(frameSizes(f.size, S), S).length;
        els.info.textContent = f.name + ' — ' + mbText(f.size) + (n > 1 ? ' → sẽ lưu thành ' + n + ' file (-1 … -' + n + ')' : '');
    });

    // Đọc phản hồi an toàn: Vercel có thể trả HTML/text (413, 504…) thay vì JSON
    function readJson(res) {
        return res.text().then(function (txt) {
            var data = null;
            try { data = JSON.parse(txt); } catch (e) { data = null; }
            if (!res.ok || !data || !data.success) {
                var m = data && data.message;
                if (!m) {
                    m = res.status === 413 ? 'Dữ liệu gửi lên quá lớn so với giới hạn máy chủ.'
                        : res.status === 504 || res.status === 502 ? 'Máy chủ xử lý quá lâu (hết thời gian). Hãy thử lại.'
                        : 'Máy chủ trả HTTP ' + res.status + (txt ? ': ' + txt.replace(/<[^>]+>/g, ' ').trim().slice(0, 140) : '');
                }
                var err = new Error(m); err.status = res.status; throw err;
            }
            return data;
        });
    }
    // upload-chunk / upload-part đi THẲNG web kết nối (nếu có); tạo / cập nhật bản ghi đi web hiện tại
    function postJson(url, body) {
        var f = (window.MnhaData && /\/dashboard\/upload-(chunk|part)$/.test(url)) ? window.MnhaData.fetch : function (u, o) { return fetch(u, o); };
        return f(url, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(body)
        }).then(readJson);
    }
    // Gửi 1 khung ĐÃ MÃ HOÁ (nhị phân) — đi THẲNG web kết nối nếu có, giống upload-part
    function postFrame(index, total, ext, frame) {
        var path = S.base + '/dashboard/upload-chunk?index=' + index + '&total=' + total + '&ext=' + encodeURIComponent(ext);
        var f = window.MnhaData ? window.MnhaData.fetch : function (u, o) { return fetch(u, o); };
        return f(path, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/octet-stream', 'Accept': 'application/json' },
            body: frame
        }).then(readJson);
    }
    // Xin khoá cho một lô salt (web chính cấp; khoá gốc ở server, chỉ nhận khoá riêng từng khung)
    function requestUploadKeys(salts) {
        return fetch(S.base + '/dashboard/upload-keys', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ salts: salts.map(toB64u) })
        }).then(readJson).then(function (d) {
            if (!d.keys || d.keys.length !== salts.length) throw new Error('Máy chủ trả khoá không đủ.');
            return d.keys;
        });
    }
    // thử lại tối đa 3 lần với lỗi mạng / 5xx (không thử lại lỗi 4xx)
    function withRetry(fn) {
        var attempt = 0;
        function go() {
            attempt++;
            return fn().catch(function (e) {
                var retriable = !e.status || e.status >= 500;
                if (retriable && attempt < 3) return new Promise(function (r) { setTimeout(r, 900 * attempt); }).then(go);
                throw e;
            });
        }
        return go();
    }

    function randomHex(n) {
        var a = new Uint8Array(n / 2); (window.crypto || window.msCrypto).getRandomValues(a);
        return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    }

    function uploadFile(file, ext, body) {
        if (!SUBTLE) return Promise.reject(new Error('Trình duyệt không hỗ trợ Web Crypto (cần mở trang bằng HTTPS hoặc localhost) nên chưa mã hoá được file.'));
        var sizes = frameSizes(file.size, S), total = sizes.length;
        var groups = groupFrames(sizes, S);
        var uid = randomHex(16), ts = Math.floor(Date.now() / 1000);
        var shas = [], parts = [];

        var KEY_BATCH = 16, pre = {};      // pre[i] = { salt, key } — khoá xin theo lô để đỡ phải gọi từng khung
        function ensureKeys(i) {
            if (pre[i]) return Promise.resolve();
            var n = Math.min(KEY_BATCH, total - i), salts = [];
            for (var j = 0; j < n; j++) salts.push(newSalt());
            return withRetry(function () { return requestUploadKeys(salts); }).then(function (keys) {
                for (var j = 0; j < n; j++) pre[i + j] = { salt: salts[j], key: keys[j] };
            });
        }
        function chunkStep(i) {
            if (i >= total) return Promise.resolve();
            setProgress(Math.round(i / total * 80), '⏳ Đang mã hoá (trong trình duyệt) và tải phần ' + (i + 1) + '/' + total + '…');
            var blob = file.slice(i * S.frameBytes, Math.min(file.size, (i + 1) * S.frameBytes));
            return ensureKeys(i).then(function () { return blob.arrayBuffer(); }).then(function (plain) {
                return encryptFrame(plain, i, total, pre[i].salt, pre[i].key);
            }).then(function (frame) {
                delete pre[i];
                return withRetry(function () { return postFrame(i, total, ext, frame); });
            }).then(function (d) { shas.push(d.sha); return chunkStep(i + 1); });
        }
        function partStep(k) {
            if (k >= groups.length) return Promise.resolve();
            var g = groups[k];
            setProgress(80 + Math.round(k / groups.length * 18), '⏳ Đang gộp và lưu file ' + (k + 1) + '/' + groups.length + ' lên GitHub (có thể mất vài chục giây)…');
            var req = {
                title: body.title, ext: ext, uid: uid, ts: ts, partIndex: k, partCount: groups.length,
                startFrame: g.startFrame, totalFrames: total, shas: shas.slice(g.startFrame, g.startFrame + g.count)
            };
            if (S.id) req.id = S.id; else req.subjectId = body.subjectId;
            return withRetry(function () { return postJson(S.base + '/dashboard/upload-part', req); }).then(function (d) { parts.push(d.part); return partStep(k + 1); });
        }
        function legacy() {
            shas.length = 0; parts.length = 0;
            return chunkStep(0).then(function () { return partStep(0); }).then(function () {
                return { name: file.name, ext: ext, uid: uid, ts: ts, parts: parts };
            });
        }

        // ---- UP THẲNG LÊN R2 (S.direct = server đã cấu hình Cloudflare R2): mã hoá ngay trong trình duyệt, ghép từng file-phần (magic + khung)
        //      rồi PUT THẲNG lên R2 bằng URL ký sẵn → dữ liệu KHÔNG đi qua Vercel. Lỗi (CORS, mạng, R2…) → tự quay về cách cũ (qua máy chủ → GitHub).
        function directFlow() {
            var req = { title: body.title, ext: ext, uid: uid, ts: ts, size: file.size };
            if (S.id) req.id = S.id; else req.subjectId = body.subjectId;
            setProgress(2, '⏳ Đang xin URL tải thẳng lên Cloudflare R2…');
            return withRetry(function () { return postJson(S.base + '/dashboard/direct-init', req); }).then(function (plan) {
                var P = plan.parts;
                if (!P || P.length !== groups.length) throw new Error('Máy chủ chia file-phần khác trình duyệt.');
                function putR2(url, blob) {
                    return fetch(url, { method: 'PUT', body: blob }).then(function (r) {
                        if (!r.ok) { var e = new Error('R2 trả HTTP ' + r.status); e.status = r.status; throw e; }
                    });
                }
                function partStepR2(k) {
                    if (k >= P.length) return Promise.resolve();
                    var g = groups[k], pieces = [new Uint8Array(MAGIC)], end = g.startFrame + g.count;
                    function frameStep(i) {
                        if (i >= end) return Promise.resolve();
                        setProgress(Math.round(i / total * 90), '⏳ Đang mã hoá (trong trình duyệt) phần ' + (i + 1) + '/' + total + '…');
                        var blob = file.slice(i * S.frameBytes, Math.min(file.size, (i + 1) * S.frameBytes));
                        return ensureKeys(i).then(function () { return blob.arrayBuffer(); }).then(function (plain) {
                            return encryptFrame(plain, i, total, pre[i].salt, pre[i].key);
                        }).then(function (frame) { delete pre[i]; pieces.push(frame); return frameStep(i + 1); });
                    }
                    return frameStep(g.startFrame).then(function () {
                        var blob = new Blob(pieces);
                        if (blob.size !== P[k].enc) throw new Error('Kích thước file-phần ' + (k + 1) + ' lệch so với máy chủ (' + blob.size + ' ≠ ' + P[k].enc + ').');
                        setProgress(Math.round(end / total * 90), '⏳ Đang tải file ' + (k + 1) + '/' + P.length + ' THẲNG lên Cloudflare R2 (' + mbText(blob.size) + ')…');
                        return withRetry(function () { return putR2(P[k].url, blob); });
                    }).then(function () { return partStepR2(k + 1); });
                }
                return partStepR2(0);
            }).then(function () {
                setProgress(95, '⏳ Đang xác nhận file trên R2…');
                var req2 = { title: body.title, ext: ext, uid: uid, ts: ts, size: file.size };
                if (S.id) req2.id = S.id; else req2.subjectId = body.subjectId;
                return withRetry(function () { return postJson(S.base + '/dashboard/direct-done', req2); });
            }).then(function (d) {
                return { name: file.name, ext: ext, uid: uid, ts: ts, parts: d.parts };
            });
        }

        if (!S.direct) return legacy();
        return directFlow().catch(function (e) {
            setProgress(0, '⚠ Không up thẳng lên R2 được (' + ((e && e.message) || 'lỗi') + ') — chuyển sang up qua máy chủ…');
            return legacy();
        });
    }

    // ------------------------------------------------------------
    // PPTX/PPT → PDF tự động (qua dịch vụ Python converter/server.py) rồi up PDF như bình thường.
    // Chỉ chạy khi: server đặt PPTX_CONVERTER_URL, mục này nhận PDF, và file chọn là .pptx/.ppt.
    // ------------------------------------------------------------
    function wantsConvert(ext) {
        return !!S.converterUrl && (ext === 'pptx' || ext === 'ppt') && S.exts.indexOf('pdf') !== -1;
    }
    function convertToPdf(file) {
        var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, 300000);
        var headers = { 'Content-Type': 'application/octet-stream' };
        if (S.converterToken) headers['X-Converter-Token'] = S.converterToken;
        return fetch(S.converterUrl.replace(/\/+$/, '') + '/convert?name=' + encodeURIComponent(file.name), {
            method: 'POST', headers: headers, body: file, signal: ctl.signal
        }).then(function (r) {
            if (!r.ok) return r.text().then(function (t) { throw new Error(t && t.length < 300 ? t : 'Dịch vụ đổi PDF trả HTTP ' + r.status); });
            return r.blob();
        }).then(function (blob) {
            clearTimeout(timer);
            if (!blob.size) throw new Error('PDF rỗng.');
            return new File([blob], file.name.replace(/\.[a-z0-9]+$/i, '') + '.pdf', { type: 'application/pdf' });
        }).catch(function (e) {
            clearTimeout(timer);
            var m = e && e.name === 'AbortError' ? 'quá 5 phút' : (e && e.message === 'Failed to fetch' ? 'không kết nối được ' + S.converterUrl + ' (đã chạy converter/server.py chưa?)' : (e && e.message) || e);
            throw new Error('Không đổi được PPTX sang PDF: ' + m);
        });
    }

    var busy = false;
    els.save.addEventListener('click', function () {
        if (busy) return;
        hideMsg();
        if (!els.subject.value) { showMsg('err', 'Vui lòng chọn môn học.'); els.subject.focus(); return; }
        if (!els.title.value.trim()) { showMsg('err', 'Vui lòng nhập tiêu đề.'); els.title.focus(); return; }
        var file = els.file.files && els.file.files[0];
        if (!S.id && !file) { showMsg('err', 'Vui lòng chọn file.'); els.file.focus(); return; }
        var ext = file ? extOf(file.name) : '';
        if (file && S.exts.indexOf(ext) === -1) { showMsg('err', 'Chỉ nhận ' + extList + '.'); return; }
        if (file && file.size > S.maxBytes) { showMsg('err', 'File vượt giới hạn ' + mbText(S.maxBytes) + '.'); return; }

        busy = true; els.save.disabled = true;
        var body = {
            subjectId: els.subject.value, title: els.title.value.trim(), description: els.desc.value.trim(), isPublished: els.pub.checked
        };
        if (S.id) body.sha = S.sha;

        var prepared = !file ? Promise.resolve(null)
            : wantsConvert(ext)
                ? (setProgress(5, '⏳ Đang đổi ' + file.name + ' sang PDF (có thể mất vài chục giây)…'), convertToPdf(file)).then(function (pdf) { return uploadFile(pdf, 'pdf', body); })
                : uploadFile(file, ext, body);
        prepared.then(function (fileInfo) {
            if (fileInfo) body.file = fileInfo;
            setProgress(file ? 99 : 50, '⏳ Đang lưu thông tin…');
            return postJson(S.id ? S.base + '/dashboard/' + S.id : S.base + '/dashboard', body);
        }).then(function (d) {
            setProgress(100, '✓ Hoàn tất');
            window.location.href = d.redirect || (S.base + '/dashboard');
        }).catch(function (e) {
            busy = false; els.save.disabled = false;
            els.prog.classList.add('hidden');
            showMsg('err', e.message || 'Không lưu được.');
        });
    });
})();
