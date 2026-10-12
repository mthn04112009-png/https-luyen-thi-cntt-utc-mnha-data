// ============================================================
// DRAWING SERVICE — xử lý bản vẽ tay (JS Paint) của bài tự luận
// ------------------------------------------------------------
//  - parseDrawingDataUrl(): kiểm tra data URL gửi từ trình duyệt (png/jpeg,
//    đúng magic bytes, giới hạn dung lượng) → { buffer, mimeType, base64, ext }
//  - formatDrawingAnalysis(): đổi kết quả phân tích ảnh thành đoạn text đưa vào prompt chấm
//
// Ảnh được client nén sẵn ≤ ~800KB (GitHub Contents API chỉ đọc lại được file ≤ 1MB).
// ============================================================

const MAX_DRAWING_BYTES = 950 * 1024; // < 1MB để đọc lại được qua GitHub Contents API

const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg' };

function hasMagic(buf, mime) {
    if (mime === 'image/png') {
        return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    }
    if (mime === 'image/jpeg') {
        return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    }
    return false;
}

/**
 * @param {string} dataUrl  "data:image/png;base64,...."
 * @returns {null | {buffer:Buffer, mimeType:string, base64:string, ext:string}}
 *          null nếu không gửi ảnh. Ném Error (message tiếng Việt, err.status=400/413) nếu ảnh sai.
 */
function parseDrawingDataUrl(dataUrl) {
    if (dataUrl === undefined || dataUrl === null || String(dataUrl).trim() === '') return null;

    const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl).trim());
    if (!m) {
        const e = new Error('Bản vẽ không hợp lệ (chỉ nhận ảnh PNG/JPEG).');
        e.status = 400;
        throw e;
    }

    const mimeType = m[1];
    const base64 = m[2].replace(/\s+/g, '');
    const buffer = Buffer.from(base64, 'base64');

    if (!buffer.length || !hasMagic(buffer, mimeType)) {
        const e = new Error('Bản vẽ không hợp lệ (dữ liệu ảnh bị hỏng).');
        e.status = 400;
        throw e;
    }
    if (buffer.length > MAX_DRAWING_BYTES) {
        const e = new Error('Bản vẽ quá nặng (> 950KB). Hãy bấm "Xoá bớt"/vẽ gọn hơn rồi nộp lại.');
        e.status = 413;
        throw e;
    }

    return { buffer, mimeType, base64, ext: MIME_EXT[mimeType] };
}

/** Đoạn text mô tả bản vẽ (kết quả bước phân tích ảnh) để đưa vào prompt chấm. */
function formatDrawingAnalysis(a) {
    if (!a) return '';
    const lines = [];
    lines.push(`Loại nội dung: ${a.kind || 'không rõ'} — độ rõ nét: ${a.legibility || 'không rõ'}`);
    if (a.transcription) lines.push(`Chữ/số/ký hiệu đọc được:\n${a.transcription}`);
    if (a.description) lines.push(`Mô tả bố cục & quan hệ giữa các thành phần:\n${a.description}`);
    if (Array.isArray(a.elements) && a.elements.length) {
        lines.push(
            'Các thành phần:\n' +
            a.elements
                .map((e, i) => `${i + 1}. [${e.type || '?'}] ${e.label || ''}${e.detail ? ' — ' + e.detail : ''}`)
                .join('\n')
        );
    }
    if (Array.isArray(a.uncertain) && a.uncertain.length) {
        lines.push('Chỗ chưa chắc chắn:\n- ' + a.uncertain.join('\n- '));
    }
    return lines.join('\n\n');
}

module.exports = { MAX_DRAWING_BYTES, parseDrawingDataUrl, formatDrawingAnalysis };
