// ============================================================
// slideCryptoService — MÃ HOÁ / GIẢI MÃ file PDF slide (AES-256-GCM, theo từng KHUNG)
// ------------------------------------------------------------
// Mục đích: repo GitHub có thể bị xem công khai → file .pdf lưu trên GitHub luôn ở dạng đã mã hoá.
// Khoá: ENCRYPTION_MASTER_KEY (64 ký tự hex — đã dùng cho API key AI). Mỗi khung có salt riêng,
//       khoá khung = HKDF-SHA256(masterKey, salt, "luyen-thi-cntt:slide-pdf:v2") → không dùng thẳng khoá gốc.
//
// Vì sao theo khung: PDF tới 20MB không thể gửi 1 request lên Vercel (≤ 4.5MB). Trình duyệt gửi từng phần 2MB,
// mỗi phần được mã hoá độc lập thành 1 KHUNG; cuối cùng các khung được nối thành 1 file .pdf.
//
// Định dạng file (nhị phân):
//   "SLD2"(4) | khung 0 | khung 1 | …
//   khung = index(4,BE) | total(4,BE) | ctLen(4,BE) | salt(16) | iv(12) | authTag(16) | ciphertext
//   AAD = "SLD2" | index | total  → đảo thứ tự / bỏ bớt / ghép khung của file khác đều bị GCM phát hiện.
//
// File lớn được CHIA thành nhiều file-phần (mỗi phần ≤ 23MB, xem config/studyFileConfig.js): mỗi file-phần có "SLD2" + một dãy
// khung LIÊN TIẾP; index/total của khung tính trên TOÀN BỘ file gốc → nối các phần theo thứ tự là ra lại dãy khung đầy đủ.
// Master key phải GIỐNG NHAU ở localhost và Vercel.
// ============================================================
const crypto = require('crypto');

const MAGIC = Buffer.from('SLD2', 'ascii');
const SALT_LEN = 16, IV_LEN = 12, TAG_LEN = 16;
const FRAME_HEAD = 12 + SALT_LEN + IV_LEN + TAG_LEN;     // index+total+ctLen + salt + iv + tag
const INFO = 'luyen-thi-cntt:slide-pdf:v2';

/** Đọc khoá lúc gọi (không lúc require) → dotenv nạp trễ / Vercel env đều hoạt động. */
function masterKey() {
    const hex = process.env.ENCRYPTION_MASTER_KEY;
    if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) return null;
    return Buffer.from(hex, 'hex');
}

function isConfigured() {
    return !!masterKey();
}

function needKey() {
    const k = masterKey();
    if (!k) throw new Error('ENCRYPTION_MASTER_KEY chưa cấu hình (cần 64 ký tự hex) nên chưa mã hoá/giải mã được PDF.');
    return k;
}

function frameKey(master, salt) {
    return Buffer.from(crypto.hkdfSync('sha256', master, salt, INFO, 32));
}

function aad(index, total) {
    const b = Buffer.alloc(MAGIC.length + 8);
    MAGIC.copy(b, 0);
    b.writeUInt32BE(index, MAGIC.length);
    b.writeUInt32BE(total, MAGIC.length + 4);
    return b;
}

/** Mã hoá 1 phần PDF → 1 khung. index: 0..total-1 */
function encryptFrame(plain, index, total) {
    const master = needKey();
    if (!Buffer.isBuffer(plain)) throw new Error('encryptFrame: dữ liệu phải là Buffer');
    if (!Number.isInteger(index) || !Number.isInteger(total) || index < 0 || total < 1 || index >= total) {
        throw new Error('encryptFrame: index/total không hợp lệ');
    }
    const salt = crypto.randomBytes(SALT_LEN);
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', frameKey(master, salt), iv);
    cipher.setAAD(aad(index, total));
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);

    const head = Buffer.alloc(12);
    head.writeUInt32BE(index, 0);
    head.writeUInt32BE(total, 4);
    head.writeUInt32BE(ct.length, 8);
    return Buffer.concat([head, salt, iv, cipher.getAuthTag(), ct]);
}

function parseFrame(buf, offset) {
    if (offset + FRAME_HEAD > buf.length) throw new Error('File PDF mã hoá bị cắt cụt.');
    const index = buf.readUInt32BE(offset);
    const total = buf.readUInt32BE(offset + 4);
    const ctLen = buf.readUInt32BE(offset + 8);
    let o = offset + 12;
    const salt = buf.subarray(o, o += SALT_LEN);
    const iv = buf.subarray(o, o += IV_LEN);
    const tag = buf.subarray(o, o += TAG_LEN);
    if (o + ctLen > buf.length) throw new Error('File PDF mã hoá bị cắt cụt.');
    return { index, total, salt, iv, tag, ct: buf.subarray(o, o + ctLen), end: o + ctLen };
}

function decryptParsed(master, f) {
    const d = crypto.createDecipheriv('aes-256-gcm', frameKey(master, f.salt), f.iv);
    d.setAAD(aad(f.index, f.total));
    d.setAuthTag(f.tag);
    return Buffer.concat([d.update(f.ct), d.final()]);
}

/** Giải mã 1 khung đơn lẻ (dùng khi kiểm tra từng phần lúc gộp) → { plain, index, total } */
function decryptFrame(frame) {
    const master = needKey();
    const f = parseFrame(frame, 0);
    if (f.end !== frame.length) throw new Error('Khung mã hoá thừa dữ liệu.');
    return { plain: decryptParsed(master, f), index: f.index, total: f.total };
}

/** Nối các khung (theo đúng thứ tự index) thành nội dung file .pdf mã hoá. */
function joinFrames(frames) {
    return Buffer.concat([MAGIC, ...frames]);
}

/** Giải mã cả file .pdf mã hoá → PDF gốc. Kiểm tra đủ & đúng thứ tự khung. */
function decryptFile(blob) {
    const master = needKey();
    if (!Buffer.isBuffer(blob) || blob.length < MAGIC.length + FRAME_HEAD || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw new Error('File PDF trên GitHub không đúng định dạng mã hoá.');
    }
    const parts = [];
    let off = MAGIC.length, expect = 0, total = -1;
    while (off < blob.length) {
        const f = parseFrame(blob, off);
        if (f.index !== expect) throw new Error('Thứ tự khung mã hoá không đúng.');
        if (total === -1) total = f.total;
        if (f.total !== total) throw new Error('Số khung mã hoá không đồng nhất.');
        parts.push(decryptParsed(master, f));
        expect++;
        off = f.end;
    }
    if (expect !== total) throw new Error('File PDF mã hoá thiếu khung.');
    return Buffer.concat(parts);
}

/**
 * Giải mã 1 file-phần: "SLD2" + các khung liên tiếp bắt đầu từ khung startIndex.
 *   total (tuỳ chọn): số khung của TOÀN file — nếu cho, mọi khung phải khớp.
 * Trả { plain, count, total }. Khung sai thứ tự / sai khoá / bị sửa → ném lỗi.
 */
function decryptPart(blob, startIndex = 0, total = null) {
    const master = needKey();
    if (!Buffer.isBuffer(blob) || blob.length < MAGIC.length + FRAME_HEAD || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw new Error('File trên GitHub không đúng định dạng mã hoá.');
    }
    const parts = [];
    // startIndex = null: khi ĐỌC lại file đã lưu — lấy theo khung đầu của phần (GCM đã gắn index vào AAD nên vẫn chống sửa/đảo khung)
    let off = MAGIC.length, expect = startIndex, seenTotal = total;
    while (off < blob.length) {
        const f = parseFrame(blob, off);
        if (expect === null) expect = f.index;
        if (f.index !== expect) throw new Error('Thứ tự khung mã hoá không đúng.');
        if (seenTotal === null) seenTotal = f.total;
        if (f.total !== seenTotal) throw new Error('Số khung mã hoá không đồng nhất.');
        parts.push(decryptParsed(master, f));
        expect++;
        off = f.end;
    }
    const first = startIndex === null ? (parts.length ? expect - parts.length : 0) : startIndex;
    return { plain: Buffer.concat(parts), count: expect === null ? 0 : expect - first, total: seenTotal };
}

/** Nối nhiều file-phần (theo thứ tự) rồi giải mã liền mạch → file gốc. */
function decryptParts(blobs) {
    let expect = 0, total = null;
    const out = [];
    for (const b of blobs) {
        const r = decryptPart(b, expect, total);
        total = r.total; expect += r.count;
        out.push(r.plain);
    }
    if (total === null || expect !== total) throw new Error('File mã hoá thiếu khung (thiếu file-phần?).');
    return Buffer.concat(out);
}

/** Chữ ký HMAC cho thông tin 1 file-phần mà server vừa ghi — để request tạo slide không thể khai man đường dẫn/kích thước. */
function metaSig(fields) {
    const master = needKey();
    const key = Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), 'luyen-thi-cntt:study-part-sig:v1', 32));
    return crypto.createHmac('sha256', key).update(fields.map(String).join('|')).digest('hex');
}
function verifyMetaSig(fields, sig) {
    if (typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) return false;
    return crypto.timingSafeEqual(Buffer.from(metaSig(fields), 'hex'), Buffer.from(sig, 'hex'));
}

module.exports = {
    encryptFrame, decryptFrame, joinFrames, decryptFile, decryptPart, decryptParts, metaSig, verifyMetaSig, isConfigured, MAGIC, FRAME_HEAD
};

