// services/videoCryptoService.js
// Mã hoá 2 chiều AES-256-GCM cho mã nhúng iframe (Video bài giảng)
// Cùng nguyên tắc với slideCrypto nhưng dùng key riêng context
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const VERSION = 'v1';
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey = null;

function getKey() {
    if (cachedKey) return cachedKey;
    const hex = (process.env.ENCRYPTION_MASTER_KEY || '').trim();
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        return null;
    }
    cachedKey = Buffer.from(hex, 'hex');
    if (cachedKey.length !== KEY_LEN) cachedKey = null;
    return cachedKey;
}

function isConfigured() {
    return getKey() !== null;
}

function encryptText(plain) {
    const key = getKey();
    if (!key) throw new Error('ENCRYPTION_MASTER_KEY chưa cấu hình (cần 64 hex).');
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const buf = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    // v1.iv.tag.ciphertext (base64url)
    return VERSION + '.' +
        iv.toString('base64url') + '.' +
        tag.toString('base64url') + '.' +
        buf.toString('base64url');
}

function decryptText(enc) {
    const key = getKey();
    if (!key) throw new Error('ENCRYPTION_MASTER_KEY chưa cấu hình.');
    if (typeof enc !== 'string') throw new Error('Dữ liệu mã hoá không hợp lệ.');
    const parts = enc.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('Phiên bản mã hoá không hỗ trợ.');
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const ct = Buffer.from(parts[3], 'base64url');
    if (iv.length !== IV_LEN || tag.length !== TAG_LEN) throw new Error('Dữ liệu mã hoá không hợp lệ.');
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const buf = Buffer.concat([decipher.update(ct), decipher.final()]);
    return buf.toString('utf8');
}

module.exports = { encryptText, decryptText, isConfigured };
