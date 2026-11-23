// ============================================================
// Lesson — KHÔNG còn lưu ở MongoDB. Dữ liệu nằm ở GitHub:
//   subjects/{subject-slug}/lessons/{file}.json
// API giữ nguyên như Mongoose (find/findOne/findById/create/updateOne/...);
// xem services/githubModel.js + services/githubStore.js.
// ============================================================
const { createModel } = require('../services/githubModel');
const githubStore = require('../services/githubStore');
const { formatAiLabel } = require('../config/aiModels');

function getLessonAiLabel(lesson) {
    if (!lesson) return formatAiLabel('gemini', null);
    const k = lesson.aiKeyId;
    if (!k) return formatAiLabel('gemini', null);
    const populated = typeof k === 'object' && (k.name !== undefined || k.provider !== undefined);
    if (!populated) return null;
    return formatAiLabel(k.provider || 'gemini', k.name);
}

module.exports = createModel({
    name: 'Lesson',
    store: githubStore.makeStore('lessons'),
    defaults: githubStore.KINDS.lessons.defaults(),
    fields: ['subjectId', 'title', 'slug', 'description', 'sampleSolution', 'duration', 'order', 'githubFile',
        'githubSha', 'promptId', 'aiKeyId', 'model', 'isPublished', 'visibility', 'allowedUserIds', 'allowedGroupIds', 'type', 'quizCounts', 'analysisAiKeyIds',
        'userKey', 'createdBy', 'updatedBy', 'isDeleted', 'deletedAt', 'deletedBy', 'createdAt', 'updatedAt'],
    refs: {
        subjectId: 'Subject', promptId: 'GradingPrompt', aiKeyId: 'AIKey', analysisAiKeyIds: 'AIKey',
        userKey: 'UserKey', createdBy: 'User', updatedBy: 'User', deletedBy: 'User'
    },
    virtuals: {
        isQuiz: (d) => d.type === 'quiz',
        aiLabel: (d) => getLessonAiLabel(d)
    },
    statics: { getAiLabel: getLessonAiLabel }
});
