/* ============================================================
 * flashcardStudy.js — Trang HỌC flashcard (/flashcards/study/:id)
 *   🃏 Thẻ học     : lật/hiện đáp án, đánh dấu "đã thuộc", lọc, xáo trộn, phím tắt
 *   ✍️ Luyện tập   : 4 cấp độ, câu hỏi tự sinh từ chính bộ thẻ, lặp cách quãng (Leitner), câu sai được hỏi lại
 *   📝 Kiểm tra    : bài kiểm tra có giờ, chấm thang 10
 *   🔊 Nghe / 🎙 Đọc : CHỈ khi học ngoại ngữ (Web Speech API: speechSynthesis + SpeechRecognition)
 * Tiến độ lưu trong localStorage của trình duyệt (theo bộ thẻ).
 * ============================================================ */
(function () {
    'use strict';

    var $ = function (id) { return document.getElementById(id); };
    var D = JSON.parse($('fcData').textContent);
    var LANG = D.mode === 'language';
    var SS = typeof window !== 'undefined' && 'speechSynthesis' in window;
    var SRC = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
    var CAN_SAY = LANG && SS;
    var CAN_HEAR = LANG && !!SRC;
    var K = 'fc_' + D.id;

    var CARDS = D.cards.map(function (c, i) {
        return { n: i, id: c.id, front: String(c.front), back: String(c.back), ipa: c.ipa || '', image: c.image || '', key: String(c.front).trim() };
    });
    var NC = CARDS.length;

    // ------------------------------------------------------------
    // Tiện ích
    // ------------------------------------------------------------
    var ls = {
        get: function (k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } },
        set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* hết chỗ / chế độ riêng tư */ } }
    };
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
    }
    // "\n" (2 ký tự) = xuống dòng; không đụng lệnh LaTeX bắt đầu bằng \n (\neq, \nu…) và "\\n"
    // (không dùng lookbehind để chạy được trên Safari cũ)
    function brk(s) {
        return String(s == null ? '' : s).replace(/(\\)?\\n(?![A-Za-z])/g, function (m, pre) { return pre ? m : '\n'; });
    }
    function fmt(s) { return esc(brk(s)); }
    function typeset(root) {
        try {
            if (window.MathJax && typeof window.MathJax.typesetPromise === 'function') {
                if (typeof window.MathJax.typesetClear === 'function') window.MathJax.typesetClear(root ? [root] : undefined);
                window.MathJax.typesetPromise(root ? [root] : undefined).catch(function () {});
            }
        } catch (e) { /* MathJax chưa tải: khi tải xong nó tự vẽ cả trang */ }
    }
    function shuffle(a) {
        var r = a.slice();
        for (var i = r.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1)), t = r[i]; r[i] = r[j]; r[j] = t;
        }
        return r;
    }
    function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
    function words(s) { return brk(s).trim().split(/\s+/).filter(Boolean); }
    function chars(s) { return Array.prototype.slice.call(String(s)); }   // tách theo ký tự Unicode (kể cả CJK)

    // So sánh đáp án gõ tay: không phân biệt hoa/thường, dấu câu, khoảng trắng
    function nz(s) {
        return String(s == null ? '' : s).toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();
    }
    function ns(s) { return nz(s).replace(/\s/g, ''); }
    function nt(s) { return String(s == null ? '' : s).toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').replace(/[.。!]+$/, '').trim(); }
    function same(a, b) {
        a = brk(a); b = brk(b);
        var x = ns(a), y = ns(b);
        return (x !== '' && x === y) || nt(a) === nt(b);
    }
    function lev(a, b) {
        a = chars(a); b = chars(b);
        var m = a.length, n = b.length, prev = [], cur = [], i, j;
        for (j = 0; j <= n; j++) prev[j] = j;
        for (i = 1; i <= m; i++) {
            cur = [i];
            for (j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            prev = cur;
        }
        return prev[n];
    }
    // gần đúng (dùng khi đọc bằng micro: nhận dạng giọng nói hay sai 1-2 ký tự)
    function close(a, b) {
        var x = ns(a), y = ns(b), L = Math.max(x.length, y.length);
        return L >= 4 && 1 - lev(x, y) / L >= 0.85;
    }
    function isShort(t) { t = brk(t).trim(); return t.length <= 40 && words(t).length <= 6 && t.indexOf('\n') < 0; }
    function hintOf(t) {
        return words(t).map(function (w) { var c = chars(w); return c[0] + new Array(c.length).join('_'); }).join('  ');
    }
    function info(x) {
        return (LANG ? x.front + (x.ipa ? ' /' + x.ipa + '/' : '') : x.front) + ' = ' + x.back;
    }

    // ------------------------------------------------------------
    // Nghe (đọc to) & Đọc (nhận giọng nói) — chỉ học ngoại ngữ
    // ------------------------------------------------------------
    function voiceFor(lang) {
        var vs = (window.speechSynthesis.getVoices && window.speechSynthesis.getVoices()) || [];
        var l = String(lang).toLowerCase();
        for (var i = 0; i < vs.length; i++) if (String(vs[i].lang).toLowerCase() === l) return vs[i];
        for (var j = 0; j < vs.length; j++) if (String(vs[j].lang).toLowerCase().slice(0, 2) === l.slice(0, 2)) return vs[j];
        return null;
    }
    function say(text) {
        if (!CAN_SAY || !text) return;
        try {
            window.speechSynthesis.cancel();
            var u = new SpeechSynthesisUtterance(brk(text).replace(/\s+/g, ' '));
            u.lang = D.language;
            u.rate = 0.85;
            var v = voiceFor(D.language);
            if (v) u.voice = v;
            window.speechSynthesis.speak(u);
        } catch (e) { /* bỏ qua */ }
    }
    function hear(target, resEl) {
        resEl.className = 'fc-res';
        if (!CAN_HEAR) { resEl.textContent = 'Trình duyệt chưa hỗ trợ nhận giọng nói. Hãy dùng Google Chrome hoặc Edge.'; return; }
        resEl.textContent = 'Đang nghe… hãy nói vào micro';
        var g = new SRC();
        g.lang = D.language;
        g.onresult = function (e) {
            var t = e.results[0][0].transcript;
            if (same(t, target)) { resEl.textContent = '🎉 Chính xác!'; resEl.className = 'fc-res ok'; }
            else if (close(t, target)) { resEl.textContent = '👍 Gần đúng! Bạn đọc là: ' + t; resEl.className = 'fc-res ok'; }
            else { resEl.textContent = 'Chưa đúng. Bạn đọc là: ' + t; resEl.className = 'fc-res no'; }
        };
        g.onerror = function () { resEl.textContent = 'Không nghe được. Hãy cho phép micro rồi thử lại.'; resEl.className = 'fc-res no'; };
        try { g.start(); } catch (e) { resEl.textContent = 'Không bật được micro.'; resEl.className = 'fc-res no'; }
    }

    // ------------------------------------------------------------
    // Trạng thái chung
    // ------------------------------------------------------------
    var known = ls.get(K + '_known', {});
    var S = { m: 0, f: 'all', order: CARDS.map(function (c) { return c.n; }), list: [], i: 0, rev: LANG };
    var R = null;          // lượt luyện tập / kiểm tra đang chạy
    var LV = 1;            // cấp độ đang sinh câu hỏi

    function isKnown(c) { return !!known[c.key]; }
    function knownCount() { return CARDS.filter(isKnown).length; }

    function rebuild(keep) {
        var cur = keep && S.list[S.i];
        S.list = S.order.map(function (n) { return CARDS[n]; }).filter(function (c) {
            return S.f === 'all' || (S.f === 'known' ? isKnown(c) : !isKnown(c));
        });
        S.i = cur ? Math.max(0, S.list.indexOf(cur)) : 0;
        if (S.i >= S.list.length) S.i = 0;
    }

    function renderStat() {
        $('fcStat').textContent = '⭐ ' + knownCount() + '/' + NC + ' thẻ đã thuộc';
    }

    function renderUnits() {
        var el = $('fcUnits');
        var list = D.siblings && D.siblings.length ? D.siblings : [{ id: D.id, title: D.title, count: NC }];
        el.innerHTML = '<div class="fc-units-h">📚 Bộ flashcard của môn</div>' + list.map(function (s, k) {
            var kn = s.id === D.id ? knownCount() : Object.keys(ls.get('fc_' + s.id + '_known', {})).length;
            return '<a class="fc-unit' + (s.id === D.id ? ' on' : '') + '" href="/flashcards/study/' + esc(s.id) + '">' +
                '<b>' + (k + 1) + '</b><span><strong>' + esc(s.title) + '</strong><small>' + kn + '/' + s.count + ' đã thuộc</small></span></a>';
        }).join('');
    }

    // ------------------------------------------------------------
    // 🃏 THẺ HỌC
    // ------------------------------------------------------------
    function renderCard() {
        var box = $('fcCard');
        box.classList.remove('fc-pop'); void box.offsetWidth; box.classList.add('fc-pop');

        if (!S.list.length) {
            box.innerHTML = '<div class="fc-empty">' + (S.f === 'known' ? '⭐ Bạn chưa đánh dấu thẻ nào là đã thuộc.' : S.f === 'todo' ? '🎉 Tuyệt vời! Bạn đã thuộc hết các thẻ.' : '📭 Bộ này chưa có thẻ.') + '</div>';
            return;
        }
        var c = S.list[S.i], k = isKnown(c);
        var long = brk(c.front).length > 28;
        box.innerHTML =
            '<div class="fc-bar"><i class="fc-fill" style="width:' + ((S.i + 1) / S.list.length * 100) + '%"></i></div>' +
            '<div class="fc-meta"><span class="fc-tag' + (k ? ' known' : '') + '">' + (k ? '⭐ Đã thuộc' : (LANG ? 'Từ vựng' : 'Câu hỏi')) + '</span><span>' + (S.i + 1) + ' / ' + S.list.length + '</span></div>' +
            (c.image ? '<img class="fc-img" src="' + esc(c.image) + '" alt="" referrerpolicy="no-referrer">' : '') +
            '<h2 class="fc-front' + (long ? ' long' : '') + '">' + fmt(c.front) + '</h2>' +
            (LANG ? '<div class="fc-ipa">' + (c.ipa ? '/' + esc(c.ipa) + '/' : '') + '</div>' : '') +
            (S.rev
                ? '<div class="fc-back" id="fcBack">' + fmt(c.back) + '</div>'
                : '<button type="button" class="fc-reveal" id="fcRev">👁 Bấm để hiện ' + (LANG ? 'nghĩa' : 'câu trả lời') + '</button>') +
            '<p class="fc-res" id="fcRes" aria-live="polite"></p>' +
            (LANG
                ? '<div class="fc-row"><button type="button" class="fc-btn fc-b-ok" id="fcListen"' + (CAN_SAY ? '' : ' disabled title="Trình duyệt chưa hỗ trợ giọng đọc"') + '>🔊 Nghe</button>' +
                  '<button type="button" class="fc-btn fc-b-blue" id="fcSpeak"' + (CAN_HEAR ? '' : ' disabled title="Trình duyệt chưa hỗ trợ nhận giọng nói (dùng Chrome / Edge)"') + '>🎙 Đọc</button></div>'
                : '') +
            '<div class="fc-row"><button type="button" class="fc-btn fc-b-gray" id="fcPrev" aria-label="Thẻ trước">◀</button>' +
            '<button type="button" class="fc-btn fc-b-vio' + (k ? ' known' : '') + '" id="fcKnow">' + (k ? '⭐ Đã thuộc' : '☆ Chưa thuộc') + '</button>' +
            '<button type="button" class="fc-btn fc-b-gray" id="fcNext" aria-label="Thẻ sau">▶</button></div>' +
            '<div class="fc-row"><button type="button" class="fc-btn fc-b-ink" id="fcFlip">' + (S.rev ? '🙈 Ẩn' : '👁 Hiện') + ' ' + (LANG ? 'nghĩa' : 'đáp án') + '</button></div>' +
            '<p class="fc-cnt">Phím tắt: ← → chuyển thẻ · Cách / Enter: hiện–ẩn · K: đã thuộc</p>';

        $('fcPrev').onclick = function () { step(-1); };
        $('fcNext').onclick = function () { step(1); };
        $('fcKnow').onclick = toggleKnown;
        $('fcFlip').onclick = flip;
        if ($('fcRev')) $('fcRev').onclick = flip;
        if (LANG) {
            $('fcListen').onclick = function () { say(c.front); };
            $('fcSpeak').onclick = function () { hear(c.front, $('fcRes')); };
        }
        typeset(box);
    }

    function step(n) {
        if (!S.list.length) return;
        S.i = (S.i + n + S.list.length) % S.list.length;
        if (!LANG) S.rev = false;     // học lý thuyết: mỗi thẻ mới đều ẩn đáp án để tự kiểm tra
        renderCard();
    }
    function flip() { S.rev = !S.rev; renderCard(); }
    function toggleKnown() {
        if (!S.list.length) return;
        var c = S.list[S.i];
        if (known[c.key]) delete known[c.key]; else known[c.key] = 1;
        ls.set(K + '_known', known);
        renderStat(); renderUnits();
        if (S.f !== 'all') {                       // thẻ vừa đổi trạng thái rời khỏi bộ lọc hiện tại
            var at = S.i;
            rebuild(false);
            S.i = Math.min(at, Math.max(0, S.list.length - 1));
        }
        renderCard();
    }

    // ------------------------------------------------------------
    // ✍️ LUYỆN TẬP + 📝 KIỂM TRA — câu hỏi tự sinh từ bộ thẻ
    // ------------------------------------------------------------
    var LVL = LANG
        ? [['🌱', 'Trung bình', 'Nhận biết: chọn đáp án, có hình và phiên âm gợi ý'],
           ['🌿', 'Khá', 'Thông hiểu: nghe, phiên âm, xếp chữ / xếp câu'],
           ['🌳', 'Giỏi', 'Vận dụng: tự gõ từ, nghe và chép, gợi ý chữ cái đầu'],
           ['🏆', 'Xuất sắc', 'Vận dụng cao: không gợi ý']]
        : [['🌱', 'Trung bình', 'Nhận biết: chọn câu trả lời đúng'],
           ['🌿', 'Khá', 'Thông hiểu: chọn hai chiều, tự đánh giá'],
           ['🌳', 'Giỏi', 'Vận dụng: tự gõ câu trả lời ngắn (có gợi ý)'],
           ['🏆', 'Xuất sắc', 'Vận dụng cao: tự gõ / tự đánh giá, không gợi ý']];

    var GROUPS = LANG
        ? [['fb', 'im', 'bf'], ['ls', 'bf', 'ip', 'sc', 'fb'], ['ty', 'dc', 'ip', 'sc'], ['ty', 'dc', 'bf', 'sc']]
        : [['fb', 'im', 'bf'], ['bf', 'fb', 'sg'], ['ty', 'fb', 'sg'], ['ty', 'sg', 'bf']];

    // n đáp án nhiễu khác nhau lấy từ các thẻ khác
    function others(x, f, n, ok) {
        var seen = {}, out = [];
        seen[f(x)] = 1;
        shuffle(CARDS).forEach(function (y) {
            if (out.length >= n || y === x) return;
            var v = f(y);
            if (!v || seen[v] || (ok && !ok(y))) return;
            seen[v] = 1;
            out.push(v);
        });
        return out;
    }
    function nWrong() { return LV === 1 ? 2 : 3; }
    function mc(base, right, wrongs) {
        if (!wrongs.length) return null;
        var o = shuffle([right].concat(wrongs));
        return Object.assign({ k: 'mc', o: o, a: o.indexOf(right) }, base);
    }
    function shuf2(a) {
        var z = shuffle(a), n = 0;
        while (z.join('\u0001') === a.join('\u0001') && n++ < 9) z = shuffle(a);
        return z;
    }

    var GEN = {
        // front → back (chọn nghĩa / câu trả lời)
        fb: function (x) {
            return mc({ t: LANG ? 'Chọn nghĩa đúng của từ' : 'Chọn câu trả lời đúng', p: x.front, ipa: LANG && LV < 4 ? x.ipa : '', img: LV <= 2 ? x.image : '', say: LANG ? x.front : '' },
                x.back, others(x, function (y) { return y.back; }, nWrong()));
        },
        // back → front (chọn từ / câu hỏi)
        bf: function (x) {
            return mc({ t: LANG ? 'Chọn từ / câu đúng' : 'Chọn câu hỏi đúng', p: x.back, img: LV <= 2 ? x.image : '' },
                x.front, others(x, function (y) { return y.front; }, nWrong()));
        },
        // hình → front
        im: function (x) {
            if (!x.image) return null;
            return mc({ t: LANG ? 'Hình này là gì?' : 'Hình này ứng với câu hỏi nào?', img: x.image, p: '' },
                x.front, others(x, function (y) { return y.front; }, nWrong()));
        },
        // nghe → chọn từ (chỉ ngoại ngữ)
        ls: function (x) {
            if (!CAN_SAY) return null;
            return mc({ t: 'Nghe và chọn từ đúng', say: x.front, auto: 1, p: '' },
                x.front, others(x, function (y) { return y.front; }, nWrong()));
        },
        // chọn phiên âm
        ip: function (x) {
            if (!LANG || !x.ipa) return null;
            var w = others(x, function (y) { return y.ipa; }, nWrong());
            return mc({ t: 'Chọn phiên âm đúng', p: x.front, say: x.front },
                '/' + x.ipa + '/', w.map(function (v) { return '/' + v + '/'; }));
        },
        // xếp chữ cái / xếp từ
        sc: function (x) {
            if (!LANG) return null;
            var t = brk(x.front).trim(), w = words(t), tiles, joiner = '';
            if (w.length >= 3 && w.length <= 12) { tiles = w; joiner = ' '; }
            else if (w.length === 1 && /^[\p{L}'-]+$/u.test(t) && chars(t).length >= 3 && chars(t).length <= 14) { tiles = chars(t); }
            else return null;
            return { k: 'tk', t: joiner ? 'Sắp xếp các từ thành câu đúng' : 'Sắp xếp chữ cái thành từ đúng', p: x.back, img: LV <= 2 ? x.image : '', tk: shuf2(tiles), ans: tiles.join(joiner), j: joiner };
        },
        // tự gõ
        ty: function (x) {
            if (LANG) {
                if (words(x.front).length > 8) return null;
                return { k: 'ty', t: 'Gõ từ / câu ngoại ngữ có nghĩa sau', p: x.back, img: LV <= 3 ? x.image : '', h: LV === 3 ? 'Gợi ý: ' + hintOf(x.front) : '', ans: [x.front] };
            }
            if (!isShort(x.back)) return null;
            var b0 = chars(brk(x.back).trim())[0];
            return { k: 'ty', t: 'Gõ câu trả lời', p: x.front, img: LV <= 3 ? x.image : '', h: LV === 3 ? 'Gợi ý: bắt đầu bằng "' + b0 + '"' : '', ans: [x.back] };
        },
        // nghe và chép
        dc: function (x) {
            if (!CAN_SAY || words(x.front).length > 10) return null;
            return { k: 'ty', t: 'Nghe và viết lại', say: x.front, auto: 1, p: '', ans: [x.front] };
        },
        // tự đánh giá (đáp án dài)
        sg: function (x) {
            return { k: 'sg', t: 'Tự đánh giá: bạn có nhớ đáp án không?', p: x.front, ipa: LANG && LV < 4 ? x.ipa : '', img: x.image, ans: x.back, say: LANG ? x.front : '' };
        }
    };

    function mk(x, avoid, noSg) {
        var g = (GROUPS[LV - 1] || GROUPS[0]).filter(function (n) { return n !== avoid && !(noSg && n === 'sg'); });
        var fallback = noSg ? ['fb', 'bf'] : (LANG ? ['fb', 'bf', 'ty'] : ['fb', 'bf', 'sg']);
        var order = shuffle(g).concat(fallback, ['sg']);
        for (var i = 0; i < order.length; i++) {
            var q = GEN[order[i]](x);
            if (q) { q.x = x; q.g = order[i]; return q; }
        }
        return null;
    }

    // Lặp cách quãng: thẻ càng yếu (hộp thấp) càng dễ được chọn
    function weakFirst() {
        var bx = ls.get(K + '_box', {});
        return CARDS.map(function (c) { return [(bx[c.key] || 0) + Math.random() * 2.5, c]; })
            .sort(function (a, b) { return a[0] - b[0]; }).map(function (a) { return a[1]; });
    }

    function runBox() { return $('fcRun'); }

    function newRun(opts) {
        killTimer();
        R = Object.assign({ qs: [], qi: 0, sc: 0, ok: 0, st: 0, wr: [], res: [], sel: [], cur: null, n: 0 }, opts);
    }

    // ---------- Chọn cấp độ ----------
    function pstart() {
        var b = ls.get(K + '_pb', {}), c = runBox();
        c.className = 'fc-card fc-run';
        var rec = 4;
        for (var l = 1; l <= 4; l++) if ((b[l] || 0) < 80) { rec = l; break; }
        c.innerHTML = '<h3>✍️ Luyện tập</h3><p class="fc-note">' + Math.min(20, NC * 3) + ' câu mỗi lượt · câu sai được hỏi lại bằng dạng khác · đạt từ 80% thì lên cấp</p>' +
            LVL.map(function (v, j) {
                var s = b[j + 1];
                return '<button type="button" class="fc-lvl" data-l="' + (j + 1) + '"><i>' + v[0] + '</i><span><strong>' + v[1] + '</strong><small>' + v[2] + '</small></span><em>' + (j + 1 === rec ? '👉 ' : '') + (s != null ? (s >= 80 ? '✅ ' : '') + s + '%' : '') + '</em></button>';
            }).join('');
        c.querySelectorAll('.fc-lvl').forEach(function (b2) { b2.onclick = function () { begin(+b2.getAttribute('data-l')); }; });
    }

    function begin(l) {
        LV = l;
        var n = Math.min(20, NC * 3), t = weakFirst(), last = {}, qs = [];
        for (var j = 0; j < n; j++) {
            var x = t[j % t.length], q = mk(x, last[x.key], false);
            last[x.key] = q.g;
            qs.push(q);
        }
        newRun({ test: false, lv: l, qs: qs, n: n });
        ask();
    }

    // ---------- Kiểm tra ----------
    function tstart() {
        var b = ls.get(K + '_tb', {}), c = runBox();
        c.className = 'fc-card fc-run';
        var n = Math.max(6, Math.min(30, NC * 2)), mins = Math.max(3, Math.ceil(n * 0.75));
        c.innerHTML = '<h3>📝 Kiểm tra</h3>' +
            '<p class="fc-sum">' + n + ' câu · ' + mins + ' phút · thang điểm 10</p>' +
            '<p class="fc-note">Trộn từ nhận biết đến vận dụng, không hiện đáp án trong lúc làm. Hết giờ bài tự nộp.</p>' +
            (b.best != null ? '<p class="fc-note">Điểm cao nhất của bạn: <b>' + b.best + '/10</b></p>' : '') +
            '<div class="fc-row"><button type="button" class="fc-btn fc-b-pri" id="fcTStart">▶ Bắt đầu làm bài</button></div>';
        $('fcTStart').onclick = function () { beginTest(n, mins); };
    }

    function beginTest(n, mins) {
        var t = shuffle(CARDS), last = {}, qs = [];
        for (var j = 0; j < n; j++) {
            LV = j < n * 0.4 ? 1 : (j < n * 0.8 ? 2 : 3);
            var x = t[j % t.length], q = mk(x, last[x.key], true);
            last[x.key] = q.g;
            qs.push(q);
        }
        newRun({ test: true, lv: 2, qs: qs, n: n, deadline: Date.now() + mins * 60000 });
        R.timer = setInterval(tick, 500);
        ask();
    }
    function killTimer() { if (R && R.timer) { clearInterval(R.timer); R.timer = null; } }
    function tick() {
        if (!R || !R.test) return;
        var left = Math.max(0, Math.round((R.deadline - Date.now()) / 1000));
        var el = $('fcTm');
        if (el) el.textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
        if (left <= 0) finish();
    }

    // ---------- Hỏi ----------
    function ask() {
        if (R.qi >= R.qs.length) { finish(); return; }
        var q = R.cur = R.qs[R.qi], c = runBox();
        R.sel = [];
        LV = R.lv;
        c.className = 'fc-card fc-run fc-pop';

        var head = '<div class="fc-bar"><i class="fc-fill" style="width:' + (Math.min(R.qi, R.n) / R.n * 100) + '%"></i></div>' +
            '<p class="fc-qi">' + (R.test
                ? '📝 Câu ' + (R.qi + 1) + '/' + R.qs.length + ' · ⏱ <span class="fc-timer" id="fcTm"></span>'
                : LVL[R.lv - 1][0] + ' ' + (q.r ? 'Ôn lại câu sai' : 'Câu ' + (R.qi + 1) + '/' + R.n) + ' · ⭐ ' + R.sc + ' · 🔥 ' + R.st) + '</p>' +
            '<p class="fc-qt">' + esc(q.t) + '</p>';

        var prompt = '<div class="fc-qp">' +
            (q.img ? '<img class="fc-img" src="' + esc(q.img) + '" alt="" referrerpolicy="no-referrer">' : '') +
            (q.p ? fmt(q.p) : '') +
            (q.ipa ? '<div class="fc-ipa">/' + esc(q.ipa) + '/</div>' : '') +
            (q.s ? '<small>' + fmt(q.s) + '</small>' : '') +
            (q.say && CAN_SAY ? ' <button type="button" class="fc-say" id="fcSay" aria-label="Nghe">🔊</button>' : '') + '</div>';

        var body = '';
        if (q.k === 'mc') body = q.o.map(function (o, j) { return '<button type="button" class="fc-opt" data-j="' + j + '">' + fmt(o) + '</button>'; }).join('');
        else if (q.k === 'ty') body = '<input id="fcIn" class="fc-in" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Gõ đáp án…">' + (q.h ? '<p class="fc-qi">' + esc(q.h) + '</p>' : '');
        else if (q.k === 'tk') body = '<div class="fc-az drop" id="fcAz"></div><div class="fc-az" id="fcBk"></div>';
        else body = '<button type="button" class="fc-reveal" id="fcRv">👁 Hiện đáp án</button><div class="fc-back" id="fcAns" hidden>' + fmt(q.ans) + '</div>';

        var foot = '<p class="fc-fb" id="fcFb" aria-live="polite"></p><div class="fc-row" id="fcFoot">' +
            (q.k === 'ty' || q.k === 'tk' ? '<button type="button" class="fc-btn fc-b-blue" id="fcGo">✔ ' + (R.test ? 'Xác nhận' : 'Kiểm tra') + '</button>' : '') +
            (R.test ? '<button type="button" class="fc-btn fc-b-gray" id="fcSkip">Bỏ qua ▶</button>' : '') + '</div>';

        c.innerHTML = head + prompt + body + foot;

        if (q.say && CAN_SAY && $('fcSay')) $('fcSay').onclick = function () { say(q.say); };
        if (q.k === 'mc') c.querySelectorAll('.fc-opt').forEach(function (b) { b.onclick = function () { grade(+b.getAttribute('data-j')); }; });
        else if (q.k === 'ty') {
            var inp = $('fcIn');
            inp.focus();
            inp.onkeydown = function (e) { if (e.key === 'Enter') grade(inp.value); };
            $('fcGo').onclick = function () { grade(inp.value); };
        } else if (q.k === 'tk') {
            drawTiles(q);
            $('fcGo').onclick = function () { if (R.sel.length) grade(R.sel.map(function (j) { return q.tk[j]; }).join(q.j)); };
        } else {
            $('fcRv').onclick = function () {
                $('fcRv').hidden = true;
                $('fcAns').hidden = false;
                $('fcFoot').innerHTML = '<button type="button" class="fc-btn fc-b-ok" id="fcYes">✅ Tôi nhớ</button><button type="button" class="fc-btn fc-b-no" id="fcNo">❌ Chưa nhớ</button>';
                $('fcYes').onclick = function () { grade(true); };
                $('fcNo').onclick = function () { grade(false); };
                typeset($('fcAns'));
            };
        }
        if (R.test && $('fcSkip')) $('fcSkip').onclick = function () { R.res.push({ q: q, r: false, skipped: true }); R.wr.push(q); R.qi++; ask(); };
        if (R.test) tick();
        typeset(c);
        if (q.auto && q.say) say(q.say);
    }

    function drawTiles(q) {
        var a = $('fcAz'), b = $('fcBk');
        a.innerHTML = R.sel.map(function (j) { return '<button type="button" class="fc-tk" data-j="' + j + '">' + esc(q.tk[j]) + '</button>'; }).join('');
        b.innerHTML = q.tk.map(function (w, j) { return '<button type="button" class="fc-tk" data-j="' + j + '"' + (R.sel.indexOf(j) >= 0 ? ' disabled' : '') + '>' + esc(w) + '</button>'; }).join('');
        a.querySelectorAll('.fc-tk').forEach(function (e) { e.onclick = function () { R.sel = R.sel.filter(function (j) { return j !== +e.getAttribute('data-j'); }); drawTiles(q); }; });
        b.querySelectorAll('.fc-tk').forEach(function (e) { e.onclick = function () { R.sel.push(+e.getAttribute('data-j')); drawTiles(q); }; });
    }

    function answerText(q) {
        return q.k === 'mc' ? q.o[q.a] : q.k === 'tk' ? q.ans : q.k === 'ty' ? q.ans[0] : q.ans;
    }

    function grade(v) {
        var q = R.cur;
        if (!q || q.done) return;
        var r;
        if (q.k === 'mc') r = v === q.a;
        else if (q.k === 'tk') r = same(v, q.ans);
        else if (q.k === 'ty') { if (!String(v).trim()) return; r = q.ans.some(function (a) { return same(a, v); }); }
        else r = v === true;
        q.done = 1;

        var x = q.x, gain = 0;
        if (!q.r && !R.test) {
            var bx = ls.get(K + '_box', {});
            bx[x.key] = r ? Math.min(4, (bx[x.key] || 0) + 1) : 0;
            ls.set(K + '_box', bx);
        }
        if (r) { R.ok += q.r ? 0 : 1; R.st++; gain = 10 + Math.min(R.st, 5); R.sc += gain; }
        else {
            R.st = 0;
            if (!q.r) R.wr.push(q);
            if (!q.r && !R.test) { var again = mk(x, q.g, false); if (again) { again.r = 1; R.qs.push(again); } }
        }

        if (R.test) { R.res.push({ q: q, r: r }); R.qi++; ask(); return; }

        var c = runBox();
        c.classList.add('done');
        if (q.k === 'mc') c.querySelectorAll('.fc-opt').forEach(function (b, j) { if (j === q.a) b.classList.add('ok'); else if (j === v) b.classList.add('no'); });
        else if (q.k === 'ty') { $('fcIn').disabled = true; $('fcIn').style.borderColor = r ? '#22c55e' : '#ef4444'; }
        var fb = $('fcFb');
        fb.className = 'fc-fb ' + (r ? 'ok' : 'no');
        fb.innerHTML = (r ? '✅ Chính xác! +' + gain + (R.st > 2 ? ' 🔥' : '') : '❌ Đáp án đúng: <b>' + fmt(answerText(q)) + '</b>') + '<small>' + fmt(info(x)) + '</small>';
        var last = R.qi + 1 >= R.qs.length;
        $('fcFoot').innerHTML = '<button type="button" class="fc-btn fc-b-pri" id="fcNxt">' + (last ? '🏁 Xem kết quả' : 'Tiếp ▶') + '</button>';
        $('fcNxt').onclick = function () { R.qi++; ask(); };
        $('fcNxt').focus();
        typeset(fb);
    }

    function finish() {
        if (!R) return;
        killTimer();
        var c = runBox();
        c.className = 'fc-card fc-run';
        var n = R.test ? R.qs.length : R.n, ok = R.test ? R.res.filter(function (z) { return z.r; }).length : R.ok;
        var p = Math.round(ok / Math.max(1, n) * 100);

        var wrongMap = {};
        var wrongQs = R.wr;
        if (R.test) {   // câu sai + câu bỏ qua + câu chưa kịp làm khi hết giờ
            var okQ = R.res.filter(function (z) { return z.r; }).map(function (z) { return z.q; });
            wrongQs = R.qs.filter(function (q) { return okQ.indexOf(q) < 0; });
        }
        wrongQs.forEach(function (q) { wrongMap[q.x.key] = q.x; });
        var wrongs = Object.keys(wrongMap).map(function (k) { return wrongMap[k]; });
        var review = wrongs.length ? '<p class="fc-qi">Cần ôn lại:</p>' + wrongs.map(function (x) { return '<div class="fc-wr">' + fmt(info(x)) + '</div>'; }).join('') : '';

        if (R.test) {
            var score = Math.round(ok / Math.max(1, n) * 100) / 10;
            var tb = ls.get(K + '_tb', {});
            if (tb.best == null || score > tb.best) { tb.best = score; ls.set(K + '_tb', tb); }
            c.innerHTML = '<h3>' + (p >= 80 ? '🏆' : p >= 60 ? '👍' : '💪') + ' ' + ok + '/' + n + ' câu đúng · Điểm ' + score + '/10</h3>' + review +
                '<div class="fc-row"><button type="button" class="fc-btn fc-b-pri" id="fcR1">🔁 Làm lại</button><button type="button" class="fc-btn fc-b-gray" id="fcR4">🃏 Thẻ học</button></div>';
            $('fcR1').onclick = tstart;
        } else {
            var pb = ls.get(K + '_pb', {});
            if (p > (pb[R.lv] || 0)) { pb[R.lv] = p; ls.set(K + '_pb', pb); }
            var lv = R.lv;
            var msg = p >= 80 ? (lv < 4 ? 'Rất tốt! Hãy thử cấp cao hơn.' : 'Xuất sắc! Bạn đã làm chủ bộ thẻ này.') : p >= 60 ? 'Khá ổn — luyện thêm để đạt 80% nhé.' : 'Hãy xem lại thẻ học rồi làm lại nhé.';
            c.innerHTML = '<h3>' + (p >= 80 ? '🏆' : p >= 60 ? '👍' : '💪') + ' ' + ok + '/' + n + ' câu đúng (' + p + '%)</h3>' +
                '<p class="fc-sum">⭐ ' + R.sc + ' điểm · ' + msg + '</p>' + review +
                '<div class="fc-row"><button type="button" class="fc-btn fc-b-pri" id="fcR1">🔁 Làm lại</button>' + (p >= 80 && lv < 4 ? '<button type="button" class="fc-btn fc-b-ok" id="fcR2">⬆️ Lên cấp</button>' : '') + '</div>' +
                '<div class="fc-row"><button type="button" class="fc-btn fc-b-vio" id="fcR3">🎚 Chọn cấp khác</button><button type="button" class="fc-btn fc-b-gray" id="fcR4">🃏 Thẻ học</button></div>';
            $('fcR1').onclick = function () { begin(lv); };
            if ($('fcR2')) $('fcR2').onclick = function () { begin(lv + 1); };
            $('fcR3').onclick = pstart;
        }
        $('fcR4').onclick = function () { setMode(0); };
        typeset(c);
        R = null;
    }

    // ------------------------------------------------------------
    // Chuyển chế độ / bộ lọc / phím tắt / cỡ chữ
    // ------------------------------------------------------------
    function setMode(m) {
        killTimer();
        R = null;
        if (SS) { try { window.speechSynthesis.cancel(); } catch (e) { /* bỏ qua */ } }
        S.m = m;
        $('fcCard').hidden = m !== 0;
        $('fcRun').hidden = m === 0;
        $('fcFilters').hidden = m !== 0;
        document.querySelectorAll('#fcModes button').forEach(function (b) { b.classList.toggle('on', +b.getAttribute('data-m') === m); });
        if (m === 0) renderCard(); else if (m === 1) pstart(); else tstart();
    }

    document.querySelectorAll('#fcModes button').forEach(function (b) { b.onclick = function () { setMode(+b.getAttribute('data-m')); }; });
    document.querySelectorAll('#fcFilters button[data-f]').forEach(function (b) {
        b.onclick = function () {
            S.f = b.getAttribute('data-f');
            document.querySelectorAll('#fcFilters button[data-f]').forEach(function (x) { x.classList.toggle('on', x === b); });
            rebuild(false);
            renderCard();
        };
    });
    $('fcShuffle').onclick = function () {
        S.order = shuffle(S.order);
        rebuild(false);
        renderCard();
    };

    document.addEventListener('keydown', function (e) {
        var tg = e.target && e.target.tagName;
        if (tg === 'INPUT' || tg === 'TEXTAREA' || tg === 'SELECT' || e.ctrlKey || e.metaKey || e.altKey) return;
        if (S.m !== 0) return;
        if (e.key === 'ArrowRight') step(1);
        else if (e.key === 'ArrowLeft') step(-1);
        else if ((e.key === ' ' || e.key === 'Enter') && tg !== 'BUTTON') { e.preventDefault(); flip(); }
        else if (e.key === 'k' || e.key === 'K') toggleKnown();
    });

    var ZK = 'fc_zoom';
    function zoom(z) {
        z = Math.min(1.8, Math.max(0.8, Math.round(z * 10) / 10));
        ls.set(ZK, z);
        $('fcApp').style.setProperty('--z', z);
        $('fcZv').textContent = Math.round(z * 100) + '%';
    }
    $('fcZm').onclick = function () { zoom(ls.get(ZK, 1) - 0.1); };
    $('fcZp').onclick = function () { zoom(ls.get(ZK, 1) + 0.1); };
    $('fcZv').onclick = function () { zoom(1); };

    // Giọng đọc của trình duyệt nạp bất đồng bộ
    if (CAN_SAY && window.speechSynthesis.getVoices) { window.speechSynthesis.getVoices(); }

    // ------------------------------------------------------------
    // Khởi động
    // ------------------------------------------------------------
    zoom(ls.get(ZK, 1));
    renderStat();
    renderUnits();
    rebuild(false);
    setMode(0);

    // Hook kiểm thử (chỉ khi trang kiểm thử đặt cờ)
    if (typeof window !== 'undefined' && window.__FC_TEST__) {
        window.__FC_TEST__.api = {
            GEN: GEN, mk: mk, same: same, close: close, nz: nz, lev: lev, brk: brk, isShort: isShort, hintOf: hintOf,
            setLV: function (l) { LV = l; }, begin: begin, beginTest: beginTest, grade: grade, getR: function () { return R; },
            tstart: tstart, pstart: pstart, setMode: setMode, ask: ask, finish: finish
        };
    }
})();
