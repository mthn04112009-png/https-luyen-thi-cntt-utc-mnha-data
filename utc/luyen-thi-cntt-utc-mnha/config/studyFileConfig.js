// config/studyFileConfig.js
// ============================================================
// Hằng số dùng chung cho 2 ứng dụng:  /slides (Slide bài học)  và  /documents (Tài liệu học tập)
//
// LƯU TRỮ — CHỈ GitHub (KHÔNG MongoDB):
//   subjects/<slug-môn>/<slides|documents>/<slug>_<unix>.json     thông tin
//   subjects/<slug-môn>/<slides|documents>/<slug>_<unix>.<ext>    file đã MÃ HOÁ (ext = pdf | ppt | pptx)
//   File > 23MB được CHIA NHỎ, mỗi phần ≤ 23MB:  <slug>_<unix>-1.<ext>, <slug>_<unix>-2.<ext>, …
//   Khi xem / tải xuống, server giải mã từng phần rồi NỐI liền mạch lại thành file gốc.
//
// VERCEL cắt request/response > 4.5MB nên file KHÔNG đi 1 lần:
//   - UP  : trình duyệt cắt file thành phần 2MB → mỗi phần 1 request (server mã hoá, lưu tạm thành blob GitHub)
//           → mỗi file-phần ≤ 23MB được gộp + ghi bằng 1 request riêng (để không vượt maxDuration 60s)
//           → request cuối ghi JSON.
//   - XEM : server giải mã và trả từng phần 4MB (?chunk=i), trình duyệt ghép lại.
// ============================================================

const ON_VERCEL = !!process.env.VERCEL;

// Kích thước dùng "MB thập phân" (1MB = 1.000.000 byte) để luôn ≤ 23MB theo cả hai cách hiểu.
const MB = 1000 * 1000;

const envMb = Number(process.env.STUDYFILE_MAX_MB || process.env.SLIDE_MAX_PDF_MB);
const MAX_FILE_BYTES = envMb > 0 ? Math.min(200 * MB, Math.floor(envMb * MB)) : 100 * MB;   // mặc định tối đa 100MB / file

const FRAME_PLAIN_BYTES = 2 * MB;         // phần gửi lên (base64 ≈ 2.7MB < 4.5MB của Vercel)
const FRAME_OVERHEAD = 56;                // header mỗi khung mã hoá (xem services/slideCryptoService.js)
const FILE_MAGIC_BYTES = 4;               // "SLD2" đầu mỗi file lưu trên GitHub
const PART_MAX_BYTES = 23 * MB;           // ★ mỗi file lưu trên GitHub ≤ 23MB
const SERVE_CHUNK_BYTES = 4 * MB;         // phần trả về khi xem (< 4.5MB của Vercel)
const MAX_FRAMES = Math.ceil(MAX_FILE_BYTES / FRAME_PLAIN_BYTES);

const EXT_MIME = {
    pdf: 'application/pdf',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};

const LIMITS = {
    MAX_FILE_BYTES, FRAME_PLAIN_BYTES, FRAME_OVERHEAD, FILE_MAGIC_BYTES, PART_MAX_BYTES, SERVE_CHUNK_BYTES, MAX_FRAMES,
    MAX_TITLE_LEN: 200, MAX_DESC_LEN: 1000, MAX_NAME_LEN: 150
};

/**
 * Chia các khung (kích thước PLAIN của từng khung) thành các file-phần sao cho mỗi file ≤ PART_MAX_BYTES.
 * Trả mảng [{ startFrame, count }]. Trình duyệt (public/js/studyFileForm.js) dùng ĐÚNG công thức này;
 * server kiểm tra lại kích thước thật khi ghi.
 */
function groupFrames(plainSizes) {
    const parts = [];
    let start = 0, bytes = FILE_MAGIC_BYTES, count = 0;
    for (let i = 0; i < plainSizes.length; i++) {
        const f = plainSizes[i] + FRAME_OVERHEAD;
        if (count > 0 && bytes + f > PART_MAX_BYTES) {
            parts.push({ startFrame: start, count });
            start = i; bytes = FILE_MAGIC_BYTES; count = 0;
        }
        bytes += f; count++;
    }
    if (count > 0) parts.push({ startFrame: start, count });
    return parts;
}

/**
 * Cấu hình từng ứng dụng.
 *   dir    : thư mục trên GitHub + tên loại dữ liệu trong githubStore
 *   exts   : định dạng cho phép
 */
const APPS = {
    slides: {
        key: 'slides', dir: 'slides', base: '/slides', idKey: 'slideId',
        name: 'Slide bài học', noun: 'slide', exts: ['pdf', 'ppt', 'pptx'],
        description: 'Xem và tải xuống slide bài học (PDF, PowerPoint) theo từng môn học.',
        icon: 'presentation', viewer: 'slides', accept: '.pdf,.ppt,.pptx'
    },
    documents: {
        key: 'documents', dir: 'documents', base: '/documents', idKey: 'documentId',
        name: 'Tài liệu học tập', noun: 'tài liệu', exts: ['pdf'],
        description: 'Đọc và tải xuống tài liệu học tập (PDF) theo từng môn học: phóng to/nhỏ, cuộn xem như PDF bình thường.',
        icon: 'file-text', viewer: 'document', accept: '.pdf'
    }
};

module.exports = { ON_VERCEL, MB, LIMITS, EXT_MIME, APPS, groupFrames };
