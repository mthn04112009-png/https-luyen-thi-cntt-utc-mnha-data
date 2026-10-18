// ============================================================
// Flashcard — một BỘ thẻ học (ứng dụng /flashcards). KHÔNG lưu ở MongoDB.
// Dữ liệu nằm ở GitHub:  subjects/{subject-slug}/flashcards/{slug}_{unix}.json
// RAM chỉ giữ CHỈ MỤC (tiêu đề, chế độ, ngôn ngữ, số thẻ…); các thẻ (cards[]) nằm trong file và được đọc khi học.
// API giữ nguyên như Mongoose (find/findOne/findById/create/updateOne/...);
// xem services/githubModel.js + services/githubStore.js (KINDS.flashcards).
//
//   mode     : 'language' (học ngoại ngữ: có phiên âm, nghe, đọc) | 'theory' (học lý thuyết)
//   language : mã BCP-47 cho nút Nghe/Đọc, chỉ dùng khi mode = 'language' (vd 'en-US', 'zh-CN')
//   userKey / createdBy : phân quyền theo tổ chức giống Subject/Lesson (userKeyService.getContentScope)
// ============================================================
const { createModel } = require('../services/githubModel');
const githubStore = require('../services/githubStore');

module.exports = createModel({
    name: 'Flashcard',
    store: githubStore.makeStore('flashcards'),
    defaults: githubStore.KINDS.flashcards.defaults(),
    fields: ['subjectId', 'title', 'slug', 'description', 'mode', 'language', 'cardCount', 'order', 'githubFile',
        'githubSha', 'isPublished', 'userKey', 'createdBy', 'updatedBy', 'isDeleted', 'deletedAt', 'deletedBy',
        'createdAt', 'updatedAt'],
    refs: {
        subjectId: 'Subject', userKey: 'UserKey', createdBy: 'User', updatedBy: 'User', deletedBy: 'User'
    },
    virtuals: {
        isLanguage: (d) => d.mode !== 'theory'
    }
});
