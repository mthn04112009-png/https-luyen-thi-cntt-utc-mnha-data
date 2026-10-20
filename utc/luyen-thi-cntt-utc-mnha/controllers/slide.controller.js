// controllers/slide.controller.js — Slide bài học (/slides): PDF, PPT, PPTX. Logic dùng chung: controllers/studyFile.controller.js
const { createController } = require('./studyFile.controller');
const { APPS } = require('../config/studyFileConfig');

module.exports = createController(APPS.slides, require('../models/Slide'));
