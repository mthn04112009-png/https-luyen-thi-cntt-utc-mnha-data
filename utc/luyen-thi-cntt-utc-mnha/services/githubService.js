// ============================================================
// GITHUB SERVICE - Octokit wrapper
// ============================================================
// Dùng config/github.js làm nguồn config DUY NHẤT.
// Export đầy đủ: writeJsonFile, readJsonFile, deleteFile,
// path helpers (submissionPath, subjectPath, lessonPath).
// ============================================================

const {
    octokit,
    owner,
    repo,
    branch,
    isConfigured,
    subjectFile,
    lessonFile,
    submissionFile,
    randomJsonName
} = require('../config/github');

const MAX_RETRY = 3;
const BASE_DELAY = 500;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * Retry khi gặp 409 (SHA conflict) hoặc 5xx.
 */
async function withRetry(fn, label = 'github') {
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
        try {
            return await fn();
        } catch (e) {
            lastErr = e;
            const status = e.status || e.response?.status;
            const retriable = status === 409 || (status >= 500 && status < 600);
            console.warn(`⚠️ [${label}] attempt ${attempt} fail: ${e.message} (status=${status})`);
            if (!retriable || attempt === MAX_RETRY) throw e;
            await sleep(BASE_DELAY * Math.pow(2, attempt - 1));
        }
    }
    throw lastErr;
}

/**
 * Đảm bảo các env cần thiết đã cấu hình.
 */
function assertConfigured() {
    if (!isConfigured) {
        throw new Error(
            'GitHub chưa cấu hình: cần GITHUB_TOKEN + GITHUB_OWNER + GITHUB_REPO trong .env'
        );
    }
}

/**
 * Giải mã nội dung file từ Contents API.
 * File > 1MB: Contents API trả content rỗng → đọc qua Git Blob API (bài nộp quiz chứa cả đề + bài làm nên có thể lớn).
 */
async function decodeContent(data, path) {
    if (data.content) return Buffer.from(data.content, 'base64').toString('utf8');
    if (data.sha) {
        const blob = await octokit.git.getBlob({ owner, repo, file_sha: data.sha });
        return Buffer.from(blob.data.content, 'base64').toString('utf8');
    }
    throw new Error(`Không đọc được nội dung file: ${path}`);
}


// ============================================================
// CÂY THƯ MỤC REPO (1 request lấy toàn bộ đường dẫn + SHA)
// ------------------------------------------------------------
// Dùng để biết trên GitHub hiện có BAO NHIÊU file / file nào, rồi mới đọc
// những file cần thiết (xem services/githubSyncService.js).
// Cache ngắn theo instance; mọi thao tác ghi/xoá của app đều xoá cache này.
// ============================================================
const TREE_TTL_MS = 15 * 1000;
let _tree = null;          // { at, files: Map(path -> blobSha), truncated }
let _treePromise = null;

async function getRepoTree({ force = false } = {}) {
    assertConfigured();
    if (!force && _tree && Date.now() - _tree.at < TREE_TTL_MS) return _tree;
    if (_treePromise) return _treePromise;

    _treePromise = (async () => {
        // tree_sha nhận cả tên nhánh → 1 request, không cần gọi getBranch trước
        const res = await octokit.git.getTree({
            owner, repo, tree_sha: branch, recursive: '1'
        });
        const files = new Map();
        for (const t of res.data.tree || []) {
            if (t.type === 'blob') files.set(t.path, t.sha);
        }
        if (res.data.truncated) {
            console.warn('⚠️ [githubService] Cây thư mục bị cắt (repo quá lớn) — bỏ qua bước xoá đồng bộ.');
        }
        _tree = { at: Date.now(), files, truncated: Boolean(res.data.truncated) };
        return _tree;
    })();

    try {
        return await _treePromise;
    } finally {
        _treePromise = null;
    }
}

function invalidateTree() {
    _tree = null;
}

/**
 * Sinh đường dẫn `dir/<tên-ngẫu-nhiên>.json` CHƯA tồn tại trên GitHub.
 * Kiểm tra cả cây thư mục (cache) lẫn API trực tiếp; trùng thì sinh lại.
 */
async function uniqueJsonPath(dir, { timestamp = false } = {}) {
    assertConfigured();
    const clean = String(dir || '').replace(/^\/+|\/+$/g, '');

    let known = null;
    try {
        known = (await getRepoTree()).files;
    } catch (e) {
        console.warn('[githubService] Không lấy được cây thư mục để kiểm tra trùng tên:', e.message);
    }

    for (let i = 0; i < 8; i++) {
        const candidate = `${clean}/${randomJsonName({ timestamp })}`;
        if (known && known.has(candidate)) continue;
        if (await getFileSha(candidate)) continue;
        return candidate;
    }
    throw new Error('Không tạo được tên file ngẫu nhiên không trùng trên GitHub.');
}

/**
 * Lấy SHA của file (null nếu chưa tồn tại).
 */
async function getFileSha(path) {
    assertConfigured();
    try {
        const res = await octokit.repos.getContent({
            owner, repo, path, ref: branch
        });
        if (Array.isArray(res.data)) return null;
        return res.data.sha;
    } catch (e) {
        if (e.status === 404) return null;
        throw e;
    }
}

/**
 * Ghi file JSON lên GitHub (tạo mới hoặc cập nhật).
 */
async function writeJsonFile(path, data, commitMessage = 'Update JSON') {
    assertConfigured();

    return withRetry(async () => {
        const sha = await getFileSha(path);
        const content = Buffer
            .from(JSON.stringify(data, null, 2), 'utf8')
            .toString('base64');

        const res = await octokit.repos.createOrUpdateFileContents({
            owner,
            repo,
            branch,
            path,
            message: commitMessage,
            content,
            sha: sha || undefined,
            committer: {
                name: 'Luyen Thi CNTT Bot',
                email: 'bot@luyen-thi-cntt.local'
            }
        });

        invalidateTree();
        return {
            path,
            sha: res.data.content.sha,
            url: res.data.content.html_url,
            downloadUrl: res.data.content.download_url,
            commitSha: res.data.commit.sha
        };
    }, `write:${path}`);
}

/**
 * Đọc file JSON từ GitHub.
 */
async function readJsonFile(path) {
    assertConfigured();

    try {
        const res = await octokit.repos.getContent({
            owner, repo, path, ref: branch
        });
        if (Array.isArray(res.data)) {
            throw new Error(`Path không phải file: ${path}`);
        }
        const content = await decodeContent(res.data, path);
        return JSON.parse(content);
    } catch (e) {
        if (e.status === 404) return null;
        throw e;
    }
}

/**
 * Đọc file JSON kèm SHA (null nếu không tồn tại).
 * Dùng khi cần so sánh phiên bản (vd form sửa đề trắc nghiệm giữ SHA lúc mở;
 * lưu mà SHA đã đổi → báo "Đề đã bị đổi, tải lại" thay vì ghi đè).
 * @returns {Promise<{data:object, sha:string}|null>}
 */
async function readJsonFileWithSha(path) {
    assertConfigured();

    try {
        const res = await octokit.repos.getContent({
            owner, repo, path, ref: branch
        });
        if (Array.isArray(res.data)) {
            throw new Error(`Path không phải file: ${path}`);
        }
        const data = JSON.parse(await decodeContent(res.data, path));
        return { data, sha: res.data.sha };
    } catch (e) {
        if (e.status === 404) return null;
        throw e;
    }
}

/**
 * Ghi file JSON CHỈ KHI SHA hiện tại khớp `expectedSha` (khoá lạc quan).
 * Khác writeJsonFile (tự lấy SHA mới nhất → ghi đè). Lệch SHA → ném lỗi
 * có `code = 'SHA_CONFLICT'` và KHÔNG ghi gì. Không retry 409 ở đây.
 * expectedSha = null → chỉ được tạo mới (file đã tồn tại cũng là xung đột).
 */
async function writeJsonFileIfSha(path, data, expectedSha, commitMessage = 'Update JSON') {
    assertConfigured();

    const currentSha = await getFileSha(path);
    if ((currentSha || null) !== (expectedSha || null)) {
        const err = new Error('File trên GitHub đã bị thay đổi, vui lòng tải lại.');
        err.code = 'SHA_CONFLICT';
        throw err;
    }

    try {
        const res = await octokit.repos.createOrUpdateFileContents({
            owner,
            repo,
            branch,
            path,
            message: commitMessage,
            content: Buffer.from(JSON.stringify(data, null, 2), 'utf8').toString('base64'),
            sha: currentSha || undefined,
            committer: {
                name: 'Luyen Thi CNTT Bot',
                email: 'bot@luyen-thi-cntt.local'
            }
        });
        invalidateTree();
        return {
            path,
            sha: res.data.content.sha,
            commitSha: res.data.commit.sha
        };
    } catch (e) {
        if ((e.status || e.response?.status) === 409) {
            const err = new Error('File trên GitHub đã bị thay đổi, vui lòng tải lại.');
            err.code = 'SHA_CONFLICT';
            throw err;
        }
        throw e;
    }
}

/**
 * Đọc → sửa → ghi lại file JSON trong CÙNG một lần thử, dùng đúng SHA vừa đọc.
 * Nếu GitHub trả 409 (SHA cũ) thì withRetry chạy lại TOÀN BỘ: đọc lại bản mới
 * nhất rồi áp updater lại → không ghi đè mất thay đổi của nơi khác.
 * (writeJsonFile chỉ lấy SHA, không đọc nội dung nên không an toàn cho patch.)
 *
 * @param {string} path
 * @param {(current:object)=>object|Promise<object>} updater  nhận JSON hiện tại, trả JSON mới
 */
async function updateJsonFile(path, updater, commitMessage = 'Update JSON') {
    assertConfigured();

    return withRetry(async () => {
        let res;
        try {
            res = await octokit.repos.getContent({ owner, repo, path, ref: branch });
        } catch (e) {
            if (e.status === 404) {
                throw new Error(`File không tồn tại trên GitHub: ${path}`);
            }
            throw e;
        }
        if (Array.isArray(res.data)) {
            throw new Error(`Path không phải file: ${path}`);
        }

        const current = JSON.parse(await decodeContent(res.data, path));
        const next = await updater(current);

        const put = await octokit.repos.createOrUpdateFileContents({
            owner,
            repo,
            branch,
            path,
            message: commitMessage,
            content: Buffer.from(JSON.stringify(next, null, 2), 'utf8').toString('base64'),
            sha: res.data.sha,
            committer: {
                name: 'Luyen Thi CNTT Bot',
                email: 'bot@luyen-thi-cntt.local'
            }
        });

        invalidateTree();
        return {
            path,
            sha: put.data.content.sha,
            commitSha: put.data.commit.sha
        };
    }, `update:${path}`);
}

/**
 * Ghi file NHỊ PHÂN (ảnh logo...) lên GitHub — tạo mới hoặc cập nhật.
 * @param {string} path
 * @param {Buffer} buffer
 */
async function writeBinaryFile(path, buffer, commitMessage = 'Update file') {
    assertConfigured();

    if (!Buffer.isBuffer(buffer)) {
        throw new Error('writeBinaryFile: dữ liệu phải là Buffer');
    }

    return withRetry(async () => {
        const sha = await getFileSha(path);

        const res = await octokit.repos.createOrUpdateFileContents({
            owner,
            repo,
            branch,
            path,
            message: commitMessage,
            content: buffer.toString('base64'),
            sha: sha || undefined,
            committer: {
                name: 'Luyen Thi CNTT Bot',
                email: 'bot@luyen-thi-cntt.local'
            }
        });

        invalidateTree();
        return {
            path,
            sha: res.data.content.sha,
            commitSha: res.data.commit.sha
        };
    }, `writeBinary:${path}`);
}

/**
 * Đọc file NHỊ PHÂN từ GitHub → Buffer (null nếu không tồn tại).
 * Contents API chỉ trả nội dung cho file ≤ 1MB; logo giới hạn 512KB nên đủ.
 */
async function readBinaryFile(path) {
    assertConfigured();

    try {
        const res = await octokit.repos.getContent({
            owner, repo, path, ref: branch
        });
        if (Array.isArray(res.data)) {
            throw new Error(`Path không phải file: ${path}`);
        }
        if (!res.data.content) {
            throw new Error(`File quá lớn để đọc qua Contents API: ${path}`);
        }
        return Buffer.from(res.data.content, 'base64');
    } catch (e) {
        if (e.status === 404) return null;
        throw e;
    }
}

/**
 * Xoá file trên GitHub.
 */
async function deleteFile(path, commitMessage = 'Delete file') {
    assertConfigured();

    return withRetry(async () => {
        const sha = await getFileSha(path);
        if (!sha) {
            console.warn(`[githubService] File không tồn tại, bỏ qua xoá: ${path}`);
            return { path, deleted: false };
        }

        const res = await octokit.repos.deleteFile({
            owner,
            repo,
            branch,
            path,
            message: commitMessage,
            sha
        });

        invalidateTree();
        return {
            path,
            deleted: true,
            commitSha: res.data.commit.sha
        };
    }, `delete:${path}`);
}

/**
 * Kiểm tra file tồn tại.
 */
async function fileExists(path) {
    const sha = await getFileSha(path);
    return sha !== null;
}

/**
 * Tương thích: quiz.controller gọi invalidate(path) sau khi sửa đề.
 * githubService KHÔNG có cache (mọi lần đọc đều gọi API) nên không cần làm gì.
 */
function invalidate(_path) { /* no-op */ }

// ============================================================
// PATH HELPERS — alias cho code cũ
// ============================================================
function submissionPath(subjectSlug, lessonSlug, userId, timestamp) {
    return submissionFile(subjectSlug, lessonSlug, userId, timestamp);
}

function subjectPath(subjectSlug) {
    return subjectFile(subjectSlug);
}

function lessonPath(subjectSlug, lessonSlug) {
    return lessonFile(subjectSlug, lessonSlug);
}

module.exports = {
    // Core
    writeJsonFile,
    readJsonFile,
    readJsonFileWithSha,
    writeJsonFileIfSha,
    updateJsonFile,
    writeBinaryFile,
    readBinaryFile,
    deleteFile,
    fileExists,
    getFileSha,
    invalidate,

    // Cây thư mục + tên file ngẫu nhiên không trùng
    getRepoTree,
    invalidateTree,
    uniqueJsonPath,

    // Path helpers
    submissionPath,
    subjectPath,
    lessonPath,

    // Config
    isConfigured,
    owner,
    repo,
    branch,

    // Debug
    _octokit: octokit
};