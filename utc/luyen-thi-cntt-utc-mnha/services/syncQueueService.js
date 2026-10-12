// ============================================================
// SYNC QUEUE - In-memory queue + retry cho GitHub sync
// ============================================================
// Hỗ trợ 2 signature:
//   enqueue(job)     — job = { type, filePath, data, commitMessage, onSuccess, onFinalFail }
//                      (cũng nhận path/payload/content và onCommitted/onFailed)
//   enqueueSync(job) — alias của enqueue (backward compat)
//
// Job types:
//   - 'putJson'    → ghi file JSON (submission, lesson, subject)
//   - 'putBinary'  → ghi file nhị phân (ảnh bản vẽ tay của bài nộp) — data = Buffer
//   - 'deleteFile' → xoá file
// ============================================================

const { writeJsonFile, writeBinaryFile, deleteFile } = require('./githubService');

const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 2000;

let _isProcessing = false;
const _queue = [];
let _successCount = 0;
let _failCount = 0;

/**
 * Chuẩn hoá job — chấp nhận nhiều format khác nhau từ code cũ.
 */
function normalizeJob(job) {
    if (!job) return null;

    const filePath = job.filePath || job.path;
    const data = job.data !== undefined ? job.data
        : (job.payload !== undefined ? job.payload : job.content);
    const type = job.type || 'putJson';

    // deleteFile không cần data; putJson bắt buộc có data
    if (!filePath || (type === 'putJson' && (data === undefined || data === null))) {
        console.warn('[syncQueue] Job không hợp lệ (thiếu filePath/path hoặc data/payload/content):',
            { type, filePath, hasData: data !== undefined && data !== null });
        return null;
    }

    return {
        type,
        filePath,
        data,
        commitMessage: job.commitMessage || `Update ${filePath}`,
        submissionId: job.submissionId,
        lessonId: job.lessonId,
        // Chấp nhận cả tên callback của quiz (onCommitted/onFailed) để không còn "nuốt" job im lặng
        onSuccess: job.onSuccess || job.onCommitted,
        onFinalFail: job.onFinalFail || job.onFailed
    };
}

/**
 * Thêm job vào queue.
 */
function enqueue(job) {
    const normalized = normalizeJob(job);
    if (!normalized) return null;

    const item = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        type: normalized.type,
        filePath: normalized.filePath,
        data: normalized.data,
        commitMessage: normalized.commitMessage,
        submissionId: normalized.submissionId,
        lessonId: normalized.lessonId,
        onSuccess: normalized.onSuccess,
        onFinalFail: normalized.onFinalFail,
        attempts: 0,
        createdAt: new Date()
    };

    _queue.push(item);
    console.log(`📥 [syncQueue] Enqueue ${item.type} → ${item.filePath} (queue size: ${_queue.length})`);

    // Bắt đầu xử lý (nếu chưa)
    setImmediate(processNext);

    return item.id;
}

/**
 * Chạy 1 job.
 */
async function runJob(job) {
    switch (job.type) {
        case 'putJson':
            if (!job.data) {
                throw new Error('Job putJson thiếu data');
            }
            return writeJsonFile(job.filePath, job.data, job.commitMessage);

        case 'putBinary':
            if (!Buffer.isBuffer(job.data)) {
                throw new Error('Job putBinary cần data là Buffer');
            }
            return writeBinaryFile(job.filePath, job.data, job.commitMessage);

        case 'deleteFile':
            return deleteFile(job.filePath, job.commitMessage);

        default:
            throw new Error(`Job type không hỗ trợ: ${job.type}`);
    }
}

/**
 * Xử lý job tiếp theo trong queue.
 */
async function processNext() {
    if (_isProcessing || _queue.length === 0) return;
    _isProcessing = true;

    const job = _queue.shift();
    job.attempts += 1;

    try {
        const result = await runJob(job);
        _successCount++;
        console.log(`✅ [syncQueue] ${job.id} OK (attempt ${job.attempts}) → ${job.filePath}`);

        if (typeof job.onSuccess === 'function') {
            try {
                await job.onSuccess(result);
            } catch (e) {
                console.warn(`⚠️ [syncQueue] onSuccess fail: ${e.message}`);
            }
        }
    } catch (e) {
        const willRetry = job.attempts < MAX_ATTEMPTS;

        if (willRetry) {
            console.warn(
                `❌ [syncQueue] ${job.id} fail (attempt ${job.attempts}/${MAX_ATTEMPTS}): ${e.message} — sẽ retry sau ${RETRY_DELAY_MS * job.attempts}ms`
            );
            setTimeout(() => {
                _queue.push(job);
                setImmediate(processNext);
            }, RETRY_DELAY_MS * job.attempts);
        } else {
            _failCount++;
            console.error(
                `❌ [syncQueue] ${job.id} FAIL VĨNH VIỄN sau ${MAX_ATTEMPTS} lần: ${e.message}`
            );

            if (typeof job.onFinalFail === 'function') {
                try {
                    await job.onFinalFail(e);
                } catch (err) {
                    console.warn(`⚠️ [syncQueue] onFinalFail fail: ${err.message}`);
                }
            }
        }
    } finally {
        _isProcessing = false;
        setImmediate(processNext);
    }
}

/**
 * Số job đang chờ.
 */
function size() {
    return _queue.length;
}

/**
 * Thống kê queue.
 */
function stats() {
    return {
        pending: _queue.length,
        processing: _isProcessing,
        success: _successCount,
        fail: _failCount
    };
}

module.exports = {
    enqueue,
    enqueueSync: enqueue,   // ← alias cho backward compat
    size,
    stats
};