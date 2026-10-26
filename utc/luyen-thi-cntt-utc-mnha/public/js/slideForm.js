/* ============================================================
 * slideForm.js — Trang UP / SỬA slide (/slides/dashboard/new, /:id/edit)
 *  PDF tới 20MB không gửi 1 request được (Vercel cắt > 4.5MB) nên:
 *   1. cắt file thành phần 2MB
 *   2. mỗi phần: POST /slides/dashboard/upload-chunk  → server mã hoá + lưu tạm blob GitHub → trả sha
 *   3. POST /slides/dashboard (tạo) | /slides/dashboard/:id (sửa) kèm danh sách sha → server gộp thành 1 file .pdf mã hoá
 * ============================================================ */
(function () {
    'use strict';

    var $ = function (id) { return document.getElementById(id); };
    var S = JSON.parse($('slState').textContent);
    var CHUNK = 2 * 1024 * 1024;

    var els = {
        subject: $('slSubject'), title: $('slTitle'), desc: $('slDesc'), pub: $('slPub'), file: $('slFile'),
        info: $('slFileInfo'), current: $('slCurrent'), msg: $('slMsg'), save: $('slSave'),
        prog: $('slProgress'), bar: $('slBar'), progText: $('slProgressText')
    };

    els.subject.value = S.subjectId || '';
    els.title.value = S.title || '';
    els.desc.value = S.description || '';
    els.pub.checked = S.isPublished !== false;

    function mbText(n) { return (n / 1048576).toFixed(n >= 10 * 1048576 ? 0 : 1) + 'MB'; }
    if (els.current && S.fileName) els.current.textContent = 'File hiện tại: ' + S.fileName + (S.fileSize ? ' (' + mbText(S.fileSize) + ')' : '');
    els.info.textContent = 'Chỉ nhận file .pdf, tối đa ' + mbText(S.maxBytes) + '.';

    function showMsg(kind, text) {
        els.msg.className = 'mb-4 p-4 rounded-xl text-sm ' + (kind === 'ok'
            ? 'bg-green-50 border border-green-200 text-green-800'
            : 'bg-red-50 border border-red-200 text-red-800');
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

    if (!S.encryptionReady) {
        showMsg('err', 'Máy chủ chưa cấu hình ENCRYPTION_MASTER_KEY (64 ký tự hex) nên chưa thể mã hoá và lưu PDF.');
    }

    els.file.addEventListener('change', function () {
        var f = els.file.files && els.file.files[0];
        if (!f) { els.info.textContent = 'Chỉ nhận file .pdf, tối đa ' + mbText(S.maxBytes) + '.'; return; }
        if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') { els.info.textContent = '❌ Chỉ nhận file PDF.'; els.file.value = ''; return; }
        if (f.size > S.maxBytes) { els.info.textContent = '❌ File ' + mbText(f.size) + ' vượt giới hạn ' + mbText(S.maxBytes) + '.'; els.file.value = ''; return; }
        els.info.textContent = f.name + ' — ' + mbText(f.size);
    });

    function blobToBase64(blob) {
        return new Promise(function (resolve, reject) {
            var r = new FileReader();
            r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };
            r.onerror = function () { reject(new Error('Không đọc được file PDF.')); };
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

    // upload-chunk đi THẲNG web kết nối (nếu có); phần còn lại (lưu thông tin) đi web hiện tại
    function postJson(url, body) {
        var f = (window.MnhaData && /\/dashboard\/upload-(chunk|part)$/.test(url)) ? window.MnhaData.fetch : function (u, o) { return fetch(u, o); };
        return f(url, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(body)
        }).then(readJson);
    }

    // 1 phần, thử lại tối đa 3 lần với lỗi mạng / 5xx (không thử lại lỗi 4xx)
    function sendChunk(blob, index, total) {
        return blobToBase64(blob).then(function (b64) {
            var attempt = 0;
            function go() {
                attempt++;
                return postJson('/slides/dashboard/upload-chunk', { index: index, total: total, data: b64 }).catch(function (e) {
                    var retriable = !e.status || e.status >= 500;
                    if (retriable && attempt < 3) return new Promise(function (r) { setTimeout(r, 800 * attempt); }).then(go);
                    throw e;
                });
            }
            return go();
        });
    }

    function uploadFile(file) {
        var total = Math.max(1, Math.ceil(file.size / CHUNK));
        var shas = [];
        var i = 0;
        function next() {
            if (i >= total) return Promise.resolve(shas);
            var idx = i;
            setProgress(Math.round(idx / total * 90), '⏳ Đang mã hoá và tải phần ' + (idx + 1) + '/' + total + '…');
            return sendChunk(file.slice(idx * CHUNK, Math.min(file.size, (idx + 1) * CHUNK)), idx, total).then(function (d) {
                shas.push(d.sha);
                i++;
                return next();
            });
        }
        return next();
    }

    var busy = false;
    els.save.addEventListener('click', function () {
        if (busy) return;
        hideMsg();
        if (!els.subject.value) { showMsg('err', 'Vui lòng chọn môn học.'); els.subject.focus(); return; }
        if (!els.title.value.trim()) { showMsg('err', 'Vui lòng nhập tiêu đề.'); els.title.focus(); return; }
        var file = els.file.files && els.file.files[0];
        if (!S.id && !file) { showMsg('err', 'Vui lòng chọn file PDF.'); els.file.focus(); return; }
        if (file && file.size > S.maxBytes) { showMsg('err', 'File vượt giới hạn ' + mbText(S.maxBytes) + '.'); return; }

        busy = true;
        els.save.disabled = true;
        var body = {
            subjectId: els.subject.value,
            title: els.title.value.trim(),
            description: els.desc.value.trim(),
            isPublished: els.pub.checked
        };
        if (S.id) body.sha = S.sha;

        var step = file ? uploadFile(file) : Promise.resolve(null);
        step.then(function (shas) {
            if (shas) body.pdf = { name: file.name, shas: shas };
            setProgress(shas ? 92 : 50, shas ? '⏳ Đang gộp các phần thành 1 file PDF mã hoá rồi lưu lên GitHub (có thể mất vài chục giây)…' : '⏳ Đang lưu…');
            return postJson(S.id ? '/slides/dashboard/' + S.id : '/slides/dashboard', body);
        }).then(function (d) {
            setProgress(100, '✓ Hoàn tất');
            window.location.href = d.redirect || '/slides/dashboard';
        }).catch(function (e) {
            busy = false;
            els.save.disabled = false;
            els.prog.classList.add('hidden');
            showMsg('err', e.message || 'Không lưu được slide.');
        });
    });
})();
