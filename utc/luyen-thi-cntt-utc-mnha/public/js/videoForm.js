/* ============================================================
 * videoForm.js — form thêm / sửa bài video (admin)  /videos/dashboard/new, /videos/dashboard/:id/edit
 * State từ <script id="vfState" type="application/json">. Gửi JSON { subjectId, title, description, visibility, allowedUserIds, isPublished, videos:[{id,title,code}], sha }.
 * visibility: 'public' (mọi sinh viên) | 'private' (chỉ admin) | 'users' (chỉ những người chọn — tìm theo họ tên / email / 1 đoạn tên, chọn nhiều người).
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
    var visibility = ['public', 'private', 'users'].indexOf(S.visibility) >= 0 ? S.visibility : (S.isPublished === false ? 'private' : 'public');

    function show(text, ok) {
        msg.textContent = text;
        msg.className = 'mb-4 p-4 rounded-xl text-sm ' + (ok ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-red-50 text-red-800 border border-red-200');
        msg.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    if (S.encryptionReady === false) show('Chưa cấu hình ENCRYPTION_MASTER_KEY (64 ký tự hex) nên chưa lưu được mã nhúng.', false);

    // ============================================================
    // Chế độ hiển thị + chọn nhiều người (giao diện giống ô chọn môn học ở /practice, thêm ô tìm + chọn nhiều)
    // ============================================================
    var selected = new Map();                                   // id → { id, name, email }
    (S.allowedUsers || []).forEach(function (u) { if (u && u.id) selected.set(u.id, { id: u.id, name: u.name || '', email: u.email || '' }); });
    var MAX_USERS = S.maxUsers || 300;
    var boxEl = $('vfUsersBox'), chipsEl = $('vfChips'), pickEl = $('vfUserPicker');

    function norm(t) {
        return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
    }
    function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    // Tô vàng mọi từ khoá khớp (so khớp trên bản bỏ dấu, map ngược về ký tự gốc)
    function highlight(text, tokens) {
        text = String(text || '');
        if (!tokens.length) return esc(text);
        var map = [], flat = '';
        for (var i = 0; i < text.length; i++) { var n = norm(text[i]); for (var j = 0; j < n.length; j++) { flat += n[j]; map.push(i); } }
        var ranges = [];
        tokens.forEach(function (tk) {
            var at = flat.indexOf(tk);
            if (at >= 0) ranges.push([map[at], map[at + tk.length - 1] + 1]);
        });
        if (!ranges.length) return esc(text);
        ranges.sort(function (a, b) { return a[0] - b[0]; });
        var merged = [ranges[0]];
        for (var k = 1; k < ranges.length; k++) {
            var last = merged[merged.length - 1];
            if (ranges[k][0] <= last[1]) last[1] = Math.max(last[1], ranges[k][1]); else merged.push(ranges[k]);
        }
        var out = '', pos = 0;
        merged.forEach(function (r) { out += esc(text.slice(pos, r[0])) + '<mark>' + esc(text.slice(r[0], r[1])) + '</mark>'; pos = r[1]; });
        return out + esc(text.slice(pos));
    }

    var CARET = '<svg class="sp-caret" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/></svg>';
    var SEARCH = '<svg class="sp-search-ico" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.45 4.39l3.58 3.58a.75.75 0 11-1.06 1.06l-3.58-3.58A7 7 0 012 9z" clip-rule="evenodd"/></svg>';
    var CHECK = '<svg class="sp-check" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 111.4-1.4l3.8 3.8 6.8-6.8a1 1 0 011.4 0z" clip-rule="evenodd"/></svg>';

    pickEl.innerHTML =
        '<button type="button" class="sp-btn" aria-haspopup="listbox" aria-expanded="false"><span class="sp-btn-text"></span>' + CARET + '</button>' +
        '<div class="sp-panel"><div class="sp-search-wrap">' + SEARCH + '<input type="text" class="sp-search" autocomplete="off" spellcheck="false" placeholder="Tìm theo họ tên hoặc email…" aria-label="Tìm người"></div>' +
        '<ul class="sp-list" role="listbox" aria-multiselectable="true"></ul><div class="sp-count"></div></div>';
    var pBtn = pickEl.querySelector('.sp-btn'), pBtnText = pickEl.querySelector('.sp-btn-text');
    var search = pickEl.querySelector('.sp-search'), list = pickEl.querySelector('.sp-list'), countEl = pickEl.querySelector('.sp-count');
    var results = [], total = 0, active = -1, loading = false, seq = 0, timer = null, lastQ = null, failed = false;

    function tokens() { return norm(search.value.trim()).split(/\s+/).filter(Boolean); }

    function syncSummary() {
        var n = selected.size;
        pBtnText.textContent = n ? 'Đã chọn ' + n + ' người — bấm để thêm / bỏ' : '— Chọn người được xem —';
        pBtnText.classList.toggle('sp-placeholder', !n);
        $('vfUsersCount').textContent = n + ' / ' + MAX_USERS + ' người';
        chipsEl.textContent = '';
        selected.forEach(function (u) {
            var c = document.createElement('div'); c.className = 'vf-chip';
            var t = document.createElement('span'); t.textContent = u.name || u.email; t.title = (u.name ? u.name + ' — ' : '') + u.email;
            c.appendChild(t);
            if (u.name && u.email) { var e = document.createElement('em'); e.textContent = u.email; c.appendChild(e); }
            var x = document.createElement('button'); x.type = 'button'; x.textContent = '×'; x.title = 'Bỏ ' + (u.name || u.email); x.setAttribute('aria-label', 'Bỏ ' + (u.name || u.email));
            x.addEventListener('click', function () { selected.delete(u.id); syncSummary(); if (isOpen()) renderList(false); });
            c.appendChild(x); chipsEl.appendChild(c);
        });
        if (n >= 2) {
            var clr = document.createElement('button'); clr.type = 'button'; clr.className = 'vf-chips-clear'; clr.textContent = 'Xoá tất cả';
            clr.addEventListener('click', function () { selected.clear(); syncSummary(); if (isOpen()) renderList(false); });
            chipsEl.appendChild(clr);
        }
    }

    function renderList(resetScroll) {
        var tk = tokens(), keep = list.scrollTop, html = '';
        results.forEach(function (u, i) {
            var sel = selected.has(u.id);
            html += '<li class="sp-item' + (sel ? ' sp-selected' : '') + '" role="option" data-i="' + i + '" aria-selected="' + sel + '" title="' + esc(u.name + ' — ' + u.email) + '"><span class="sp-item-text">' +
                highlight(u.name || '(chưa có tên)', tk) + '<small>' + highlight(u.email, tk) + '</small></span>' + CHECK + '</li>';
        });
        if (!results.length) html = '<li class="sp-empty">' + (loading ? 'Đang tìm…' : failed ? 'Không tải được danh sách, thử lại.' : 'Không tìm thấy người nào') + '</li>';
        list.innerHTML = html;
        list.scrollTop = resetScroll ? 0 : keep;
        var shown = results.length;
        var base = loading ? 'Đang tìm…' : (search.value.trim() ? total + ' người khớp' : total + ' sinh viên') + (total > shown ? ' (hiện ' + shown + ' đầu — gõ thêm để lọc)' : '');
        countEl.textContent = base + ' · đã chọn ' + selected.size;
        setActive(results.length ? Math.min(Math.max(active, 0), results.length - 1) : -1, false);
    }

    function setActive(i, scroll) {
        var els = list.querySelectorAll('.sp-item');
        if (active >= 0 && els[active]) els[active].classList.remove('sp-active');
        active = i;
        if (i >= 0 && els[i]) {
            els[i].classList.add('sp-active');
            if (scroll !== false) {
                var top = els[i].offsetTop, bottom = top + els[i].offsetHeight;
                if (top < list.scrollTop) list.scrollTop = top; else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
            }
        }
    }

    function load(q) {
        var my = ++seq; loading = true; failed = false; lastQ = q; renderList(true);
        fetch(S.base + '/dashboard/users?q=' + encodeURIComponent(q), { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (my !== seq) return;                         // đã có lần gõ mới hơn
                loading = false;
                if (!d || !d.success) { failed = true; results = []; total = 0; } else { results = d.users || []; total = d.total || results.length; }
                active = 0; renderList(true);
            })
            .catch(function () { if (my !== seq) return; loading = false; failed = true; results = []; total = 0; renderList(true); });
    }

    function toggle(i) {
        var u = results[i]; if (!u) return;
        if (selected.has(u.id)) selected.delete(u.id);
        else {
            if (selected.size >= MAX_USERS) return show('Mỗi bài chỉ chọn tối đa ' + MAX_USERS + ' người.', false);
            selected.set(u.id, { id: u.id, name: u.name, email: u.email });
        }
        syncSummary(); renderList(false);
    }

    function isOpen() { return pickEl.classList.contains('sp-open'); }
    function open() {
        if (isOpen()) return;
        pickEl.classList.add('sp-open'); pBtn.setAttribute('aria-expanded', 'true');
        var r = pBtn.getBoundingClientRect();
        pickEl.classList.toggle('sp-up', window.innerHeight - r.bottom < 330 && r.top > 330);
        search.value = ''; active = 0; load('');
        search.focus();
    }
    function close(focusBtn) {
        if (!isOpen()) return;
        pickEl.classList.remove('sp-open'); pBtn.setAttribute('aria-expanded', 'false');
        clearTimeout(timer); seq++; loading = false;
        if (focusBtn) pBtn.focus();
    }
    pBtn.addEventListener('click', function () { isOpen() ? close(true) : open(); });
    pBtn.addEventListener('keydown', function (e) { if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    search.addEventListener('input', function () {
        clearTimeout(timer);
        timer = setTimeout(function () { var q = search.value.trim(); if (q !== lastQ) load(q); }, 220);
    });
    search.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); if (results.length) setActive(Math.min(active + 1, results.length - 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); if (results.length) setActive(Math.max(active - 1, 0)); }
        else if (e.key === 'Enter') { e.preventDefault(); if (active >= 0) toggle(active); }
        else if (e.key === 'Escape') { e.preventDefault(); close(true); }
        else if (e.key === 'Tab') close(false);
    });
    list.addEventListener('mousemove', function (e) { var li = e.target.closest('.sp-item'); if (li) { var i = +li.dataset.i; if (i !== active) setActive(i, false); } });
    list.addEventListener('mousedown', function (e) { e.preventDefault(); });          // giữ focus ở ô tìm
    list.addEventListener('click', function (e) { var li = e.target.closest('.sp-item'); if (li) toggle(+li.dataset.i); });
    document.addEventListener('mousedown', function (e) { if (isOpen() && !pickEl.contains(e.target)) close(false); });

    function applyVisibility(v) {
        visibility = v;
        boxEl.classList.toggle('hidden', v !== 'users');
        Array.prototype.forEach.call(document.querySelectorAll('input[name="vfVisibility"]'), function (r) {
            r.checked = r.value === v; r.parentNode.classList.toggle('on', r.checked);
        });
        if (v !== 'users') close(false);
    }
    Array.prototype.forEach.call(document.querySelectorAll('input[name="vfVisibility"]'), function (r) {
        r.addEventListener('change', function () { if (r.checked) applyVisibility(r.value); });
    });
    syncSummary(); applyVisibility(visibility);

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
        if (visibility === 'users' && !selected.size) return show('Hãy chọn ít nhất 1 người được xem (hoặc đổi sang chế độ khác).', false);
        var body = {
            subjectId: subjectId, title: title, description: $('vfDesc').value.trim(),
            visibility: visibility, isPublished: visibility !== 'private',
            allowedUserIds: visibility === 'users' ? Array.from(selected.keys()) : [],
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
