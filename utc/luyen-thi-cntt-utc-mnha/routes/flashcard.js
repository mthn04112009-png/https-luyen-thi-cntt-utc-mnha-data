// routes/flashcard.js — ỨNG DỤNG FLASHCARD (mount ở /flashcards)
const express = require('express');
const router = express.Router();

const ctrl = require('../controllers/flashcard.controller');
const { attachUser, requireAuth } = require('../middleware/auth');
const { requireRole, studentOrAdmin } = require('../middleware/role');

router.use(attachUser);   // req.user luôn đọc lại từ DB (role/userKey không bao giờ "cũ")

const admin = [requireAuth, requireRole('admin')];

// --- ADMIN: dashboard (đặt TRƯỚC các route có :tham số) ---
router.get ('/dashboard',            ...admin, ctrl.dashboard);
router.get ('/dashboard/new',        ...admin, ctrl.newForm);
router.post('/dashboard/parse',      ...admin, ctrl.parsePreview);
router.post('/dashboard',            ...admin, ctrl.create);
router.get ('/dashboard/:fid/edit',  ...admin, ctrl.editForm);
router.post('/dashboard/:fid/publish', ...admin, ctrl.togglePublish);
router.post('/dashboard/:fid/delete',  ...admin, ctrl.remove);
router.post('/dashboard/:fid',       ...admin, ctrl.update);

// --- STUDENT / ADMIN ---
router.get('/',                      requireAuth, studentOrAdmin, ctrl.getHub);
router.get('/subjects',              requireAuth, studentOrAdmin, ctrl.getSubjects);
router.get('/subjects/:id',          requireAuth, studentOrAdmin, ctrl.getSubject);
router.get('/study/:fid',            requireAuth, studentOrAdmin, ctrl.study);

module.exports = router;
