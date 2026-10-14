// ============================================================
// ★ FIX VERCEL: trước đây gửi BODY THÔ (Content-Type: image/*) → trên Vercel (serverless) body thô
//   không đáng tin (runtime tự đọc/giới hạn body, request hay bị 413/400 mà client không thấy lý do).
//   Giờ client gửi JSON { mime, data(base64), names } — cùng đường với mọi POST JSON khác của app
//   (đã chạy ổn trên Vercel). Body thô (image/*) vẫn được nhận như đường dự phòng.
//   Vercel giới hạn request ≤ 4.5MB → client tự nén ảnh về ≤ uploadMaxBytes (xem getConfig).
// UP ẢNH CÂU HỎI TRẮC NGHIỆM (admin) — POST /admin/quiz/upload-image
// ------------------------------------------------------------
//  Body = bytes ảnh thô. Header X-Cloudinary-Names = các CLOUDINARY_CLOUD_NAME đã chọn (cách nhau dấu phẩy).
//    1. kiểm tra magic bytes (png / jpg / webp / gif / bmp / avif)
//    2. Cloudinary kiểm duyệt bằng TẤT CẢ tài khoản đã chọn — ảnh nhạy cảm → 422, dừng, không lưu đâu cả
//    3. ảnh được duyệt → commit lên GitHub: cache/image/<timestamp>.<đuôi ảnh>
//    4. trả link raw (https://raw.githubusercontent.com/<owner>/<repo>/<branch>/cache/image/<timestamp>.<ext>)
//       để editor tự điền vào ô "link ảnh"
//  (Ảnh trên Cloudinary luôn bị xoá — xem imageModerationService.)
// ============================================================

const express = require('express');

const githubService = require('../services/githubService');
const moderation = require('../services/imageModerationService');
const cloudinaryAccounts = require('../services/cloudinaryAccountService');

const IMAGE_DIR = 'cache/image';
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/avif'];

// Vercel cắt request > 4.5MB; base64 phình ×4/3 → ảnh gốc tối đa ~3MB. Local không bị giới hạn này.
const ON_VERCEL = !!process.env.VERCEL;
const CLIENT_MAX_BYTES = ON_VERCEL
    ? Math.min(3 * 1024 * 1024, moderation.MAX_UPLOAD_BYTES)
    : moderation.MAX_UPLOAD_BYTES;

const rawImageBody = express.raw({ type: ALLOWED_TYPES, limit: moderation.MAX_UPLOAD_BYTES });

function rawBodyErrorHandler(err, req, res, next) {
    if (!err) return next();
    const tooLarge = err.type === 'entity.too.large' || err.status === 413;
    const mb = Math.round(moderation.MAX_UPLOAD_BYTES / 1024 / 1024);
    return res.status(tooLarge ? 413 : 400).json({
        success: false,
        message: tooLarge ? `Ảnh quá nặng (tối đa ${mb}MB).` : 'Không đọc được ảnh gửi lên.'
    });
}

// Add-on kiểm duyệt có hạn mức free nhỏ → 30 ảnh / 10 phút / admin
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 30;
const _hits = new Map();
function rateLimited(userId) {
    const now = Date.now();
    const arr = (_hits.get(userId) || []).filter(t => now - t < RATE_WINDOW_MS);
    if (arr.length >= RATE_MAX) { _hits.set(userId, arr); return true; }
    arr.push(now);
    _hits.set(userId, arr);
    return false;
}

function rawUrl(path) {
    return `https://raw.githubusercontent.com/${githubService.owner}/${githubService.repo}/${githubService.branch}/${path}`;
}

/** cache/image/<timestamp>.<ext>; nếu trùng mili-giây (hiếm) thì thêm -1, -2… */
async function freePath(ext) {
    const ts = Date.now();
    let path = `${IMAGE_DIR}/${ts}.${ext}`;
    for (let i = 1; i <= 5 && (await githubService.fileExists(path)); i++) {
        path = `${IMAGE_DIR}/${ts}-${i}.${ext}`;
    }
    return path;
}

/** Lấy buffer ảnh + tên Cloudinary từ request: JSON base64 (chuẩn) hoặc body thô (dự phòng). */
function readUpload(req) {
    const b = req.body;
    if (Buffer.isBuffer(b)) {
        return { buffer: b, names: req.get('x-cloudinary-names') };
    }
    if (b && typeof b === 'object' && typeof b.data === 'string') {
        const b64 = b.data.replace(/^data:[^;]+;base64,/, '');
        return {
            buffer: Buffer.from(b64, 'base64'),
            names: b.names || req.get('x-cloudinary-names')
        };
    }
    return { buffer: null, names: req.get('x-cloudinary-names') };
}

/** Kiểm tra link raw đã mở được chưa (không chặn kết quả; chỉ để cảnh báo). */
async function checkRawReachable(url) {
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 3500);
        const r = await fetch(url, { method: 'HEAD', signal: ctrl.signal });
        clearTimeout(t);
        return r.ok ? { ok: true } : { ok: false, status: r.status };
    } catch (e) {
        return { ok: null, error: e.name === 'AbortError' ? 'timeout' : String(e.message || e) };
    }
}

// GET /admin/quiz/upload-image/config
const getConfig = async (req, res) => {
    const accounts = await cloudinaryAccounts.listCloudNames();
    res.json({
        success: true,
        enabled: accounts.length > 0 && !!githubService.isConfigured,
        githubReady: !!githubService.isConfigured,
        accounts,
        maxSelected: cloudinaryAccounts.MAX_SELECTED,
        maxBytes: moderation.MAX_UPLOAD_BYTES,
        uploadMaxBytes: CLIENT_MAX_BYTES,   // client nén ảnh về ≤ mức này trước khi gửi
        types: ALLOWED_TYPES
    });
};

// POST /admin/quiz/upload-image
const uploadQuizImage = async (req, res) => {
    try {
        const user = req.session && req.session.user;
        if (!user) return res.status(401).json({ success: false, message: 'Chưa đăng nhập.' });
        const userId = String(user.id || user._id);

        if (!githubService.isConfigured) {
            return res.status(503).json({ success: false, message: 'GitHub chưa cấu hình nên chưa lưu được ảnh.' });
        }
        const available = await cloudinaryAccounts.listCloudNames();
        if (!available.length) {
            return res.status(503).json({ success: false, message: 'Chưa có tài khoản Cloudinary — vào Quản trị → API Key → Cloudinary để thêm.' });
        }
        const up = readUpload(req);
        const accounts = await cloudinaryAccounts.resolveAccounts(up.names);

        const buffer = up.buffer;
        console.log(`[quizImage] nhận ảnh: ${buffer ? buffer.length : 0} bytes, content-type=${req.get('content-type')}, vercel=${ON_VERCEL}`);
        if (!Buffer.isBuffer(buffer) || !buffer.length) {
            return res.status(400).json({ success: false, message: 'Không nhận được ảnh (PNG / JPEG / WEBP / GIF / BMP / AVIF).' });
        }
        if (buffer.length > moderation.MAX_UPLOAD_BYTES) {
            return res.status(413).json({ success: false, message: 'Ảnh quá nặng.' });
        }
        const kind = moderation.sniffImage(buffer);
        if (!kind) {
            return res.status(400).json({ success: false, message: 'File không phải ảnh hợp lệ (PNG / JPEG / WEBP / GIF / BMP / AVIF).' });
        }
        if (rateLimited(userId)) {
            return res.status(429).json({ success: false, message: 'Bạn tải ảnh quá nhiều lần. Vui lòng thử lại sau ít phút.' });
        }

        let path = null;
        await moderation.moderate(buffer, async () => {
            // Đã qua kiểm duyệt (ảnh còn trên Cloudinary) → commit lên GitHub
            path = await freePath(kind.ext);
            await githubService.writeBinaryFile(path, buffer, `[Quiz image] ${path}`);
        }, accounts);

        const url = rawUrl(path);
        const reach = await checkRawReachable(url);
        console.log(`[quizImage] đã lưu ${path} (${buffer.length} bytes) → raw: ${JSON.stringify(reach)}`);
        let warning;
        if (reach.ok === false && (reach.status === 404 || reach.status === 403)) {
            warning = `Link raw trả HTTP ${reach.status}: kiểm tra repo GitHub có đang ở chế độ PUBLIC và đúng GITHUB_OWNER/REPO/BRANCH trên Vercel không (repo private thì trình duyệt không hiện được ảnh).`;
        }

        return res.json({
            success: true,
            warning,
            url,
            path,
            mime: kind.mime,
            bytes: buffer.length,
            moderatedBy: accounts.map(a => a.cloudName)
        });
    } catch (e) {
        const status = e.status || 500;
        if (status >= 500) console.error('uploadQuizImage error:', e);
        return res.status(status).json({
            success: false,
            code: e.code || undefined,
            message: status >= 500 && !e.status ? 'Không xử lý được ảnh. Vui lòng thử lại.' : e.message
        });
    }
};

module.exports = { rawImageBody, rawBodyErrorHandler, getConfig, uploadQuizImage };
