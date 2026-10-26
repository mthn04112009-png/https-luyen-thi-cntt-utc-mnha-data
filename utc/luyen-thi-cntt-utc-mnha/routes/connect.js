// routes/connect.js — /connect trên WEB CHÍNH (quản lý web dữ liệu).
// Chỉ admin mặc định: role=admin + userKey=null (admin tổ chức / student / client đều bị chặn).
'use strict';
const express = require('express');
const c = require('../controllers/connect.controller');
const { requireDefaultAdmin } = require('../middleware/userKeyGuard');

const router = express.Router();

router.use(requireDefaultAdmin);
router.get('/', c.index);
router.post('/check', c.check);
router.post('/github/webhook', c.githubWebhook);
router.post('/add', c.add);
router.post('/node/:id/rename', c.rename);
router.post('/node/:id/toggle', c.toggle);
router.post('/node/:id/remove', c.remove);
router.post('/node/:id/key', c.setKey);
router.post('/node/:id/vercel', c.vercel);

module.exports = router;
