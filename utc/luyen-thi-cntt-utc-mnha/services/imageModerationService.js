// ============================================================
// IMAGE MODERATION SERVICE — kiểm duyệt ảnh viết tay bằng Cloudinary
// ------------------------------------------------------------
//  Luồng (xem controllers/drawingUpload.controller.js):
//    1. moderate(buffer, onApproved)
//         a. đẩy ảnh lên Cloudinary (type "private") kèm tham số `moderation`
//            (mặc định add-on Amazon Rekognition: "aws_rek")
//         b. bị "rejected" (ảnh nhạy cảm) → ném lỗi SENSITIVE_IMAGE (422), KHÔNG lưu đâu cả
//         c. được "approved" → chạy onApproved() (ở controller: ghi ảnh TẠM lên GitHub)
//         d. LUÔN xoá ảnh khỏi Cloudinary (finally), dù thành công hay lỗi
//    2. signUploadToken / verifyUploadToken: token HMAC chứng nhận "user này đã có ảnh qua kiểm duyệt"
//
//  Tài khoản Cloudinary: lưu ở MongoDB (trang /admin/ai-keys/cloudinary, mã hoá AES-256-GCM) —
//  người upload chọn 1 hoặc nhiều CLOUDINARY_CLOUD_NAME; ảnh phải được TẤT CẢ tài khoản đã chọn duyệt.
//  (.env CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET vẫn dùng được như 1 tài khoản dự phòng.)
//  Env tuỳ chọn:
//    CLOUDINARY_MODERATION   mặc định "aws_rek" (hoặc "aws_rek:explicit_nudity:0.6:..." / "webpurify")
//    CLOUDINARY_MAX_BYTES    mặc định 10485760 (10MB = giới hạn ảnh của gói Free Cloudinary)
//
//  Lưu ý: add-on kiểm duyệt phải được bật (Cloudinary Console → Add-ons → Amazon Rekognition AI
//  Moderation, có free tier). Chưa bật / kết quả không rõ → CHẶN ảnh (fail-closed).
// ============================================================

const crypto = require('crypto');

const MAX_UPLOAD_BYTES = Number(process.env.CLOUDINARY_MAX_BYTES) > 0
    ? Number(process.env.CLOUDINARY_MAX_BYTES)
    : 10 * 1024 * 1024;

const MODERATION = (process.env.CLOUDINARY_MODERATION || 'aws_rek').trim();
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // token dùng được trong 2 giờ
const UPLOAD_FOLDER = 'drawing-moderation';

const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

function fail(message, status, code) {
    const e = new Error(message);
    e.status = status;
    if (code) e.code = code;
    return e;
}

/** Nhận diện loại ảnh bằng magic bytes (không tin Content-Type do client gửi). */
function sniffMime(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return null;
}

/**
 * Nhận diện ảnh nhiều đuôi bằng magic bytes (dùng cho ảnh câu hỏi).
 * @returns {null | {mime:string, ext:string}}  png | jpg | webp | gif | bmp | avif
 */
function sniffImage(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
    const m = sniffMime(buf);
    if (m) return { mime: m, ext: MIME_EXT[m] };
    const head6 = buf.toString('ascii', 0, 6);
    if (head6 === 'GIF87a' || head6 === 'GIF89a') return { mime: 'image/gif', ext: 'gif' };
    if (buf[0] === 0x42 && buf[1] === 0x4d) return { mime: 'image/bmp', ext: 'bmp' };
    if (buf.toString('ascii', 4, 8) === 'ftyp') {
        const brand = buf.toString('ascii', 8, 12);
        if (brand === 'avif' || brand === 'avis') return { mime: 'image/avif', ext: 'avif' };
    }
    return null;
}

let _lib = null;
function cloudinaryLib() {
    if (_lib) return _lib;
    try {
        _lib = require('cloudinary').v2;
    } catch (e) {
        console.error('[imageModeration] Thiếu package "cloudinary" — chạy: npm i cloudinary');
        throw fail('Máy chủ chưa cài đặt dịch vụ kiểm duyệt ảnh.', 503);
    }
    return _lib;
}

/** Tuỳ chọn xác thực cho TỪNG lần gọi (không dùng cấu hình toàn cục vì có nhiều tài khoản). */
function authOptions(account) {
    return {
        cloud_name: account.cloudName,
        api_key: account.apiKey,
        api_secret: account.apiSecret,
        secure: true
    };
}

function uploadBuffer(lib, buffer, options) {
    return new Promise((resolve, reject) => {
        const stream = lib.uploader.upload_stream(options, (err, result) => {
            if (err) return reject(err);
            resolve(result);
        });
        stream.on('error', reject);
        stream.end(buffer);
    });
}

/** 'approved' | 'rejected' | 'pending' | 'missing' */
function verdictOf(result) {
    const list = Array.isArray(result && result.moderation) ? result.moderation : [];
    if (!list.length) return 'missing';
    if (list.some(m => m && m.status === 'rejected')) return 'rejected';
    if (list.every(m => m && m.status === 'approved')) return 'approved';
    return 'pending';
}

function describeLabels(result) {
    try {
        const labels = [];
        for (const m of result.moderation || []) {
            const ls = m && m.response && m.response.moderation_labels;
            if (Array.isArray(ls)) ls.forEach(l => labels.push(`${l.name}:${Math.round(l.confidence || 0)}`));
        }
        return labels.join(', ');
    } catch (_) {
        return '';
    }
}

async function destroyQuietly(lib, account, publicId) {
    if (!publicId) return;
    try {
        await lib.uploader.destroy(publicId, {
            ...authOptions(account),
            resource_type: 'image',
            type: 'private',
            invalidate: true
        });
    } catch (e) {
        console.warn(`[imageModeration] Không xoá được ảnh Cloudinary (${account.cloudName}) ${publicId}: ${e.message || e}`);
    }
}

/**
 * Kiểm duyệt ảnh bằng MỘT tài khoản Cloudinary.
 * onApproved chạy khi ảnh được duyệt, trong lúc ảnh còn trên Cloudinary.
 */
async function moderateOne(buffer, onApproved, account) {
    const lib = cloudinaryLib();
    const auth = authOptions(account);

    const publicId = `${UPLOAD_FOLDER}/${crypto.randomBytes(16).toString('hex')}`;
    let uploaded = null;

    try {
        try {
            uploaded = await uploadBuffer(lib, buffer, {
                ...auth,
                resource_type: 'image',
                type: 'private',            // không công khai ảnh
                public_id: publicId,
                overwrite: false,
                moderation: MODERATION
            });
        } catch (e) {
            const raw = String((e && (e.message || (e.error && e.error.message))) || e);
            console.error(`[imageModeration] Upload Cloudinary (${account.cloudName}) lỗi:`, raw);
            if (/too large|maximum|exceed|megapixel/i.test(raw)) {
                throw fail('Ảnh vượt giới hạn của Cloudinary (tối đa 10MB và 25 megapixel). Hãy chọn ảnh nhỏ hơn.', 413);
            }
            if (/invalid (api_key|signature|cloud)|unknown api key|must supply|cloud_name|401|403/i.test(raw)) {
                throw fail(`Cloudinary "${account.cloudName}" từ chối kết nối (sai cloud name / API key / secret). Báo admin kiểm tra lại.`, 502);
            }
            throw fail('Không kiểm duyệt được ảnh lúc này. Vui lòng thử lại sau.', 502);
        }

        const verdict = verdictOf(uploaded);

        if (verdict === 'rejected') {
            console.warn(`[imageModeration] ẢNH NHẠY CẢM bị chặn bởi "${account.cloudName}" (${describeLabels(uploaded) || 'không rõ nhãn'})`);
            throw fail('Ảnh bị từ chối vì có nội dung nhạy cảm. Vui lòng chọn ảnh khác.', 422, 'SENSITIVE_IMAGE');
        }
        if (verdict !== 'approved') {
            // missing = add-on chưa bật; pending = đang chờ duyệt → không chắc chắn thì chặn
            console.error(
                `[imageModeration] "${account.cloudName}": kết quả kiểm duyệt "${verdict}" — kiểm tra đã bật add-on moderation ` +
                `("${MODERATION}") trong Cloudinary Console chưa.`
            );
            throw fail(`Cloudinary "${account.cloudName}" chưa kiểm duyệt được ảnh (có thể chưa bật add-on moderation). Thử tài khoản khác hoặc báo admin.`, 503);
        }

        return onApproved ? await onApproved() : undefined;
    } finally {
        // Dù duyệt xong, bị chặn hay lỗi giữa chừng → luôn xoá ảnh khỏi Cloudinary
        await destroyQuietly(lib, account, (uploaded && uploaded.public_id) || (uploaded ? publicId : null));
    }
}

/**
 * Kiểm duyệt 1 ảnh qua các tài khoản Cloudinary ĐÃ CHỌN.
 * Ảnh phải được TẤT CẢ tài khoản duyệt (lần lượt từng tài khoản); chỉ khi qua hết mới chạy onApproved.
 * Mọi bản sao trên Cloudinary đều bị xoá ở cuối (kể cả khi lỗi).
 *
 * @param {Buffer} buffer
 * @param {() => Promise<any>} onApproved
 * @param {{cloudName:string, apiKey:string, apiSecret:string}[]} accounts  từ cloudinaryAccountService.resolveAccounts
 * @returns {Promise<any>} kết quả của onApproved
 * @throws Error có .status: 422 (nhạy cảm, code SENSITIVE_IMAGE) | 413 (quá lớn) | 502/503 (lỗi dịch vụ)
 */
async function moderate(buffer, onApproved, accounts) {
    if (!Array.isArray(accounts) || !accounts.length) {
        throw fail('Chưa chọn tài khoản Cloudinary để kiểm duyệt ảnh.', 400);
    }
    const run = (i) => (i >= accounts.length
        ? (onApproved ? onApproved() : undefined)
        : moderateOne(buffer, () => run(i + 1), accounts[i]));
    return run(0);
}

// ---------------- token chứng nhận ảnh đã qua kiểm duyệt ----------------

function tokenSecret() {
    return process.env.SESSION_SECRET || process.env.CLOUDINARY_API_SECRET || 'change-this-session-secret';
}

function hmac(payload) {
    return crypto.createHmac('sha256', tokenSecret()).update(payload).digest('base64url');
}

/** token = base64url("userId|uploadId|ext|exp") + "." + HMAC */
function signUploadToken({ userId, uploadId, ext }) {
    const body = Buffer.from([String(userId), uploadId, ext, Date.now() + TOKEN_TTL_MS].join('|')).toString('base64url');
    return `${body}.${hmac(body)}`;
}

/** @returns {null | {uploadId:string, ext:string}} null nếu sai/hết hạn/không phải của user này */
function verifyUploadToken(token, userId) {
    if (typeof token !== 'string' || token.length > 400) return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;

    const expected = hmac(body);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const [uid, uploadId, ext, exp] = Buffer.from(body, 'base64url').toString('utf8').split('|');
    if (String(uid) !== String(userId)) return null;
    if (!(Number(exp) > Date.now())) return null;
    if (!/^[a-f0-9]{24}$/.test(uploadId || '') || !/^(png|jpg|webp)$/.test(ext || '')) return null;
    return { uploadId, ext };
}

module.exports = {
    MAX_UPLOAD_BYTES,
    MIME_EXT,
    sniffMime,
    sniffImage,
    moderate,
    signUploadToken,
    verifyUploadToken
};
