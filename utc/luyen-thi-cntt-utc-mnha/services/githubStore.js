// ============================================================
// GITHUB STORE — GitHub là NƠI DUY NHẤT chứa lessons / prompts / submissions
// ------------------------------------------------------------
// Không còn collection Mongo cho 3 loại này. Quy ước đường dẫn (slug môn xác
// định môn học ngay trên đường dẫn):
//
//   subjects/{subject-slug}/lessons/{file}.json          → Lesson
//   subjects/{subject-slug}/flashcards/{file}.json       → Flashcard (ứng dụng /flashcards; thẻ nằm trong file, RAM chỉ giữ chỉ mục)
//   subjects/{subject-slug}/slides/{file}.json           → Slide (ứng dụng /slides; JSON chỉ chứa thông tin, file PDF MÃ HOÁ nằm cạnh: {file}.pdf)
//   prompts/{file}.json                                  → GradingPrompt
//   submissions/{subject-slug}/{lesson-slug}/{file}.json → Submission
//
// Cách hoạt động:
//   1. Lần đầu: 1 request lấy cây thư mục → đọc TẤT CẢ file khớp (GraphQL, ~40
//      file/request) → dựng chỉ mục trong RAM (không giữ nội dung nặng).
//   2. WEBHOOK (POST /webhooks/github, sự kiện push): payload cho biết chính xác
//      file nào thêm / sửa / xoá → chỉ đọc đúng các file đó, cập nhật RAM ngay.
//   3. Lưới an toàn (instance khác không nhận webhook / webhook trượt): mỗi ≥5s
//      hỏi SHA đầu nhánh bằng ETag (304 không tốn quota). Đổi → so cây thư mục
//      và đọc đúng file mới/đổi, xoá file không còn.
//   4. Ghi: controller ghi JSON lên GitHub như cũ; Model.create/save/updateOne
//      cập nhật RAM rồi gọi persist() → chỉ commit khi PHẦN CHỈ MỤC khác file.
//
// Hạn chế cần biết (serverless): bản ghi bài nộp đang "pending/grading" chỉ
// nằm trong RAM của instance xử lý cho tới khi file JSON được ghi.
// ============================================================

const crypto = require('crypto');
const mongoose = require('mongoose');
const { toObjectId, newId } = require('./githubModel');

let githubService = null;
let cfg = null;
function gh() {
    if (!githubService) {
        githubService = require('./githubService');
        cfg = require('../config/github');
    }
    return githubService;
}

const HEAD_CHECK_MS = Number(process.env.GITHUB_HEAD_CHECK_MS || 5000);
const DELETE_GRACE_MS = 30 * 1000;   // không xoá bản ghi vừa tạo/sửa trong khoảng này
const GRAPHQL_BATCH = 40;
const CONCURRENCY = 5;

const STRICTNESS = ['lenient', 'normal', 'strict', 'very_strict'];
const SCOPES = ['global', 'subject', 'lesson'];
const SUB_STATUS = ['pending', 'grading', 'graded', 'failed', 'regrading'];
const TRANSIENT = ['pending', 'grading', 'regrading'];

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
// Nội dung nặng (đề, rubric…) được cache 60s ở lessonContentService → xoá khi file đổi
function clearContentCache(path) {
    try { require('./lessonContentService').clearCache(path); } catch (_) { /* không bắt buộc */ }
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');
function toDate(v) {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}
const hex = (v) => (v == null ? null : String(v.toHexString ? v.toHexString() : v));

// id ổn định cho file KHÔNG có id trong JSON (mọi instance ra cùng 1 id)
function idFromPath(path) {
    return new mongoose.Types.ObjectId(crypto.createHash('sha1').update(path).digest('hex').slice(0, 24));
}

function quizCounts(quiz) {
    const parts = (quiz && quiz.parts) || {};
    const n = (k) => (parts[k] && Array.isArray(parts[k].questions) ? parts[k].questions.length : 0);
    return { mcq: n('mcq'), tf: n('tf'), fill: n('fill') };
}

// so sánh giá trị JSON (id → hex, ngày → ISO, undefined → null)
function stable(v) {
    return JSON.stringify(v, (k, x) => {
        if (x === undefined) return null;
        if (x && typeof x === 'object' && typeof x.toHexString === 'function') return x.toHexString();
        return x;
    });
}
const iso = (d) => (d ? new Date(d).toISOString() : null);

// ------------------------------------------------------------
// Định nghĩa 3 loại: path → record (fromJson) và record → patch JSON (toPatch)
// ------------------------------------------------------------
const KINDS = {
    lessons: {
        re: /^subjects\/([^/]+)\/lessons\/([^/]+)\.json$/,
        defaults: () => ({
            description: '', sampleSolution: '', duration: 20, order: 0,
            githubFile: null, githubSha: null, promptId: null, aiKeyId: null, model: null,
            isPublished: true, type: 'essay', quizCounts: { mcq: 0, tf: 0, fill: 0 },
            analysisAiKeyIds: [], userKey: null, createdBy: null, updatedBy: null,
            isDeleted: false, deletedAt: null, deletedBy: null, slug: null
        }),
        idKey: 'lessonId',
        fromJson(path, m, json, ctx) {
            const subject = ctx.subjects.get(m[1]);
            if (!subject) return { skip: `không có môn học slug "${m[1]}"` };
            const isQuiz = json.type === 'quiz';
            const r = {
                subjectId: subject._id, userKey: subject.userKey || null,
                type: isQuiz ? 'quiz' : 'essay',
                slug: (str(json.slug) || m[2]).toLowerCase(),
                title: (str(json.title) || m[2]).slice(0, 200)
            };
            if (typeof json.description === 'string') r.description = json.description;
            if (typeof json.sampleSolution === 'string') r.sampleSolution = json.sampleSolution;
            const dur = Number(json.duration);
            if (dur > 0) r.duration = Math.min(Math.max(Math.round(dur), 1), 600);
            if (Number.isFinite(Number(json.order))) r.order = Number(json.order);
            if (json.model !== undefined) r.model = json.model ? String(json.model) : null;
            if (typeof json.isPublished === 'boolean') r.isPublished = json.isPublished;
            if (json.isDeleted !== undefined) {
                r.isDeleted = json.isDeleted === true;
                r.deletedAt = r.isDeleted ? (toDate(json.deletedAt) || new Date()) : null;
            }
            if (isQuiz) r.quizCounts = quizCounts(json.quiz);
            if (json.promptId !== undefined) r.promptId = toObjectId(json.promptId);
            if (json.aiKeyId !== undefined) r.aiKeyId = toObjectId(json.aiKeyId);
            if (Array.isArray(json.analysisAiKeyIds)) r.analysisAiKeyIds = json.analysisAiKeyIds.map(toObjectId).filter(Boolean);
            for (const k of ['createdBy', 'updatedBy', 'deletedBy']) {
                const v = toObjectId(json[k]); if (v) r[k] = v;
            }
            return { rec: r, createdAt: toDate(json.createdAt), updatedAt: toDate(json.updatedAt) };
        },
        toPatch: (r) => ({
            lessonId: hex(r._id), title: r.title, slug: r.slug, description: r.description,
            sampleSolution: r.sampleSolution, duration: r.duration, order: r.order,
            model: r.model || null, isPublished: r.isPublished, type: r.type,
            promptId: hex(r.promptId), aiKeyId: hex(r.aiKeyId),
            analysisAiKeyIds: (r.analysisAiKeyIds || []).map(hex),
            createdBy: hex(r.createdBy), updatedBy: hex(r.updatedBy),
            isDeleted: !!r.isDeleted, deletedAt: iso(r.deletedAt), deletedBy: hex(r.deletedBy)
        })
    },

    flashcards: {
        re: /^subjects\/([^/]+)\/flashcards\/([^/]+)\.json$/,
        defaults: () => ({
            description: '', mode: 'language', language: 'en-US', cardCount: 0, order: 0,
            githubFile: null, githubSha: null, isPublished: true,
            userKey: null, createdBy: null, updatedBy: null,
            isDeleted: false, deletedAt: null, deletedBy: null, slug: null
        }),
        idKey: 'flashcardId',
        fromJson(path, m, json, ctx) {
            const subject = ctx.subjects.get(m[1]);
            if (!subject) return { skip: `không có môn học slug "${m[1]}"` };
            const r = {
                subjectId: subject._id, userKey: subject.userKey || null,
                slug: (str(json.slug) || m[2]).toLowerCase(),
                title: (str(json.title) || m[2]).slice(0, 200),
                mode: json.mode === 'theory' ? 'theory' : 'language',
                cardCount: Array.isArray(json.cards) ? json.cards.length : 0
            };
            if (typeof json.description === 'string') r.description = json.description.slice(0, 1000);
            if (typeof json.language === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(json.language)) r.language = json.language;
            if (Number.isFinite(Number(json.order))) r.order = Number(json.order);
            if (typeof json.isPublished === 'boolean') r.isPublished = json.isPublished;
            if (json.isDeleted !== undefined) {
                r.isDeleted = json.isDeleted === true;
                r.deletedAt = r.isDeleted ? (toDate(json.deletedAt) || new Date()) : null;
            }
            for (const k of ['createdBy', 'updatedBy', 'deletedBy']) {
                const v = toObjectId(json[k]); if (v) r[k] = v;
            }
            return { rec: r, createdAt: toDate(json.createdAt), updatedAt: toDate(json.updatedAt) };
        },
        toPatch: (r) => ({
            flashcardId: hex(r._id), title: r.title, slug: r.slug, description: r.description,
            mode: r.mode, language: r.language, cardCount: r.cardCount, order: r.order, isPublished: r.isPublished,
            createdBy: hex(r.createdBy), updatedBy: hex(r.updatedBy),
            isDeleted: !!r.isDeleted, deletedAt: iso(r.deletedAt), deletedBy: hex(r.deletedBy)
        })
    },

    slides: {
        re: /^subjects\/([^/]+)\/slides\/([^/]+)\.json$/,
        defaults: () => ({
            description: '', pdfFile: null, pdfSize: 0, originalName: '', order: 0,
            githubFile: null, githubSha: null, isPublished: true,
            userKey: null, createdBy: null, updatedBy: null,
            isDeleted: false, deletedAt: null, deletedBy: null, slug: null
        }),
        idKey: 'slideId',
        fromJson(path, m, json, ctx) {
            const subject = ctx.subjects.get(m[1]);
            if (!subject) return { skip: `không có môn học slug "${m[1]}"` };
            const r = {
                subjectId: subject._id, userKey: subject.userKey || null,
                slug: (str(json.slug) || m[2]).toLowerCase(),
                title: (str(json.title) || m[2]).slice(0, 200),
                // file PDF phải nằm CÙNG thư mục slides của đúng môn này (không tin đường dẫn lạ trong JSON)
                pdfFile: (typeof json.pdfFile === 'string' && json.pdfFile.startsWith(`subjects/${m[1]}/slides/`) &&
                    /^subjects\/[^/]+\/slides\/[^/]+\.pdf$/.test(json.pdfFile)) ? json.pdfFile : null,
                pdfSize: Number(json.pdfSize) > 0 ? Math.round(Number(json.pdfSize)) : 0,
                originalName: str(json.originalName).slice(0, 200)
            };
            if (typeof json.description === 'string') r.description = json.description.slice(0, 1000);
            if (Number.isFinite(Number(json.order))) r.order = Number(json.order);
            if (typeof json.isPublished === 'boolean') r.isPublished = json.isPublished;
            if (json.isDeleted !== undefined) {
                r.isDeleted = json.isDeleted === true;
                r.deletedAt = r.isDeleted ? (toDate(json.deletedAt) || new Date()) : null;
            }
            for (const k of ['createdBy', 'updatedBy', 'deletedBy']) {
                const v = toObjectId(json[k]); if (v) r[k] = v;
            }
            return { rec: r, createdAt: toDate(json.createdAt), updatedAt: toDate(json.updatedAt) };
        },
        toPatch: (r) => ({
            slideId: hex(r._id), title: r.title, slug: r.slug, description: r.description,
            pdfFile: r.pdfFile || null, pdfSize: r.pdfSize || 0, originalName: r.originalName || '',
            order: r.order, isPublished: r.isPublished,
            createdBy: hex(r.createdBy), updatedBy: hex(r.updatedBy),
            isDeleted: !!r.isDeleted, deletedAt: iso(r.deletedAt), deletedBy: hex(r.deletedBy)
        })
    },

    prompts: {
        re: /^prompts\/([^/]+)\.json$/,
        defaults: () => ({
            description: '', kind: 'essay', strictness: 'normal', maxScore: 10, isDefault: false,
            scope: 'global', subjectId: null, lessonIds: [], version: 1,
            githubFile: null, githubSha: null, active: true, createdBy: null, updatedBy: null
        }),
        idKey: 'promptId',
        fromJson(path, m, json) {
            const r = {
                kind: json.kind === 'quiz' ? 'quiz' : 'essay',
                name: (str(json.name) || m[1]).slice(0, 200)
            };
            if (typeof json.description === 'string') r.description = json.description;
            if (STRICTNESS.includes(json.strictness)) r.strictness = json.strictness;
            if (Number.isFinite(Number(json.maxScore)) && Number(json.maxScore) >= 0) r.maxScore = Number(json.maxScore);
            if (SCOPES.includes(json.scope)) r.scope = json.scope;
            if (typeof json.isDefault === 'boolean') r.isDefault = json.isDefault;
            if (typeof json.active === 'boolean') r.active = json.active;
            if (Number.isFinite(Number(json.version)) && Number(json.version) > 0) r.version = Number(json.version);
            if (json.subjectId !== undefined) r.subjectId = toObjectId(json.subjectId);
            if (Array.isArray(json.lessonIds)) r.lessonIds = json.lessonIds.map(toObjectId).filter(Boolean);
            for (const k of ['createdBy', 'updatedBy']) { const v = toObjectId(json[k]); if (v) r[k] = v; }
            return { rec: r, createdAt: toDate(json.createdAt), updatedAt: toDate(json.updatedAt) };
        },
        toPatch: (r) => ({
            promptId: hex(r._id), name: r.name, description: r.description, kind: r.kind,
            strictness: r.strictness, maxScore: r.maxScore, scope: r.scope, isDefault: !!r.isDefault,
            active: r.active !== false, version: r.version, subjectId: hex(r.subjectId),
            lessonIds: (r.lessonIds || []).map(hex), createdBy: hex(r.createdBy), updatedBy: hex(r.updatedBy)
        })
    },

    submissions: {
        re: /^submissions\/([^/]+)\/([^/]+)\/([^/]+)\.json$/,
        defaults: () => ({
            subjectId: null, type: 'essay', answerHtml: '', score: null, feedback: '', breakdown: [],
            grammar: null, sampleComparison: null, promptSnapshot: null, model: null, aiKeyId: null,
            aiKeyName: null, aiProvider: null, latencyMs: null, maxScore: null, correctCount: null,
            totalCount: null, analysisCount: 0, lastAnalyzedAt: null, status: 'pending',
            errorMessage: null, gradedAt: null, submittedAt: () => new Date(), teacherComment: null,
            teacherCommentHistory: [], teacherCommentSyncStatus: 'none', teacherCommentSyncError: null,
            syncStatus: 'none', githubFile: null, githubSha: null, errorCount: null, syncedAt: null, syncError: null,
            // ★ Bản vẽ tay (JS Paint): ảnh nằm ở GitHub (drawingFile); drawingData chỉ giữ TẠM trong RAM tới khi đẩy xong
            hasDrawing: false, drawingFile: null, drawingMime: null, drawingData: '', drawingAnalysis: null
        }),
        idKey: 'submissionId',
        fromJson(path, m, json, ctx) {
            const userId = toObjectId(json.userId);
            const lesson = ctx.findLesson(json, m[1], m[2]);
            if (!userId || !lesson) return { skip: 'thiếu userId hoặc không tìm thấy bài học' };
            const isQuiz = json.type === 'quiz';
            const r = {
                syncStatus: 'committed', syncedAt: new Date(), userId,
                lessonId: lesson._id, subjectId: lesson.subjectId,
                type: isQuiz ? 'quiz' : 'essay',
                submittedAt: toDate(json.submittedAt) || new Date()
            };
            const gradedAt = toDate(json.gradedAt); if (gradedAt) r.gradedAt = gradedAt;

            if (isQuiz) {
                const res = json.result || {};
                if (res.score !== undefined) r.score = Number(res.score);
                if (res.maxScore !== undefined) r.maxScore = Number(res.maxScore);
                if (res.correctCount !== undefined) r.correctCount = Number(res.correctCount);
                if (res.totalCount !== undefined) r.totalCount = Number(res.totalCount);
                r.status = 'graded';
                const an = Array.isArray(json.aiAnalyses) ? json.aiAnalyses : [];
                r.analysisCount = an.length;
                const last = an[an.length - 1];
                const at = last && toDate(last.createdAt || last.analyzedAt || last.at);
                if (at) r.lastAnalyzedAt = at;
            } else {
                if (json.score !== undefined) r.score = json.score === null ? null : Number(json.score);
                r.status = SUB_STATUS.includes(json.status) ? json.status
                    : (json.score !== undefined && json.score !== null ? 'graded' : 'failed');
                if (json.model !== undefined) r.model = json.model || null;
                if (json.aiKeyName !== undefined) r.aiKeyName = json.aiKeyName || null;
                if (typeof json.aiProvider === 'string' && /^[a-z][a-z0-9_-]{1,31}$/.test(json.aiProvider)) r.aiProvider = json.aiProvider;   // id nhà cung cấp (AI-database/index.json)
                if (json.latencyMs !== undefined) r.latencyMs = json.latencyMs || null;
                if (json.errorMessage !== undefined) r.errorMessage = json.errorMessage || null;
                const errs = json.grammar && Array.isArray(json.grammar.errors) ? json.grammar.errors.length : null;
                if (errs !== null) r.errorCount = errs;
                // ★ Bản vẽ tay: chỉ cần biết có hay không + đường dẫn ảnh (ảnh/phân tích đọc khi xem chi tiết)
                if (json.hasDrawing && json.drawingFile) {
                    r.hasDrawing = true;
                    r.drawingFile = String(json.drawingFile);
                    r.drawingMime = json.drawingMime ? String(json.drawingMime) : null;
                }
            }

            const tc = json.teacherComment;
            if (tc && typeof tc === 'object' && str(tc.content) && toObjectId(tc.commentedBy)) {
                r.teacherComment = {
                    content: str(tc.content), commentedBy: toObjectId(tc.commentedBy),
                    commentedByName: str(tc.commentedByName), commentedAt: toDate(tc.commentedAt) || new Date()
                };
                r.teacherCommentSyncStatus = 'committed';
            }
            if (Array.isArray(json.teacherCommentHistory)) {
                r.teacherCommentHistory = json.teacherCommentHistory
                    .filter((h) => h && str(h.content) && toObjectId(h.commentedBy))
                    .map((h) => ({
                        content: str(h.content), commentedBy: toObjectId(h.commentedBy),
                        commentedByName: str(h.commentedByName), commentedAt: toDate(h.commentedAt) || new Date()
                    }));
            }
            return { rec: r, createdAt: r.submittedAt, updatedAt: toDate(json.updatedAt) || r.gradedAt || r.submittedAt };
        },
        // Trạng thái trung gian (pending/grading) KHÔNG ghi GitHub → trả null
        toPatch: (r) => {
            if (TRANSIENT.includes(r.status)) return null;
            const tc = (c) => (c ? { content: c.content, commentedBy: hex(c.commentedBy), commentedByName: c.commentedByName || '', commentedAt: iso(c.commentedAt) } : null);
            const base = {
                submissionId: hex(r._id), userId: hex(r.userId), lessonId: hex(r.lessonId),
                subjectId: hex(r.subjectId), type: r.type, submittedAt: iso(r.submittedAt),
                teacherComment: tc(r.teacherComment)
            };
            if (r.type === 'quiz') return base;
            return Object.assign(base, {
                status: r.status, score: r.score == null ? null : r.score, model: r.model || null,
                aiKeyName: r.aiKeyName || null, aiProvider: r.aiProvider || null,
                latencyMs: r.latencyMs == null ? null : r.latencyMs,
                errorMessage: r.errorMessage || null, gradedAt: iso(r.gradedAt)
            });
        }
    }
};
const KIND_NAMES = Object.keys(KINDS);

// ------------------------------------------------------------
// Trạng thái trong RAM
// ------------------------------------------------------------
const S = {
    loaded: false,
    loading: null,
    headSha: null,
    etag: null,
    checkedAt: 0,
    recs: { lessons: new Map(), flashcards: new Map(), slides: new Map(), prompts: new Map(), submissions: new Map() },   // id(hex) → record
    paths: { lessons: new Map(), flashcards: new Map(), slides: new Map(), prompts: new Map(), submissions: new Map() },  // path → id(hex)
    shas: { lessons: new Map(), flashcards: new Map(), slides: new Map(), prompts: new Map(), submissions: new Map() },   // path → blob sha
    skipShas: { lessons: new Map(), flashcards: new Map(), slides: new Map(), prompts: new Map(), submissions: new Map() }, // path → sha của file ĐÃ BỊ BỎ QUA (không tải lại khi sha không đổi)
    lastPatch: new Map(),     // id(hex) → chuỗi patch đã khớp với GitHub
    confirmed: new Set(),     // id(hex) đã thấy trên GitHub (xoá file → gỡ ngay, không chờ)
    localAt: new Map(),       // id(hex) → thời điểm tạo cục bộ (chưa chắc đã có trong cây thư mục)
    persistChain: new Map()   // id(hex) → Promise (tuần tự hoá ghi cùng bản ghi)
};

// ------------------------------------------------------------
// Đọc nhiều file: GraphQL (≈40 file/request) → dự phòng REST
// ------------------------------------------------------------
async function pool(items, size, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
        while (i < items.length) {
            const idx = i++;
            try { await fn(items[idx], idx); } catch (e) {
                console.warn(`[githubStore] Lỗi xử lý ${items[idx] && (items[idx].path || items[idx])}: ${e.message}`);
            }
        }
    }));
}

async function readMany(paths) {
    gh();
    const out = new Map(); // path → { data, sha } | null
    const rest = [];

    for (let i = 0; i < paths.length; i += GRAPHQL_BATCH) {
        const chunk = paths.slice(i, i + GRAPHQL_BATCH);
        const fields = chunk.map((p, j) =>
            `f${j}: object(expression: ${JSON.stringify(`${cfg.branch}:${p}`)}) { ... on Blob { oid text isTruncated } }`).join('\n');
        const query = `query { repository(owner: ${JSON.stringify(cfg.owner)}, name: ${JSON.stringify(cfg.repo)}) { ${fields} } }`;
        try {
            const res = await cfg.octokit.request('POST /graphql', { query });
            const repo = res.data && res.data.data && res.data.data.repository;
            if (!repo) throw new Error('GraphQL không trả repository');
            chunk.forEach((p, j) => {
                const o = repo[`f${j}`];
                if (!o) { out.set(p, null); return; }
                if (o.isTruncated || typeof o.text !== 'string') { rest.push(p); return; }
                try { out.set(p, { data: JSON.parse(o.text), sha: o.oid }); }
                catch (_) { out.set(p, { data: null, sha: o.oid }); }
            });
        } catch (e) {
            console.warn(`[githubStore] GraphQL lỗi (${e.message}) → đọc từng file qua REST.`);
            rest.push(...chunk.filter((p) => !out.has(p)));
        }
    }

    await pool(rest, CONCURRENCY, async (p) => {
        out.set(p, await githubService.readJsonFileWithSha(p));
    });
    return out;
}

// ------------------------------------------------------------
// Ngữ cảnh (môn học nằm ở Mongo; bài học tra từ RAM)
// ------------------------------------------------------------
async function loadSubjects() {
    const Subject = require('../models/Subject');
    const rows = await Subject.find({ deletedForever: { $ne: true } }).select('_id slug userKey').lean();
    return new Map(rows.map((s) => [s.slug, s]));
}

function makeCtx(subjects) {
    const lessons = [...S.recs.lessons.values()];
    return {
        subjects,
        findLesson(json, subjectSlug, lessonSlug) {
            const id = toObjectId(json.lessonId);
            if (id && S.recs.lessons.has(hex(id))) return S.recs.lessons.get(hex(id));
            const subject = subjects.get(subjectSlug);
            if (!subject) return null;
            return lessons.find((l) => hex(l.subjectId) === hex(subject._id) && l.slug === lessonSlug) ||
                [...S.recs.lessons.values()].find((l) => hex(l.subjectId) === hex(subject._id) && l.slug === lessonSlug) || null;
        }
    };
}

// ------------------------------------------------------------
// Áp dụng 1 file JSON vào RAM / gỡ file khỏi RAM
// ------------------------------------------------------------
function applyFile(kind, path, m, file, ctx) {
    const K = KINDS[kind];
    if (!file || !file.data || typeof file.data !== 'object') return 'skipped';
    const res = K.fromJson(path, m, file.data, ctx);
    if (res.skip) {
        // Chỉ in chi tiết từng file khi bật GITHUB_STORE_VERBOSE=1; mặc định gom thành 1 dòng tổng (xem syncFromTree)
        if (process.env.GITHUB_STORE_VERBOSE === '1') console.warn(`[githubStore] Bỏ qua ${path}: ${res.skip}.`);
        if (file.sha) S.skipShas[kind].set(path, file.sha);   // lần sau cùng sha → khỏi tải lại / khỏi cảnh báo lại
        return 'skipped';
    }

    // id: theo JSON → (nếu trùng với file KHÁC còn tồn tại) → id ổn định từ đường dẫn
    let id = toObjectId(file.data[K.idKey]);
    if (id) {
        const cur = S.recs[kind].get(hex(id));
        if (cur && cur.githubFile && cur.githubFile !== path && S.shas[kind].has(cur.githubFile)) id = null; // bản sao
    }
    if (!id) id = S.paths[kind].has(path) ? toObjectId(S.paths[kind].get(path)) : idFromPath(path);

    const prevId = S.paths[kind].get(path);
    if (prevId && prevId !== hex(id)) S.recs[kind].delete(prevId);   // file đổi id

    const existing = S.recs[kind].get(hex(id));
    const rec = Object.assign({}, KINDS[kind].defaults(), existing || {}, res.rec);
    for (const k of Object.keys(rec)) if (typeof rec[k] === 'function') rec[k] = rec[k]();
    rec._id = id;
    rec.githubFile = path;
    rec.githubSha = file.sha;
    rec.createdAt = res.createdAt || (existing && existing.createdAt) || new Date();
    rec.updatedAt = res.updatedAt || (existing && existing.updatedAt) || rec.createdAt;

    // bản ghi cũ cùng file khác id (di chuyển) đã xoá ở trên; ghi mới
    S.recs[kind].set(hex(id), rec);
    S.paths[kind].set(path, hex(id));
    S.shas[kind].set(path, file.sha);
    S.confirmed.add(hex(id));
    clearContentCache(path);
    const patch = KINDS[kind].toPatch(rec);
    if (patch) S.lastPatch.set(hex(id), stable(patch));
    return existing ? 'updated' : 'imported';
}

function dropPath(kind, path) {
    clearContentCache(path);
    const id = S.paths[kind].get(path);
    S.shas[kind].delete(path);
    S.skipShas[kind].delete(path);
    S.paths[kind].delete(path);
    if (id) { S.recs[kind].delete(id); S.lastPatch.delete(id); S.confirmed.delete(id); S.localAt.delete(id); return true; }
    return false;
}

// ------------------------------------------------------------
// Đồng bộ theo cây thư mục (nạp lần đầu & lưới an toàn)
// ------------------------------------------------------------
async function syncFromTree({ force = false } = {}) {
    const service = gh();
    const tree = await service.getRepoTree({ force: true });
    const canDelete = !tree.truncated && tree.files.size > 0;
    const subjects = await loadSubjects();
    const stats = {};

    for (const kind of ['lessons', 'flashcards', 'slides', 'prompts', 'submissions']) {   // lessons trước submissions
        const K = KINDS[kind];
        const remote = [];
        for (const [path, sha] of tree.files) {
            const m = K.re.exec(path);
            if (m) remote.push({ path, sha, m });
        }
        const stat = { kind, files: remote.length, imported: 0, updated: 0, removed: 0, skipped: 0, pending: 0 };

        // Bài học vừa mới/được cập nhật → bài nộp từng bị bỏ qua (vì chưa thấy bài học) được thử lại
        if (kind === 'submissions' && (stats.lessons?.imported || stats.lessons?.updated)) S.skipShas.submissions.clear();

        // File đã từng bị bỏ qua mà sha không đổi → KHÔNG tải lại (trước đây tải lại mỗi lần đồng bộ)
        const todo = remote.filter((r) =>
            force || (S.shas[kind].get(r.path) !== r.sha && S.skipShas[kind].get(r.path) !== r.sha)
        );
        const files = await readMany(todo.map((r) => r.path));
        const ctx = makeCtx(subjects);
        for (const r of todo) {
            const f = files.get(r.path);
            if (!f) { stat.skipped++; continue; }
            const out = applyFile(kind, r.path, r.m, f, ctx);
            if (out === 'skipped') stat.skipped++; else stat[out]++;
        }

        if (canDelete) {
            const remotePaths = new Set(remote.map((r) => r.path));
            for (const [path, id] of [...S.paths[kind]]) {
                if (remotePaths.has(path)) continue;
                // chỉ chờ với bản ghi MỚI TẠO cục bộ mà cây thư mục có thể chưa thấy
                const born = S.localAt.get(id);
                if (!S.confirmed.has(id) && born && Date.now() - born < DELETE_GRACE_MS) continue;
                if (dropPath(kind, path)) stat.removed++;
            }
        }
        stats[kind] = stat;
        if (stat.skipped > 0 && process.env.GITHUB_STORE_VERBOSE === '1') console.warn(`[githubStore] ${kind}: bỏ qua ${stat.skipped} file không hợp lệ/mồ côi (đặt GITHUB_STORE_VERBOSE=1 để xem từng file).`);
    }
    S.headSha = null;       // buộc kiểm tra lại đầu nhánh lần tới
    S.checkedAt = Date.now();
    return stats;
}

// ------------------------------------------------------------
// Đầu nhánh (ETag → 304 không tốn quota)
// ------------------------------------------------------------
async function fetchHead() {
    gh();
    try {
        const res = await cfg.octokit.request('GET /repos/{owner}/{repo}/git/ref/heads/{branch}', {
            owner: cfg.owner, repo: cfg.repo, branch: cfg.branch,
            headers: S.etag ? { 'if-none-match': S.etag } : {}
        });
        S.etag = res.headers && res.headers.etag ? res.headers.etag : null;
        return res.data && res.data.object ? res.data.object.sha : null;
    } catch (e) {
        if (e.status === 304) return S.headSha;     // không đổi
        throw e;
    }
}

async function ensureFresh({ force = false } = {}) {
    gh();
    if (!githubService.isConfigured) return null;
    if (S.loading) return S.loading;
    if (!force && S.loaded && Date.now() - S.checkedAt < HEAD_CHECK_MS) return null;

    S.loading = (async () => {
        try {
            if (!S.loaded || force) {
                const stats = await syncFromTree({ force });
                S.loaded = true;
                try { S.headSha = await fetchHead(); } catch (_) { /* bỏ qua */ }
                return stats;
            }
            const head = await fetchHead();
            S.checkedAt = Date.now();
            if (head && head !== S.headSha) {
                const hadHead = Boolean(S.headSha);
                const stats = hadHead ? await syncFromTree() : null;
                S.headSha = head;
                return stats;
            }
            return null;
        } catch (e) {
            S.checkedAt = Date.now() - HEAD_CHECK_MS + 2000;   // thử lại sau ~2s
            if (!S.loaded) throw e;                             // chưa có dữ liệu nào → báo lỗi thật
            console.warn(`⚠️ [githubStore] Làm mới lỗi (dùng dữ liệu RAM hiện có): ${e.message}`);
            return null;
        } finally {
            S.loading = null;
        }
    })();
    return S.loading;
}

// ------------------------------------------------------------
// WEBHOOK push
// ------------------------------------------------------------
async function applyPush(payload) {
    gh();
    if (!payload || typeof payload !== 'object') return { ok: false, reason: 'payload rỗng' };
    if (payload.ref && payload.ref !== `refs/heads/${cfg.branch}`) return { ok: true, ignored: `nhánh ${payload.ref}` };
    if (!S.loaded) return { ok: true, ignored: 'chưa nạp dữ liệu — lần nạp đầu sẽ thấy mọi thay đổi' };

    const commits = Array.isArray(payload.commits) ? payload.commits : [];
    // hành động cuối cùng của mỗi path thắng
    const final = new Map();
    for (const c of commits) {
        (c.added || []).forEach((p) => final.set(p, 'upsert'));
        (c.modified || []).forEach((p) => final.set(p, 'upsert'));
        (c.removed || []).forEach((p) => final.set(p, 'remove'));
    }

    // Quá nhiều commit (GitHub chỉ liệt kê tối đa 20) → so cây thư mục cho chắc
    if (commits.length >= 20 || payload.forced) {
        const stats = await syncFromTree();
        S.headSha = payload.after || S.headSha;
        return { ok: true, mode: 'tree-diff', stats };
    }

    const subjects = await loadSubjects();
    const result = { ok: true, mode: 'incremental', imported: 0, updated: 0, removed: 0, skipped: 0 };
    const upserts = [];
    for (const [path, action] of final) {
        const kind = KIND_NAMES.find((k) => KINDS[k].re.test(path));
        if (!kind) continue;
        if (action === 'remove') { if (dropPath(kind, path)) result.removed++; continue; }
        upserts.push({ kind, path, m: KINDS[kind].re.exec(path) });
    }

    const files = await readMany(upserts.map((u) => u.path));
    for (const kind of KIND_NAMES) {          // lessons → prompts → submissions
        const ctx = makeCtx(subjects);
        for (const u of upserts.filter((x) => x.kind === kind)) {
            const f = files.get(u.path);
            if (!f) { if (dropPath(kind, u.path)) result.removed++; continue; }
            const out = applyFile(kind, u.path, u.m, f, ctx);
            if (out === 'skipped') result.skipped++; else result[out]++;
        }
    }

    if (payload.after) { S.headSha = payload.after; }
    S.checkedAt = Date.now();
    return result;
}

// ------------------------------------------------------------
// Ghi chỉ mục xuống JSON (chỉ commit khi khác)
// ------------------------------------------------------------
function kindOf(rec) {
    return KIND_NAMES.find((k) => S.recs[k].get(hex(rec._id)) === rec) || null;
}

async function persistNow(kind, rec) {
    const service = gh();
    if (!rec.githubFile || !service.isConfigured) return;
    const patch = KINDS[kind].toPatch(rec);
    if (!patch) return;
    const id = hex(rec._id);
    const key = stable(patch);
    if (S.lastPatch.get(id) === key) return;

    const file = await service.readJsonFileWithSha(rec.githubFile);
    if (!file) return;           // file chưa có trên GitHub — controller sẽ ghi
    const cur = file.data || {};
    const differs = Object.keys(patch).some((k) => stable(cur[k]) !== stable(patch[k]));
    if (differs) {
        const res = await service.updateJsonFile(
            rec.githubFile,
            (c) => Object.assign({}, c, patch, { updatedAt: new Date().toISOString() }),
            `[${kind}] cập nhật chỉ mục: ${rec.title || rec.name || id}`
        );
        rec.githubSha = res.sha;
        S.shas[kind].set(rec.githubFile, res.sha);
    } else {
        rec.githubSha = file.sha;
    }
    S.lastPatch.set(id, key);
}

function makeStore(kind) {
    return {
        async all() { await ensureFresh(); return [...S.recs[kind].values()]; },
        byId(id) { return S.recs[kind].get(hex(id)) || null; },
        upsert(rec) {
            rec._id = toObjectId(rec._id) || newId();
            const old = S.recs[kind].get(hex(rec._id));
            if (old && old !== rec) Object.assign(old, rec); else S.recs[kind].set(hex(rec._id), rec);
            const live = S.recs[kind].get(hex(rec._id));
            if (!S.confirmed.has(hex(live._id))) S.localAt.set(hex(live._id), Date.now());
            if (live.githubFile) { S.paths[kind].set(live.githubFile, hex(live._id)); if (live.githubSha) S.shas[kind].set(live.githubFile, live.githubSha); }
            return live;
        },
        async remove(rec) {
            const id = hex(rec._id);
            S.recs[kind].delete(id);
            S.lastPatch.delete(id); S.confirmed.delete(id); S.localAt.delete(id);
            if (rec.githubFile) { S.paths[kind].delete(rec.githubFile); S.shas[kind].delete(rec.githubFile); }
        },
        async persist(rec) {
            const live = S.recs[kind].get(hex(rec._id)) || rec;
            if (live.githubFile && live.githubSha) { S.paths[kind].set(live.githubFile, hex(live._id)); S.shas[kind].set(live.githubFile, live.githubSha); }
            const id = hex(live._id);
            const prev = S.persistChain.get(id) || Promise.resolve();
            const next = prev.then(() => persistNow(kind, live)).catch((e) => {
                console.warn(`⚠️ [githubStore] Ghi chỉ mục ${kind}/${id} lỗi (RAM vẫn giữ giá trị mới): ${e.message}`);
            });
            S.persistChain.set(id, next);
            await next;
            if (S.persistChain.get(id) === next) S.persistChain.delete(id);
        }
    };
}

// ------------------------------------------------------------
// API công khai
// ------------------------------------------------------------
async function refresh(kinds, opts = {}) {
    const stats = await ensureFresh({ force: Boolean(opts.force) });
    const wanted = (kinds || KIND_NAMES);
    return wanted.map((k) => (stats && stats[k]) || {
        kind: k, files: S.recs[k].size, imported: 0, updated: 0, removed: 0, skipped: 0, pending: 0
    });
}

function _reset() {      // chỉ cho test
    S.loaded = false; S.loading = null; S.headSha = null; S.etag = null; S.checkedAt = 0;
    for (const k of KIND_NAMES) { S.recs[k].clear(); S.paths[k].clear(); S.shas[k].clear(); S.skipShas[k].clear(); }
    S.lastPatch.clear(); S.persistChain.clear(); S.confirmed.clear(); S.localAt.clear();
}

module.exports = {
    KINDS, makeStore, refresh, ensureFresh, applyPush, syncFromTree, readMany,
    stats: () => Object.fromEntries(KIND_NAMES.map((k) => [k, S.recs[k].size])),
    _state: S, _reset, kindOf
};
