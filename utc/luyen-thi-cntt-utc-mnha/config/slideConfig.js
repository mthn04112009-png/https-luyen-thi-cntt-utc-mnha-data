// config/slideConfig.js
// ============================================================
// Hằng số cho ỨNG DỤNG SLIDE HỌC TẬP (/slides). KHÔNG đặt trong .env (trừ SLIDE_MAX_PDF_MB tuỳ chọn).
//
// Lưu trữ: CHỈ trên GitHub (KHÔNG MongoDB)
//   subjects/<slug-môn>/slides/<slug-slide>_<unix>.json   thông tin slide (tiêu đề, môn, đường dẫn PDF…)
//   subjects/<slug-môn>/slides/<slug-slide>_<unix>.pdf    file PDF đã MÃ HOÁ AES-256-GCM (mở thẳng trên GitHub chỉ thấy dữ liệu rối)
// Chỉ khi xem / tải xuống qua web app, server mới giải mã (services/slideCryptoService.js).
//
// PDF tối đa 20MB. Vercel cắt request/response > 4.5MB nên file KHÔNG đi 1 lần mà chia PHẦN:
//   - UP   : trình duyệt cắt PDF thành phần 2MB → mỗi phần gửi 1 request (server mã hoá rồi lưu tạm thành blob GitHub)
//            → request cuối gộp các phần thành 1 file .pdf mã hoá duy nhất.
//   - XEM  : server giải mã và trả từng phần ≤ 3MB (?chunk=i), trình duyệt ghép lại rồi nhúng PDF.
// → localhost và Vercel dùng chung 1 đường chạy.
// ============================================================

const ON_VERCEL = !!process.env.VERCEL;

const HARD_CAP_BYTES = 50 * 1024 * 1024;                 // GitHub Contents API ≤ 100MB; giữ trần an toàn 50MB
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;              // ★ giới hạn mặc định: 20MB
const envMb = Number(process.env.SLIDE_MAX_PDF_MB);
const MAX_PDF_BYTES = envMb > 0 ? Math.min(HARD_CAP_BYTES, Math.floor(envMb * 1024 * 1024)) : DEFAULT_MAX_BYTES;

const UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024;              // phần gửi lên: 2MB (base64 ≈ 2.7MB < 4.5MB của Vercel)
const SERVE_CHUNK_BYTES = 3 * 1024 * 1024;               // phần trả về khi xem: 3MB (< 4.5MB của Vercel)
const MAX_CHUNKS = Math.ceil(MAX_PDF_BYTES / UPLOAD_CHUNK_BYTES);

const LIMITS = {
    MAX_PDF_BYTES,
    UPLOAD_CHUNK_BYTES,
    SERVE_CHUNK_BYTES,
    MAX_CHUNKS,
    MAX_TITLE_LEN: 200,
    MAX_DESC_LEN: 1000,
    MAX_NAME_LEN: 150
};

module.exports = { ON_VERCEL, LIMITS };
