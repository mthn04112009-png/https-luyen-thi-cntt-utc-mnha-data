// routes/studyFile.js — router dùng chung cho /slides và /documents (xem routes/slide.js, routes/document.js)
const express = require('express');
const rateLimit = require('express-rate-limit');
const { attachUser, requireAuth } = require('../middleware/auth');
const { requireRole, studentOrAdmin } = require('../middleware/role');

// ------------------------------------------------------------
// Giới hạn tần suất (mỗi tài khoản; chưa đăng nhập thì theo IP). Bộ đếm nằm trong RAM của instance → chỉ là lớp chặn mềm.
// ------------------------------------------------------------
const ipKeyGenerator = typeof rateLimit.ipKeyGenerator === 'function' ? rateLimit.ipKeyGenerator : null;
function limiterKey(req) {
    if (req.user && (req.user._id || req.user.id)) return 'u:' + String(req.user._id || req.user.id);
    const xff = req.headers['x-forwarded-for'];
    let ip = (typeof xff === 'string' && xff ? xff.split(',')[0].trim() : '') || req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    if (ipKeyGenerator) { try { ip = ipKeyGenerator(ip); } catch (_) { /* giữ nguyên */ } }
    return 'ip:' + ip;
}
const mkLimit = (max, message) => rateLimit({
    windowMs: 60 * 1000, max, standardHeaders: true, legacyHeaders: false, keyGenerator: limiterKey,
    handler: (req, res) => res.status(429).json({ success: false, message }),
    validate: { trustProxy: false, xForwardedForHeader: false, ip: false, keyGeneratorIpFallback: false }
});
const keysLimit       = mkLimit(300, 'Xin khoá quá nhanh — thử lại sau ít phút.');      // học viên xem file: trình duyệt xin theo từng đợt khung (file 100MB ≈ 50 lần)
const uploadKeysLimit = mkLimit(120, 'Xin khoá up quá nhanh — thử lại sau ít phút.');    // admin up: 1 lần / 16 khung
// Khung mã hoá sẵn từ trình duyệt: octet-stream ≤ khung 2MB + header (Vercel giới hạn body 4.5MB)
const rawFrame = express.raw({ type: 'application/octet-stream', limit: '3mb' });

module.exports = function createRouter(ctrl) {
    const router = express.Router();
    router.use(attachUser);   // req.user luôn đọc lại từ DB (role/userKey không bao giờ "cũ")
    const admin = [requireAuth, requireRole('admin')];

    // --- ADMIN: dashboard (đặt TRƯỚC các route có :tham số) ---
    router.get ('/dashboard',                ...admin, ctrl.dashboard);
    router.get ('/dashboard/new',            ...admin, ctrl.newForm);
    router.post('/dashboard/upload-keys',    ...admin, uploadKeysLimit, ctrl.uploadKeys);   // cấp khoá để TRÌNH DUYỆT tự mã hoá
    router.post('/dashboard/upload-chunk',   ...admin, rawFrame, ctrl.uploadChunk);          // nhận khung ĐÃ mã hoá (octet-stream)
    router.post('/dashboard/upload-part',    ...admin, ctrl.uploadPart);
    router.post('/dashboard',                ...admin, ctrl.create);
    router.get ('/dashboard/:sid/edit',      ...admin, ctrl.editForm);
    router.post('/dashboard/:sid/publish',   ...admin, ctrl.togglePublish);
    router.post('/dashboard/:sid/delete',    ...admin, ctrl.remove);
    router.post('/dashboard/:sid',           ...admin, ctrl.update);

    // --- STUDENT / ADMIN ---
    router.get('/',                          requireAuth, studentOrAdmin, ctrl.getHub);
    router.get('/subjects',                  requireAuth, studentOrAdmin, ctrl.getSubjects);
    router.get('/subjects/:id',              requireAuth, studentOrAdmin, ctrl.getSubject);
    router.get('/study/:sid',                requireAuth, studentOrAdmin, ctrl.study);
    router.get('/file/:sid',                 requireAuth, studentOrAdmin, ctrl.file);
    router.post('/keys/:sid',                requireAuth, studentOrAdmin, keysLimit, ctrl.keys);   // cấp khoá khung cho trình duyệt tự giải mã
    return router;
};
