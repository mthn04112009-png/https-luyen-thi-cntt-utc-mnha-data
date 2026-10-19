// ============================================================
// controllers/slide.controller.js — ỨNG DỤNG SLIDE HỌC TẬP
// ------------------------------------------------------------
//   GET  /slides                          2 nút: Dashboard (admin) + Môn học
//   GET  /slides/subjects                 Chọn môn (giống /flashcards/subjects)
//   GET  /slides/subjects/:id             Các slide của môn
//   GET  /slides/study/:sid               Xem slide (nhúng PDF)
//   GET  /slides/file/:sid[?chunk=i|download=1]  Server GIẢI MÃ PDF rồi trả về (từng phần ≤ 3MB, hoặc cả file nếu nhỏ)
//   --- admin ---
//   GET  /slides/dashboard                Quản lý slide
//   GET  /slides/dashboard/new|:sid/edit  Form up / sửa
//   POST /slides/dashboard/upload-chunk   Gửi 1 phần PDF (≤ 2MB, base64) → server mã hoá, lưu tạm thành blob GitHub, trả sha
//   POST /slides/dashboard                Up mới   (JSON: thông tin + danh sách sha các phần → server gộp thành 1 file .pdf mã hoá)
//   POST /slides/dashboard/:sid           Sửa      (JSON; PDF mới tuỳ chọn)
//   POST /slides/dashboard/:sid/publish | /delete
//
// LƯU TRỮ: CHỈ GitHub (KHÔNG MongoDB)
//   subjects/{slug-môn}/slides/{slug-slide}_{unix}.json   thông tin
//   subjects/{slug-môn}/slides/{slug-slide}_{unix}.pdf    PDF MÃ HOÁ AES-256-GCM (services/slideCryptoService.js)
//   RAM chỉ giữ chỉ mục (models/Slide.js ← services/githubStore.js KINDS.slides).
// QUYỀN  : giống Flashcards/Môn học — userKeyService.getContentScope(req).
// GIỚI HẠN: PDF tối đa 20MB. Vercel cắt request/response > 4.5MB nên file được gửi/nhận theo TỪNG PHẦN
//          (xem config/slideConfig.js) — localhost và Vercel chạy cùng một đường.
// ============================================================
const mongoose = require('mongoose');

const Subject = require('../models/Subject');
const Slide = require('../models/Slide');
const githubService = require('../services/githubService');
const githubSync = require('../services/githubSyncService');
const slideCrypto = require('../services/slideCryptoService');
const cfg = require('../config/slideConfig');
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
    return out || 'slide';
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
const mb = (n) => (n / 1048576).toFixed(n >= 10 * 1048576 ? 0 : 1);

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

/** Điều kiện lọc slide: còn tồn tại, trong phạm vi quyền; sinh viên chỉ thấy slide đã công khai. */
function slideFilter(req, scope, extra) {
    return {
        isDeleted: { $ne: true },
        ...(isAdmin(req) ? {} : { isPublished: true }),
        ...scope.filter,
        ...(extra || {})
    };
}

async function countBySubject(req, scope, subjectIds) {
    if (!subjectIds.length) return {};
    const list = await Slide.find(slideFilter(req, scope, { subjectId: { $in: subjectIds } })).select('subjectId').lean();
    const out = {};
    for (const s of list) {
        const k = String(s.subjectId);
        out[k] = (out[k] || 0) + 1;
    }
    return out;
}

/** Quyền dùng ứng dụng Slide = giống Flashcards: admin, hoặc student đã được duyệt. */
async function canUseSlides(req) {
    const u = req.user;
    if (!u) return false;
    if (u.role === 'admin') return true;
    return u.role === 'student' && u.status === 'approved';
}

function denied(req, res) {
    return res.status(403).render('apps', { title: 'Ứng dụng', user: req.user, apps: [], denied: 'Slide học tập' });
}

/** Tên file hiển thị khi tải xuống: bỏ ký tự điều khiển / đường dẫn, bắt buộc đuôi .pdf */
function cleanName(name, fallback) {
    let n = String(name || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"<>:|?*]/g, '').trim();
    n = n.replace(/\.pdf$/i, '').trim().slice(0, cfg.LIMITS.MAX_NAME_LEN);
    return (n || fallback || 'slide') + '.pdf';
}

const SHA_RE = /^[0-9a-f]{40}$/;
const hasPdfHeader = (buf) => buf.subarray(0, 1024).indexOf('%PDF-', 0, 'latin1') !== -1;   // PDF hợp lệ có "%PDF-" trong 1024 byte đầu
const tooBig = () => `File PDF quá nặng (tối đa ${mb(cfg.LIMITS.MAX_PDF_BYTES)}MB).`;

async function pool(n, size, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(size, n) }, async () => {
        while (i < n) { const k = i++; await fn(k); }
    }));
}

/**
 * Gộp các phần PDF đã gửi lên (mỗi phần là 1 blob GitHub chứa 1 khung mã hoá) thành nội dung file .pdf mã hoá.
 * body.pdf = { name, shas: [sha phần 0, sha phần 1, …] }
 *   required=true  → bắt buộc (tạo mới);  false → không gửi = giữ file cũ (sửa).
 * Mỗi khung được GIẢI MÃ thử để kiểm tra: đúng thứ tự, đủ phần, là PDF, không vượt giới hạn.
 * Trả { none:true } | { error } | { encrypted, size, originalName }
 */
async function assemblePdf(body, required) {
    const p = body && body.pdf;
    if (!p || typeof p !== 'object' || !Array.isArray(p.shas) || !p.shas.length) {
        return required ? { error: 'Vui lòng chọn file PDF slide.' } : { none: true };
    }
    const shas = p.shas;
    if (shas.length > cfg.LIMITS.MAX_CHUNKS) return { error: tooBig() };
    if (!shas.every((x) => typeof x === 'string' && SHA_RE.test(x))) return { error: 'Danh sách phần PDF không hợp lệ.' };

    const frames = new Array(shas.length);
    await pool(shas.length, 4, async (i) => { frames[i] = await githubService.getBlobBuffer(shas[i]); });
    if (frames.some((f) => !f)) return { error: 'Một phần PDF đã tải lên không còn trên GitHub. Hãy chọn file và up lại.' };

    let size = 0;
    try {
        for (let i = 0; i < frames.length; i++) {
            const d = slideCrypto.decryptFrame(frames[i]);
            if (d.index !== i || d.total !== frames.length) return { error: 'Các phần PDF không khớp thứ tự. Hãy up lại.' };
            if (i === 0 && !hasPdfHeader(d.plain)) return { error: 'File gửi lên không phải PDF.' };
            size += d.plain.length;
            if (size > cfg.LIMITS.MAX_PDF_BYTES) return { error: tooBig() };
        }
    } catch (e) {
        return { error: 'Không xác thực được các phần PDF đã gửi (' + e.message + '). Hãy up lại.' };
    }
    if (!size) return { error: 'File PDF rỗng.' };
    return { encrypted: slideCrypto.joinFrames(frames), size, originalName: cleanName(p.name, 'slide') };
}

/** Đọc + kiểm tra phần thông tin của form (dùng chung tạo / sửa) */
function readForm(body) {
    const b = body || {};
    const title = String(b.title || '').trim();
    const description = String(b.description || '').trim();
    const isPublished = !(b.isPublished === false || b.isPublished === 'false' || b.isPublished === 0 || b.isPublished === '0');
    if (!title) return { error: 'Vui lòng nhập tiêu đề slide.' };
    if (title.length > cfg.LIMITS.MAX_TITLE_LEN) return { error: `Tiêu đề tối đa ${cfg.LIMITS.MAX_TITLE_LEN} ký tự.` };
    if (description.length > cfg.LIMITS.MAX_DESC_LEN) return { error: `Mô tả tối đa ${cfg.LIMITS.MAX_DESC_LEN} ký tự.` };
    return { title, description, isPublished };
}

/** Slide người dùng được xem (đã kiểm quyền + công khai + môn học). Trả { rec, subject } hoặc null. */
async function loadVisible(req, scope, sid) {
    const rec = isObjectId(sid) ? await Slide.findById(sid) : null;
    if (!rec || rec.isDeleted || (!isAdmin(req) && !rec.isPublished) || !scope.canAccess(rec)) return null;
    const subject = await findSubject(req, scope, String(rec.subjectId));
    return subject ? { rec, subject } : null;
}

// ============================================================
// /slides  (hub)
// ============================================================
exports.getHub = async (req, res) => {
    try {
        if (!(await canUseSlides(req))) return denied(req, res);
        return res.render('slides/hub', { title: 'Slide học tập', user: req.user, admin: isAdmin(req) });
    } catch (e) {
        console.error('[slides.hub]', e);
        return renderError(req, res, 500, 'Không tải được trang Slide học tập.');
    }
};

// ============================================================
// /slides/subjects
// ============================================================
exports.getSubjects = async (req, res) => {
    try {
        if (!(await canUseSlides(req))) return denied(req, res);
        await githubSync.syncKinds(['slides']);
        const scope = await getContentScope(req);

        const q = getSearchTerm(req);
        const searchClause = buildSearchClause(q, ['name', 'code', 'description']);
        // Giống /subjects và /flashcards/subjects: hiện MỌI môn đã công khai trong phạm vi quyền
        const subjects = await Subject.find(withSearch({
            ...SUBJECT_ALIVE,
            isPublished: true,
            ...scope.filter
        }, searchClause)).sort({ createdAt: -1, _id: -1 }).lean();

        const counts = await countBySubject(req, scope, subjects.map((s) => s._id));
        const rows = subjects.map((s) => Object.assign({}, s, { slideCount: counts[String(s._id)] || 0 }));

        const { items, pagination } = paginateArray(rows, req, { limit: 9 });
        return res.render('slides/subjects', {
            title: 'Slide học tập · Môn học',
            user: req.user,
            subjects: items,
            filters: { q },
            ...pagination
        });
    } catch (e) {
        console.error('[slides.subjects]', e);
        return renderError(req, res, 500, 'Không tải được danh sách môn học.');
    }
};

// ============================================================
// /slides/subjects/:id
// ============================================================
exports.getSubject = async (req, res) => {
    try {
        if (!(await canUseSlides(req))) return denied(req, res);
        await githubSync.syncKinds(['slides']);
        const scope = await getContentScope(req);
        const subject = await findSubject(req, scope, req.params.id);
        if (!subject) return renderError(req, res, 404, 'Không tìm thấy môn học.');

        const q = getSearchTerm(req);
        const searchClause = buildSearchClause(q, ['title', 'description']);
        const rows = await Slide.find(withSearch(slideFilter(req, scope, { subjectId: subject._id }), searchClause))
            .sort({ createdAt: -1, _id: -1 }).lean();
        const { items, pagination } = paginateArray(rows, req, { limit: 10 });

        return res.render('slides/subject', {
            title: `Slide học tập · ${subject.name}`,
            user: req.user,
            subject,
            slides: items,
            filters: { q },
            ...pagination
        });
    } catch (e) {
        console.error('[slides.subject]', e);
        return renderError(req, res, 500, 'Không tải được môn học.');
    }
};

// ============================================================
// /slides/study/:sid  — trang xem slide (PDF được nhúng, nạp qua /slides/file/:sid)
// ============================================================
exports.study = async (req, res) => {
    try {
        if (!(await canUseSlides(req))) return denied(req, res);
        await githubSync.syncKinds(['slides']);
        const scope = await getContentScope(req);
        const found = await loadVisible(req, scope, req.params.sid);
        if (!found) return renderError(req, res, 404, 'Không tìm thấy slide.');
        const { rec, subject } = found;
        if (!rec.pdfFile) return renderError(req, res, 404, 'Slide này chưa có file PDF.');

        const siblings = await Slide.find(slideFilter(req, scope, { subjectId: subject._id }))
            .sort({ createdAt: -1, _id: -1 }).select('title pdfSize').lean();

        const sl = {
            id: String(rec._id),
            title: rec.title,
            description: rec.description || '',
            size: rec.pdfSize || 0,
            fileName: cleanName(rec.originalName, rec.slug),
            fileUrl: `/slides/file/${rec._id}`,
            downloadUrl: `/slides/file/${rec._id}?download=1`,
            subject: { id: String(subject._id), name: subject.name },
            siblings: siblings.map((s) => ({ id: String(s._id), title: s.title }))
        };
        return res.render('slides/study', {
            title: `${rec.title} · Slide học tập`,
            user: req.user,
            sl,
            slJson: safeJson(sl),
            mb
        });
    } catch (e) {
        console.error('[slides.study]', e);
        return renderError(req, res, 500, 'Không tải được slide.');
    }
};

// ============================================================
// /slides/file/:sid — GIẢI MÃ rồi trả PDF
//   ?chunk=i      : phần thứ i (≤ 3MB) — trình duyệt tự ghép lại (cách duy nhất qua được giới hạn 4.5MB của Vercel)
//   ?download=1   : cả file, Content-Disposition: attachment (file nhỏ)
//   (không tham số): cả file, inline
// ============================================================
// Cache RAM ngắn hạn cho PDF ĐÃ GIẢI MÃ — để 7 request ?chunk=i của 1 lần xem chỉ đọc GitHub + giải mã 1 lần.
// Quyền truy cập vẫn kiểm tra ở MỌI request; chỉ tồn tại trong RAM của instance, không ghi đĩa.
const CACHE_TTL_MS = 2 * 60 * 1000;
const CACHE_MAX_BYTES = 60 * 1024 * 1024;
const _cache = new Map();   // key → { at, pdf }

function cacheGet(key) {
    const c = _cache.get(key);
    if (!c) return null;
    if (Date.now() - c.at > CACHE_TTL_MS) { _cache.delete(key); return null; }
    return c.pdf;
}
function cacheSet(key, pdf) {
    const now = Date.now();
    for (const [k, v] of _cache) if (now - v.at > CACHE_TTL_MS) _cache.delete(k);
    let total = pdf.length;
    for (const v of _cache.values()) total += v.pdf.length;
    while (total > CACHE_MAX_BYTES && _cache.size) {          // bỏ mục cũ nhất
        const k = _cache.keys().next().value;
        total -= _cache.get(k).pdf.length;
        _cache.delete(k);
    }
    if (pdf.length <= CACHE_MAX_BYTES) _cache.set(key, { at: now, pdf });
}

exports.file = async (req, res) => {
    try {
        if (!(await canUseSlides(req))) return res.status(403).type('text/plain').send('Không có quyền.');
        await githubSync.syncKinds(['slides']);
        const scope = await getContentScope(req);
        const found = await loadVisible(req, scope, req.params.sid);
        if (!found || !found.rec.pdfFile) return res.status(404).type('text/plain').send('Không tìm thấy slide.');
        const { rec } = found;

        const key = `${rec.pdfFile}@${rec.githubSha || ''}`;
        let pdf = cacheGet(key);
        if (!pdf) {
            const enc = await githubService.readBinaryFileLarge(rec.pdfFile);
            if (!enc) return res.status(404).type('text/plain').send('Không đọc được file PDF trên GitHub.');
            try {
                pdf = slideCrypto.decryptFile(enc);
            } catch (e) {
                console.error('[slides.file] giải mã lỗi:', e.message);
                return res.status(500).type('text/plain').send('Không giải mã được PDF (kiểm tra ENCRYPTION_MASTER_KEY có giống nơi đã upload không).');
            }
            cacheSet(key, pdf);
        }

        const common = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };

        if (req.query.chunk !== undefined) {
            const per = cfg.LIMITS.SERVE_CHUNK_BYTES;
            const count = Math.max(1, Math.ceil(pdf.length / per));
            const i = Number(req.query.chunk);
            if (!Number.isInteger(i) || i < 0 || i >= count) return res.status(400).type('text/plain').send('Phần không hợp lệ.');
            const part = pdf.subarray(i * per, Math.min(pdf.length, (i + 1) * per));
            res.status(200).set(Object.assign({
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(part.length),
                'X-Total-Size': String(pdf.length),
                'X-Chunk-Count': String(count),
                'X-Chunk-Index': String(i)
            }, common));
            return res.end(part);
        }

        const name = cleanName(rec.originalName, rec.slug);
        const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '_');
        const disp = req.query.download ? 'attachment' : 'inline';
        res.status(200).set(Object.assign({
            'Content-Type': 'application/pdf',
            'Content-Length': String(pdf.length),
            'Content-Disposition': `${disp}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
        }, common));
        return res.end(pdf);
    } catch (e) {
        console.error('[slides.file]', e);
        return res.status(500).type('text/plain').send('Lỗi máy chủ khi đọc PDF.');
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
        await githubSync.syncKinds(['slides']);
        const scope = await getContentScope(req);
        const subjects = await adminSubjects(scope);
        const nameById = {};
        subjects.forEach((s) => { nameById[String(s._id)] = s; });

        const q = getSearchTerm(req);
        const subjectId = isObjectId(req.query.subject) ? String(req.query.subject) : '';
        const searchClause = buildSearchClause(q, ['title', 'description']);
        const rows = await Slide.find(withSearch({
            isDeleted: { $ne: true },
            ...scope.filter,
            ...(subjectId ? { subjectId } : {})
        }, searchClause)).sort({ createdAt: -1, _id: -1 }).lean();

        const items = rows.map((f) => Object.assign({}, f, { subject: nameById[String(f.subjectId)] || null }));
        const { items: pageItems, pagination } = paginateArray(items, req, { limit: 10 });

        return res.render('slides/dashboard', {
            title: 'Slide học tập · Dashboard',
            user: req.user,
            slides: pageItems,
            subjects,
            filters: { q, subject: subjectId },
            mb,
            ...pagination
        });
    } catch (e) {
        console.error('[slides.dashboard]', e);
        return renderError(req, res, 500, 'Không tải được dashboard slide.');
    }
};

async function renderForm(req, res, rec) {
    const scope = await getContentScope(req);
    const subjects = await adminSubjects(scope);
    const state = {
        id: rec ? String(rec._id) : null,
        subjectId: rec ? String(rec.subjectId) : (isObjectId(req.query.subject) ? String(req.query.subject) : ''),
        title: rec ? rec.title : '',
        description: rec ? rec.description || '' : '',
        isPublished: rec ? rec.isPublished !== false : true,
        fileName: rec ? cleanName(rec.originalName, rec.slug) : '',
        fileSize: rec ? rec.pdfSize || 0 : 0,
        maxBytes: cfg.LIMITS.MAX_PDF_BYTES,
        onVercel: cfg.ON_VERCEL,
        encryptionReady: slideCrypto.isConfigured(),
        sha: rec ? ((await githubService.readJsonFileWithSha(rec.githubFile).catch(() => null)) || {}).sha || null : null
    };
    return res.render('slides/form', {
        title: rec ? 'Sửa slide' : 'Up slide',
        user: req.user,
        editing: !!rec,
        subjects,
        maxMb: mb(cfg.LIMITS.MAX_PDF_BYTES),
        slState: state,
        slStateJson: safeJson(state)
    });
}

exports.newForm = async (req, res) => {
    try {
        return await renderForm(req, res, null);
    } catch (e) {
        console.error('[slides.newForm]', e);
        return renderError(req, res, 500, 'Không mở được form up slide.');
    }
};

exports.editForm = async (req, res) => {
    try {
        await githubSync.syncKinds(['slides']);
        const scope = await getContentScope(req);
        const rec = isObjectId(req.params.sid) ? await Slide.findById(req.params.sid) : null;
        if (!rec || rec.isDeleted || !scope.canAccess(rec)) return renderError(req, res, 404, 'Không tìm thấy slide.');
        return await renderForm(req, res, rec);
    } catch (e) {
        console.error('[slides.editForm]', e);
        return renderError(req, res, 500, 'Không mở được form sửa slide.');
    }
};

/**
 * POST /slides/dashboard/upload-chunk  { index, total, data(base64 ≤ 2MB) }
 * Mã hoá phần này thành 1 khung AES-256-GCM rồi lưu tạm thành blob GitHub → trả { sha }.
 * (Admin; request ≤ ~2.7MB nên qua được giới hạn 4.5MB của Vercel.)
 */
exports.uploadChunk = async (req, res) => {
    try {
        const b = req.body || {};
        const index = Number(b.index), total = Number(b.total);
        if (!Number.isInteger(total) || total < 1 || total > cfg.LIMITS.MAX_CHUNKS) return fail(res, 413, tooBig());
        if (!Number.isInteger(index) || index < 0 || index >= total) return fail(res, 400, 'Số thứ tự phần PDF không hợp lệ.');
        if (typeof b.data !== 'string' || !b.data) return fail(res, 400, 'Phần PDF rỗng.');
        const b64 = b.data.replace(/\s+/g, '');
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return fail(res, 400, 'Dữ liệu PDF gửi lên không hợp lệ.');
        if (Math.floor(b64.length * 3 / 4) > cfg.LIMITS.UPLOAD_CHUNK_BYTES + 3) return fail(res, 413, 'Phần PDF vượt quá kích thước cho phép.');

        const buf = Buffer.from(b64, 'base64');
        if (!buf.length) return fail(res, 400, 'Phần PDF rỗng.');
        if (buf.length > cfg.LIMITS.UPLOAD_CHUNK_BYTES) return fail(res, 413, 'Phần PDF vượt quá kích thước cho phép.');
        if (index === 0 && !hasPdfHeader(buf)) return fail(res, 400, 'File gửi lên không phải PDF.');
        if (!githubService.isConfigured) return fail(res, 503, 'GitHub chưa cấu hình nên chưa lưu được slide.');
        if (!slideCrypto.isConfigured()) return fail(res, 503, 'Chưa cấu hình ENCRYPTION_MASTER_KEY (64 ký tự hex) nên chưa mã hoá được PDF.');

        const sha = await githubService.createBlob(slideCrypto.encryptFrame(buf, index, total));
        return res.json({ success: true, sha });
    } catch (e) {
        console.error('[slides.uploadChunk]', e);
        return fail(res, 500, 'Lỗi máy chủ khi lưu phần PDF.');
    }
};

exports.create = async (req, res) => {
    let pdfWritten = null;
    try {
        const scope = await getContentScope(req);
        const subject = isObjectId(req.body && req.body.subjectId)
            ? await Subject.findOne({ _id: req.body.subjectId, ...SUBJECT_ALIVE, ...scope.filter })
            : null;
        if (!subject || !scope.canAccess(subject)) return fail(res, 404, 'Vui lòng chọn môn học hợp lệ.');

        const f = readForm(req.body);
        if (f.error) return fail(res, 400, f.error);
        if (!githubService.isConfigured) return fail(res, 503, 'GitHub chưa cấu hình nên chưa lưu được slide.');
        if (!slideCrypto.isConfigured()) return fail(res, 503, 'Chưa cấu hình ENCRYPTION_MASTER_KEY (64 ký tự hex) nên chưa mã hoá được PDF.');
        const pdf = await assemblePdf(req.body, true);
        if (pdf.error) return fail(res, pdf.error.includes('quá nặng') ? 413 : 400, pdf.error);

        await githubSync.syncKinds(['slides']);
        let slug = slugify(f.title);
        if (await Slide.exists({ subjectId: subject._id, slug })) slug += '-' + Date.now().toString(36);
        // <slug>_<unix>.json + <slug>_<unix>.pdf  (timestamp giây ở đuôi để không trùng tên file)
        const base = `subjects/${subject.slug}/slides/${slug}_${Math.floor(Date.now() / 1000)}`;
        const jsonFile = `${base}.json`;
        const pdfFile = `${base}.pdf`;
        if ((await githubService.fileExists(jsonFile)) || (await githubService.fileExists(pdfFile))) {
            return fail(res, 409, 'Đã có file trùng đường dẫn trên GitHub, hãy thử lại.');
        }

        const id = new mongoose.Types.ObjectId();
        const nowIso = new Date().toISOString();

        // 1) PDF (đã mã hoá) TRƯỚC — để file JSON không bao giờ trỏ tới PDF chưa tồn tại
        await githubService.writeBinaryFileBig(pdfFile, pdf.encrypted, `Slide: tải PDF mã hoá "${f.title}"`);
        pdfWritten = pdfFile;

        // 2) JSON thông tin
        const written = await githubService.writeJsonFile(jsonFile, {
            type: 'slide',
            slideId: String(id),
            title: f.title, slug, subjectSlug: subject.slug, description: f.description,
            pdfFile, pdfSize: pdf.size, originalName: pdf.originalName,
            encrypted: true, encryption: 'aes-256-gcm',
            order: 0,
            isPublished: f.isPublished, isDeleted: false, deletedAt: null, deletedBy: null,
            createdBy: String(req.user._id), updatedBy: String(req.user._id),
            createdAt: nowIso, updatedAt: nowIso
        }, `Slide: tạo "${f.title}"`);

        const rec = await Slide.create({
            _id: id, githubSha: written && written.sha ? written.sha : null,
            subjectId: subject._id, title: f.title, slug, description: f.description, githubFile: jsonFile,
            pdfFile, pdfSize: pdf.size, originalName: pdf.originalName,
            isPublished: f.isPublished, userKey: subject.userKey || null,
            createdBy: req.user._id, updatedBy: req.user._id
        });
        return res.json({ success: true, id: String(rec._id), redirect: '/slides/dashboard' });
    } catch (e) {
        console.error('[slides.create]', e);
        // JSON không ghi được → gỡ PDF mồ côi (cố gắng, không bắt buộc)
        if (pdfWritten) await githubService.deleteFile(pdfWritten, 'Slide: gỡ PDF mồ côi').catch(() => {});
        return fail(res, 500, 'Lỗi máy chủ khi lưu slide.');
    }
};

exports.update = async (req, res) => {
    try {
        await githubSync.syncKinds(['slides']);
        const scope = await getContentScope(req);
        const rec = isObjectId(req.params.sid) ? await Slide.findById(req.params.sid) : null;
        if (!rec || rec.isDeleted || !scope.canAccess(rec)) return fail(res, 404, 'Không tìm thấy slide.');

        const f = readForm(req.body);
        if (f.error) return fail(res, 400, f.error);
        const hasNew = !!(req.body && req.body.pdf && Array.isArray(req.body.pdf.shas) && req.body.pdf.shas.length);
        if (hasNew && !slideCrypto.isConfigured()) return fail(res, 503, 'Chưa cấu hình ENCRYPTION_MASTER_KEY (64 ký tự hex) nên chưa mã hoá được PDF.');
        const pdf = await assemblePdf(req.body, false);
        if (pdf.error) return fail(res, pdf.error.includes('quá nặng') ? 413 : 400, pdf.error);

        const file = await githubService.readJsonFileWithSha(rec.githubFile);
        if (!file) return fail(res, 404, 'Không đọc được slide trên GitHub.');
        if (req.body.sha && req.body.sha !== file.sha) return fail(res, 409, 'Slide đã bị người khác sửa. Hãy tải lại trang.');

        const subject = await Subject.findById(rec.subjectId).select('slug').lean();
        const nowIso = new Date().toISOString();

        let pdfFile = rec.pdfFile;
        let pdfSize = rec.pdfSize || 0;
        let originalName = rec.originalName || '';
        if (!pdf.none) {
            // Thay PDF: ghi đè đúng đường dẫn cũ (hoặc theo tên JSON nếu slide cũ chưa có PDF)
            pdfFile = rec.pdfFile || rec.githubFile.replace(/\.json$/, '.pdf');
            await githubService.writeBinaryFileBig(pdfFile, pdf.encrypted, `Slide: thay PDF mã hoá "${f.title}"`);
            pdfSize = pdf.size;
            originalName = pdf.originalName;
        }

        const written = await githubService.writeJsonFileIfSha(rec.githubFile, Object.assign({}, file.data, {
            type: 'slide',
            title: f.title, description: f.description,
            pdfFile, pdfSize, originalName, encrypted: true, encryption: 'aes-256-gcm',
            isPublished: f.isPublished, subjectSlug: subject ? subject.slug : (file.data || {}).subjectSlug,
            updatedBy: String(req.user._id), updatedAt: nowIso
        }), file.sha, `Slide: sửa "${f.title}"`);

        rec.title = f.title;
        rec.description = f.description;
        rec.pdfFile = pdfFile;
        rec.pdfSize = pdfSize;
        rec.originalName = originalName;
        rec.isPublished = f.isPublished;
        rec.updatedBy = req.user._id;
        rec.githubSha = written && written.sha ? written.sha : rec.githubSha;
        await rec.save();
        return res.json({ success: true, id: String(rec._id), redirect: '/slides/dashboard' });
    } catch (e) {
        if (e && e.code === 'SHA_CONFLICT') return fail(res, 409, 'Slide đã bị người khác sửa. Hãy tải lại trang.');
        console.error('[slides.update]', e);
        return fail(res, 500, 'Lỗi máy chủ khi lưu slide.');
    }
};

exports.togglePublish = async (req, res) => {
    try {
        await githubSync.syncKinds(['slides']);
        const scope = await getContentScope(req);
        const rec = isObjectId(req.params.sid) ? await Slide.findById(req.params.sid) : null;
        if (!rec || rec.isDeleted || !scope.canAccess(rec)) return fail(res, 404, 'Không tìm thấy slide.');
        rec.isPublished = !rec.isPublished;
        rec.updatedBy = req.user._id;
        await rec.save();     // githubStore tự ghi lại file JSON (isPublished, updatedBy)
        return res.json({ success: true, isPublished: rec.isPublished });
    } catch (e) {
        console.error('[slides.togglePublish]', e);
        return fail(res, 500, 'Không đổi được trạng thái công khai.');
    }
};

exports.remove = async (req, res) => {
    try {
        await githubSync.syncKinds(['slides']);
        const scope = await getContentScope(req);
        const rec = isObjectId(req.params.sid) ? await Slide.findById(req.params.sid) : null;
        if (!rec || rec.isDeleted || !scope.canAccess(rec)) return fail(res, 404, 'Không tìm thấy slide.');
        // JSON trước: nếu xoá PDF lỗi thì chỉ còn 1 file mã hoá mồ côi, không có slide nào "hỏng"
        await githubService.deleteFile(rec.githubFile, `Slide: xoá "${rec.title}"`);
        if (rec.pdfFile) await githubService.deleteFile(rec.pdfFile, `Slide: xoá PDF "${rec.title}"`).catch((e) => {
            console.warn('[slides.remove] không xoá được PDF:', e.message);
        });
        await Slide.deleteOne({ _id: rec._id });
        return res.json({ success: true });
    } catch (e) {
        console.error('[slides.remove]', e);
        return fail(res, 500, 'Không xoá được slide.');
    }
};

// các hàm dùng cho test
exports._test = { slugify, assemblePdf, readForm, cleanName, cacheGet, cacheSet };
