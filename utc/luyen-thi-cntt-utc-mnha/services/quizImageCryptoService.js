// ============================================================
// quizImageCryptoService — ẢNH CÂU HỎI MÃ HOÁ (AES-256-GCM), dùng cho nút "🔒 Tải ảnh (mã hoá)" ở /admin/quiz/new|edit
// ------------------------------------------------------------
// Ý tưởng: ảnh được MÃ HOÁ NGAY TRONG TRÌNH DUYỆT của admin rồi mới lưu lên GitHub (cache/image/<ts>.enc) → ai mở link raw cũng
//   chỉ thấy dữ liệu mã hoá, không phải ảnh ⇒ KHÔNG cần Cloudinary kiểm duyệt. Khi sinh viên mở tới câu có ảnh, trình duyệt tự
//   xin khoá (đã đăng nhập + được duyệt) và giải mã ảnh (public/js/quizEncImage.js).
//
// Định dạng file (nhị phân):  "QIM1"(4) | salt(16) | iv(12) | authTag(16) | ciphertext
//   AAD = "QIM1"
//   khoá = HKDF-SHA256(ENCRYPTION_MASTER_KEY, salt, "luyen-thi-cntt:quiz-image:v1")  — INFO RIÊNG, khác slide/tài liệu → khoá cấp cho
//   sinh viên để xem ảnh quiz KHÔNG giải mã được slide/tài liệu. Khoá gốc không rời máy chủ.
// Máy chủ vẫn giải mã thử 1 lần lúc nhận (kiểm GCM + đúng là ảnh) nên file rác / không phải ảnh bị từ chối.
// ============================================================
'use strict';
const crypto = require('crypto');

const MAGIC = Buffer.from('QIM1', 'ascii');
const SALT_LEN = 16, IV_LEN = 12, TAG_LEN = 16;
const HEAD = MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN;
const INFO = 'luyen-thi-cntt:quiz-image:v1';

function masterKey() {
    const hex = process.env.ENCRYPTION_MASTER_KEY;
    if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) return null;
    return Buffer.from(hex, 'hex');
}

function isConfigured() { return !!masterKey(); }

function needKey() {
    const k = masterKey();
    if (!k) {
        const e = new Error('Máy chủ chưa cấu hình ENCRYPTION_MASTER_KEY (64 ký tự hex) nên chưa mã hoá / giải mã được ảnh.');
        e.status = 503;
        throw e;
    }
    return k;
}

function keyFor(master, salt) {
    return Buffer.from(crypto.hkdfSync('sha256', master, salt, INFO, 32));
}

/** salt (base64url, 16 byte) → khoá (base64url, 32 byte) để TRÌNH DUYỆT tự mã hoá / giải mã bằng Web Crypto. */
function deriveKey(saltB64u) {
    const master = needKey();
    const salt = Buffer.from(String(saltB64u || ''), 'base64url');
    if (salt.length !== SALT_LEN) {
        const e = new Error('Salt không hợp lệ.');
        e.status = 400;
        throw e;
    }
    return keyFor(master, salt).toString('base64url');
}

function deriveKeys(salts) { return salts.map(deriveKey); }

/** Mã hoá (dùng cho test / công cụ; trình duyệt tự mã hoá, không gọi hàm này). */
function encrypt(plain) {
    const master = needKey();
    const salt = crypto.randomBytes(SALT_LEN), iv = crypto.randomBytes(IV_LEN);
    const c = crypto.createCipheriv('aes-256-gcm', keyFor(master, salt), iv);
    c.setAAD(MAGIC);
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), ct]);
}

/** Giải mã cả file → ảnh gốc. Sai định dạng / sai khoá / bị sửa → ném lỗi (status 400). */
function decrypt(blob) {
    const master = needKey();
    if (!Buffer.isBuffer(blob) || blob.length <= HEAD || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
        const e = new Error('File ảnh mã hoá không đúng định dạng.');
        e.status = 400;
        throw e;
    }
    let o = MAGIC.length;
    const salt = blob.subarray(o, o += SALT_LEN);
    const iv = blob.subarray(o, o += IV_LEN);
    const tag = blob.subarray(o, o += TAG_LEN);
    try {
        const d = crypto.createDecipheriv('aes-256-gcm', keyFor(master, salt), iv);
        d.setAAD(MAGIC);
        d.setAuthTag(tag);
        return Buffer.concat([d.update(blob.subarray(o)), d.final()]);
    } catch (_) {
        const e = new Error('Ảnh mã hoá không giải mã được (sai khoá hoặc dữ liệu bị sửa).');
        e.status = 400;
        throw e;
    }
}

module.exports = { MAGIC, HEAD, isConfigured, deriveKey, deriveKeys, encrypt, decrypt };
