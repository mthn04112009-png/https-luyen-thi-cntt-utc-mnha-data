// ============================================================
// AI CONTROLLER - Gemini (chấm bài code CNTT + quản lý prompt)
// ============================================================

const mongoose = require("mongoose");

const {
    checkSubmissionByGemini,
    runCustomPrompt,
    testGeminiConnection,
    createCodeGradingPrompt,
    SUPPORTED_MODELS,
    getSafeModel,
} = require("../services/aiService");

const { writeJsonFile } = require("../services/githubService");

// ★ vilao.ai: model theo từng key (key vilao chỉ dùng được model đã subscribe)
const {
    normalizeProvider,
    formatAiLabel,
    getModelOptionsForKey,
    resolveModelForKey,
    isOpenAiProvider,
    getProvidersForClient,
    getDefaultGeminiModel,
} = require("../config/aiModels");

const GradingPrompt = (() => {
    try { return require("../models/GradingPrompt"); } catch (_) { return null; }
})();
const Subject = (() => {
    try { return require("../models/Subject"); } catch (_) { return null; }
})();
const Lesson = (() => {
    try { return require("../models/Lesson"); } catch (_) { return null; }
})();
const ModelComparison = (() => {
    try { return require("../models/ModelComparison"); } catch (_) { return null; }
})();
const AIKey = (() => {
    try { return require("../models/AIKey"); } catch (_) { return null; }
})();
const promptService = (() => {
    try { return require("../services/promptService"); } catch (_) { return null; }
})();

// ============================================================
// HELPERS
// ============================================================

function safeStr(v) { return typeof v === "string" ? v : ""; }

function clampTimeout(v, fb = 45000) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return fb;
    return Math.min(120000, n);
}

async function measure(fn) {
    const t0 = Date.now();
    try {
        return { data: await fn(), latencyMs: Date.now() - t0, error: null };
    } catch (e) {
        return { data: null, latencyMs: Date.now() - t0, error: e.message || String(e) };
    }
}

function pickModels(body) {
    const { models, model } = body || {};
    if (Array.isArray(models) && models.length) {
        const filtered = models
            .map((m) => String(m).trim())
            .filter((m) => !SUPPORTED_MODELS.length || SUPPORTED_MODELS.includes(m));
        return filtered.length ? filtered : [getDefaultGeminiModel()];
    }
    if (models === "all") return [...SUPPORTED_MODELS];
    if (model && (!SUPPORTED_MODELS.length || SUPPORTED_MODELS.includes(model))) {
        return [model];
    }
    return [getDefaultGeminiModel()];
}

function toObjId(v) {
    if (!v) return null;
    const s = String(v).trim();
    return mongoose.Types.ObjectId.isValid(s) ? s : null;
}

// ★ Đọc key (chỉ field cần thiết, KHÔNG lấy encryptedKey) để biết provider/model.
async function loadKeyMeta(aiKeyId) {
    const id = toObjId(aiKeyId);
    if (!id || !AIKey) return null;
    try {
        return await AIKey.findById(id).select("_id name provider model").lean();
    } catch (_) {
        return null;
    }
}

// ★ Chọn model cuối cùng theo key:
//   - Có key của nhà cung cấp kiểu OpenAI (vilao.ai, ChatGPT, DeepSeek…) → resolveModelForKey
//     (vilao.ai: model gắn trên key thắng, tránh 403 subscribe)
//   - Gemini / không chọn key → getSafeModel như cũ
async function resolveModelByKeyId(aiKeyId, requestedModel) {
    const keyDoc = await loadKeyMeta(aiKeyId);
    if (keyDoc && isOpenAiProvider(keyDoc.provider)) {
        return resolveModelForKey(keyDoc, requestedModel);
    }
    return getSafeModel(requestedModel);
}

/**
 * Chuẩn hoá rubric → mảng object gọn gàng để trả về FE
 */
function normalizeRubric(rubric) {
    if (!Array.isArray(rubric)) return [];
    return rubric.map((r) => ({
        criterion: r?.criterion || "",
        weight: Number(r?.weight) || 0,
        description: r?.description || ""
    }));
}

/**
 * Render prompt template với biến (dùng promptService nếu có)
 */
function renderTemplate(prompt, vars = {}) {
    if (promptService && typeof promptService.renderPromptTemplate === "function") {
        return promptService.renderPromptTemplate(prompt, vars);
    }

    // Fallback
    const rubricText = Array.isArray(prompt?.rubric) && prompt.rubric.length
        ? prompt.rubric
              .map((r, i) =>
                  `${i + 1}. ${r.criterion} (${r.weight}%): ${r.description || ''}`
              )
              .join('\n')
        : '(không có rubric)';

    return String(prompt?.content || '')
        .replace(/\{đề_bài\}/g, vars.topic || '(không có đề bài)')
        .replace(/\{bài_làm\}/g, vars.essay || '(không có bài làm)')
        .replace(/\{lời_giải_mẫu\}/g, vars.sampleSolution || '(không có)')
        .replace(/\{student_name\}/g, vars.studentName || '')
        .replace(/\{max_score\}/g, String(vars.maxScore ?? prompt?.maxScore ?? 10))
        .replace(/\{strictness\}/g, vars.strictness || prompt?.strictness || 'normal')
        .replace(/\{rubric\}/g, rubricText);
}

// ============================================================
// ★ RESOLVE PROMPT DOC (dùng nội bộ cho checkWriting)
// Ưu tiên: promptId → lesson.promptId → lesson.subject.promptId
//          → subjectId.promptId → global default → null
// ============================================================
async function resolvePromptDoc({ promptId, lessonId, subjectId } = {}) {
    if (!GradingPrompt) return { prompt: null, source: "fallback" };

    // 1. Explicit promptId
    if (promptId && mongoose.Types.ObjectId.isValid(promptId)) {
        const p = await GradingPrompt.findOne({ _id: promptId, active: true }).lean();
        if (p) return { prompt: p, source: "explicit" };
    }

    // 2. Lesson → lesson.promptId → subject.promptId
    if (lessonId && mongoose.Types.ObjectId.isValid(lessonId) && Lesson) {
        const lesson = await Lesson.findById(lessonId).lean();
        if (lesson?.promptId) {
            const p = await GradingPrompt.findOne({ _id: lesson.promptId, active: true }).lean();
            if (p) return { prompt: p, source: "lesson" };
        }
        if (lesson?.subjectId && Subject) {
            const subj = await Subject.findById(lesson.subjectId).lean();
            if (subj?.promptId) {
                const p = await GradingPrompt.findOne({ _id: subj.promptId, active: true }).lean();
                if (p) return { prompt: p, source: "subject" };
            }
        }
    }

    // 3. SubjectId trực tiếp
    if (subjectId && mongoose.Types.ObjectId.isValid(subjectId) && Subject) {
        const subj = await Subject.findById(subjectId).lean();
        if (subj?.promptId) {
            const p = await GradingPrompt.findOne({ _id: subj.promptId, active: true }).lean();
            if (p) return { prompt: p, source: "subject" };
        }
    }

    // 4. Global default
    const def = await GradingPrompt.findOne({
        scope: "global",
        isDefault: true,
        active: true
    }).lean();
    if (def) return { prompt: def, source: "global" };

    return { prompt: null, source: "fallback" };
}

// ============================================================
// 0. LIST AI KEYS — cho dropdown ở lesson.pug
// GET /api/ai/keys
// ============================================================
async function listKeys(req, res) {
    try {
        if (!AIKey) {
            return res.json({ success: true, total: 0, keys: [] });
        }

        const now = new Date();

        const keys = await AIKey.find({
            isRevoked: { $ne: true }
        })
            .select("_id name provider model lastFour lastUsedAt usageCount isActive disabledUntil quotaErrorCount")
            .sort({ isActive: -1, lastUsedAt: 1, usageCount: 1 })
            .lean();

        const mapped = keys.map((k) => {
            const isDisabledTemp =
                k.disabledUntil && new Date(k.disabledUntil) > now;
            const isUsable = k.isActive === true && !isDisabledTemp;

            return {
                _id: String(k._id),
                name: k.name || "AI Key",
                provider: normalizeProvider(k.provider),
                label: formatAiLabel(k.provider, k.name),
                model: k.model || null,
                lastFour: k.lastFour || null,
                maskedKey: k.lastFour
                    ? "••••••••••••" + k.lastFour
                    : "••••••••••••••••",
                usable: isUsable,
                isActive: k.isActive === true,
                isDisabledTemp,
                disabledUntil: k.disabledUntil || null,
                usageCount: k.usageCount || 0,
                quotaErrorCount: k.quotaErrorCount || 0
            };
        });

        mapped.sort((a, b) => {
            if (a.usable !== b.usable) return a.usable ? -1 : 1;
            return 0;
        });

        return res.json({
            success: true,
            total: mapped.length,
            usableCount: mapped.filter((k) => k.usable).length,
            keys: mapped
        });
    } catch (error) {
        console.error("❌ listKeys:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
}

// ============================================================
// ★ 0.5. LIST ACTIVE PROMPTS (JSON) — kèm FULL RUBRIC
// GET /api/ai/prompts
// ------------------------------------------------------------
// Dùng cho dropdown "Prompt chấm điểm" ở form bài học (admin)
// ============================================================
async function listActivePrompts(req, res) {
    try {
        if (!GradingPrompt) {
            return res.json({ success: true, total: 0, prompts: [] });
        }

        const prompts = await GradingPrompt.find({ active: true })
            .select(
                "_id name description content scope strictness maxScore " +
                "isDefault rubric variables version subjectId lessonId"
            )
            .populate("subjectId", "name code")
            .populate("lessonId", "title")
            .sort({ isDefault: -1, name: 1 })
            .lean();

        return res.json({
            success: true,
            total: prompts.length,
            prompts: prompts.map((p) => ({
                _id: String(p._id),
                name: p.name,
                description: p.description || "",
                content: p.content || "",
                scope: p.scope || "global",
                strictness: p.strictness || "normal",
                maxScore: p.maxScore ?? 10,
                isDefault: p.isDefault === true,
                version: p.version || 1,
                variables: Array.isArray(p.variables) ? p.variables : [],

                // ★ FULL RUBRIC
                rubric: normalizeRubric(p.rubric),
                rubricCount: Array.isArray(p.rubric) ? p.rubric.length : 0,

                subjectId: p.subjectId ? String(p.subjectId._id || p.subjectId) : null,
                subjectName: p.subjectId?.name || null,
                lessonId: p.lessonId ? String(p.lessonId._id || p.lessonId) : null,
                lessonTitle: p.lessonId?.title || null
            }))
        });
    } catch (error) {
        console.error("❌ listActivePrompts:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
}

// ============================================================
// ★ 0.6. GET ONE PROMPT (JSON) — kèm full rubric
// GET /api/ai/prompts/:id
// ============================================================
async function getPromptById(req, res) {
    try {
        if (!GradingPrompt) {
            return res.status(501).json({ success: false, message: "Chưa có model GradingPrompt." });
        }

        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: "ID không hợp lệ." });
        }

        const prompt = await GradingPrompt.findById(id)
            .populate("subjectId", "name code")
            .populate("lessonId", "title")
            .lean();

        if (!prompt) {
            return res.status(404).json({ success: false, message: "Không tìm thấy prompt." });
        }

        return res.json({
            success: true,
            prompt: {
                ...prompt,
                _id: String(prompt._id),
                rubric: normalizeRubric(prompt.rubric),
                rubricCount: Array.isArray(prompt.rubric) ? prompt.rubric.length : 0,
                variables: Array.isArray(prompt.variables) ? prompt.variables : []
            }
        });
    } catch (error) {
        console.error("❌ getPromptById:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
}

// ============================================================
// ★ 0.7. RESOLVE PROMPT CHO LESSON — kèm full rubric
// GET /api/ai/prompts/resolve/:lessonId
// ------------------------------------------------------------
// Trả về prompt SẼ ĐƯỢC DÙNG khi chấm bài lesson này
// Ưu tiên: lesson.promptId → subject.promptId → global default → fallback
// ============================================================
async function resolvePromptForLesson(req, res) {
    try {
        if (!GradingPrompt || !Lesson || !Subject) {
            return res.status(501).json({ success: false, message: "Thiếu model cần thiết." });
        }

        const { lessonId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(lessonId)) {
            return res.status(400).json({ success: false, message: "lessonId không hợp lệ." });
        }

        const lesson = await Lesson.findById(lessonId).lean();
        if (!lesson) {
            return res.status(404).json({ success: false, message: "Không tìm thấy bài học." });
        }

        const { prompt: resolved, source } = await resolvePromptDoc({
            lessonId,
            subjectId: lesson.subjectId ? String(lesson.subjectId) : null
        });

        if (!resolved) {
            return res.json({
                success: true,
                source: "fallback",
                prompt: null,
                message:
                    "Không có prompt trong DB → hệ thống sẽ dùng prompt mặc định (hardcoded)."
            });
        }

        return res.json({
            success: true,
            source,
            prompt: {
                _id: String(resolved._id),
                name: resolved.name,
                description: resolved.description || "",
                content: resolved.content || "",
                variables: Array.isArray(resolved.variables) ? resolved.variables : [],

                // ★ FULL RUBRIC
                rubric: normalizeRubric(resolved.rubric),
                rubricCount: Array.isArray(resolved.rubric) ? resolved.rubric.length : 0,

                strictness: resolved.strictness || "normal",
                maxScore: resolved.maxScore ?? 10,
                scope: resolved.scope || "global",
                isDefault: resolved.isDefault === true,
                version: resolved.version || 1
            }
        });
    } catch (error) {
        console.error("❌ resolvePromptForLesson:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
}

// ============================================================
// ★ 0.8. PREVIEW PROMPT (không gọi AI) — kèm full rubric
// POST /api/ai/prompts/preview
// ------------------------------------------------------------
// Body: { promptId, topic, essay, sampleSolution, studentName }
// ============================================================
async function previewPrompt(req, res) {
    try {
        if (!GradingPrompt) {
            return res.status(501).json({ success: false, message: "Chưa có model GradingPrompt." });
        }

        const {
            promptId,
            topic = "",
            essay = "",
            sampleSolution = "",
            studentName = ""
        } = req.body || {};

        if (!mongoose.Types.ObjectId.isValid(promptId)) {
            return res.status(400).json({ success: false, message: "promptId không hợp lệ." });
        }

        const prompt = await GradingPrompt.findById(promptId).lean();
        if (!prompt) {
            return res.status(404).json({ success: false, message: "Không tìm thấy prompt." });
        }

        const renderedContent = renderTemplate(prompt, {
            topic,
            essay,
            sampleSolution,
            studentName,
            maxScore: prompt.maxScore ?? 10,
            strictness: prompt.strictness || "normal"
        });

        return res.json({
            success: true,
            promptId: String(prompt._id),
            promptName: prompt.name,
            version: prompt.version || 1,
            maxScore: prompt.maxScore ?? 10,
            strictness: prompt.strictness || "normal",

            // ★ FULL RUBRIC + content gốc
            content: prompt.content || "",
            variables: Array.isArray(prompt.variables) ? prompt.variables : [],
            rubric: normalizeRubric(prompt.rubric),
            rubricCount: Array.isArray(prompt.rubric) ? prompt.rubric.length : 0,

            promptLength: renderedContent.length,
            renderedContent
        });
    } catch (error) {
        console.error("❌ previewPrompt:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
}

// ============================================================
// ★ 0.9. TEST PROMPT VỚI AI — kèm full rubric
// POST /api/ai/prompts/test
//   hoặc /api/ai/prompts/:id/test
// ------------------------------------------------------------
// Body:
//   { promptId|:id, topic, answer|essay, sampleSolution, studentName, model, aiKeyId }
//   hoặc { models: 'all' } để chạy hết model + lưu ModelComparison
// ============================================================
async function testPrompt(req, res) {
    try {
        if (!GradingPrompt) {
            return res.status(501).json({ success: false, message: "Chưa có model GradingPrompt." });
        }

        // Hỗ trợ cả 2 kiểu route: /test (body.promptId) và /:id/test (params.id)
        const promptId =
            req.params?.id || req.body?.promptId || req.body?.id;

        if (!mongoose.Types.ObjectId.isValid(promptId)) {
            return res.status(400).json({ success: false, message: "promptId không hợp lệ." });
        }

        const topic = safeStr(req.body?.topic).trim();
        const essay = safeStr(req.body?.answer || req.body?.essay).trim();
        const sampleSolution = safeStr(req.body?.sampleSolution).trim();
        const studentName = safeStr(req.body?.studentName).trim();
        const aiKeyId = safeStr(req.body?.aiKeyId).trim() || null;
        const timeout = clampTimeout(req.body?.timeoutMs, 45000);

        if (!essay) {
            return res.status(400).json({ success: false, message: "Bài làm đang trống." });
        }

        const gp = await GradingPrompt.findById(promptId).lean();
        if (!gp) {
            return res.status(404).json({ success: false, message: "Không tìm thấy prompt." });
        }
        if (gp.active === false) {
            return res.status(400).json({
                success: false,
                message: "Prompt đã bị vô hiệu hoá, không thể test."
            });
        }

        // Render template
        const renderedContent = renderTemplate(gp, {
            topic,
            essay,
            sampleSolution,
            studentName,
            maxScore: gp.maxScore ?? 10,
            strictness: gp.strictness || "normal"
        });

        // Chọn model(s) để chạy
        const keyMeta = await loadKeyMeta(aiKeyId);
        const isVilaoKey = keyMeta && isOpenAiProvider(keyMeta.provider);   // key kiểu OpenAI (vilao.ai, ChatGPT…)
        const runAll = req.body?.models === "all";
        // Key kiểu OpenAI: chỉ chạy 1 model (vilao.ai: model đã subscribe trên key), không chạy list Gemini
        const modelsToRun = isVilaoKey
            ? [resolveModelForKey(keyMeta, safeStr(req.body?.model).trim() || null)]
            : runAll
                ? [...SUPPORTED_MODELS]
                : pickModels(req.body);

        const results = [];
        for (const m of modelsToRun) {
            const { data, latencyMs, error } = await measure(() =>
                runCustomPrompt(renderedContent, m, timeout, aiKeyId)
            );

            results.push({
                model: m,
                score: data?.score ?? null,
                feedback:
                    data?.feedback ??
                    data?.overall_comment ??
                    (typeof data?.raw === "string" ? data.raw : "") ??
                    "",
                breakdown: Array.isArray(data?.breakdown) ? data.breakdown : [],
                latencyMs,
                error,
                success: !error
            });

            await new Promise((r) => setTimeout(r, 400));
        }

        // Lưu ModelComparison nếu chạy hết model
        let comparisonId = null;
        if (runAll && ModelComparison) {
            try {
                const doc = await ModelComparison.create({
                    promptId: gp._id,
                    promptSnapshot: renderedContent,
                    topic: topic || null,
                    essay,
                    studentName: studentName || null,
                    results: results.map((r) => ({
                        model: r.model,
                        score: r.score,
                        latencyMs: r.latencyMs,
                        feedback: r.feedback,
                        error: r.error
                    })),
                    createdBy: req.session?.user?._id || req.user?._id || null
                });
                comparisonId = doc._id;
            } catch (e) {
                console.warn("⚠️ Lưu ModelComparison:", e.message);
            }
        }

        return res.json({
            success: true,
            promptId: String(gp._id),
            promptName: gp.name,
            version: gp.version || 1,
            promptLength: renderedContent.length,
            renderedPreview: renderedContent.slice(0, 2000),

            // ★ FULL RUBRIC
            rubric: normalizeRubric(gp.rubric),
            rubricCount: Array.isArray(gp.rubric) ? gp.rubric.length : 0,
            maxScore: gp.maxScore ?? 10,
            strictness: gp.strictness || "normal",

            comparisonId,
            totalModels: modelsToRun.length,
            successCount: results.filter((r) => r.success).length,
            results
        });
    } catch (error) {
        console.error("❌ testPrompt:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
}

// ============================================================
// 1. CHECK SUBMISSION — chấm 1 bài
// POST /api/ai/check
// ------------------------------------------------------------
// Body: topic, answer|essay, model, aiKeyId, timeoutMs,
//       sampleSolution, studentName, maxScore,
//       (tùy chọn) promptId | lessonId | subjectId
//
// Nếu có prompt DB (explicit/lesson/subject/global default) →
// dùng runCustomPrompt với prompt đã render + rubric.
// Ngược lại → fallback hardcoded (checkSubmissionByGemini).
// ============================================================
async function checkWriting(req, res) {
    try {
        const topic = safeStr(req.body?.topic || req.body?.prompt).trim();
        const answer = safeStr(req.body?.answer || req.body?.essay).trim();
        const timeout = clampTimeout(req.body?.timeoutMs, 45000);
        const aiKeyId = safeStr(req.body?.aiKeyId).trim() || null;
        const model = await resolveModelByKeyId(aiKeyId, req.body?.model);

        const sampleSolution = safeStr(req.body?.sampleSolution).trim();
        const studentName = safeStr(req.body?.studentName).trim();
        const maxScore = Number(req.body?.maxScore) || 10;

        const promptId = toObjId(req.body?.promptId);
        const lessonId = toObjId(req.body?.lessonId);
        const subjectId = toObjId(req.body?.subjectId);

        if (!answer) {
            return res.status(400).json({ success: false, message: "Bài làm đang trống." });
        }

        console.log(
            `🤖 [ai.checkWriting] model=${model} keyId=${aiKeyId || "auto"} ` +
            `promptId=${promptId || "-"} lessonId=${lessonId || "-"} subjectId=${subjectId || "-"}`
        );

        // 1. Thử resolve prompt từ DB
        const { prompt: dbPrompt, source } = await resolvePromptDoc({
            promptId,
            lessonId,
            subjectId
        });

        // 2. Nếu có prompt DB → render + runCustomPrompt
        if (dbPrompt) {
            const rendered = renderTemplate(dbPrompt, {
                topic,
                essay: answer,
                sampleSolution,
                studentName,
                maxScore: dbPrompt.maxScore ?? maxScore,
                strictness: dbPrompt.strictness || "normal"
            });

            const { data, latencyMs, error } = await measure(() =>
                runCustomPrompt(rendered, model, timeout, aiKeyId)
            );

            if (error) {
                return res.status(502).json({
                    success: false,
                    model,
                    source,
                    promptId: String(dbPrompt._id),
                    message: error
                });
            }

            return res.json({
                success: true,
                model,
                latencyMs,
                source,
                promptId: String(dbPrompt._id),
                promptName: dbPrompt.name,
                promptVersion: dbPrompt.version || 1,
                rubric: normalizeRubric(dbPrompt.rubric),
                rubricCount: Array.isArray(dbPrompt.rubric) ? dbPrompt.rubric.length : 0,
                maxScore: dbPrompt.maxScore ?? maxScore,
                strictness: dbPrompt.strictness || "normal",
                result: data
            });
        }

        // 3. Fallback: prompt hardcoded
        const { data, latencyMs, error } = await measure(() =>
            checkSubmissionByGemini(
                topic,
                answer,
                timeout,
                model,
                aiKeyId,
                { sampleSolution, studentName, maxScore }
            )
        );

        if (error) {
            return res.status(502).json({ success: false, model, source: "fallback", message: error });
        }

        return res.json({
            success: true,
            model,
            latencyMs,
            source: "fallback",
            promptId: null,
            promptName: null,
            rubric: [],
            rubricCount: 0,
            maxScore,
            result: data
        });
    } catch (error) {
        console.error("❌ checkWriting:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
}

// ============================================================
// 2. COMPARE MODELS — so sánh nhiều model
// POST /api/ai/compare
// ============================================================
async function compareModels(req, res) {
    try {
        const topic = safeStr(req.body?.topic).trim();
        const answer = safeStr(req.body?.answer || req.body?.essay).trim();
        const timeout = clampTimeout(req.body?.timeoutMs, 45000);
        const saveComp = Boolean(req.body?.saveComparison);
        const studentName = safeStr(req.body?.studentName).trim() || null;
        const aiKeyId = safeStr(req.body?.aiKeyId).trim() || null;
        const sampleSolution = safeStr(req.body?.sampleSolution).trim();
        const maxScore = Number(req.body?.maxScore) || 10;

        if (!answer) {
            return res.status(400).json({ success: false, message: "Bài làm đang trống." });
        }

        const modelsToRun = pickModels(req.body);
        console.log(`🤖 [ai.compareModels] ${modelsToRun.length} models keyId=${aiKeyId || "auto"}`);

        const results = [];
        for (const m of modelsToRun) {
            const { data, latencyMs, error } = await measure(() =>
                checkSubmissionByGemini(
                    topic,
                    answer,
                    timeout,
                    m,
                    aiKeyId,
                    { sampleSolution, studentName, maxScore }
                )
            );
            results.push({
                model: m,
                score: data?.score ?? null,
                wordCount: data?.wordCount ?? null,
                grammarScore: data?.grammar?.score ?? null,
                vocabularyScore: data?.vocabulary?.score ?? null,
                coherenceScore: data?.coherence?.score ?? null,
                contentScore: data?.content?.score ?? null,
                overallComment: data?.overall_comment ?? "",
                strengths: data?.strengths ?? [],
                weaknesses: data?.weaknesses ?? [],
                improvements: data?.improvements ?? [],
                breakdown: data?.breakdown ?? [],
                grammarErrors: data?.grammar?.errors ?? [],
                latencyMs, error, success: !error,
            });
            await new Promise((r) => setTimeout(r, 400));
        }

        const successCount = results.filter((r) => r.success).length;

        let comparisonId = null;
        if (saveComp && ModelComparison) {
            try {
                const doc = await ModelComparison.create({
                    topic: topic || null,
                    essay: answer,
                    studentName,
                    promptSnapshot: createCodeGradingPrompt(topic, answer, {
                        sampleSolution,
                        studentName,
                        maxScore
                    }),
                    results: results.map((r) => ({
                        model: r.model, score: r.score, latencyMs: r.latencyMs,
                        feedback: r.overallComment, error: r.error,
                    })),
                    createdBy: req.session?.user?._id || req.user?._id || null,
                });
                comparisonId = doc._id;
            } catch (e) {
                console.warn("⚠️ Không lưu ModelComparison:", e.message);
            }
        }

        return res.json({
            success: true,
            totalModels: modelsToRun.length,
            successCount,
            failedCount: modelsToRun.length - successCount,
            comparisonId,
            results,
        });
    } catch (error) {
        console.error("❌ compareModels:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
}

// ============================================================
// 3. TEST CONNECTION
// GET /api/ai/ai-status
// ============================================================
async function testConnection(req, res) {
    try {
        const model = req.query?.model || req.body?.model || null;
        const aiKeyId = safeStr(req.query?.aiKeyId || req.body?.aiKeyId).trim() || null;
        const timeout = clampTimeout(req.query?.timeoutMs, 30000);
        const selectedModel = await resolveModelByKeyId(aiKeyId, model);

        const { data, latencyMs, error } = await measure(() =>
            testGeminiConnection(selectedModel, timeout, aiKeyId)
        );

        if (error) {
            return res.status(502).json({
                success: false,
                connected: false,
                model: selectedModel,
                message: error
            });
        }

        return res.json({
            success: true,
            connected: true,
            model: selectedModel,
            latencyMs,
            response: data?.response || "OK",
            keyName: data?.keyUsed?.name || null,
            keyId: data?.keyUsed?.id || null,
        });
    } catch (error) {
        return res.status(500).json({ success: false, connected: false, message: error.message });
    }
}

// ============================================================
// 4. TEST ALL
// ============================================================
async function testAllConnections(req, res) {
    try {
        const timeout = clampTimeout(req.query?.timeoutMs, 30000);
        const results = [];
        for (const m of SUPPORTED_MODELS) {
            const { data, latencyMs, error } = await measure(() =>
                testGeminiConnection(m, timeout)
            );
            results.push({
                model: m,
                connected: !error,
                latencyMs,
                response: data?.response || null,
                error
            });
            await new Promise((r) => setTimeout(r, 250));
        }
        const connectedCount = results.filter((r) => r.connected).length;
        return res.json({
            success: true,
            total: SUPPORTED_MODELS.length,
            connectedCount,
            failedCount: SUPPORTED_MODELS.length - connectedCount,
            results,
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
}

// ============================================================
// 5. LIST MODELS
// ============================================================
// GET /api/ai/models?aiKeyId=<id>
//   Có aiKeyId → danh sách THEO KEY (vilao: model đã gắn trên key, hoặc gợi ý)
//   Không có   → danh sách Gemini như cũ (tương thích ngược)
async function listModels(req, res) {
    try {
        const aiKeyId = safeStr(req.query?.aiKeyId).trim();
        if (aiKeyId) {
            const keyDoc = await loadKeyMeta(aiKeyId);
            if (!keyDoc) {
                return res.status(404).json({ success: false, message: "Không tìm thấy AI key." });
            }
            const opts = getModelOptionsForKey(keyDoc);
            return res.json({
                success: true,
                provider: opts.provider,
                defaultModel: opts.defaultModel,
                fixed: opts.fixed,
                total: opts.models.length,
                models: opts.models,
            });
        }
        // Trang làm bài đọc 1 lần: models/defaultModel = Gemini,
        // providers = TẤT CẢ nhà cung cấp (AI-database/index.json) → chọn theo provider của key đang chọn;
        // vilaoModels/vilaoDefaultModel giữ lại cho trang cũ chưa đọc `providers`.
        const providers = getProvidersForClient();
        const gem = providers.find((p) => p.id === "gemini");
        const vil = providers.find((p) => p.id === "vilao");
        return res.json({
            success: true,
            provider: "gemini",
            defaultModel: gem ? gem.defaultModel : getDefaultGeminiModel(),
            fixed: false,
            total: gem ? gem.models.length : SUPPORTED_MODELS.length,
            models: gem ? gem.models : SUPPORTED_MODELS,
            vilaoModels: vil ? vil.models : [],
            vilaoDefaultModel: vil ? vil.defaultModel : "",
            providers,
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
}

// ============================================================
// 6. SAVE TO GITHUB (adhoc)
// ============================================================
async function saveToGithub(req, res) {
    try {
        const topic = safeStr(req.body?.topic).trim();
        const answer = safeStr(req.body?.answer).trim();
        const model = await resolveModelByKeyId(req.body?.aiKeyId, req.body?.model);
        const result = req.body?.result || null;
        const sampleSolution = safeStr(req.body?.sampleSolution).trim();
        const studentName = safeStr(req.body?.studentName).trim();

        if (!answer || !result) {
            return res.status(400).json({ success: false, message: "Thiếu answer hoặc result." });
        }

        const user = req.session?.user || req.user;
        const userId = user?._id || user?.id || "anonymous";
        const ts = Date.now();
        const path = `submissions/_adhoc/${userId}-${ts}.json`;

        const payload = {
            userId: String(userId),
            userName: user?.name || null,
            topic,
            answer,
            wordCount: result?.wordCount ?? 0,
            score: result?.score ?? null,
            model,
            submittedAt: new Date().toISOString(),
            feedback: result,
            promptSnapshot: createCodeGradingPrompt(topic, answer, {
                sampleSolution,
                studentName
            }),
        };

        const saved = await writeJsonFile(
            path,
            payload,
            `ai.check: ${userId} - ${result?.score ?? "?"}/10`
        );
        return res.json({ success: true, github: { path: saved.path, url: saved.url } });
    } catch (error) {
        console.error("❌ saveToGithub:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
}

// ============================================================
// 9. LỊCH SỬ SO SÁNH
// ============================================================
async function getComparison(req, res) {
    try {
        if (!ModelComparison) {
            return res.status(501).json({ success: false, message: "Chưa có model ModelComparison." });
        }
        const doc = await ModelComparison.findById(req.params.id).lean();
        if (!doc) return res.status(404).json({ success: false, message: "Không tìm thấy." });
        return res.json({ success: true, comparison: doc });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
}

async function listComparisons(req, res) {
    try {
        if (!ModelComparison) {
            return res.status(501).json({ success: false, message: "Chưa có model ModelComparison." });
        }
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
        const docs = await ModelComparison.find({})
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();
        return res.json({ success: true, total: docs.length, comparisons: docs });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
}

module.exports = {
    // AI keys
    listKeys,

    // ★ PROMPTS — BỔ SUNG + FULL RUBRIC
    listActivePrompts,
    getPromptById,
    resolvePromptForLesson,
    previewPrompt,
    testPrompt,

    // AI chấm
    checkWriting,
    compareModels,
    testConnection,
    testAllConnections,
    listModels,
    saveToGithub,
    getComparison,
    listComparisons,

    // Debug/Internal (không dùng trong route nhưng hữu ích)
    resolvePromptDoc
};