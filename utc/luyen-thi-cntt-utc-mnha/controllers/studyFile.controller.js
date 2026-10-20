// ============================================================
// controllers/studyFile.controller.js — DÙNG CHUNG cho 2 ứng dụng file học tập
//   /slides     Slide bài học      (PDF, PPT, PPTX)   — controllers/slide.controller.js
//   /documents  Tài liệu học tập   (PDF)              — controllers/document.controller.js
// Cấu hình từng ứng dụng: config/studyFileConfig.js (APPS).
// ------------------------------------------------------------
//   GET  {base}                          2 nút: Dashboard (admin) + Môn học
//   GET  {base}/subjects[/:id]           Chọn môn → danh sách file của môn
//   GET  {base}/study/:sid               Xem (nhúng PDF / chạy PPTX)
//   GET  {base}/file/:sid[?chunk=i|download=1]   Server GIẢI MÃ + NỐI các phần rồi trả về
//   --- admin ---
//   GET  {base}/dashboard, /dashboard/new, /dashboard/:sid/edit
//   POST {base}/dashboard/upload-chunk   1 phần 2MB (base64) → mã hoá thành 1 khung, lưu tạm thành blob GitHub, trả sha
//   POST {base}/dashboard/upload-part    gộp các khung của 1 file-phần (≤ 23MB) → ghi lên GitHub
//   POST {base}/dashboard                tạo mới (JSON thông tin + danh sách các file-phần đã ghi)
//   POST {base}/dashboard/:sid           sửa (file mới tuỳ chọn)
//   POST {base}/dashboard/:sid/publish | /delete
//
// LƯU TRỮ: CHỈ GitHub (KHÔNG MongoDB) — xem config/studyFileConfig.js
//   {slug}_{unix}.json  +  {slug}_{unix}.{ext}   hoặc, nếu > 23MB:  {slug}_{unix}-1.{ext}, -2, -3 …
//   Mỗi file đều MÃ HOÁ AES-256-GCM (services/slideCryptoService.js); chỉ giải mã khi xem/tải xuống.
// QUYỀN: userKeyService.getContentScope(req) (giống Môn học/Flashcards).
// ============================================================
const mongoose = require('mongoose');

const Subject = require('../models/Subject');
const githubService = require('../services/githubService');
const githubSync = require('../services/githubSyncService');
const slideCrypto = require('../services/slideCryptoService');
const cfg = require('../config/studyFileConfig');
const { getContentScope } = require('../services/userKeyService');
const { paginateArray } = require('./pagination.controller');
const { getSearchTerm, buildSearchClause, withSearch } = require('../utils/search');

const L = cfg.LIMITS;
const SUBJECT_ALIVE = { deletedAt: null, deletedForever: { $ne: true } };

// ------------------------------------------------------------
// Tiện ích thuần (không phụ thuộc ứng dụng)
// ------------------------------------------------------------
const isAdmin = (req) => !!(req.user && req.user.role === 'admin');
const isObjectId = (v) => mongoose.Types.ObjectId.isValid(String(v || '')) && String(v).length === 24;
const mb = (n) => (n / cfg.MB).toFixed(n >= 10 * cfg.MB ? 0 : 1);
const tooBig = () => `File quá nặng (tối đa ${mb(L.MAX_FILE_BYTES)}MB).`;
// JSON nhúng vào <script type="application/json">: thoát "<" để không đóng thẻ script sớm
const safeJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function slugify(s) {
    const out = String(s || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd').replace(/Đ/g, 'D')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
        .slice(0, 60).replace(/-+$/g, '');
    return out || 'file';
}

/** Tên file hiển thị khi tải xuống: bỏ ký tự điều khiển / đường dẫn, đuôi luôn là ext đã kiểm tra. */
function cleanName(name, fallback, ext) {
    let n = String(name || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"<>:|?*]/g, '').trim();
    n = n.replace(/\.(pdf|pptx?|)$/i, '').trim().slice(0, L.MAX_NAME_LEN);
    return (n || fallback || 'file') + '.' + (ext || 'pdf');
}

/** Kiểm tra "chữ ký" đầu file theo định dạng (không tin đuôi tên file). */
function magicOk(buf, ext) {
    if (!buf || !buf.length) return false;
    if (ext === 'pdf') return buf.subarray(0, 1024).indexOf('%PDF-', 0, 'latin1') !== -1;
    if (ext === 'pptx') return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;   // ZIP
    if (ext === 'ppt') return buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])); // OLE2
    return false;
}

function partPath(base, ext, i, n) {
    return n === 1 ? `${base}.${ext}` : `${base}-${i + 1}.${ext}`;   // *.pdf  hoặc  *-1.pdf, *-2.pdf, …
}

async function pool(n, size, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(size, n) }, async () => {
        while (i < n) { const k = i++; await fn(k); }
    }));
}

/** Đọc + kiểm tra phần thông tin của form (dùng chung tạo / sửa) */
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

// ------------------------------------------------------------
// Cache RAM ngắn hạn cho từng file-phần ĐÃ GIẢI MÃ — để nhiều request ?chunk=i của 1 lần xem
// chỉ đọc GitHub + giải mã mỗi phần 1 lần. Quyền truy cập vẫn kiểm tra ở MỌI request;
// chỉ tồn tại trong RAM của instance, không ghi đĩa.
// ------------------------------------------------------------
const CACHE_TTL_MS = 2 * 60 * 1000;
const CACHE_MAX_BYTES = 90 * cfg.MB;
const _cache = new Map();   // key → { at, plain }

function cacheGet(key) {
    const c = _cache.get(key);
    if (!c) return null;
    if (Date.now() - c.at > CACHE_TTL_MS) { _cache.delete(key); return null; }
    return c.plain;
}
function cacheSet(key, plain) {
    const now = Date.now();
    for (const [k, v] of _cache) if (now - v.at > CACHE_TTL_MS) _cache.delete(k);
    let total = plain.length;
    for (const v of _cache.values()) total += v.plain.length;
    while (total > CACHE_MAX_BYTES && _cache.size) {          // bỏ mục cũ nhất
        const k = _cache.keys().next().value;
        total -= _cache.get(k).plain.length;
        _cache.delete(k);
    }
    if (plain.length <= CACHE_MAX_BYTES) _cache.set(key, { at: now, plain });
}

/**
 * Tạo controller cho 1 ứng dụng.
 *   app   : phần tử của cfg.APPS
 *   Model : Slide | Document (models/…)
 */
function createController(app, Model) {
    const ctrl = {};

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

    /** Điều kiện lọc: còn tồn tại, trong phạm vi quyền; sinh viên chỉ thấy bản đã công khai. */
    const itemFilter = (req, scope, extra) => ({
        isDeleted: { $ne: true }, ...(isAdmin(req) ? {} : { isPublished: true }), ...scope.filter, ...(extra || {})
    });

    async function countBySubject(req, scope, subjectIds) {
        if (!subjectIds.length) return {};
        const list = await Model.find(itemFilter(req, scope, { subjectId: { $in: subjectIds } })).select('subjectId').lean();
        const out = {};
        for (const s of list) { const k = String(s.subjectId); out[k] = (out[k] || 0) + 1; }
        return out;
    }

    async function loadVisible(req, scope, sid) {
        const rec = isObjectId(sid) ? await Model.findById(sid) : null;
        if (!rec || rec.isDeleted || (!isAdmin(req) && !rec.isPublished) || !scope.canAccess(rec)) return null;
        const subject = await findSubject(req, scope, String(rec.subjectId));
        return subject ? { rec, subject } : null;
    }

    const totalSize = (rec) => rec.fileSize || (rec.parts || []).reduce((n, p) => n + (p.plain || 0), 0);

    // ============================================================
    // HUB / MÔN HỌC / DANH SÁCH
    // ============================================================
    ctrl.getHub = async (req, res) => {
        try {
            if (!(await canUse(req))) return denied(req, res);
            return res.render('studyfiles/hub', { title: app.name, user: req.user, admin: isAdmin(req), app });
        } catch (e) {
            console.error(`[${app.key}.hub]`, e);
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
            // Giống /subjects và /flashcards/subjects: hiện MỌI môn đã công khai trong phạm vi quyền
            const subjects = await Subject.find(withSearch({ ...SUBJECT_ALIVE, isPublished: true, ...scope.filter }, searchClause))
                .sort({ createdAt: -1, _id: -1 }).lean();
            const counts = await countBySubject(req, scope, subjects.map((s) => s._id));
            const rows = subjects.map((s) => Object.assign({}, s, { itemCount: counts[String(s._id)] || 0 }));
            const { items, pagination } = paginateArray(rows, req, { limit: 9 });
            return res.render('studyfiles/subjects', {
                title: `${app.name} · Môn học`, user: req.user, app, subjects: items, filters: { q }, ...pagination
            });
        } catch (e) {
            console.error(`[${app.key}.subjects]`, e);
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
            const rows = await Model.find(withSearch(itemFilter(req, scope, { subjectId: subject._id }), searchClause))
                .sort({ createdAt: -1, _id: -1 }).lean();
            const { items, pagination } = paginateArray(rows, req, { limit: 10 });
            return res.render('studyfiles/subject', {
                title: `${app.name} · ${subject.name}`, user: req.user, app, subject, items, filters: { q }, mb, ...pagination
            });
        } catch (e) {
            console.error(`[${app.key}.subject]`, e);
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
            const found = await loadVisible(req, scope, req.params.sid);
            if (!found) return renderError(req, res, 404, `Không tìm thấy ${app.noun}.`);
            const { rec, subject } = found;
            if (!rec.parts || !rec.parts.length) return renderError(req, res, 404, `${app.name} này chưa có file.`);

            const siblings = await Model.find(itemFilter(req, scope, { subjectId: subject._id }))
                .sort({ createdAt: -1, _id: -1 }).select('title').lean();
            const sl = {
                id: String(rec._id), title: rec.title, description: rec.description || '',
                ext: rec.fileExt || 'pdf', size: totalSize(rec), viewer: app.viewer,
                fileName: cleanName(rec.originalName, rec.slug, rec.fileExt),
                fileUrl: `${app.base}/file/${rec._id}`, downloadUrl: `${app.base}/file/${rec._id}?download=1`,
                chunkBytes: L.SERVE_CHUNK_BYTES,
                subject: { id: String(subject._id), name: subject.name },
                siblings: siblings.map((s) => ({ id: String(s._id), title: s.title }))
            };
            return res.render('studyfiles/study', {
                title: `${rec.title} · ${app.name}`, user: req.user, app, sl, slJson: safeJson(sl), mb
            });
        } catch (e) {
            console.error(`[${app.key}.study]`, e);
            return renderError(req, res, 500, `Không tải được ${app.noun}.`);
        }
    };

    /** Giải mã 1 file-phần → Buffer (có cache RAM). */
    async function loadPart(rec, i) {
        const part = rec.parts[i];
        const key = `${part.path}@${rec.githubSha || ''}`;
        let plain = cacheGet(key);
        if (!plain) {
            const enc = await githubService.readBinaryFileLarge(part.path);
            if (!enc) { const e = new Error('Không đọc được file trên GitHub.'); e.code = 'MISSING'; throw e; }
            plain = slideCrypto.decryptPart(enc, null, null).plain;     // lỗi khoá / bị sửa → ném lỗi
            cacheSet(key, plain);
        }
        return plain;
    }

    /** Đọc khoảng byte [start, end) của file GỐC — tự nối các file-phần liền mạch. */
    async function readRange(rec, start, end) {
        const out = [];
        let off = 0;
        for (let i = 0; i < rec.parts.length && off < end; i++) {
            const len = rec.parts[i].plain || 0;
            const pStart = off, pEnd = off + len;
            off = pEnd;
            if (pEnd <= start) continue;
            const plain = await loadPart(rec, i);
            out.push(plain.subarray(Math.max(0, start - pStart), Math.min(plain.length, end - pStart)));
        }
        return Buffer.concat(out);
    }

    ctrl.file = async (req, res) => {
        try {
            if (!(await canUse(req))) return res.status(403).type('text/plain').send('Không có quyền.');
            await githubSync.syncKinds([app.key]);
            const scope = await getContentScope(req);
            const found = await loadVisible(req, scope, req.params.sid);
            if (!found || !found.rec.parts || !found.rec.parts.length) return res.status(404).type('text/plain').send('Không tìm thấy.');
            const { rec } = found;
            const total = totalSize(rec);
            const common = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };

            try {
                if (req.query.chunk !== undefined) {
                    const per = L.SERVE_CHUNK_BYTES;
                    const count = Math.max(1, Math.ceil(total / per));
                    const i = Number(req.query.chunk);
                    if (!Number.isInteger(i) || i < 0 || i >= count) return res.status(400).type('text/plain').send('Phần không hợp lệ.');
                    const part = await readRange(rec, i * per, Math.min(total, (i + 1) * per));
                    res.status(200).set(Object.assign({
                        'Content-Type': 'application/octet-stream', 'Content-Length': String(part.length),
                        'X-Total-Size': String(total), 'X-Chunk-Count': String(count), 'X-Chunk-Index': String(i)
                    }, common));
                    return res.end(part);
                }

                const name = cleanName(rec.originalName, rec.slug, rec.fileExt);
                const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '_');
                res.status(200).set(Object.assign({
                    'Content-Type': cfg.EXT_MIME[rec.fileExt] || 'application/octet-stream',
                    'Content-Length': String(total),
                    'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
                }, common));
                // Nối liền mạch từng file-phần (file lớn: ghi lần lượt, không giữ cả file trong RAM)
                for (let i = 0; i < rec.parts.length; i++) res.write(await loadPart(rec, i));
                return res.end();
            } catch (e) {
                if (res.headersSent) { console.error(`[${app.key}.file] lỗi giữa chừng:`, e.message); return res.destroy(e); }
                if (e.code === 'MISSING') return res.status(404).type('text/plain').send(e.message);
                console.error(`[${app.key}.file] giải mã lỗi:`, e.message);
                return res.status(500).type('text/plain').send('Không giải mã được file (kiểm tra ENCRYPTION_MASTER_KEY có giống nơi đã upload không).');
            }
        } catch (e) {
            console.error(`[${app.key}.file]`, e);
            return res.status(500).type('text/plain').send('Lỗi máy chủ khi đọc file.');
        }
    };

    // ============================================================
    // DASHBOARD (admin)
    // ============================================================
    const adminSubjects = (scope) => Subject.find({ ...SUBJECT_ALIVE, ...scope.filter })
        .sort({ createdAt: -1, _id: -1 }).select('name code slug userKey').lean();

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
            const rows = await Model.find(withSearch({
                isDeleted: { $ne: true }, ...scope.filter, ...(subjectId ? { subjectId } : {})
            }, searchClause)).sort({ createdAt: -1, _id: -1 }).lean();
            const items = rows.map((f) => Object.assign({}, f, { subject: nameById[String(f.subjectId)] || null }));
            const { items: pageItems, pagination } = paginateArray(items, req, { limit: 10 });
            return res.render('studyfiles/dashboard', {
                title: `${app.name} · Dashboard`, user: req.user, app, items: pageItems, subjects,
                filters: { q, subject: subjectId }, mb, ...pagination
            });
        } catch (e) {
            console.error(`[${app.key}.dashboard]`, e);
            return renderError(req, res, 500, 'Không tải được dashboard.');
        }
    };

    async function renderForm(req, res, rec) {
        const scope = await getContentScope(req);
        const subjects = await adminSubjects(scope);
        const state = {
            id: rec ? String(rec._id) : null,
            base: app.base, key: app.key, noun: app.noun, exts: app.exts, accept: app.accept,
            subjectId: rec ? String(rec.subjectId) : (isObjectId(req.query.subject) ? String(req.query.subject) : ''),
            title: rec ? rec.title : '', description: rec ? rec.description || '' : '',
            isPublished: rec ? rec.isPublished !== false : true,
            fileName: rec ? cleanName(rec.originalName, rec.slug, rec.fileExt) : '', fileSize: rec ? totalSize(rec) : 0,
            fileParts: rec ? (rec.parts || []).length : 0,
            maxBytes: L.MAX_FILE_BYTES, frameBytes: L.FRAME_PLAIN_BYTES, frameOverhead: L.FRAME_OVERHEAD,
            magicBytes: L.FILE_MAGIC_BYTES, partMaxBytes: L.PART_MAX_BYTES, maxFrames: L.MAX_FRAMES,
            encryptionReady: slideCrypto.isConfigured(),
            sha: rec ? ((await githubService.readJsonFileWithSha(rec.githubFile).catch(() => null)) || {}).sha || null : null
        };
        return res.render('studyfiles/form', {
            title: rec ? `Sửa ${app.noun}` : `Up ${app.noun}`, user: req.user, app, editing: !!rec, subjects,
            maxMb: mb(L.MAX_FILE_BYTES), partMb: mb(L.PART_MAX_BYTES), slStateJson: safeJson(state)
        });
    }

    ctrl.newForm = async (req, res) => {
        try { return await renderForm(req, res, null); }
        catch (e) { console.error(`[${app.key}.newForm]`, e); return renderError(req, res, 500, 'Không mở được form.'); }
    };

    ctrl.editForm = async (req, res) => {
        try {
            await githubSync.syncKinds([app.key]);
            const scope = await getContentScope(req);
            const rec = isObjectId(req.params.sid) ? await Model.findById(req.params.sid) : null;
            if (!rec || rec.isDeleted || !scope.canAccess(rec)) return renderError(req, res, 404, `Không tìm thấy ${app.noun}.`);
            return await renderForm(req, res, rec);
        } catch (e) {
            console.error(`[${app.key}.editForm]`, e);
            return renderError(req, res, 500, 'Không mở được form sửa.');
        }
    };

    // ------------------------------------------------------------
    // UP: bước 1 — 1 phần 2MB → 1 khung mã hoá → blob GitHub tạm
    // ------------------------------------------------------------
    ctrl.uploadChunk = async (req, res) => {
        try {
            const b = req.body || {};
            const index = Number(b.index), total = Number(b.total);
            const ext = String(b.ext || '').toLowerCase();
            if (!app.exts.includes(ext)) return fail(res, 400, `Chỉ nhận định dạng: ${app.exts.map((x) => '.' + x).join(', ')}.`);
            if (!Number.isInteger(total) || total < 1 || total > L.MAX_FRAMES) return fail(res, 413, tooBig());
            if (!Number.isInteger(index) || index < 0 || index >= total) return fail(res, 400, 'Số thứ tự phần không hợp lệ.');
            if (typeof b.data !== 'string' || !b.data) return fail(res, 400, 'Phần dữ liệu rỗng.');
            const b64 = b.data.replace(/\s+/g, '');
            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return fail(res, 400, 'Dữ liệu gửi lên không hợp lệ.');
            if (Math.floor(b64.length * 3 / 4) > L.FRAME_PLAIN_BYTES + 3) return fail(res, 413, 'Phần dữ liệu vượt quá kích thước cho phép.');

            const buf = Buffer.from(b64, 'base64');
            if (!buf.length) return fail(res, 400, 'Phần dữ liệu rỗng.');
            if (buf.length > L.FRAME_PLAIN_BYTES) return fail(res, 413, 'Phần dữ liệu vượt quá kích thước cho phép.');
            if (index === 0 && !magicOk(buf, ext)) return fail(res, 400, `File gửi lên không phải .${ext} hợp lệ.`);
            if (!githubService.isConfigured) return fail(res, 503, 'GitHub chưa cấu hình nên chưa lưu được file.');
            if (!slideCrypto.isConfigured()) return fail(res, 503, 'Chưa cấu hình ENCRYPTION_MASTER_KEY (64 ký tự hex) nên chưa mã hoá được file.');

            const sha = await githubService.createBlob(slideCrypto.encryptFrame(buf, index, total));
            return res.json({ success: true, sha });
        } catch (e) {
            console.error(`[${app.key}.uploadChunk]`, e);
            return fail(res, 500, 'Lỗi máy chủ khi lưu phần dữ liệu.');
        }
    };

    /** slug dùng cho tên file: slug của tiêu đề (tạo mới: thêm đuôi nếu trùng trong môn) hoặc slug cũ (sửa). */
    async function resolveSlug(subject, title, uid, existingRec) {
        if (existingRec) return existingRec.slug;
        let slug = slugify(title);
        if (await Model.exists({ subjectId: subject._id, slug })) slug += '-' + uid.slice(0, 4);
        return slug;
    }

    const UID_RE = /^[0-9a-f]{16,32}$/;
    function checkTs(ts) {
        const now = Math.floor(Date.now() / 1000);
        return Number.isInteger(ts) && Math.abs(ts - now) <= 86400;
    }

    /** Xác định (môn, bản ghi cũ nếu sửa) từ body của upload-part / create / update. */
    async function resolveContext(req, scope) {
        const b = req.body || {};
        let rec = null;
        if (req.params.sid || b.id) {
            const id = req.params.sid || b.id;
            rec = isObjectId(id) ? await Model.findById(id) : null;
            if (!rec || rec.isDeleted || !scope.canAccess(rec)) return { error: [404, `Không tìm thấy ${app.noun}.`] };
        }
        const subject = isObjectId(rec ? rec.subjectId : b.subjectId)
            ? await Subject.findOne({ _id: rec ? rec.subjectId : b.subjectId, ...SUBJECT_ALIVE, ...scope.filter })
            : null;
        if (!subject || !scope.canAccess(subject)) return { error: [404, 'Vui lòng chọn môn học hợp lệ.'] };
        return { rec, subject };
    }

    // ------------------------------------------------------------
    // UP: bước 2 — gộp các khung của 1 file-phần (≤ 23MB) rồi ghi lên GitHub
    //   Mỗi file-phần 1 request riêng (Vercel maxDuration 60s).
    // ------------------------------------------------------------
    ctrl.uploadPart = async (req, res) => {
        try {
            const b = req.body || {};
            const ext = String(b.ext || '').toLowerCase();
            const uid = String(b.uid || '');
            const ts = Number(b.ts), partIndex = Number(b.partIndex), partCount = Number(b.partCount);
            const startFrame = Number(b.startFrame), totalFrames = Number(b.totalFrames);
            const shas = b.shas;

            if (!app.exts.includes(ext)) return fail(res, 400, `Chỉ nhận định dạng: ${app.exts.map((x) => '.' + x).join(', ')}.`);
            if (!UID_RE.test(uid) || !checkTs(ts)) return fail(res, 400, 'Phiên upload không hợp lệ. Hãy tải lại trang.');
            if (![partIndex, partCount, startFrame, totalFrames].every(Number.isInteger) || partCount < 1 || partCount > L.MAX_FRAMES ||
                partIndex < 0 || partIndex >= partCount || startFrame < 0 || totalFrames < 1 || totalFrames > L.MAX_FRAMES) {
                return fail(res, 400, 'Thông tin file-phần không hợp lệ.');
            }
            if (!Array.isArray(shas) || !shas.length || startFrame + shas.length > totalFrames ||
                !shas.every((x) => typeof x === 'string' && /^[0-9a-f]{40}$/.test(x))) {
                return fail(res, 400, 'Danh sách phần dữ liệu không hợp lệ.');
            }
            if (!githubService.isConfigured) return fail(res, 503, 'GitHub chưa cấu hình nên chưa lưu được file.');
            if (!slideCrypto.isConfigured()) return fail(res, 503, 'Chưa cấu hình ENCRYPTION_MASTER_KEY (64 ký tự hex) nên chưa mã hoá được file.');

            const scope = await getContentScope(req);
            const ctx = await resolveContext(req, scope);
            if (ctx.error) return fail(res, ctx.error[0], ctx.error[1]);
            const f = readForm(b);
            if (f.error && !ctx.rec) return fail(res, 400, f.error);

            await githubSync.syncKinds([app.key]);
            const slug = await resolveSlug(ctx.subject, f.title || '', uid, ctx.rec);
            const base = `subjects/${ctx.subject.slug}/${app.dir}/${slug}_${ts}`;
            const path = partPath(base, ext, partIndex, partCount);

            const frames = new Array(shas.length);
            await pool(shas.length, 4, async (i) => { frames[i] = await githubService.getBlobBuffer(shas[i]); });
            if (frames.some((x) => !x)) return fail(res, 400, 'Một phần dữ liệu đã tải lên không còn trên GitHub. Hãy chọn file và up lại.');

            let plain = 0;
            try {
                for (let i = 0; i < frames.length; i++) {
                    const d = slideCrypto.decryptFrame(frames[i]);
                    if (d.index !== startFrame + i || d.total !== totalFrames) return fail(res, 400, 'Các phần dữ liệu không khớp thứ tự. Hãy up lại.');
                    if (startFrame + i === 0 && !magicOk(d.plain, ext)) return fail(res, 400, `File gửi lên không phải .${ext} hợp lệ.`);
                    plain += d.plain.length;
                }
            } catch (e) {
                return fail(res, 400, 'Không xác thực được dữ liệu đã gửi (' + e.message + '). Hãy up lại.');
            }
            const joined = slideCrypto.joinFrames(frames);
            if (joined.length > L.PART_MAX_BYTES) return fail(res, 400, `File-phần vượt ${mb(L.PART_MAX_BYTES)}MB. Hãy tải lại trang và up lại.`);

            await githubService.writeBinaryFileBig(path, joined, `${app.name}: lưu file mã hoá ${path.split('/').pop()}`);
            const sig = slideCrypto.metaSig([app.key, uid, path, startFrame, shas.length, totalFrames, joined.length, plain]);
            return res.json({ success: true, part: { path, enc: joined.length, plain, startFrame, count: shas.length, sig } });
        } catch (e) {
            console.error(`[${app.key}.uploadPart]`, e);
            return fail(res, 500, 'Lỗi máy chủ khi ghi file lên GitHub.');
        }
    };

    /**
     * Kiểm tra danh sách file-phần mà client báo đã ghi (chữ ký HMAC + liên tục + đúng đường dẫn).
     * Không gọi mạng. Trả { error } | { parts, size, ext, base, originalName, uid, ts }
     */
    async function checkFile(body, ctx) {
        const p = body && body.file;
        if (!p || typeof p !== 'object') return { none: true };
        const ext = String(p.ext || '').toLowerCase();
        const uid = String(p.uid || '');
        const ts = Number(p.ts);
        if (!app.exts.includes(ext)) return { error: `Chỉ nhận định dạng: ${app.exts.map((x) => '.' + x).join(', ')}.` };
        if (!UID_RE.test(uid) || !checkTs(ts)) return { error: 'Phiên upload không hợp lệ. Hãy tải lại trang.' };
        const list = p.parts;
        if (!Array.isArray(list) || !list.length || list.length > L.MAX_FRAMES) return { error: 'Danh sách file-phần không hợp lệ.' };

        const slug = await resolveSlug(ctx.subject, String(body.title || ''), uid, ctx.rec);
        const base = `subjects/${ctx.subject.slug}/${app.dir}/${slug}_${ts}`;
        const totalFrames = list.reduce((n, x) => n + (Number(x && x.count) || 0), 0);
        let next = 0, size = 0;
        const parts = [];
        for (let i = 0; i < list.length; i++) {
            const x = list[i] || {};
            const vals = [x.startFrame, x.count, x.enc, x.plain].map(Number);
            if (!vals.every(Number.isInteger) || x.startFrame !== next || vals[1] < 1) return { error: 'Các file-phần không liên tục. Hãy up lại.' };
            const expectPath = partPath(base, ext, i, list.length);
            if (x.path !== expectPath) return { error: 'Đường dẫn file-phần không hợp lệ. Hãy up lại.' };
            if (!slideCrypto.verifyMetaSig([app.key, uid, expectPath, x.startFrame, x.count, totalFrames, x.enc, x.plain], x.sig)) {
                return { error: 'Chữ ký file-phần không hợp lệ. Hãy up lại.' };
            }
            if (x.enc > L.PART_MAX_BYTES) return { error: 'File-phần vượt giới hạn. Hãy up lại.' };
            next += x.count; size += x.plain;
            parts.push({ path: expectPath, enc: x.enc, plain: x.plain });
        }
        if (totalFrames > L.MAX_FRAMES || size > L.MAX_FILE_BYTES) return { error: tooBig() };
        if (size <= 0) return { error: 'File rỗng.' };
        return { parts, size, ext, base, originalName: cleanName(p.name, slug, ext) };
    }

    const delPaths = (paths, msg) => Promise.all(paths.map((p) => githubService.deleteFile(p, msg).catch(() => {})));

    // ------------------------------------------------------------
    // UP: bước 3 — ghi JSON thông tin, tạo chỉ mục
    // ------------------------------------------------------------
    ctrl.create = async (req, res) => {
        let written = [];
        try {
            const scope = await getContentScope(req);
            const ctx = await resolveContext(req, scope);
            if (ctx.error) return fail(res, ctx.error[0], ctx.error[1]);
            if (ctx.rec) return fail(res, 400, 'Yêu cầu không hợp lệ.');
            const f = readForm(req.body);
            if (f.error) return fail(res, 400, f.error);
            if (!githubService.isConfigured) return fail(res, 503, 'GitHub chưa cấu hình nên chưa lưu được file.');
            if (!slideCrypto.isConfigured()) return fail(res, 503, 'Chưa cấu hình ENCRYPTION_MASTER_KEY (64 ký tự hex).');

            await githubSync.syncKinds([app.key]);
            const chk = await checkFile(Object.assign({}, req.body, { title: f.title }), ctx);
            if (chk.none) return fail(res, 400, `Vui lòng chọn file ${app.noun}.`);
            if (chk.error) return fail(res, chk.error.includes('quá nặng') ? 413 : 400, chk.error);
            written = chk.parts.map((x) => x.path);

            const jsonFile = `${chk.base}.json`;
            if (await githubService.fileExists(jsonFile)) return fail(res, 409, 'Đã có file trùng đường dẫn trên GitHub, hãy thử lại.');

            const id = new mongoose.Types.ObjectId();
            const slug = chk.base.split('/').pop().replace(/_\d+$/, '');
            const nowIso = new Date().toISOString();
            const w = await githubService.writeJsonFile(jsonFile, {
                type: app.key === 'slides' ? 'slide' : 'document',
                [app.idKey]: String(id),
                title: f.title, slug, subjectSlug: ctx.subject.slug, description: f.description,
                parts: chk.parts, fileExt: chk.ext, fileSize: chk.size, originalName: chk.originalName,
                encrypted: true, encryption: 'aes-256-gcm',
                order: 0, isPublished: f.isPublished, isDeleted: false, deletedAt: null, deletedBy: null,
                createdBy: String(req.user._id), updatedBy: String(req.user._id), createdAt: nowIso, updatedAt: nowIso
            }, `${app.name}: tạo "${f.title}"`);

            const rec = await Model.create({
                _id: id, githubSha: w && w.sha ? w.sha : null,
                subjectId: ctx.subject._id, title: f.title, slug, description: f.description, githubFile: jsonFile,
                parts: chk.parts, fileExt: chk.ext, fileSize: chk.size, originalName: chk.originalName,
                isPublished: f.isPublished, userKey: ctx.subject.userKey || null,
                createdBy: req.user._id, updatedBy: req.user._id
            });
            return res.json({ success: true, id: String(rec._id), redirect: `${app.base}/dashboard` });
        } catch (e) {
            console.error(`[${app.key}.create]`, e);
            if (written.length) await delPaths(written, `${app.name}: gỡ file mồ côi`);     // JSON không ghi được → gỡ file mã hoá mồ côi
            return fail(res, 500, 'Lỗi máy chủ khi lưu.');
        }
    };

    ctrl.update = async (req, res) => {
        let newPaths = [];
        try {
            await githubSync.syncKinds([app.key]);
            const scope = await getContentScope(req);
            const ctx = await resolveContext(req, scope);
            if (ctx.error) return fail(res, ctx.error[0], ctx.error[1]);
            const rec = ctx.rec;
            if (!rec) return fail(res, 404, `Không tìm thấy ${app.noun}.`);
            const f = readForm(req.body);
            if (f.error) return fail(res, 400, f.error);

            const chk = await checkFile(Object.assign({}, req.body, { title: f.title }), ctx);
            if (chk.error) return fail(res, chk.error.includes('quá nặng') ? 413 : 400, chk.error);
            if (!chk.none) newPaths = chk.parts.map((x) => x.path);

            const file = await githubService.readJsonFileWithSha(rec.githubFile);
            if (!file) return fail(res, 404, 'Không đọc được dữ liệu trên GitHub.');
            if (req.body.sha && req.body.sha !== file.sha) return fail(res, 409, 'Đã bị người khác sửa. Hãy tải lại trang.');

            const oldPaths = (rec.parts || []).map((x) => x.path);
            const fileFields = chk.none ? {} : {
                parts: chk.parts, fileExt: chk.ext, fileSize: chk.size, originalName: chk.originalName,
                encrypted: true, encryption: 'aes-256-gcm'
            };
            const written = await githubService.writeJsonFileIfSha(rec.githubFile, Object.assign({}, file.data, {
                type: app.key === 'slides' ? 'slide' : 'document',
                title: f.title, description: f.description, isPublished: f.isPublished,
                subjectSlug: ctx.subject.slug, updatedBy: String(req.user._id), updatedAt: new Date().toISOString()
            }, fileFields), file.sha, `${app.name}: sửa "${f.title}"`);

            rec.title = f.title; rec.description = f.description; rec.isPublished = f.isPublished;
            rec.updatedBy = req.user._id;
            if (!chk.none) { rec.parts = chk.parts; rec.fileExt = chk.ext; rec.fileSize = chk.size; rec.originalName = chk.originalName; }
            rec.githubSha = written && written.sha ? written.sha : rec.githubSha;
            await rec.save();

            // File cũ không còn dùng → xoá (JSON đã trỏ sang file mới nên lỗi ở đây không làm hỏng dữ liệu)
            if (!chk.none) await delPaths(oldPaths.filter((p) => !newPaths.includes(p)), `${app.name}: xoá file cũ`);
            // Legacy: JSON cũ còn pdfFile/pdfSize → bỏ đi cho gọn
            return res.json({ success: true, id: String(rec._id), redirect: `${app.base}/dashboard` });
        } catch (e) {
            if (e && e.code === 'SHA_CONFLICT') return fail(res, 409, 'Đã bị người khác sửa. Hãy tải lại trang.');
            console.error(`[${app.key}.update]`, e);
            return fail(res, 500, 'Lỗi máy chủ khi lưu.');
        }
    };

    ctrl.togglePublish = async (req, res) => {
        try {
            await githubSync.syncKinds([app.key]);
            const scope = await getContentScope(req);
            const rec = isObjectId(req.params.sid) ? await Model.findById(req.params.sid) : null;
            if (!rec || rec.isDeleted || !scope.canAccess(rec)) return fail(res, 404, `Không tìm thấy ${app.noun}.`);
            rec.isPublished = !rec.isPublished;
            rec.updatedBy = req.user._id;
            await rec.save();     // githubStore tự ghi lại file JSON (isPublished, updatedBy)
            return res.json({ success: true, isPublished: rec.isPublished });
        } catch (e) {
            console.error(`[${app.key}.togglePublish]`, e);
            return fail(res, 500, 'Không đổi được trạng thái công khai.');
        }
    };

    ctrl.remove = async (req, res) => {
        try {
            await githubSync.syncKinds([app.key]);
            const scope = await getContentScope(req);
            const rec = isObjectId(req.params.sid) ? await Model.findById(req.params.sid) : null;
            if (!rec || rec.isDeleted || !scope.canAccess(rec)) return fail(res, 404, `Không tìm thấy ${app.noun}.`);
            // JSON trước: nếu xoá file lỗi thì chỉ còn file mã hoá mồ côi, không có bản ghi nào "hỏng"
            await githubService.deleteFile(rec.githubFile, `${app.name}: xoá "${rec.title}"`);
            for (const p of rec.parts || []) {
                await githubService.deleteFile(p.path, `${app.name}: xoá file "${rec.title}"`).catch((e) => {
                    console.warn(`[${app.key}.remove] không xoá được ${p.path}:`, e.message);
                });
            }
            await Model.deleteOne({ _id: rec._id });
            return res.json({ success: true });
        } catch (e) {
            console.error(`[${app.key}.remove]`, e);
            return fail(res, 500, 'Không xoá được.');
        }
    };

    ctrl._test = { checkFile, readRange, loadPart, resolveSlug };
    return ctrl;
}

module.exports = { createController, _test: { slugify, cleanName, magicOk, partPath, readForm, cacheGet, cacheSet } };
