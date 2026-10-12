// routes/submission.js
const express = require('express');
const router = express.Router();

const submissionController = require('../controllers/submission.controller');
const drawingUpload = require('../controllers/drawingUpload.controller');
const requireApproved = require('../middleware/requireApproved');

// ============================================================
// MIDDLEWARE — ADMIN + STUDENT đều qua
// ============================================================
router.use(requireApproved);

// ============================================================
// SUBMISSION ROUTES
// ============================================================

// Lịch sử — đặt TRƯỚC :id để không bị match nhầm
router.get('/history', submissionController.getMySubmissions);

// ★ Upload ảnh viết tay (Cloudinary kiểm duyệt → GitHub tạm) — đặt TRƯỚC '/:id'
router.get('/drawing-upload/config', drawingUpload.getConfig);
router.post(
    '/drawing-upload',
    drawingUpload.rawImageBody,
    drawingUpload.rawBodyErrorHandler,
    drawingUpload.uploadDrawingPhoto
);

// ★ Ảnh bản vẽ tay (JS Paint) của bài nộp — đặt TRƯỚC '/:id'
router.get('/:id/drawing', submissionController.getSubmissionDrawing);

// Chi tiết 1 bài nộp
router.get('/:id', submissionController.getSubmission);

// Tạo bài nộp
router.post('/', submissionController.createSubmission);

module.exports = router;