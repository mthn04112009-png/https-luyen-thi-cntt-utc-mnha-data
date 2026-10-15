// migrateMongoToGithub.js  (đặt ở THƯ MỤC GỐC của dự án)
// ============================================================
// CHUYỂN dữ liệu NẶNG còn sót trong MongoDB sang file JSON trên GitHub,
// rồi XOÁ phần đã chuyển khỏi MongoDB.
//
// Chạy từ thư mục gốc của dự án:
//   node migrateMongoToGithub.js                 → chạy THỬ (dry-run): chỉ báo cáo, KHÔNG ghi gì
//   node migrateMongoToGithub.js --run           → chuyển + xoá THẬT
//   node migrateMongoToGithub.js --run --limit=3 → làm thử với 3 bản ghi mỗi loại
//   node migrateMongoToGithub.js --only=prompts,lessons,submissions   (chọn loại)
//   node migrateMongoToGithub.js --only=auditlogs [--run]            → chuyển TOÀN BỘ audit log trong MongoDB (collection `auditlogs`)
//                                                                       sang 1 file GitHub: auditlogs/index.json (gộp, không ghi đè bản đã có)
//   node migrateMongoToGithub.js --only=aiproviders [--run]         → tạo AI-database/index.json trên GitHub: danh sách NHÀ CUNG CẤP AI
//                                                                       (tên API, biến API: địa chỉ/đường dẫn/max_tokens, và các model) lấy từ
//                                                                       config/aiProviderSeed.js (dữ liệu trước đây nằm cứng trong config/aiModels.js
//                                                                       + services/aiService.js). Đối chiếu provider đang dùng trong MongoDB (aikeys:
//                                                                       'gemini' / 'vilao' giữ NGUYÊN). Key API vẫn ở MongoDB, KHÔNG đụng tới.
//                                                                       Chỉ THÊM nhà cung cấp còn thiếu, không ghi đè phần đã chỉnh ở /admin/ai-keys/Supplier.
//   node migrateMongoToGithub.js --orphans               → LIỆT KÊ collection dư thừa trong MongoDB (không xoá)
//   node migrateMongoToGithub.js --run --drop-orphans=tenA,tenB → BACKUP rồi XOÁ đúng các collection dư thừa nêu tên
//      (lessons/gradingprompts/submissions chỉ xoá khi MỌI document đã có file trên GitHub; --force-drop để bỏ qua kiểm tra)
//
// QUY ƯỚC CỦA DỰ ÁN (script bám đúng):
//   - MongoDB chỉ giữ metadata + con trỏ `githubFile`; GitHub là nguồn thật.
//   - submissions : submissions/{môn}/{bài}/{tên-ngẫu-nhiên}.json  (payload giống services/submissionService.js)
//                   field nặng: answerHtml, feedback, breakdown, grammar, sampleComparison, promptSnapshot
//   - lessons     : subjects/{môn}/lessons/{slug}.json              (giống lessonContentService / lesson.controller)
//                   field nặng: contentHtml (đã bỏ khỏi schema). description/sampleSolution được COPY lên
//                   GitHub nếu file còn thiếu nhưng GIỮ lại ở Mongo (code vẫn đọc từ Mongo, xem ghi chú cuối).
//   - gradingprompts: prompts/{...}.json                            (giống prompt.controller.pushPromptToGithub)
//                   field nặng: content, rubric, variables (đã bỏ khỏi schema)
//
// AN TOÀN:
//   1. Luôn ghi GitHub TRƯỚC → đọc lại kiểm tra → mới xoá field ở Mongo.
//   2. Không bao giờ ghi đè dữ liệu đã có trên GitHub (chỉ điền chỗ còn thiếu; ghi bằng khoá SHA).
//   3. Bài nộp trắc nghiệm (type='quiz') KHÔNG đụng tới (dữ liệu của nó vốn đã nằm ở GitHub).
//   4. Với --run, tự BACKUP phần sắp xoá ra file backup-mongo-to-github-<thời gian>.json.
//      Thêm --no-backup để KHÔNG tạo file backup (dữ liệu vẫn được ghi GitHub + đọc lại kiểm tra trước khi xoá ở Mongo).
//   5. Bản ghi lỗi/thiếu dữ liệu chỉ bị bỏ qua + in cảnh báo, KHÔNG xoá gì ở Mongo.
// ============================================================
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');

// Lesson / GradingPrompt / Submission giờ nằm ở GitHub (models/* là bản đọc GitHub).
// Script này chỉ cần ĐỌC collection Mongo CŨ (nếu còn) để chuyển nốt lên GitHub,
// nên truy cập thẳng collection thô — tên mặc định của Mongoose:
const legacy = (name) => mongoose.connection.collection(name);
const Submission = { get collection() { return legacy('submissions'); } };
const Lesson = { get collection() { return legacy('lessons'); } };
const GradingPrompt = { get collection() { return legacy('gradingprompts'); } };
const Subject = require('./models/Subject');
const User = require('./models/User');
const githubService = require('./services/githubService');
const auditLogService = require('./services/auditLogService');

// Nạp TẤT CẢ model để biết collection nào là "của dự án" (dùng cho --orphans)
const path = require('path');
for (const f of fs.readdirSync(path.join(__dirname, 'models'))) {
    if (f.endsWith('.js')) require(path.join(__dirname, 'models', f));
}

// ------------------------------------------------------------
// Tham số dòng lệnh
// ------------------------------------------------------------
const argv = process.argv.slice(2);
const RUN = argv.includes('--run');
const argVal = (name) => {
    const a = argv.find((x) => x.startsWith(`--${name}=`));
    return a ? a.slice(name.length + 3) : null;
};
const ALL_KINDS = ['prompts', 'lessons', 'submissions', 'auditlogs', 'aiproviders'];
const ONLY = (argVal('only') ? argVal('only').split(',') : ALL_KINDS)
    .map((s) => s.trim())
    .filter((s) => ALL_KINDS.includes(s));
const LIMIT = Number(argVal('limit')) || 0;
const NO_BACKUP = argv.includes('--no-backup');   // bỏ file backup-*.json (xem ghi chú ở đầu file)

const WRITE_DELAY_MS = 1000;            // GitHub khuyến nghị ≤ 1 lần ghi/giây
const RECENT_MS = 15 * 60 * 1000;       // bài đang chấm dở trong 15 phút gần nhất → bỏ qua
const IN_FLIGHT = ['pending', 'grading', 'regrading'];

// ------------------------------------------------------------
// Tiện ích
// ------------------------------------------------------------
function findMongoUri() {
    const names = ['MONGO_URI', 'MONGODB_URI', 'MONGO_URL', 'MONGODB_URL', 'MONGO_URI_ATLAS', 'DATABASE_URL', 'DB_URI', 'DB_URL', 'MONGO'];
    for (const n of names) if (process.env[n]) return { name: n, uri: process.env[n] };
    for (const [k, v] of Object.entries(process.env)) {
        if (/^mongodb(\+srv)?:\/\//.test(String(v || ''))) return { name: k, uri: v };
    }
    return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hasText = (v) => typeof v === 'string' && v.trim() !== '';
const hasArr = (v) => Array.isArray(v) && v.length > 0;
const hasObj = (v) => v !== null && v !== undefined && typeof v === 'object';
const idStr = (v) => (v === null || v === undefined ? null : String(v));
const oid = (v) => (v && /^[a-f0-9]{24}$/i.test(String(v)) ? new mongoose.Types.ObjectId(String(v)) : null);

function stripRubric(rubric) {
    return (Array.isArray(rubric) ? rubric : []).map((r) => {
        const { _id, ...rest } = r || {};
        return rest;
    });
}

// ------------------------------------------------------------
// Cache tra cứu (user / môn / bài / đề bài trên GitHub)
// ------------------------------------------------------------
const userCache = new Map();
async function userMeta(id) {
    const key = idStr(id);
    if (!key) return null;
    if (!userCache.has(key)) {
        const _id = oid(key);
        const u = _id ? await User.collection.findOne({ _id }, { projection: { name: 1, email: 1 } }) : null;
        userCache.set(key, { id: key, name: (u && u.name) || '', email: (u && u.email) || '' });
    }
    return userCache.get(key);
}

const subjectCache = new Map();
async function getSubject(id) {
    const key = idStr(id);
    if (!key) return null;
    if (!subjectCache.has(key)) {
        const _id = oid(key);
        subjectCache.set(
            key,
            _id ? await Subject.collection.findOne({ _id }, { projection: { slug: 1, name: 1, code: 1 } }) : null
        );
    }
    return subjectCache.get(key);
}

const lessonCache = new Map();
async function getLesson(id) {
    const key = idStr(id);
    if (!key) return null;
    if (!lessonCache.has(key)) {
        const _id = oid(key);
        lessonCache.set(key, _id ? await Lesson.collection.findOne({ _id }) : null);
    }
    return lessonCache.get(key);
}

function lessonPathOf(lesson, subject) {
    if (lesson && lesson.githubFile) return lesson.githubFile;
    if (lesson && lesson.slug && subject && subject.slug) return `subjects/${subject.slug}/lessons/${lesson.slug}.json`;
    return null;
}

const lessonJsonCache = new Map();
async function lessonJson(lesson, subject) {
    const p = lessonPathOf(lesson, subject);
    if (!p) return {};
    if (!lessonJsonCache.has(p)) {
        let data = {};
        try { data = (await githubService.readJsonFile(p)) || {}; } catch (_) { data = {}; }
        lessonJsonCache.set(p, data);
    }
    return lessonJsonCache.get(p);
}

async function putJson(filePath, data, expectedSha, message) {
    const res = await githubService.writeJsonFileIfSha(filePath, data, expectedSha || null, message);
    await sleep(WRITE_DELAY_MS);
    return res; // { path, sha, commitSha }
}

// ------------------------------------------------------------
// Báo cáo
// ------------------------------------------------------------
const report = {};
function stat(kind) {
    if (!report[kind]) report[kind] = { total: 0, written: 0, cleared: 0, alreadyOk: 0, skipped: [], failed: [] };
    return report[kind];
}
const tag = RUN ? '' : '[dry-run] ';

// ============================================================
// 1. GRADING PROMPTS  (collection gradingprompts → prompts/*.json)
//    Mongo cũ còn: content, rubric, variables  → chuyển lên GitHub rồi $unset
// ============================================================
async function collectPrompts() {
    return GradingPrompt.collection.find({
        $or: [
            { content: { $exists: true } },
            { rubric: { $exists: true } },
            { variables: { $exists: true } }
        ]
    }).toArray();
}

async function promptSkeleton(d) {
    // Cùng cấu trúc với pushPromptToGithub() trong prompt.controller.js
    return {
        promptId: String(d._id),
        name: d.name,
        description: d.description || '',
        content: hasText(d.content) ? d.content : '',
        rubric: stripRubric(d.rubric),
        strictness: d.strictness || 'normal',
        maxScore: d.maxScore ?? 10,
        scope: d.scope || 'global',
        kind: d.kind === 'quiz' ? 'quiz' : 'essay',
        subjectId: idStr(d.subjectId),
        lessonIds: (d.lessonIds || []).map(String),
        isDefault: Boolean(d.isDefault),
        variables: Array.isArray(d.variables) ? d.variables : [],
        version: d.version || 1,
        active: d.active !== false,
        createdBy: await userMeta(d.createdBy),
        createdAt: d.createdAt || new Date(),
        updatedAt: d.updatedAt || new Date()
    };
}

async function processPrompt(d) {
    const st = stat('prompts');
    const label = `prompt ${d._id} "${d.name}"`;

    const wantContent = hasText(d.content);
    const wantRubric = hasArr(d.rubric);
    const wantVars = hasArr(d.variables);

    let filePath = d.githubFile || null;
    const remote = filePath ? await githubService.readJsonFileWithSha(filePath) : null;
    const isNewFile = !remote;
    const data = remote ? { ...remote.data } : await promptSkeleton(d);

    const filled = [];
    if (wantContent && !hasText(data.content)) { data.content = d.content; filled.push('content'); }
    if (wantRubric && !hasArr(data.rubric)) { data.rubric = stripRubric(d.rubric); filled.push('rubric'); }
    if (wantVars && !hasArr(data.variables)) { data.variables = d.variables; filled.push('variables'); }

    const needWrite = isNewFile || filled.length > 0;

    if (isNewFile && !hasText(data.content)) {
        console.warn(`   ⚠️  ${label}: Mongo lẫn GitHub đều không có "content" → file tạo ra có content rỗng (chấm bài sẽ rơi về prompt mặc định hardcoded).`);
    }

    const plan = needWrite
        ? `ghi GitHub ${isNewFile ? '(TẠO file mới)' : '(điền thêm: ' + filled.join(', ') + ')'} → ${filePath || 'prompts/<tên-ngẫu-nhiên>.json'}`
        : 'GitHub đã đủ dữ liệu';
    console.log(`${tag}• ${label}: ${plan}; xoá khỏi Mongo: content/rubric/variables`);

    if (!RUN) return;

    let finalSha = remote ? remote.sha : null;
    let finalData = data;
    if (needWrite) {
        if (!filePath) filePath = await githubService.uniqueJsonPath('prompts', { timestamp: true });
        const res = await putJson(filePath, data, remote ? remote.sha : null, `[Migrate] Prompt: ${d.name}`);
        st.written++;
        const again = await githubService.readJsonFileWithSha(filePath);
        if (!again) throw new Error(`Ghi xong nhưng đọc lại không thấy file ${filePath}`);
        finalSha = again.sha || res.sha;
        finalData = again.data;
    }

    // Kiểm tra lại trên GitHub trước khi xoá ở Mongo
    if (wantContent && !hasText(finalData.content)) throw new Error('Kiểm tra lại: GitHub thiếu content → KHÔNG xoá Mongo');
    if (wantRubric && !hasArr(finalData.rubric)) throw new Error('Kiểm tra lại: GitHub thiếu rubric → KHÔNG xoá Mongo');
    if (wantVars && !hasArr(finalData.variables)) throw new Error('Kiểm tra lại: GitHub thiếu variables → KHÔNG xoá Mongo');

    const update = { $unset: { content: '', rubric: '', variables: '' } };
    const set = {};
    if (!d.githubFile) set.githubFile = filePath;
    if (finalSha) set.githubSha = finalSha;
    if (Object.keys(set).length) update.$set = set;
    await GradingPrompt.collection.updateOne({ _id: d._id }, update);
    st.cleared++;
    if (!needWrite) st.alreadyOk++;
}

// ============================================================
// 2. LESSONS  (collection lessons → subjects/{môn}/lessons/{slug}.json)
//    - contentHtml (field cũ)          → đảm bảo có ở GitHub rồi $unset khỏi Mongo
//    - description / sampleSolution    → điền lên GitHub nếu thiếu, GIỮ ở Mongo
// ============================================================
async function collectLessons() {
    return Lesson.collection.find({
        $or: [
            { contentHtml: { $exists: true } },
            { sampleSolution: { $exists: true, $nin: ['', null] } },
            { description: { $exists: true, $nin: ['', null] } }
        ]
    }).toArray();
}

async function lessonSkeleton(l, subject) {
    // Cùng cấu trúc với lesson.controller.js (createLesson)
    return {
        lessonId: String(l._id),
        type: 'essay',
        title: l.title,
        slug: l.slug,
        subjectSlug: subject.slug,
        description: l.description || '',
        contentHtml: l.contentHtml || '',
        sampleSolution: l.sampleSolution || '',
        duration: l.duration || 20,
        model: l.model || null,
        promptId: idStr(l.promptId),
        aiKeyId: idStr(l.aiKeyId),
        isPublished: l.isPublished !== false,
        isDeleted: l.isDeleted === true,
        deletedAt: l.deletedAt || null,
        createdBy: await userMeta(l.createdBy),
        createdAt: l.createdAt || new Date(),
        updatedAt: l.updatedAt || new Date()
    };
}

async function processLesson(l) {
    const st = stat('lessons');
    const label = `lesson ${l._id} "${l.title}"`;

    const hasLegacyField = Object.prototype.hasOwnProperty.call(l, 'contentHtml');
    const wantContent = hasText(l.contentHtml);
    const wantSample = hasText(l.sampleSolution);
    const wantDesc = hasText(l.description);

    const subject = await getSubject(l.subjectId || l.subject);
    const filePath = lessonPathOf(l, subject);
    if (!filePath) {
        st.skipped.push(`${label}: thiếu môn/slug nên không xác định được file GitHub`);
        console.warn(`   ⚠️  ${label}: không xác định được file GitHub (thiếu môn hoặc slug) → bỏ qua`);
        return;
    }

    const remote = await githubService.readJsonFileWithSha(filePath);
    let data;
    const isNewFile = !remote;

    if (isNewFile) {
        if (l.type === 'quiz') {
            st.skipped.push(`${label}: file đề trắc nghiệm không có trên GitHub (${filePath}); không dựng lại được từ Mongo`);
            console.warn(`   ⚠️  ${label}: bài TRẮC NGHIỆM nhưng file ${filePath} không có trên GitHub → KHÔNG tạo, bỏ qua`);
            return;
        }
        if (!wantContent || !subject || !subject.slug) {
            st.skipped.push(`${label}: file ${filePath} không có trên GitHub và Mongo không có contentHtml để tạo`);
            console.warn(`   ⚠️  ${label}: file ${filePath} không có trên GitHub và Mongo không có contentHtml → không tạo file rỗng, bỏ qua`);
            return;
        }
        data = await lessonSkeleton(l, subject);
    } else {
        data = { ...remote.data };
    }

    const filled = [];
    if (wantContent && !hasText(data.contentHtml)) { data.contentHtml = l.contentHtml; filled.push('contentHtml'); }
    if (wantSample && !hasText(data.sampleSolution)) { data.sampleSolution = l.sampleSolution; filled.push('sampleSolution'); }
    if (wantDesc && !hasText(data.description)) { data.description = l.description; filled.push('description'); }

    const needWrite = isNewFile || filled.length > 0;
    const needClear = hasLegacyField;
    const needPointer = !l.githubFile;

    if (!needWrite && !needClear && !needPointer) { st.alreadyOk++; return; }

    const plan = needWrite
        ? `ghi GitHub ${isNewFile ? '(TẠO file mới)' : '(điền thêm: ' + filled.join(', ') + ')'} → ${filePath}`
        : 'GitHub đã đủ dữ liệu';
    console.log(`${tag}• ${label}: ${plan}${needClear ? '; xoá contentHtml khỏi Mongo' : ''}`);

    if (!RUN) return;

    let finalSha = remote ? remote.sha : null;
    let finalData = data;
    if (needWrite) {
        const res = await putJson(filePath, data, remote ? remote.sha : null, `[Migrate] Lesson: ${l.title}`);
        st.written++;
        const again = await githubService.readJsonFileWithSha(filePath);
        if (!again) throw new Error(`Ghi xong nhưng đọc lại không thấy file ${filePath}`);
        finalSha = again.sha || res.sha;
        finalData = again.data;
    }

    if (wantContent && !hasText(finalData.contentHtml)) throw new Error('Kiểm tra lại: GitHub thiếu contentHtml → KHÔNG xoá Mongo');

    const update = {};
    if (needClear) update.$unset = { contentHtml: '' };
    const set = {};
    if (needPointer) set.githubFile = filePath;
    if (needWrite && finalSha) set.githubSha = finalSha;
    if (Object.keys(set).length) update.$set = set;
    if (Object.keys(update).length) {
        await Lesson.collection.updateOne({ _id: l._id }, update);
        if (needClear) st.cleared++;
    }
    lessonJsonCache.delete(filePath);
}

// ============================================================
// 3. SUBMISSIONS  (collection submissions → submissions/{môn}/{bài}/{file}.json)
//    Bài TỰ LUẬN còn data nặng trong Mongo → đẩy GitHub rồi dọn field nặng
//    (đúng như services/submissionService.js → onSuccess)
// ============================================================
async function collectSubmissions() {
    return Submission.collection.find({
        type: { $ne: 'quiz' },
        $or: [
            { answerHtml: { $exists: true, $nin: ['', null] } },
            { feedback: { $exists: true, $nin: ['', null] } },
            { 'breakdown.0': { $exists: true } },
            { grammar: { $ne: null } },
            { sampleComparison: { $ne: null } },
            { promptSnapshot: { $ne: null } }
        ]
    }).sort({ submittedAt: 1 }).toArray();
}

async function submissionSkeleton(s, lesson, subject) {
    // Cùng cấu trúc payload với services/submissionService.js
    const user = await userMeta(s.userId);
    const lc = await lessonJson(lesson, subject);
    const history = Array.isArray(s.teacherCommentHistory) ? s.teacherCommentHistory : [];
    return {
        submissionId: String(s._id),
        submittedAt: s.submittedAt || s.createdAt || null,
        gradedAt: s.gradedAt || null,

        status: s.status || (s.score !== null && s.score !== undefined ? 'graded' : 'failed'),
        errorMessage: s.errorMessage || null,

        userId: String(s.userId),
        userName: (user && user.name) || null,
        userEmail: (user && user.email) || null,

        subjectId: String(lesson.subjectId || s.subjectId),
        subjectName: subject.name || null,
        subjectCode: subject.code || null,
        subjectSlug: subject.slug,

        lessonId: String(lesson._id),
        lessonTitle: lesson.title || null,
        lessonSlug: lesson.slug,
        lessonDuration: lesson.duration || 20,

        lessonContentHtml: lc.contentHtml || lesson.contentHtml || '',
        lessonSampleSolution: lc.sampleSolution || lesson.sampleSolution || '',

        answerHtml: s.answerHtml || '',

        score: s.score ?? null,
        feedback: s.feedback || '',
        breakdown: Array.isArray(s.breakdown) ? s.breakdown : [],
        grammar: s.grammar || null,
        sampleComparison: s.sampleComparison || null,

        model: s.model || null,
        aiKeyId: idStr(s.aiKeyId),
        aiKeyName: s.aiKeyName || null,
        aiProvider: s.aiProvider || null,
        latencyMs: s.latencyMs || null,

        promptSnapshot: s.promptSnapshot || null,
        raw: null, // phản hồi thô của AI không còn trong Mongo

        ...(s.teacherComment ? { teacherComment: s.teacherComment } : {}),
        ...(history.length ? { teacherCommentHistory: history } : {})
    };
}

function missingHeavy(s, data) {
    const miss = [];
    if (hasText(s.answerHtml) && !hasText(data.answerHtml)) miss.push('answerHtml');
    if (hasText(s.feedback) && !hasText(data.feedback)) miss.push('feedback');
    if (hasArr(s.breakdown) && !hasArr(data.breakdown)) miss.push('breakdown');
    if (hasObj(s.grammar) && !hasObj(data.grammar)) miss.push('grammar');
    if (hasObj(s.sampleComparison) && !hasObj(data.sampleComparison)) miss.push('sampleComparison');
    if (hasObj(s.promptSnapshot) && !hasObj(data.promptSnapshot)) miss.push('promptSnapshot');
    return miss;
}

async function processSubmission(s) {
    const st = stat('submissions');
    const label = `submission ${s._id}`;

    // Bài đang chấm dở (vừa nộp) → tránh đụng độ với server đang chạy
    const touched = new Date(s.updatedAt || s.createdAt || 0).getTime();
    if (IN_FLIGHT.includes(s.status) && Date.now() - touched < RECENT_MS) {
        st.skipped.push(`${label}: đang ở trạng thái ${s.status} (mới trong 15 phút) → bỏ qua, chạy lại sau`);
        console.warn(`   ⚠️  ${label}: đang ${s.status} → bỏ qua`);
        return;
    }

    const lesson = await getLesson(s.lessonId);
    const subject = lesson ? await getSubject(lesson.subjectId || lesson.subject || s.subjectId) : null;
    if (!lesson || !subject || !subject.slug || !lesson.slug) {
        st.skipped.push(`${label}: không tìm thấy bài học/môn (hoặc thiếu slug) để xác định thư mục GitHub`);
        console.warn(`   ⚠️  ${label}: không xác định được môn/bài → bỏ qua (KHÔNG xoá gì)`);
        return;
    }

    let filePath = s.githubFile || null;
    const remote = filePath ? await githubService.readJsonFileWithSha(filePath) : null;
    const isNewFile = !remote;
    const data = remote ? { ...remote.data } : await submissionSkeleton(s, lesson, subject);

    const filled = [];
    if (remote) {
        if (hasText(s.answerHtml) && !hasText(data.answerHtml)) { data.answerHtml = s.answerHtml; filled.push('answerHtml'); }
        if (hasText(s.feedback) && !hasText(data.feedback)) { data.feedback = s.feedback; filled.push('feedback'); }
        if (hasArr(s.breakdown) && !hasArr(data.breakdown)) { data.breakdown = s.breakdown; filled.push('breakdown'); }
        if (hasObj(s.grammar) && !hasObj(data.grammar)) { data.grammar = s.grammar; filled.push('grammar'); }
        if (hasObj(s.sampleComparison) && !hasObj(data.sampleComparison)) { data.sampleComparison = s.sampleComparison; filled.push('sampleComparison'); }
        if (hasObj(s.promptSnapshot) && !hasObj(data.promptSnapshot)) { data.promptSnapshot = s.promptSnapshot; filled.push('promptSnapshot'); }
    }
    const needWrite = isNewFile || filled.length > 0;

    const plan = needWrite
        ? `ghi GitHub ${isNewFile ? '(TẠO file mới)' : '(điền thêm: ' + filled.join(', ') + ')'} → ${filePath || `submissions/${subject.slug}/${lesson.slug}/<tên-ngẫu-nhiên>.json`}`
        : 'GitHub đã đủ dữ liệu';
    console.log(`${tag}• ${label}: ${plan}; dọn field nặng khỏi Mongo`);

    if (!RUN) return;

    let finalSha = remote ? remote.sha : null;
    let finalData = data;
    if (needWrite) {
        if (!filePath) filePath = await githubService.uniqueJsonPath(`submissions/${subject.slug}/${lesson.slug}`, { timestamp: true });
        const res = await putJson(
            filePath,
            data,
            remote ? remote.sha : null,
            `[Migrate] Submission ${s._id} - ${lesson.title || lesson.slug}`
        );
        st.written++;
        const again = await githubService.readJsonFileWithSha(filePath);
        if (!again) throw new Error(`Ghi xong nhưng đọc lại không thấy file ${filePath}`);
        finalSha = again.sha || res.sha;
        finalData = again.data;
    }

    const miss = missingHeavy(s, finalData);
    if (miss.length) throw new Error(`Kiểm tra lại: GitHub vẫn thiếu ${miss.join(', ')} → KHÔNG xoá Mongo`);

    const set = {
        syncStatus: 'committed',
        githubFile: filePath,
        githubSha: finalSha || null,
        syncedAt: s.syncedAt || new Date(),
        syncError: null,
        // Dọn field nặng — giống submissionService.onSuccess
        answerHtml: '',
        feedback: '',
        breakdown: [],
        grammar: null,
        sampleComparison: null,
        promptSnapshot: null
    };
    if ((s.errorCount === null || s.errorCount === undefined) && s.grammar && Array.isArray(s.grammar.errors)) {
        set.errorCount = s.grammar.errors.length;
    }
    await Submission.collection.updateOne({ _id: s._id }, { $set: set });
    st.cleared++;
}

// ============================================================
// 4. COLLECTION DƯ THỪA (không thuộc model nào của dự án)
//    --orphans                    → chỉ liệt kê
//    --run --drop-orphans=a,b     → backup rồi xoá ĐÚNG các collection nêu tên
//    (không bao giờ tự xoá thứ không được nêu tên)
// ============================================================
const EXTRA_KEEP = ['sessions']; // connect-mongo (server.js) — không phải model nhưng đang dùng

// Collection CŨ của 3 loại dữ liệu đã chuyển sang GitHub. Trước khi xoá phải chắc
// MỌI document còn file tương ứng trên GitHub (githubFile có trong cây thư mục).
const LEGACY_GITHUB = ['lessons', 'gradingprompts', 'submissions'];

async function verifyLegacyOnGithub(name, tree) {
    const docs = await mongoose.connection.db.collection(name)
        .find({}, { projection: { githubFile: 1, title: 1, name: 1, status: 1, syncStatus: 1 } }).toArray();
    const missing = docs.filter((d) => !d.githubFile || !tree.files.has(d.githubFile));
    return { total: docs.length, ok: docs.length - missing.length, missing };
}

async function handleOrphans() {
    const db = mongoose.connection.db;
    const known = new Set([
        ...Object.values(mongoose.models).map((m) => m.collection.name),
        ...EXTRA_KEEP
    ]);
    const all = (await db.listCollections({}, { nameOnly: true }).toArray())
        .map((c) => c.name)
        .filter((n) => !n.startsWith('system.'));
    const orphans = all.filter((n) => !known.has(n));

    console.log('\n===== COLLECTION DƯ THỪA =====');
    console.log(`Collection thuộc dự án: ${[...known].sort().join(', ')}`);
    if (!orphans.length) {
        console.log('✅ Không có collection dư thừa.');
        return;
    }
    const info = [];
    for (const n of orphans) {
        const count = await db.collection(n).estimatedDocumentCount();
        info.push({ name: n, count });
        console.log(`• ${n}: ~${count} document`);
    }

    // Kiểm tra: dữ liệu cũ đã nằm đủ trên GitHub chưa?
    const verify = {};
    const toCheck = orphans.filter((n) => LEGACY_GITHUB.includes(n));
    if (toCheck.length) {
        let tree = null;
        try { tree = await githubService.getRepoTree({ force: true }); }
        catch (e) { console.warn(`⚠️ Không lấy được cây thư mục GitHub để kiểm tra: ${e.message}`); }
        console.log('\n--- Đối chiếu với GitHub ---');
        for (const n of toCheck) {
            if (!tree || tree.truncated) { verify[n] = null; console.log(`• ${n}: không kiểm tra được`); continue; }
            const v = await verifyLegacyOnGithub(n, tree);
            verify[n] = v;
            if (!v.missing.length) {
                console.log(`✅ ${n}: ${v.ok}/${v.total} document đều có file trên GitHub → an toàn để xoá.`);
            } else {
                console.log(`❌ ${n}: ${v.missing.length}/${v.total} document KHÔNG có file trên GitHub (mất dữ liệu nếu xoá):`);
                v.missing.slice(0, 10).forEach((d) => console.log(`     - ${d._id} ${d.title || d.name || ''} [githubFile=${d.githubFile || 'null'}]`));
                console.log(`     → chạy: node migrateMongoToGithub.js --run   (đẩy nốt lên GitHub) rồi kiểm tra lại.`);
            }
        }
    }

    const wanted = (argVal('drop-orphans') || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!wanted.length) {
        console.log('\n(Chỉ liệt kê.) Muốn xoá: node migrateMongoToGithub.js --run --drop-orphans=' + orphans.join(','));
        return;
    }
    const bad = wanted.filter((n) => !orphans.includes(n));
    if (bad.length) {
        console.error(`❌ Không xoá vì các tên sau không nằm trong danh sách dư thừa (hoặc là collection của dự án): ${bad.join(', ')}`);
        return;
    }
    const unsafe = wanted.filter((n) => LEGACY_GITHUB.includes(n) && (!verify[n] || verify[n].missing.length));
    if (unsafe.length && !argv.includes('--force-drop')) {
        console.error(`❌ Từ chối xoá ${unsafe.join(', ')}: chưa chứng minh được mọi document đã có trên GitHub. ` +
            `Nếu vẫn muốn xoá (đã có backup file JSON), thêm --force-drop.`);
        return;
    }
    if (!RUN) {
        console.log(`\n[dry-run] Sẽ backup + xoá: ${wanted.join(', ')}. Thêm --run để thực hiện.`);
        return;
    }

    // Backup toàn bộ document trước khi drop
    if (NO_BACKUP) {
        console.log('⏭️  --no-backup: bỏ qua bước backup collection dư thừa.');
    } else {
        const backup = { createdAt: new Date().toISOString(), collections: {} };
        for (const n of wanted) backup.collections[n] = await db.collection(n).find({}).toArray();
        const file = `backup-orphan-collections-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        let text;
        try { text = mongoose.mongo.BSON.EJSON.stringify(backup, null, 2, { relaxed: false }); }
        catch (_) { text = JSON.stringify(backup, null, 2); }
        fs.writeFileSync(file, text, 'utf8');
        console.log(`💾 Đã backup ra file: ${file}`);
    }

    for (const n of wanted) {
        await db.collection(n).drop();
        console.log(`🗑️  Đã xoá collection: ${n}`);
    }
}

// ============================================================
// 4. AUDIT LOGS  (collection auditlogs → auditlogs/index.json)
//    Chuyển HẾT bản ghi trong Mongo sang MỘT file JSON trên GitHub (gộp theo id,
//    không ghi đè bản đã có) → đọc lại kiểm tra → mới xoá đúng các bản ghi đã chuyển.
//    Xử lý THEO LÔ (1 commit cho cả lô) vì ghi từng bản ghi sẽ rất chậm.
// ============================================================
const AUDIT_BATCH = 500;

async function collectAuditlogs() {
    return legacy('auditlogs').find({}).sort({ createdAt: 1, _id: 1 }).toArray();
}

async function auditEntry(d) {
    const actorId = idStr(d.actor || d.adminId);
    const meta = actorId && oid(actorId) ? await userMeta(actorId) : null;   // chụp tên người thực hiện lúc chuyển
    let metadata = d.metadata !== undefined ? d.metadata : d.detail;
    try { metadata = JSON.parse(mongoose.mongo.BSON.EJSON.stringify(metadata === undefined ? {} : metadata, { relaxed: true })); } catch (_) { /* giữ nguyên */ }
    return {
        id: String(d._id),
        actor: actorId,
        ...(meta && meta.name ? { actorName: meta.name } : {}),
        ...(meta && meta.email ? { actorEmail: meta.email } : {}),
        action: d.action,
        entity: d.entity || d.targetType,
        entityId: idStr(d.entityId || d.targetId),
        description: d.description || (typeof d.detail === 'string' ? d.detail : ''),
        metadata,
        ipAddress: d.ipAddress || d.ip || '',
        userAgent: d.userAgent || '',
        createdAt: d.createdAt || (d._id && d._id.getTimestamp ? d._id.getTimestamp() : new Date()),
    };
}

async function processAuditlogsBatch(docs) {
    const st = stat('auditlogs');
    if (!docs.length) return;
    console.log(`   ${tag}${docs.length} bản ghi audit log → ${auditLogService.AUDIT_PATH} (lô ${AUDIT_BATCH})`);

    for (let i = 0; i < docs.length; i += AUDIT_BATCH) {
        const chunk = docs.slice(i, i + AUDIT_BATCH);
        const label = `lô ${Math.floor(i / AUDIT_BATCH) + 1}/${Math.ceil(docs.length / AUDIT_BATCH)} (${chunk.length} bản ghi)`;
        if (!RUN) { console.log(`   ${tag}${label}`); continue; }

        try {
            const entries = [];
            for (const d of chunk) {
                if (!hasText(d.action)) { st.skipped.push(`${d._id}: thiếu action`); continue; }
                entries.push(await auditEntry(d));
            }
            await auditLogService.createMany(entries, `Chuyển audit log từ MongoDB (${label})`);
            await sleep(WRITE_DELAY_MS);

            // Đọc lại GitHub để chắc chắn đã có đủ id rồi mới xoá ở Mongo
            const onGh = new Set(((await githubService.readJsonFile(auditLogService.AUDIT_PATH)) || { logs: [] }).logs.map((l) => l.id));
            const okIds = entries.filter((e) => onGh.has(e.id)).map((e) => e.id);
            st.written += okIds.length;
            if (okIds.length !== entries.length) {
                st.failed.push(`${label}: chỉ thấy ${okIds.length}/${entries.length} bản ghi trên GitHub → KHÔNG xoá lô này ở Mongo`);
                continue;
            }
            const del = await legacy('auditlogs').deleteMany({ _id: { $in: okIds.map((x) => oid(x)).filter(Boolean) } });
            st.cleared += del.deletedCount || 0;
            console.log(`   ✅ ${label}: ghi GitHub ${okIds.length}, xoá Mongo ${del.deletedCount || 0}`);
        } catch (e) {
            st.failed.push(`${label}: ${e.message}`);
            console.error(`   ❌ ${label}: ${e.message}`);
        }
    }
}

// ============================================================
// 5. AI PROVIDERS  (config/aiProviderSeed.js + MongoDB aikeys → AI-database/index.json)
//    - Dữ liệu chuyển từ JS: tên nhà cung cấp, biến API (baseUrl, chatPath, maxTokens, …), danh sách model,
//      model mặc định, model dự phòng — trước đây cứng trong config/aiModels.js / services/aiService.js.
//    - MongoDB: collection aikeys có field `provider` ('gemini' | 'vilao'; 'google' = cũ của Gemini) → GIỮ NGUYÊN,
//      chính là `id` của nhà cung cấp. Script chỉ ĐỌC để đối chiếu, không sửa/xoá gì ở MongoDB.
//    - Idempotent: chỉ thêm nhà cung cấp CÒN THIẾU trên GitHub; không ghi đè phần đã chỉnh trên web.
// ============================================================
const aiProviderService = require('./services/aiProviderService');
const aiSeed = require('./config/aiProviderSeed');

let aiDbState = null;   // { current:{data,sha}|null, usage:{id:count} }

async function readAiDbState() {
    if (aiDbState) return aiDbState;
    const current = await githubService.readJsonFileWithSha(aiProviderService.AI_DB_PATH);
    const usage = {};
    const rows = await legacy('aikeys').aggregate([{ $group: { _id: '$provider', n: { $sum: 1 } } }]).toArray();
    for (const r of rows) {
        const raw = typeof r._id === 'string' ? r._id.trim().toLowerCase() : '';
        const id = !raw || raw === 'google' ? 'gemini' : raw;
        usage[id] = (usage[id] || 0) + r.n;
    }
    aiDbState = { current, usage };
    return aiDbState;
}

async function collectAiproviders() {
    const { current } = await readAiDbState();
    const have = new Set(((current && current.data && current.data.providers) || []).map((p) => p.id));
    return aiSeed.seedProviders().filter((p) => !have.has(p.id));
}

async function processAiprovidersBatch(missing) {
    const st = stat('aiproviders');
    const { current, usage } = await readAiDbState();
    const PATH = aiProviderService.AI_DB_PATH;

    // Đối chiếu provider đang dùng trong MongoDB
    const known = new Set([
        ...aiSeed.seedProviders().map((p) => p.id),
        ...((current && current.data && current.data.providers) || []).map((p) => p.id)
    ]);
    console.log('   Key API trong MongoDB theo provider (giữ nguyên):');
    const ids = Object.keys(usage);
    if (!ids.length) console.log('   (chưa có key nào)');
    for (const id of ids) {
        const ok = known.has(id);
        console.log(`   - ${id}: ${usage[id]} key ${ok ? '✅' : '⚠️  chưa có cấu hình nhà cung cấp'}`);
        if (!ok) st.skipped.push(`provider "${id}" (${usage[id]} key) chưa có trong AI-database — thêm ở /admin/ai-keys/Supplier (id phải trùng "${id}")`);
    }

    console.log(`   ${tag}${current ? 'File đã có trên GitHub' : 'File CHƯA có trên GitHub'}: ${PATH}`);
    console.log(`   ${tag}Nhà cung cấp sẽ thêm: ${missing.map((p) => `${p.id} (${p.kind}, ${p.models.length} model)`).join(', ') || '(không — đã đủ)'}`);
    for (const p of missing) {
        const vars = Object.entries(p.jsVars || {}).map(([k, v]) => `${v}→${k}`).join(', ');
        console.log(`     • ${p.id}: ${p.label}${p.baseUrl ? ` | ${p.baseUrl}${p.chatPath}` : ''} | mặc định ${p.defaultModel}${vars ? ` | biến: ${vars}` : ''}`);
    }
    if (!missing.length) return;
    if (!RUN) return;

    const base = current && current.data ? aiProviderService.sanitizeDocument(current.data) : aiSeed.buildSeedDocument();
    const doc = {
        ...base,
        version: 1,
        updatedAt: new Date().toISOString(),
        providers: [...base.providers.filter((p) => !missing.some((m) => m.id === p.id)), ...missing]
    };
    // gemini luôn đứng đầu, còn lại giữ thứ tự
    doc.providers.sort((a, b) => (a.id === 'gemini' ? -1 : b.id === 'gemini' ? 1 : 0));
    const clean = aiProviderService.sanitizeDocument(doc);
    clean.updatedAt = doc.updatedAt;

    const res = await putJson(PATH, clean, current ? current.sha : null, 'Chuyển danh sách nhà cung cấp AI (API/biến API/model) từ JS sang GitHub');
    st.written += missing.length;

    // Đọc lại kiểm tra: đủ nhà cung cấp, đủ model
    const back = await githubService.readJsonFile(PATH);
    const backIds = new Set(((back && back.providers) || []).map((p) => p.id));
    const lost = clean.providers.filter((p) => !backIds.has(p.id)).map((p) => p.id);
    if (lost.length) { st.failed.push(`đọc lại thiếu nhà cung cấp: ${lost.join(', ')}`); return; }
    aiDbState = null;
    console.log(`   ✅ Đã ghi ${PATH} (sha ${String(res.sha).slice(0, 7)}): ${clean.providers.map((p) => `${p.id}[${p.models.length} model]`).join(', ')}`);
    console.log('   ℹ️  MongoDB không bị thay đổi: key API và field provider giữ nguyên. Từ nay danh sách này sửa ở /admin/ai-keys/Supplier.');
}

// ============================================================
// BACKUP trước khi xoá
// ============================================================
function writeBackup(plan) {
    const out = {
        createdAt: new Date().toISOString(),
        note: 'Bản sao các field sắp bị xoá khỏi MongoDB (EJSON: giữ nguyên ObjectId/Date).',
        prompts: (plan.prompts || []).map((d) => ({ _id: d._id, name: d.name, githubFile: d.githubFile, content: d.content, rubric: d.rubric, variables: d.variables })),
        lessons: (plan.lessons || [])
            .filter((l) => Object.prototype.hasOwnProperty.call(l, 'contentHtml'))
            .map((l) => ({ _id: l._id, title: l.title, githubFile: l.githubFile, contentHtml: l.contentHtml })),
        auditlogs: plan.auditlogs || [],   // nguyên bản ghi audit log sắp xoá khỏi Mongo
        submissions: (plan.submissions || []).map((s) => ({
            _id: s._id, githubFile: s.githubFile, syncStatus: s.syncStatus,
            answerHtml: s.answerHtml, feedback: s.feedback, breakdown: s.breakdown,
            grammar: s.grammar, sampleComparison: s.sampleComparison, promptSnapshot: s.promptSnapshot
        }))
    };
    const file = `backup-mongo-to-github-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    let text;
    try {
        const EJSON = mongoose.mongo.BSON.EJSON;
        text = EJSON.stringify(out, null, 2, { relaxed: false });
    } catch (_) {
        text = JSON.stringify(out, null, 2);
    }
    fs.writeFileSync(file, text, 'utf8');
    console.log(`💾 Đã backup ra file: ${file}`);
    return file;
}

// ============================================================
// MAIN
// ============================================================
(async () => {
    const found = findMongoUri();
    if (!found) {
        console.error('❌ Không tìm thấy chuỗi kết nối MongoDB trong .env (MONGO_URI...).');
        process.exit(1);
    }
    if (!githubService.isConfigured) {
        console.error('❌ GitHub chưa cấu hình: cần GITHUB_TOKEN + GITHUB_OWNER + GITHUB_REPO trong .env');
        process.exit(1);
    }

    console.log(`Kết nối MongoDB bằng biến ${found.name}`);
    await mongoose.connect(found.uri);
    console.log(RUN
        ? '🚀 CHẠY THẬT: sẽ ghi GitHub rồi xoá phần đã chuyển khỏi MongoDB.'
        : '🔎 DRY-RUN: chỉ báo cáo, không ghi GitHub, không sửa MongoDB. Thêm --run để chạy thật.');
    console.log(`Loại dữ liệu: ${ONLY.join(', ')}${LIMIT ? ` | giới hạn ${LIMIT} bản ghi/loại` : ''}\n`);

    const collectors = { prompts: collectPrompts, lessons: collectLessons, submissions: collectSubmissions, auditlogs: collectAuditlogs, aiproviders: collectAiproviders };
    const processors = { prompts: processPrompt, lessons: processLesson, submissions: processSubmission };

    // Bước 1: gom danh sách cần xử lý
    const plan = {};
    for (const kind of ONLY) {
        let docs = await collectors[kind]();
        if (LIMIT && kind !== 'aiproviders') docs = docs.slice(0, LIMIT);
        plan[kind] = docs;
        stat(kind).total = docs.length;
        console.log(`• ${kind}: ${docs.length} bản ghi còn dữ liệu cần xử lý`);
    }
    console.log('');

    // Bước 2: backup (chỉ khi chạy thật)
    // (aiproviders không xoá gì ở MongoDB nên không cần backup)
    if (RUN && !NO_BACKUP && ONLY.some((k) => k !== 'aiproviders' && plan[k] && plan[k].length)) writeBackup(plan);
    else if (RUN && NO_BACKUP) console.log('⏭️  --no-backup: không tạo file backup.');

    // Bước 3: xử lý tuần tự (prompts → lessons → submissions)
    for (const kind of ALL_KINDS) {
        if (kind === 'aiproviders' && plan[kind]) {
            console.log(`\n===== ${kind.toUpperCase()} =====`);
            try { await processAiprovidersBatch(plan[kind]); } catch (e) { stat(kind).failed.push(e.message); console.error(`   ❌ aiproviders: ${e.message}`); }
            continue;
        }
        if (!plan[kind] || !plan[kind].length) continue;
        console.log(`\n===== ${kind.toUpperCase()} =====`);
        if (kind === 'auditlogs') { await processAuditlogsBatch(plan[kind]); continue; }   // xử lý theo lô
        for (const doc of plan[kind]) {
            try {
                await processors[kind](doc);
            } catch (e) {
                stat(kind).failed.push(`${doc._id}: ${e.message}`);
                console.error(`   ❌ ${kind} ${doc._id}: ${e.message}`);
            }
        }
    }

    // Collection dư thừa (độc lập với 3 loại trên)
    if (argv.includes('--orphans') || argVal('drop-orphans')) {
        try { await handleOrphans(); } catch (e) { console.error('❌ Lỗi khi xử lý collection dư thừa:', e.message); }
    }

    // Tổng kết
    console.log('\n================ TỔNG KẾT ================');
    for (const kind of ONLY) {
        const r = stat(kind);
        console.log(`${kind}: cần xử lý ${r.total} | ghi GitHub ${r.written} | đã dọn Mongo ${r.cleared} | lỗi ${r.failed.length} | bỏ qua ${r.skipped.length}`);
        r.skipped.forEach((m) => console.log(`   ⚠️  bỏ qua — ${m}`));
        r.failed.forEach((m) => console.log(`   ❌ lỗi — ${m}`));
    }
    if (!RUN) console.log('\n(Dry-run) Chưa thay đổi gì. Kiểm tra kết quả rồi chạy lại với --run.');

    await mongoose.disconnect();
    const anyFail = ONLY.some((k) => stat(k).failed.length);
    process.exit(anyFail ? 1 : 0);
})().catch((e) => {
    console.error('❌', e);
    process.exit(1);
});

// ------------------------------------------------------------
// GHI CHÚ: vì sao KHÔNG xoá sampleSolution / description của lessons khỏi Mongo?
//   - services/submissionService.js đọc `lesson.sampleSolution` TRỰC TIẾP từ Mongo khi chấm bài;
//   - lesson.controller.js tạo/sửa bài vẫn ghi 2 field này vào Mongo;
//   Xoá chúng sẽ làm AI chấm thiếu lời giải mẫu. Muốn xoá thì phải sửa code đọc từ GitHub trước.
// ------------------------------------------------------------
