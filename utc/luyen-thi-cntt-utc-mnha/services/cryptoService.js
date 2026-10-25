const crypto = require('crypto');

/**
 * Đọc khoá lúc dùng (không đọc lúc require) → dotenv nạp trễ / biến môi trường Vercel đều hoạt động.
 * Phải đúng 64 ký tự hex (= 32 byte). Giá trị mẫu trong .env (vd "khoa-hex-64-ky-tu...") hoặc 64 ký tự
 * không phải hex trước đây gây lỗi khó hiểu "Invalid key length" — nay báo rõ nguyên nhân.
 */
let _warned = false;
function masterKey() {
    const hex = process.env.ENCRYPTION_MASTER_KEY;
    if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
        if (!_warned) {
            _warned = true;
            console.warn('[cryptoService] ENCRYPTION_MASTER_KEY không hợp lệ (cần 64 ký tự hex = 32 byte, tạo bằng: openssl rand -hex 32).');
        }
        return null;
    }
    return Buffer.from(hex, 'hex');
}

function needKey() {
    const k = masterKey();
    if (!k) {
        throw new Error('ENCRYPTION_MASTER_KEY chưa cấu hình hoặc không hợp lệ (cần đúng 64 ký tự hex = 32 byte).');
    }
    return k;
}

/**
 * Mã hoá plaintext bằng AES-256-GCM.
 * Trả về { iv, content, authTag } (hex strings) — đúng schema AIKey.encryptedKey.
 */
function encrypt(plainText) {
    const MASTER_KEY = needKey();

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, iv);

    const encrypted = Buffer.concat([
        cipher.update(String(plainText), 'utf8'),
        cipher.final()
    ]);

    const authTag = cipher.getAuthTag();

    return {
        iv: iv.toString('hex'),
        content: encrypted.toString('hex'),
        authTag: authTag.toString('hex')
    };
}

/**
 * Giải mã { iv, content, authTag } → plaintext.
 * Chỉ gọi trong RAM, không log.
 */
function decrypt({ iv, content, authTag }) {
    const MASTER_KEY = needKey();

    if (!iv || !content || !authTag) {
        throw new Error('Dữ liệu mã hoá thiếu trường.');
    }

    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        MASTER_KEY,
        Buffer.from(iv, 'hex')
    );

    decipher.setAuthTag(Buffer.from(authTag, 'hex'));

    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(content, 'hex')),
        decipher.final()
    ]);

    return decrypted.toString('utf8');
}

/**
 * Lấy 4 ký tự cuối của key để hiển thị (không lộ key).
 */
function maskKey(plainKey) {
    if (!plainKey || plainKey.length < 4) return '****';
    return '...' + plainKey.slice(-4);
}

module.exports = { encrypt, decrypt, maskKey };