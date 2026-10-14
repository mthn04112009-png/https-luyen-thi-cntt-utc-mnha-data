// ============================================================
// UPLOAD ẢNH VIẾT TAY — POST /submissions/drawing-upload
// ------------------------------------------------------------
//  Body = bytes ảnh thô (Content-Type image/png|jpeg|webp), tối đa CLOUDINARY_MAX_BYTES (mặc định 10MB)
//    1. kiểm tra magic bytes
//    2. Cloudinary kiểm duyệt (bằng các CLOUDINARY_CLOUD_NAME người dùng đã chọn — header X-Cloudinary-Names,
//       cách nhau dấu phẩy; ảnh phải qua TẤT CẢ): ảnh nhạy cảm → 422 và dừng
//    3. ảnh được duyệt → ghi TẠM lên GitHub (drawing-uploads/<userId>/<id>.<ext>)
//    4. xoá ảnh khỏi Cloudinary (luôn luôn, kể cả khi lỗi)
//    5. trả token HMAC; lúc nộp bài server kiểm token rồi xoá file tạm trên GitHub
// ============================================================

const crypto = require('crypto');
const express = require('express');

const githubService = require('../services/githubService');
const moderation = require('../services/imageModerationService');
const cloudinaryAccounts = require('../services/cloudinaryAccountService');

const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

// Body ảnh thô — chỉ áp dụng cho đúng route upload (không đụng body parser toàn cục)
const rawImageBody = express.raw({ type: ALLOWED_TYPES, limit: moderation.MAX_UPLOAD_BYTES });

// Lỗi của body parser (quá lớn…) → trả JSON thay vì trang lỗi HTML
function rawBodyErrorHandler(err, req, res, next) {
    if (!err) return next();
    const tooLarge = err.type === 'entity.too.large' || err.status === 413;
    const mb = Math.round(moderation.MAX_UPLOAD_BYTES / 1024 / 1024);
    return res.status(tooLarge ? 413 : 400).json({
        success: false,
        message: tooLarge ? `Ảnh quá nặng (tối đa ${mb}MB).` : 'Không đọc được ảnh gửi lên.'
    });
}

// Giới hạn tần suất: add-on kiểm duyệt có hạn mức free nhỏ → 12 ảnh / 10 phút / người
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 12;
const _hits = new Map(); // userId → [timestamps]
function rateLimited(userId) {
    const now = Date.now();
    const arr = (_hits.get(userId) || []).filter(t => now - t < RATE_WINDOW_MS);
    if (arr.length >= RATE_MAX) {
        _hits.set(userId, arr);
        return true;
    }
    arr.push(now);
    _hits.set(userId, arr);
    return false;
}

function safeSegment(v) {
    return String(v).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

function stagingPath(userId, uploadId, ext) {
    return `drawing-uploads/${safeSegment(userId)}/${uploadId}.${ext}`;
}

// GET /submissions/drawing-upload/config
const getConfig = async (req, res) => {
    const accounts = await cloudinaryAccounts.listCloudNames();
    res.json({
        success: true,
        enabled: accounts.length > 0,
        accounts,                       // danh sách CLOUDINARY_CLOUD_NAME cho ô chọn
        maxSelected: cloudinaryAccounts.MAX_SELECTED,
        maxBytes: moderation.MAX_UPLOAD_BYTES,
        types: ALLOWED_TYPES
    });
};

// POST /submissions/drawing-upload
const uploadDrawingPhoto = async (req, res) => {
    try {
        const user = req.session && req.session.user;
        if (!user) return res.status(401).json({ success: false, message: 'Chưa đăng nhập.' });
        const userId = String(user.id || user._id);

        // Tài khoản Cloudinary người dùng đã chọn (header) — kiểm tra trong DB, giải mã trong RAM
        const available = await cloudinaryAccounts.listCloudNames();
        if (!available.length) {
            return res.status(503).json({ success: false, message: 'Tính năng tải ảnh chưa được bật (admin chưa thêm tài khoản Cloudinary).' });
        }
        const accounts = await cloudinaryAccounts.resolveAccounts(req.get('x-cloudinary-names'));

        const buffer = req.body;
        if (!Buffer.isBuffer(buffer) || !buffer.length) {
            return res.status(400).json({ success: false, message: 'Không nhận được ảnh (chỉ nhận PNG / JPEG / WEBP).' });
        }
        if (buffer.length > moderation.MAX_UPLOAD_BYTES) {
            return res.status(413).json({ success: false, message: 'Ảnh quá nặng.' });
        }

        const mime = moderation.sniffMime(buffer);
        if (!mime) {
            return res.status(400).json({ success: false, message: 'File không phải ảnh PNG / JPEG / WEBP hợp lệ.' });
        }

        if (rateLimited(userId)) {
            return res.status(429).json({ success: false, message: 'Bạn tải ảnh quá nhiều lần. Vui lòng thử lại sau ít phút.' });
        }

        const ext = moderation.MIME_EXT[mime];
        const uploadId = crypto.randomBytes(12).toString('hex'); // 24 ký tự hex

        await moderation.moderate(buffer, async () => {
            // Ảnh đã được duyệt (vẫn còn trên Cloudinary) → ghi tạm lên GitHub
            if (!githubService.isConfigured) {
                console.warn('[drawingUpload] GitHub chưa cấu hình — bỏ qua bước lưu tạm.');
                return;
            }
            await githubService.writeBinaryFile(
                stagingPath(userId, uploadId, ext),
                buffer,
                `[Drawing upload] ảnh tạm ${uploadId}`
            );
        }, accounts);

        return res.json({
            success: true,
            token: moderation.signUploadToken({ userId, uploadId, ext }),
            mime,
            bytes: buffer.length
        });
    } catch (e) {
        const status = e.status || 500;
        if (status >= 500) console.error('uploadDrawingPhoto error:', e);
        return res.status(status).json({
            success: false,
            code: e.code || undefined,
            message: status >= 500 && !e.status ? 'Không xử lý được ảnh. Vui lòng thử lại.' : e.message
        });
    }
};

/**
 * Xoá file ảnh tạm trên GitHub sau khi bài đã nộp. Không bao giờ ném lỗi.
 * @param {string|number} userId
 * @param {{uploadId:string, ext:string}} verified  kết quả verifyUploadToken
 */
async function deleteStagedUpload(userId, verified) {
    try {
        if (!verified || !githubService.isConfigured) return;
        await githubService.deleteFile(
            stagingPath(userId, verified.uploadId, verified.ext),
            `[Drawing upload] xoá ảnh tạm ${verified.uploadId}`
        );
    } catch (e) {
        console.warn(`[drawingUpload] Không xoá được ảnh tạm trên GitHub: ${e.message || e}`);
    }
}

module.exports = {
    rawImageBody,
    rawBodyErrorHandler,
    getConfig,
    uploadDrawingPhoto,
    deleteStagedUpload
};
