// controllers/prompt.controller.js
const mongoose = require('mongoose');
const GradingPrompt = require('../models/GradingPrompt');
const Subject = require('../models/Subject');
const Lesson = require('../models/Lesson');
const lessonContentService = require('../services/lessonContentService');
const githubSync = require('../services/githubSyncService');
const { paginate } = require('./pagination.controller');

// ★ PHÂN QUYỀN THEO userKey
const { isDefaultAdmin } = require('../middleware/auth');
const { canManageOwned, ownContentFilter } = require('../middleware/role');

// ★ CHANGED: cần 1 service để ĐỌC JSON từ GitHub khi render form edit.
//   Nếu bạn có sẵn hàm khác (vd: syncQueueService.fetchJson,
//   githubService.getFileContent, ...) thì đổi lại require + tên hàm
//   trong readPromptJsonFromGithub() cho khớp.
const githubService = require('../services/githubService');
const {
    normalizeKind,
    kindFilter,
    findUnknownPlaceholders
} = require('../services/promptService');
const { QUIZ_PLACEHOLDERS, DEFAULT_QUIZ_ANALYSIS_PROMPT } = require('../config/quizConfig');

// ============================================================
// HELPERS
// ============================================================
function getUserId(req) {
    // req.user do attachUser đọc lại từ DB → không tin session (có thể cũ)
    return req.user?._id || null;
}

const NOT_OWNER_MSG = 'Bạn chỉ được sửa/xoá prompt do chính mình tạo.';

// ★ Admin user_key chỉ được gán prompt cho MÔN do chính mình tạo.
//   Trả về subjectId hợp lệ (hoặc null). Ném lỗi nếu vi phạm.
async function resolveSubjectId(actor, scope, subjectId) {
    if (scope !== 'subject' || !subjectId || !mongoose.Types.ObjectId.isValid(subjectId)) {
        return null;
    }
    if (isDefaultAdmin(actor)) return subjectId;

    const owned = await Subject.exists({ _id: subjectId, ...ownContentFilter(actor, Subject) });
    if (!owned) throw new Error('Bạn chỉ được gán prompt cho môn học do chính mình tạo.');
    return subjectId;
}

// ★ Admin user_key chỉ được gán prompt cho BÀI do chính mình tạo.
async function resolveLessonIds(actor, scope, raw) {
    if (scope !== 'lesson') return [];
    const ids = [...new Set(normalizeIds(raw).map(String))];
    if (!ids.length || isDefaultAdmin(actor)) return ids;

    const owned = await Lesson.find({ _id: { $in: ids }, ...ownContentFilter(actor, Lesson) })
        .select('_id')
        .lean();
    if (owned.length !== ids.length) {
        throw new Error('Bạn chỉ được gán prompt cho bài học do chính mình tạo.');
    }
    return owned.map((l) => l._id);
}

function validateRubric(rubric) {
    if (!Array.isArray(rubric) || rubric.length === 0) {
        return { ok: false, error: 'Rubric phải có ít nhất 1 tiêu chí.' };
    }
    const sum = rubric.reduce((acc, r) => acc + Number(r.weight || 0), 0);
    if (Math.round(sum) !== 100) {
        return { ok: false, error: `Tổng weight phải = 100% (hiện tại: ${sum}%).` };
    }
    return { ok: true };
}

function normalizeIds(value) {
    const arr = Array.isArray(value) ? value : (value ? [value] : []);
    return arr.filter((id) => id && mongoose.Types.ObjectId.isValid(id));
}

// ★ GitHub là nguồn sự thật: gán/gỡ prompt cho bài học phải ghi cả vào file JSON
//   của bài (field promptId) — nếu chỉ ghi Mongo, lần sửa file bài sau sẽ ghi đè lại.
async function setLessonPrompt(lessonIds, promptId, onlyIfPromptId = null) {
    if (!lessonIds.length) return;
    const filter = { _id: { $in: lessonIds } };
    if (onlyIfPromptId) filter.promptId = onlyIfPromptId;
    const lessons = await Lesson.find(filter).select('_id title githubFile').lean();

    for (const l of lessons) {
        const set = { promptId: promptId || null };
        if (l.githubFile && githubService.isConfigured) {
            try {
                const r = await lessonContentService.patchLessonFile(
                    l.githubFile,
                    { promptId: promptId ? String(promptId) : null },
                    `[Lesson] ${promptId ? 'Gán' : 'Gỡ'} prompt: ${l.title}`
                );
                if (r && r.sha) set.githubSha = r.sha;
            } catch (e) {
                console.warn(`[prompt] Không ghi được promptId vào ${l.githubFile}:`, e.message);
            }
        }
        await Lesson.updateOne({ _id: l._id }, { $set: set }, { timestamps: false });
    }
}

async function syncLessonAssignments(promptId, oldLessonIds, newLessonIds) {
    const oldSet = new Set(oldLessonIds.map(String));
    const newSet = new Set(newLessonIds.map(String));

    const added = newLessonIds.filter((id) => !oldSet.has(String(id)));
    const removed = oldLessonIds.filter((id) => !newSet.has(String(id)));

    if (added.length) await setLessonPrompt(added, promptId);
    if (removed.length) await setLessonPrompt(removed, null, promptId);
}

function parseRubric(body) {
    if (body.rubricJson) {
        try {
            const parsed = JSON.parse(body.rubricJson);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    const criteria = [].concat(body.criterion || []);
    const weights = [].concat(body.weight || []);
    const descriptions = [].concat(body.rubricDescription || []);

    return criteria
        .map((c, i) => ({
            criterion: (c || '').trim(),
            weight: Number(weights[i]) || 0,
            description: (descriptions[i] || '').trim()
        }))
        .filter((r) => r.criterion);
}

// ★ CHANGED: danh sách biến mặc định (trước đây hardcode trong createPrompt,
//   giờ tách riêng để cả create + update dùng chung, và vì `variables`
//   không còn lưu Mongo nữa).
const DEFAULT_VARIABLES = [
    '{đề_bài}', '{bài_làm}', '{rubric}', '{max_score}',
    '{student_name}', '{lời_giải_mẫu}', '{hình_vẽ}'
];

// ★ Prompt trắc nghiệm (kind = 'quiz') có bộ biến riêng
const variablesForKind = (kind) =>
    normalizeKind(kind) === 'quiz' ? [...QUIZ_PLACEHOLDERS] : DEFAULT_VARIABLES;

// ★ Biến lạ / biến của loại khác → báo lỗi theo kind.
//   Quiz: chặn cứng (dùng {rubric}… sẽ không được thay → AI nhận nguyên chữ {rubric}).
//   Essay: giữ hành vi cũ (chỉ cảnh báo ở nơi chấm), không chặn lưu.
function validatePlaceholders(content, kind) {
    if (normalizeKind(kind) !== 'quiz') return { ok: true };
    const unknown = findUnknownPlaceholders(content, 'quiz');
    if (!unknown.length) return { ok: true };
    return {
        ok: false,
        error:
            `Prompt trắc nghiệm có biến không hợp lệ: ${unknown.join(', ')}. ` +
            `Biến hợp lệ: ${QUIZ_PLACEHOLDERS.join(', ')}.`
    };
}

// kind lấy từ body (lúc tạo) hoặc query; luôn chuẩn hoá về 'essay' | 'quiz'
const kindFromReq = (req) => normalizeKind(req.body?.kind || req.query?.kind);

// ============================================================
// GITHUB I/O — nguồn thật duy nhất của content / rubric / variables
// ============================================================

// Đọc file JSON prompt từ GitHub — dùng đúng tên hàm thật trong
// services/githubService.js (readJsonFile), không phải fetchJson.
async function readPromptJsonFromGithub(prompt) {
    if (!prompt || !prompt.githubFile) return null;
    try {
        return await githubService.readJsonFile(prompt.githubFile);
    } catch (e) {
        console.warn(`[prompt] Không đọc được ${prompt.githubFile}:`, e.message);
        return null;
    }
}

// ★ Ghi file JSON prompt lên GitHub (ĐỒNG BỘ, không qua queue) và trả về { sha, ... }.
//   File chứa ĐỦ thông tin (kể cả isDefault, môn/bài gán, người tạo) để dựng lại
//   GradingPrompt trong MongoDB chỉ từ GitHub. Lỗi → ném ra để nơi gọi KHÔNG lưu Mongo.
async function pushPromptToGithub(prompt, content, rubric, variables, extra = {}) {
    if (!prompt.githubFile) return null;
    if (!githubService.isConfigured) throw new Error('GitHub chưa được cấu hình.');

    const data = {
        promptId: String(prompt._id),
        name: prompt.name,
        description: prompt.description || '',
        content: content || '',
        rubric: rubric || [],
        strictness: prompt.strictness,
        maxScore: prompt.maxScore,
        scope: prompt.scope,
        kind: normalizeKind(prompt.kind),
        subjectId: prompt.subjectId ? String(prompt.subjectId) : null,
        lessonIds: (prompt.lessonIds || []).map(String),
        isDefault: Boolean(prompt.isDefault),
        variables: variables || [],
        version: prompt.version,
        active: prompt.active !== false,
        createdBy: extra.createdBy || null,
        createdAt: extra.createdAt || prompt.createdAt || new Date(),
        updatedAt: new Date()
    };

    const result = await githubService.writeJsonFile(
        prompt.githubFile,
        data,
        `[Prompt] ${extra.isNew ? 'Create' : 'Update'}: ${prompt.name}`
    );
    console.log(`📤 [prompt] Đã ghi GitHub: ${prompt.githubFile}`);
    return result;
}

// Người tạo prompt để ghi vào JSON: ưu tiên giá trị đã có trong file, rồi tới Mongo
async function creatorMeta(prompt, previous) {
    if (previous && previous.createdBy) return previous.createdBy;
    if (!prompt.createdBy) return null;
    try {
        const User = require('../models/User');
        const u = await User.findById(prompt.createdBy).select('name email').lean();
        return u
            ? { id: String(u._id), name: u.name || '', email: u.email || '' }
            : { id: String(prompt.createdBy), name: '', email: '' };
    } catch (_) {
        return { id: String(prompt.createdBy), name: '', email: '' };
    }
}

// Sửa một vài field trong file JSON prompt đã có (không đụng content/rubric).
// File không còn trên GitHub → trả null (bản ghi sẽ tự biến mất ở lần đồng bộ sau).
async function patchPromptJson(prompt, patch, message) {
    if (!prompt || !prompt.githubFile || !githubService.isConfigured) return null;
    try {
        return await githubService.updateJsonFile(
            prompt.githubFile,
            (cur) => ({ ...(cur || {}), ...patch, updatedAt: new Date() }),
            message
        );
    } catch (e) {
        if (/không tồn tại/i.test(e.message) || e.status === 404) return null;
        throw e;
    }
}

// Bỏ cờ mặc định của các prompt CÙNG kind khác (cả Mongo lẫn file JSON)
async function unsetOtherDefaults(kind, exceptId) {
    const others = await GradingPrompt.find({
        _id: { $ne: exceptId }, isDefault: true, ...kindFilter(kind)
    }).select('_id name githubFile').lean();

    for (const o of others) {
        const set = { isDefault: false };
        try {
            const r = await patchPromptJson(o, { isDefault: false }, `[Prompt] Bỏ mặc định: ${o.name}`);
            if (r && r.sha) set.githubSha = r.sha;
        } catch (e) {
            console.warn(`[prompt] Không bỏ được cờ mặc định trong ${o.githubFile}:`, e.message);
        }
        await GradingPrompt.updateOne({ _id: o._id }, { $set: set });
    }
}

function actorMeta(req) {
    const u = req.user || {};
    return { id: String(u._id || ''), name: u.name || '', email: u.email || '' };
}

// ============================================================
// LIST — GET /admin/prompts   (KHÔNG ĐỔI)
// ============================================================
exports.getPrompts = async (req, res, next) => {
    try {
        const { scope, active, search } = req.query;
        const actor = req.user;

        // ★ Danh sách prompt lấy từ GitHub (prompts/*.json); bài học để hiện tên khi gán
        await githubSync.syncKinds(['lessons', 'prompts']);

        // ★ Tab Tự luận | Trắc nghiệm (mặc định tự luận; khớp cả prompt cũ thiếu `kind`)
        const kind = normalizeKind(req.query.kind);
        const filter = { ...kindFilter(kind) };
        if (scope) filter.scope = scope;
        if (active === '1') filter.active = true;
        if (active === '0') filter.active = false;
        if (search && search.trim()) {
            filter.name = { $regex: search.trim(), $options: 'i' };
        }

        const [{ items: prompts, pagination }, subjects, lessons] = await Promise.all([
            paginate(GradingPrompt, filter, req, {
                limit: 8,
                sort: { isDefault: -1, createdAt: -1 },
                populate: [
                    { path: 'subjectId', select: 'name code' },
                    { path: 'lessonIds', select: 'title' },
                    { path: 'createdBy', select: 'name email' },
                    { path: 'updatedBy', select: 'name email' }   // ★ hiển thị "Cập nhật bởi"
                ]
            }),
            Subject.find({ deletedAt: null, deletedForever: { $ne: true }, ...ownContentFilter(actor, Subject) })
                .sort({ name: 1 }).lean(),
            Lesson.find({ deletedAt: null, deletedForever: { $ne: true }, ...ownContentFilter(actor, Lesson) })
                .populate('subjectId', 'name')
                .sort({ createdAt: -1 }).lean()
        ]);

        // ★ Mọi admin đều XEM được danh sách; chỉ chủ prompt (hoặc admin default) mới sửa/xoá.
        prompts.forEach((p) => {
            p.canManage = canManageOwned(actor, p.createdBy);
        });

        return res.render('admin/prompts', {
            title: 'Quản lý Prompt chấm điểm',
            user: req.user,
            isDefaultAdmin: isDefaultAdmin(actor),
            prompts,
            subjects,
            lessons,
            kind,
            ...pagination,
            filters: {
                scope: scope || '',
                active: active || '',
                search: search || ''
            },
            success: req.query.success || null,
            error: req.query.error || null
        });
    } catch (err) {
        console.error('getPrompts error:', err);
        return res.status(500).render('error', {
            title: 'Lỗi',
            message: 'Không thể tải danh sách prompt.',
            statusCode: 500,
            stack: null
        });
    }
};

// ============================================================
// CREATE — POST /admin/prompts
// ============================================================
exports.createPrompt = async (req, res, next) => {
    try {
        const {
            name, description, content,
            strictness, maxScore,
            scope, subjectId,
            isDefault, active
        } = req.body;

        if (!name || !name.trim()) {
            return res.redirect('/admin/prompts?error=' + encodeURIComponent('Tên prompt không được để trống.'));
        }
        if (!content || !content.trim()) {
            return res.redirect('/admin/prompts?error=' + encodeURIComponent('Nội dung prompt không được để trống.'));
        }

        // ★ kind chọn lúc tạo và KHÔNG đổi sau khi tạo
        const kind = kindFromReq(req);
        const backUrl = `/admin/prompts?kind=${kind}&error=`;

        // Prompt quiz: không có rubric / strictness / maxScore (điểm do server tính)
        //  → bỏ kiểm tra "tổng weight = 100%" (chỉ áp cho tự luận)
        let rubric = [];
        if (kind === 'essay') {
            rubric = parseRubric(req.body);
            const check = validateRubric(rubric);
            if (!check.ok) {
                return res.redirect(backUrl + encodeURIComponent(check.error));
            }
        } else {
            const ph = validatePlaceholders(content, kind);
            if (!ph.ok) return res.redirect(backUrl + encodeURIComponent(ph.error));
        }

        const actor = req.user;

        // ★ Kiểm tra quyền gán môn/bài TRƯỚC mọi thao tác ghi (ném lỗi nếu vi phạm)
        const lessonIds = await resolveLessonIds(actor, scope, req.body.lessonIds);
        const safeSubjectId = await resolveSubjectId(actor, scope, subjectId);

        // ★ Chỉ admin default được đặt prompt mặc định toàn hệ thống
        const setDefault = isDefaultAdmin(actor) && (isDefault === 'on' || isDefault === true);

        // ★ GitHub là nguồn sự thật → GHI GITHUB TRƯỚC, thành công mới tạo bản ghi Mongo.
        //   Tên file NGẪU NHIÊN, đã kiểm tra không trùng với file nào đang có trên GitHub.
        const _id = new mongoose.Types.ObjectId();
        const createdAt = new Date();
        const githubFile = await githubService.uniqueJsonPath('prompts', { timestamp: true });

        const draft = {
            _id,
            name: name.trim(),
            description: (description || '').trim(),
            kind,
            strictness: kind === 'quiz' ? 'normal' : (strictness || 'normal'),
            maxScore: kind === 'quiz' ? 10 : (Number(maxScore) || 10),
            scope: scope || 'global',
            subjectId: safeSubjectId,
            lessonIds,
            isDefault: setDefault,
            active: active !== 'off',
            version: 1,
            githubFile,
            createdAt
        };

        let saved;
        try {
            saved = await pushPromptToGithub(draft, content.trim(), rubric, variablesForKind(kind), {
                isNew: true,
                createdBy: actorMeta(req),
                createdAt
            });
        } catch (e) {
            console.error('[prompt] createPrompt: ghi GitHub lỗi, KHÔNG tạo prompt:', e.message);
            return res.redirect(backUrl + encodeURIComponent('Không lưu được prompt lên GitHub nên chưa tạo: ' + e.message));
        }

        // ★ Mỗi `kind` có 1 mặc định riêng → chỉ bỏ cờ của prompt CÙNG kind (cả file JSON lẫn Mongo)
        if (setDefault) await unsetOtherDefaults(kind, _id);

        // MongoDB chỉ giữ metadata + con trỏ tới file
        const prompt = await GradingPrompt.create({
            _id,
            name: draft.name,
            description: draft.description,
            kind,
            strictness: draft.strictness,
            maxScore: draft.maxScore,
            scope: draft.scope,
            subjectId: safeSubjectId,
            lessonIds,
            isDefault: setDefault,
            active: draft.active,
            version: 1,
            githubFile,
            githubSha: (saved && saved.sha) || null,
            createdBy: getUserId(req),
            updatedBy: getUserId(req)
        });

        if (lessonIds.length) {
            await syncLessonAssignments(prompt._id, [], lessonIds);
        }

        return res.redirect(`/admin/prompts?kind=${kind}&success=` + encodeURIComponent(`Đã tạo prompt "${prompt.name}".`));
    } catch (err) {
        console.error('createPrompt error:', err);
        return res.redirect(`/admin/prompts?kind=${kindFromReq(req)}&error=` + encodeURIComponent('Không thể tạo: ' + err.message));
    }
};

// ============================================================
// EDIT FORM — GET /admin/prompts/:id/edit
// ============================================================
exports.showEditPrompt = async (req, res, next) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.redirect('/admin/prompts?error=' + encodeURIComponent('ID không hợp lệ.'));
        }

        const actor = req.user;
        const [prompt, subjects, lessons] = await Promise.all([
            GradingPrompt.findById(id).lean(),
            Subject.find({ deletedAt: null, deletedForever: { $ne: true }, ...ownContentFilter(actor, Subject) })
                .sort({ name: 1 }).lean(),
            Lesson.find({ deletedAt: null, deletedForever: { $ne: true }, ...ownContentFilter(actor, Lesson) })
                .populate('subjectId', 'name').sort({ createdAt: -1 }).lean()
        ]);

        if (!prompt) {
            return res.redirect('/admin/prompts?error=' + encodeURIComponent('Không tìm thấy prompt.'));
        }

        // ★ Chỉ chủ prompt (createdBy) hoặc admin default mới mở được form sửa.
        //   Kiểm tra TRƯỚC khi đọc nội dung từ GitHub để không lộ content/rubric.
        if (!canManageOwned(actor, prompt.createdBy)) {
            return res.redirect('/admin/prompts?error=' + encodeURIComponent(NOT_OWNER_MSG));
        }

        // ★ CHANGED: nội dung thật nằm trên GitHub — merge tạm vào object
        //   chỉ để render view, KHÔNG lưu lại vào Mongo.
        const remote = await readPromptJsonFromGithub(prompt);
        if (remote) {
            prompt.content   = remote.content   || '';
            prompt.rubric    = remote.rubric    || [];
            prompt.variables = remote.variables || [];
        } else {
            prompt.content   = '';
            prompt.rubric    = [];
            prompt.variables = [];
            if (prompt.githubFile) {
                console.warn(`[prompt] Form edit: không đọc được ${prompt.githubFile} từ GitHub.`);
            }
        }

        // ★ FIX: lấy đúng trạng thái THẬT — bài nào đang thực sự trỏ
        //   Lesson.promptId = prompt này — thay vì tin field prompt.lessonIds
        //   đã lưu (có thể lệch nếu lesson được gán qua dropdown ở trang sửa
        //   Lesson, vì đường đó ghi thẳng Lesson.promptId, không đụng tới
        //   prompt.lessonIds). Nhờ vậy checkbox ở đây luôn khớp với trang Lesson.
        const assignedLessons = await Lesson.find({ promptId: prompt._id, ...ownContentFilter(actor, Lesson) })
            .select('_id')
            .lean();
        prompt.lessonIds = assignedLessons.map((l) => l._id);

        return res.render('admin/prompt-form', {
            title: 'Sửa Prompt',
            user: req.user,
            canSetDefault: isDefaultAdmin(actor),
            kind: normalizeKind(prompt.kind),
            quizVars: QUIZ_PLACEHOLDERS,
            quizDefaultContent: DEFAULT_QUIZ_ANALYSIS_PROMPT,
            prompt,
            subjects,
            lessons,
            success: req.query.success || null,
            error: req.query.error || null
        });
    } catch (err) {
        console.error('showEditPrompt error:', err);
        return res.redirect('/admin/prompts?error=' + encodeURIComponent('Không thể tải prompt.'));
    }
};

// ============================================================
// CREATE FORM — GET /admin/prompts/create   (KHÔNG ĐỔI)
// ============================================================
exports.showCreatePrompt = async (req, res, next) => {
    try {
        const actor = req.user;
        const [subjects, lessons] = await Promise.all([
            Subject.find({ deletedAt: null, deletedForever: { $ne: true }, ...ownContentFilter(actor, Subject) })
                .sort({ name: 1 }).lean(),
            Lesson.find({ deletedAt: null, deletedForever: { $ne: true }, ...ownContentFilter(actor, Lesson) })
                .populate('subjectId', 'name').sort({ createdAt: -1 }).lean()
        ]);

        return res.render('admin/prompt-form', {
            title: 'Thêm Prompt',
            user: req.user,
            canSetDefault: isDefaultAdmin(actor),
            kind: normalizeKind(req.query.kind),
            quizVars: QUIZ_PLACEHOLDERS,                      // ★ biến hợp lệ của prompt trắc nghiệm
            quizDefaultContent: DEFAULT_QUIZ_ANALYSIS_PROMPT, // ★ mẫu prompt trắc nghiệm
            prompt: null,
            subjects,
            lessons,
            success: null,
            error: req.query.error || null
        });
    } catch (err) {
        console.error('showCreatePrompt error:', err);
        return res.redirect('/admin/prompts?error=' + encodeURIComponent('Không thể mở form.'));
    }
};

// ============================================================
// UPDATE — POST /admin/prompts/:id/edit
// ============================================================
exports.updatePrompt = async (req, res, next) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.redirect('/admin/prompts?error=' + encodeURIComponent('ID không hợp lệ.'));
        }

        const prompt = await GradingPrompt.findById(id);
        if (!prompt) {
            return res.redirect('/admin/prompts?error=' + encodeURIComponent('Không tìm thấy prompt.'));
        }

        // ★ Chỉ chủ prompt (createdBy) hoặc admin default mới được sửa
        const actor = req.user;
        if (!canManageOwned(actor, prompt.createdBy)) {
            return res.redirect('/admin/prompts?error=' + encodeURIComponent(NOT_OWNER_MSG));
        }

        const {
            name, description, content,
            strictness, maxScore,
            scope, subjectId,
            isDefault, active
        } = req.body;

        // ★ kind của prompt đã tạo là CỐ ĐỊNH — bỏ qua mọi `kind` client gửi lên
        const kind = normalizeKind(prompt.kind);

        let rubric = [];
        if (kind === 'essay') {
            rubric = parseRubric(req.body);
            const check = validateRubric(rubric);
            if (!check.ok) {
                return res.redirect(`/admin/prompts/${id}/edit?error=` + encodeURIComponent(check.error));
            }
        } else {
            const ph = validatePlaceholders(content, kind);
            if (!ph.ok) {
                return res.redirect(`/admin/prompts/${id}/edit?error=` + encodeURIComponent(ph.error));
            }
        }

        // ★ CHANGED: so content mới với content CŨ trên GitHub (không phải
        //   prompt.content nữa, vì field này không còn tồn tại).
        const previous = await readPromptJsonFromGithub(prompt);
        const oldContent = previous?.content || '';
        const contentChanged = content && content.trim() !== oldContent;

        // ★ FIX: "bài cũ" phải lấy từ trạng thái THẬT trong Lesson
        //   (Lesson.find({promptId: prompt._id})), không lấy từ prompt.lessonIds
        //   đã lưu — vì lesson có thể được gán/gỡ trực tiếp qua dropdown ở
        //   trang sửa Lesson (không đi qua đây), khiến prompt.lessonIds lệch
        //   so với thực tế → checkbox tick sai + có thể gán/gỡ nhầm bài khi lưu.
        //   ★ Admin user_key chỉ "thấy" các bài của chính mình → không gỡ nhầm bài của người khác.
        const assignedLessonsNow = await Lesson.find({ promptId: prompt._id, ...ownContentFilter(actor, Lesson) })
            .select('_id')
            .lean();
        const oldLessonIds = assignedLessonsNow.map((l) => String(l._id));

        // ★ FIX: giữ lại scope CŨ (trước khi ghi đè bên dưới) để phân biệt
        //   "admin đang sửa prompt scope=lesson" với "admin chủ động đổi
        //   scope từ lesson sang cái khác" — hai trường hợp cần xử lý khác
        //   nhau, xem chi tiết ở khối sync bên dưới.
        const previousScope = prompt.scope;
        // ★ Kiểm tra quyền gán môn/bài (ném lỗi nếu admin user_key gán môn/bài không phải của mình)
        const newLessonIds = await resolveLessonIds(actor, scope, req.body.lessonIds);
        const safeSubjectId = await resolveSubjectId(actor, scope, subjectId);

        // ---- Chỉ cập nhật METADATA vào Mongo ----
        if (name) prompt.name = name.trim();
        if (typeof description === 'string') prompt.description = description.trim();
        // ★ ĐÃ BỎ: prompt.content = content.trim()
        // ★ ĐÃ BỎ: prompt.rubric = rubric
        if (kind === 'essay') {
            prompt.strictness = strictness || prompt.strictness;
            prompt.maxScore = Number(maxScore) || prompt.maxScore;
        }
        prompt.scope = scope || prompt.scope;
        prompt.subjectId = safeSubjectId;
        prompt.lessonIds = newLessonIds;

        // ★ Chỉ admin default được bật/tắt "mặc định"; admin user_key giữ nguyên giá trị hiện tại
        const setDefault = isDefaultAdmin(actor)
            ? (isDefault === 'on' || isDefault === true)
            : prompt.isDefault;
        const becameDefault = setDefault && !prompt.isDefault;
        prompt.isDefault = setDefault;
        prompt.active = active !== 'off';

        if (contentChanged) {
            prompt.version = (prompt.version || 1) + 1;
        }

        prompt.updatedBy = getUserId(req);

        // Prompt cũ chưa có file → cấp tên file ngẫu nhiên không trùng
        if (!prompt.githubFile) {
            prompt.githubFile = await githubService.uniqueJsonPath('prompts', { timestamp: true });
        }

        // ★ GitHub là nguồn sự thật → GHI GITHUB TRƯỚC. Lỗi → KHÔNG lưu MongoDB
        //   (nếu lưu Mongo trước, hai nơi sẽ lệch nhau).
        const variables = previous?.variables?.length ? previous.variables : variablesForKind(kind);
        const finalContent = (content && content.trim()) || oldContent;
        let saved;
        try {
            saved = await pushPromptToGithub(prompt, finalContent, rubric, variables, {
                createdBy: await creatorMeta(prompt, previous),
                createdAt: previous?.createdAt || prompt.createdAt
            });
        } catch (githubErr) {
            return res.redirect(
                `/admin/prompts/${id}/edit?error=` +
                encodeURIComponent(
                    'Không ghi được lên GitHub nên chưa lưu thay đổi: ' +
                    githubErr.message +
                    '. Nội dung CŨ vẫn đang được dùng để chấm bài — vui lòng thử lại.'
                )
            );
        }
        prompt.githubSha = (saved && saved.sha) || prompt.githubSha;

        if (becameDefault) await unsetOtherDefaults(kind, prompt._id);

        await prompt.save();

        // Chỉ đụng vào Lesson.promptId trong đúng 2 trường hợp có chủ đích:
        if (scope === 'lesson') {
            // 1) Đang sửa prompt scope=lesson → đồng bộ theo đúng checkbox vừa chọn.
            await syncLessonAssignments(prompt._id, oldLessonIds, newLessonIds);
        } else if (previousScope === 'lesson' && oldLessonIds.length) {
            // 2) Admin CHỦ ĐỘNG đổi scope từ 'lesson' sang scope khác → gỡ hết bài cũ.
            await syncLessonAssignments(prompt._id, oldLessonIds, []);
        }

        return res.redirect(`/admin/prompts/${id}/edit?success=` + encodeURIComponent('Đã cập nhật prompt và đồng bộ GitHub thành công.'));
    } catch (err) {
        console.error('updatePrompt error:', err);
        return res.redirect(`/admin/prompts/${req.params.id}/edit?error=` + encodeURIComponent('Không thể cập nhật: ' + err.message));
    }
};

// ============================================================
// SET DEFAULT — POST /admin/prompts/:id/set-default   (KHÔNG ĐỔI)
// ============================================================
exports.setDefault = async (req, res, next) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.redirect('/admin/prompts?error=' + encodeURIComponent('ID không hợp lệ.'));
        }

        // ★ Prompt mặc định ảnh hưởng MỌI tổ chức → chỉ admin default
        if (!isDefaultAdmin(req.user)) {
            return res.redirect('/admin/prompts?error=' + encodeURIComponent('Chỉ quản trị viên hệ thống mới được đặt prompt mặc định.'));
        }

        // Kiểm tra tồn tại TRƯỚC khi gỡ default cũ (tránh id sai → mất luôn prompt mặc định)
        const target = await GradingPrompt.findById(id).select('_id name kind githubFile').lean();
        if (!target) {
            return res.redirect('/admin/prompts?error=' + encodeURIComponent('Không tìm thấy prompt.'));
        }

        // ★ GitHub là nguồn sự thật: đánh dấu mặc định trong file JSON TRƯỚC
        const set = { isDefault: true, updatedBy: getUserId(req) };
        try {
            const r = await patchPromptJson(target, { isDefault: true }, `[Prompt] Đặt mặc định: ${target.name}`);
            if (r && r.sha) set.githubSha = r.sha;
        } catch (e) {
            return res.redirect('/admin/prompts?error=' + encodeURIComponent('Không ghi được GitHub nên chưa đặt mặc định: ' + e.message));
        }

        // ★ Mặc định là MỖI kind một prompt: chỉ bỏ cờ của prompt cùng kind
        //   (cả file JSON lẫn Mongo; trước đây updateMany({}) sẽ gỡ luôn mặc định của loại kia).
        await unsetOtherDefaults(target.kind, target._id);
        await GradingPrompt.updateOne({ _id: id }, { $set: set });

        return res.redirect(`/admin/prompts?kind=${normalizeKind(target.kind)}&success=` + encodeURIComponent('Đã đặt làm prompt mặc định.'));
    } catch (err) {
        console.error('setDefault error:', err);
        return res.redirect('/admin/prompts?error=' + encodeURIComponent('Không thể đặt default.'));
    }
};

// ============================================================
// DELETE (soft) — POST /admin/prompts/:id/delete   (KHÔNG ĐỔI)
// ============================================================
exports.deletePrompt = async (req, res, next) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.redirect('/admin/prompts?error=' + encodeURIComponent('ID không hợp lệ.'));
        }

        const prompt = await GradingPrompt.findById(id);
        if (!prompt) {
            return res.redirect('/admin/prompts?error=' + encodeURIComponent('Không tìm thấy prompt.'));
        }
        if (!canManageOwned(req.user, prompt.createdBy)) {
            return res.redirect('/admin/prompts?error=' + encodeURIComponent(NOT_OWNER_MSG));
        }
        if (prompt.isDefault) {
            return res.redirect('/admin/prompts?error=' + encodeURIComponent('Không thể xoá prompt mặc định. Hãy đặt prompt khác làm default trước.'));
        }

        // ★ Ghi active:false vào file JSON TRƯỚC (nếu không lần đồng bộ sau sẽ bật lại)
        try {
            const r = await patchPromptJson(prompt, { active: false }, `[Prompt] Vô hiệu hoá: ${prompt.name}`);
            if (r && r.sha) prompt.githubSha = r.sha;
        } catch (e) {
            return res.redirect('/admin/prompts?error=' + encodeURIComponent('Không ghi được GitHub nên chưa vô hiệu hoá: ' + e.message));
        }

        prompt.active = false;
        prompt.updatedBy = getUserId(req);
        await prompt.save();

        return res.redirect('/admin/prompts?success=' + encodeURIComponent('Đã vô hiệu hoá prompt.'));
    } catch (err) {
        console.error('deletePrompt error:', err);
        return res.redirect('/admin/prompts?error=' + encodeURIComponent('Không thể xoá.'));
    }
};

// ============================================================
// HARD DELETE — POST /admin/prompts/:id/hard-delete   (KHÔNG ĐỔI)
// ============================================================
exports.hardDeletePrompt = async (req, res, next) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.redirect('/admin/prompts?error=' + encodeURIComponent('ID không hợp lệ.'));
        }

        const prompt = await GradingPrompt.findById(id);
        if (!prompt) {
            return res.redirect('/admin/prompts?error=' + encodeURIComponent('Không tìm thấy prompt.'));
        }
        if (!canManageOwned(req.user, prompt.createdBy)) {
            return res.redirect('/admin/prompts?error=' + encodeURIComponent(NOT_OWNER_MSG));
        }
        if (prompt.isDefault) {
            return res.redirect('/admin/prompts?error=' + encodeURIComponent('Không thể xoá prompt mặc định.'));
        }

        // ★ Xoá file JSON trên GitHub TRƯỚC (đồng bộ), rồi mới xoá bản ghi Mongo.
        //   Chỉ xoá file nằm trong thư mục prompts/.
        if (prompt.githubFile && /^prompts\/[^/]+\.json$/.test(prompt.githubFile) && githubService.isConfigured) {
            try {
                await githubService.deleteFile(prompt.githubFile, `[Prompt] Hard delete: ${prompt.name}`);
            } catch (e) {
                console.error('[prompt] Xoá file GitHub lỗi:', e.message);
                return res.redirect('/admin/prompts?error=' + encodeURIComponent('Không xoá được file trên GitHub nên chưa xoá prompt: ' + e.message));
            }
        }

        await GradingPrompt.deleteOne({ _id: id });

        return res.redirect('/admin/prompts?success=' + encodeURIComponent('Đã xoá vĩnh viễn prompt.'));
    } catch (err) {
        console.error('hardDeletePrompt error:', err);
        return res.redirect('/admin/prompts?error=' + encodeURIComponent('Không thể xoá vĩnh viễn.'));
    }
};

module.exports = exports;