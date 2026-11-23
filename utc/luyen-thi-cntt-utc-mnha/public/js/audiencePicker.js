/* ============================================================
 * audiencePicker.js — "Ai được xem": công khai / không công khai / chỉ hiển thị với (chọn nhiều người, có ô tìm)
 * Dùng chung cho Tài liệu (/documents), Đề tự luận (/admin/lessons), Đề trắc nghiệm (/admin/quiz).
 * HTML: views/partials/audience-field.pug (+audienceField). CSS: /css/audience.css (+ subject-picker.css của layout).
 *   var ap = AudiencePicker.init({ state: { visibility, allowedUsers:[{id,name,email}], maxUsers }, searchUrl: '/…/users', onError: fn(msg) });
 *   ap.get()      → { visibility, isPublished, allowedUserIds }
 *   ap.validate() → null | thông báo lỗi
 * ============================================================ */
(function () {
    'use strict';
    var $ = function (id) { return document.getElementById(id); };
    function init(A) {
        A = A || {};
        var st = A.state || {};
        A = { allowedUsers: st.allowedUsers || [], maxUsers: st.maxUsers || 300, searchUrl: A.searchUrl, onError: A.onError || function (m) { alert(m); } };
        if (!$('auVis') || !A.searchUrl) return null;
        var visibility = ['public', 'private', 'users'].indexOf(st.visibility) >= 0 ? st.visibility : 'public';
        var hidVis = $('auHidVis'), hidIds = $('auHidIds');
        function syncHidden() {
            if (hidVis) hidVis.value = visibility;
            if (hidIds) hidIds.value = visibility === 'users' ? Array.from(selected.keys()).join(',') : '';
        }
    var selected = new Map();                                   // id → { id, name, email }
    (A.allowedUsers || []).forEach(function (u) { if (u && u.id) selected.set(u.id, { id: u.id, name: u.name || '', email: u.email || '' }); });
    var MAX_USERS = A.maxUsers || 300;
    var boxEl = $('auUsersBox'), chipsEl = $('auChips'), pickEl = $('auUserPicker');

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
        syncHidden();
        var n = selected.size;
        pBtnText.textContent = n ? 'Đã chọn ' + n + ' người — bấm để thêm / bỏ' : '— Chọn người được xem —';
        pBtnText.classList.toggle('sp-placeholder', !n);
        $('auUsersCount').textContent = n + ' / ' + MAX_USERS + ' người';
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
        fetch(A.searchUrl + (A.searchUrl.indexOf('?') >= 0 ? '&' : '?') + 'q=' + encodeURIComponent(q), { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
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
            if (selected.size >= MAX_USERS) return A.onError('Chỉ chọn tối đa ' + MAX_USERS + ' người.');
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
        visibility = v; syncHidden();
        boxEl.classList.toggle('hidden', v !== 'users');
        Array.prototype.forEach.call(document.querySelectorAll('input[name="auVisibility"]'), function (r) {
            r.checked = r.value === v; r.parentNode.classList.toggle('on', r.checked);
        });
        if (v !== 'users') close(false);
    }
    Array.prototype.forEach.call(document.querySelectorAll('input[name="auVisibility"]'), function (r) {
        r.addEventListener('change', function () { if (r.checked) applyVisibility(r.value); });
    });
    syncSummary(); applyVisibility(visibility);


    syncHidden();
        return {
            get: function () { return { visibility: visibility, isPublished: visibility !== 'private', allowedUserIds: visibility === 'users' ? Array.from(selected.keys()) : [] }; },
            validate: function () { return visibility === 'users' && !selected.size ? 'Hãy chọn ít nhất 1 người được xem (hoặc đổi sang chế độ khác).' : null; }
        };
    }
    window.AudiencePicker = { init: init };
})();
