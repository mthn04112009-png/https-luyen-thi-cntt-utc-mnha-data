/*
 * subjectPicker.js – nâng cấp <select data-subject-picker> thành bộ chọn môn có tìm kiếm.
 *  - Hiện tối đa 5 môn, còn lại kéo thanh cuộn.
 *  - Gõ chữ nào lọc môn theo chữ đó (không phân biệt hoa/thường, có/không dấu tiếng Việt).
 *  - <select> gốc vẫn giữ nguyên trong form: submit, required, .value, sự kiện "change" đều hoạt động như cũ.
 * Dùng: select(data-subject-picker) – script được nạp trong layout.pug.
 */
(function () {
    "use strict";

    function norm(s) {
        return String(s || "")
            .normalize("NFD").replace(/[̀-ͯ]/g, "")
            .replace(/đ/g, "d").replace(/Đ/g, "D")
            .toLowerCase();
    }
    function esc(s) {
        return String(s).replace(/[&<>"]/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
        });
    }
    // Tô vàng đoạn khớp (so khớp trên bản đã bỏ dấu; NFD đổi độ dài nên map theo từng ký tự gốc)
    function highlight(text, q) {
        if (!q) return esc(text);
        var map = [], flat = "";
        for (var i = 0; i < text.length; i++) {
            var n = norm(text[i]);
            for (var j = 0; j < n.length; j++) { flat += n[j]; map.push(i); }
        }
        var at = flat.indexOf(q);
        if (at < 0) return esc(text);
        var s = map[at], e = map[at + q.length - 1] + 1;
        return esc(text.slice(0, s)) + "<mark>" + esc(text.slice(s, e)) + "</mark>" + esc(text.slice(e));
    }

    var CARET = '<svg class="sp-caret" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/></svg>';
    var SEARCH = '<svg class="sp-search-ico" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.45 4.39l3.58 3.58a.75.75 0 11-1.06 1.06l-3.58-3.58A7 7 0 012 9z" clip-rule="evenodd"/></svg>';
    var CHECK = '<svg class="sp-check" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 111.4-1.4l3.8 3.8 6.8-6.8a1 1 0 011.4 0z" clip-rule="evenodd"/></svg>';

    var uid = 0;
    var openInstance = null;

    function init(select) {
        if (select.__sp) return;
        select.__sp = true;
        uid++;

        var wrap = document.createElement("div");
        var pcs = select.parentElement ? getComputedStyle(select.parentElement) : null;
        var inRow = pcs && pcs.display.indexOf("flex") !== -1 && pcs.flexDirection.indexOf("row") === 0 && !select.classList.contains("w-full");
        wrap.className = "sp" + (inRow ? " sp-row" : "");

        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "sp-btn";
        btn.setAttribute("aria-haspopup", "listbox");
        btn.setAttribute("aria-expanded", "false");
        btn.innerHTML = '<span class="sp-btn-text"></span>' + CARET;
        var btnText = btn.firstChild;

        var panel = document.createElement("div");
        panel.className = "sp-panel";
        panel.innerHTML =
            '<div class="sp-search-wrap">' + SEARCH +
            '<input type="text" class="sp-search" placeholder="Tìm kiếm môn học..." autocomplete="off" spellcheck="false" aria-label="Tìm môn học"></div>' +
            '<ul class="sp-list" role="listbox" id="sp-list-' + uid + '"></ul>' +
            '<div class="sp-count"></div>';
        var search = panel.querySelector(".sp-search");
        var list = panel.querySelector(".sp-list");
        var count = panel.querySelector(".sp-count");
        btn.setAttribute("aria-controls", "sp-list-" + uid);

        // đưa select gốc vào wrapper
        select.parentNode.insertBefore(wrap, select);
        wrap.appendChild(select);
        select.classList.add("sp-native");
        select.tabIndex = -1;
        wrap.appendChild(btn);
        wrap.appendChild(panel);

        // select gốc bị focus (vd. validation "required") → mở bộ chọn
        select.addEventListener("focus", function () { if (!select.disabled) btn.focus(); });
        select.addEventListener("invalid", function () { btn.focus(); });

        var items = [];      // [{value, label, norm, placeholder}]
        var shown = [];      // các mục đang hiển thị sau khi lọc
        var active = -1;

        function readOptions() {
            items = [];
            for (var i = 0; i < select.options.length; i++) {
                var o = select.options[i];
                items.push({ value: o.value, label: o.textContent.trim(), norm: norm(o.textContent), placeholder: o.value === "" });
            }
        }

        function syncButton() {
            var o = select.options[select.selectedIndex];
            var label = o ? o.textContent.trim() : "";
            btnText.textContent = label || "— Chọn môn học —";
            btnText.classList.toggle("sp-placeholder", !o || o.value === "");
            btn.title = label;
            btn.disabled = select.disabled;
        }

        function render() {
            var q = norm(search.value.trim());
            shown = items.filter(function (it) {
                if (!q) return true;
                return !it.placeholder && it.norm.indexOf(q) !== -1;
            });
            var html = "";
            shown.forEach(function (it, idx) {
                var sel = it.value === select.value;
                html += '<li class="sp-item' + (sel ? " sp-selected" : "") + '" role="option" data-i="' + idx +
                    '" aria-selected="' + sel + '" title="' + esc(it.label) + '"><span class="sp-item-text">' +
                    highlight(it.label, q) + "</span>" + CHECK + "</li>";
            });
            if (!shown.length) html = '<li class="sp-empty">Không tìm thấy môn học nào</li>';
            list.innerHTML = html;
            var real = shown.filter(function (s) { return !s.placeholder; }).length;
            var total = items.filter(function (s) { return !s.placeholder; }).length;
            count.textContent = q ? real + " / " + total + " môn khớp" : total + " môn học";
            // mục đang chọn (nếu có) làm mục active, không thì mục đầu tiên
            var selIdx = -1;
            shown.forEach(function (s, i) { if (s.value === select.value) selIdx = i; });
            setActive(q ? (shown.length ? 0 : -1) : (selIdx >= 0 ? selIdx : 0), !q);
            if (q && shown.length) list.scrollTop = 0;
        }

        function setActive(i, scroll) {
            var els = list.querySelectorAll(".sp-item");
            if (active >= 0 && els[active]) els[active].classList.remove("sp-active");
            active = i;
            if (i >= 0 && els[i]) {
                els[i].classList.add("sp-active");
                if (scroll !== false) {
                    var top = els[i].offsetTop, bottom = top + els[i].offsetHeight;
                    if (top < list.scrollTop) list.scrollTop = top;
                    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
                }
            }
        }

        function choose(i) {
            var it = shown[i];
            if (!it) return;
            var changed = select.value !== it.value;
            select.value = it.value;
            syncButton();
            close(true);
            if (changed) select.dispatchEvent(new Event("change", { bubbles: true }));
        }

        function open() {
            if (select.disabled || wrap.classList.contains("sp-open")) return;
            if (openInstance && openInstance !== api) openInstance.close();
            readOptions();
            search.value = "";
            wrap.classList.add("sp-open");
            btn.setAttribute("aria-expanded", "true");
            // hết chỗ phía dưới thì mở lên trên
            var r = btn.getBoundingClientRect();
            var need = 330;
            wrap.classList.toggle("sp-up", window.innerHeight - r.bottom < need && r.top > need);
            render();
            openInstance = api;
            search.focus();
        }

        function close(focusBtn) {
            if (!wrap.classList.contains("sp-open")) return;
            wrap.classList.remove("sp-open");
            btn.setAttribute("aria-expanded", "false");
            if (openInstance === api) openInstance = null;
            if (focusBtn) btn.focus();
        }

        var api = { close: close, wrap: wrap };

        btn.addEventListener("click", function () {
            wrap.classList.contains("sp-open") ? close(true) : open();
        });
        btn.addEventListener("keydown", function (e) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                open();
            }
        });

        search.addEventListener("input", render);
        search.addEventListener("keydown", function (e) {
            if (e.key === "ArrowDown") { e.preventDefault(); if (shown.length) setActive(Math.min(active + 1, shown.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); if (shown.length) setActive(Math.max(active - 1, 0)); }
            else if (e.key === "Home") { if (shown.length) { e.preventDefault(); setActive(0); } }
            else if (e.key === "End") { if (shown.length) { e.preventDefault(); setActive(shown.length - 1); } }
            else if (e.key === "Enter") { e.preventDefault(); if (active >= 0) choose(active); }   // không submit form
            else if (e.key === "Escape") { e.preventDefault(); close(true); }
            else if (e.key === "Tab") { close(false); }
        });

        list.addEventListener("mousemove", function (e) {
            var li = e.target.closest(".sp-item");
            if (li) { var i = +li.dataset.i; if (i !== active) setActive(i, false); }
        });
        list.addEventListener("mousedown", function (e) { e.preventDefault(); });   // giữ focus ở ô tìm
        list.addEventListener("click", function (e) {
            var li = e.target.closest(".sp-item");
            if (li) choose(+li.dataset.i);
        });

        // select gốc đổi từ code khác (vd. quizEditor) → cập nhật nút
        select.addEventListener("change", syncButton);
        new MutationObserver(syncButton).observe(select, { attributes: true, attributeFilter: ["disabled"] });
        var form = select.form;
        if (form) form.addEventListener("reset", function () { setTimeout(syncButton, 0); });

        readOptions();
        syncButton();
    }

    function initAll(root) {
        (root || document).querySelectorAll("select[data-subject-picker]").forEach(init);
    }

    // bấm ra ngoài → đóng
    document.addEventListener("mousedown", function (e) {
        if (openInstance && !openInstance.wrap.contains(e.target)) openInstance.close();
    });

    window.SubjectPicker = { init: init, initAll: initAll };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { initAll(); });
    else initAll();
})();
