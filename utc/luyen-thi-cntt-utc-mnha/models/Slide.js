// ============================================================
// Slide — SLIDE BÀI HỌC (ứng dụng /slides). KHÔNG lưu ở MongoDB.
// Dữ liệu nằm ở GitHub:
//   subjects/{subject-slug}/slides/{slug}_{unix}.json         (thông tin)
//   subjects/{subject-slug}/slides/{slug}_{unix}[-n].{pdf|ppt|pptx}   (file đã mã hoá, chia nhỏ ≤ 23MB/phần nếu lớn)
// RAM chỉ giữ CHỈ MỤC — xem services/githubStore.js (KINDS.slides). API giữ nguyên như Mongoose.
// ============================================================
const { createModel } = require('../services/githubModel');
const githubStore = require('../services/githubStore');

module.exports = createModel({
    name: 'Slide',
    store: githubStore.makeStore('slides'),
    defaults: githubStore.KINDS.slides.defaults(),
    fields: ['subjectId', 'title', 'slug', 'description', 'parts', 'fileExt', 'fileSize', 'originalName', 'order', 'githubFile',
        'githubSha', 'isPublished', 'userKey', 'createdBy', 'updatedBy', 'isDeleted', 'deletedAt', 'deletedBy',
        'createdAt', 'updatedAt'],
    refs: { subjectId: 'Subject', userKey: 'UserKey', createdBy: 'User', updatedBy: 'User', deletedBy: 'User' }
});
