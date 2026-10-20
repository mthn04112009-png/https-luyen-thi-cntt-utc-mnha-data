/* ============================================================
 * studyFileForm.js — Trang UP / SỬA  Slide bài học (/slides)  và  Tài liệu học tập (/documents)
 *
 *  File lớn không gửi được 1 request (Vercel cắt > 4.5MB) và mỗi file lưu trên GitHub phải ≤ 23MB, nên:
 *   1. Cắt file thành phần 2MB  → POST {base}/dashboard/upload-chunk  (server mã hoá 1 khung, lưu tạm thành blob, trả sha)
 *   2. Gom các khung thành file-phần ≤ 23MB (cùng công thức với server: config/studyFileConfig.js groupFrames)
 *      → POST {base}/dashboard/upload-part  (mỗi file-phần 1 request: *.pdf  hoặc  *-1.pdf, *-2.pdf, …)
 *   3. POST {base}/dashboard (tạo) | {base}/dashboard/:id (sửa) kèm danh sách file-phần → server ghi JSON
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

    var api = { groupFrames: groupFrames, frameSizes: frameSizes };
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
    function setProgress(pct, text) {
        els.prog.classList.remove('hidden');
        els.bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
        els.progText.textContent = text || '';
    }

    if (!S.encryptionReady) showMsg('err', 'Máy chủ chưa cấu hình ENCRYPTION_MASTER_KEY (64 ký tự hex) nên chưa thể mã hoá và lưu file.');

    els.file.addEventListener('change', function () {
        var f = els.file.files && els.file.files[0];
        if (!f) { els.info.textContent = hint; return; }
        var ext = extOf(f.name);
        if (S.exts.indexOf(ext) === -1) { els.info.textContent = '❌ Chỉ nhận ' + extList + '.'; els.file.value = ''; return; }
        if (f.size > S.maxBytes) { els.info.textContent = '❌ File ' + mbText(f.size) + ' vượt giới hạn ' + mbText(S.maxBytes) + '.'; els.file.value = ''; return; }
        var n = groupFrames(frameSizes(f.size, S), S).length;
        els.info.textContent = f.name + ' — ' + mbText(f.size) + (n > 1 ? ' → sẽ lưu thành ' + n + ' file (-1 … -' + n + ')' : '');
    });

    function blobToBase64(blob) {
        return new Promise(function (resolve, reject) {
            var r = new FileReader();
            r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };
            r.onerror = function () { reject(new Error('Không đọc được file.')); };
            r.readAsDataURL(blob);
        });
    }

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
    function postJson(url, body) {
        return fetch(url, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(body)
        }).then(readJson);
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
        var sizes = frameSizes(file.size, S), total = sizes.length;
        var groups = groupFrames(sizes, S);
        var uid = randomHex(16), ts = Math.floor(Date.now() / 1000);
        var shas = [], parts = [];

        function chunkStep(i) {
            if (i >= total) return Promise.resolve();
            setProgress(Math.round(i / total * 80), '⏳ Đang mã hoá và tải phần ' + (i + 1) + '/' + total + '…');
            var blob = file.slice(i * S.frameBytes, Math.min(file.size, (i + 1) * S.frameBytes));
            return blobToBase64(blob).then(function (b64) {
                return withRetry(function () { return postJson(S.base + '/dashboard/upload-chunk', { index: i, total: total, ext: ext, data: b64 }); });
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
        return chunkStep(0).then(function () { return partStep(0); }).then(function () {
            return { name: file.name, ext: ext, uid: uid, ts: ts, parts: parts };
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

        (file ? uploadFile(file, ext, body) : Promise.resolve(null)).then(function (fileInfo) {
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
