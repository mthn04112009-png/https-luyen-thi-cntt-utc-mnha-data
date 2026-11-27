// ============================================================
// UP ẢNH THẲNG (trình duyệt → Cloudinary → GitHub) — controller dùng chung cho 2 nơi
//   quiz    POST /admin/quiz/upload-image/direct-{init,verify,done}   (admin, ảnh câu hỏi / flashcard)
//   drawing POST /submissions/drawing-upload/direct-{init,verify,done} (người làm bài, ảnh viết tay)
// Logic nằm ở services/directImageService.js. Lỗi 502/503 (Cloudinary/GitHub) → client tự quay về luồng cũ qua máy chủ;
// lỗi 422 SENSITIVE_IMAGE / IMAGE_MISMATCH thì DỪNG, không quay về.
// ============================================================
'use strict';
const direct = require('../services/directImageService');
const moderation = require('../services/imageModerationService');
const githubService = require('../services/githubService');

function userIdOf(req) {
    const u = req.user || (req.session && req.session.user);
    return u ? String(u.id || u._id) : null;
}

function sendError(res, tag, e) {
    const status = e.status || 500;
    if (status >= 500 && !e.status) console.error(`[${tag}]`, e);
    res.set('Cache-Control', 'no-store');
    return res.status(status).json({
        success: false,
        code: e.code || undefined,
        message: status >= 500 && !e.status ? 'Không xử lý được ảnh. Vui lòng thử lại.' : e.message
    });
}

/** Kiểm tra link raw đã mở được chưa (không chặn kết quả; chỉ để cảnh báo repo private / sai nhánh). */
async function reachWarning(url) {
    try {
        const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3500) });
        if (!r.ok && (r.status === 404 || r.status === 403)) {
            return `Link raw trả HTTP ${r.status}: kiểm tra repo GitHub có đang ở chế độ PUBLIC và đúng GITHUB_OWNER/REPO/BRANCH trên Vercel không (repo private thì trình duyệt không hiện được ảnh).`;
        }
    } catch (_) { /* mạng chậm: bỏ qua */ }
    return undefined;
}

function make(kind) {
    const tag = `${kind}Direct`;
    return {
        init: async (req, res) => {
            try {
                const userId = userIdOf(req);
                if (!userId) return sendError(res, tag, Object.assign(new Error('Chưa đăng nhập.'), { status: 401 }));
                const b = req.body || {};
                const out = await direct.init({ kind, userId, names: b.names, mime: b.mime, size: b.size });
                res.set('Cache-Control', 'no-store');
                return res.json({ success: true, mode: 'direct', ...out });
            } catch (e) { return sendError(res, tag, e); }
        },

        verify: async (req, res) => {
            try {
                const userId = userIdOf(req);
                if (!userId) return sendError(res, tag, Object.assign(new Error('Chưa đăng nhập.'), { status: 401 }));
                const b = req.body || {};
                const out = await direct.verify({ kind, userId, ticket: b.ticket, reported: b.reported });
                res.set('Cache-Control', 'no-store');
                return res.json({ success: true, ...out });
            } catch (e) { return sendError(res, tag, e); }
        },

        done: async (req, res) => {
            try {
                const userId = userIdOf(req);
                if (!userId) return sendError(res, tag, Object.assign(new Error('Chưa đăng nhập.'), { status: 401 }));
                const b = req.body || {};
                const r = await direct.done({ kind, userId, ticket: b.ticket });
                res.set('Cache-Control', 'no-store');
                if (kind === 'drawing') {
                    // Giống luồng cũ: token HMAC gắn user + uploadId + đuôi; submission.controller kiểm rồi xoá file tạm sau khi nộp
                    return res.json({
                        success: true,
                        token: moderation.signUploadToken({ userId, uploadId: r.uploadId, ext: r.ext }),
                        mime: r.mime,
                        bytes: r.bytes
                    });
                }
                return res.json({
                    success: true,
                    warning: await reachWarning(r.url),
                    url: r.url,
                    path: r.path,
                    mime: r.mime,
                    bytes: r.bytes,
                    moderatedBy: Array.isArray(b.moderatedBy) ? b.moderatedBy.slice(0, 5).map(String) : undefined
                });
            } catch (e) { return sendError(res, tag, e); }
        },

        /** GET …/direct-config: có up thẳng được không (để trình duyệt chọn luồng ngay từ đầu). */
        config: async (req, res) => {
            res.set('Cache-Control', 'no-store');
            return res.json({ success: true, direct: await direct.isAvailable() && !!githubService.isConfigured });
        }
    };
}

module.exports = { quiz: make('quiz'), drawing: make('drawing') };
