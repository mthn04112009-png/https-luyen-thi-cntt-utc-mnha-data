// controllers/layout.controller.js
const mongoose = require('mongoose');
const User = require('../models/User');
const layoutService = require('../services/layoutService');
const moderation = require('../services/imageModerationService');
const cloudinaryAccounts = require('../services/cloudinaryAccountService');
const { redirectWithFlash, takeFlash } = require('../utils/flash');

const { LayoutError, audit } = layoutService;

// ------------------------------------------------------------
// ADMIN USER_KEY (requireLayoutEditor) — layout của CHÍNH tổ chức mình
// ------------------------------------------------------------

async function showForm(req, res, next) {
    try {
        const UserKey = require('../models/UserKey');
        const uk = await UserKey.findById(req.actor.userKey).select('name layout').lean();
        const layout = (uk && uk.layout) || {};

        res.render('admin/brand', {
            title: 'Giao diện tổ chức',
            orgName: uk ? uk.name : '',
            form: {
                brandSub: layout.brandSub || '',
                footerText: layout.footerText || ''
            },
            hasCustomLogo: Boolean(layout.logoFile),
            cloudNames: await cloudinaryAccounts.listCloudNames(),   // ★ ô chọn Cloudinary kiểm duyệt logo
            flash: takeFlash(req),
            limits: {
                brandSub: layoutService.MAX_BRAND_SUB,
                footerText: layoutService.MAX_FOOTER
            }
        });
    } catch (err) {
        next(err);
    }
}

async function update(req, res, next) {
    try {
        // ★ Logo mới PHẢI qua kiểm duyệt Cloudinary (bằng CLOUDINARY_CLOUD_NAME đã chọn) trước khi lưu.
        //   Ảnh trên Cloudinary bị xoá ngay sau khi duyệt (xem imageModerationService).
        if (req.file && req.file.size > 0) {
            if (!moderation.sniffMime(req.file.buffer)) {
                return redirectWithFlash(req, res, '/admin/layout', 'error', 'Logo chỉ nhận PNG, JPEG hoặc WebP.');
            }
            try {
                const accounts = await cloudinaryAccounts.resolveAccounts(req.body.cloudName);
                await moderation.moderate(req.file.buffer, null, accounts);
            } catch (modErr) {
                if (!modErr.status) console.error('[layout.moderate]', modErr);
                return redirectWithFlash(
                    req, res, '/admin/layout', 'error',
                    modErr.status ? modErr.message : 'Không kiểm duyệt được logo lúc này. Vui lòng thử lại.'
                );
            }
        }

        // userKey luôn lấy từ admin đang đăng nhập, không nhận từ body
        const result = await layoutService.saveLayout(req.actor.userKey, {
            file: req.file,
            brandSub: req.body.brandSub,
            footerText: req.body.footerText
        });
        await audit(req, 'update_layout', { meta: { logoChanged: result.logoChanged } });
        redirectWithFlash(req, res, '/admin/layout', 'success', 'Đã lưu giao diện.');
    } catch (err) {
        if (err instanceof LayoutError) {
            return redirectWithFlash(req, res, '/admin/layout', 'error', err.message);
        }
        // Lỗi GitHub / hạ tầng: logo cũ được giữ nguyên vì MongoDB chưa bị cập nhật
        console.error('[layout.update]', err);
        return redirectWithFlash(
            req, res, '/admin/layout', 'error',
            'Không lưu được giao diện (lỗi lưu trữ GitHub). Logo cũ được giữ nguyên, vui lòng thử lại.'
        );
    }
}

async function reset(req, res, next) {
    try {
        await layoutService.resetLayout(req.actor.userKey);
        await audit(req, 'reset_layout');
        redirectWithFlash(req, res, '/admin/layout', 'success', 'Đã đưa giao diện về mặc định.');
    } catch (err) {
        if (err instanceof LayoutError) {
            return redirectWithFlash(req, res, '/admin/layout', 'error', err.message);
        }
        next(err);
    }
}

// ------------------------------------------------------------
// GET /layout/logo/:userKeyId  (đăng nhập; lỗi/không có → logo mặc định)
// ------------------------------------------------------------

async function serveLogo(req, res) {
    try {
        if (!req.user) return res.redirect('/images/logo.png');

        const logo = await layoutService.getLogo(req.params.userKeyId);
        if (!logo) return res.redirect('/images/logo.png');

        res.set({
            'Content-Type': logo.mime,
            'Content-Length': String(logo.buffer.length),
            'X-Content-Type-Options': 'nosniff',
            // URL có ?v=<logoVersion> nên cache lâu được; 'private' vì cần đăng nhập
            'Cache-Control': 'private, max-age=86400'
        });
        return res.send(logo.buffer);
    } catch (err) {
        console.warn('[layout.logo]', err.message);
        return res.redirect('/images/logo.png');
    }
}

// ------------------------------------------------------------
// POST /admin/users/:id/layout-permission  (requireDefaultAdmin)
// Gắn vào routes của trang admin/users — xem admin-users-snippet.md
// ------------------------------------------------------------

async function setLayoutPermission(req, res, next) {
    // Trang admin/users gọi bằng fetch (router còn ép x-requested-with) → trả JSON {success, message}
    const wantsJson = req.xhr || req.accepts(['html', 'json']) === 'json';
    const fail = (status, message) =>
        wantsJson
            ? res.status(status).json({ success: false, message })
            : redirectWithFlash(req, res, '/admin/users', 'error', message);

    try {
        if (!mongoose.isValidObjectId(req.params.id)) return fail(400, 'ID không hợp lệ.');

        const value = String(req.body.canEditLayout);   // chấp nhận cả boolean JSON lẫn chuỗi
        if (!['true', 'false', 'on'].includes(value)) {
            return fail(400, 'Giá trị canEditLayout không hợp lệ.');
        }
        const grant = value === 'true' || value === 'on';

        const target = await User.findById(req.params.id).select('role userKey name email').lean();
        // Chỉ admin THUỘC user_key mới có ý nghĩa (admin default không có quyền này)
        if (!target || target.role !== 'admin' || !target.userKey) {
            return fail(400, 'Chỉ cấp quyền cho tài khoản admin thuộc một user_key.');
        }

        await User.updateOne({ _id: target._id }, { $set: { canEditLayout: grant } });

        await audit(req, grant ? 'grant_layout_edit' : 'revoke_layout_edit', {
            targetUser: target._id,
            userKey: target.userKey            // tổ chức của tài khoản đích
        });

        if (wantsJson) return res.json({ success: true, canEditLayout: grant });
        return redirectWithFlash(
            req, res, '/admin/users', 'success',
            `${grant ? 'Đã cấp' : 'Đã thu hồi'} quyền sửa layout của ${target.name || target.email}.`
        );
    } catch (err) {
        next(err);
    }
}

module.exports = { showForm, update, reset, serveLogo, setLayoutPermission };
