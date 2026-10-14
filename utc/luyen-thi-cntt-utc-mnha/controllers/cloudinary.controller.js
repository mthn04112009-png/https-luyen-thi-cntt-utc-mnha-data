// ============================================================
// QUẢN LÝ CLOUDINARY — /admin/ai-keys/cloudinary
// ------------------------------------------------------------
//  3 biến cho mỗi tài khoản:
//    CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET
//  Lưu MongoDB; API key + secret mã hoá AES-256-GCM. KHÔNG có nút bật/tắt (chỉ thêm / cập nhật / xoá).
//  Chỉ admin default (route đã requireDefaultAdmin + kiểm tra lại ở đây).
// ============================================================

const cloudinaryAccounts = require('../services/cloudinaryAccountService');
const { isDefaultAdmin } = require('../middleware/auth');

function denyIfNotDefaultAdmin(req, res) {
    if (isDefaultAdmin(req.user)) return false;
    res.status(403).render('error', {
        title: 'Không có quyền truy cập',
        message: 'Chỉ quản trị viên hệ thống (admin default) mới được quản lý Cloudinary.',
        statusCode: 403,
        stack: null,
        user: req.user
    });
    return true;
}

const BASE = '/admin/ai-keys/cloudinary';
const back = (type, msg) => `${BASE}?${type}=${encodeURIComponent(msg)}`;

// GET /admin/ai-keys/cloudinary
const getCloudinary = async (req, res) => {
    if (denyIfNotDefaultAdmin(req, res)) return;
    try {
        const accounts = await cloudinaryAccounts.listForAdmin();
        return res.render('admin/cloudinary', {
            title: 'Cloudinary',
            user: req.user,
            accounts,
            BASE_PATH: BASE,
            success: req.query.success || null,
            error: req.query.error || null
        });
    } catch (error) {
        console.error('Get Cloudinary accounts error:', error);
        return res.status(500).render('admin/cloudinary', {
            title: 'Cloudinary',
            user: req.user,
            accounts: [],
            BASE_PATH: BASE,
            success: null,
            error: 'Không thể tải danh sách Cloudinary.'
        });
    }
};

// POST /admin/ai-keys/cloudinary
const saveCloudinary = async (req, res) => {
    if (denyIfNotDefaultAdmin(req, res)) return;
    try {
        const { cloudName, apiKey, apiSecret } = req.body || {};
        const r = await cloudinaryAccounts.upsertAccount({
            cloudName,
            apiKey,
            apiSecret,
            userId: req.user && req.user._id
        });
        return res.redirect(back('success', r.created
            ? `Đã thêm Cloudinary "${r.cloudName}".`
            : `Đã cập nhật key của Cloudinary "${r.cloudName}".`));
    } catch (error) {
        if (!error.status) console.error('Save Cloudinary error:', error);
        return res.redirect(back('error', error.status ? error.message : 'Không thể lưu: ' + error.message));
    }
};

// POST /admin/ai-keys/cloudinary/:id/delete
const deleteCloudinary = async (req, res) => {
    if (denyIfNotDefaultAdmin(req, res)) return;
    try {
        const doc = await cloudinaryAccounts.deleteAccount(req.params.id);
        if (!doc) return res.redirect(back('error', 'Không tìm thấy tài khoản Cloudinary.'));
        return res.redirect(back('success', `Đã xoá Cloudinary "${doc.cloudName}".`));
    } catch (error) {
        console.error('Delete Cloudinary error:', error);
        return res.redirect(back('error', 'Không thể xoá.'));
    }
};

module.exports = { getCloudinary, saveCloudinary, deleteCloudinary };
