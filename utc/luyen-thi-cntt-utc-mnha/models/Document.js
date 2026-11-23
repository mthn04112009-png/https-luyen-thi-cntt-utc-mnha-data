// ============================================================
// Document — TÀI LIỆU HỌC TẬP (ứng dụng /documents). KHÔNG lưu ở MongoDB.
//   subjects/{subject-slug}/documents/{slug}_{unix}.json
//   subjects/{subject-slug}/documents/{slug}_{unix}[-n].pdf   (mã hoá, chia nhỏ ≤ 23MB/phần nếu lớn)
// Cùng cách lưu với Slide — xem services/githubStore.js (KINDS.documents).
// Khác Slide: 1 tài liệu có thể gồm NHIỀU file (files = [{ id, name, ext, size, parts }], chỉ khi ≥ 2 file;
// 1 file vẫn dùng parts/fileExt/fileSize/originalName như cũ) và có "Chỉ hiển thị với" (visibility, allowedUserIds).
// ============================================================
const { createModel } = require('../services/githubModel');
const githubStore = require('../services/githubStore');

module.exports = createModel({
    name: 'Document',
    store: githubStore.makeStore('documents'),
    defaults: githubStore.KINDS.documents.defaults(),
    fields: ['subjectId', 'title', 'slug', 'description', 'parts', 'fileExt', 'fileSize', 'originalName', 'order', 'githubFile',
        'githubSha', 'isPublished', 'files', 'visibility', 'allowedUserIds', 'userKey', 'createdBy', 'updatedBy', 'isDeleted', 'deletedAt', 'deletedBy',
        'createdAt', 'updatedAt'],
    refs: { subjectId: 'Subject', userKey: 'UserKey', createdBy: 'User', updatedBy: 'User', deletedBy: 'User' }
});
