// ============================================================
// Biểu đồ điểm theo thời gian — trang /lessons/:id/history
// SVG thuần (không cần thư viện). Dữ liệu lấy từ <script id="hcData" type="application/json">:
//   { isAdmin, points: [{ t(ms), s(0–10), raw, max, q(1=trắc nghiệm), m(1=bài của chính mình),
//                         id + n (chỉ có với admin hoặc bài của chính mình) }] }
// Student thấy điểm cả lớp (ẩn danh): điểm của mình to + viền đen, điểm người khác mờ, không bấm được.
// Mỗi điểm tô màu theo khoảng điểm: [0,1] [1,2] … [9,10]
//   (điểm nằm đúng biên thì thuộc khoảng trên: 1 → [1,2]; riêng 10 → [9,10])
// ============================================================
(function () {
    'use strict';

    var dataEl = document.getElementById('hcData');
    var svgHost = document.getElementById('hcSvgHost');
    if (!dataEl || !svgHost) return;

    var cfg;
    try { cfg = JSON.parse(dataEl.textContent || '{}'); } catch (e) { cfg = {}; }
    var points = Array.isArray(cfg.points) ? cfg.points : [];
    var isAdmin = !!cfg.isAdmin;

    // 10 màu riêng cho 10 khoảng điểm: đỏ (thấp) → xanh (cao)
    var COLORS = ['#b91c1c', '#dc2626', '#ea580c', '#f59e0b', '#eab308',
                  '#84cc16', '#22c55e', '#0d9488', '#0ea5e9', '#4f46e5'];
    function binOf(s) { return Math.max(0, Math.min(9, Math.floor(s))); }

    var $ = function (id) { return document.getElementById(id); };
    var rangeLabel = $('hcRangeLabel'), summary = $('hcSummary'), legend = $('hcLegend');
    var tip = $('hcTip'), emptyEl = $('hcEmpty');
    var kindSel = $('hcKind'), inYear = $('hcYear'), inMonth = $('hcMonth'), inDay = $('hcDay');
    var lineChk = $('hcLine');
    var othersChk = $('hcOthers'); // chỉ có ở student
    var presetBtns = document.querySelectorAll('[data-hc-range]');

    var NS = 'http://www.w3.org/2000/svg';
    var H = 3600e3, D = 24 * H;
    var W = 880, HT = 340, M = { l: 40, r: 22, t: 14, b: 34 };
    var PW = W - M.l - M.r, PH = HT - M.t - M.b;

    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    function el(name, attrs, parent) {
        var n = document.createElementNS(NS, name);
        for (var k in attrs) n.setAttribute(k, attrs[k]);
        if (parent) parent.appendChild(n);
        return n;
    }
    function fmtDateTime(t) {
        var d = new Date(t);
        return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' ' + pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear();
    }
    function fmtNum(n) { return (Math.round(n * 100) / 100).toString(); }

    // ---------- Khoảng thời gian ----------
    var state = { type: 'preset', preset: 'month' };

    function getRange() {
        var now = new Date(), a, b, label;
        if (state.type === 'preset') {
            if (state.preset === 'day') {
                a = now.getTime() - D; b = now.getTime(); label = '1 ngày gần nhất (24 giờ)';
            } else if (state.preset === 'month') {
                var m = new Date(now); m.setMonth(m.getMonth() - 1);
                a = m.getTime(); b = now.getTime(); label = '1 tháng gần nhất';
            } else if (state.preset === 'year') {
                var y = new Date(now); y.setFullYear(y.getFullYear() - 1);
                a = y.getTime(); b = now.getTime(); label = '1 năm gần nhất';
            } else {
                var ts = points.map(function (p) { return p.t; });
                if (ts.length) {
                    a = Math.min.apply(null, ts); b = Math.max.apply(null, ts);
                    if (b - a < H) { a -= 12 * H; b += 12 * H; }
                    else { var padT = (b - a) * 0.03; a -= padT; b += padT; }
                } else { a = now.getTime() - D; b = now.getTime(); }
                label = 'Tất cả thời gian';
            }
            return { a: a, b: b, label: label };
        }
        if (state.kind === 'year') {
            var Y = parseInt(inYear.value, 10);
            if (!Y) return null;
            return { a: new Date(Y, 0, 1).getTime(), b: new Date(Y + 1, 0, 1).getTime(), label: 'Năm ' + Y };
        }
        if (state.kind === 'month') {
            var mv = (inMonth.value || '').split('-');
            var yy = parseInt(mv[0], 10), mm = parseInt(mv[1], 10);
            if (!yy || !mm) return null;
            return { a: new Date(yy, mm - 1, 1).getTime(), b: new Date(yy, mm, 1).getTime(), label: 'Tháng ' + mm + ' năm ' + yy };
        }
        var dv = (inDay.value || '').split('-');
        var dy = parseInt(dv[0], 10), dm = parseInt(dv[1], 10), dd = parseInt(dv[2], 10);
        if (!dy || !dm || !dd) return null;
        return { a: new Date(dy, dm - 1, dd).getTime(), b: new Date(dy, dm - 1, dd + 1).getTime(), label: 'Ngày ' + dd + ' tháng ' + dm + ' năm ' + dy };
    }

    // ---------- Vạch chia trục X ----------
    function makeTicks(a, b) {
        var span = b - a, ticks = [], d, step;
        if (span <= 2 * D + 1000) {                       // theo giờ
            step = span <= 6 * H ? 1 : (span <= 26 * H ? 3 : 6);
            d = new Date(a); d.setMinutes(0, 0, 0);
            if (d.getTime() < a) d.setHours(d.getHours() + 1);
            while (d.getHours() % step) d.setHours(d.getHours() + 1);
            while (d.getTime() <= b + 1000) {
                ticks.push({ t: d.getTime(), label: d.getHours() === 0 ? pad(d.getDate()) + '/' + pad(d.getMonth() + 1) : pad(d.getHours()) + ':00' });
                d.setHours(d.getHours() + step);
            }
        } else if (span <= 70 * D) {                      // theo ngày
            step = span <= 10 * D ? 1 : (span <= 35 * D ? 5 : 7);
            d = new Date(a); d.setHours(0, 0, 0, 0);
            if (d.getTime() < a) d.setDate(d.getDate() + 1);
            while (d.getTime() <= b + 1000) {
                ticks.push({ t: d.getTime(), label: pad(d.getDate()) + '/' + pad(d.getMonth() + 1) });
                d.setDate(d.getDate() + step);
            }
        } else if (span <= 4 * 366 * D) {                 // theo tháng
            step = Math.max(1, Math.ceil((span / (30.4 * D)) / 12));
            d = new Date(a); d.setDate(1); d.setHours(0, 0, 0, 0);
            if (d.getTime() < a) d.setMonth(d.getMonth() + 1);
            while (d.getTime() <= b + 1000) {
                ticks.push({ t: d.getTime(), label: pad(d.getMonth() + 1) + '/' + String(d.getFullYear()).slice(2) });
                d.setMonth(d.getMonth() + step);
            }
        } else {                                          // theo năm
            step = Math.max(1, Math.ceil(span / (366 * D) / 10));
            d = new Date(a); d.setMonth(0, 1); d.setHours(0, 0, 0, 0);
            if (d.getTime() < a) d.setFullYear(d.getFullYear() + 1);
            while (d.getTime() <= b + 1000) {
                ticks.push({ t: d.getTime(), label: String(d.getFullYear()) });
                d.setFullYear(d.getFullYear() + step);
            }
        }
        return ticks;
    }

    // ---------- Vẽ ----------
    function draw() {
        var r = getRange();
        svgHost.innerHTML = '';
        if (!r) return;
        rangeLabel.textContent = r.label;

        var showOthers = isAdmin || !othersChk || othersChk.checked;
        var inRange = points.filter(function (p) {
            if (p.t < r.a || p.t > r.b) return false;
            return isAdmin || p.m || showOthers;
        });
        var X = function (t) { return M.l + ((t - r.a) / (r.b - r.a)) * PW; };
        var Y = function (s) { return M.t + (1 - s / 10) * PH; };

        var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + HT, width: '100%', role: 'img',
            'aria-label': 'Biểu đồ điểm theo thời gian' }, svgHost);
        svg.style.display = 'block'; svg.style.maxWidth = '100%'; svg.style.height = 'auto';

        // Dải màu nền theo khoảng điểm + vạch ngang + nhãn trục Y
        for (var i = 0; i < 10; i++) {
            el('rect', { x: M.l, y: Y(i + 1), width: PW, height: PH / 10, fill: COLORS[i], 'fill-opacity': 0.07 }, svg);
        }
        for (var g = 0; g <= 10; g++) {
            el('line', { x1: M.l, x2: M.l + PW, y1: Y(g), y2: Y(g), stroke: '#e5e7eb', 'stroke-width': 1 }, svg);
            var yl = el('text', { x: M.l - 8, y: Y(g) + 4, 'text-anchor': 'end', 'font-size': 11, fill: '#6b7280' }, svg);
            yl.textContent = g;
        }
        // Trục X
        makeTicks(r.a, r.b).forEach(function (tk) {
            var x = X(tk.t);
            if (x < M.l - 0.5 || x > M.l + PW + 0.5) return;
            el('line', { x1: x, x2: x, y1: M.t, y2: M.t + PH, stroke: '#f1f5f9', 'stroke-width': 1 }, svg);
            el('line', { x1: x, x2: x, y1: M.t + PH, y2: M.t + PH + 4, stroke: '#9ca3af', 'stroke-width': 1 }, svg);
            var xl = el('text', { x: x, y: M.t + PH + 18, 'text-anchor': 'middle', 'font-size': 11, fill: '#6b7280' }, svg);
            xl.textContent = tk.label;
        });
        el('rect', { x: M.l, y: M.t, width: PW, height: PH, fill: 'none', stroke: '#d1d5db', 'stroke-width': 1 }, svg);

        // Đường nối (tuỳ chọn) rồi tới các điểm
        var sorted = inRange.slice().sort(function (p, q) { return p.t - q.t; });
        // Student: chỉ nối các điểm CỦA MÌNH (nối bài của nhiều người thì vô nghĩa)
        var linePts = isAdmin ? sorted : sorted.filter(function (p) { return p.m; });
        if (lineChk.checked && linePts.length > 1) {
            el('polyline', {
                points: linePts.map(function (p) { return X(p.t).toFixed(1) + ',' + Y(p.s).toFixed(1); }).join(' '),
                fill: 'none', stroke: '#94a3b8', 'stroke-width': 1.5, 'stroke-linejoin': 'round'
            }, svg);
        }
        // Vẽ điểm người khác trước, điểm của mình đè lên trên
        var drawOrder = isAdmin ? sorted : sorted.filter(function (p) { return !p.m; }).concat(sorted.filter(function (p) { return p.m; }));
        drawOrder.forEach(function (p) {
            var other = !isAdmin && !p.m;      // student nhìn bài của người khác
            var c = el('circle', {
                cx: X(p.t), cy: Y(p.s),
                r: other ? 4 : (isAdmin ? 5 : 6.5),
                fill: COLORS[binOf(p.s)],
                'fill-opacity': other ? 0.55 : 1,
                stroke: other ? '#fff' : (isAdmin ? '#fff' : '#111827'),
                'stroke-width': other ? 1 : (isAdmin ? 1.5 : 2)
            }, svg);
            c.addEventListener('mouseenter', function (ev) { showTip(ev, p); });
            c.addEventListener('mousemove', function (ev) { moveTip(ev); });
            c.addEventListener('mouseleave', function () { tip.style.display = 'none'; });
            if (!other && p.id) {              // chỉ mở được bài của mình (admin: mọi bài)
                c.style.cursor = 'pointer';
                c.addEventListener('click', function () {
                    window.location.href = (p.q ? '/quiz-submissions/' : '/submissions/') + p.id;
                });
            }
        });

        emptyEl.style.display = sorted.length ? 'none' : 'flex';

        // Tóm tắt kiểu "High / Low"
        if (sorted.length) {
            var hi = Math.max.apply(null, sorted.map(function (p) { return p.s; }));
            var lo = Math.min.apply(null, sorted.map(function (p) { return p.s; }));
            var mineN = isAdmin ? 0 : sorted.filter(function (p) { return p.m; }).length;
            summary.textContent = sorted.length + ' bài nộp' + (isAdmin ? '' : ' (của bạn: ' + mineN + ')') +
                ' • Cao nhất: ' + fmtNum(hi) + ' • Thấp nhất: ' + fmtNum(lo) + ' (thang 10)';
        } else {
            summary.textContent = 'Không có bài nộp trong khoảng này';
        }

        // Chú giải 10 khoảng + số bài trong mỗi khoảng
        var counts = []; for (var k = 0; k < 10; k++) counts.push(0);
        sorted.forEach(function (p) { counts[binOf(p.s)]++; });
        legend.innerHTML = '';
        for (var b = 0; b < 10; b++) {
            var chip = document.createElement('span');
            chip.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border:1px solid #e5e7eb;border-radius:999px;font-size:12px;background:#fff;color:#374151;opacity:' + (counts[b] ? 1 : 0.5);
            var dot = document.createElement('i');
            dot.style.cssText = 'display:inline-block;width:10px;height:10px;border-radius:50%;background:' + COLORS[b];
            chip.appendChild(dot);
            chip.appendChild(document.createTextNode('[' + b + ',' + (b + 1) + ']  ' + counts[b]));
            legend.appendChild(chip);
        }
    }

    // ---------- Tooltip ----------
    function showTip(ev, p) {
        var lines = [];
        if (isAdmin && p.n) lines.push('<b>' + esc(p.n) + '</b>');
        if (!isAdmin) lines.push(p.m ? '<b>Bài của bạn</b>' : '<b>Sinh viên khác</b> <span style="opacity:.75">(ẩn danh)</span>');
        var score = 'Điểm: <b>' + fmtNum(p.raw) + '/' + p.max + '</b>';
        if (p.max !== 10) score += ' <span style="opacity:.75">(quy đổi ' + fmtNum(p.s) + '/10)</span>';
        lines.push(score);
        lines.push(fmtDateTime(p.t));
        if (isAdmin || p.m) lines.push('<span style="opacity:.75">Bấm để xem chi tiết</span>');
        tip.innerHTML = lines.join('<br>');
        tip.style.display = 'block';
        moveTip(ev);
    }
    function moveTip(ev) {
        var box = tip.parentNode.getBoundingClientRect();
        var x = ev.clientX - box.left + 12, y = ev.clientY - box.top + 12;
        var tw = tip.offsetWidth, th = tip.offsetHeight;
        if (x + tw > box.width) x = ev.clientX - box.left - tw - 12;
        if (y + th > box.height) y = ev.clientY - box.top - th - 12;
        tip.style.left = Math.max(0, x) + 'px';
        tip.style.top = Math.max(0, y) + 'px';
    }
    function esc(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // ---------- Điều khiển ----------
    function setActivePreset(name) {
        presetBtns.forEach(function (b) {
            var on = b.getAttribute('data-hc-range') === name;
            b.style.background = on ? '#4f46e5' : '#fff';
            b.style.color = on ? '#fff' : '#374151';
            b.style.borderColor = on ? '#4f46e5' : '#d1d5db';
        });
    }
    function showKindInput() {
        inYear.style.display = kindSel.value === 'year' ? '' : 'none';
        inMonth.style.display = kindSel.value === 'month' ? '' : 'none';
        inDay.style.display = kindSel.value === 'day' ? '' : 'none';
    }
    function applyCustom() {
        state = { type: 'custom', kind: kindSel.value };
        setActivePreset(null);
        draw();
    }

    presetBtns.forEach(function (b) {
        b.addEventListener('click', function () {
            state = { type: 'preset', preset: b.getAttribute('data-hc-range') };
            setActivePreset(state.preset);
            draw();
        });
    });
    kindSel.addEventListener('change', function () { showKindInput(); applyCustom(); });
    [inYear, inMonth, inDay].forEach(function (i) { i.addEventListener('change', applyCustom); });
    lineChk.checked = !isAdmin; // student: nối điểm thành đường; admin: nhiều SV nên mặc định chỉ hiện điểm
    lineChk.addEventListener('change', draw);
    if (othersChk) { othersChk.checked = true; othersChk.addEventListener('change', draw); }

    // Giá trị mặc định cho ô chọn cụ thể = hôm nay
    var today = new Date();
    inYear.value = today.getFullYear();
    inMonth.value = today.getFullYear() + '-' + pad(today.getMonth() + 1);
    inDay.value = today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate());
    showKindInput();
    setActivePreset('month');
    draw();
})();
