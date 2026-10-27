// ============================================================
// controllers/video.controller.js — VIDEO BÀI GIẢNG (/videos)
// ------------------------------------------------------------
//   GET  /videos                          2 nút: Dashboard (admin) + Môn học          (view dùng chung studyfiles/hub)
//   GET  /videos/subjects[/:id]           Chọn môn → danh sách bài video của môn
//   GET  /videos/study/:vid               Xem bài: các video xếp dọc, tự co giãn theo khung
//   --- admin ---
//   GET  /videos/dashboard, /dashboard/new, /dashboard/:vid/edit
//   POST /videos/dashboard                tạo mới   { subjectId, title, description, isPublished, videos:[{id?,title,code}] }
//   POST /videos/dashboard/:vid           sửa
//   POST /videos/dashboard/:vid/publish | /delete
//
// LƯU TRỮ: CHỈ GitHub, repo CHÍNH (KHÔNG MongoDB, không có file nhị phân):
//   subjects/<slug-môn>/videos/<slug>_<unix>.json
//   Mã nhúng <iframe> của từng video được MÃ HOÁ 2 CHIỀU (AES-256-GCM — services/videoCryptoService.js)
//   → mở JSON trên GitHub không thấy link video. Server chỉ giải mã khi người có quyền mở trang xem.
// AN TOÀN: mã nhúng dán vào được KIỂM TRA (services/videoEmbedService.js): đúng 1 thẻ iframe, https, nguồn video cho phép;
//   web tự dựng lại thẻ iframe, không in nguyên văn HTML của admin.
// QUYỀN: userKeyService.getContentScope(req) (giống Slide / Tài liệu / Flashcards).
// ============================================================
const crypto = require('crypto');
const mongoose = require('mongoose');

const Subject = require('../models/Subject');
const Video = require('../models/Video');
const githubService = require('../services/githubService');
const githubSync = require('../services/githubSyncService');
const videoCrypto = require('../services/videoCryptoService');
const { parseEmbed } = require('../services/videoEmbedService');
const cfg = require('../config/videoConfig');
const { getContentScope } = require('../services/userKeyService');
const { paginateArray } = require('./pagination.controller');
const { getSearchTerm, buildSearchClause, withSearch } = require('../utils/search');

const app = cfg.APP;
const L = cfg.LIMITS;
const SUBJECT_ALIVE = { deletedAt: null, deletedForever: { $ne: true } };

// ------------------------------------------------------------
// Tiện ích thuần
// ------------------------------------------------------------
const isAdmin = (req) => !!(req.user && req.user.role === 'admin');
const isObjectId = (v) => mongoose.Types.ObjectId.isValid(String(v || '')) && String(v).length === 24;
// JSON nhúng vào <script type="application/json">: thoát "<" để mã nhúng (<iframe…) không đóng thẻ script sớm
const safeJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const ITEM_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function slugify(s) {
    const out = String(s || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd').replace(/Đ/g, 'D')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
        .slice(0, 60).replace(/-+$/g, '');
    return out || 'video';
}

/** Đọc + kiểm tra phần thông tin của form (tiêu đề, mô tả, công khai). */
function readForm(body) {
    const b = body || {};
    const title = String(b.title || '').trim();
    const description = String(b.description || '').trim();
    const isPublished = !(b.isPublished === false || b.isPublished === 'false' || b.isPublished === 0 || b.isPublished === '0');
    if (!title) return { error: 'Vui lòng nhập tiêu đề.' };
    if (title.length > L.MAX_TITLE_LEN) return { error: `Tiêu đề tối đa ${L.MAX_TITLE_LEN} ký tự.` };
    if (description.length > L.MAX_DESC_LEN) return { error: `Mô tả tối đa ${L.MAX_DESC_LEN} ký tự.` };
    return { title, description, isPublished };
}

/** Giải mã 1 video đã lưu → { code } | { error } (không bao giờ ném lỗi). */
function openItem(item) {
    try { return { code: videoCrypto.decryptText(item.enc) }; }
    catch (e) { return { error: e.message }; }
}

/**
 * Kiểm tra danh sách video gửi lên từ form và MÃ HOÁ từng mã nhúng.
 *   existing: các video đã lưu của bài (khi sửa) — video không đổi mã nhúng thì GIỮ NGUYÊN chuỗi mã hoá cũ
 *             (mã hoá lại mỗi lần sẽ tạo chuỗi khác → commit GitHub thừa).
 * Trả { videos:[{id,title,enc}] } | { error }
 */
function buildVideos(list, existing) {
    if (!Array.isArray(list) || !list.length) return { error: 'Cần ít nhất 1 video (dán mã nhúng <iframe>).' };
    if (list.length > L.MAX_VIDEOS) return { error: `Mỗi bài tối đa ${L.MAX_VIDEOS} video.` };
    const old = new Map((existing || []).map((v) => [v.id, v]));
    const used = new Set();
    const out = [];
    for (let i = 0; i < list.length; i++) {
        const x = list[i] || {};
        const n = i + 1;
        const code = typeof x.code === 'string' ? x.code.trim() : '';
        const p = parseEmbed(code);
        if (!p.ok) return { error: `Video ${n}: ${p.error}` };
        const title = String(x.title || '').trim();
        if (title.length > L.MAX_VIDEO_TITLE_LEN) return { error: `Video ${n}: tiêu đề tối đa ${L.MAX_VIDEO_TITLE_LEN} ký tự.` };

        let id = typeof x.id === 'string' && ITEM_ID_RE.test(x.id) && !used.has(x.id) ? x.id : null;
        if (!id) { do { id = 'v' + crypto.randomBytes(4).toString('hex'); } while (used.has(id)); }
        used.add(id);

        let enc = null;
        const prev = old.get(id);
        if (prev) { const o = openItem(prev); if (o.code !== undefined && o.code.trim() === code) enc = prev.enc; }
        if (!enc) enc = videoCrypto.encryptText(code);
        if (enc.length > L.MAX_ENC_LEN) return { error: `Video ${n}: mã nhúng quá dài.` };
        out.push({ id, title, enc });
    }
    return { videos: out };
}

// ------------------------------------------------------------
// Quyền / truy vấn dùng chung
// ------------------------------------------------------------
const fail = (res, status, message, extra) => res.status(status).json(Object.assign({ success: false, message }, extra || {}));

function renderError(req, res, status, message) {
    return res.status(status).render('error', {
        title: status === 404 ? 'Không tìm thấy' : 'Lỗi', message, statusCode: status, stack: null, user: req.user
    });
}

async function canUse(req) {
    const u = req.user;
    if (!u) return false;
    if (u.role === 'admin') return true;
    return u.role === 'student' && u.status === 'approved';
}
const denied = (req, res) => res.status(403).render('apps', { title: 'Ứng dụng', user: req.user, apps: [], denied: app.name });

/** Môn học (theo _id hoặc slug) mà người dùng được xem. Sinh viên chỉ thấy môn đã công khai. */
async function findSubject(req, scope, param) {
    const cond = isObjectId(param) ? { _id: param } : { slug: String(param || '').toLowerCase() };
    const subject = await Subject.findOne({
        ...cond, ...SUBJECT_ALIVE, ...(isAdmin(req) ? {} : { isPublished: true }), ...scope.filter
    });
    return subject && scope.canAccess(subject) ? subject : null;
}

const itemFilter = (req, scope, extra) => ({
    isDeleted: { $ne: true }, ...(isAdmin(req) ? {} : { isPublished: true }), ...scope.filter, ...(extra || {})
});

async function countBySubject(req, scope, subjectIds) {
    if (!subjectIds.length) return {};
    const list = await Video.find(itemFilter(req, scope, { subjectId: { $in: subjectIds } })).select('subjectId').lean();
    const out = {};
    for (const s of list) { const k = String(s.subjectId); out[k] = (out[k] || 0) + 1; }
    return out;
}

async function loadVisible(req, scope, vid) {
    const rec = isObjectId(vid) ? await Video.findById(vid) : null;
    if (!rec || rec.isDeleted || (!isAdmin(req) && !rec.isPublished) || !scope.canAccess(rec)) return null;
    const subject = await findSubject(req, scope, String(rec.subjectId));
    return subject ? { rec, subject } : null;
}

const adminSubjects = (scope) => Subject.find({ ...SUBJECT_ALIVE, ...scope.filter })
    .sort({ createdAt: -1, _id: -1 }).select('name code slug userKey').lean();

const ctrl = {};

// ============================================================
// HUB / MÔN HỌC / DANH SÁCH
// ============================================================
ctrl.getHub = async (req, res) => {
    try {
        if (!(await canUse(req))) return denied(req, res);
        return res.render('studyfiles/hub', { title: app.name, user: req.user, admin: isAdmin(req), app });
    } catch (e) {
        console.error('[videos.hub]', e);
        return renderError(req, res, 500, `Không tải được trang ${app.name}.`);
    }
};

ctrl.getSubjects = async (req, res) => {
    try {
        if (!(await canUse(req))) return denied(req, res);
        await githubSync.syncKinds([app.key]);
        const scope = await getContentScope(req);
        const q = getSearchTerm(req);
        const searchClause = buildSearchClause(q, ['name', 'code', 'description']);
        const subjects = await Subject.find(withSearch({ ...SUBJECT_ALIVE, isPublished: true, ...scope.filter }, searchClause))
            .sort({ createdAt: -1, _id: -1 }).lean();
        const counts = await countBySubject(req, scope, subjects.map((s) => s._id));
        const rows = subjects.map((s) => Object.assign({}, s, { itemCount: counts[String(s._id)] || 0 }));
        const { items, pagination } = paginateArray(rows, req, { limit: 9 });
        return res.render('studyfiles/subjects', {
            title: `${app.name} · Môn học`, user: req.user, app, subjects: items, filters: { q }, ...pagination
        });
    } catch (e) {
        console.error('[videos.subjects]', e);
        return renderError(req, res, 500, 'Không tải được danh sách môn học.');
    }
};

ctrl.getSubject = async (req, res) => {
    try {
        if (!(await canUse(req))) return denied(req, res);
        await githubSync.syncKinds([app.key]);
        const scope = await getContentScope(req);
        const subject = await findSubject(req, scope, req.params.id);
        if (!subject) return renderError(req, res, 404, 'Không tìm thấy môn học.');
        const q = getSearchTerm(req);
        const searchClause = buildSearchClause(q, ['title', 'description']);
        const rows = await Video.find(withSearch(itemFilter(req, scope, { subjectId: subject._id }), searchClause))
            .sort({ createdAt: -1, _id: -1 }).lean();
        const { items, pagination } = paginateArray(rows, req, { limit: 10 });
        return res.render('videos/subject', {
            title: `${app.name} · ${subject.name}`, user: req.user, app, subject, items, filters: { q }, ...pagination
        });
    } catch (e) {
        console.error('[videos.subject]', e);
        return renderError(req, res, 500, 'Không tải được môn học.');
    }
};

// ============================================================
// XEM
// ============================================================
ctrl.study = async (req, res) => {
    try {
        if (!(await canUse(req))) return denied(req, res);
        await githubSync.syncKinds([app.key]);
        const scope = await getContentScope(req);
        const found = await loadVisible(req, scope, req.params.vid);
        if (!found) return renderError(req, res, 404, `Không tìm thấy ${app.noun}.`);
        const { rec, subject } = found;
        if (!rec.videos || !rec.videos.length) return renderError(req, res, 404, `${app.name} này chưa có video.`);

        // Giải mã từng video → kiểm tra lại → chỉ đưa { src, tiêu đề, tỉ lệ } cho trang (KHÔNG đưa HTML gốc)
        const videos = rec.videos.map((it, i) => {
            const base = { n: i + 1, id: it.id, title: it.title || '' };
            const o = openItem(it);
            if (o.error) {
                return Object.assign(base, {
                    error: videoCrypto.isConfigured()
                        ? 'Không giải mã được video này (kiểm tra ENCRYPTION_MASTER_KEY có giống nơi đã lưu không).'
                        : 'Chưa cấu hình ENCRYPTION_MASTER_KEY nên chưa giải mã được video.'
                });
            }
            const p = parseEmbed(o.code);
            if (!p.ok) return Object.assign(base, { error: 'Mã nhúng của video này không hợp lệ.' });
            return Object.assign(base, { src: p.src, ratio: p.ratio, frameTitle: it.title || p.title || `Video ${i + 1}` });
        });

        const siblings = await Video.find(itemFilter(req, scope, { subjectId: subject._id }))
            .sort({ createdAt: -1, _id: -1 }).select('title').lean();
        const vd = {
            id: String(rec._id), title: rec.title, description: rec.description || '',
            subject: { id: String(subject._id), name: subject.name },
            siblings: siblings.map((s) => ({ id: String(s._id), title: s.title })),
            videos, iframeAllow: cfg.IFRAME_ALLOW, iframeReferrer: cfg.IFRAME_REFERRER
        };
        res.set({ 'Cache-Control': 'private, no-store' });
        return res.render('videos/study', { title: `${rec.title} · ${app.name}`, user: req.user, app, vd });
    } catch (e) {
        console.error('[videos.study]', e);
        return renderError(req, res, 500, `Không tải được ${app.noun}.`);
    }
};

// ============================================================
// DASHBOARD (admin)
// ============================================================
ctrl.dashboard = async (req, res) => {
    try {
        await githubSync.syncKinds([app.key]);
        const scope = await getContentScope(req);
        const subjects = await adminSubjects(scope);
        const nameById = {};
        subjects.forEach((s) => { nameById[String(s._id)] = s; });

        const q = getSearchTerm(req);
        const subjectId = isObjectId(req.query.subject) ? String(req.query.subject) : '';
        const searchClause = buildSearchClause(q, ['title', 'description']);
        const rows = await Video.find(withSearch({
            isDeleted: { $ne: true }, ...scope.filter, ...(subjectId ? { subjectId } : {})
        }, searchClause)).sort({ createdAt: -1, _id: -1 }).lean();
        const items = rows.map((f) => Object.assign({}, f, { subject: nameById[String(f.subjectId)] || null }));
        const { items: pageItems, pagination } = paginateArray(items, req, { limit: 10 });
        return res.render('videos/dashboard', {
            title: `${app.name} · Dashboard`, user: req.user, app, items: pageItems, subjects,
            filters: { q, subject: subjectId }, ...pagination
        });
    } catch (e) {
        console.error('[videos.dashboard]', e);
        return renderError(req, res, 500, 'Không tải được dashboard.');
    }
};

async function renderForm(req, res, rec) {
    const scope = await getContentScope(req);
    const subjects = await adminSubjects(scope);
    // Khi sửa: giải mã để admin thấy lại mã nhúng đã dán (chỉ admin mở được form này)
    const videos = rec ? (rec.videos || []).map((it) => {
        const o = openItem(it);
        return { id: it.id, title: it.title || '', code: o.code || '', broken: o.error ? true : false };
    }) : [{ id: '', title: '', code: '', broken: false }];
    const state = {
        id: rec ? String(rec._id) : null,
        base: app.base, noun: app.noun,
        subjectId: rec ? String(rec.subjectId) : (isObjectId(req.query.subject) ? String(req.query.subject) : ''),
        title: rec ? rec.title : '', description: rec ? rec.description || '' : '',
        isPublished: rec ? rec.isPublished !== false : true,
        videos, maxVideos: L.MAX_VIDEOS, maxEmbed: L.MAX_EMBED_LEN,
        encryptionReady: videoCrypto.isConfigured(),
        sha: rec ? ((await githubService.readJsonFileWithSha(rec.githubFile).catch(() => null)) || {}).sha || null : null
    };
    return res.render('videos/form', {
        title: rec ? `Sửa ${app.noun}` : `Thêm ${app.noun}`, user: req.user, app, editing: !!rec, subjects,
        vfStateJson: safeJson(state)
    });
}

ctrl.newForm = async (req, res) => {
    try { return await renderForm(req, res, null); }
    catch (e) { console.error('[videos.newForm]', e); return renderError(req, res, 500, 'Không mở được form.'); }
};

ctrl.editForm = async (req, res) => {
    try {
        await githubSync.syncKinds([app.key]);
        const scope = await getContentScope(req);
        const rec = isObjectId(req.params.vid) ? await Video.findById(req.params.vid) : null;
        if (!rec || rec.isDeleted || !scope.canAccess(rec)) return renderError(req, res, 404, `Không tìm thấy ${app.noun}.`);
        return await renderForm(req, res, rec);
    } catch (e) {
        console.error('[videos.editForm]', e);
        return renderError(req, res, 500, 'Không mở được form sửa.');
    }
};

/** Xác định (môn, bản ghi cũ nếu sửa) từ body / params. */
async function resolveContext(req, scope) {
    const b = req.body || {};
    let rec = null;
    if (req.params.vid) {
        rec = isObjectId(req.params.vid) ? await Video.findById(req.params.vid) : null;
        if (!rec || rec.isDeleted || !scope.canAccess(rec)) return { error: [404, `Không tìm thấy ${app.noun}.`] };
    }
    const sid = rec ? rec.subjectId : b.subjectId;
    const subject = isObjectId(sid) ? await Subject.findOne({ _id: sid, ...SUBJECT_ALIVE, ...scope.filter }) : null;
    if (!subject || !scope.canAccess(subject)) return { error: [404, 'Vui lòng chọn môn học hợp lệ.'] };
    return { rec, subject };
}

function checkReady() {
    if (!githubService.isConfigured) return 'GitHub chưa cấu hình nên chưa lưu được.';
    if (!videoCrypto.isConfigured()) return 'Chưa cấu hình ENCRYPTION_MASTER_KEY (64 ký tự hex) nên chưa mã hoá được mã nhúng.';
    return null;
}

// ------------------------------------------------------------
// TẠO: ghi JSON (repo chính) + chỉ mục
// ------------------------------------------------------------
ctrl.create = async (req, res) => {
    try {
        const scope = await getContentScope(req);
        const ctx = await resolveContext(req, scope);
        if (ctx.error) return fail(res, ctx.error[0], ctx.error[1]);
        const f = readForm(req.body);
        if (f.error) return fail(res, 400, f.error);
        const notReady = checkReady();
        if (notReady) return fail(res, 503, notReady);
        const v = buildVideos((req.body || {}).videos, null);
        if (v.error) return fail(res, 400, v.error);

        await githubSync.syncKinds([app.key]);
        let slug = slugify(f.title);
        if (await Video.exists({ subjectId: ctx.subject._id, slug })) slug += '-' + crypto.randomBytes(2).toString('hex');
        const ts = Math.floor(Date.now() / 1000);
        const jsonFile = `subjects/${ctx.subject.slug}/${app.dir}/${slug}_${ts}.json`;
        if (await githubService.fileExists(jsonFile)) return fail(res, 409, 'Đã có file trùng đường dẫn trên GitHub, hãy thử lại.');

        const id = new mongoose.Types.ObjectId();
        const nowIso = new Date().toISOString();
        const w = await githubService.writeJsonFile(jsonFile, {
            type: 'video',
            [app.idKey]: String(id),
            title: f.title, slug, subjectSlug: ctx.subject.slug, description: f.description,
            videos: v.videos, videoCount: v.videos.length,
            encrypted: true, encryption: 'aes-256-gcm',
            order: 0, isPublished: f.isPublished, isDeleted: false, deletedAt: null, deletedBy: null,
            createdBy: String(req.user._id), updatedBy: String(req.user._id), createdAt: nowIso, updatedAt: nowIso
        }, `${app.name}: tạo "${f.title}"`);

        const rec = await Video.create({
            _id: id, githubSha: w && w.sha ? w.sha : null,
            subjectId: ctx.subject._id, title: f.title, slug, description: f.description, githubFile: jsonFile,
            videos: v.videos, videoCount: v.videos.length,
            isPublished: f.isPublished, userKey: ctx.subject.userKey || null,
            createdBy: req.user._id, updatedBy: req.user._id
        });
        return res.json({ success: true, id: String(rec._id), redirect: `${app.base}/dashboard` });
    } catch (e) {
        console.error('[videos.create]', e);
        return fail(res, 500, 'Lỗi máy chủ khi lưu.');
    }
};

ctrl.update = async (req, res) => {
    try {
        await githubSync.syncKinds([app.key]);
        const scope = await getContentScope(req);
        const ctx = await resolveContext(req, scope);
        if (ctx.error) return fail(res, ctx.error[0], ctx.error[1]);
        const rec = ctx.rec;
        if (!rec) return fail(res, 404, `Không tìm thấy ${app.noun}.`);
        const f = readForm(req.body);
        if (f.error) return fail(res, 400, f.error);
        const notReady = checkReady();
        if (notReady) return fail(res, 503, notReady);
        const v = buildVideos((req.body || {}).videos, rec.videos);
        if (v.error) return fail(res, 400, v.error);

        const file = await githubService.readJsonFileWithSha(rec.githubFile);
        if (!file) return fail(res, 404, 'Không đọc được dữ liệu trên GitHub.');
        if (req.body.sha && req.body.sha !== file.sha) return fail(res, 409, 'Đã bị người khác sửa. Hãy tải lại trang.');

        const written = await githubService.writeJsonFileIfSha(rec.githubFile, Object.assign({}, file.data, {
            type: 'video',
            title: f.title, description: f.description, isPublished: f.isPublished,
            videos: v.videos, videoCount: v.videos.length, encrypted: true, encryption: 'aes-256-gcm',
            subjectSlug: ctx.subject.slug, updatedBy: String(req.user._id), updatedAt: new Date().toISOString()
        }), file.sha, `${app.name}: sửa "${f.title}"`);

        rec.title = f.title; rec.description = f.description; rec.isPublished = f.isPublished;
        rec.videos = v.videos; rec.videoCount = v.videos.length;
        rec.updatedBy = req.user._id;
        rec.githubSha = written && written.sha ? written.sha : rec.githubSha;
        await rec.save();
        return res.json({ success: true, id: String(rec._id), redirect: `${app.base}/dashboard` });
    } catch (e) {
        if (e && e.code === 'SHA_CONFLICT') return fail(res, 409, 'Đã bị người khác sửa. Hãy tải lại trang.');
        console.error('[videos.update]', e);
        return fail(res, 500, 'Lỗi máy chủ khi lưu.');
    }
};

ctrl.togglePublish = async (req, res) => {
    try {
        await githubSync.syncKinds([app.key]);
        const scope = await getContentScope(req);
        const rec = isObjectId(req.params.vid) ? await Video.findById(req.params.vid) : null;
        if (!rec || rec.isDeleted || !scope.canAccess(rec)) return fail(res, 404, `Không tìm thấy ${app.noun}.`);
        rec.isPublished = !rec.isPublished;
        rec.updatedBy = req.user._id;
        await rec.save();     // githubStore tự ghi lại file JSON (isPublished, updatedBy)
        return res.json({ success: true, isPublished: rec.isPublished });
    } catch (e) {
        console.error('[videos.togglePublish]', e);
        return fail(res, 500, 'Không đổi được trạng thái công khai.');
    }
};

ctrl.remove = async (req, res) => {
    try {
        await githubSync.syncKinds([app.key]);
        const scope = await getContentScope(req);
        const rec = isObjectId(req.params.vid) ? await Video.findById(req.params.vid) : null;
        if (!rec || rec.isDeleted || !scope.canAccess(rec)) return fail(res, 404, `Không tìm thấy ${app.noun}.`);
        await githubService.deleteFile(rec.githubFile, `${app.name}: xoá "${rec.title}"`);
        await Video.deleteOne({ _id: rec._id });
        return res.json({ success: true });
    } catch (e) {
        console.error('[videos.remove]', e);
        return fail(res, 500, 'Không xoá được.');
    }
};

ctrl._test = { readForm, buildVideos, openItem, slugify };
module.exports = ctrl;
