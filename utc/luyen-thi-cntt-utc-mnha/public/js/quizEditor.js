/* ============================================================
   public/js/quizEditor.js — admin tạo / sửa bài trắc nghiệm
   Khớp với views/admin/quiz-form.pug + public/css/quiz-form.css.
   Luồng: dán text AI → "Chuyển" → sửa từng thẻ câu hỏi → Lưu.
   Khi lưu, client serialize các thẻ về TEXT rồi gửi lên; SERVER PARSE LẠI
   (không tin JSON từ client). Parser ở đây chỉ để xem trước / bắt lỗi sớm.
   Điểm hỗ trợ số thập phân: "0.1", "0,25", "1.5"…
   ============================================================ */
(function () {
    "use strict";

    var dataEl = document.getElementById("qfData");
    if (!dataEl) return;
    var CFG = JSON.parse(dataEl.textContent);

    var PARTS = ["mcq", "tf", "fill"];
    var PART_TITLES = { mcq: "Phần 1 · Nhiều đáp án", tf: "Phần 2 · Đúng / Sai", fill: "Phần 3 · Điền số liệu / đáp án" };
    var LETTERS = "ABCDEFGHIJ";
    var HOSTS = CFG.allowedImageHosts || ["raw.githubusercontent.com"];
    var MAX_OPT = CFG.maxOptions || 10;
    var DUR = CFG.durationLimits || { min: 1, max: 600 };
    var AUDIO_HOSTS = CFG.allowedAudioHosts || ["raw.githubusercontent.com", "media.githubusercontent.com"];
    var AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|aac|opus)$/i;
    var STMT_LABELS = "abcdefghij";
    var TF_MIN = CFG.tfMinStatements || 1;
    var TF_MAX = CFG.tfMaxStatements || 10;
    var TF_THPTQG_N = CFG.tfThptqgStatements || 4;
    function tfScoring() {
        var r = document.querySelector('input[name="scoring_tf"]:checked');
        return r ? r.value : (CFG.tfScoring || "equal");
    }

    var state = { mcq: [], tf: [], fill: [] };
    var saving = false;

    function $(id) { return document.getElementById(id); }
    function esc(s) {
        return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
            .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    }

    function toNum(v, def) {
        var s = String(v == null ? "" : v).trim().replace(",", ".");
        if (s === "") return def;
        var n = Number(s);
        return isFinite(n) ? n : def;
    }
    function fmt(n) { return String(Math.round(n * 10000) / 10000); }

    // ============================================================
    // PARSER (mirror quizParserService — chỉ để xem trước)
    // ============================================================
    function imageIssue(url) {
        url = String(url || "").trim();
        if (!url) return "";
        var u;
        try { u = new URL(url); } catch (e) { return "Link ảnh không hợp lệ."; }
        if (u.protocol !== "https:") return "Ảnh phải là link https.";
        if (HOSTS.indexOf(u.hostname) === -1) return "Host ảnh không được phép (chỉ: " + HOSTS.join(", ") + ").";
        return "";
    }

    function normalizeAudio(input) {
        var s = String(input || "").trim();
        if (!s) return { url: "" };
        var u;
        try { u = new URL(s); } catch (e) { return { url: "", error: "Link audio không hợp lệ." }; }
        if (u.protocol !== "https:") return { url: "", error: "Audio phải là link https." };
        if (u.hostname === "github.com" || u.hostname === "www.github.com") {
            var m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/);
            if (!m) return { url: "", error: "Link GitHub chưa đúng. Hãy mở file audio trên GitHub rồi bấm “View raw” để lấy link." };
            u = new URL("https://raw.githubusercontent.com/" + m[1] + "/" + m[2] + "/" + m[3]);
        }
        if (AUDIO_HOSTS.indexOf(u.hostname) === -1) return { url: "", error: "Host audio không được phép (chỉ: " + AUDIO_HOSTS.join(", ") + ")." };
        if (!AUDIO_EXT.test(u.pathname)) return { url: "", error: "File audio phải có đuôi .mp3, .wav, .ogg, .m4a, .aac hoặc .opus." };
        u.search = ""; u.hash = "";
        return { url: u.toString() };
    }
    function refreshAudio(rewrite) {
        var inp = $("fAudio");
        if (!inp) return { url: "" };
        var r = normalizeAudio(inp.value);
        var warn = $("audioWarn"), prev = $("audioPrev");
        warn.textContent = r.error || "";
        warn.hidden = !r.error;
        if (r.url && !r.error) {
            if (rewrite && inp.value.trim() !== r.url) inp.value = r.url;
            if (prev.getAttribute("src") !== r.url) prev.src = r.url;
            prev.hidden = false;
        } else {
            if (prev.getAttribute("src")) { try { prev.pause(); } catch (e) { /* noop */ } prev.removeAttribute("src"); prev.load(); }
            prev.hidden = true;
        }
        return r;
    }

    function normTf(s) {
        s = String(s || "").trim().toLowerCase();
        if (["đúng", "dung", "đ", "d", "true", "t", "1"].indexOf(s) !== -1) return true;
        if (["sai", "s", "false", "f", "0"].indexOf(s) !== -1) return false;
        return null;
    }

    function parseTf(text) {
        var errors = [], questions = [];
        var t = String(text || "").replace(/\r/g, "").trim();
        if (/^["“].*["”]$/s.test(t)) t = t.slice(1, -1);
        var lines = [];
        t.split("\n").forEach(function (raw, idx) {
            if (/^\s*```/.test(raw)) return;
            if (!raw.trim()) return;
            lines.push({ n: idx + 1, s: raw.trim() });
        });
        var cur = null, st = null, open = null;
        function err(line, msg, qi) { errors.push({ line: line, msg: msg, qi: qi }); }

        lines.forEach(function (L) {
            var s = L.s, escaped = false;
            if (/^\\(- |\+\+\)|\+\)|=>|\*\))/.test(s)) { s = s.slice(1); escaped = true; }

            if (!escaped && /^- /.test(s)) {
                cur = { line: L.n, text: s.slice(2).trim(), image: "", imgLine: 0, statements: [], order: questions.length };
                questions.push(cur); st = null; open = "text"; return;
            }
            if (!cur) { if (!escaped && (s.indexOf("+)") === 0 || s.indexOf("=>") === 0 || s.indexOf("++)") === 0)) err(L.n, "Dòng nằm ngoài câu hỏi."); return; }
            if (!escaped && s.indexOf("++)") === 0) {
                if (!st) return err(L.n, "“++)” phải nằm dưới một ý “+)” và dòng “=>” của ý đó.", cur.order);
                if (st.raw === null) return err(L.n, "“++)” đứng trước dòng “=>” của ý.", cur.order);
                st.explanation = st.explanation ? st.explanation + "\n" + s.slice(3).trim() : s.slice(3).trim();
                open = "expl"; return;
            }
            if (!escaped && s.indexOf("+)") === 0) {
                st = { line: L.n, text: s.slice(2).trim(), raw: null, explanation: "" };
                cur.statements.push(st); open = "st"; return;
            }
            if (!escaped && s.indexOf("=>") === 0) {
                if (!st) return err(L.n, "“=>” đứng trước ý “+)” đầu tiên.", cur.order);
                if (st.raw !== null) return err(L.n, "Ý này có hơn một dòng “=>”.", cur.order);
                st.raw = s.slice(2).trim(); open = "ans"; return;
            }
            if (/^https?:\/\/\S+$/.test(s) && open !== "expl") {
                if (cur.statements.length || cur.image) return err(L.n, "Link ảnh phải đặt ngay sau câu dẫn, trước “+)”.", cur.order);
                cur.image = s; cur.imgLine = L.n; open = null; return;
            }
            if (open === "text") cur.text += "\n" + s;
            else if (open === "st" && st) st.text += " " + s;
            else if (open === "expl" && st) st.explanation += "\n" + s;
            else if (open === "ans" && st) st.raw += " " + s;
            else err(L.n, "Dòng thừa, không thuộc mục nào.", cur.order);
        });

        var out = [], scoring = tfScoring();
        questions.forEach(function (q, qi) {
            if (!q.text.trim()) err(q.line, "Câu dẫn rỗng.", qi);
            var iss = imageIssue(q.image);
            if (iss) err(q.imgLine || q.line, iss, qi);
            var n = q.statements.length;
            if (!n) err(q.line, "Câu chưa có ý “+)” nào.", qi);
            else {
                if (n < TF_MIN || n > TF_MAX) err(q.line, "Câu có " + n + " ý, cần từ " + TF_MIN + " đến " + TF_MAX + " ý.", qi);
                if (scoring === "thptqg" && n !== TF_THPTQG_N) err(q.line, "Cách chia điểm THPTQG yêu cầu đúng " + TF_THPTQG_N + " ý mỗi câu (câu này có " + n + " ý).", qi);
            }
            var sts = q.statements.map(function (st, si) {
                var lb = STMT_LABELS.charAt(si) || String(si + 1);
                if (!st.text.trim()) err(st.line, "Ý " + lb + " rỗng.", qi);
                var v = null;
                if (st.raw === null) err(st.line, "Ý " + lb + " thiếu dòng “=> Đúng” hoặc “=> Sai”.", qi);
                else { v = normTf(st.raw); if (v === null) err(st.line, "Ý " + lb + ": chỉ nhận “Đúng” hoặc “Sai”.", qi); }
                return { text: st.text.trim(), correct: v, explanation: st.explanation.trim() };
            });
            out.push({ text: q.text.trim(), image: q.image, statements: sts });
        });
        return { questions: out, note: "", errors: errors };
    }

    // ★ Dòng "//image: 5,8,10" (AI báo các câu cần ảnh): bỏ khỏi text TRƯỚC khi parse
    //   (thay bằng dòng trống để số dòng báo lỗi vẫn đúng) và trả về danh sách số câu.
    function extractImageHint(text) {
        var nums = [];
        var out = String(text || "").replace(/\r/g, "").split("\n").map(function (ln) {
            var m = /^\s*\/\/\s*image\s*:\s*(.*)$/i.exec(ln);
            if (!m) return ln;
            m[1].split(/[,;\s]+/).forEach(function (tok) {
                var r = /^(\d+)\s*-\s*(\d+)$/.exec(tok);
                if (r) {
                    var a = +r[1], b = Math.min(+r[2], a + 200);
                    for (var n = a; n <= b; n++) if (nums.indexOf(n) === -1) nums.push(n);
                } else if (/^\d+$/.test(tok) && nums.indexOf(+tok) === -1) nums.push(+tok);
            });
            return "";
        }).join("\n");
        return { text: out, nums: nums };
    }

    function parsePart(part, text) {
        var h = extractImageHint(text);
        var r = parsePartCore(part, h.text);
        r.imageNums = h.nums;
        return r;
    }

    function parsePartCore(part, text) {
        if (part === "tf") return parseTf(text);
        var errors = [], questions = [], note = [];
        var t = String(text || "").replace(/\r/g, "").trim();
        if (/^["“].*["”]$/s.test(t)) t = t.slice(1, -1);
        var lines = [];
        t.split("\n").forEach(function (raw, idx) {
            if (/^\s*```/.test(raw)) return;
            if (!raw.trim()) return;
            lines.push({ n: idx + 1, s: raw.trim() });
        });

        var cur = null, open = null, openCl = null, clDecl = [];
        function err(line, msg, qi) { errors.push({ line: line, msg: msg, qi: qi }); }

        lines.forEach(function (L) {
            var s = L.s, escaped = false;
            if (/^\\(- |\+\+\)|\+\)|=>|\*\))/.test(s)) { s = s.slice(1); escaped = true; }

            if (!escaped && /^- /.test(s)) {
                cur = { line: L.n, text: s.slice(2).trim(), image: "", options: [], rawCorrect: null, explanation: "", imgLine: 0, order: questions.length };
                openCl = null;
                questions.push(cur); open = "text"; return;
            }
            if (!escaped && s.indexOf("*)") === 0) {
                var cm = /^\*\)\s*\/\s*(\d+)\s*-\s*(\d+)\s*\/\s*(.*)$/.exec(s);
                open = null; openCl = null; cur = null;
                if (!cm) return err(L.n, "Sai cú pháp chùm. Đúng dạng: *)/1-3/ nội dung chùm.");
                var cFrom = Number(cm[1]), cTo = Number(cm[2]), cNext = questions.length + 1, cBad = false, lastOk = null;
                clDecl.forEach(function (c) { if (!c.bad) lastOk = c; });
                if (!(cFrom >= 1 && cTo > cFrom)) { err(L.n, "Chùm /" + cFrom + "-" + cTo + "/ không hợp lệ: cần từ ≥ 1 và đến > từ (chùm có ít nhất 2 câu)."); cBad = true; }
                else if (lastOk && cFrom <= lastOk.to) { err(L.n, "Chùm /" + cFrom + "-" + cTo + "/ chồng lên chùm /" + lastOk.from + "-" + lastOk.to + "/."); cBad = true; }
                else if (cFrom !== cNext) { err(L.n, "Chùm /" + cFrom + "-" + cTo + "/ phải đặt ngay trước câu " + cFrom + " (câu kế tiếp ở đây là câu " + cNext + ")."); cBad = true; }
                openCl = { from: cFrom, to: cTo, text: cm[3].trim(), image: "", line: L.n, imgLine: 0, bad: cBad };
                clDecl.push(openCl); return;
            }
            if (openCl && !cur) {
                if (!escaped && /^(\+\+\)|\+\)|=>)/.test(s)) return err(L.n, "Dòng này nằm trong nội dung chùm; “+)”, “=>”, “++)” chỉ dùng sau dòng “- câu hỏi”.");
                if (!escaped && /^https?:\/\/\S+$/.test(s)) {
                    if (openCl.image) return err(L.n, "Mỗi chùm chỉ có một ảnh.");
                    openCl.image = s; openCl.imgLine = L.n; return;
                }
                openCl.text += (openCl.text ? "\n" : "") + s; return;
            }
            if (!escaped && s.indexOf("++)") === 0) {
                if (!cur) return err(L.n, "Giải thích nằm ngoài câu hỏi.");
                cur.explanation = s.slice(3).trim(); open = "expl"; return;
            }
            if (!escaped && s.indexOf("+)") === 0) {
                if (!cur) return err(L.n, "Đáp án nằm ngoài câu hỏi.");
                if (part !== "mcq") return err(L.n, "Phần này không có dòng “+)”.", cur.order);
                cur.options.push(s.slice(2).trim()); open = "opt"; return;
            }
            if (!escaped && s.indexOf("=>") === 0) {
                if (!cur) return err(L.n, "Dòng “=>” nằm ngoài câu hỏi.");
                cur.rawCorrect = s.slice(2).trim(); open = "corr"; return;
            }
            if (cur && /^https?:\/\/\S+$/.test(s)) {
                if (cur.options.length || cur.rawCorrect !== null || cur.explanation || cur.image) {
                    return err(L.n, "Link ảnh phải đặt ngay sau câu hỏi, trước “+)” / “=>”.", cur.order);
                }
                cur.image = s; cur.imgLine = L.n; open = null; return;
            }
            if (!cur) { if (part === "fill") { note.push(s); return; } return err(L.n, "Dòng nằm ngoài câu hỏi."); }
            if (open === "text") cur.text += "\n" + s;
            else if (open === "expl") cur.explanation += "\n" + s;
            else if (open === "opt") cur.options[cur.options.length - 1] += " " + s;
            else if (open === "corr") cur.rawCorrect += " " + s;
            else err(L.n, "Dòng thừa, không thuộc mục nào.", cur.order);
        });

        var out = [];
        questions.forEach(function (q, qi) {
            if (!q.text.trim()) err(q.line, "Câu hỏi rỗng.", qi);
            if (q.rawCorrect === null) err(q.line, "Thiếu dòng “=> đáp án”.", qi);
            else if (q.rawCorrect === "") err(q.line, "Chưa chọn đáp án đúng.", qi);
            var iss = imageIssue(q.image);
            if (iss) err(q.imgLine || q.line, iss, qi);

            var item = { text: q.text.trim(), image: q.image, explanation: q.explanation.trim() };
            if (part === "mcq") {
                var opts = q.options;
                if (opts.length < 2) err(q.line, "Cần ít nhất 2 đáp án.", qi);
                if (opts.length > MAX_OPT) err(q.line, "Tối đa " + MAX_OPT + " đáp án.", qi);
                var seen = {};
                opts.forEach(function (o) {
                    var k = o.trim().toLowerCase();
                    if (!k) err(q.line, "Có đáp án bị để trống.", qi);
                    else if (seen[k]) err(q.line, "Đáp án bị trùng: “" + o + "”.", qi);
                    seen[k] = true;
                });
                item.options = opts.map(function (o) { return o.trim(); });
                item.correct = [];
                if (q.rawCorrect) {
                    var whole = opts.findIndex(function (o) { return o.trim().toLowerCase() === q.rawCorrect.toLowerCase(); });
                    var idxs = [];
                    if (whole !== -1 && !/^[A-Za-z]$/.test(q.rawCorrect) && !/^\d+$/.test(q.rawCorrect)) idxs = [whole];
                    else {
                        q.rawCorrect.split(",").forEach(function (tok) {
                            tok = tok.trim(); if (!tok) return;
                            var i = -1;
                            if (/^[A-Za-z]$/.test(tok)) i = LETTERS.indexOf(tok.toUpperCase());
                            else if (/^\d+$/.test(tok)) i = Number(tok) - 1;
                            else i = opts.findIndex(function (o) { return o.trim().toLowerCase() === tok.toLowerCase(); });
                            if (i < 0 || i >= opts.length) err(q.line, "“=> " + tok + "” không khớp đáp án nào.", qi);
                            else if (idxs.indexOf(i) === -1) idxs.push(i);
                        });
                    }
                    item.correct = idxs.sort(function (a, b) { return a - b; });
                }
            } else if (part === "tf") {
                var v = q.rawCorrect ? normTf(q.rawCorrect) : null;
                if (q.rawCorrect && v === null) err(q.line, "Phần Đúng/Sai chỉ nhận “Đúng” hoặc “Sai”.", qi);
                item.correct = v;
            } else {
                var ans = (q.rawCorrect || "").split("|").map(function (x) { return x.trim(); }).filter(Boolean);
                if (q.rawCorrect !== null && !ans.length) err(q.line, "Đáp án rỗng.", qi);
                item.answers = ans.join(" | ");
            }
            out.push(item);
        });
        clDecl.forEach(function (c) {
            if (c.bad) return;
            var tag = "Chùm /" + c.from + "-" + c.to + "/";
            if (!c.text && !c.image) { err(c.line, tag + " chưa có nội dung."); return; }
            if (c.to > out.length) { err(c.line, tag + " vượt quá số câu của phần (chỉ có " + out.length + " câu)."); return; }
            var ci = imageIssue(c.image);
            if (ci) { err(c.imgLine || c.line, ci); return; }
            out[c.from - 1].cluster = { text: c.text, image: c.image };
            for (var n = c.from; n < c.to; n++) out[n].joinPrev = true;
        });
        return { questions: out, note: note.join(" "), errors: errors };
    }

    function escLine(s) {
        return String(s).split("\n").map(function (l, i) {
            return (i > 0 && /^\s*(- |\+\+\)|\+\)|=>|\*\))/.test(l)) ? "\\" + l.replace(/^\s+/, "") : l;
        }).join("\n");
    }
    function serializePart(part, list) {
        return list.map(function (q, i) {
            var o = [];
            if (part !== "tf" && q.cluster) {
                var to = i + 1;
                while (to < list.length && list[to].joinPrev) to++;
                var ctext = String(q.cluster.text || "").trim();
                o.push("*)/" + (i + 1) + "-" + to + "/" + (ctext ? " " + escLine(ctext) : ""));
                if (q.cluster.image && q.cluster.image.trim()) o.push(q.cluster.image.trim());
            }
            o.push("- " + escLine(q.text || ""));
            if (q.image && q.image.trim()) o.push(q.image.trim());
            if (part === "mcq") {
                (q.options || []).forEach(function (t) { o.push("+)" + String(t).replace(/\n/g, " ")); });
                o.push("=> " + (q.correct || []).slice().sort(function (a, b) { return a - b; }).map(function (i) { return LETTERS[i]; }).join(", "));
            } else if (part === "tf") {
                (q.statements || []).forEach(function (st) {
                    o.push("+)" + String(st.text || "").replace(/\n/g, " "));
                    o.push("=> " + (st.correct === true ? "Đúng" : st.correct === false ? "Sai" : ""));
                    if (st.explanation && st.explanation.trim()) o.push("++) " + escLine(st.explanation.trim()));
                });
            } else {
                o.push("=> " + (q.answers || ""));
            }
            if (part !== "tf" && q.explanation && q.explanation.trim()) o.push("++) " + escLine(q.explanation.trim()));
            return o.join("\n");
        }).join("\n");
    }

    // ============================================================
    // STATE ↔ ĐỀ ĐÃ LƯU (GitHub JSON)
    // ============================================================
    function blank(part) {
        var b = { text: "", image: "", explanation: "" };
        if (part === "mcq") { b.options = ["", "", "", ""]; b.correct = []; }
        else if (part === "tf") {
            b.statements = [];
            for (var i = 0; i < TF_THPTQG_N; i++) b.statements.push({ text: "", correct: null, explanation: "" });
        } else b.answers = "";
        return b;
    }
    function fromSaved(part, q) {
        var b = { text: q.text || "", image: q.image || "", explanation: q.explanationHtml || "" };
        if (part === "mcq") {
            b.options = (q.options || []).map(function (o) { return o.text; });
            b.correct = (q.correct || []).map(function (k) {
                return (q.options || []).findIndex(function (o) { return o.key === k; });
            }).filter(function (i) { return i >= 0; });
        } else if (part === "tf") {
            b.statements = (q.statements || []).map(function (st) {
                return { text: st.text || "", correct: st.correct === true ? true : st.correct === false ? false : null, explanation: st.explanationHtml || "" };
            });
            if (!b.statements.length) b.statements = blank("tf").statements;
        } else b.answers = (q.answers || []).join(" | ");
        return b;
    }

    // ============================================================
    // RENDER
    // ============================================================
    var UP_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif";
    function upBlock(act, fileF) {
        return '<div class="qc-uprow"><label class="qc-cldlabel">🛡 Kiểm duyệt bằng:' +
            '<select class="qc-cld" title="Chọn CLOUDINARY_CLOUD_NAME dùng để kiểm duyệt ảnh">' + cloudOptionsHtml() + "</select></label>" +
            '<button type="button" class="qf-btn qc-upbtn" data-act="' + act + '"' + (cloudUsable() ? "" : " disabled") + ">⬆ Tải ảnh lên</button>" +
            '<input type="file" data-f="' + fileF + '" accept="' + UP_ACCEPT + '" hidden>' +
            '<span class="qc-upstatus"></span></div>';
    }

    function imageBlock(q) {
        var iss = imageIssue(q.image);
        var okImg = q.image && !iss;
        return '<div class="qc-img"><label class="qc-l" style="margin-top:0">Ảnh minh hoạ (link https, tuỳ chọn)' +
            (q.needImage && !String(q.image || "").trim() ? ' <span class="qc-needimg">🖼 Câu này cần ảnh</span>' : "") + "</label>" +
            '<div class="qc-imgrow"><input type="text" data-f="image" value="' + esc(q.image) + '" placeholder="https://raw.githubusercontent.com/…">' +
            '<button type="button" class="qf-btn danger-s" data-act="rmimg"' + (q.image ? "" : " hidden") + ">Xoá ảnh</button></div>" +
            upBlock("upimg", "imgfile") +
            '<div class="qc-imgwarn">' + esc(iss) + "</div>" +
            '<img class="qc-imgprev" referrerpolicy="no-referrer" alt=""' + (okImg ? ' src="' + esc(q.image) + '"' : " hidden") + "></div>";
    }

    function clusterBlock(part, q, i) {
        if (part === "tf") return "";
        var list = state[part], prev = i > 0 ? list[i - 1] : null;
        if (q.cluster) {
            var iss = imageIssue(q.cluster.image);
            return '<div class="qc-cluster" style="margin:8px 0;padding:10px;border:1px dashed #f59e0b;border-radius:10px;background:#fffbeb">' +
                '<div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><b>📖 Chùm — bắt đầu từ câu ' + (i + 1) + "</b>" +
                '<button type="button" class="qf-btn danger-s" data-act="rmcluster">Bỏ chùm</button></div>' +
                '<label class="qc-l">Nội dung dùng chung (có thể dùng &lt;b&gt; in đậm, &lt;i&gt; in nghiêng, &lt;u&gt;, &lt;br&gt;, &lt;sub&gt;, &lt;sup&gt;, &lt;ul&gt;&lt;li&gt;…)</label>' +
                '<textarea rows="3" data-f="cltext">' + esc(q.cluster.text) + "</textarea>" +
                '<label class="qc-l">Ảnh của chùm (link https, tuỳ chọn)</label>' +
                '<input type="text" data-f="climage" value="' + esc(q.cluster.image) + '" placeholder="https://raw.githubusercontent.com/…">' +
                upBlock("upclimg", "climgfile") +
                '<div class="qc-imgwarn">' + esc(iss) + "</div>" +
                '<div class="qc-note">Các câu liền sau: bấm “＋ Thêm vào chùm ở trên” để dùng chung nội dung này (chùm cần ít nhất 2 câu).</div></div>';
        }
        if (q.joinPrev) {
            return '<div class="qc-cluster-tag" style="margin:6px 0;color:#b45309">⛓ Thuộc chùm ở trên ' +
                '<button type="button" class="qf-btn small" data-act="unjoin">Tách khỏi chùm (từ câu này trở đi)</button></div>';
        }
        var h = '<div class="qc-cluster-actions" style="margin:6px 0;display:flex;gap:8px;flex-wrap:wrap">' +
            '<button type="button" class="qf-btn small" data-act="mkcluster">⛓ Tạo chùm từ câu này</button>';
        if (prev && (prev.cluster || prev.joinPrev)) h += '<button type="button" class="qf-btn small" data-act="join">＋ Thêm vào chùm ở trên</button>';
        return h + "</div>";
    }

    function cardHtml(part, q, i, n) {
        var h = '<div class="qc" data-k="' + part + '" data-i="' + i + '"><div class="qc-head"><b>Câu ' + (i + 1) + "</b>" +
            (q.needImage && !String(q.image || "").trim() ? '<span class="qc-needimg">🖼 Cần ảnh</span>' : "") +
            '<span class="qc-tools"><button type="button" data-act="up" title="Lên"' + (i === 0 ? " disabled" : "") + ">↑</button>" +
            '<button type="button" data-act="down" title="Xuống"' + (i === n - 1 ? " disabled" : "") + ">↓</button>" +
            '<button type="button" data-act="del" title="Xoá câu">✕</button></span></div>' +
            clusterBlock(part, q, i) +
            '<label class="qc-l">Nội dung câu hỏi</label><textarea rows="2" data-f="text">' + esc(q.text) + "</textarea>" +
            imageBlock(q);

        if (part === "mcq") {
            h += '<label class="qc-l">Đáp án — tick ô vuông là đáp án đúng (tick nhiều ô = câu nhiều đáp án)</label><div class="qc-opts">' +
                q.options.map(function (t, oi) {
                    var on = q.correct.indexOf(oi) !== -1;
                    return '<div class="qc-opt' + (on ? " ok" : "") + '" data-oi="' + oi + '">' +
                        '<input type="checkbox" data-f="correct"' + (on ? " checked" : "") + ">" +
                        '<span class="ltr">' + LETTERS[oi] + "</span>" +
                        '<input type="text" data-f="opt" value="' + esc(t) + '" placeholder="Nội dung đáp án">' +
                        '<button type="button" data-act="rmopt" title="Xoá đáp án"' + (q.options.length <= 2 ? " disabled" : "") + ">✕</button></div>";
                }).join("") + "</div>" +
                '<button type="button" class="qf-btn small" data-act="addopt" style="margin-top:8px"' + (q.options.length >= MAX_OPT ? " disabled" : "") + ">＋ Thêm đáp án</button>";
        } else if (part === "tf") {
            h += '<label class="qc-l">Các ý — chọn Đúng / Sai cho từng ý (có thể ghi giải thích riêng từng ý)</label><div class="qc-opts">' +
                q.statements.map(function (st, si) {
                    var lb = STMT_LABELS.charAt(si) || String(si + 1);
                    var nm = "tf-" + i + "-" + si;
                    return '<div class="qc-opt qc-st' + (st.correct === true ? " ok" : "") + '" data-si="' + si + '" style="flex-wrap:wrap">' +
                        '<span class="ltr">' + lb + "</span>" +
                        '<input type="text" data-f="stext" value="' + esc(st.text) + '" placeholder="Nội dung ý ' + lb + '">' +
                        '<span class="qc-tf" style="display:inline-flex;gap:6px">' +
                        [[true, "Đúng"], [false, "Sai"]].map(function (c) {
                            return '<label class="' + (st.correct === c[0] ? "ok" : "") + '"><input type="radio" name="' + nm + '" data-f="scorrect" value="' + c[0] + '"' +
                                (st.correct === c[0] ? " checked" : "") + "> " + c[1] + "</label>";
                        }).join("") + "</span>" +
                        '<button type="button" data-act="rmst" title="Xoá ý"' + (q.statements.length <= 1 ? " disabled" : "") + ">✕</button>" +
                        '<input type="text" data-f="sexpl" value="' + esc(st.explanation) + '" placeholder="Giải thích ý ' + lb + ' (tuỳ chọn)" style="flex-basis:100%;margin-top:6px"></div>';
                }).join("") + "</div>" +
                '<button type="button" class="qf-btn small" data-act="addst" style="margin-top:8px"' + (q.statements.length >= TF_MAX ? " disabled" : "") + ">＋ Thêm ý</button>";
        } else {
            h += '<label class="qc-l">Đáp án đúng (nhiều cách viết ngăn bằng dấu |)</label><div class="qc-ans">' +
                '<input type="text" data-f="answers" value="' + esc(q.answers) + '" placeholder="VD: 12.57 | 12,57"></div>' +
                '<div class="qc-note">Đáp án là số thì được so với “Sai số cho phép” ở trên (VD 0.01).</div>';
        }
        if (part !== "tf") h += '<label class="qc-l">Giải thích (tuỳ chọn, HTML ngắn)</label><textarea rows="2" data-f="explanation">' + esc(q.explanation) + "</textarea>";
        h += '<div class="qc-err"></div></div>';
        return h;
    }

    function renderPart(part) {
        var list = state[part], box = $("cards-" + part);
        if (!box) return;
        box.innerHTML = list.map(function (q, i) { return cardHtml(part, q, i, list.length); }).join("");
        refreshMeta();
    }
    function renderAll() { PARTS.forEach(renderPart); }

    function partPoints(part) { return toNum(($("ppq-" + part) || {}).value, 0); }
    function refreshMeta() {
        var total = 0, n = 0;
        PARTS.forEach(function (k) {
            var cnt = state[k].length, pts = cnt * partPoints(k);
            n += cnt; total += pts;
            if ($("count-" + k)) $("count-" + k).textContent = cnt + " câu";
            if ($("sum-" + k)) $("sum-" + k).textContent = cnt ? cnt + " × " + fmt(partPoints(k)) + " = " + fmt(pts) + " điểm thô" : "";
        });
        refreshImgNeed();
        var max = toNum($("fMax").value, 0);
        $("saveSummary").textContent = n
            ? n + " câu · tổng " + fmt(total) + " điểm thô → quy về thang " + fmt(max)
            : "Chưa có câu hỏi";
    }

    function showErrors(list) {
        var box = $("qfErrors");
        if (!list || !list.length) { box.hidden = true; box.innerHTML = ""; return; }
        box.innerHTML = "<b>Chưa lưu được:</b><ul>" + list.map(function (e) {
            return "<li>" + (e.part ? "[" + esc(PART_TITLES[e.part] || e.part) + "] " : "") +
                (e.q ? "Câu " + e.q + ": " : "") + (e.line ? "dòng " + e.line + ": " : "") + esc(e.msg) + "</li>";
        }).join("") + "</ul>";
        box.hidden = false;
        box.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    function showOk(msg) {
        var box = $("qfOk");
        box.textContent = msg || "";
        box.hidden = !msg;
    }

    function ctx(target) {
        var card = target.closest(".qc");
        if (!card) return null;
        var part = card.getAttribute("data-k"), i = Number(card.getAttribute("data-i"));
        return { card: card, part: part, i: i, q: state[part][i] };
    }

    document.addEventListener("input", function (e) {
        var c = ctx(e.target);
        if (c) {
            var f = e.target.getAttribute("data-f");
            if (f === "text") c.q.text = e.target.value;
            else if (f === "explanation") c.q.explanation = e.target.value;
            else if (f === "answers") c.q.answers = e.target.value;
            else if (f === "cltext") { if (c.q.cluster) c.q.cluster.text = e.target.value; }
            else if (f === "climage") {
                if (c.q.cluster) c.q.cluster.image = e.target.value;
                var cw = c.card.querySelector(".qc-cluster .qc-imgwarn");
                if (cw) cw.textContent = imageIssue(e.target.value);
            }
            else if (f === "stext") c.q.statements[Number(e.target.closest(".qc-st").getAttribute("data-si"))].text = e.target.value;
            else if (f === "sexpl") c.q.statements[Number(e.target.closest(".qc-st").getAttribute("data-si"))].explanation = e.target.value;
            else if (f === "opt") c.q.options[Number(e.target.closest(".qc-opt").getAttribute("data-oi"))] = e.target.value;
            else if (f === "image") {
                c.q.image = e.target.value;
                var iss = imageIssue(c.q.image), prev = c.card.querySelector(".qc-imgprev");
                c.card.querySelector(".qc-imgwarn").textContent = iss;
                c.card.querySelector('[data-act="rmimg"]').hidden = !c.q.image;
                if (c.q.image && !iss) { prev.src = c.q.image; prev.hidden = false; } else { prev.hidden = true; }
            }
            return;
        }
        if (/^(ppq-|fMax$|tolerance$)/.test(e.target.id || "")) refreshMeta();
    });

    if ($("fAudio")) {
        $("fAudio").addEventListener("input", function () { refreshAudio(false); });
        $("fAudio").addEventListener("change", function () { refreshAudio(true); });
        $("fAudio").addEventListener("paste", function () { setTimeout(function () { refreshAudio(true); }, 0); });
        $("audioPrev").addEventListener("error", function () {
            var w = $("audioWarn");
            if (!$("audioPrev").getAttribute("src")) return;
            w.textContent = "Không nghe thử được file này. Kiểm tra: link đúng chưa, repo có public không, file đã commit chưa.";
            w.hidden = false;
        });
    }

    document.addEventListener("change", function (e) {
        var c = ctx(e.target);
        if (!c) return;
        var f = e.target.getAttribute("data-f");
        if (f === "imgfile" || f === "climgfile") {
            var file = e.target.files && e.target.files[0];
            if (file) uploadQuizImage(file, c, f === "climgfile");
            return;
        }
        if (f === "correct") {
            var oi = Number(e.target.closest(".qc-opt").getAttribute("data-oi"));
            var at = c.q.correct.indexOf(oi);
            if (e.target.checked && at === -1) c.q.correct.push(oi);
            if (!e.target.checked && at !== -1) c.q.correct.splice(at, 1);
            renderPart(c.part);
        } else if (f === "scorrect") {
            c.q.statements[Number(e.target.closest(".qc-st").getAttribute("data-si"))].correct = e.target.value === "true";
            renderPart(c.part);
        }
    });

    document.addEventListener("click", function (e) {
        var addBtn = e.target.closest("[data-add]");
        if (addBtn) { var k = addBtn.getAttribute("data-add"); state[k].push(blank(k)); renderPart(k); return; }

        var btn = e.target.closest("button[data-act]");
        if (!btn) return;
        var c = ctx(btn);
        if (!c) return;
        var act = btn.getAttribute("data-act"), list = state[c.part];

        if (act === "upimg" || act === "upclimg") {
            var fi = c.card.querySelector('input[data-f="' + (act === "upimg" ? "imgfile" : "climgfile") + '"]');
            if (fi) { fi.value = ""; fi.click(); }
            return; // không render lại thẻ
        }

        if (act === "del") {
            if (!confirm("Xoá câu " + (c.i + 1) + "?")) return;
            var gone = list.splice(c.i, 1)[0];
            if (gone && gone.cluster && list[c.i] && list[c.i].joinPrev) { list[c.i].cluster = gone.cluster; list[c.i].joinPrev = false; }
        } else if (act === "up" && c.i > 0) {
            list.splice(c.i - 1, 0, list.splice(c.i, 1)[0]);
        } else if (act === "down" && c.i < list.length - 1) {
            list.splice(c.i + 1, 0, list.splice(c.i, 1)[0]);
        } else if (act === "rmimg") {
            c.q.image = "";
        } else if (act === "mkcluster") {
            c.q.cluster = { text: "", image: "" }; c.q.joinPrev = false;
        } else if (act === "rmcluster") {
            c.q.cluster = null;
            for (var jr = c.i + 1; jr < list.length && list[jr].joinPrev; jr++) list[jr].joinPrev = false;
        } else if (act === "join") {
            c.q.joinPrev = true; c.q.cluster = null;
        } else if (act === "unjoin") {
            for (var ju = c.i; ju < list.length && list[ju].joinPrev; ju++) list[ju].joinPrev = false;
        } else if (act === "addopt") {
            if (c.q.options.length < MAX_OPT) c.q.options.push("");
        } else if (act === "addst") {
            if (c.q.statements.length < TF_MAX) c.q.statements.push({ text: "", correct: null, explanation: "" });
        } else if (act === "rmst") {
            if (c.q.statements.length <= 1) return;
            c.q.statements.splice(Number(btn.closest(".qc-st").getAttribute("data-si")), 1);
        } else if (act === "rmopt") {
            var oi = Number(btn.closest(".qc-opt").getAttribute("data-oi"));
            if (c.q.options.length <= 2) return;
            c.q.options.splice(oi, 1);
            c.q.correct = c.q.correct.filter(function (x) { return x !== oi; }).map(function (x) { return x > oi ? x - 1 : x; });
        }
        renderPart(c.part);
    });


    // ============================================================
    // ★ CÂU CẦN ẢNH (//image) + UP ẢNH (Cloudinary kiểm duyệt → GitHub cache/image)
    // ============================================================
    function refreshImgNeed() {
        var box = $("qfImgNeed");
        if (!box) return;
        var parts = [];
        PARTS.forEach(function (k) {
            var nums = [];
            state[k].forEach(function (q, i) {
                if (q.needImage && !String(q.image || "").trim()) nums.push(i + 1);
            });
            if (nums.length) parts.push("<b>" + esc(PART_TITLES[k]) + ":</b> câu " + nums.join(", "));
        });
        if (!parts.length) { box.hidden = true; box.innerHTML = ""; return; }
        box.innerHTML = "🖼 <b>Các câu cần ảnh (chưa có link):</b> " + parts.join(" · ") +
            ". Bấm “⬆ Tải ảnh lên” ở từng câu — ảnh được kiểm duyệt rồi tự điền link raw.";
        box.hidden = false;
    }

    var upCfg = { loaded: false, enabled: false, accounts: [], maxBytes: 10 * 1024 * 1024, githubReady: true };
    var curCloud = ""; // CLOUDINARY_CLOUD_NAME đang chọn (dùng chung cho mọi ô chọn trên trang)

    function cloudUsable() { return upCfg.enabled && upCfg.accounts.length > 0; }

    function cloudOptionsHtml() {
        if (!upCfg.loaded) return '<option value="">Đang tải…</option>';
        if (!upCfg.accounts.length) return '<option value="">Chưa có Cloudinary</option>';
        if (!curCloud || upCfg.accounts.indexOf(curCloud) === -1) curCloud = upCfg.accounts[0];
        return upCfg.accounts.map(function (n) {
            return '<option value="' + esc(n) + '"' + (n === curCloud ? " selected" : "") + ">" + esc(n) + "</option>";
        }).join("");
    }

    // Cập nhật mọi ô chọn + nút đang có trên trang (sau khi tải xong cấu hình)
    function refreshCloudSelects() {
        document.querySelectorAll("select.qc-cld").forEach(function (sel) { sel.innerHTML = cloudOptionsHtml(); sel.disabled = !upCfg.accounts.length; });
        document.querySelectorAll(".qc-upbtn").forEach(function (b) {
            b.disabled = !cloudUsable();
            b.title = cloudUsable() ? "" : (upCfg.accounts.length ? "GitHub chưa cấu hình nên chưa lưu được ảnh" : "Chưa có tài khoản Cloudinary — thêm ở Quản trị → API Key → Cloudinary");
        });
    }

    function loadUploadConfig() {
        fetch("/admin/quiz/upload-image/config", { cache: "no-store", headers: { "Accept": "application/json" } })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                if (d && d.success) {
                    upCfg = { loaded: true, enabled: !!d.enabled, accounts: d.accounts || [], maxBytes: d.maxBytes || upCfg.maxBytes, githubReady: d.githubReady !== false };
                } else { upCfg.loaded = true; }
                refreshCloudSelects();
            })
            .catch(function () { upCfg.loaded = true; refreshCloudSelects(); });
    }
    loadUploadConfig();

    // Đổi lựa chọn ở 1 ô → đồng bộ mọi ô còn lại
    document.addEventListener("change", function (e) {
        if (!e.target.classList || !e.target.classList.contains("qc-cld")) return;
        curCloud = e.target.value;
        document.querySelectorAll("select.qc-cld").forEach(function (sel) { if (sel !== e.target) sel.value = curCloud; });
    });

    function setUpStatus(card, kind, text) {
        var el = card && card.querySelector(".qc-upstatus");
        if (!el) return;
        el.className = "qc-upstatus" + (kind ? " " + kind : "");
        el.textContent = text || "";
    }

    function uploadQuizImage(file, c, isCluster) {
        var card = c.card, q = c.q, part = c.part;
        var btn = card.querySelector(isCluster ? '[data-act="upclimg"]' : '[data-act="upimg"]');

        function fail(msg) { setUpStatus(card, "err", "❌ " + msg); }

        if (!upCfg.enabled) { fail(upCfg.accounts.length ? "Chưa lưu được ảnh (GitHub chưa cấu hình)." : "Chưa có tài khoản Cloudinary để kiểm duyệt."); return; }
        var sel = card.querySelector("select.qc-cld");
        var cloud = (sel && sel.value) || curCloud;
        if (!cloud) { fail("Hãy chọn CLOUDINARY_CLOUD_NAME để kiểm duyệt ảnh."); return; }
        var names = [cloud];
        if (!/^image\/(png|jpeg|webp|gif|bmp|avif)$/.test(file.type)) { fail("Chỉ nhận ảnh PNG / JPEG / WEBP / GIF / BMP / AVIF."); return; }
        if (file.size > upCfg.maxBytes) { fail("Ảnh nặng " + (file.size / 1048576).toFixed(1) + "MB, tối đa " + Math.round(upCfg.maxBytes / 1048576) + "MB."); return; }

        if (btn) btn.disabled = true;
        setUpStatus(card, "busy", "⏳ Đang kiểm duyệt ảnh bằng " + cloud + " rồi lưu lên GitHub…");

        fetch("/admin/quiz/upload-image", {
            method: "POST",
            headers: { "Content-Type": file.type, "X-Cloudinary-Names": names.join(","), "Accept": "application/json" },
            body: file
        }).then(function (res) {
            return res.json().catch(function () { return null; }).then(function (data) {
                if (!res.ok || !data || !data.success) {
                    throw new Error((data && data.message) || (res.status === 413 ? "Ảnh quá nặng so với giới hạn máy chủ." : "Không tải được ảnh (HTTP " + res.status + ")."));
                }
                return data;
            });
        }).then(function (data) {
            // Tự điền link raw vào ô link ảnh (dùng tham chiếu câu, không dùng chỉ số — phòng khi đã đổi thứ tự)
            if (isCluster) { if (q.cluster) q.cluster.image = data.url; }
            else q.image = data.url;
            renderPart(part);
            showOk("✓ Đã kiểm duyệt (" + (data.moderatedBy || names).join(", ") + ") và lưu ảnh: " + data.path + " — link raw đã điền vào ô link ảnh. Nhớ bấm Lưu.");
        }).catch(function (e) {
            if (btn) btn.disabled = false;
            fail(e.message || "Không tải được ảnh.");
        });
    }

    $("btnParse").addEventListener("click", function () {
        var errs = [], done = 0, missingImg = [];
        PARTS.forEach(function (k) {
            var txt = $("paste-" + k).value;
            if (!txt.trim()) return;
            var r = parsePart(k, txt);
            if (r.errors.length) {
                r.errors.forEach(function (x) { errs.push({ part: k, line: x.line, msg: x.msg }); });
                return;
            }
            if (state[k].length && !confirm(PART_TITLES[k] + " đang có " + state[k].length + " câu. Thay bằng " + r.questions.length + " câu từ text đã dán?")) return;
            state[k] = r.questions;
            (r.imageNums || []).forEach(function (n) {
                if (n >= 1 && n <= state[k].length) state[k][n - 1].needImage = true;
                else missingImg.push(PART_TITLES[k] + ": câu " + n);
            });
            if (k === "fill" && r.note && $("fillNote") && !$("fillNote").value.trim()) $("fillNote").value = r.note.slice(0, 300);
            renderPart(k);
            done++;
        });
        showErrors(errs);
        $("syncHint").textContent = errs.length ? "" : (done ? "✓ Đã chuyển " + done + " phần" : "Chưa có text nào để chuyển") +
            (missingImg.length ? " · ⚠ //image nhắc câu không tồn tại: " + missingImg.join("; ") : "");
        refreshImgNeed();
    });

    $("btnExport").addEventListener("click", function () {
        PARTS.forEach(function (k) { $("paste-" + k).value = serializePart(k, state[k]); });
        $("syncHint").textContent = "✓ Đã xuất câu hỏi ra text (có thể copy / sửa rồi chuyển lại)";
    });

    var promptBox = $("promptBox");
    if (promptBox && CFG.authoringPrompt) promptBox.textContent = CFG.authoringPrompt;
    $("btnTogglePrompt").addEventListener("click", function () { promptBox.hidden = !promptBox.hidden; });
    $("btnCopyPrompt").addEventListener("click", function () {
        var msg = $("copyMsg");
        navigator.clipboard.writeText(CFG.authoringPrompt || "").then(function () {
            msg.textContent = "✓ Đã sao chép"; setTimeout(function () { msg.textContent = ""; }, 1800);
        }).catch(function () { msg.textContent = "Không sao chép được — bấm “Xem / ẩn prompt” rồi copy tay."; });
    });

    function validateAll() {
        var errs = [];
        document.querySelectorAll(".qc").forEach(function (c) { c.classList.remove("qc-bad"); c.querySelector(".qc-err").textContent = ""; });

        var isEdit = CFG.mode === "edit";
        if (!isEdit && !$("fSubject").value) errs.push({ msg: "Chưa chọn môn học." });
        if (!$("fTitle").value.trim()) errs.push({ msg: "Chưa nhập tiêu đề bài." });

        var max = toNum($("fMax").value, NaN);
        if (!(max > 0)) errs.push({ msg: "Thang điểm tối đa phải là số lớn hơn 0 (VD 10 hoặc 2.5)." });

        var dur = toNum($("fDuration").value, NaN);
        if (!(Number.isInteger(dur) && dur >= DUR.min && dur <= DUR.max)) {
            errs.push({ msg: "Thời gian làm bài phải là số phút nguyên từ " + DUR.min + " đến " + DUR.max + "." });
        }

        if ($("fAudio")) {
            var au = refreshAudio(true);
            if (au.error) errs.push({ msg: au.error });
        }

        var total = 0;
        PARTS.forEach(function (k) {
            var list = state[k];
            if (!list.length) return;
            total += list.length;
            if (k !== "tf") list.forEach(function (q, qi) {
                if (q.joinPrev && !(qi > 0 && (list[qi - 1].cluster || list[qi - 1].joinPrev))) {
                    errs.push({ part: k, q: qi + 1, msg: "Câu này được đánh dấu thuộc chùm nhưng câu trước không thuộc chùm nào (kiểm tra lại thứ tự câu)." });
                }
            });
            if (!(partPoints(k) > 0)) errs.push({ part: k, msg: "“Điểm / câu” phải là số lớn hơn 0 (VD 0.1, 0.2, 0.25, 1)." });
            if (k === "fill" && toNum($("tolerance").value, 0) < 0) errs.push({ part: k, msg: "Sai số cho phép không được âm." });

            var r = parsePart(k, serializePart(k, list));
            r.errors.forEach(function (x) {
                var qi = x.qi;
                if (qi != null && list[qi]) {
                    var card = document.querySelector('.qc[data-k="' + k + '"][data-i="' + qi + '"]');
                    if (card) { card.classList.add("qc-bad"); card.querySelector(".qc-err").textContent += (card.querySelector(".qc-err").textContent ? " · " : "") + x.msg; }
                    errs.push({ part: k, q: qi + 1, msg: x.msg });
                } else errs.push({ part: k, msg: x.msg });
            });
        });
        if (!total) errs.push({ msg: "Cần ít nhất 1 câu hỏi ở một phần nào đó." });
        return errs;
    }

    // ============================================================
    // ★ FIX: collectBody — tự động sync textarea → state trước khi gửi
    // ------------------------------------------------------------
    // Lỗi cũ: admin sửa text ở ô dán đề ("paste-mcq/tf/fill") nhưng quên bấm
    //         nút "Chuyển" trước khi bấm "Lưu" → state không cập nhật → client
    //         serialize ra TEXT CŨ → backend ghi file y hệt → GitHub có commit
    //         nhưng nội dung không đổi.
    //
    // Fix: trước khi gửi, nếu textarea khác text lúc mở form (CFG.raw[k]) →
    //      parse lại textarea; nếu không lỗi thì dùng kết quả làm state mới.
    //      (Không sync nếu textarea giống CFG.raw → giữ nguyên state đã sửa
    //       qua cards, tránh ghi đè nhầm.)
    // ============================================================
    function syncTextareasToState() {
        PARTS.forEach(function (k) {
            var ta = $("paste-" + k);
            if (!ta) return;
            var initial = (CFG.raw && CFG.raw[k]) || "";
            var current = ta.value;
            if (!current.trim()) return;
            if (current.trim() === initial.trim()) return;   // textarea không đổi → không đụng state
            var r = parsePart(k, current);
            if (r.errors.length) return;                     // có lỗi → để validateAll bắt, không sync
            state[k] = r.questions;
            if (k === "fill" && r.note && $("fillNote") && !$("fillNote").value.trim()) {
                $("fillNote").value = r.note.slice(0, 300);
            }
        });
    }

    function collectBody() {
        // ★ SYNC: bắt kịp thay đổi admin gõ ở ô dán text mà không bấm "Chuyển"
        syncTextareasToState();

        var body = {
            subjectId: $("fSubject").value,
            title: $("fTitle").value.trim(),
            slug: $("fSlug") ? $("fSlug").value.trim() : "",
            maxScore: toNum($("fMax").value, 10),
            duration: toNum($("fDuration").value, 20),
            promptId: $("fPrompt").value,
            contentHtml: $("fDesc").value,
            audioUrl: $("fAudio") ? normalizeAudio($("fAudio").value).url : "",
            scoring_tf: tfScoring(),
            tolerance: toNum($("tolerance").value, 0),
            note: $("fillNote").value.trim(),
            aiKeyIds: Array.prototype.map.call(document.querySelectorAll('input[name="aiKeyIds"]:checked'), function (x) { return x.value; }),
            sha: CFG.sha || ""
        };
        PARTS.forEach(function (k) {
            body[k] = serializePart(k, state[k]);
            body["pointsPerQuestion_" + k] = partPoints(k);
        });
        return body;
    }

    $("btnSave").addEventListener("click", async function () {
        if (saving) return;
        showOk("");
        var errs = validateAll();
        if (errs.length) { showErrors(errs); return; }
        showErrors([]);

        saving = true;
        var btn = $("btnSave"), old = btn.textContent;
        btn.disabled = true; btn.textContent = "Đang lưu…";
        try {
            var url = CFG.mode === "edit" ? "/admin/quiz/" + encodeURIComponent(CFG.lessonId) : "/admin/quiz";
            var res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json", Accept: "application/json" },
                body: JSON.stringify(collectBody())
            });
            var data = {};
            try { data = await res.json(); } catch (e) { /* noop */ }
            if (!res.ok || !data.success) {
                if (data.errors && data.errors.length) showErrors(data.errors);
                else showErrors([{ msg: data.message || "Lưu thất bại (" + res.status + ")." }]);
                return;
            }
            showOk("✓ Đã lưu bài trắc nghiệm.");
            setTimeout(function () { window.location.href = "/admin/lessons"; }, 700);
        } catch (err) {
            showErrors([{ msg: "Lỗi mạng: " + err.message }]);
        } finally {
            saving = false; btn.disabled = false; btn.textContent = old;
        }
    });

    var parts = CFG.parts || {};
    PARTS.forEach(function (k) {
        var p = parts[k];
        state[k] = (p && Array.isArray(p.questions)) ? p.questions.map(function (q) { return fromSaved(k, q); }) : [];
        if (p && Array.isArray(p.clusters)) {
            p.clusters.forEach(function (cl) {
                (cl.questionIds || []).forEach(function (id, n) {
                    var idx = (p.questions || []).findIndex(function (q) { return q.id === id; });
                    if (idx < 0 || !state[k][idx]) return;
                    if (n === 0) state[k][idx].cluster = { text: cl.text || "", image: cl.image || "" };
                    else state[k][idx].joinPrev = true;
                });
            });
        }
        if ($("paste-" + k) && CFG.raw && CFG.raw[k]) $("paste-" + k).value = CFG.raw[k];
    });
    renderAll();
    if ($("fAudio") && $("fAudio").value.trim()) refreshAudio(false);
})();