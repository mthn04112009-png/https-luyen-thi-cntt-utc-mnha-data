// routes/apps.js — trang "Ứng dụng": danh sách ứng dụng mà người dùng được cấp quyền
const express = require('express');
const router = express.Router();

const ctrl = require('../controllers/flashcard.controller');
const { attachUser, requireAuth } = require('../middleware/auth');
const { studentOrAdmin } = require('../middleware/role');

router.use(attachUser);

// client (chưa được duyệt) hoặc tài khoản đang chờ duyệt → trang "Tài khoản đang chờ duyệt"
// (views/pages.pug), KHÔNG hiện "Không có ứng dụng nào được cấp quyền".
function pendingGate(req, res, next) {
    const u = req.user;
    if (u && u.role !== 'admin' && (u.role === 'client' || u.status === 'pending')) {
        return res.render('pages', { title: 'Chờ duyệt', user: u, unreadCount: 0 });
    }
    next();
}

// GET /apps
router.get('/', requireAuth, pendingGate, studentOrAdmin, ctrl.getApps);

module.exports = router;
