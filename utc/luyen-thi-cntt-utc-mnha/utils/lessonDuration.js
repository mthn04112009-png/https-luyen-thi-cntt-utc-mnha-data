// ============================================================
// Thời gian làm bài của bài học (tự luận + trắc nghiệm)
//   • số nguyên 1..600  → ĐẾM GIỜ (phút)     — "duration": 75
//   • null              → KHÔNG ĐẾM GIỜ      — "duration": null
// Dữ liệu cũ chưa có field duration (undefined) → mặc định 20 phút như trước.
// ============================================================
const DURATION_MIN = 1;
const DURATION_MAX = 600;
const DURATION_DEFAULT = 20;

/** Đọc duration đã lưu: null = không đếm giờ; undefined/rác = mặc định 20. */
function fromStored(v, fallback = DURATION_DEFAULT) {
    if (v === null) return null;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return Math.min(Math.max(Math.round(n), DURATION_MIN), DURATION_MAX);
    return fallback;
}

/** true nếu bài không đếm giờ. */
function isUntimed(v) { return v === null; }

/**
 * Đọc từ body form/JSON:
 *   timerMode = 'untimed' (hoặc duration = null / 'null' / 'none') → null
 *   còn lại → số phút (mặc định 20 nếu rỗng/sai).
 * Trả undefined nếu body không hề gửi thông tin thời gian (để update giữ nguyên giá trị cũ).
 */
function fromBody(body, fallback = DURATION_DEFAULT) {
    const b = body || {};
    const mode = b.timerMode;
    if (mode === undefined && b.duration === undefined) return undefined;
    if (mode === 'untimed' || mode === 'none' || mode === 'false') return null;
    const d = b.duration;
    if (d === null || d === 'null' || d === 'none') return null;
    return fromStored(d, fallback);
}

module.exports = { DURATION_MIN, DURATION_MAX, DURATION_DEFAULT, fromStored, isUntimed, fromBody };
