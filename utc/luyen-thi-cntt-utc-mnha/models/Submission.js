// ============================================================
// Submission — KHÔNG còn lưu ở MongoDB. Dữ liệu nằm ở GitHub:
//   submissions/{subject-slug}/{lesson-slug}/{file}.json
// Bản ghi đang "pending/grading" chỉ nằm trong RAM tới khi file JSON được ghi.
// ============================================================
const { createModel } = require('../services/githubModel');
const githubStore = require('../services/githubStore');

module.exports = createModel({
    name: 'Submission',
    store: githubStore.makeStore('submissions'),
    defaults: githubStore.KINDS.submissions.defaults(),
    fields: ['userId', 'lessonId', 'subjectId', 'type', 'answerHtml', 'score', 'feedback', 'breakdown', 'grammar',
        'sampleComparison', 'promptSnapshot', 'model', 'aiKeyId', 'aiKeyName', 'aiProvider', 'latencyMs', 'maxScore',
        'correctCount', 'totalCount', 'analysisCount', 'lastAnalyzedAt', 'status', 'errorMessage', 'gradedAt',
        'submittedAt', 'teacherComment', 'teacherCommentHistory', 'teacherCommentSyncStatus',
        'teacherCommentSyncError', 'hasDrawing', 'drawingFile', 'drawingMime', 'drawingData', 'drawingAnalysis', 'syncStatus', 'githubFile', 'githubSha', 'errorCount', 'syncedAt', 'syncError',
        'createdAt', 'updatedAt'],
    refs: { userId: 'User', lessonId: 'Lesson', subjectId: 'Subject', aiKeyId: 'AIKey' }
});
