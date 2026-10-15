// ============================================================
// controllers/aiProvider.controller.js
// TRANG "NHÀ CUNG CẤP AI":  /admin/ai-keys/Supplier
// ------------------------------------------------------------
// Xem các AI hiện có (Gemini, vilao.ai, …) và THÊM loại AI mới (ChatGPT, DeepSeek…) ngay trên web.
// Mỗi nhà cung cấp có sẵn các "biến API": địa chỉ API, đường dẫn chat, header xác thực, max_tokens,
// danh sách model, model mặc định… Sau khi tạo nhà cung cấp, vào /admin/ai-keys → "Thêm API Key"
// chọn nhà cung cấp đó để gắn key (key mã hoá AES-256-GCM, lưu MongoDB).
// Dữ liệu nhà cung cấp lưu ở GitHub: AI-database/index.json (services/aiProviderService.js).
// Chỉ admin default (requireDefaultAdmin ở route + denyIfNotDefaultAdmin ở đây).
// ============================================================
const AIKey = require('../models/AIKey');
const providerService = require('../services/aiProviderService');
const { PROVIDER_TEMPLATES } = require('../config/aiProviderSeed');
const { isDefaultAdmin } = require('../middleware/auth');

const BASE = '/admin/ai-keys/Supplier';

function denyIfNotDefaultAdmin(req, res) {
    if (isDefaultAdmin(req.user)) return false;
    res.status(403).render('error', {
        title: 'Không có quyền truy cập',
        message: 'Chỉ quản trị viên hệ thống (admin default) mới được quản lý nhà cung cấp AI.',
        statusCode: 403,
        stack: null,
        user: req.user
    });
    return true;
}

const actorOf = (req) => (req.user && (req.user.email || req.user.name)) || '';
const last = (v) => (Array.isArray(v) ? v[v.length - 1] : v);   // checkbox có hidden "0" đi kèm → lấy giá trị cuối
const str = (v) => (v == null ? undefined : String(last(v)));

// Đếm số key trong MongoDB theo nhà cung cấp (key cũ thiếu provider / 'google' tính cho Gemini)
async function countKeysByProvider() {
    const rows = await AIKey.aggregate([{ $group: { _id: '$provider', n: { $sum: 1 } } }]);
    const counts = {};
    for (const r of rows) {
        const id = providerService.isKnownProvider(r._id) ? providerService.resolveProviderId(r._id) : (r._id || 'gemini');
        counts[id] = (counts[id] || 0) + r.n;
    }
    return counts;
}

function inputFromBody(body, mode) {
    const b = body || {};
    const input = {
        id: str(b.id),
        label: str(b.label),
        description: str(b.description),
        baseUrl: str(b.baseUrl),
        chatPath: str(b.chatPath),
        authHeader: str(b.authHeader),
        authScheme: str(b.authScheme),
        maxTokens: str(b.maxTokens),
        systemPrompt: str(b.systemPrompt),
        models: str(b.models),
        defaultModel: str(b.defaultModel),
        fallbackModels: str(b.fallbackModels),
        modelPerKey: str(b.modelPerKey),
        allowCustomModel: str(b.allowCustomModel),
        keyPrefixes: str(b.keyPrefixes),
        keyPlaceholder: str(b.keyPlaceholder),
        subscribeRegex: str(b.subscribeRegex),
        missingModelRegex: str(b.missingModelRegex),
        enabled: str(b.enabled)
    };
    if (mode === 'edit') input.id = String(input.id || '').toLowerCase();
    // bỏ field undefined để giữ giá trị cũ khi sửa
    Object.keys(input).forEach((k) => input[k] === undefined && delete input[k]);
    return input;
}

async function renderPage(req, res, extra = {}) {
    try { await providerService.ensureFresh({ force: true }); } catch (_) { /* dùng bản đang có */ }
    const providers = providerService.listProviders({ includeDisabled: true });
    let keyCounts = {};
    try { keyCounts = await countKeysByProvider(); } catch (e) { console.warn('[Supplier] không đếm được key:', e.message); }

    const safeJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
    const templatesJson = safeJson(PROVIDER_TEMPLATES);
    const providersJson = safeJson(providers);
    const formDataJson = safeJson(extra.formData || null);
    return res.status(extra.statusCode || 200).render('admin/ai-providers', {
        title: 'Nhà cung cấp AI',
        user: req.user,
        providers,
        keyCounts,
        templates: PROVIDER_TEMPLATES,
        templatesJson,
        providersJson,
        formDataJson,
        status: providerService.getStatus(),
        formMode: extra.formMode || null,        // 'create' | 'edit' | null (đóng form)
        formData: extra.formData || null,
        success: req.query.success || extra.success || null,
        error: req.query.error || extra.error || null,
        openEdit: req.query.edit || null,
        openNew: req.query.new === '1'
    });
}

// GET /admin/ai-keys/Supplier
const getSuppliers = async (req, res) => {
    if (denyIfNotDefaultAdmin(req, res)) return;
    try {
        return await renderPage(req, res);
    } catch (error) {
        console.error('Get suppliers error:', error);
        return res.status(500).render('error', {
            title: 'Lỗi', message: 'Không tải được danh sách nhà cung cấp AI: ' + error.message,
            statusCode: 500, stack: null, user: req.user
        });
    }
};

// POST /admin/ai-keys/Supplier   (mode=create | edit)
const saveSupplier = async (req, res) => {
    if (denyIfNotDefaultAdmin(req, res)) return;
    const mode = last(req.body && req.body.mode) === 'edit' ? 'edit' : 'create';
    const input = inputFromBody(req.body, mode);
    try {
        const { provider } = await providerService.upsertProvider(input, { isNew: mode === 'create', actor: actorOf(req) });
        return res.redirect(BASE + '?success=' + encodeURIComponent(
            (mode === 'create' ? 'Đã thêm nhà cung cấp "' : 'Đã lưu nhà cung cấp "') + provider.label +
            '". ' + (mode === 'create' ? 'Giờ vào AI Key → Thêm API Key để gắn key cho nhà cung cấp này.' : '')
        ));
    } catch (error) {
        const errors = error.errors && error.errors.length ? error.errors : [error.message || 'Không lưu được.'];
        console.warn('Save supplier error:', errors.join(' | '));
        return renderPage(req, res, {
            statusCode: 400,
            error: errors.join(' • '),
            formMode: mode,
            formData: input
        });
    }
};

// POST /admin/ai-keys/Supplier/:id/toggle
const toggleSupplier = async (req, res) => {
    if (denyIfNotDefaultAdmin(req, res)) return;
    try {
        const p = providerService.getProvider(req.params.id);
        if (!providerService.isKnownProvider(req.params.id)) {
            return res.redirect(BASE + '?error=' + encodeURIComponent('Không tìm thấy nhà cung cấp.'));
        }
        await providerService.setEnabled(p.id, p.enabled === false, { actor: actorOf(req) });
        return res.redirect(BASE + '?success=' + encodeURIComponent(p.enabled === false ? 'Đã bật nhà cung cấp.' : 'Đã tắt nhà cung cấp (các key của nó tạm không được dùng).'));
    } catch (error) {
        const msg = error.errors && error.errors[0] ? error.errors[0] : error.message;
        return res.redirect(BASE + '?error=' + encodeURIComponent(msg || 'Không đổi được trạng thái.'));
    }
};

// POST /admin/ai-keys/Supplier/:id/delete
const deleteSupplier = async (req, res) => {
    if (denyIfNotDefaultAdmin(req, res)) return;
    try {
        if (!providerService.isKnownProvider(req.params.id)) {
            return res.redirect(BASE + '?error=' + encodeURIComponent('Không tìm thấy nhà cung cấp.'));
        }
        const p = providerService.getProvider(req.params.id);
        if (p.builtin) {
            return res.redirect(BASE + '?error=' + encodeURIComponent('Không thể xoá Gemini (nhà cung cấp mặc định).'));
        }
        // Còn key đang gắn vào nhà cung cấp này → chặn (tránh key "mồ côi")
        const used = await AIKey.countDocuments({ provider: { $in: [p.id, ...(p.aliases || [])] } });
        if (used > 0) {
            return res.redirect(BASE + '?error=' + encodeURIComponent(
                `Còn ${used} API Key thuộc "${p.label}". Hãy xoá các key đó ở trang AI Key trước (hoặc chỉ cần Tắt nhà cung cấp).`
            ));
        }
        await providerService.deleteProvider(p.id);
        return res.redirect(BASE + '?success=' + encodeURIComponent('Đã xoá nhà cung cấp "' + p.label + '".'));
    } catch (error) {
        const msg = error.errors && error.errors[0] ? error.errors[0] : error.message;
        return res.redirect(BASE + '?error=' + encodeURIComponent(msg || 'Không xoá được.'));
    }
};

// POST /admin/ai-keys/Supplier/init — tạo AI-database/index.json từ danh sách hiện có (nếu chưa có file trên GitHub)
// (cách thay thế cho: node migrateMongoToGithub.js --only=aiproviders --run)
const initSupplierDb = async (req, res) => {
    if (denyIfNotDefaultAdmin(req, res)) return;
    try {
        await providerService.ensureFresh({ force: true });
        if (providerService.getStatus().source === 'github') {
            return res.redirect(BASE + '?success=' + encodeURIComponent('File ' + providerService.AI_DB_PATH + ' đã có trên GitHub.'));
        }
        const doc = providerService.getDocument();
        const first = doc.providers.find((p) => p.id === 'gemini');
        // upsert Gemini (không đổi nội dung) chỉ để tạo file bằng đúng đường ghi có khoá SHA
        await providerService.upsertProvider(first, { isNew: false, actor: actorOf(req) });
        return res.redirect(BASE + '?success=' + encodeURIComponent('Đã tạo ' + providerService.AI_DB_PATH + ' trên GitHub.'));
    } catch (error) {
        const msg = error.errors && error.errors[0] ? error.errors[0] : error.message;
        return res.redirect(BASE + '?error=' + encodeURIComponent('Không tạo được file: ' + msg));
    }
};

module.exports = { getSuppliers, saveSupplier, toggleSupplier, deleteSupplier, initSupplierDb };
