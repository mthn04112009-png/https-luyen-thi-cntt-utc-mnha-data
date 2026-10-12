// config/github.js
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');

/**
 * Khởi tạo Octokit với token trong .env.
 */
const token = process.env.GITHUB_TOKEN;
const owner = process.env.GITHUB_OWNER;
const repo  = process.env.GITHUB_REPO;
const branch = process.env.GITHUB_BRANCH || 'main';

if (!token) {
    console.warn('⚠️  GITHUB_TOKEN chưa cấu hình — thao tác ghi GitHub sẽ thất bại.');
}
if (!owner || !repo) {
    console.warn('⚠️  GITHUB_OWNER hoặc GITHUB_REPO chưa cấu hình trong .env');
}

const octokit = new Octokit({
    auth: token || undefined,
    userAgent: 'luyen-thi-cntt-utc/1.0.0',
    request: { timeout: 20000 }
});

// ★ Theo dõi GitHub sập/bảo trì: request lỗi → noteFailure, thành công → noteSuccess
//   (xem utils/githubErrors.js + middleware/githubDownGuard.js)
const githubHealth = require('../utils/githubErrors');
octokit.hook.error('request', async (error) => {
    githubHealth.noteFailure(error);
    throw error;
});
octokit.hook.after('request', () => {
    githubHealth.noteSuccess();
});

/**
 * Đường dẫn gốc trong repo
 */
const PATHS = {
    subjectsRoot: 'subjects',
    submissionsRoot: 'submissions',
    promptsRoot: 'prompts'
};

/**
 * Tên file JSON NGẪU NHIÊN (20 ký tự hex, ~2^80 khả năng).
 * Dùng cho prompt + bài nộp; việc "không trùng" được đảm bảo thêm ở
 * githubService.uniqueJsonPath() (kiểm tra cây thư mục + API trước khi dùng).
 *
 * { timestamp: true } → thêm đuôi thời gian (mili-giây UTC):
 *   "<20 hex>_<timestamp>.json"  vd: 234f3322afe6f8dedc18_1760257538123.json
 * Đuôi timestamp giúp sắp xếp theo thời gian nộp và giảm thêm khả năng trùng.
 */
function randomJsonName({ timestamp = false } = {}) {
    const hex = crypto.randomBytes(10).toString('hex');
    return timestamp ? `${hex}_${Date.now()}.json` : `${hex}.json`;
}

/**
 * Path helpers
 */
function subjectFile(subjectSlug) {
    return `${PATHS.subjectsRoot}/${subjectSlug}/subject.json`;
}

function lessonFile(subjectSlug, lessonSlug) {
    return `${PATHS.subjectsRoot}/${subjectSlug}/lessons/${lessonSlug}.json`;
}

function submissionFile(subjectSlug, lessonSlug, userId, timestamp) {
    const ts = new Date(timestamp || Date.now())
        .toISOString()
        .replace(/[:.]/g, '-');
    return `${PATHS.submissionsRoot}/${subjectSlug}/${lessonSlug}/${userId}-${ts}.json`;
}

module.exports = {
    randomJsonName,
    octokit,
    owner,
    repo,
    branch,
    PATHS,
    isConfigured: Boolean(token && owner && repo),
    subjectFile,
    lessonFile,
    submissionFile
};