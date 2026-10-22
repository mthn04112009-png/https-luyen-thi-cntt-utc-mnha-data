// services/cookieCryptoService.js
// ============================================================
// MÃ HOÁ 2 CHIỀU cho session/cookie lưu trên GitHub (cookies/index.json)
// ------------------------------------------------------------
//  • Mã cookie (session id = giá trị trong cookie "connect.sid" sau khi bỏ chữ ký) được MÃ HOÁ
//    bằng AES-256-GCM → trên GitHub chỉ có chuỗi mã hoá, không lộ id thật.
//    Mã hoá TẤT ĐỊNH (cùng sid → luôn ra cùng chuỗi) để dùng làm khoá tra cứu O(1) trong file;
//    vẫn GIẢI MÃ ngược lại được ra sid gốc (decryptSid).
//      IV = HMAC-SHA256(khoá IV, sid)[0..12)   (kiểu SIV: sid khác nhau → IV khác nhau)
//      token = "c1." + base64url( IV | authTag | ciphertext )
//  • Dữ liệu session (user đăng nhập, flash...) mã hoá AES-256-GCM với IV NGẪU NHIÊN,
//    gắn AAD = token sid → không thể cắt dán dữ liệu của session này sang session khác.
//      token = "d1." + base64url( IV | authTag | ciphertext )
//
// Khoá gốc: ENCRYPTION_MASTER_KEY (64 hex — đã có sẵn cho API key AI). Nếu thiếu mới dùng SESSION_SECRET.
// Từ khoá gốc suy ra 3 khoá con độc lập bằng HKDF-SHA256 (sid / iv-sid / data).
// Đổi khoá gốc ⇒ session cũ không giải mã được ⇒ coi như hết phiên (người dùng đăng nhập lại), KHÔNG lỗi hệ thống.
// ============================================================
const crypto = require('crypto');

const SID_PREFIX = 'c1.';
const DATA_PREFIX = 'd1.';
const IV_LEN = 12;
const TAG_LEN = 16;

let keys = null;
let warned = false;

function rootKey() {
    const hex = process.env.ENCRYPTION_MASTER_KEY;
    if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');

    // Giống server.js: production bắt buộc phải có secret thật
    const secret = process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'change-this-session-secret');
    if (!secret) {
        throw new Error('Thiếu ENCRYPTION_MASTER_KEY (64 hex) hoặc SESSION_SECRET để mã hoá cookie/session.');
    }
    if (!warned) {
        warned = true;
        console.warn('[cookieCrypto] ENCRYPTION_MASTER_KEY không hợp lệ/thiếu → tạm dùng SESSION_SECRET để mã hoá cookie.');
    }
    return Buffer.from(secret, 'utf8');
}

function derive(root, info) {
    return Buffer.from(crypto.hkdfSync('sha256', root, Buffer.from('luyen-thi-cntt:cookies:v1'), Buffer.from(info), 32));
}

function getKeys() {
    if (keys) return keys;
    const root = rootKey();
    keys = {
        sid: derive(root, 'cookies/sid'),
        sidIv: derive(root, 'cookies/sid-iv'),
        data: derive(root, 'cookies/data')
    };
    return keys;
}

const b64u = (buf) => buf.toString('base64url');

function pack(iv, tag, ct) {
    return b64u(Buffer.concat([iv, tag, ct]));
}

function unpack(token, prefix) {
    if (typeof token !== 'string' || !token.startsWith(prefix)) throw new Error('Token mã hoá không hợp lệ.');
    const raw = Buffer.from(token.slice(prefix.length), 'base64url');
    if (raw.length < IV_LEN + TAG_LEN) throw new Error('Token mã hoá quá ngắn.');
    return {
        iv: raw.subarray(0, IV_LEN),
        tag: raw.subarray(IV_LEN, IV_LEN + TAG_LEN),
        ct: raw.subarray(IV_LEN + TAG_LEN)
    };
}

/** sid → chuỗi mã hoá (tất định, dùng làm khoá trong cookies/index.json). */
function encryptSid(sid) {
    if (typeof sid !== 'string' || !sid) throw new Error('sid không hợp lệ.');
    const k = getKeys();
    const iv = crypto.createHmac('sha256', k.sidIv).update(sid, 'utf8').digest().subarray(0, IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', k.sid, iv);
    const ct = Buffer.concat([cipher.update(sid, 'utf8'), cipher.final()]);
    return SID_PREFIX + pack(iv, cipher.getAuthTag(), ct);
}

/** Chuỗi mã hoá → sid gốc. Ném lỗi nếu bị sửa/sai khoá. */
function decryptSid(token) {
    const k = getKeys();
    const { iv, tag, ct } = unpack(token, SID_PREFIX);
    const decipher = crypto.createDecipheriv('aes-256-gcm', k.sid, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Dữ liệu session (chuỗi JSON) → token mã hoá. aad = token sid tương ứng. */
function encryptData(plain, aad) {
    const k = getKeys();
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', k.data, iv);
    if (aad) cipher.setAAD(Buffer.from(String(aad), 'utf8'));
    const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    return DATA_PREFIX + pack(iv, cipher.getAuthTag(), ct);
}

/** Token mã hoá → chuỗi JSON gốc. */
function decryptData(token, aad) {
    const k = getKeys();
    const { iv, tag, ct } = unpack(token, DATA_PREFIX);
    const decipher = crypto.createDecipheriv('aes-256-gcm', k.data, iv);
    if (aad) decipher.setAAD(Buffer.from(String(aad), 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Chỉ dùng cho test: nạp lại khoá sau khi đổi biến môi trường. */
function _reset() { keys = null; warned = false; }

module.exports = { encryptSid, decryptSid, encryptData, decryptData, _reset };
