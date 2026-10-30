'use strict';
/* ============================================================
   controllers/quiz.controller.js — bài trắc nghiệm
   Admin : newForm, editForm, parsePreview, create, update, reviewPage, saveQuizTeacherComment
   Student: submit, status, analyze, renderStudentDetail
   Export thêm: toStudentView(quiz) — lesson.controller dùng khi render quiz-lesson.pug
   ============================================================ */

const mongoose = require('mongoose');

const Lesson = require('../models/Lesson');
const Subject = require('../models/Subject');
const Submission = require('../models/Submission');
const GradingPrompt = require('../models/GradingPrompt');
const AIKey = require('../models/AIKey');
const AuditLog = require('../models/AuditLog');

const githubService = require('../services/githubService');
const syncQueue = require('../services/syncQueueService');
const quizParser = require('../services/quizParserService');
const quizGrader = require('../services/quizGradingService');
const quizAnalysis = require('../services/quizAnalysisService');
const userKeyService = require('../services/userKeyService');
const sanitizeService = require('../services/sanitizeService');
const notificationService = require('../services/notificationService');
const aiService = require('../services/aiService');
const quizConfig = require('../config/quizConfig');
const { normalizeAudioUrl } = require('../services/quizAudioService');

// ============================================================
// ADAPTERS
// ============================================================
const A = {
  ghRead: (path) => githubService.readJsonFileWithSha(path),
  ghWrite: async (path, data, sha) => {
    if (!sha) return githubService.writeJsonFile(path, data, 'Quiz: ' + path);
    try {
      return await githubService.writeJsonFileIfSha(path, data, sha, 'Quiz: ' + path);
    } catch (e) {
      if (e && e.code === 'SHA_CONFLICT') e.status = 409;
      throw e;
    }
  },
  ghInvalidate: (path) => { if (typeof githubService.invalidate === 'function') githubService.invalidate(path); },

  parsePart: (part, text, opts) => {
    const r = quizParser.parsePart(text, part, opts);
    return { errors: r.errors || [], questions: r.questions || [], clusters: r.clusters || [], note: r.note || null };
  },
  serializePart: (part, questions, note, clusters) => quizParser.serializePart(questions, part, note, clusters),

  grade: (quiz, answers) => quizGrader.grade(quiz, answers),

  cleanHtml: (html) => sanitizeService.sanitizeExplanationHtml(html),

  adminScope: async (actor) => (await userKeyService.getContentScope(actor)).query || {},
  // ★ FIX: userKeyService KHÔNG có hàm canAccess (chỉ export getContentScope…) → trước đây sinh viên nộp bài
  //   bị TypeError "canAccess is not a function" → 500. getContentScope nhận req ({ user }) và trả scope.canAccess(doc).
  studentCanAccess: async (user, lesson) => (await userKeyService.getContentScope({ user })).canAccess(lesson),
  adminCanAccess: (actor, lesson) => !actor.userKey || String(lesson.createdBy) === String(actor._id),

  formatAiLabel: (provider, keyName) => aiService.formatAiLabel(provider, keyName),

  pushSubmission: async (path, data, subId) => {
    const setSync = (v, extra) => Submission.updateOne({ _id: subId }, { $set: Object.assign({ syncStatus: v }, extra || {}) });
    const msg = 'Quiz submission: ' + path;
    if (!githubService.isConfigured) { await setSync('failed'); return 'failed'; }
    try {
      const written = await githubService.writeJsonFile(path, data, msg);
      await setSync('committed', { githubSha: written && written.sha ? written.sha : null, syncedAt: new Date() });
      return 'committed';
    } catch (e) {
      console.error('[quiz.submit] GitHub ghi trực tiếp lỗi, chuyển sang queue:', e.message);
      const jobId = syncQueue.enqueue({
        type: 'putJson', filePath: path, data, commitMessage: msg,
        onSuccess: async (r) => { await setSync('committed', { githubSha: r && r.sha ? r.sha : null, syncedAt: new Date() }); },
        onFinalFail: async () => { await setSync('failed'); },
      });
      if (!jobId) { await setSync('failed'); return 'failed'; }
      return 'pending';
    }
  },

  notifyNewLesson: (lesson, subject) => notificationService.notifyNewLesson(lesson, subject),
  notifyTeacherComment: (submission) => notificationService.create({
    userId: submission.userId, type: 'teacher_comment', title: 'Giảng viên đã nhận xét bài làm',
    message: 'Bài trắc nghiệm của bạn có nhận xét mới từ giảng viên.', link: `/submissions/${submission._id}`,
  }),
};

// ============================================================
// ★ FIX: audit() — khớp schema AuditLog.js thật
// ------------------------------------------------------------
// Schema thật dùng: actor / action / entity / entityId / description / metadata.
// Trước đây ghi: adminId / action / targetType / targetId / detail / userKey
// → AuditLog.create() ném ValidationError "entity: Path 'entity' is required".
//
// Chữ ký hàm GIỮ NGUYÊN (action, entityName, entityId, detail) để không phải
// sửa các chỗ gọi audit() — chỉ đổi cách map sang field của schema:
//   - actor      ← req.user._id
//   - entity     ← entityName (String: 'Lesson' | 'Submission' | ...)
//   - entityId   ← entityId (ObjectId)
//   - metadata   ← detail (nếu là object) — để tra cứu thêm
//   - description← detail (nếu là string) — để đọc nhanh trong danh sách log
// ============================================================
async function audit(req, action, entityName, entityId, detail) {
  try {
    const meta = (detail && typeof detail === 'object') ? detail : {};
    const desc = typeof detail === 'string' ? detail : '';
    await AuditLog.create({
      actor: req.user && req.user._id ? req.user._id : null,
      action: String(action),
      entity: String(entityName || 'Unknown'),
      entityId: entityId && mongoose.Types.ObjectId.isValid(entityId) ? entityId : null,
      description: desc,
      metadata: meta,
      ipAddress: req.ip || '',
      userAgent: (req.get && req.get('user-agent')) || '',
    });
  } catch (e) {
    console.warn('[quiz] audit:', e.message);
  }
}

// ============================================================
// Tiện ích
// ============================================================
const PARTS = ['mcq', 'tf', 'fill'];
const MAX_TEXT = quizConfig.MAX_TEXT_CHARS || 200000;
const MAX_ANALYSES = quizConfig.MAX_ANALYSES_PER_SUBMISSION || 5;
const COOLDOWN_MS = quizConfig.ANALYSIS_COOLDOWN_MS || 30000;
const DEFAULT_DURATION = quizConfig.DEFAULT_DURATION || 20;
const DURATION_MIN = 1;
const DURATION_MAX = 600;

function toNum(v, def) {
  const s = String(v == null ? '' : v).trim().replace(',', '.');
  if (s === '') return def;
  const n = Number(s);
  return Number.isFinite(n) ? n : def;
}
const round4 = (n) => Math.round(n * 10000) / 10000;

function parseDuration(v) {
  const n = toNum(v, NaN);
  return Number.isInteger(n) && n >= DURATION_MIN && n <= DURATION_MAX ? n : null;
}

function slugify(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'quiz';
}

const fail = (res, status, message, extra) => res.status(status).json(Object.assign({ success: false, message }, extra || {}));
const isDefaultAdmin = (u) => !u.userKey;
const AI_KEY_USABLE = { active: { $ne: false }, isActive: { $ne: false }, isRevoked: { $ne: true } };

// ============================================================
// Dựng đề từ text
// ============================================================
function buildQuiz(body) {
  const errors = [];
  const maxScore = toNum(body.maxScore, NaN);
  if (!(maxScore > 0)) errors.push({ msg: 'Thang điểm tối đa phải là số lớn hơn 0 (VD 10 hoặc 2.5).' });

  const parts = {};
  let total = 0;
  for (const part of PARTS) {
    const text = String(body[part] || '');
    if (text.length > MAX_TEXT) { errors.push({ part, msg: 'Text quá dài.' }); continue; }
    if (!text.trim()) continue;

    const ppq = toNum(body['pointsPerQuestion_' + part], NaN);
    if (!(ppq > 0)) { errors.push({ part, msg: '“Điểm / câu” phải là số lớn hơn 0 (VD 0.1, 0.2, 0.25, 1).' }); continue; }

    const opts = {};
    if (part === 'tf') {
      const sc = String(body.scoring_tf || body.tfScoring || quizConfig.TF_DEFAULT_SCORING || 'equal');
      if (!(quizConfig.TF_SCORING || ['equal', 'thptqg']).includes(sc)) { errors.push({ part, msg: 'Cách chia điểm phần Đúng/Sai không hợp lệ.' }); continue; }
      opts.scoring = sc;
    }
    if (part === 'fill') {
      opts.tolerance = Math.max(0, toNum(body.tolerance, 0));
      opts.note = String(body.note || '').trim().slice(0, 300);
    }
    const r = A.parsePart(part, text, opts);
    if (r.errors.length) { r.errors.forEach((e) => errors.push({ part, line: e.line, msg: e.msg })); continue; }
    if (!r.questions.length) continue;

    const questions = r.questions.map((q, i) => {
      const id = `${part}-${i + 1}`;
      if (part === 'tf') {
        return Object.assign({}, q, {
          id,
          statements: (q.statements || []).map((st) => Object.assign({}, st, {
            explanationHtml: st.explanationHtml ? (A.cleanHtml(st.explanationHtml) || null) : null,
          })),
        });
      }
      return Object.assign({}, q, { id, explanationHtml: q.explanationHtml ? (A.cleanHtml(q.explanationHtml) || null) : null });
    });
    parts[part] = { pointsPerQuestion: round4(ppq), questions };
    if (part === 'tf') parts.tf.scoring = opts.scoring;
    if (part === 'fill') {
      parts.fill.tolerance = opts.tolerance;
      parts.fill.note = opts.note || (r.note ? String(r.note).slice(0, 300) : '');
    }
    if (part !== 'tf' && r.clusters && r.clusters.length) {
      parts[part].clusters = r.clusters;
    }
    total += questions.length;
  }
  if (!total && !errors.length) errors.push({ msg: 'Cần ít nhất 1 câu hỏi ở một phần nào đó.' });
  if (errors.length) return { errors };
  return { quiz: { version: 1, maxScore: round4(maxScore), parts }, counts: {
    mcq: parts.mcq ? parts.mcq.questions.length : 0,
    tf: parts.tf ? parts.tf.questions.length : 0,
    fill: parts.fill ? parts.fill.questions.length : 0,
  } };
}

// ============================================================
// Dữ liệu gửi xuống sinh viên
// ============================================================
function toStudentView(quiz) {
  const out = { maxScore: quiz.maxScore, parts: {} };
  const audio = normalizeAudioUrl(quiz.audioUrl);
  if (audio.url) out.audioUrl = audio.url;
  for (const k of PARTS) {
    const p = quiz.parts && quiz.parts[k];
    if (!p || !Array.isArray(p.questions) || !p.questions.length) continue;
    out.parts[k] = {
      pointsPerQuestion: p.pointsPerQuestion,
      questions: p.questions.map((q) => {
        const v = { id: q.id, text: q.text, image: q.image || null };
        if (k === 'mcq') { v.options = (q.options || []).map((o) => ({ key: o.key, text: o.text })); v.multi = !!q.multi; }
        if (k === 'tf') v.statements = (q.statements || []).map((st) => ({ id: st.id, text: st.text }));
        return v;
      }),
    };
    if (k === 'tf') out.parts[k].scoring = p.scoring || quizConfig.TF_DEFAULT_SCORING || 'equal';
    if (k === 'fill') out.parts[k].note = p.note || '';
    if (k !== 'tf') {
      if (p.clusters && p.clusters.length) {
        out.parts[k].clusters = p.clusters.map((c) => ({
          id: c.id, from: c.from, to: c.to,
          text: sanitizeService.sanitizeExplanationHtml(c.text || ''),
          image: c.image || null, questionIds: c.questionIds || [],
        }));
        const byQ = {};
        out.parts[k].clusters.forEach((c) => (c.questionIds || []).forEach((qid) => { byQ[qid] = c.id; }));
        out.parts[k].questions.forEach((v) => { v.clusterId = byQ[v.id] || null; });
      } else {
        out.parts[k].questions.forEach((v) => { v.clusterId = null; });
      }
    }
  }
  return out;
}

function sanitizeAnswers(quiz, raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const k of PARTS) {
    const p = quiz.parts && quiz.parts[k];
    if (!p) continue;
    for (const q of p.questions) {
      if (k === 'tf') {
        for (const st of q.statements || []) {
          if (typeof src[st.id] === 'boolean') out[st.id] = src[st.id];
        }
        continue;
      }
      const a = src[q.id];
      if (a === undefined || a === null) continue;
      if (k === 'mcq') {
        const keys = new Set((q.options || []).map((o) => o.key));
        const picked = (Array.isArray(a) ? a : [a]).map(String).filter((x) => keys.has(x));
        if (picked.length) out[q.id] = Array.from(new Set(picked)).sort();
      } else if (typeof a === 'string' && a.trim()) {
        out[q.id] = a.trim().slice(0, 300);
      }
    }
  }
  return out;
}

function withExplanations(result, quiz) {
  const expl = {};
  for (const k of PARTS) {
    ((quiz.parts[k] || {}).questions || []).forEach((q) => {
      expl[q.id] = q.explanationHtml || null;
      (q.statements || []).forEach((st) => { expl[st.id] = st.explanationHtml || null; });
    });
  }
  return Object.assign({}, result, {
    items: (result.items || []).map((it) => Object.assign({}, it, { explanationHtml: expl[it.id] ? A.cleanHtml(expl[it.id]) : null })),
  });
}

// ============================================================
// ADMIN — form tạo / sửa
// ============================================================
async function formLists(actor) {
  const scope = await A.adminScope(actor);
  const [subjects, prompts, aiKeys] = await Promise.all([
    Subject.find(Object.assign({ deletedAt: null, deletedForever: { $ne: true } }, scope)).sort({ name: 1 }).lean(),
    GradingPrompt.find({ kind: 'quiz', active: true }).sort({ name: 1 }).lean(),
    isDefaultAdmin(actor) ? AIKey.find(AI_KEY_USABLE).sort({ name: 1 }).lean() : [],
  ]);
  return { subjects, prompts, aiKeys: aiKeys.map((k) => Object.assign({}, k, { provider: k.provider || 'gemini', aiLabel: A.formatAiLabel(k.provider || 'gemini', k.name) })), canPickAIKey: isDefaultAdmin(actor) };
}

exports.newForm = async (req, res, next) => {
  try {
    const lists = await formLists(req.user);
    res.render('admin/quiz-form', Object.assign(lists, {
      mode: 'create', subjectId: req.query.subjectId || '', quiz: null, lesson: null,
      rawTexts: { mcq: '', tf: '', fill: '' }, submissionCount: 0, sha: null, quizConfig,
    }));
  } catch (e) { next(e); }
};

exports.editForm = async (req, res, next) => {
  try {
    const lesson = await Lesson.findOne({ _id: req.params.lessonId, type: 'quiz', deletedForever: { $ne: true } }).lean();
    if (!lesson || !A.adminCanAccess(req.user, lesson)) return res.status(404).render('error', { message: 'Không tìm thấy bài trắc nghiệm.' });
    const file = await A.ghRead(lesson.githubFile);
    if (!file) return res.status(404).render('error', { message: 'Không đọc được đề trên GitHub.' });

    // ★ Đưa giải thích / nội dung chùm đã lưu về dạng DỄ SỬA (&lt;code&gt; → <code>, i&lt;n → i<n):
    //   tránh hiện nguyên "&lt;code&gt;…" trong ô nhập và tránh bị escape chồng sau mỗi lần Lưu.
    //   Khi Lưu, sanitizeExplanationHtml chuẩn hoá lại (idempotent). Không đụng bản trên GitHub.
    const editData = JSON.parse(JSON.stringify(file.data || {}));
    const toEdit = sanitizeService.htmlToEditable;
    const eParts = (editData.quiz && editData.quiz.parts) || {};
    PARTS.forEach((k) => {
      const part = eParts[k];
      if (!part) return;
      (part.questions || []).forEach((q) => {
        if (q.explanationHtml) q.explanationHtml = toEdit(q.explanationHtml);
        (q.statements || []).forEach((st) => { if (st.explanationHtml) st.explanationHtml = toEdit(st.explanationHtml); });
      });
      (part.clusters || []).forEach((c) => { if (c.text) c.text = toEdit(c.text); });
    });

    const parts = eParts;
    const rawTexts = {};
    PARTS.forEach((k) => {
      if (!parts[k]) { rawTexts[k] = ''; return; }
      rawTexts[k] = A.serializePart(k, parts[k].questions, parts[k].note, parts[k].clusters);
    });

    const lists = await formLists(req.user);
    const submissionCount = await Submission.countDocuments({ lessonId: lesson._id, type: 'quiz' });
    res.render('admin/quiz-form', Object.assign(lists, {
      mode: 'edit', subjectId: String(lesson.subjectId), quiz: editData, lesson, rawTexts, submissionCount, sha: file.sha, quizConfig,
    }));
  } catch (e) { next(e); }
};

exports.parsePreview = (req, res) => {
  const built = buildQuiz(req.body || {});
  if (built.errors) return fail(res, 400, 'Đề chưa hợp lệ.', { errors: built.errors });
  res.json({ success: true, preview: built.quiz });
};

// ============================================================
// ADMIN — lưu (tạo mới / cập nhật)
// ============================================================
async function readCommon(req, body) {
  const duration = parseDuration(body.duration);
  if (duration == null) return { error: `Thời gian làm bài phải là số phút nguyên từ ${DURATION_MIN} đến ${DURATION_MAX}.` };

  const title = String(body.title || '').trim().slice(0, 200);
  if (!title) return { error: 'Chưa nhập tiêu đề bài.' };

  const built = buildQuiz(body);
  if (built.errors) return { errors: built.errors };

  const audio = normalizeAudioUrl(body.audioUrl);
  if (audio.error) return { error: audio.error };

  let promptId = null;
  if (body.promptId) {
    const p = await GradingPrompt.findOne({ _id: body.promptId, kind: 'quiz', active: true }).select('_id').lean();
    if (!p) return { error: 'Prompt phân tích không hợp lệ.' };
    promptId = p._id;
  }

  let analysisAiKeyIds;
  if (isDefaultAdmin(req.user)) {
    const ids = Array.isArray(body.aiKeyIds) ? body.aiKeyIds : [];
    analysisAiKeyIds = ids.length ? (await AIKey.find(Object.assign({ _id: { $in: ids } }, AI_KEY_USABLE)).select('_id').lean()).map((k) => k._id) : [];
  }
  return { duration, title, built, promptId, analysisAiKeyIds, audioUrl: audio.url,
    contentHtml: body.contentHtml ? (A.cleanHtml(String(body.contentHtml).slice(0, 20000)) || null) : null };
}

exports.create = async (req, res) => {
  try {
    const body = req.body || {};
    const scope = await A.adminScope(req.user);
    const subject = await Subject.findOne(Object.assign({ _id: body.subjectId, deletedAt: null, deletedForever: { $ne: true } }, scope));
    if (!subject) return fail(res, 404, 'Không tìm thấy môn học.');

    const c = await readCommon(req, body);
    if (c.error) return fail(res, 400, c.error);
    if (c.errors) return fail(res, 400, 'Đề chưa hợp lệ.', { errors: c.errors });

    let slug = slugify(body.slug || c.title);
    if (await Lesson.exists({ subjectId: subject._id, slug })) slug += '-' + Date.now().toString(36);
    // ★ Thêm timestamp (giây unix) ở đuôi để giảm tỉ lệ trùng tên file: <slug>_<unix>.json
    const githubFile = `subjects/${subject.slug}/lessons/${slug}_${Math.floor(Date.now() / 1000)}.json`;
    if (await A.ghRead(githubFile)) return fail(res, 409, 'Đã có file trùng đường dẫn trên GitHub. Đổi tiêu đề / slug.');

    if (c.audioUrl) c.built.quiz.audioUrl = c.audioUrl;

    // ★ GitHub là nguồn sự thật: file JSON chứa ĐỦ thông tin để dựng lại bài chỉ từ GitHub
    const lessonId = new mongoose.Types.ObjectId();
    const nowIso = new Date().toISOString();
    const written = await A.ghWrite(githubFile, {
      type: 'quiz', lessonId: String(lessonId), title: c.title, slug, subjectSlug: subject.slug,
      duration: c.duration, promptId: c.promptId ? String(c.promptId) : null,
      analysisAiKeyIds: (c.analysisAiKeyIds || []).map(String),
      isPublished: true, isDeleted: false,
      createdBy: { id: String(req.user._id), name: req.user.name || '', email: req.user.email || '' },
      createdAt: nowIso, updatedAt: nowIso,
      contentHtml: c.contentHtml, quiz: c.built.quiz,
    });

    const lesson = await Lesson.create({
      _id: lessonId, githubSha: written && written.sha ? written.sha : null,
      subjectId: subject._id, title: c.title, slug, githubFile, type: 'quiz',
      quizCounts: c.built.counts, duration: c.duration, promptId: c.promptId,
      analysisAiKeyIds: c.analysisAiKeyIds || [],
      userKey: subject.userKey || null,
      createdBy: req.user._id, isPublished: true,
    });

    try { await A.notifyNewLesson(lesson, subject); } catch (e) { console.warn('[quiz] notify:', e.message); }
    await audit(req, 'create_quiz', 'Lesson', lesson._id, { title: c.title, duration: c.duration, counts: c.built.counts });
    res.json({ success: true, lessonId: String(lesson._id) });
  } catch (e) {
    console.error('[quiz.create]', e);
    fail(res, 500, 'Lỗi máy chủ khi tạo bài.');
  }
};

exports.update = async (req, res) => {
  try {
    const body = req.body || {};
    const lesson = await Lesson.findOne({ _id: req.params.lessonId, type: 'quiz', deletedForever: { $ne: true } });
    if (!lesson || !A.adminCanAccess(req.user, lesson)) return fail(res, 404, 'Không tìm thấy bài trắc nghiệm.');

    const c = await readCommon(req, body);
    if (c.error) return fail(res, 400, c.error);
    if (c.errors) return fail(res, 400, 'Đề chưa hợp lệ.', { errors: c.errors });

    const file = await A.ghRead(lesson.githubFile);
    if (!file) return fail(res, 404, 'Không đọc được đề trên GitHub.');
    if (body.sha && body.sha !== file.sha) return fail(res, 409, 'Đề đã bị đổi, vui lòng tải lại trang.');

    if (c.audioUrl) c.built.quiz.audioUrl = c.audioUrl;
    try {
      // ★ Giữ nguyên các field metadata sẵn có trong file (createdBy, createdAt, isDeleted…), chỉ ghi đè phần đổi
      const subj = await Subject.findById(lesson.subjectId).select('slug').lean();
      const prev = file.data || {};
      const analysisIds = c.analysisAiKeyIds || lesson.analysisAiKeyIds || [];
      const written = await A.ghWrite(lesson.githubFile, Object.assign({}, prev, {
        type: 'quiz', lessonId: String(lesson._id), title: c.title, slug: lesson.slug,
        subjectSlug: subj ? subj.slug : (prev.subjectSlug || null),
        duration: c.duration, promptId: c.promptId ? String(c.promptId) : null,
        analysisAiKeyIds: analysisIds.map(String),
        isPublished: lesson.isPublished !== false, isDeleted: lesson.deletedAt ? true : (prev.isDeleted === true),
        createdAt: prev.createdAt || (lesson.createdAt ? new Date(lesson.createdAt).toISOString() : new Date().toISOString()),
        updatedAt: new Date().toISOString(),
        contentHtml: c.contentHtml, quiz: c.built.quiz,
      }), file.sha);
      lesson.githubSha = written && written.sha ? written.sha : lesson.githubSha;
    } catch (e) {
      if (e && e.status === 409) return fail(res, 409, 'Đề đã bị đổi, vui lòng tải lại trang.');
      throw e;
    }
    A.ghInvalidate(lesson.githubFile);

    lesson.title = c.title;
    lesson.duration = c.duration;
    lesson.promptId = c.promptId;
    lesson.quizCounts = c.built.counts;
    if (c.analysisAiKeyIds) lesson.analysisAiKeyIds = c.analysisAiKeyIds;
    await lesson.save();

    await audit(req, 'update_quiz', 'Lesson', lesson._id, { title: c.title, duration: c.duration, counts: c.built.counts });
    res.json({ success: true, lessonId: String(lesson._id) });
  } catch (e) {
    console.error('[quiz.update]', e);
    fail(res, 500, 'Lỗi máy chủ khi lưu bài.');
  }
};

// ============================================================
// STUDENT — nộp bài
// ============================================================
async function loadStudentLesson(req) {
  const lesson = await Lesson.findOne({
    _id: req.params.lessonId, type: 'quiz', isPublished: true, deletedAt: null, deletedForever: { $ne: true },
  });
  if (!lesson) return null;
  if (req.user.role === 'admin') return A.adminCanAccess(req.user, lesson) ? lesson : null;
  return (await A.studentCanAccess(req.user, lesson)) ? lesson : null;
}

exports.submit = async (req, res) => {
  // ★ step: ghi lại bước đang chạy để log/giao diện biết CHÍNH XÁC chỗ lỗi (trước đây chỉ báo chung chung)
  let step = 'kiểm tra quyền';
  try {
    if (!['student', 'admin'].includes(req.user.role)) return fail(res, 403, 'Bạn không có quyền nộp bài.');
    step = 'tải bài + kiểm tra quyền truy cập bài (userKeyService.canAccess)';
    const lesson = await loadStudentLesson(req);
    if (!lesson) return fail(res, 404, 'Không tìm thấy bài.');

    step = 'đọc đề từ GitHub (' + lesson.githubFile + ')';
    const file = await A.ghRead(lesson.githubFile);
    if (!file || !file.data.quiz) return fail(res, 500, 'Không đọc được đề.');
    const quiz = file.data.quiz;
    step = 'chấm bài';
    const answers = sanitizeAnswers(quiz, req.body && req.body.answers);

    const result = A.grade(quiz, answers);
    step = 'tạo đường dẫn bài nộp';
    const subject = await Subject.findById(lesson.subjectId).select('slug').lean();
    const now = new Date();
    // ★ Tên file NGẪU NHIÊN, không trùng file nào trên GitHub
    const path = await githubService.uniqueJsonPath(`submissions/${subject.slug}/${lesson.slug}`, { timestamp: true });
    const subId = new mongoose.Types.ObjectId();

    step = 'tạo bản ghi Submission';
    const sub = await Submission.create({
      _id: subId,
      userId: req.user._id, lessonId: lesson._id, githubFile: path, type: 'quiz',
      score: result.score, maxScore: result.maxScore, correctCount: result.correctCount, totalCount: result.totalCount,
      status: 'graded', syncStatus: 'pending', submittedAt: now, gradedAt: now, analysisCount: 0, teacherComment: null,
    });

    const json = {
      type: 'quiz', submissionId: String(subId), userId: String(req.user._id), lessonId: String(lesson._id),
      lessonTitle: lesson.title || null, subjectSlug: subject.slug, lessonSlug: lesson.slug, submittedAt: now.toISOString(),
      answers, quizSnapshot: quiz, result, gradedAt: now.toISOString(), gradedBy: 'auto',
      teacherComment: null, teacherCommentHistory: [], aiAnalyses: [],
    };
    step = 'ghi bài nộp lên GitHub';
    const syncStatus = await A.pushSubmission(path, json, sub._id);

    res.json({ success: true, submissionId: String(sub._id), status: syncStatus, syncStatus, result: withExplanations(result, quiz) });
  } catch (e) {
    console.error('[quiz.submit] LỖI Ở BƯỚC: ' + step + ' | user=' + (req.user && req.user._id) + ' role=' + (req.user && req.user.role) + ' userKey=' + (req.user && req.user.userKey) + ' lesson=' + req.params.lessonId, e);
    fail(res, 500, 'Lỗi máy chủ khi chấm bài (bước: ' + step + ').', { step, detail: String((e && e.message) || e).slice(0, 200) });
  }
};

exports.status = async (req, res) => {
  const sub = await Submission.findOne({ _id: req.params.id, userId: req.user._id, type: 'quiz' }).select('syncStatus analysisCount').lean();
  if (!sub) return fail(res, 404, 'Không tìm thấy bài nộp.');
  res.json({ success: true, status: sub.syncStatus || 'pending', syncStatus: sub.syncStatus || 'pending', analysisCount: sub.analysisCount || 0 });
};

// ============================================================
// STUDENT — Phân tích AI
// ============================================================
const analyzing = new Set();

exports.analyze = async (req, res) => {
  const id = String(req.params.id);
  if (analyzing.has(id)) return fail(res, 429, 'Đang phân tích, vui lòng chờ.');
  analyzing.add(id);
  try {
    const sub = await Submission.findOne({ _id: id, userId: req.user._id, type: 'quiz' });
    if (!sub) return fail(res, 404, 'Không tìm thấy bài nộp.');
    if (sub.syncStatus !== 'committed') return fail(res, 409, 'Bài chưa lưu xong lên GitHub, thử lại sau ít giây.');
    if ((sub.analysisCount || 0) >= MAX_ANALYSES) return fail(res, 429, 'Đã đạt số lần phân tích tối đa.', { limitReached: true });
    if (sub.lastAnalyzedAt && Date.now() - sub.lastAnalyzedAt.getTime() < COOLDOWN_MS) {
      return fail(res, 429, `Vui lòng chờ ${Math.ceil((COOLDOWN_MS - (Date.now() - sub.lastAnalyzedAt.getTime())) / 1000)} giây rồi thử lại.`);
    }

    const lesson = await Lesson.findById(sub.lessonId).lean();
    if (!lesson) return fail(res, 404, 'Bài học không còn tồn tại.');

    const aiKeyId = req.body && req.body.aiKeyId ? String(req.body.aiKeyId) : '';
    if (!aiKeyId) return fail(res, 400, 'Hãy chọn AI và bấm “Kiểm tra AI” trước khi phân tích.');
    const allowed = (lesson.analysisAiKeyIds || []).map(String);
    if (allowed.length) {
      if (!allowed.includes(aiKeyId)) return fail(res, 400, 'AI không được phép cho bài này.');
    } else {
      if (!mongoose.Types.ObjectId.isValid(aiKeyId)) return fail(res, 400, 'AI Key không hợp lệ.');
      const usable = await AIKey.exists(Object.assign({ _id: aiKeyId }, AI_KEY_USABLE));
      if (!usable) return fail(res, 400, 'AI Key không tồn tại hoặc đã bị tắt.');
    }
    const model = req.body && typeof req.body.model === 'string' && req.body.model.trim()
      ? req.body.model.trim().slice(0, 100) : null;

    const subject = await Subject.findById(lesson.subjectId).lean();

    const file = await A.ghRead(sub.githubFile);
    if (!file || !file.data || !file.data.quizSnapshot) return fail(res, 502, 'Không đọc được bài nộp trên GitHub.');
    const doc = file.data;

    const entry = await quizAnalysis.analyze({
      quiz: doc.quizSnapshot, result: doc.result, answers: doc.answers,
      submission: sub, studentName: req.user.name,
      lesson, subject, userId: req.user._id, aiKeyId, model,
    });

    await githubService.updateJsonFile(sub.githubFile, (cur) => {
      cur.aiAnalyses = (Array.isArray(cur.aiAnalyses) ? cur.aiAnalyses : []).concat([entry]);
      return cur;
    }, 'Quiz AI analysis: ' + sub.githubFile);
    A.ghInvalidate(sub.githubFile);

    const upd = await Submission.findOneAndUpdate({ _id: sub._id },
      { $inc: { analysisCount: 1 }, $set: { lastAnalyzedAt: new Date() } }, { new: true });
    const count = upd.analysisCount;
    res.json({
      success: true, analysisCount: count, limitReached: count >= MAX_ANALYSES,
      analysis: Object.assign({}, entry, { aiLabel: A.formatAiLabel(entry.aiProvider || 'gemini', entry.aiKeyName) }),
    });
  } catch (e) {
    console.error('[quiz.analyze]', e);
    fail(res, e.status || 500, e.userMessage || 'Phân tích thất bại, thử lại sau.');
  } finally {
    analyzing.delete(id);
  }
};

// ============================================================
// Trang chi tiết (student) + review (admin)
// ============================================================
async function loadDetail(sub) {
  const [lesson, doc] = await Promise.all([Lesson.findById(sub.lessonId).lean(), A.ghRead(sub.githubFile)]);
  const subject = lesson ? await Subject.findById(lesson.subjectId).lean() : null;
  return { lesson, subject, doc: doc ? doc.data : null, sha: doc ? doc.sha : null };
}

exports.renderStudentDetail = async (req, res, next) => {
  try {
    const sub = await Submission.findOne({ _id: req.params.id, userId: req.user._id, type: 'quiz' }).lean();
    if (!sub) return res.status(404).render('error', { message: 'Không tìm thấy bài nộp.' });
    const d = await loadDetail(sub);
    if (!d.lesson || !d.doc) return res.status(404).render('error', { message: 'Chưa đọc được dữ liệu bài nộp.' });
    const keyIds = d.lesson.analysisAiKeyIds || [];
    const ais = keyIds.length ? await AIKey.find(Object.assign({ _id: { $in: keyIds } }, AI_KEY_USABLE)).lean() : [];
    res.render('student/quiz-submission-detail', {
      submission: sub, lesson: d.lesson, subject: d.subject, doc: d.doc, quizConfig,
      formatAiLabel: A.formatAiLabel,
      analysisAiOptions: ais.map((k) => ({ id: String(k._id), label: A.formatAiLabel(k.provider || 'gemini', k.name) })),
    });
  } catch (e) { next(e); }
};

exports.reviewPage = async (req, res, next) => {
  try {
    const sub = await Submission.findOne({ _id: req.params.id, type: 'quiz' }).lean();
    if (!sub) return res.status(404).render('error', { message: 'Không tìm thấy bài nộp.' });
    const d = await loadDetail(sub);
    if (!d.lesson || !A.adminCanAccess(req.user, d.lesson)) return res.status(404).render('error', { message: 'Không tìm thấy bài nộp.' });
    res.render('admin/quiz_submission_review', {
      submission: sub, lesson: d.lesson, subject: d.subject, doc: d.doc, formatAiLabel: A.formatAiLabel,
    });
  } catch (e) { next(e); }
};

exports.saveQuizTeacherComment = async (req, res) => {
  try {
    const content = String((req.body && req.body.content) || '').trim();
    if (!content) return fail(res, 400, 'Vui lòng nhập nội dung nhận xét');
    if (content.length > 3000) return fail(res, 400, 'Nhận xét tối đa 3000 ký tự.');

    const sub = await Submission.findOne({ _id: req.params.id, type: 'quiz' });
    if (!sub) return fail(res, 404, 'Không tìm thấy bài nộp.');
    const lesson = await Lesson.findById(sub.lessonId).lean();
    if (!lesson || !A.adminCanAccess(req.user, lesson)) return fail(res, 404, 'Không tìm thấy bài nộp.');

    const entry = { content, commentedBy: req.user._id, commentedByName: req.user.name || 'Giảng viên', commentedAt: new Date().toISOString() };
    const hadComment = !!sub.teacherComment;

    for (let attempt = 0; attempt < 3; attempt++) {
      const file = await A.ghRead(sub.githubFile);
      if (!file) return fail(res, 404, 'Không đọc được bài nộp trên GitHub.');
      const doc = file.data;
      if (doc.teacherComment) {
        doc.teacherCommentHistory = (doc.teacherCommentHistory || []).concat([{
          content: doc.teacherComment.content, commentedBy: doc.teacherComment.commentedBy, commentedAt: doc.teacherComment.commentedAt,
        }]);
      }
      doc.teacherComment = entry;
      try { await A.ghWrite(sub.githubFile, doc, file.sha); break; }
      catch (e) { if (e && e.status === 409 && attempt < 2) continue; throw e; }
    }

    sub.teacherComment = entry;
    await sub.save();
    try { await A.notifyTeacherComment(sub); } catch (e) { console.warn('[quiz] notify:', e.message); }
    await audit(req, hadComment ? 'edit_teacher_comment' : 'add_teacher_comment', 'Submission', sub._id, { length: content.length });
    res.json({ success: true });
  } catch (e) {
    console.error('[quiz.saveQuizTeacherComment]', e);
    fail(res, 500, 'Không lưu được nhận xét.');
  }
};

exports.toStudentView = toStudentView;
exports._internal = { buildQuiz, sanitizeAnswers, parseDuration, toNum };