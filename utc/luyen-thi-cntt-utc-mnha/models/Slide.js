// ============================================================
// Slide — một SLIDE HỌC TẬP (ứng dụng /slides). KHÔNG lưu ở MongoDB.
// Dữ liệu nằm ở GitHub:
//   subjects/{subject-slug}/slides/{slug}_{unix}.json   (thông tin)
//   subjects/{subject-slug}/slides/{slug}_{unix}.pdf    (PDF đã mã hoá — không nạp vào RAM)
// RAM chỉ giữ CHỈ MỤC (tiêu đề, kích thước, đường dẫn PDF…) — xem services/githubStore.js (KINDS.slides).
// API giữ nguyên như Mongoose (find/findOne/findById/create/exists/deleteOne/save…).
//   userKey / createdBy : phân quyền theo tổ chức giống Subject/Flashcard (userKeyService.getContentScope)
// ============================================================
const { createModel } = require('../services/githubModel');
const githubStore = require('../services/githubStore');

module.exports = createModel({
    name: 'Slide',
    store: githubStore.makeStore('slides'),
    defaults: githubStore.KINDS.slides.defaults(),
    fields: ['subjectId', 'title', 'slug', 'description', 'pdfFile', 'pdfSize', 'originalName', 'order', 'githubFile',
        'githubSha', 'isPublished', 'userKey', 'createdBy', 'updatedBy', 'isDeleted', 'deletedAt', 'deletedBy',
        'createdAt', 'updatedAt'],
    refs: {
        subjectId: 'Subject', userKey: 'UserKey', createdBy: 'User', updatedBy: 'User', deletedBy: 'User'
    }
});
