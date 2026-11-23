/* ============================================================
 * groupForm.js — form tạo / sửa NHÓM (/admin/user-keys/groups/new, /:id/edit)
 * State: <script id="gmState" type="application/json"> { id, name, members:[{id,name,email}], maxMembers, searchUrl, base }
 * Lưu: POST {base} (tạo) hoặc {base}/{id} (sửa) với JSON { name, memberIds }.
 * ============================================================ */
(function () {
    'use strict';
    var $ = function (id) { return document.getElementById(id); };
    var S = JSON.parse($('gmState').textContent);
    var MAX = S.maxMembers || 1000;

    var els = { name: $('gmName'), search: $('gmSearch'), list: $('gmList'), info: $('gmInfo'), addAll: $('gmAddAll'),
        chips: $('gmChips'), count: $('gmCount'), save: $('gmSave'), msg: $('gmMsg') };
    var selected = new Map();                 // id → { id, name, email }
    (S.members || []).forEach(function (u) { selected.set(u.id, u); });
    els.name.value = S.name || '';

    var results = [], total = 0, seq = 0, timer = null, busy = false;

    function showMsg(kind, text) {
        els.msg.className = 'mb-4 p-4 rounded-xl text-sm ' + (kind === 'ok' ? 'bg-green-50 border border-green-200 text-green-800' : 'bg-red-50 border border-red-200 text-red-800');
        els.msg.textContent = text;
        els.msg.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    function hideMsg() { els.msg.className = 'hidden mb-4 p-4 rounded-xl text-sm'; }

    function norm(t) { return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase(); }
    function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function hl(text, tokens) {
        text = String(text || ''); if (!tokens.length) return esc(text);
        var map = [], flat = '';
        for (var i = 0; i < text.length; i++) { var n = norm(text[i]); for (var j = 0; j < n.length; j++) { flat += n[j]; map.push(i); } }
        var ranges = [];
        tokens.forEach(function (tk) { var at = flat.indexOf(tk); if (at >= 0) ranges.push([map[at], map[at + tk.length - 1] + 1]); });
        if (!ranges.length) return esc(text);
        ranges.sort(function (a, b) { return a[0] - b[0]; });
        var out = '', pos = 0;
        ranges.forEach(function (r) { if (r[0] < pos) return; out += esc(text.slice(pos, r[0])) + '<mark>' + esc(text.slice(r[0], r[1])) + '</mark>'; pos = r[1]; });
        return out + esc(text.slice(pos));
    }

    function renderChips() {
        els.count.textContent = selected.size + ' / ' + MAX + ' người';
        els.chips.textContent = '';
        selected.forEach(function (u) {
            var c = document.createElement('div'); c.className = 'vf-chip';
            var t = document.createElement('span'); t.textContent = u.name || u.email; t.title = (u.name ? u.name + ' — ' : '') + u.email; c.appendChild(t);
            if (u.name && u.email) { var e = document.createElement('em'); e.textContent = u.email; c.appendChild(e); }
            var x = document.createElement('button'); x.type = 'button'; x.textContent = '×'; x.title = 'Bỏ ' + (u.name || u.email);
            x.addEventListener('click', function () { selected.delete(u.id); renderChips(); renderList(); });
            c.appendChild(x); els.chips.appendChild(c);
        });
        if (selected.size >= 2) {
            var clr = document.createElement('button'); clr.type = 'button'; clr.className = 'vf-chips-clear'; clr.textContent = 'Xoá tất cả';
            clr.addEventListener('click', function () { selected.clear(); renderChips(); renderList(); });
            els.chips.appendChild(clr);
        }
    }

    function renderList() {
        var tk = norm(els.search.value.trim()).split(/\s+/).filter(Boolean);
        if (!results.length) { els.list.innerHTML = '<li class="gm-empty">Không tìm thấy sinh viên nào</li>'; }
        else {
            els.list.innerHTML = results.map(function (u, i) {
                return '<li class="gm-item" data-i="' + i + '"><input type="checkbox" tabindex="-1"' + (selected.has(u.id) ? ' checked' : '') + '><span class="gm-t">' +
                    hl(u.name || '(chưa có tên)', tk) + '<small>' + hl(u.email, tk) + '</small></span></li>';
            }).join('');
        }
        els.info.textContent = results.length + (total > results.length ? ' / ' + total : '') + ' sinh viên' + (total > results.length ? ' (gõ thêm để lọc)' : '');
    }

    function load(q) {
        var my = ++seq;
        fetch(S.searchUrl + '?q=' + encodeURIComponent(q), { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (my !== seq) return;
                results = d && d.success ? (d.users || []) : []; total = d && d.total ? d.total : results.length; renderList();
            })
            .catch(function () { if (my !== seq) return; results = []; total = 0; renderList(); });
    }

    function add(u) {
        if (selected.has(u.id)) return true;
        if (selected.size >= MAX) { showMsg('err', 'Mỗi nhóm tối đa ' + MAX + ' thành viên.'); return false; }
        selected.set(u.id, { id: u.id, name: u.name, email: u.email }); return true;
    }

    els.list.addEventListener('click', function (e) {
        var li = e.target.closest('.gm-item'); if (!li) return;
        var u = results[+li.dataset.i]; if (!u) return;
        if (selected.has(u.id)) selected.delete(u.id); else if (!add(u)) return;
        renderChips(); renderList();
    });
    els.addAll.addEventListener('click', function () {
        for (var i = 0; i < results.length; i++) if (!add(results[i])) break;
        renderChips(); renderList();
    });
    els.search.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { load(els.search.value.trim()); }, 220); });

    els.save.addEventListener('click', function () {
        if (busy) return;
        hideMsg();
        var name = els.name.value.trim();
        if (!name) { showMsg('err', 'Vui lòng nhập tên nhóm.'); els.name.focus(); return; }
        busy = true; els.save.disabled = true;
        var old = els.save.textContent; els.save.textContent = 'Đang lưu…';
        fetch(S.id ? S.base + '/' + S.id : S.base, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ name: name, memberIds: Array.from(selected.keys()) })
        }).then(function (r) {
            return r.text().then(function (txt) {
                var d = null; try { d = JSON.parse(txt); } catch (e) { d = null; }
                return d || { success: false, message: 'Máy chủ trả HTTP ' + r.status };
            });
        }).then(function (d) {
            if (!d.success) throw new Error(d.message || 'Không lưu được nhóm.');
            window.location.href = d.redirect || S.base;
        }).catch(function (e) {
            busy = false; els.save.disabled = false; els.save.textContent = old;
            showMsg('err', e.message || 'Không lưu được nhóm.');
        });
    });

    renderChips(); renderList(); load('');
})();
