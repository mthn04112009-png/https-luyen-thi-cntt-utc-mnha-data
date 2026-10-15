/* ============================================================
   quizAiPanel.js — thanh "Kiểm tra AI" + nút "Phân tích AI" cho TRẮC NGHIỆM
   (cùng luồng với lesson.pug của tự luận)

   Luồng:
     1. Tải /api/ai/models và /api/ai/keys → điền dropdown Key + Model.
     2. Bấm "Kiểm tra AI" (hoặc tự kiểm tra lần đầu) → GET /api/ai/ai-status?aiKeyId=&model=
     3. CHỈ khi kiểm tra OK + bài đã lưu lên GitHub (committed) + chưa quá giới hạn
        thì nút "Phân tích AI" mới bấm được.
     4. Đổi Key / Model → phải kiểm tra lại.
     5. Bấm phân tích → POST /api/quiz/submissions/:id/analyze { aiKeyId, model }
        → render kết quả theo kiểu submission-detail.pug (thẻ trắng bo góc).

   Dùng ở: quizTake.js (sau khi nộp) và quizDetail.js (trang chi tiết bài nộp).
   Markup: views/partials/quiz-ai-panel.pug
   ============================================================ */
(function () {
    "use strict";

    var API_AI = "/api/ai";

    function $(id) { return document.getElementById(id); }
    function esc(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    }
    // ★ Nhà cung cấp AI đọc từ /api/ai/models (AI-database/index.json)
    var providerInfo = {};
    function normProvider(p) {
        var s = String(p || "").trim().toLowerCase();
        return !s || s === "google" ? "gemini" : s;
    }
    function providerName(p) {
        var id = normProvider(p);
        return (providerInfo[id] && providerInfo[id].label) || (id === "gemini" ? "Gemini" : id === "vilao" ? "vilao.ai" : id);
    }

    // "mcq-3" → "TN 3", "tf-2-b" → "ĐS 2b", "fill-1" → "ĐK 1" (dùng khi trang không truyền chipLabel)
    function defaultChipLabel(id) {
        var m = /^(mcq|tf|fill)-(\d+)(?:-([a-z]))?$/i.exec(String(id || ""));
        if (!m) return String(id || "");
        var pre = { mcq: "TN", tf: "ĐS", fill: "ĐK" }[m[1].toLowerCase()];
        return pre + " " + m[2] + (m[3] || "");
    }

    // ============================================================
    // RENDER KẾT QUẢ — theo phong cách submission-detail.pug
    // (chỉ dùng class Tailwind đã xuất hiện trong submission-detail.pug)
    // Mọi chữ do AI trả về đều qua esc().
    // ============================================================
    var CARD = "bg-white border border-gray-200 rounded-2xl p-6 shadow-sm mb-6";
    var H2 = "text-lg font-bold text-gray-900 mb-3 flex items-center gap-2";

    function renderAnalysis(a, opts) {
        opts = opts || {};
        var chipLabel = opts.chipLabel || defaultChipLabel;

        function chips(ids) {
            if (!Array.isArray(ids)) return "";
            return ids.map(function (id) {
                return '<a class="qai-chip" data-goto="' + esc(id) + '">' + esc(chipLabel(id)) + "</a>";
            }).join("");
        }

        var label = a.aiLabel || (providerName(a.aiProvider) + (a.aiKeyName ? ": " + a.aiKeyName : ""));
        var when = a.analyzedAt ? new Date(a.analyzedAt).toLocaleString("vi-VN") : "";

        // ----- Header: AI nào, model nào, lúc nào, prompt nào -----
        var head = '<div class="' + CARD + '">' +
            '<h2 class="' + H2 + '">🤖 Phân tích AI' + (opts.no ? " #" + esc(opts.no) : "") + "</h2>" +
            '<div class="flex flex-wrap items-center gap-3 text-xs text-gray-500">' +
            (a.model ? '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 font-mono">' + esc(a.model) + "</span>" : "") +
            '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-50 text-purple-700">🔑 ' + esc(label) + "</span>" +
            (when ? "<span>🕒 " + esc(when) + "</span>" : "") +
            (a.promptName ? "<span>Prompt: " + esc(a.promptName) + (a.promptVersion ? " v" + esc(a.promptVersion) : "") + "</span>" : "") +
            "</div></div>";

        // ----- AI trả về không đọc được -----
        if (a.status === "parse_failed" || !a.result) {
            return '<section class="qai-item">' + head +
                '<div class="bg-white border border-red-200 rounded-2xl p-6 shadow-sm mb-6">' +
                '<p class="font-semibold text-red-900 mb-1">AI trả về định dạng không đọc được</p>' +
                '<pre class="mt-2 p-3 rounded-lg bg-gray-50 text-xs text-gray-800 overflow-x-auto whitespace-pre-wrap border border-gray-100">' +
                esc(a.rawText || "(trống)") + "</pre></div></section>";
        }

        var r = a.result;
        var out = head;

        // ----- Tổng quan (giống khối "Nhận xét của AI") -----
        if (r.summary) {
            out += '<div class="' + CARD + '"><h2 class="' + H2 + '">🤖 Tổng quan</h2>' +
                '<div class="text-sm text-gray-700 whitespace-pre-wrap leading-7">' + esc(r.summary) + "</div></div>";
        }

        // ----- Chủ đề cần ôn (khung cam như "Lỗi ngữ pháp") -----
        if (Array.isArray(r.weakTopics) && r.weakTopics.length) {
            out += '<div class="bg-white border border-orange-200 rounded-2xl p-6 shadow-sm mb-6">' +
                '<h2 class="text-lg font-bold text-orange-900 mb-4 flex items-center gap-2">📚 Chủ đề cần ôn' +
                '<span class="ml-2 px-2 py-0.5 rounded-full text-xs font-bold bg-orange-100 text-orange-700">' + r.weakTopics.length + "</span></h2>" +
                '<div class="space-y-3">' + r.weakTopics.map(function (t) {
                    return '<div class="p-4 rounded-lg bg-orange-50 border border-orange-100">' +
                        '<div class="flex items-center gap-2 mb-2"><span class="text-xs font-bold text-orange-600">' + esc(t.topic) + "</span>" +
                        (t.wrongCount != null ? '<span class="text-xs text-gray-500">— sai ' + esc(t.wrongCount) + " câu</span>" : "") + "</div>" +
                        (t.advice ? '<div class="text-sm text-gray-800 mb-2">' + esc(t.advice) + "</div>" : "") +
                        "<div>" + chips(t.questions) + "</div></div>";
                }).join("") + "</div></div>";
        }

        // ----- Phân tích từng câu sai (giống "Lỗi #n": sai → đúng → giải thích) -----
        if (Array.isArray(r.mistakes) && r.mistakes.length) {
            out += '<div class="' + CARD + '"><h2 class="' + H2 + '">📝 Phân tích từng câu sai</h2>' +
                '<div class="space-y-3">' + r.mistakes.map(function (x, i) {
                    return '<div class="p-4 rounded-lg bg-gray-50 border border-gray-100">' +
                        '<div class="flex items-center gap-2 mb-2"><span class="text-xs font-bold text-indigo-600">Lỗi #' + (i + 1) + "</span>" + chips([x.id]) + "</div>" +
                        '<div class="space-y-2 text-sm">' +
                        (x.why ? '<div><span class="font-medium text-gray-700">Vì sao sai: </span><span class="text-red-600">' + esc(x.why) + "</span></div>" : "") +
                        (x.correctReasoning ? '<div><span class="font-medium text-gray-700">Cách nghĩ đúng: </span><span class="text-green-700 font-semibold">' + esc(x.correctReasoning) + "</span></div>" : "") +
                        (x.tip ? '<div><span class="font-medium text-gray-700">Mẹo: </span><span class="text-gray-800">' + esc(x.tip) + "</span></div>" : "") +
                        "</div></div>";
                }).join("") + "</div></div>";
        }

        // ----- Kế hoạch ôn tập (khung tím như "So sánh với lời giải mẫu") -----
        if (Array.isArray(r.studyPlan) && r.studyPlan.length) {
            out += '<div class="bg-white border border-purple-200 rounded-2xl p-6 shadow-sm mb-6">' +
                '<h2 class="text-lg font-bold text-purple-900 mb-4 flex items-center gap-2">🗓️ Kế hoạch ôn tập</h2>' +
                '<ul class="space-y-2 list-disc list-inside">' + r.studyPlan.map(function (s) {
                    return '<li class="text-sm text-purple-900">' + esc(s) + "</li>";
                }).join("") + "</ul></div>";
        }

        return '<section class="qai-item">' + out + "</section>";
    }

    // ============================================================
    // PANEL
    // opts: {
    //   submissionId : string
    //   allowed      : [{id,label}]  — AI mà bài cho phép (rỗng = mọi key đang dùng được)
    //   maxAnalyses  : number
    //   analysisCount: number
    //   committed    : boolean       — bài đã lên GitHub chưa
    //   syncFailed   : boolean
    //   chipLabel    : function(id) → "Câu N"
    //   onAnalyzed   : function(data)
    // }
    // ============================================================
    function create(opts) {
        opts = opts || {};
        var keySelect = $("aiKeySelect");
        var modelSelect = $("modelSelect");
        var checkBtn = $("aiCheckBtn");
        var pill = $("aiStatusPill");
        var pillText = $("aiStatusText");
        var desc = $("aiDesc");
        var labelText = $("aiLabelText");
        var analyzeBtn = $("analyzeBtn");
        var msg = $("analyzeMsg");
        var list = $("analysisList");
        var randomBtn = $("aiRandomBtn");
        if (!keySelect || !modelSelect || !checkBtn || !analyzeBtn || !list) return null;

        var allowed = Array.isArray(opts.allowed) ? opts.allowed : [];
        var allowedLabel = {};
        allowed.forEach(function (a) { allowedLabel[String(a.id)] = a.label; });

        var state = {
            submissionId: opts.submissionId || "",
            max: opts.maxAnalyses || 5,
            count: opts.analysisCount || 0,
            committed: !!opts.committed,
            syncFailed: !!opts.syncFailed,
            aiConnected: false,
            checking: false,
            analyzing: false
        };

        // ---------- Trạng thái ----------
        function setStatus(type, text, d) {
            pill.classList.remove("checking", "connected", "error");
            if (type) pill.classList.add(type);
            pillText.textContent = text;
            if (d) desc.textContent = d;
        }
        function setMsg(text, isError) {
            msg.textContent = text || "";
            msg.classList.toggle("error", !!isError);
        }

        // Nút phân tích: mở khi (đã kiểm tra AI OK) VÀ (bài đã committed) VÀ chưa quá giới hạn
        function refreshButton() {
            var limit = state.count >= state.max;
            var ready = !!state.submissionId && state.committed && state.aiConnected && !state.analyzing && !limit;
            analyzeBtn.disabled = !ready;

            if (!state.submissionId) analyzeBtn.textContent = "Không có mã bài nộp";
            else if (limit) analyzeBtn.textContent = "Đã đạt số lần phân tích tối đa";
            else if (state.analyzing) analyzeBtn.textContent = "🤖 AI đang phân tích…";
            else if (state.syncFailed) analyzeBtn.textContent = "❌ Lưu bài lỗi";
            else if (!state.committed) analyzeBtn.textContent = "⏳ Đang lưu bài…";
            else if (!state.aiConnected) analyzeBtn.textContent = "🔒 Hãy kiểm tra AI trước";
            else analyzeBtn.textContent = state.count ? "🤖 Phân tích thêm bằng AI khác" : "🤖 Phân tích AI";
        }

        // ---------- Model ----------
        var modelLists = { gemini: [], vilao: [] };
        var defaultModels = { gemini: "", vilao: "" };

        function fillModelOptions(provider, extraModel) {
            var pid = normProvider(provider);
            var useOther = pid !== "gemini" && modelLists[pid] && modelLists[pid].length;
            var items = (useOther ? modelLists[pid] : modelLists.gemini).slice();
            if (extraModel && items.indexOf(extraModel) === -1) items.unshift(extraModel);
            modelSelect.innerHTML = '<option value="">— Chọn AI Key trước —</option>';
            items.forEach(function (m) {
                var o = document.createElement("option");
                o.value = m;
                o.textContent = m;
                modelSelect.appendChild(o);
            });
            modelSelect.dataset.default = defaultModels[useOther ? pid : "gemini"] || "";
        }
        function selectModelValue(v) {
            for (var i = 0; i < modelSelect.options.length; i++) {
                if (modelSelect.options[i].value === v) { modelSelect.selectedIndex = i; return true; }
            }
            return false;
        }
        async function loadModels() {
            try {
                var res = await fetch(API_AI + "/models");
                var data = await res.json();
                if (data.success) {
                    modelLists.gemini = data.models || [];
                    modelLists.vilao = data.vilaoModels || [];
                    defaultModels.gemini = data.defaultModel || "";
                    defaultModels.vilao = data.vilaoDefaultModel || "";
                    (data.providers || []).forEach(function (p) {
                        providerInfo[p.id] = p;
                        modelLists[p.id] = p.models || [];
                        defaultModels[p.id] = p.defaultModel || "";
                    });
                    fillModelOptions("gemini");
                }
            } catch (e) {
                console.warn("quizAiPanel.loadModels:", e);
            }
        }

        // ---------- Key ----------
        function syncModelFromKey() {
            var opt = keySelect.options[keySelect.selectedIndex];
            var keyModel = opt ? opt.getAttribute("data-model") || "" : "";
            var keyProvider = keySelect.value && opt ? opt.getAttribute("data-provider") || "gemini" : "gemini";
            var lbl = keySelect.value && opt ? opt.getAttribute("data-label") : "";
            if (labelText) labelText.textContent = lbl ? "🤖 " + lbl : "";

            var perKey = !!(providerInfo[keyProvider] ? providerInfo[keyProvider].modelPerKey : keyProvider === "vilao");
            fillModelOptions(keyProvider, perKey ? keyModel : "");
            modelSelect.disabled = false;
            if (keyModel && selectModelValue(keyModel)) {
                // Key kiểu vilao.ai (model theo key) → server luôn dùng model này
                if (perKey) modelSelect.disabled = true;
                return;
            }
            var def = modelSelect.dataset.default;
            if (def) selectModelValue(def);
        }

        async function loadKeys() {
            keySelect.innerHTML = '<option value="">— Đang tải key… —</option>';
            try {
                var res = await fetch(API_AI + "/keys");
                var data = await res.json();
                if (!data.success || !Array.isArray(data.keys)) throw new Error(data.message || "Không tải được danh sách AI Key.");

                var keys = data.keys;
                if (allowed.length) {
                    var ids = allowed.map(function (a) { return String(a.id); });
                    keys = keys.filter(function (k) { return ids.indexOf(String(k._id)) !== -1; });
                }

                keySelect.innerHTML = "";
                keys.forEach(function (k) {
                    var o = document.createElement("option");
                    o.value = k._id;
                    o.setAttribute("data-model", k.model || "");
                    // Ưu tiên nhãn do server dựng sẵn (formatAiLabel), không có thì tự ghép
                    var base = allowedLabel[String(k._id)] ||
                        (k.provider ? providerName(k.provider) + ": " : "") + k.name;
                    o.setAttribute("data-provider", normProvider(k.provider));
                    o.setAttribute("data-label", base);
                    var label = base + (k.model ? " (" + k.model + ")" : "");
                    if (!k.usable) {
                        if (!k.isActive) label += " [Đã tắt]";
                        else if (k.isDisabledTemp) {
                            var remain = k.disabledUntil ? Math.ceil((new Date(k.disabledUntil) - new Date()) / 60000) : 0;
                            label += remain > 0 ? " [Tạm nghỉ ~" + remain + "p]" : " [Tạm nghỉ]";
                        }
                        o.disabled = true;
                    }
                    o.textContent = label;
                    keySelect.appendChild(o);
                });

                var first = keys.find(function (k) { return k.usable; });
                if (!first) {
                    keySelect.innerHTML = '<option value="">— Không có AI Key khả dụng —</option>';
                    modelSelect.disabled = true;
                    throw new Error("Không có AI Key nào đang hoạt động. Liên hệ giảng viên / admin.");
                }
                keySelect.value = first._id;
                syncModelFromKey();
            } catch (e) {
                console.warn("quizAiPanel.loadKeys:", e);
                state.aiConnected = false;
                setStatus("error", "Chưa kết nối", e.message);
                refreshButton();
                throw e;
            }
        }

        // ---------- Kiểm tra AI (giống checkAIConnection của lesson.pug) ----------
        async function checkAIConnection() {
            if (state.checking) return;
            state.checking = true;
            checkBtn.disabled = true;
            checkBtn.textContent = "Đang kiểm tra...";
            setStatus("checking", "Đang kiểm tra", "Đang kết nối AI...");
            refreshButton();
            try {
                var model = modelSelect.value || "";
                var aiKeyId = keySelect.value || "";
                if (!aiKeyId) throw new Error("Chưa chọn AI Key.");

                var params = new URLSearchParams();
                if (model) params.append("model", model);
                params.append("aiKeyId", aiKeyId);

                var res = await fetch(API_AI + "/ai-status?" + params.toString(), { cache: "no-store" });
                var data = await res.json();
                if (!res.ok || !data.success || data.connected !== true) {
                    throw new Error(data.message || "AI chưa kết nối.");
                }

                state.aiConnected = true;
                if (labelText && (data.aiLabel || data.provider)) {
                    labelText.textContent = "🤖 " + (data.aiLabel ||
                        providerName(data.provider) + (data.keyName ? ": " + data.keyName : ""));
                }
                setStatus("connected", "Đã kết nối (" + (data.model || model || "") + ")",
                    "AI hoạt động" + (data.keyName ? " • Key: " + data.keyName : ""));
                setMsg("");
            } catch (err) {
                state.aiConnected = false;
                setStatus("error", "Chưa kết nối", err.message);
            } finally {
                state.checking = false;
                checkBtn.disabled = false;
                checkBtn.textContent = "🔄 Kiểm tra AI";
                refreshButton();
            }
        }

        // Đổi key/model → kết quả kiểm tra cũ không còn đúng → phải kiểm tra lại
        function invalidateCheck() {
            if (!state.aiConnected) return;
            state.aiConnected = false;
            setStatus("", "Chưa kiểm tra", "Đã đổi AI — hãy bấm “Kiểm tra AI” lại.");
            refreshButton();
        }

        // ---------- Kết quả ----------
        function bindChips() {
            list.querySelectorAll(".qai-chip:not([data-bound])").forEach(function (c) {
                c.setAttribute("data-bound", "1");
                c.addEventListener("click", function () {
                    var id = c.getAttribute("data-goto");
                    var t = document.getElementById("review-" + id);
                    // ý của câu đúng/sai: "tf-2-b" → khung của câu "tf-2"
                    if (!t) t = document.getElementById("review-" + String(id).replace(/-[a-z]$/i, ""));
                    if (!t) return;
                    t.scrollIntoView({ behavior: "smooth", block: "center" });
                    t.classList.remove("qai-flash");
                    void t.offsetWidth;
                    t.classList.add("qai-flash");
                });
            });
        }

        // analyses đã lưu trước đó (trang chi tiết) — mới nhất trên cùng
        function renderExisting(analyses) {
            if (!Array.isArray(analyses) || !analyses.length) return;
            var sorted = analyses.slice().sort(function (a, b) {
                return new Date(b.analyzedAt || 0) - new Date(a.analyzedAt || 0);
            });
            list.innerHTML = sorted.map(function (a, i) {
                return renderAnalysis(a, { no: sorted.length - i, chipLabel: opts.chipLabel });
            }).join("");
            bindChips();
        }

        async function analyze() {
            if (analyzeBtn.disabled || state.analyzing) return;
            if (!state.aiConnected) { setMsg("AI chưa kết nối. Hãy bấm “Kiểm tra AI” trước.", true); return; }

            state.analyzing = true;
            setMsg("");
            setStatus("checking", "Đang phân tích", "AI đang phân tích bài làm...");
            refreshButton();
            try {
                var body = { aiKeyId: keySelect.value, model: modelSelect.value || "" };
                var res = await fetch("/api/quiz/submissions/" + encodeURIComponent(state.submissionId) + "/analyze", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Accept: "application/json" },
                    body: JSON.stringify(body)
                });
                var data;
                try { data = await res.json(); } catch (e) { throw new Error("Server không trả JSON. Kiểm tra log backend."); }
                if (!res.ok || !data.success) throw new Error(data.message || "Phân tích thất bại.");

                state.count = data.analysisCount != null ? data.analysisCount : state.count + 1;
                if (data.analysis) {
                    list.insertAdjacentHTML("afterbegin", renderAnalysis(data.analysis, { no: state.count, chipLabel: opts.chipLabel }));
                    bindChips();
                }
                setStatus("connected", "Đã phân tích xong", "AI phân tích thành công.");
                if (data.limitReached) state.count = Math.max(state.count, state.max);
                if (typeof opts.onAnalyzed === "function") opts.onAnalyzed(data);
            } catch (err) {
                console.error("quizAiPanel.analyze:", err);
                // Lỗi AI → bắt kiểm tra lại (giống lesson.pug: lỗi chấm → "Chưa kết nối")
                state.aiConnected = false;
                setStatus("error", "Lỗi phân tích", err.message);
                setMsg("❌ " + err.message, true);
            } finally {
                state.analyzing = false;
                refreshButton();
            }
        }

        // ---------- Sự kiện ----------
        keySelect.addEventListener("change", function () { syncModelFromKey(); invalidateCheck(); });
        modelSelect.addEventListener("change", invalidateCheck);
        checkBtn.addEventListener("click", checkAIConnection);
        analyzeBtn.addEventListener("click", analyze);
        if (randomBtn) {
            randomBtn.addEventListener("click", function () {
                if (modelSelect.disabled) return;
                var opts2 = modelSelect.options;
                var real = [];
                for (var i = 0; i < opts2.length; i++) if (opts2[i].value) real.push(i);
                if (!real.length) return;
                modelSelect.selectedIndex = real[Math.floor(Math.random() * real.length)];
                invalidateCheck();
            });
        }

        // ---------- Khởi tạo: tải model → tải key → tự kiểm tra AI ----------
        refreshButton();
        loadModels().then(loadKeys).then(checkAIConnection).catch(function () { /* đã hiện lỗi trên thanh trạng thái */ });

        return {
            checkAIConnection: checkAIConnection,
            renderExisting: renderExisting,
            setCommitted: function (v) { state.committed = !!v; if (v) state.syncFailed = false; refreshButton(); },
            setSyncFailed: function () { state.syncFailed = true; state.committed = false; refreshButton(); },
            setMessage: setMsg
        };
    }

    window.QuizAiPanel = { create: create, renderAnalysis: renderAnalysis, providerName: providerName };
})();
