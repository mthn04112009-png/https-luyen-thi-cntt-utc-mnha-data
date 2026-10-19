// ============================================================
// controllers/flashcard.controller.js — ỨNG DỤNG FLASHCARD
// ------------------------------------------------------------
//   GET  /apps                            Danh sách ứng dụng được cấp quyền (xem routes/apps.js)
//   GET  /flashcards                      2 nút: Dashboard (admin) + Môn học
//   GET  /flashcards/subjects             Chọn môn (giống /subjects)
//   GET  /flashcards/subjects/:id         Các bộ flashcard của môn (bố cục giống /subjects/:id)
//   GET  /flashcards/study/:fid           Học: thẻ học / luyện tập / kiểm tra
//   --- admin ---
//   GET  /flashcards/dashboard            Quản lý các bộ flashcard
//   GET  /flashcards/dashboard/new|:fid/edit    Form tạo / sửa
//   POST /flashcards/dashboard            Tạo      (JSON)
//   POST /flashcards/dashboard/:fid       Sửa      (JSON)
//   POST /flashcards/dashboard/parse      Kiểm tra nội dung nhập (JSON, để xem trước)
//   POST /flashcards/dashboard/:fid/publish | /delete
//
// LƯU TRỮ: GitHub  subjects/{slug-môn}/flashcards/{slug-flashcard}_{unix}.json  (GitHub là nguồn sự thật;
//          RAM chỉ giữ chỉ mục — models/Flashcard.js, services/githubStore.js KINDS.flashcards).
// QUYỀN  : giống Môn học — userKeyService.getContentScope(req):
//          admin default thấy tất cả; admin user_key chỉ thấy/sửa của tổ chức mình;
//          sinh viên chỉ thấy bộ thẻ (đã công khai) thuộc môn mà họ được phép xem.
// ============================================================
const mongoose = require('mongoose');

const Subject = require('../models/Subject');
const Flashcard = require('../models/Flashcard');
const githubService = require('../services/githubService');
const githubSync = require('../services/githubSyncService');
const parser = require('../services/flashcardParserService');
const cfg = require('../config/flashcardConfig');
const { getContentScope } = require('../services/userKeyService');
const { paginateArray } = require('./pagination.controller');
const { getSearchTerm, buildSearchClause, withSearch } = require('../utils/search');

// ------------------------------------------------------------
// Tiện ích
// ------------------------------------------------------------
const isAdmin = (req) => !!(req.user && req.user.role === 'admin');
const isObjectId = (v) => mongoose.Types.ObjectId.isValid(String(v || '')) && String(v).length === 24;

function slugify(s) {
    const out = String(s || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd').replace(/Đ/g, 'D')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
        .slice(0, 60).replace(/-+$/g, '');
    return out || 'flashcard';
}

// JSON nhúng vào <script type="application/json">: thoát "<" để không đóng thẻ script sớm
const safeJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function renderError(req, res, status, message) {
    return res.status(status).render('error', {
        title: status === 404 ? 'Không tìm thấy' : 'Lỗi',
        message,
        statusCode: status,
        stack: null,
        user: req.user
    });
}

function fail(res, status, message, extra) {
    return res.status(status).json(Object.assign({ success: false, message }, extra || {}));
}

const SUBJECT_ALIVE = { deletedAt: null, deletedForever: { $ne: true } };

/** Môn học (theo _id hoặc slug) mà người dùng được xem. Sinh viên chỉ thấy môn đã công khai. */
async function findSubject(req, scope, param) {
    const cond = isObjectId(param) ? { _id: param } : { slug: String(param || '').toLowerCase() };
    const subject = await Subject.findOne({
        ...cond,
        ...SUBJECT_ALIVE,
        ...(isAdmin(req) ? {} : { isPublished: true }),
        ...scope.filter
    });
    return subject && scope.canAccess(subject) ? subject : null;
}

/** Điều kiện lọc bộ thẻ: còn tồn tại, trong phạm vi quyền; sinh viên chỉ thấy bộ đã công khai. */
function flashcardFilter(req, scope, extra) {
    return {
        isDeleted: { $ne: true },
        ...(isAdmin(req) ? {} : { isPublished: true }),
        ...scope.filter,
        ...(extra || {})
    };
}

async function visibleSubjectIds(req, scope) {
    const subjects = await Subject.find({
        ...SUBJECT_ALIVE,
        ...(isAdmin(req) ? {} : { isPublished: true }),
        ...scope.filter
    }).select('_id').lean();
    return subjects.map((s) => s._id);
}

/** Số bộ thẻ nhìn thấy được theo từng môn: { subjectId: n } */
async function countBySubject(req, scope, subjectIds) {
    if (!subjectIds.length) return {};
    const list = await Flashcard.find(flashcardFilter(req, scope, { subjectId: { $in: subjectIds } })).select('subjectId').lean();
    const out = {};
    for (const f of list) {
        const k = String(f.subjectId);
        out[k] = (out[k] || 0) + 1;
    }
    return out;
}

/**
 * Người dùng có "ứng dụng Flashcard" không?
 *   - admin                      : luôn có
 *   - student đã được duyệt      : luôn có (quyền theo VAI TRÒ, không phụ thuộc đã có bộ thẻ hay chưa
 *                                  và không phụ thuộc GitHub đồng bộ được hay không → localhost / Vercel đều giống nhau)
 *   - client / chờ duyệt / khác  : không có (route đã chặn và chuyển sang trang chờ duyệt)
 * Danh sách môn / bộ thẻ bên trong ứng dụng vẫn lọc theo user_key như cũ.
 */
async function canUseFlashcards(req) {
    const u = req.user;
    if (!u) return false;
    if (u.role === 'admin') return true;
    return u.role === 'student' && u.status === 'approved';
}

function pickCards(data) {
    const arr = data && Array.isArray(data.cards) ? data.cards : [];
    const s = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
    return arr.slice(0, cfg.LIMITS.MAX_CARDS).map((c, i) => ({
        id: s(c && c.id, 20) || 'c' + (i + 1),
        front: s(c && c.front, cfg.LIMITS.MAX_FRONT_LEN),
        back: s(c && c.back, cfg.LIMITS.MAX_BACK_LEN),
        ipa: s(c && c.ipa, cfg.LIMITS.MAX_IPA_LEN),
        image: parser.isImageUrl(s(c && c.image, 500)) ? c.image : ''
    })).filter((c) => c.front && c.back);
}

// ============================================================
// /apps
// ============================================================
exports.getApps = async (req, res) => {
    try {
        const apps = [];
        if (await canUseFlashcards(req)) {
            apps.push({
                id: 'flashcards',
                name: 'Flashcards',
                description: 'Học thuộc từ vựng ngoại ngữ (có nghe – đọc) và lý thuyết bằng thẻ ghi nhớ, luyện tập và kiểm tra.',
                href: '/flashcards',
                icon: 'layers'
            });
            // Slide học tập: cùng điều kiện quyền với Flashcards (admin / student đã duyệt)
            apps.push({
                id: 'slides',
                name: 'Slide học tập',
                description: 'Xem và tải xuống slide (PDF) theo từng môn học. File được mã hoá khi lưu trữ.',
                href: '/slides',
                icon: 'presentation'
            });
        }
        return res.render('apps', { title: 'Ứng dụng', user: req.user, apps });
    } catch (e) {
        console.error('[apps]', e);
        return renderError(req, res, 500, 'Không tải được danh sách ứng dụng.');
    }
};

// ============================================================
// /flashcards  (hub)
// ============================================================
exports.getHub = async (req, res) => {
    try {
        if (!(await canUseFlashcards(req))) {
            return res.status(403).render('apps', { title: 'Ứng dụng', user: req.user, apps: [], denied: 'Flashcards' });
        }
        return res.render('flashcards/hub', { title: 'Flashcards', user: req.user, admin: isAdmin(req) });
    } catch (e) {
        console.error('[flashcards.hub]', e);
        return renderError(req, res, 500, 'Không tải được trang Flashcards.');
    }
};

// ============================================================
// /flashcards/subjects
// ============================================================
exports.getSubjects = async (req, res) => {
    try {
        if (!(await canUseFlashcards(req))) return res.status(403).render('apps', { title: 'Ứng dụng', user: req.user, apps: [], denied: 'Flashcards' });
        await githubSync.syncKinds(['flashcards']);
        const scope = await getContentScope(req);

        const q = getSearchTerm(req);
        const searchClause = buildSearchClause(q, ['name', 'code', 'description']);
        // ★ Giống hệt trang Môn học (/subjects): hiện MỌI môn đã công khai trong phạm vi quyền,
        //   dù môn đó chưa có bộ flashcard nào (số bộ thẻ hiện ở từng ô môn học).
        const subjects = await Subject.find(withSearch({
            ...SUBJECT_ALIVE,
            isPublished: true,
            ...scope.filter
        }, searchClause)).sort({ createdAt: -1, _id: -1 }).lean();

        const counts = await countBySubject(req, scope, subjects.map((s) => s._id));
        const rows = subjects.map((s) => Object.assign({}, s, { flashcardCount: counts[String(s._id)] || 0 }));

        const { items, pagination } = paginateArray(rows, req, { limit: 9 });
        return res.render('flashcards/subjects', {
            title: 'Flashcards · Môn học',
            user: req.user,
            subjects: items,
            filters: { q },
            ...pagination
        });
    } catch (e) {
        console.error('[flashcards.subjects]', e);
        return renderError(req, res, 500, 'Không tải được danh sách môn học.');
    }
};

// ============================================================
// /flashcards/subjects/:id
// ============================================================
exports.getSubject = async (req, res) => {
    try {
        await githubSync.syncKinds(['flashcards']);
        const scope = await getContentScope(req);
        const subject = await findSubject(req, scope, req.params.id);
        if (!subject) return renderError(req, res, 404, 'Không tìm thấy môn học.');

        const q = getSearchTerm(req);
        const searchClause = buildSearchClause(q, ['title', 'description']);
        const rows = await Flashcard.find(withSearch(flashcardFilter(req, scope, { subjectId: subject._id }), searchClause))
            .sort({ createdAt: -1, _id: -1 }).lean();
        const { items, pagination } = paginateArray(rows, req, { limit: 10 });

        return res.render('flashcards/subject', {
            title: `Flashcards · ${subject.name}`,
            user: req.user,
            subject,
            flashcards: items,
            filters: { q },
            modeLabel: cfg.MODE_LABEL,
            languageName: cfg.languageName,
            ...pagination
        });
    } catch (e) {
        console.error('[flashcards.subject]', e);
        return renderError(req, res, 500, 'Không tải được môn học.');
    }
};

// ============================================================
// /flashcards/study/:fid
// ============================================================
exports.study = async (req, res) => {
    try {
        await githubSync.syncKinds(['flashcards']);
        const scope = await getContentScope(req);
        const rec = isObjectId(req.params.fid) ? await Flashcard.findById(req.params.fid) : null;
        if (!rec || rec.isDeleted || (!isAdmin(req) && !rec.isPublished) || !scope.canAccess(rec)) {
            return renderError(req, res, 404, 'Không tìm thấy bộ flashcard.');
        }
        const subject = await findSubject(req, scope, String(rec.subjectId));
        if (!subject) return renderError(req, res, 404, 'Không tìm thấy môn học của bộ flashcard.');

        const data = await githubService.readJsonFile(rec.githubFile);
        if (!data) return renderError(req, res, 404, 'Không đọc được nội dung bộ flashcard trên GitHub.');
        const cards = pickCards(data);
        if (!cards.length) return renderError(req, res, 404, 'Bộ flashcard này chưa có thẻ nào.');

        const siblings = await Flashcard.find(flashcardFilter(req, scope, { subjectId: subject._id }))
            .sort({ createdAt: -1, _id: -1 }).select('title cardCount mode').lean();

        const payload = {
            id: String(rec._id),
            title: rec.title,
            description: rec.description || '',
            mode: rec.mode === 'theory' ? 'theory' : 'language',
            language: rec.language || cfg.DEFAULT_LANGUAGE,
            languageLabel: cfg.languageName(rec.language),
            subject: { id: String(subject._id), name: subject.name },
            cards,
            siblings: siblings.map((s) => ({ id: String(s._id), title: s.title, count: s.cardCount || 0, mode: s.mode }))
        };

        return res.render('flashcards/study', {
            title: `${rec.title} · Flashcards`,
            user: req.user,
            fc: payload,
            fcJson: safeJson(payload)
        });
    } catch (e) {
        console.error('[flashcards.study]', e);
        return renderError(req, res, 500, 'Không tải được bộ flashcard.');
    }
};

// ============================================================
// DASHBOARD (admin)
// ============================================================
async function adminSubjects(scope) {
    return Subject.find({ ...SUBJECT_ALIVE, ...scope.filter }).sort({ createdAt: -1, _id: -1 }).select('name code slug userKey').lean();
}

exports.dashboard = async (req, res) => {
    try {
        await githubSync.syncKinds(['flashcards']);
        const scope = await getContentScope(req);
        const subjects = await adminSubjects(scope);
        const nameById = {};
        subjects.forEach((s) => { nameById[String(s._id)] = s; });

        const q = getSearchTerm(req);
        const subjectId = isObjectId(req.query.subject) ? String(req.query.subject) : '';
        const searchClause = buildSearchClause(q, ['title', 'description']);
        const rows = await Flashcard.find(withSearch({
            isDeleted: { $ne: true },
            ...scope.filter,
            ...(subjectId ? { subjectId } : {})
        }, searchClause)).sort({ createdAt: -1, _id: -1 }).lean();

        const items = rows.map((f) => Object.assign({}, f, { subject: nameById[String(f.subjectId)] || null }));
        const { items: pageItems, pagination } = paginateArray(items, req, { limit: 10 });

        return res.render('flashcards/dashboard', {
            title: 'Flashcards · Dashboard',
            user: req.user,
            flashcards: pageItems,
            subjects,
            filters: { q, subject: subjectId },
            modeLabel: cfg.MODE_LABEL,
            languageName: cfg.languageName,
            ...pagination
        });
    } catch (e) {
        console.error('[flashcards.dashboard]', e);
        return renderError(req, res, 500, 'Không tải được dashboard flashcard.');
    }
};

async function renderForm(req, res, { rec, data }) {
    const scope = await getContentScope(req);
    const subjects = await adminSubjects(scope);
    const mode = rec ? (rec.mode === 'theory' ? 'theory' : 'language') : 'language';
    const language = rec ? (rec.language || cfg.DEFAULT_LANGUAGE) : cfg.DEFAULT_LANGUAGE;
    const content = rec ? parser.serialize(pickCards(data), mode) : '';

    const state = {
        id: rec ? String(rec._id) : null,
        subjectId: rec ? String(rec.subjectId) : (isObjectId(req.query.subject) ? String(req.query.subject) : ''),
        title: rec ? rec.title : '',
        description: rec ? rec.description || '' : '',
        mode,
        language,
        isPublished: rec ? rec.isPublished !== false : true,
        content,
        sha: rec ? (await githubService.readJsonFileWithSha(rec.githubFile).catch(() => null) || {}).sha || null : null,
        prompts: { language: cfg.PROMPT_LANGUAGE, theory: cfg.PROMPT_THEORY },
        languages: cfg.LANGUAGES
    };
    return res.render('flashcards/form', {
        title: rec ? 'Sửa flashcard' : 'Tạo flashcard',
        user: req.user,
        editing: !!rec,
        subjects,
        languages: cfg.LANGUAGES,
        modeLabel: cfg.MODE_LABEL,
        modeHint: cfg.MODE_HINT,
        fcState: state,
        fcStateJson: safeJson(state)
    });
}

exports.newForm = async (req, res) => {
    try {
        return await renderForm(req, res, { rec: null, data: null });
    } catch (e) {
        console.error('[flashcards.newForm]', e);
        return renderError(req, res, 500, 'Không mở được form tạo flashcard.');
    }
};

exports.editForm = async (req, res) => {
    try {
        await githubSync.syncKinds(['flashcards']);
        const scope = await getContentScope(req);
        const rec = isObjectId(req.params.fid) ? await Flashcard.findById(req.params.fid) : null;
        if (!rec || rec.isDeleted || !scope.canAccess(rec)) return renderError(req, res, 404, 'Không tìm thấy bộ flashcard.');
        const data = await githubService.readJsonFile(rec.githubFile);
        if (!data) return renderError(req, res, 404, 'Không đọc được nội dung bộ flashcard trên GitHub.');
        return await renderForm(req, res, { rec, data });
    } catch (e) {
        console.error('[flashcards.editForm]', e);
        return renderError(req, res, 500, 'Không mở được form sửa flashcard.');
    }
};

/** Đọc + kiểm tra dữ liệu form (dùng chung cho tạo / sửa) */
function readForm(body) {
    const b = body || {};
    const title = String(b.title || '').trim();
    const description = String(b.description || '').trim();
    const mode = b.mode === 'theory' ? 'theory' : 'language';
    const language = cfg.LANGUAGE_CODES.includes(b.language) ? b.language : cfg.DEFAULT_LANGUAGE;
    const isPublished = !(b.isPublished === false || b.isPublished === 'false' || b.isPublished === 0 || b.isPublished === '0');

    if (!title) return { error: 'Vui lòng nhập tiêu đề bộ flashcard.' };
    if (title.length > cfg.LIMITS.MAX_TITLE_LEN) return { error: `Tiêu đề tối đa ${cfg.LIMITS.MAX_TITLE_LEN} ký tự.` };
    if (description.length > cfg.LIMITS.MAX_DESC_LEN) return { error: `Mô tả tối đa ${cfg.LIMITS.MAX_DESC_LEN} ký tự.` };

    const parsed = parser.parse(b.content, mode);
    if (parsed.errors.length) return { errors: parsed.errors };
    return { title, description, mode, language, isPublished, cards: parsed.cards };
}

exports.parsePreview = async (req, res) => {
    const mode = req.body && req.body.mode === 'theory' ? 'theory' : 'language';
    const r = parser.parse(req.body && req.body.content, mode);
    return res.json({ success: true, cards: r.cards.slice(0, 200), total: r.cards.length, errors: r.errors, imageHints: r.imageHints });
};

exports.create = async (req, res) => {
    try {
        const scope = await getContentScope(req);
        const subject = isObjectId(req.body && req.body.subjectId)
            ? await Subject.findOne({ _id: req.body.subjectId, ...SUBJECT_ALIVE, ...scope.filter })
            : null;
        if (!subject || !scope.canAccess(subject)) return fail(res, 404, 'Vui lòng chọn môn học hợp lệ.');

        const f = readForm(req.body);
        if (f.error) return fail(res, 400, f.error);
        if (f.errors) return fail(res, 400, 'Nội dung flashcard chưa hợp lệ.', { errors: f.errors });
        if (!githubService.isConfigured) return fail(res, 503, 'GitHub chưa cấu hình nên chưa lưu được flashcard.');

        await githubSync.syncKinds(['flashcards']);
        let slug = slugify(f.title);
        if (await Flashcard.exists({ subjectId: subject._id, slug })) slug += '-' + Date.now().toString(36);
        // <slug>_<unix>.json  (thêm timestamp giây ở đuôi để không trùng tên file)
        const githubFile = `subjects/${subject.slug}/flashcards/${slug}_${Math.floor(Date.now() / 1000)}.json`;
        if (await githubService.fileExists(githubFile)) return fail(res, 409, 'Đã có file trùng đường dẫn trên GitHub, hãy thử lại.');

        const id = new mongoose.Types.ObjectId();
        const nowIso = new Date().toISOString();
        const written = await githubService.writeJsonFile(githubFile, {
            type: 'flashcard',
            flashcardId: String(id),
            title: f.title, slug, subjectSlug: subject.slug, description: f.description,
            mode: f.mode, language: f.language, cardCount: f.cards.length, order: 0,
            isPublished: f.isPublished, isDeleted: false, deletedAt: null, deletedBy: null,
            createdBy: String(req.user._id), updatedBy: String(req.user._id),
            createdAt: nowIso, updatedAt: nowIso,
            cards: f.cards
        }, `Flashcard: tạo "${f.title}"`);

        const rec = await Flashcard.create({
            _id: id, githubSha: written && written.sha ? written.sha : null,
            subjectId: subject._id, title: f.title, slug, description: f.description, githubFile,
            mode: f.mode, language: f.language, cardCount: f.cards.length,
            isPublished: f.isPublished, userKey: subject.userKey || null,
            createdBy: req.user._id, updatedBy: req.user._id
        });
        return res.json({ success: true, id: String(rec._id), redirect: '/flashcards/dashboard' });
    } catch (e) {
        console.error('[flashcards.create]', e);
        return fail(res, 500, 'Lỗi máy chủ khi tạo flashcard.');
    }
};

exports.update = async (req, res) => {
    try {
        await githubSync.syncKinds(['flashcards']);
        const scope = await getContentScope(req);
        const rec = isObjectId(req.params.fid) ? await Flashcard.findById(req.params.fid) : null;
        if (!rec || rec.isDeleted || !scope.canAccess(rec)) return fail(res, 404, 'Không tìm thấy bộ flashcard.');

        const f = readForm(req.body);
        if (f.error) return fail(res, 400, f.error);
        if (f.errors) return fail(res, 400, 'Nội dung flashcard chưa hợp lệ.', { errors: f.errors });

        const file = await githubService.readJsonFileWithSha(rec.githubFile);
        if (!file) return fail(res, 404, 'Không đọc được bộ flashcard trên GitHub.');
        if (req.body.sha && req.body.sha !== file.sha) return fail(res, 409, 'Bộ flashcard đã bị người khác sửa. Hãy tải lại trang.');

        const subject = await Subject.findById(rec.subjectId).select('slug').lean();
        const nowIso = new Date().toISOString();
        const written = await githubService.writeJsonFileIfSha(rec.githubFile, Object.assign({}, file.data, {
            type: 'flashcard',
            title: f.title, description: f.description,
            mode: f.mode, language: f.language, cardCount: f.cards.length,
            isPublished: f.isPublished, subjectSlug: subject ? subject.slug : (file.data || {}).subjectSlug,
            updatedBy: String(req.user._id), updatedAt: nowIso,
            cards: f.cards
        }), file.sha, `Flashcard: sửa "${f.title}"`);

        rec.title = f.title;
        rec.description = f.description;
        rec.mode = f.mode;
        rec.language = f.language;
        rec.cardCount = f.cards.length;
        rec.isPublished = f.isPublished;
        rec.updatedBy = req.user._id;
        rec.githubSha = written && written.sha ? written.sha : rec.githubSha;
        await rec.save();
        return res.json({ success: true, id: String(rec._id), redirect: '/flashcards/dashboard' });
    } catch (e) {
        if (e && e.code === 'SHA_CONFLICT') return fail(res, 409, 'Bộ flashcard đã bị người khác sửa. Hãy tải lại trang.');
        console.error('[flashcards.update]', e);
        return fail(res, 500, 'Lỗi máy chủ khi lưu flashcard.');
    }
};

exports.togglePublish = async (req, res) => {
    try {
        await githubSync.syncKinds(['flashcards']);
        const scope = await getContentScope(req);
        const rec = isObjectId(req.params.fid) ? await Flashcard.findById(req.params.fid) : null;
        if (!rec || rec.isDeleted || !scope.canAccess(rec)) return fail(res, 404, 'Không tìm thấy bộ flashcard.');
        rec.isPublished = !rec.isPublished;
        rec.updatedBy = req.user._id;
        await rec.save();     // githubStore tự ghi lại file JSON (isPublished, updatedBy)
        return res.json({ success: true, isPublished: rec.isPublished });
    } catch (e) {
        console.error('[flashcards.togglePublish]', e);
        return fail(res, 500, 'Không đổi được trạng thái công khai.');
    }
};

exports.remove = async (req, res) => {
    try {
        await githubSync.syncKinds(['flashcards']);
        const scope = await getContentScope(req);
        const rec = isObjectId(req.params.fid) ? await Flashcard.findById(req.params.fid) : null;
        if (!rec || rec.isDeleted || !scope.canAccess(rec)) return fail(res, 404, 'Không tìm thấy bộ flashcard.');
        await githubService.deleteFile(rec.githubFile, `Flashcard: xoá "${rec.title}"`);
        await Flashcard.deleteOne({ _id: rec._id });
        return res.json({ success: true });
    } catch (e) {
        console.error('[flashcards.remove]', e);
        return fail(res, 500, 'Không xoá được bộ flashcard.');
    }
};

// các hàm dùng cho test
exports._test = { slugify, pickCards, readForm };
