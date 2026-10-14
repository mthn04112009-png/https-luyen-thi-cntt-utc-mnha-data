// routes/quiz.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/quiz.controller');
const quizImage = require('../controllers/quizImageUpload.controller');
const { requireAuth } = require('../middleware/auth');
const { requireRole, studentOrAdmin } = require('../middleware/role');
const rateLimit = require('express-rate-limit');

// ============================================================
// Rate limit — dùng được cả localhost lẫn Vercel
// ------------------------------------------------------------
// VẤN ĐỀ 1: express-rate-limit v7+ mặc định THROW ValidationError khi
//   `trust proxy` chưa set, VÀ request có header `X-Forwarded-For` (Vercel LUÔN có).
//
// VẤN ĐỀ 2: express-rate-limit v7.5+ bắt custom keyGenerator trả IP phải
//   chuẩn hoá qua helper `ipKeyGenerator` (tránh IPv6 bypass). Nếu không,
//   throw ERR_ERL_KEY_GEN_IPV6 ngay lúc rateLimit() được gọi → crash server.
//
// FIX: dùng helper `ipKeyGenerator` nếu lib có; đồng thời tắt các validation
//   ta đã tự xử lý (trustProxy / xForwardedFor / ip / keyGeneratorIpFallback).
// ============================================================

// v7.5+ export ipKeyGenerator; version cũ không có → null
const ipKeyGenerator =
  typeof rateLimit.ipKeyGenerator === 'function' ? rateLimit.ipKeyGenerator : null;

function clientIp(req) {
  // Ưu tiên IP thật từ X-Forwarded-For (Vercel/Cloudflare luôn set header này)
  const xff = req.headers['x-forwarded-for'];
  let ip = '';
  if (typeof xff === 'string' && xff) {
    ip = xff.split(',')[0].trim();
  }
  if (!ip) ip = req.ip || (req.socket && req.socket.remoteAddress) || '';
  if (!ip) return 'unknown';

  // Nếu lib có helper → chuẩn hoá (gộp IPv6 /64 subnet tránh bypass)
  if (ipKeyGenerator) {
    try { return ipKeyGenerator(ip); } catch { /* fall through */ }
  }
  return ip;
}

const rlOpts = {
  windowMs: 60 * 1000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIp,
  validate: {
    // Ta tự lấy IP → tắt các validation lib tự dò để tránh false-positive
    trustProxy: false,
    xForwardedForHeader: false,
    ip: false,
    // ★ Bắt buộc: nếu không thêm dòng này, lib v7.5+ sẽ throw
    //   ERR_ERL_KEY_GEN_IPV6 khi keyGenerator không gọi ipKeyGenerator.
    keyGeneratorIpFallback: false,
  },
};

const submitLimit  = rateLimit({ ...rlOpts, max: 6 });
const parseLimit   = rateLimit({ ...rlOpts, max: 30 });
const analyzeLimit = rateLimit({ ...rlOpts, max: 6 });

// ============================================================
// ⚠️ THỨ TỰ ROUTE — cụ thể TRƯỚC, có :param SAU.
//    /admin/quiz/parse phải đứng trước /admin/quiz/:lessonId,
//    nếu không "parse" bị nuốt thành lessonId rồi đi vào update.
// ============================================================

// --- ADMIN: form (GET) ---
router.get('/admin/quiz/new',             requireAuth, requireRole('admin'), ctrl.newForm);
router.get('/admin/quiz/:lessonId/edit',  requireAuth, requireRole('admin'), ctrl.editForm);

// --- ADMIN: POST (parse TRƯỚC :lessonId) ---
router.post('/admin/quiz/parse',          requireAuth, requireRole('admin'), parseLimit, ctrl.parsePreview);
// ★ Up ảnh câu hỏi (kiểm duyệt Cloudinary → GitHub cache/image/<timestamp>.<đuôi>) — đứng TRƯỚC /:lessonId
router.get ('/admin/quiz/upload-image/config', requireAuth, requireRole('admin'), quizImage.getConfig);
router.post('/admin/quiz/upload-image',        requireAuth, requireRole('admin'), quizImage.rawImageBody, quizImage.rawBodyErrorHandler, quizImage.uploadQuizImage);
router.post('/admin/quiz',                requireAuth, requireRole('admin'), ctrl.create);
router.post('/admin/quiz/:lessonId',      requireAuth, requireRole('admin'), ctrl.update);

// --- ADMIN: review quiz ---
router.get ('/admin/quiz-submissions/:id/review', requireAuth, requireRole('admin'), ctrl.reviewPage);
router.post('/admin/quiz-submissions/:id/review', requireAuth, requireRole('admin'), ctrl.saveQuizTeacherComment);

// --- STUDENT: API ---
router.post('/api/quiz/:lessonId/submit',           requireAuth, studentOrAdmin, submitLimit, ctrl.submit);
router.get ('/api/quiz/submissions/:id/status',     requireAuth, studentOrAdmin, ctrl.status);
router.post('/api/quiz/submissions/:id/analyze',    requireAuth, studentOrAdmin, analyzeLimit, ctrl.analyze);

// --- Trang chi tiết (student) ---
router.get('/quiz-submissions/:id',       requireAuth, ctrl.renderStudentDetail);

module.exports = router;