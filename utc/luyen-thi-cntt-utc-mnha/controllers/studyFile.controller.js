// ============================================================
// controllers/studyFile.controller.js — DÙNG CHUNG cho 2 ứng dụng file học tập
//   /slides     Slide bài học      (PDF, PPT, PPTX)   — controllers/slide.controller.js
//   /documents  Tài liệu học tập   (PDF)              — controllers/document.controller.js
// Cấu hình từng ứng dụng: config/studyFileConfig.js (APPS).
// ------------------------------------------------------------
//   GET  {base}                          2 nút: Dashboard (admin) + Môn học
//   GET  {base}/subjects[/:id]           Chọn môn → danh sách file của môn
//   GET  {base}/study/:sid               Xem (nhúng PDF / chạy PPTX)
//   GET  {base}/file/:sid[?chunk=i|download=1]   Server GIẢI MÃ + NỐI các phần rồi trả về (đường dự phòng)
//   POST {base}/keys/:sid                Cấp khoá từng khung (theo salt) + token 2 giờ → TRÌNH DUYỆT tải thẳng file mã hoá
//                                        từ GitHub rồi tự giải mã bằng Web Crypto (không tốn băng thông Vercel)
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
const crypto = require('crypto');
const mongoose = require('mongoose');

const Subject = require('../models/Subject');
const githubService = require('../services/githubService');
const githubSync = require('../services/githubSyncService');
const slideCrypto = require('../services/slideCryptoService');
const audience = require('../services/audienceService');
const r2 = require('../services/r2Service');
const ghCfg = require('../config/github');
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

/**
 * Đọc + kiểm tra phần thông tin của form (dùng chung tạo / sửa).
 *   audienceOn = true (ứng dụng có "Chỉ hiển thị với", vd /documents): đọc thêm visibility + allowedUserIds.
 *   audienceProvided = false → form không gửi gì về chế độ hiển thị (khi sửa thì giữ nguyên giá trị cũ).
 */
function readForm(body, audienceOn) {
    const b = body || {};
    const title = String(b.title || '').trim();
    const description = String(b.description || '').trim();
    let isPublished = !(b.isPublished === false || b.isPublished === 'false' || b.isPublished === 0 || b.isPublished === '0');
    if (!title) return { error: 'Vui lòng nhập tiêu đề.' };
    if (title.length > L.MAX_TITLE_LEN) return { error: `Tiêu đề tối đa ${L.MAX_TITLE_LEN} ký tự.` };
    if (description.length > L.MAX_DESC_LEN) return { error: `Mô tả tối đa ${L.MAX_DESC_LEN} ký tự.` };
    if (!audienceOn) return { title, description, isPublished };
    const a = audience.readAudience(b);
    if (a.error) return { error: a.error };
    if (a.provided) isPublished = a.isPublished;
    return { title, description, isPublished, visibility: a.visibility, allowedUserIds: a.allowedUserIds, allowedGroupIds: a.allowedGroupIds, audienceProvided: a.provided };
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
 * Quét header các khung của 1 file-phần mã hoá → danh sách salt (base64url).
 *   readAt(start, len) → Promise<{ buf: Buffer, total: number }>   (total = kích thước cả file-phần)
 * Chỉ đọc 56 byte header mỗi khung rồi nhảy qua ciphertext (ctLen) → không tải cả file.
 */
async function scanFrameSalts(readAt, maxFrames) {
    const MAGIC_LEN = slideCrypto.MAGIC.length, HEAD = slideCrypto.FRAME_HEAD;
    const salts = [];
    let off = MAGIC_LEN, total = null;
    while (total === null || off < total) {
        if (salts.length >= maxFrames) throw new Error('Quá nhiều khung.');
        const r = await readAt(off, HEAD);
        if (total === null) total = r.total;
        if (!r.buf || r.buf.length < HEAD) throw new Error('File mã hoá bị cắt cụt.');
        const ctLen = r.buf.readUInt32BE(8);
        salts.push(r.buf.subarray(12, 28).toString('base64url'));
        off += HEAD + ctLen;
        if (off > total) throw new Error('File mã hoá bị cắt cụt.');
    }
    return salts;
}

// Cache RAM: danh sách salt HỢP LỆ của từng file (chỉ trong instance, 30 phút)
const _saltCache = new Map();   // key → { at, set }
const SALT_TTL_MS = 30 * 60 * 1000;

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
    const itemFilter = (req, scope, extra) => {
        const base = { isDeleted: { $ne: true }, ...(isAdmin(req) ? {} : { isPublished: true }), ...scope.filter, ...(extra || {}) };
        // Ứng dụng có "Chỉ hiển thị với": sinh viên chỉ thấy bản công khai hoặc bản có tên mình trong danh sách
        return app.audience ? audience.withAudience(base, req.user) : base;
    };

    async function countBySubject(req, scope, subjectIds) {
        if (!subjectIds.length) return {};
        const list = await Model.find(itemFilter(req, scope, { subjectId: { $in: subjectIds } })).select('subjectId').lean();
        const out = {};
        for (const s of list) { const k = String(s.subjectId); out[k] = (out[k] || 0) + 1; }
        return out;
    }

    async function loadVisible(req, scope, sid) {
        const rec = isObjectId(sid) ? await Model.findById(sid) : null;
        if (!rec || rec.isDeleted || (!isAdmin(req) && !(app.audience ? audience.canSee(req.user, rec) : rec.isPublished)) || !scope.canAccess(rec)) return null;
        const subject = await findSubject(req, scope, String(rec.subjectId));
        return subject ? { rec, subject } : null;
    }

    const sumPlain = (parts) => (parts || []).reduce((n, p) => n + (p.plain || 0), 0);
    const totalSize = (rec) => rec.fileSize || sumPlain(rec.parts);

    /**
     * Danh sách file của 1 bản ghi: [{ id, name, ext, size, parts }].
     *   • 1 file (mọi bản ghi cũ, Slide, và Tài liệu chỉ có 1 file): lấy từ parts / fileExt / fileSize / originalName như cũ, id = 'main'.
     *   • Nhiều file (chỉ Tài liệu, ≥ 2 file): rec.files.
     */
    function filesOf(rec) {
        if (app.multiFile && rec && Array.isArray(rec.files) && rec.files.length > 1) {
            return rec.files.map((f) => ({ id: f.id, name: f.name || '', ext: f.ext || 'pdf', size: f.size || sumPlain(f.parts), parts: f.parts || [] }));
        }
        if (!rec || !rec.parts || !rec.parts.length) return [];
        return [{ id: 'main', name: rec.originalName || '', ext: rec.fileExt || 'pdf', size: totalSize(rec), parts: rec.parts }];
    }
    const allParts = (rec) => [].concat(...filesOf(rec).map((f) => f.parts));

    // ------------------------------------------------------------
    // GIẢI MÃ Ở TRÌNH DUYỆT: token xin khoá (HMAC, gắn tài khoản + file, hết hạn sau 2 giờ)
    // Khoá gốc không rời server; trình duyệt chỉ nhận khoá riêng của từng khung.
    // ------------------------------------------------------------
    const KEY_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
    const uidOf = (req) => String(req.user._id || req.user.id);
    const keyTokenFields = (req, rec, exp) => ['keytoken', app.key, uidOf(req), String(rec._id), String(exp)];

    function makeKeyToken(req, rec) {
        const exp = Date.now() + KEY_TOKEN_TTL_MS;
        return { exp, token: `${exp}.${slideCrypto.metaSig(keyTokenFields(req, rec, exp))}` };
    }
    function checkKeyToken(req, rec, token) {
        const m = /^(\d{10,16})\.([0-9a-f]{64})$/.exec(String(token || ''));
        if (!m) return false;
        const exp = Number(m[1]);
        if (!(exp > Date.now()) || exp > Date.now() + KEY_TOKEN_TTL_MS + 60 * 1000) return false;
        return slideCrypto.verifyMetaSig(keyTokenFields(req, rec, exp), m[2]);
    }
    /**
     * Thông tin để trình duyệt tải thẳng file mã hoá từ GitHub (repo public). null → dùng cách cũ ?chunk=i
     * ★ File nằm ở repo NÀO do nhóm repo (services/githubPool.js) quyết định: repo chính hoặc <repo>-1, -2… → hỏi repoFor() từng phần.
     */
    async function buildDirect(req, rec, fv) {
        if (!githubService.isConfigured || !slideCrypto.isConfigured()) return null;
        const parts = [];
        for (const p of (fv ? fv.parts : rec.parts)) {
            if (p.store === 'r2') {       // file-phần nằm ở Cloudflare R2: URL public / ký sẵn
                if (!r2.config()) return null;
                parts.push({ path: p.path, plain: p.plain || 0, url: r2.getUrl(p.path) });
                continue;
            }
            let r = null;
            try {
                r = typeof githubService.repoFor === 'function'
                    ? await githubService.repoFor(p.path)
                    : { owner: ghCfg.owner, repo: ghCfg.repo, branch: ghCfg.branch };
            } catch (_) { return null; }
            if (!r || !r.owner || !r.repo || !r.branch) return null;
            parts.push({
                path: p.path, plain: p.plain || 0,
                url: `https://raw.githubusercontent.com/${r.owner}/${r.repo}/${r.branch}/${String(p.path).split('/').map(encodeURIComponent).join('/')}`
            });
        }
        const kt = makeKeyToken(req, rec);
        return { token: kt.token, exp: kt.exp, frameBytes: L.FRAME_PLAIN_BYTES, keyUrl: `${app.base}/keys/${rec._id}`, parts };
    }

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
            const files = filesOf(rec);
            if (!files.length) return renderError(req, res, 404, `${app.name} này chưa có file.`);
            const multi = files.length > 1;
            // Nhiều file: ?f=<id file> chọn file đang xem (mặc định file đầu); 1 file: như cũ
            const fv = (multi && req.query.f && files.find((x) => x.id === String(req.query.f))) || files[0];

            const siblings = await Model.find(itemFilter(req, scope, { subjectId: subject._id }))
                .sort({ createdAt: -1, _id: -1 }).select('title').lean();
            const sl = {
                id: String(rec._id), title: rec.title, description: rec.description || '',
                ext: fv.ext || 'pdf', size: fv.size, viewer: app.viewer,
                fileName: cleanName(fv.name, rec.slug, fv.ext),
                fileUrl: `${app.base}/file/${rec._id}`, fileId: multi ? fv.id : undefined,
                downloadUrl: `${app.base}/file/${rec._id}?download=1${multi ? '&f=' + encodeURIComponent(fv.id) : ''}`,
                chunkBytes: L.SERVE_CHUNK_BYTES,
                direct: await buildDirect(req, rec, fv),
                files: multi ? files.map((x, i) => ({
                    id: x.id, n: i + 1, name: cleanName(x.name, rec.slug, x.ext), ext: x.ext, size: x.size, active: x.id === fv.id,
                    href: `${app.base}/study/${rec._id}?f=${encodeURIComponent(x.id)}`
                })) : [],
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
            const enc = part.store === 'r2' ? await r2.getBuffer(part.path) : await githubService.readBinaryFileLarge(part.path);
            if (!enc) { const e = new Error(part.store === 'r2' ? 'Không đọc được file trên R2.' : 'Không đọc được file trên GitHub.'); e.code = 'MISSING'; throw e; }
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

    /** URL raw GitHub của 1 file-phần (repo public) — null nếu không xác định được. */
    async function rawUrlOf(p) {
        if (p.store === 'r2') { try { return r2.getUrl(p.path); } catch (_) { return null; } }
        try {
            const r = typeof githubService.repoFor === 'function'
                ? await githubService.repoFor(p.path)
                : { owner: ghCfg.owner, repo: ghCfg.repo, branch: ghCfg.branch };
            if (!r || !r.owner || !r.repo || !r.branch) return null;
            return `https://raw.githubusercontent.com/${r.owner}/${r.repo}/${r.branch}/${String(p.path).split('/').map(encodeURIComponent).join('/')}`;
        } catch (_) { return null; }
    }

    /** Salt của 1 file-phần: ưu tiên đọc header qua Range (nhẹ); lỗi → đọc cả file-phần rồi quét. */
    async function saltsOfPart(p) {
        const url = await rawUrlOf(p);
        if (url) {
            try {
                const readAt = async (start, len) => {
                    const r = await fetch(url, { headers: { Range: `bytes=${start}-${start + len - 1}` }, signal: AbortSignal.timeout(10000) });
                    if (r.status !== 206) throw new Error(`Range HTTP ${r.status}`);
                    const m = /\/(\d+)$/.exec(r.headers.get('content-range') || '');
                    if (!m) throw new Error('Thiếu Content-Range');
                    return { buf: Buffer.from(await r.arrayBuffer()), total: Number(m[1]) };
                };
                return await scanFrameSalts(readAt, L.MAX_FRAMES);
            } catch (_) { /* rơi xuống đường dự phòng */ }
        }
        const enc = p.store === 'r2' ? await r2.getBuffer(p.path) : await githubService.readBinaryFileLarge(p.path);
        if (!enc) throw new Error('Không đọc được file trên ' + (p.store === 'r2' ? 'R2.' : 'GitHub.'));
        return scanFrameSalts(async (start, len) => ({ buf: enc.subarray(start, start + len), total: enc.length }), L.MAX_FRAMES);
    }

    /** Tập salt HỢP LỆ của file (mọi file-phần). Khoá chỉ được cấp cho salt nằm trong tập này. */
    async function allowedSalts(rec) {
        const parts = allParts(rec);
        const key = `${rec._id}|${parts.map((p) => p.path).join(',')}|${rec.githubSha || ''}`;
        const hit = _saltCache.get(key);
        if (hit && Date.now() - hit.at < SALT_TTL_MS) return hit.set;
        const lists = await Promise.all(parts.map(saltsOfPart));
        const set = new Set([].concat(...lists));
        const now = Date.now();
        for (const [k, v] of _saltCache) if (now - v.at > SALT_TTL_MS) _saltCache.delete(k);
        if (_saltCache.size > 200) _saltCache.clear();
        _saltCache.set(key, { at: now, set });
        return set;
    }

    /** POST {base}/keys/:sid  body { token, salts: [base64url(16 byte), …] } → { keys: [base64url(32 byte), …] } */
    ctrl.keys = async (req, res) => {
        res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
        try {
            if (!(await canUse(req))) return fail(res, 403, 'Không có quyền.');
            const scope = await getContentScope(req);
            const found = await loadVisible(req, scope, req.params.sid);
            if (!found || !filesOf(found.rec).length) return fail(res, 404, 'Không tìm thấy.');
            const { rec } = found;
            const b = req.body || {};

            let okToken = false;
            try { okToken = checkKeyToken(req, rec, b.token); } catch (_) { okToken = false; }
            if (!okToken) return fail(res, 401, 'Phiên xem đã hết hạn — hãy tải lại trang.', { expired: true });

            // Số salt tối đa = số khung của file (+1 dự phòng); salt = 16 byte base64url = 22 ký tự
            const per = L.FRAME_PLAIN_BYTES || 2 * cfg.MB;
            const maxFrames = Math.max(1, Math.ceil(totalSize(rec) / per)) + 1;
            const salts = Array.isArray(b.salts) ? b.salts : null;
            if (!salts || !salts.length || salts.length > maxFrames
                || !salts.every((s) => typeof s === 'string' && /^[A-Za-z0-9_-]{22}$/.test(s))) {
                return fail(res, 400, 'Danh sách salt không hợp lệ.');
            }

            // ★ Chỉ cấp khoá cho salt THUỘC ĐÚNG file này (repo public → salt của file khác ai cũng đọc được)
            let allowed;
            try { allowed = await allowedSalts(rec); } catch (e) {
                console.error(`[${app.key}.keys] không đọc được salt của file ${rec._id}:`, e.message);
                return fail(res, 503, 'Chưa kiểm tra được salt — dùng đường tải qua máy chủ.');
            }
            if (!salts.every((s) => allowed.has(s))) {
                console.warn(`[${app.key}.keys] TỪ CHỐI user=${uidOf(req)} file=${rec._id}: salt không thuộc file`);
                return fail(res, 403, 'Salt không thuộc file này.');
            }

            const keys = slideCrypto.deriveFrameKeys(salts);
            console.log(`[${app.key}.keys] user=${uidOf(req)} file=${rec._id} frames=${salts.length}`);
            return res.json({ success: true, keys });
        } catch (e) {
            console.error(`[${app.key}.keys]`, e.message);
            return fail(res, 500, 'Không cấp được khoá.');
        }
    };

    ctrl.file = async (req, res) => {
        try {
            if (!(await canUse(req))) return res.status(403).type('text/plain').send('Không có quyền.');
            await githubSync.syncKinds([app.key]);
            const scope = await getContentScope(req);
            const found = await loadVisible(req, scope, req.params.sid);
            const files = found ? filesOf(found.rec) : [];
            if (!found || !files.length) return res.status(404).type('text/plain').send('Không tìm thấy.');
            const { rec } = found;
            // Nhiều file: ?f=<id file>; không truyền → file đầu (1 file: y như cũ)
            let fv = files[0];
            if (req.query.f !== undefined) {
                fv = files.find((x) => x.id === String(req.query.f));
                if (!fv) return res.status(404).type('text/plain').send('Không tìm thấy file.');
            }
            const frec = { parts: fv.parts, githubSha: rec.githubSha };      // "bản ghi 1 file" để loadPart / readRange dùng
            const total = fv.size;
            const common = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };

            try {
                if (req.query.chunk !== undefined) {
                    const per = L.SERVE_CHUNK_BYTES;
                    const count = Math.max(1, Math.ceil(total / per));
                    const i = Number(req.query.chunk);
                    if (!Number.isInteger(i) || i < 0 || i >= count) return res.status(400).type('text/plain').send('Phần không hợp lệ.');
                    const part = await readRange(frec, i * per, Math.min(total, (i + 1) * per));
                    res.status(200).set(Object.assign({
                        'Content-Type': 'application/octet-stream', 'Content-Length': String(part.length),
                        'X-Total-Size': String(total), 'X-Chunk-Count': String(count), 'X-Chunk-Index': String(i)
                    }, common));
                    return res.end(part);
                }

                const name = cleanName(fv.name, rec.slug, fv.ext);
                const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '_');
                res.status(200).set(Object.assign({
                    'Content-Type': cfg.EXT_MIME[fv.ext] || 'application/octet-stream',
                    'Content-Length': String(total),
                    'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
                }, common));
                // Nối liền mạch từng file-phần (file lớn: ghi lần lượt, không giữ cả file trong RAM)
                for (let i = 0; i < frec.parts.length; i++) res.write(await loadPart(frec, i));
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
            // Nhiều file / tài liệu (chỉ ứng dụng multiFile): danh sách file hiện có để quản lý (xoá / đổi thứ tự / thêm)
            multi: !!app.multiFile, maxFiles: L.MAX_FILES,
            files: rec && app.multiFile ? filesOf(rec).map((f) => ({ id: f.id, name: cleanName(f.name, rec.slug, f.ext), size: f.size, count: f.parts.length })) : [],
            // "Chỉ hiển thị với" (chỉ ứng dụng audience)
            audience: app.audience ? await audience.formState(req, rec) : null,
            searchUrl: `${app.base}/dashboard/users`,
            maxBytes: L.MAX_FILE_BYTES, frameBytes: L.FRAME_PLAIN_BYTES, frameOverhead: L.FRAME_OVERHEAD,
            magicBytes: L.FILE_MAGIC_BYTES, partMaxBytes: L.PART_MAX_BYTES, maxFrames: L.MAX_FRAMES,
            encryptionReady: slideCrypto.isConfigured(),
            direct: r2.isConfigured() || (await ghDirectOn()),          // R2 đã cấu hình → up THẲNG lên R2; hoặc đã nhập GitHub App ở /connect → up THẲNG lên GitHub bằng token tạm (đều không qua Vercel)
            converterUrl: process.env.PPTX_CONVERTER_URL || '',       // dịch vụ đổi PPTX → PDF (converter/server.py); rỗng = up PPTX nguyên bản
            converterToken: process.env.PPTX_CONVERTER_TOKEN || '',
            sha: rec ? ((await githubService.readJsonFileWithSha(rec.githubFile).catch(() => null)) || {}).sha || null : null
        };
        return res.render('studyfiles/form', {
            title: rec ? `Sửa ${app.noun}` : `Up ${app.noun}`, user: req.user, app, editing: !!rec, subjects,
            maxMb: mb(L.MAX_FILE_BYTES), partMb: mb(L.PART_MAX_BYTES), slStateJson: safeJson(state)
        });
    }

    /** GET {base}/dashboard/users?q= — tìm sinh viên để chọn "Chỉ hiển thị với" (chỉ ứng dụng audience). */
    ctrl.searchUsers = (req, res) => (app.audience ? audience.searchUsers(req, res) : fail(res, 404, 'Không có chức năng này.'));

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
    // UP: bước 0 — cấp khoá khung cho TRÌNH DUYỆT tự mã hoá (admin)
    //   Trình duyệt tự sinh salt (16 byte) + IV; server chỉ tính khoá khung = HKDF(master, salt) rồi trả về.
    //   Server KHÔNG nhận file gốc ở bước này và không mã hoá gì cả.
    // ------------------------------------------------------------
    const UPLOAD_KEYS_MAX = 16;
    ctrl.uploadKeys = async (req, res) => {
        res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
        try {
            if (!slideCrypto.isConfigured()) return fail(res, 503, 'Chưa cấu hình ENCRYPTION_MASTER_KEY (64 ký tự hex) nên chưa cấp được khoá mã hoá.');
            const salts = req.body && req.body.salts;
            if (!Array.isArray(salts) || !salts.length || salts.length > UPLOAD_KEYS_MAX
                || !salts.every((x) => typeof x === 'string' && /^[A-Za-z0-9_-]{22}$/.test(x))) {
                return fail(res, 400, 'Danh sách salt không hợp lệ.');
            }
            if (new Set(salts).size !== salts.length) return fail(res, 400, 'Salt bị trùng.');
            return res.json({ success: true, keys: slideCrypto.deriveFrameKeys(salts) });
        } catch (e) {
            console.error(`[${app.key}.uploadKeys]`, e.message);
            return fail(res, 500, 'Không cấp được khoá.');
        }
    };

    // ------------------------------------------------------------
    // UP: bước 1 — nhận 1 KHUNG ĐÃ MÃ HOÁ SẴN ở trình duyệt (octet-stream) → blob GitHub tạm
    //   POST ...?index=&total=&ext=   body = khung nhị phân (index|total|ctLen|salt|iv|tag|ciphertext)
    //   Server không mã hoá: chỉ kiểm tra cấu trúc; khung 0 được giải mã thử để bắt sớm lỗi khoá / định dạng sai.
    //   (Đường cũ — gửi JSON {data:base64} để server mã hoá — mặc định TẮT; bật bằng ALLOW_SERVER_ENCRYPT=1.)
    // ------------------------------------------------------------
    ctrl.uploadChunk = async (req, res) => {
        try {
            const q = req.query || {};
            const b = req.body || {};
            const isFrame = Buffer.isBuffer(req.body);
            const index = Number(isFrame ? q.index : b.index), total = Number(isFrame ? q.total : b.total);
            const ext = String((isFrame ? q.ext : b.ext) || '').toLowerCase();
            if (!app.exts.includes(ext)) return fail(res, 400, `Chỉ nhận định dạng: ${app.exts.map((x) => '.' + x).join(', ')}.`);
            if (!Number.isInteger(total) || total < 1 || total > L.MAX_FRAMES) return fail(res, 413, tooBig());
            if (!Number.isInteger(index) || index < 0 || index >= total) return fail(res, 400, 'Số thứ tự phần không hợp lệ.');
            if (!githubService.isConfigured) return fail(res, 503, 'GitHub chưa cấu hình nên chưa lưu được file.');
            if (!slideCrypto.isConfigured()) return fail(res, 503, 'Chưa cấu hình ENCRYPTION_MASTER_KEY (64 ký tự hex).');

            if (isFrame) {
                const buf = req.body;
                const HEAD = slideCrypto.FRAME_HEAD;
                if (buf.length <= HEAD) return fail(res, 400, 'Khung dữ liệu rỗng.');
                if (buf.length > L.FRAME_PLAIN_BYTES + L.FRAME_OVERHEAD) return fail(res, 413, 'Khung dữ liệu vượt quá kích thước cho phép.');
                const fIndex = buf.readUInt32BE(0), fTotal = buf.readUInt32BE(4), ctLen = buf.readUInt32BE(8);
                if (fIndex !== index || fTotal !== total) return fail(res, 400, 'Thông tin khung không khớp thứ tự.');
                if (ctLen < 1 || buf.length !== HEAD + ctLen) return fail(res, 400, 'Khung dữ liệu sai cấu trúc.');
                if (index === 0) {
                    let d;
                    try { d = slideCrypto.decryptFrame(buf); }
                    catch (e) { return fail(res, 400, 'Khung đầu không giải mã được — khoá/định dạng mã hoá ở trình duyệt không khớp máy chủ.'); }
                    if (!magicOk(d.plain, ext)) return fail(res, 400, `File gửi lên không phải .${ext} hợp lệ.`);
                }
                const sha = await githubService.createBlob(buf);
                return res.json({ success: true, sha });
            }

            // ----- đường cũ: server mã hoá (mặc định tắt) -----
            if (process.env.ALLOW_SERVER_ENCRYPT !== '1') {
                return fail(res, 410, 'Bản trang cũ đã hết hỗ trợ (mã hoá nay chạy trong trình duyệt). Hãy tải lại trang (Ctrl+F5) rồi up lại.');
            }
            if (typeof b.data !== 'string' || !b.data) return fail(res, 400, 'Phần dữ liệu rỗng.');
            const b64 = b.data.replace(/\s+/g, '');
            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return fail(res, 400, 'Dữ liệu gửi lên không hợp lệ.');
            if (Math.floor(b64.length * 3 / 4) > L.FRAME_PLAIN_BYTES + 3) return fail(res, 413, 'Phần dữ liệu vượt quá kích thước cho phép.');
            const plainBuf = Buffer.from(b64, 'base64');
            if (!plainBuf.length) return fail(res, 400, 'Phần dữ liệu rỗng.');
            if (plainBuf.length > L.FRAME_PLAIN_BYTES) return fail(res, 413, 'Phần dữ liệu vượt quá kích thước cho phép.');
            if (index === 0 && !magicOk(plainBuf, ext)) return fail(res, 400, `File gửi lên không phải .${ext} hợp lệ.`);
            const sha = await githubService.createBlob(slideCrypto.encryptFrame(plainBuf, index, total));
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

    // ------------------------------------------------------------
    // UP THẲNG LÊN R2 (không qua băng thông Vercel) — chỉ khi r2.isConfigured()
    //   direct-init : server tính cách chia file-phần (cùng groupFrames với trình duyệt) rồi cấp URL PUT ký sẵn cho từng file-phần
    //   (trình duyệt tự mã hoá SLD2, ghép magic + khung, PUT thẳng lên R2)
    //   direct-done : server HEAD + đọc header (và giải thử khung 0 của file-phần đầu) rồi trả chữ ký như upload-part (thêm 'r2')
    //   Sau đó create / update ghi JSON như cũ (parts[i].store = 'r2').
    // ------------------------------------------------------------
    // ---- Up THẲNG lên GitHub (không có R2): trình duyệt tạo BLOB bản mã trên api.github.com bằng TOKEN TẠM của GitHub App (1 giờ, 1 repo, Contents:write;
    //      PAT thật không rời server) → direct-done gom các blob vào MỘT commit rồi kiểm tra header / giải thử khung 0 như đường R2.
    const appTok = () => require('../services/githubAppToken');
    const ghDirectOn = async () => process.env.STUDYFILE_DIRECT !== 'off' && process.env.GH_DIRECT !== 'off' && (await appTok().isConfigured().catch(() => false));
    async function ghTicket() {
        let rec = { owner: githubService.owner || ghCfg.owner, repo: githubService.repo || ghCfg.repo, branch: githubService.branch || ghCfg.branch };
        try { if (githubService.pooled && githubService.pool && typeof githubService.pool.active === 'function') { const a = await githubService.pool.active(); if (a && a.owner && a.repo) rec = { owner: a.owner, repo: a.repo, branch: a.branch || rec.branch }; } } catch (_) { /* dùng repo chính */ }
        if (!rec.owner || !rec.repo) throw new Error('Chưa xác định được repo GitHub để nhận file.');
        const t = await appTok().mintForRepo(rec.owner, rec.repo);
        return { owner: rec.owner, repo: rec.repo, branch: rec.branch || 'main', token: t.token, expiresAt: t.expiresAt };
    }
    /** Đọc [start, start+len) của file-phần vừa commit: ưu tiên raw GitHub + Range (nhẹ, repo public); không được → tải blob theo sha. */
    async function ghReadRange(path, sha, start, len) {
        const url = await rawUrlOf({ path });
        if (url) {
            for (let k = 0; k < 3; k++) {
                try {
                    const r = await fetch(url, { headers: { Range: `bytes=${start}-${start + len - 1}` }, signal: AbortSignal.timeout(10000) });
                    if (r.status === 206) {
                        const m = /\/(\d+)$/.exec((r.headers && r.headers.get && r.headers.get('content-range')) || '');
                        return { buf: Buffer.from(await r.arrayBuffer()), total: m ? Number(m[1]) : null };
                    }
                } catch (_) { /* thử lại / dự phòng */ }
                await new Promise((ok) => setTimeout(ok, 400 * (k + 1)));
            }
        }
        const all = await githubService.getBlobBuffer(sha);
        if (!all) return null;
        return { buf: all.subarray(start, start + len), total: all.length };
    }

    async function directPlan(req, res) {
        const b = req.body || {};
        const ext = String(b.ext || '').toLowerCase();
        const uid = String(b.uid || '');
        const ts = Number(b.ts), size = Number(b.size);
        const useGh = !r2.isConfigured();
        if (useGh && !(await ghDirectOn())) { fail(res, 503, 'Chưa cấu hình Cloudflare R2 hoặc GitHub App (nhập ở /connect) — hãy dùng cách up thường.'); return null; }
        if (!app.exts.includes(ext)) { fail(res, 400, `Chỉ nhận định dạng: ${app.exts.map((x) => '.' + x).join(', ')}.`); return null; }
        if (!UID_RE.test(uid) || !checkTs(ts)) { fail(res, 400, 'Phiên upload không hợp lệ. Hãy tải lại trang.'); return null; }
        if (!Number.isInteger(size) || size <= 0) { fail(res, 400, 'File rỗng hoặc kích thước không hợp lệ.'); return null; }
        if (size > L.MAX_FILE_BYTES) { fail(res, 413, tooBig()); return null; }
        if (!slideCrypto.isConfigured()) { fail(res, 503, 'Chưa cấu hình ENCRYPTION_MASTER_KEY (64 ký tự hex) nên chưa mã hoá được file.'); return null; }
        const scope = await getContentScope(req);
        const ctx = await resolveContext(req, scope);
        if (ctx.error) { fail(res, ctx.error[0], ctx.error[1]); return null; }
        const f = readForm(b);
        if (f.error && !ctx.rec) { fail(res, 400, f.error); return null; }
        await githubSync.syncKinds([app.key]);
        const slug = await resolveSlug(ctx.subject, f.title || '', uid, ctx.rec);
        const base = `subjects/${ctx.subject.slug}/${app.dir}/${slug}_${ts}`;
        const sizes = cfg.frameSizes(size), total = sizes.length;
        const groups = cfg.groupFrames(sizes);
        const parts = groups.map((g, k) => {
            let plain = 0, enc = L.FILE_MAGIC_BYTES;
            for (let i = g.startFrame; i < g.startFrame + g.count; i++) { plain += sizes[i]; enc += sizes[i] + L.FRAME_OVERHEAD; }
            return { path: partPath(base, ext, k, groups.length), enc, plain, startFrame: g.startFrame, count: g.count };
        });
        return { ext, uid, total, sizes, parts, useGh };
    }

    ctrl.directInit = async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            const plan = await directPlan(req, res);
            if (!plan) return undefined;
            if (plan.useGh) {
                let gh;
                try { gh = await ghTicket(); } catch (e) { return fail(res, 503, 'Không cấp được token tạm cho GitHub: ' + e.message); }
                return res.json({ success: true, mode: 'github', gh, parts: plan.parts.map((p) => ({ path: p.path, enc: p.enc, plain: p.plain, startFrame: p.startFrame, count: p.count })) });
            }
            return res.json({ success: true, mode: 'r2', parts: plan.parts.map((p) => ({ path: p.path, enc: p.enc, plain: p.plain, startFrame: p.startFrame, count: p.count, url: r2.putUrl(p.path) })) });
        } catch (e) {
            console.error(`[${app.key}.directInit]`, e);
            return fail(res, 500, 'Lỗi máy chủ khi cấp URL tải lên.');
        }
    };

    /** direct-done (GitHub): body.shas[k] = sha blob của file-phần k (trình duyệt đã tạo). Gom vào MỘT commit → kiểm size/header/khung 0 → chữ ký. */
    async function directDoneGithub(req, res, plan) {
        const shas = (req.body || {}).shas;
        if (!Array.isArray(shas) || shas.length !== plan.parts.length || !shas.every((x) => typeof x === 'string' && /^[0-9a-f]{40}$/.test(x))) {
            return fail(res, 400, 'Danh sách blob của các file-phần không hợp lệ. Hãy up lại.');
        }
        await githubService.commitFiles(plan.parts.map((p, k) => ({ path: p.path, sha: shas[k] })), `${app.name}: lưu file mã hoá (${plan.parts.length} file-phần)`);
        const out = [];
        const drop = async (path) => { await githubService.deleteFile(path, `${app.name}: xoá file-phần lỗi`).catch(() => { }); };
        for (let k = 0; k < plan.parts.length; k++) {
            const p = plan.parts[k];
            const hd = await ghReadRange(p.path, shas[k], 0, L.FILE_MAGIC_BYTES + 12);
            if (!hd) { await drop(p.path); return fail(res, 422, `Không đọc lại được file-phần ${k + 1}/${plan.parts.length} trên GitHub. Hãy up lại.`); }
            if (hd.total != null && hd.total !== p.enc) { await drop(p.path); return fail(res, 422, `File-phần ${k + 1} sai kích thước (${hd.total} ≠ ${p.enc}) — đã xoá. Hãy up lại.`); }
            const head = hd.buf;
            const bad = !head || head.length < L.FILE_MAGIC_BYTES + 12 || head.subarray(0, 4).toString('latin1') !== 'SLD2'
                || head.readUInt32BE(4) !== p.startFrame || head.readUInt32BE(8) !== plan.total || head.readUInt32BE(12) !== plan.sizes[p.startFrame];
            if (bad) { await drop(p.path); return fail(res, 422, `File-phần ${k + 1} không đúng định dạng mã hoá — đã xoá. Hãy up lại.`); }
            if (k === 0) {
                try {
                    const fr = await ghReadRange(p.path, shas[k], L.FILE_MAGIC_BYTES, plan.sizes[0] + L.FRAME_OVERHEAD);
                    const d = slideCrypto.decryptFrame(fr.buf);
                    if (d.index !== 0 || d.total !== plan.total) throw new Error('khung 0 sai thứ tự');
                    if (!magicOk(d.plain, plan.ext)) { await drop(p.path); return fail(res, 400, `File gửi lên không phải .${plan.ext} hợp lệ.`); }
                } catch (e) {
                    await drop(p.path);
                    return fail(res, 422, 'Không xác thực được dữ liệu đã up (' + e.message + '). Hãy up lại.');
                }
            }
            const sig = slideCrypto.metaSig([app.key, plan.uid, p.path, p.startFrame, p.count, plan.total, p.enc, p.plain]);
            out.push({ path: p.path, enc: p.enc, plain: p.plain, startFrame: p.startFrame, count: p.count, sig });
        }
        return res.json({ success: true, parts: out });
    }

    ctrl.directDone = async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            const plan = await directPlan(req, res);
            if (!plan) return undefined;
            if (plan.useGh) return await directDoneGithub(req, res, plan);
            const out = [];
            for (let k = 0; k < plan.parts.length; k++) {
                const p = plan.parts[k];
                const h = await r2.head(p.path);
                if (!h) return fail(res, 400, `Thiếu file-phần ${k + 1}/${plan.parts.length} trên R2. Hãy up lại.`);
                if (h.size !== p.enc) {
                    await r2.remove(p.path).catch(() => {});
                    return fail(res, 422, `File-phần ${k + 1} sai kích thước (${h.size} ≠ ${p.enc}) — đã xoá. Hãy up lại.`);
                }
                // header: magic "SLD2" + khung đầu (index | total | ctLen) phải đúng vị trí; file-phần đầu: giải thử khung 0 để bắt khoá/định dạng sai
                const head = await r2.readRange(p.path, 0, L.FILE_MAGIC_BYTES + 12);
                const bad = !head || head.length < L.FILE_MAGIC_BYTES + 12 || head.subarray(0, 4).toString('latin1') !== 'SLD2'
                    || head.readUInt32BE(4) !== p.startFrame || head.readUInt32BE(8) !== plan.total || head.readUInt32BE(12) !== plan.sizes[p.startFrame];
                if (bad) { await r2.remove(p.path).catch(() => {}); return fail(res, 422, `File-phần ${k + 1} không đúng định dạng mã hoá — đã xoá. Hãy up lại.`); }
                if (k === 0) {
                    try {
                        const buf = await r2.readRange(p.path, L.FILE_MAGIC_BYTES, plan.sizes[0] + L.FRAME_OVERHEAD);
                        const d = slideCrypto.decryptFrame(buf);
                        if (d.index !== 0 || d.total !== plan.total) throw new Error('khung 0 sai thứ tự');
                        if (!magicOk(d.plain, plan.ext)) { await r2.remove(p.path).catch(() => {}); return fail(res, 400, `File gửi lên không phải .${plan.ext} hợp lệ.`); }
                    } catch (e) {
                        await r2.remove(p.path).catch(() => {});
                        return fail(res, 422, 'Không xác thực được dữ liệu đã up (' + e.message + '). Hãy up lại.');
                    }
                }
                const sig = slideCrypto.metaSig([app.key, plan.uid, p.path, p.startFrame, p.count, plan.total, p.enc, p.plain, 'r2']);
                out.push({ path: p.path, enc: p.enc, plain: p.plain, startFrame: p.startFrame, count: p.count, sig, store: 'r2' });
            }
            return res.json({ success: true, parts: out });
        } catch (e) {
            console.error(`[${app.key}.directDone]`, e);
            return fail(res, 500, 'Lỗi máy chủ khi xác nhận file trên R2.');
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
            const onR2 = x.store === 'r2';       // file-phần đã được trình duyệt up thẳng lên R2 (chữ ký có thêm 'r2' nên không khai man được)
            if (!slideCrypto.verifyMetaSig([app.key, uid, expectPath, x.startFrame, x.count, totalFrames, x.enc, x.plain].concat(onR2 ? ['r2'] : []), x.sig)) {
                return { error: 'Chữ ký file-phần không hợp lệ. Hãy up lại.' };
            }
            if (x.enc > L.PART_MAX_BYTES) return { error: 'File-phần vượt giới hạn. Hãy up lại.' };
            next += x.count; size += x.plain;
            parts.push({ path: expectPath, enc: x.enc, plain: x.plain, ...(onR2 ? { store: 'r2' } : {}) });
        }
        if (totalFrames > L.MAX_FRAMES || size > L.MAX_FILE_BYTES) return { error: tooBig() };
        if (size <= 0) return { error: 'File rỗng.' };
        return { parts, size, ext, base, originalName: cleanName(p.name, slug, ext) };
    }

    /**
     * Danh sách file của form nhiều file (ứng dụng multiFile): body.items = [{ keep: '<id file đang có>' } | { file: <thông tin file vừa up> }] theo THỨ TỰ hiển thị.
     * Mỗi { file } được kiểm tra y như checkFile (chữ ký HMAC, đường dẫn, kích thước). Trả cùng dạng với checkFile, thêm:
     *   files    : mảng file (chỉ khi ≥ 2 file; 1 file → null = lưu kiểu cũ)
     *   newParts : các file-phần MỚI ghi (để dọn khi lỗi)
     */
    async function checkItems(body, ctx) {
        const items = body && body.items;
        if (!Array.isArray(items) || !items.length) return { error: `Cần ít nhất 1 file ${app.noun}.` };
        if (items.length > L.MAX_FILES) return { error: `Mỗi ${app.noun} tối đa ${L.MAX_FILES} file.` };
        const have = new Map(filesOf(ctx.rec).map((x) => [x.id, x]));
        const used = new Set(), paths = new Set(), list = [], fresh = [];
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            let f;
            if (it && typeof it.keep === 'string') {
                const old = have.get(it.keep);
                if (!old || used.has(it.keep)) return { error: 'File giữ lại không còn tồn tại. Hãy tải lại trang rồi thử lại.' };
                used.add(it.keep);
                f = { id: old.id, name: old.name, ext: old.ext, size: old.size, parts: old.parts, base: null };
            } else if (it && it.file && typeof it.file === 'object') {
                const chk = await checkFile({ file: it.file, title: body.title }, ctx);
                if (chk.error) return { error: items.length > 1 ? `File ${i + 1}: ${chk.error}` : chk.error };
                if (chk.none) return { error: 'Danh sách file không hợp lệ.' };
                f = { id: null, name: chk.originalName, ext: chk.ext, size: chk.size, parts: chk.parts, base: chk.base };
                fresh.push(...chk.parts);
            } else {
                return { error: 'Danh sách file không hợp lệ.' };
            }
            for (const p of f.parts) {
                if (paths.has(p.path)) return { error: 'Có file bị trùng đường dẫn. Hãy up lại.' };
                paths.add(p.path);
            }
            list.push(f);
        }
        // id cho file mới / file "main" cũ (khi tài liệu 1 file được thêm file thứ 2)
        const ids = new Set(list.filter((f) => f.id && f.id !== 'main').map((f) => f.id));
        for (const f of list) {
            if (f.id && f.id !== 'main') continue;
            let id;
            do { id = 'f' + crypto.randomBytes(4).toString('hex'); } while (ids.has(id));
            ids.add(id); f.id = id;
        }
        const head = list[0];
        const firstNew = list.find((f) => f.base);
        return {
            parts: head.parts, ext: head.ext, originalName: head.name,
            size: list.length > 1 ? list.reduce((n, f) => n + f.size, 0) : head.size,
            base: firstNew ? firstNew.base : null,
            files: list.length > 1 ? list.map((f) => ({ id: f.id, name: f.name, ext: f.ext, size: f.size, parts: f.parts })) : null,
            newParts: fresh
        };
    }

    /** Trường file ghi vào bản ghi (RAM): 1 file → như cũ; nhiều file → thêm files. */
    const recFileFields = (chk) => Object.assign(
        { parts: chk.parts, fileExt: chk.ext, fileSize: chk.size, originalName: chk.originalName },
        app.multiFile ? { files: chk.files || [] } : {}
    );
    /** Trường file ghi vào JSON GitHub (1 file → không có khoá files, giống hệt định dạng cũ). */
    const jsonFileFields = (chk) => Object.assign(recFileFields(chk), app.multiFile ? { files: chk.files || undefined } : {});

    const delPaths = (paths, msg) => Promise.all(paths.map((p) => githubService.deleteFile(p, msg).catch(() => {})));
    /** Xoá các file-phần (GitHub hoặc R2 tuỳ `store`). */
    const delParts = (list, msg) => Promise.all((list || []).map((x) => (x.store === 'r2'
        ? r2.remove(x.path).catch((e) => console.warn(`[${app.key}] không xoá được R2 ${x.path}:`, e.message))
        : githubService.deleteFile(x.path, msg).catch(() => {}))));

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
            const f = readForm(req.body, app.audience);
            if (f.error) return fail(res, 400, f.error);
            if (!githubService.isConfigured) return fail(res, 503, 'GitHub chưa cấu hình nên chưa lưu được file.');
            if (!slideCrypto.isConfigured()) return fail(res, 503, 'Chưa cấu hình ENCRYPTION_MASTER_KEY (64 ký tự hex).');
            let au = null;
            if (app.audience) {
                au = await audience.resolveAudienceTargets(req, f);     // người + nhóm (người đã nằm trong nhóm được chọn thì bỏ)
                if (au.error) return fail(res, 400, au.error);
            }

            await githubSync.syncKinds([app.key]);
            // Form nhiều file gửi items[]; form cũ / Slide gửi file (1 file)
            const multiReq = !!app.multiFile && Array.isArray((req.body || {}).items);
            const chk = multiReq
                ? await checkItems(Object.assign({}, req.body, { title: f.title }), ctx)
                : await checkFile(Object.assign({}, req.body, { title: f.title }), ctx);
            if (chk.none) return fail(res, 400, `Vui lòng chọn file ${app.noun}.`);
            if (chk.error) return fail(res, chk.error.includes('quá nặng') ? 413 : 400, chk.error);
            if (multiReq && !chk.base) return fail(res, 400, `Vui lòng chọn file ${app.noun}.`);
            written = chk.newParts || chk.parts;

            const jsonFile = `${chk.base}.json`;
            if (await githubService.fileExists(jsonFile)) return fail(res, 409, 'Đã có file trùng đường dẫn trên GitHub, hãy thử lại.');

            const id = new mongoose.Types.ObjectId();
            const slug = chk.base.split('/').pop().replace(/_\d+$/, '');
            const nowIso = new Date().toISOString();
            const w = await githubService.writeJsonFile(jsonFile, {
                type: app.key === 'slides' ? 'slide' : 'document',
                [app.idKey]: String(id),
                title: f.title, slug, subjectSlug: ctx.subject.slug, description: f.description,
                ...jsonFileFields(chk),
                encrypted: true, encryption: 'aes-256-gcm',
                order: 0, isPublished: f.isPublished, ...(au ? { visibility: f.visibility, allowedUserIds: au.ids, allowedGroupIds: au.groupIds } : {}),
                isDeleted: false, deletedAt: null, deletedBy: null,
                createdBy: String(req.user._id), updatedBy: String(req.user._id), createdAt: nowIso, updatedAt: nowIso
            }, `${app.name}: tạo "${f.title}"`);

            const rec = await Model.create({
                _id: id, githubSha: w && w.sha ? w.sha : null,
                subjectId: ctx.subject._id, title: f.title, slug, description: f.description, githubFile: jsonFile,
                ...recFileFields(chk),
                isPublished: f.isPublished, ...(au ? { visibility: f.visibility, allowedUserIds: au.ids, allowedGroupIds: au.groupIds } : {}),
                userKey: ctx.subject.userKey || null,
                createdBy: req.user._id, updatedBy: req.user._id
            });
            return res.json({ success: true, id: String(rec._id), redirect: `${app.base}/dashboard` });
        } catch (e) {
            console.error(`[${app.key}.create]`, e);
            if (written.length) await delParts(written, `${app.name}: gỡ file mồ côi`);     // JSON không ghi được → gỡ file mã hoá mồ côi
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
            const f = readForm(req.body, app.audience);
            if (f.error) return fail(res, 400, f.error);
            // "Chỉ hiển thị với": form không gửi gì → giữ nguyên chế độ hiện tại
            let aud = null;
            if (app.audience) {
                if (f.audienceProvided) {
                    const au = await audience.resolveAudienceTargets(req, f);
                    if (au.error) return fail(res, 400, au.error);
                    aud = { visibility: f.visibility, allowedUserIds: au.ids, allowedGroupIds: au.groupIds, isPublished: f.isPublished };
                } else {
                    aud = { visibility: audience.visibilityOf(rec), allowedUserIds: (rec.allowedUserIds || []).map(String), allowedGroupIds: (rec.allowedGroupIds || []).map(String), isPublished: rec.isPublished !== false };
                }
            }

            const multiReq = !!app.multiFile && Array.isArray((req.body || {}).items);
            const chk = multiReq
                ? await checkItems(Object.assign({}, req.body, { title: f.title }), ctx)
                : await checkFile(Object.assign({}, req.body, { title: f.title }), ctx);
            if (chk.error) return fail(res, chk.error.includes('quá nặng') ? 413 : 400, chk.error);
            if (!chk.none) newPaths = (chk.newParts || chk.parts).map((x) => x.path);

            const file = await githubService.readJsonFileWithSha(rec.githubFile);
            if (!file) return fail(res, 404, 'Không đọc được dữ liệu trên GitHub.');
            if (req.body.sha && req.body.sha !== file.sha) return fail(res, 409, 'Đã bị người khác sửa. Hãy tải lại trang.');

            const oldParts = allParts(rec).map((x) => ({ path: x.path, store: x.store }));
            const fileFields = chk.none ? {} : Object.assign(jsonFileFields(chk), { encrypted: true, encryption: 'aes-256-gcm' });
            const isPublished = aud ? aud.isPublished : f.isPublished;
            const written = await githubService.writeJsonFileIfSha(rec.githubFile, Object.assign({}, file.data, {
                type: app.key === 'slides' ? 'slide' : 'document',
                title: f.title, description: f.description, isPublished,
                ...(aud ? { visibility: aud.visibility, allowedUserIds: aud.allowedUserIds, allowedGroupIds: aud.allowedGroupIds } : {}),
                subjectSlug: ctx.subject.slug, updatedBy: String(req.user._id), updatedAt: new Date().toISOString()
            }, fileFields), file.sha, `${app.name}: sửa "${f.title}"`);

            rec.title = f.title; rec.description = f.description; rec.isPublished = isPublished;
            if (aud) { rec.visibility = aud.visibility; rec.allowedUserIds = aud.allowedUserIds; rec.allowedGroupIds = aud.allowedGroupIds; }
            rec.updatedBy = req.user._id;
            if (!chk.none) {
                const ff = recFileFields(chk);
                rec.parts = ff.parts; rec.fileExt = ff.fileExt; rec.fileSize = ff.fileSize; rec.originalName = ff.originalName;
                if (app.multiFile) rec.files = ff.files;
            }
            rec.githubSha = written && written.sha ? written.sha : rec.githubSha;
            await rec.save();

            // File cũ không còn dùng → xoá (JSON đã trỏ sang file mới nên lỗi ở đây không làm hỏng dữ liệu)
            if (!chk.none) {
                const keep = new Set(allParts(rec).map((x) => x.path));       // file còn dùng (giữ lại + mới) — KHÔNG được xoá
                await delParts(oldParts.filter((x) => !keep.has(x.path)), `${app.name}: xoá file cũ`);
            }
            // Legacy: JSON cũ còn pdfFile/pdfSize → bỏ đi cho gọn
            return res.json({ success: true, id: String(rec._id), redirect: `${app.base}/dashboard` });
        } catch (e) {
            if (e && (e.name !== 'HttpError' && e.code === 'SHA_CONFLICT')) return fail(res, 409, 'Đã bị người khác sửa. Hãy tải lại trang.');
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
            if (app.audience) {
                // công khai → không công khai; không công khai → công khai; "chỉ một số người" → không công khai (danh sách người giữ nguyên)
                rec.visibility = audience.visibilityOf(rec) === 'private' ? 'public' : 'private';
                rec.isPublished = rec.visibility !== 'private';
                rec.updatedBy = req.user._id;
                await rec.save();
                return res.json({ success: true, isPublished: rec.isPublished, visibility: rec.visibility });
            }
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
            for (const p of allParts(rec)) {
                if (p.store === 'r2') { await r2.remove(p.path).catch((e) => console.warn(`[${app.key}.remove] không xoá được R2 ${p.path}:`, e.message)); continue; }
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

    ctrl._test = { checkFile, checkItems, filesOf, readRange, loadPart, resolveSlug };
    return ctrl;
}

module.exports = { createController, _test: { slugify, cleanName, magicOk, partPath, readForm, cacheGet, cacheSet, scanFrameSalts } };
