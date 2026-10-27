/* ============================================================
 * videoForm.js — form thêm / sửa bài video (admin)  /videos/dashboard/new, /videos/dashboard/:id/edit
 * State từ <script id="vfState" type="application/json">. Gửi JSON { subjectId, title, description, isPublished, videos:[{id,title,code}], sha }.
 * Kiểm tra nhanh phía trình duyệt (đúng 1 thẻ iframe, https); server kiểm tra lại và MÃ HOÁ mã nhúng trước khi ghi GitHub.
 * ============================================================ */
(function () {
    'use strict';
    var S = JSON.parse(document.getElementById('vfState').textContent);
    var $ = function (id) { return document.getElementById(id); };
    var listEl = $('vfList'), msg = $('vfMsg'), saveBtn = $('vfSave');
    var items = (S.videos && S.videos.length ? S.videos : [{ id: '', title: '', code: '' }]).map(function (v) {
        return { id: v.id || '', title: v.title || '', code: v.code || '', broken: !!v.broken };
    });

    $('vfSubject').value = S.subjectId || '';
    $('vfTitle').value = S.title || '';
    $('vfDesc').value = S.description || '';
    $('vfPub').checked = S.isPublished !== false;

    function show(text, ok) {
        msg.textContent = text;
        msg.className = 'mb-4 p-4 rounded-xl text-sm ' + (ok ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-red-50 text-red-800 border border-red-200');
        msg.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    if (S.encryptionReady === false) show('Chưa cấu hình ENCRYPTION_MASTER_KEY (64 ký tự hex) nên chưa lưu được mã nhúng.', false);

    function check(code) {
        code = (code || '').trim();
        if (!code) return { ok: false, text: 'Chưa dán mã nhúng.' };
        var n = (code.match(/<iframe\b/gi) || []).length;
        if (n !== 1) return { ok: false, text: n ? 'Chỉ dán đúng 1 thẻ <iframe> cho mỗi video.' : 'Không thấy thẻ <iframe>.' };
        var m = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(code);
        if (!m) return { ok: false, text: 'Thiếu thuộc tính src.' };
        var src = (m[1] || m[2] || '').trim();
        if (src.indexOf('//') === 0) src = 'https:' + src;
        if (!/^https:\/\//i.test(src)) return { ok: false, text: 'Chỉ nhận mã nhúng dùng https.' };
        var host = src.replace(/^https:\/\//i, '').split(/[\/?#]/)[0];
        return { ok: true, text: 'Mã nhúng hợp lệ (' + host + ').' };
    }

    function render() {
        listEl.textContent = '';
        items.forEach(function (it, i) {
            var box = document.createElement('div'); box.className = 'vf-item' + (it.broken ? ' bad' : '');
            var top = document.createElement('div'); top.className = 'vf-item-top';
            var n = document.createElement('span'); n.className = 'n'; n.textContent = String(i + 1);
            var t = document.createElement('input'); t.type = 'text'; t.maxLength = 150; t.placeholder = 'Tiêu đề video (tuỳ chọn)'; t.value = it.title;
            t.addEventListener('input', function () { it.title = t.value; });
            var up = btn('↑', 'Lên', function () { move(i, -1); }); up.disabled = i === 0;
            var dn = btn('↓', 'Xuống', function () { move(i, 1); }); dn.disabled = i === items.length - 1;
            var del = btn('Xoá', 'Xoá video này', function () {
                if (items.length === 1) { it.code = ''; it.title = ''; it.id = ''; render(); return; }
                items.splice(i, 1); render();
            }); del.className += ' del';
            top.appendChild(n); top.appendChild(t); top.appendChild(up); top.appendChild(dn); top.appendChild(del);
            var ta = document.createElement('textarea'); ta.className = 'vf-code'; ta.spellcheck = false; ta.maxLength = S.maxEmbed || 4000;
            ta.placeholder = '<iframe width="560" height="315" src="https://www.youtube.com/embed/…" …></iframe>';
            ta.value = it.code;
            var hint = document.createElement('div'); hint.className = 'vf-hint';
            function upd() { var r = check(ta.value); hint.textContent = it.broken && !ta.value.trim() ? 'Không giải mã được video đã lưu — dán lại mã nhúng.' : r.text; hint.className = 'vf-hint ' + (ta.value.trim() ? (r.ok ? 'ok' : 'err') : ''); }
            ta.addEventListener('input', function () { it.code = ta.value; it.broken = false; box.className = 'vf-item'; upd(); });
            box.appendChild(top); box.appendChild(ta); box.appendChild(hint);
            listEl.appendChild(box); upd();
        });
        $('vfCount').textContent = items.length + ' / ' + S.maxVideos + ' video';
        $('vfAdd').disabled = items.length >= S.maxVideos;
        if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    }
    function btn(label, title, fn) {
        var b = document.createElement('button'); b.type = 'button'; b.className = 'vf-btn'; b.textContent = label; b.title = title;
        b.addEventListener('click', fn); return b;
    }
    function move(i, d) { var j = i + d; if (j < 0 || j >= items.length) return; var t = items[i]; items[i] = items[j]; items[j] = t; render(); }

    $('vfAdd').addEventListener('click', function () {
        if (items.length >= S.maxVideos) return;
        items.push({ id: '', title: '', code: '' }); render();
        var tas = listEl.querySelectorAll('textarea'); if (tas.length) tas[tas.length - 1].focus();
    });

    saveBtn.addEventListener('click', function () {
        var subjectId = $('vfSubject').value, title = $('vfTitle').value.trim();
        if (!subjectId) return show('Vui lòng chọn môn học.', false);
        if (!title) return show('Vui lòng nhập tiêu đề.', false);
        for (var i = 0; i < items.length; i++) {
            var r = check(items[i].code);
            if (!r.ok) return show('Video ' + (i + 1) + ': ' + r.text, false);
        }
        var body = {
            subjectId: subjectId, title: title, description: $('vfDesc').value.trim(), isPublished: $('vfPub').checked,
            videos: items.map(function (x) { return { id: x.id || undefined, title: x.title.trim(), code: x.code.trim() }; }),
            sha: S.sha || undefined
        };
        saveBtn.disabled = true;
        var url = S.id ? S.base + '/dashboard/' + S.id : S.base + '/dashboard';
        fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(body) })
            .then(function (r) { return r.json().catch(function () { return { success: false, message: 'Máy chủ trả lỗi ' + r.status }; }); })
            .then(function (d) {
                if (!d.success) { saveBtn.disabled = false; return show(d.message || 'Không lưu được.', false); }
                window.location.href = d.redirect || (S.base + '/dashboard');
            })
            .catch(function () { saveBtn.disabled = false; show('Lỗi mạng, thử lại.', false); });
    });

    render();
})();
