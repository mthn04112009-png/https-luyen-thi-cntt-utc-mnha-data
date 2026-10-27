// ============================================================
// Video — VIDEO BÀI GIẢNG (ứng dụng /videos). KHÔNG lưu ở MongoDB.
// Dữ liệu nằm ở GitHub:
//   subjects/{subject-slug}/videos/{slug}_{unix}.json
// RAM chỉ giữ CHỈ MỤC — xem services/githubStore.js (KINDS.videos)
// ============================================================
const { createModel } = require('../services/githubModel');
const githubStore = require('../services/githubStore');

module.exports = createModel({
    name: 'Video',
    store: githubStore.makeStore('videos'),
    defaults: githubStore.KINDS.videos ? githubStore.KINDS.videos.defaults() : {
        description: '', videos: [], videoCount: 0, order: 0,
        githubFile: null, githubSha: null, isPublished: true,
        userKey: null, createdBy: null, updatedBy: null,
        isDeleted: false, deletedAt: null, deletedBy: null, slug: null
    },
    fields: ['subjectId', 'title', 'slug', 'description', 'videos', 'videoCount', 'order', 'githubFile',
        'githubSha', 'isPublished', 'userKey', 'createdBy', 'updatedBy', 'isDeleted', 'deletedAt', 'deletedBy',
        'createdAt', 'updatedAt'],
    refs: { subjectId: 'Subject', userKey: 'UserKey', createdBy: 'User', updatedBy: 'User', deletedBy: 'User' }
});
