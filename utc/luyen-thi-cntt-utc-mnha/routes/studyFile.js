// routes/studyFile.js — router dùng chung cho /slides và /documents (xem routes/slide.js, routes/document.js)
const express = require('express');
const { attachUser, requireAuth } = require('../middleware/auth');
const { requireRole, studentOrAdmin } = require('../middleware/role');

module.exports = function createRouter(ctrl) {
    const router = express.Router();
    router.use(attachUser);   // req.user luôn đọc lại từ DB (role/userKey không bao giờ "cũ")
    const admin = [requireAuth, requireRole('admin')];

    // --- ADMIN: dashboard (đặt TRƯỚC các route có :tham số) ---
    router.get ('/dashboard',                ...admin, ctrl.dashboard);
    router.get ('/dashboard/new',            ...admin, ctrl.newForm);
    router.post('/dashboard/upload-chunk',   ...admin, ctrl.uploadChunk);
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
    return router;
};
