// routes/video.js — Video bài giảng (mount ở /videos)
const express = require('express');
const router = express.Router();

const ctrl = require('../controllers/video.controller');
const { attachUser, requireAuth } = require('../middleware/auth');
const { requireRole, studentOrAdmin } = require('../middleware/role');

router.use(attachUser);
const admin = [requireAuth, requireRole('admin')];

// --- ADMIN ---
router.get('/dashboard',                ...admin, ctrl.dashboard);
router.get('/dashboard/new',            ...admin, ctrl.newForm);
router.post('/dashboard',               ...admin, ctrl.create);
router.get('/dashboard/:vid/edit',      ...admin, ctrl.editForm);
router.post('/dashboard/:vid/publish',  ...admin, ctrl.togglePublish);
router.post('/dashboard/:vid/delete',   ...admin, ctrl.remove);
router.post('/dashboard/:vid',          ...admin, ctrl.update);

// --- STUDENT / ADMIN ---
router.get('/',                        requireAuth, studentOrAdmin, ctrl.getHub);
router.get('/subjects',                requireAuth, studentOrAdmin, ctrl.getSubjects);
router.get('/subjects/:id',            requireAuth, studentOrAdmin, ctrl.getSubject);
router.get('/study/:vid',              requireAuth, studentOrAdmin, ctrl.study);
router.get('/play/:vid/:item',         requireAuth, studentOrAdmin, ctrl.play);

module.exports = router;
