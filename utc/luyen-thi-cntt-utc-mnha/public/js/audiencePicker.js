/* ============================================================
 * audiencePicker.js — "Ai được xem": công khai / không công khai / chỉ hiển thị với (chọn NHÓM và/hoặc TÀI KHOẢN, có ô tìm)
 * Dùng chung cho Tài liệu (/documents), Slide (/slides), Flashcards (/flashcards), Đề tự luận (/admin/lessons), Đề trắc nghiệm (/admin/quiz).
 * HTML: views/partials/audience-field.pug (+audienceField). CSS: /css/audience.css (+ subject-picker.css của layout).
 *   var ap = AudiencePicker.init({
 *       state: { visibility, allowedUsers:[{id,name,email}], allowedGroups:[{id,name,count,memberIds}], maxUsers, maxGroups },
 *       searchUrl: '/…/users',            // GET ?q= → { users:[{id,name,email}], groups:[{id,name,count,memberIds}], total }
 *       onError: fn(msg) });
 *   ap.get()      → { visibility, isPublished, allowedUserIds, allowedGroupIds }
 *   ap.validate() → null | thông báo lỗi
 * QUY TẮC TRÙNG: tài khoản đã nằm trong 1 nhóm được chọn thì KHÔNG giữ riêng — báo lỗi (khung đỏ) và tự bỏ tài khoản đó, chỉ giữ nhóm.
 * ============================================================ */
(function () {
    'use strict';
    var $ = function (id) { return document.getElementById(id); };

    function init(A) {
        A = A || {};
        var st = A.state || {};
        A = { searchUrl: A.searchUrl, onError: A.onError || function (m) { alert(m); } };
        if (!$('auVis') || !A.searchUrl) return null;

        var MAX_USERS = st.maxUsers || 300, MAX_GROUPS = st.maxGroups || 50;
        var visibility = ['public', 'private', 'users'].indexOf(st.visibility) >= 0 ? st.visibility : 'public';
        var hidVis = $('auHidVis'), hidIds = $('auHidIds'), hidGroups = $('auHidGroups');
        var boxEl = $('auUsersBox'), chipsEl = $('auChips'), pickEl = $('auUserPicker');

        var selectedUsers = new Map();      // id → { id, name, email }
        var selectedGroups = new Map();     // id → { id, name, count, members:Set }
        (st.allowedUsers || []).forEach(function (u) { if (u && u.id) selectedUsers.set(u.id, { id: u.id, name: u.name || '', email: u.email || '' }); });
        (st.allowedGroups || []).forEach(function (g) { if (g && g.id) selectedGroups.set(g.id, mkGroup(g)); });

        function mkGroup(g) {
            var ids = Array.isArray(g.memberIds) ? g.memberIds : [];
            return { id: g.id, name: g.name || '', count: g.count != null ? g.count : ids.length, members: new Set(ids) };
        }

        // ---------- Cảnh báo (khung đỏ) ----------
        var warnEl = $('auWarn');
        if (!warnEl) {
            warnEl = document.createElement('div'); warnEl.id = 'auWarn';
            pickEl.parentNode.insertBefore(warnEl, chipsEl);
        }
        warnEl.className = 'au-warn hidden'; warnEl.setAttribute('role', 'alert');
        var warnTimer = null;
        function warn(msg) {
            warnEl.textContent = '⚠ ' + msg; warnEl.classList.remove('hidden');
            clearTimeout(warnTimer); warnTimer = setTimeout(function () { warnEl.classList.add('hidden'); }, 9000);
        }

        // ---------- Quy tắc trùng người ↔ nhóm ----------
        function groupOfUser(uid) {
            var found = null;
            selectedGroups.forEach(function (g) { if (!found && g.members.has(uid)) found = g; });
            return found;
        }
        // Bỏ các tài khoản đã nằm trong nhóm được chọn. Trả về danh sách tên đã bỏ.
        function dropCovered() {
            var dropped = [];
            Array.from(selectedUsers.values()).forEach(function (u) {
                var g = groupOfUser(u.id);
                if (g) { selectedUsers.delete(u.id); dropped.push({ user: u, group: g }); }
            });
            return dropped;
        }
        function warnDropped(dropped) {
            if (!dropped.length) return;
            var names = dropped.slice(0, 3).map(function (d) { return '"' + (d.user.name || d.user.email) + '"'; }).join(', ') + (dropped.length > 3 ? ' và ' + (dropped.length - 3) + ' người khác' : '');
            var groups = Array.from(new Set(dropped.map(function (d) { return '"' + d.group.name + '"'; }))).join(', ');
            warn('Lỗi trùng: ' + names + ' đã nằm trong nhóm ' + groups + '. Đã bỏ chọn riêng tài khoản — chỉ giữ nhóm.');
        }
        warnDropped(dropCovered());          // dữ liệu cũ có thể đang trùng → dọn ngay khi mở form

        function syncHidden() {
            if (hidVis) hidVis.value = visibility;
            if (hidIds) hidIds.value = visibility === 'users' ? Array.from(selectedUsers.keys()).join(',') : '';
            if (hidGroups) hidGroups.value = visibility === 'users' ? Array.from(selectedGroups.keys()).join(',') : '';
        }

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
            '<div class="sp-panel"><div class="sp-search-wrap">' + SEARCH + '<input type="text" class="sp-search" autocomplete="off" spellcheck="false" placeholder="Tìm nhóm, họ tên hoặc email…" aria-label="Tìm nhóm hoặc tài khoản"></div>' +
            '<ul class="sp-list" role="listbox" aria-multiselectable="true"></ul><div class="sp-count"></div></div>';
        var pBtn = pickEl.querySelector('.sp-btn'), pBtnText = pickEl.querySelector('.sp-btn-text');
        var search = pickEl.querySelector('.sp-search'), list = pickEl.querySelector('.sp-list'), countEl = pickEl.querySelector('.sp-count');
        var resGroups = [], resUsers = [], items = [], total = 0, active = -1, loading = false, seq = 0, timer = null, lastQ = null, failed = false;

        function tokens() { return norm(search.value.trim()).split(/\s+/).filter(Boolean); }

        function chip(cls, icon, label, sub, title, onRemove) {
            var c = document.createElement('div'); c.className = 'vf-chip ' + cls;
            var ic = document.createElement('i'); ic.className = 'au-chip-ico'; ic.textContent = icon; c.appendChild(ic);
            var t = document.createElement('span'); t.textContent = label; t.title = title; c.appendChild(t);
            if (sub) { var e = document.createElement('em'); e.textContent = sub; c.appendChild(e); }
            var x = document.createElement('button'); x.type = 'button'; x.textContent = '×'; x.title = 'Bỏ ' + label; x.setAttribute('aria-label', 'Bỏ ' + label);
            x.addEventListener('click', onRemove);
            c.appendChild(x); return c;
        }

        function syncSummary() {
            syncHidden();
            var nu = selectedUsers.size, ng = selectedGroups.size;
            var parts = [];
            if (ng) parts.push(ng + ' nhóm');
            if (nu) parts.push(nu + ' tài khoản');
            pBtnText.textContent = parts.length ? 'Đã chọn ' + parts.join(' + ') + ' — bấm để thêm / bỏ' : '— Chọn nhóm hoặc tài khoản —';
            pBtnText.classList.toggle('sp-placeholder', !parts.length);
            $('auUsersCount').textContent = ng + ' / ' + MAX_GROUPS + ' nhóm · ' + nu + ' / ' + MAX_USERS + ' tài khoản';
            chipsEl.textContent = '';
            selectedGroups.forEach(function (g) {
                chipsEl.appendChild(chip('vf-chip-group', '👥', g.name, 'Nhóm · ' + g.count + ' người', 'Nhóm "' + g.name + '" (' + g.count + ' người)', function () {
                    selectedGroups.delete(g.id); syncSummary(); if (isOpen()) renderList(false);
                }));
            });
            selectedUsers.forEach(function (u) {
                chipsEl.appendChild(chip('vf-chip-user', '👤', u.name || u.email, u.name && u.email ? u.email : '', (u.name ? u.name + ' — ' : '') + u.email, function () {
                    selectedUsers.delete(u.id); syncSummary(); if (isOpen()) renderList(false);
                }));
            });
            if (nu + ng >= 2) {
                var clr = document.createElement('button'); clr.type = 'button'; clr.className = 'vf-chips-clear'; clr.textContent = 'Xoá tất cả';
                clr.addEventListener('click', function () { selectedUsers.clear(); selectedGroups.clear(); syncSummary(); if (isOpen()) renderList(false); });
                chipsEl.appendChild(clr);
            }
        }

        function rebuildItems() {
            items = resGroups.map(function (g) { return { type: 'group', g: g }; })
                .concat(resUsers.map(function (u) { return { type: 'user', u: u }; }));
        }

        function renderList(resetScroll) {
            var tk = tokens(), keep = list.scrollTop, html = '';
            var idx = 0;
            if (resGroups.length) html += '<li class="au-head" role="presentation">👥 Nhóm <span>' + resGroups.length + '</span></li>';
            resGroups.forEach(function (g) {
                var sel = selectedGroups.has(g.id);
                html += '<li class="sp-item au-row au-group' + (sel ? ' sp-selected' : '') + '" role="option" data-i="' + (idx++) + '" aria-selected="' + sel + '" title="' + esc('Nhóm ' + g.name + ' — ' + g.count + ' người') + '">' +
                    '<span class="au-ico">👥</span><span class="sp-item-text">' + highlight(g.name, tk) + '<small>' + g.count + ' thành viên</small></span>' +
                    '<span class="au-badge au-badge-group">Nhóm</span>' + CHECK + '</li>';
            });
            if (resUsers.length) html += '<li class="au-head" role="presentation">👤 Tài khoản <span>' + resUsers.length + '</span></li>';
            resUsers.forEach(function (u) {
                var sel = selectedUsers.has(u.id), cov = !sel && groupOfUser(u.id);
                html += '<li class="sp-item au-row au-user' + (sel ? ' sp-selected' : '') + (cov ? ' au-covered' : '') + '" role="option" data-i="' + (idx++) + '" aria-selected="' + sel + '" title="' + esc((u.name || '') + ' — ' + u.email) + '">' +
                    '<span class="au-ico">👤</span><span class="sp-item-text">' + highlight(u.name || '(chưa có tên)', tk) + '<small>' + highlight(u.email, tk) + '</small>' +
                    (cov ? '<small class="au-cov-note">đã thuộc nhóm "' + esc(cov.name) + '"</small>' : '') + '</span>' +
                    '<span class="au-badge au-badge-user">Tài khoản</span>' + CHECK + '</li>';
            });
            if (!items.length) html = '<li class="sp-empty">' + (loading ? 'Đang tìm…' : failed ? 'Không tải được danh sách, thử lại.' : 'Không tìm thấy nhóm hoặc tài khoản nào') + '</li>';
            list.innerHTML = html;
            list.scrollTop = resetScroll ? 0 : keep;
            var shown = resUsers.length;
            var base = loading ? 'Đang tìm…' : resGroups.length + ' nhóm · ' + (search.value.trim() ? total + ' tài khoản khớp' : total + ' sinh viên') + (total > shown ? ' (hiện ' + shown + ' đầu — gõ thêm để lọc)' : '');
            countEl.textContent = base + ' · đã chọn ' + selectedGroups.size + ' nhóm, ' + selectedUsers.size + ' tài khoản';
            setActive(items.length ? Math.min(Math.max(active, 0), items.length - 1) : -1, false);
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
            var my = ++seq; loading = true; failed = false; lastQ = q; rebuildItems(); renderList(true);
            fetch(A.searchUrl + (A.searchUrl.indexOf('?') >= 0 ? '&' : '?') + 'q=' + encodeURIComponent(q), { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
                .then(function (r) { return r.json(); })
                .then(function (d) {
                    if (my !== seq) return;                         // đã có lần gõ mới hơn
                    loading = false;
                    if (!d || !d.success) { failed = true; resGroups = []; resUsers = []; total = 0; }
                    else { resGroups = d.groups || []; resUsers = d.users || []; total = d.total || resUsers.length; }
                    active = 0; rebuildItems(); renderList(true);
                })
                .catch(function () { if (my !== seq) return; loading = false; failed = true; resGroups = []; resUsers = []; total = 0; rebuildItems(); renderList(true); });
        }

        function toggle(i) {
            var it = items[i]; if (!it) return;
            if (it.type === 'group') {
                var g = it.g;
                if (selectedGroups.has(g.id)) selectedGroups.delete(g.id);
                else {
                    if (selectedGroups.size >= MAX_GROUPS) return A.onError('Chỉ chọn tối đa ' + MAX_GROUPS + ' nhóm.');
                    selectedGroups.set(g.id, mkGroup(g));
                    warnDropped(dropCovered());                   // tài khoản đã chọn riêng mà nằm trong nhóm này → báo lỗi + bỏ
                }
            } else {
                var u = it.u;
                if (selectedUsers.has(u.id)) selectedUsers.delete(u.id);
                else {
                    var inG = groupOfUser(u.id);
                    if (inG) {                                    // đã thuộc nhóm được chọn → báo lỗi, không giữ riêng
                        warn('Lỗi trùng: "' + (u.name || u.email) + '" đã nằm trong nhóm "' + inG.name + '". Không cần chọn riêng — chỉ giữ nhóm.');
                        renderList(false); return;
                    }
                    if (selectedUsers.size >= MAX_USERS) return A.onError('Chỉ chọn tối đa ' + MAX_USERS + ' tài khoản.');
                    selectedUsers.set(u.id, { id: u.id, name: u.name, email: u.email });
                }
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
            if (e.key === 'ArrowDown') { e.preventDefault(); if (items.length) setActive(Math.min(active + 1, items.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); if (items.length) setActive(Math.max(active - 1, 0)); }
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

        return {
            get: function () {
                var users = visibility === 'users';
                return {
                    visibility: visibility, isPublished: visibility !== 'private',
                    allowedUserIds: users ? Array.from(selectedUsers.keys()) : [],
                    allowedGroupIds: users ? Array.from(selectedGroups.keys()) : []
                };
            },
            validate: function () {
                return visibility === 'users' && !selectedUsers.size && !selectedGroups.size
                    ? 'Hãy chọn ít nhất 1 nhóm hoặc 1 tài khoản được xem (hoặc đổi sang chế độ khác).' : null;
            }
        };
    }
    window.AudiencePicker = { init: init };
})();
