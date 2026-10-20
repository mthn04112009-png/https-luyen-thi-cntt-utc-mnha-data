// ============================================================
// Subject (MÔN HỌC) — KHÔNG còn lưu ở MongoDB. Dữ liệu nằm ở GitHub:
//   subjects/index.json   (xem services/subjectStore.js)
// API giữ nguyên như Mongoose (find/findOne/findById/create/updateOne/save/deleteOne/...)
// nên controller dùng `Subject` y như cũ: thêm môn = Subject.create, xoá = đặt deletedAt /
// deletedForever rồi save() (hoặc Subject.deleteOne), đọc danh sách = Subject.find.
// Thêm: Subject.refresh() nạp lại từ GitHub ngay.
// ============================================================
const { createModel } = require('../services/githubModel');
const subjectStore = require('../services/subjectStore');

module.exports = createModel({
    name: 'Subject',
    store: subjectStore.store,
    defaults: subjectStore.defaults(),
    fields: subjectStore.FIELDS,
    refs: {
        promptId: 'GradingPrompt', quizPromptId: 'GradingPrompt', userKey: 'UserKey',
        createdBy: 'User', updatedBy: 'User', deletedBy: 'User'
    },
    virtuals: {
        createdAtFormatted: (d) => (d.createdAt ? new Date(d.createdAt).toLocaleString('vi-VN') : ''),
        updatedAtFormatted: (d) => (d.updatedAt ? new Date(d.updatedAt).toLocaleString('vi-VN') : '')
    },
    statics: {
        PATH: subjectStore.SUBJECTS_PATH,
        refresh: () => subjectStore.reload(),
        refreshIfOlderThan: (ms) => subjectStore.refreshIfOlderThan(ms)
    }
});
