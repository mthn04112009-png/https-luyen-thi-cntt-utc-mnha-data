// controllers/document.controller.js — Tài liệu học tập (/documents): PDF. Logic dùng chung: controllers/studyFile.controller.js
const { createController } = require('./studyFile.controller');
const { APPS } = require('../config/studyFileConfig');

module.exports = createController(APPS.documents, require('../models/Document'));
