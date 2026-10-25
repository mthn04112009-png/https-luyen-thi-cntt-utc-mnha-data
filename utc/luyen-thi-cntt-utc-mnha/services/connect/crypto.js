// services/connect/crypto.js — mã hoá 2 CHIỀU cho dữ liệu "web kết nối" (v-s/index.json).
//   • Khoá chủ: CONNECT_ENC_KEY (≥ 32 ký tự) hoặc SESSION_ENC_KEY / ENCRYPTION_MASTER_KEY
//     (dùng chung .env của mọi web).
//   • AES-256-GCM: chỉ máy chủ có khoá mới đọc lại được. AAD gắn với id web → không thể bê khối
//     mã hoá của web này gán sang web khác.
//   • Khoá kết nối (connection key) KHÔNG bao giờ gửi xuống trình duyệt của người dùng thường;
//     trang admin chỉ hiện 4 ký tự cuối, bản đầy đủ chỉ hiện 1 lần khi web dữ liệu vừa tạo.
'use strict';
const crypto = require('crypto');

let _k = null;
function keys() {
    if (_k) return _k;
    const raw = process.env.CONNECT_ENC_KEY || process.env.SESSION_ENC_KEY || process.env.ENCRYPTION_MASTER_KEY || '';
    if (String(raw).length < 32) {
        throw new Error('Thiếu CONNECT_ENC_KEY (hoặc SESSION_ENC_KEY / ENCRYPTION_MASTER_KEY) ít nhất 32 ký tự — cần để mã hoá/giải mã dữ liệu web kết nối.');
    }
    // Chuỗi mẫu trong .env (envTemplate) là CÔNG KHAI — dùng nguyên văn thì ai đọc được repo cũng giải mã được khoá kết nối.
    // Chỉ CẢNH BÁO (không chặn) để web đang chạy bằng khoá mẫu không bị sập; hãy đổi sang chuỗi ngẫu nhiên.
    if (/^(khoa|chuoi|change-this|your[-_ ])/i.test(String(raw))) {
        console.warn('[connect/crypto] ⚠️ CONNECT_ENC_KEY đang là chuỗi MẪU trong .env (ai cũng biết) — hãy thay bằng chuỗi ngẫu nhiên: openssl rand -base64 48 (giống hệt ở mọi web).');
    }
    if (new Set(String(raw)).size < 8) {
        throw new Error('CONNECT_ENC_KEY quá yếu (ít ký tự khác nhau) — hãy dùng chuỗi ngẫu nhiên, ví dụ: openssl rand -base64 48');
    }
    const master = crypto.scryptSync(String(raw), 'luyen-thi-cntt/connect/v1', 32);
    const sub = (label) => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), label, 32));
    _k = { enc: sub('aes-gcm'), hmac: sub('hmac'), mac: sub('node-mac') };
    return _k;
}
function resetKeys() { _k = null; }          // dùng trong test

const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

/**
 * object/chuỗi → "v2.<iv>.<tag>.<ciphertext>" (mã hoá 2 chiều, AES-256-GCM).
 * v2 bọc kiểu dữ liệu trong phần được mã hoá ({t:'s'|'j', v}) nên giải mã trả về ĐÚNG kiểu đã ghi.
 */
function encrypt(value, aad = '') {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', keys().enc, iv);
    c.setAAD(Buffer.from(String(aad)));
    const env = typeof value === 'string' ? { t: 's', v: value } : { t: 'j', v: value };
    const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(env), 'utf8')), c.final()]);
    return ['v2', b64u(iv), b64u(c.getAuthTag()), b64u(ct)].join('.');
}

/** Giải mã v2 (đúng kiểu) và v1 cũ (đọc được dữ liệu đã ghi trước đây). Sai khoá/sửa/AAD → ném lỗi. */
function decrypt(token, aad = '') {
    const p = String(token || '').split('.');
    if (p.length !== 4 || (p[0] !== 'v1' && p[0] !== 'v2')) throw new Error('Dữ liệu mã hoá không hợp lệ.');
    let text;
    try {
        const d = crypto.createDecipheriv('aes-256-gcm', keys().enc, unb64u(p[1]));
        d.setAAD(Buffer.from(String(aad)));
        d.setAuthTag(unb64u(p[2]));
        text = Buffer.concat([d.update(unb64u(p[3])), d.final()]).toString('utf8');
    } catch (e) {
        if (e && /Unsupported state|authenticate/i.test(e.message)) {
            throw Object.assign(new Error('Không giải mã được dữ liệu kết nối: khoá mã hoá (CONNECT_ENC_KEY / SESSION_ENC_KEY / ENCRYPTION_MASTER_KEY) ở web này KHÁC web đã ghi dữ liệu, hoặc dữ liệu bị sửa.'), { code: 'DECRYPT_FAILED' });
        }
        throw e;
    }
    if (p[0] === 'v2') {
        const env = JSON.parse(text);
        return env.v;
    }
    // v1 (tương thích ngược): chuỗi khoá kết nối luôn là chuỗi hex → không parse thành số.
    if (/^[[{"]|^(true|false|null)$/.test(text)) {
        try { return JSON.parse(text); } catch (_) { /* để nguyên chuỗi */ }
    }
    return text;
}

/** HMAC-SHA256 (hex) — ký yêu cầu giữa web chính và web dữ liệu. */
function hmac(data, label = 'node-mac') {
    return crypto.createHmac('sha256', keys()[label] || keys().mac).update(String(data)).digest('hex');
}

/**
 * HMAC-SHA256 (hex) bằng KHOÁ KẾT NỐI RIÊNG của từng web (nodeKey) + khoá chủ.
 * Nhờ vậy biết CONNECT_ENC_KEY mà không có khoá của web đó vẫn không ký giả được yêu cầu tới web đó.
 */
function hmacWithKey(nodeKey, data) {
    const k = crypto.createHmac('sha256', keys().mac).update('node-key|' + String(nodeKey)).digest();
    return crypto.createHmac('sha256', k).update(String(data)).digest('hex');
}

/** So sánh chuỗi an toàn thời gian. */
function safeEqual(a, b) {
    const x = Buffer.from(String(a == null ? '' : a)), y = Buffer.from(String(b == null ? '' : b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Khoá kết nối mới (64 ký tự hex = 32 byte). */
function newKey() { return crypto.randomBytes(32).toString('hex'); }

/** 4 ký tự cuối để hiển thị/nhận diện, không đủ đoán. */
function hint(key) { return String(key || '').slice(-4); }

module.exports = { encrypt, decrypt, hmac, hmacWithKey, safeEqual, newKey, hint, keys, resetKeys };
