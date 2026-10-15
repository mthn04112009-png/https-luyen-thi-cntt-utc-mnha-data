const crypto = require('crypto');

const AIKey = require('../models/AIKey');
const {
    getProvider,
    getProviderLabel,
    getProvidersForClient,
    isKnownProvider,
    isValidProvider
} = require('../config/aiModels');
const providerService = require('../services/aiProviderService');
const { isDefaultAdmin } = require('../middleware/auth');

// ============================================================
// HELPERS
// ============================================================
function getUserId(req) {
    // req.user do attachUser đọc lại từ DB → không tin session (có thể cũ)
    return req.user?._id || null;
}

// ★ CHẶN HOÀN TOÀN admin user_key (lớp bảo vệ thứ 2, ngoài requireDefaultAdmin ở route).
//   Trả true nếu đã chặn (handler phải return ngay).
function denyIfNotDefaultAdmin(req, res) {
    if (isDefaultAdmin(req.user)) return false;
    res.status(403).render('error', {
        title: 'Không có quyền truy cập',
        message: 'Chỉ quản trị viên hệ thống (admin default) mới được quản lý API Key.',
        statusCode: 403,
        stack: null,
        user: req.user
    });
    return true;
}

// ★ Dữ liệu nhà cung cấp/model truyền cho view aikeys.pug (đọc từ AI-database/index.json qua registry)
function getProviderViewData() {
    const providers = getProvidersForClient();   // chỉ nhà cung cấp đang bật; mỗi mục có models, defaultModel, keyPrefixes…
    return {
        providers,
        // JSON nhúng vào <script type="application/json"> — thoát "<" để không đóng thẻ script sớm
        providersJson: JSON.stringify(providers).replace(/</g, '\\u003c'),
        providerStatus: providerService.getStatus()
    };
}

// ★ Cảnh báo MỀM theo tiền tố key của từng nhà cung cấp (keyPrefixes) — KHÔNG chặn lưu.
//   Chỉ cảnh báo khi nhà cung cấp có khai báo tiền tố mà key không khớp, hoặc key khớp rõ ràng
//   tiền tố của nhà cung cấp KHÁC (nhập nhầm nhà cung cấp).
function getKeyPrefixWarning(provider, apiKey) {
    const p = getProvider(provider);
    const prefixes = p.keyPrefixes || [];
    const matchesOwn = prefixes.some((x) => apiKey.startsWith(x));
    if (prefixes.length && !matchesOwn) {
        const other = providerService.listProviders().find(
            (q) => q.id !== p.id && (q.keyPrefixes || []).some((x) => apiKey.startsWith(x))
        );
        if (other) {
            return `Lưu ý: key này trông giống key ${other.label} nhưng bạn đang chọn ${p.label}.`;
        }
        return `Lưu ý: key ${p.label} thường bắt đầu bằng ${prefixes.map((x) => '"' + x + '"').join(' hoặc ')}. Hãy kiểm tra lại nhà cung cấp/ key.`;
    }
    return null;
}

function getMasterKey() {
    const hex = process.env.ENCRYPTION_MASTER_KEY;
    if (!hex) throw new Error('ENCRYPTION_MASTER_KEY chưa cấu hình.');
    const buf = Buffer.from(hex, 'hex');
    if (buf.length !== 32) throw new Error('ENCRYPTION_MASTER_KEY phải là 32 byte (64 hex).');
    return buf;
}

// ============================================================
// GET /admin/ai-keys
// ============================================================
const getAIKeys = async (req, res) => {
    if (denyIfNotDefaultAdmin(req, res)) return;

    try {
        try { await providerService.ensureFresh({ force: true }); } catch (_) { /* dùng bản đang có */ }
        const aiKeys = await AIKey.find({})
            .populate('createdBy', 'name email')
            .sort({ createdAt: -1 })
            .lean({ virtuals: true });

        // Đảm bảo maskedKey luôn có
        aiKeys.forEach((k) => {
            if (!k.maskedKey) {
                k.maskedKey = k.lastFour
                    ? '••••••••••••' + k.lastFour
                    : '••••••••••••••••';
            }

            // ★ .lean() không áp default → key cũ thiếu provider coi là gemini.
            //   Provider không còn trong danh sách (đã xoá) → hiện nguyên id + cảnh báo, KHÔNG coi là Gemini.
            const raw = typeof k.provider === 'string' ? k.provider.trim().toLowerCase() : '';
            if (raw && !isKnownProvider(raw)) {
                k.provider = raw;
                k.providerLabel = raw + ' (đã xoá khỏi danh sách)';
                k.providerMissing = true;
            } else {
                k.provider = getProvider(raw).id;
                k.providerLabel = getProviderLabel(k.provider);
                k.providerMissing = false;
            }
        });

        return res.render('admin/aikeys', {
            title: 'AI API Keys',
            user: req.user,
            aiKeys,
            ...getProviderViewData(),
            success: req.query.success || null,
            error: req.query.error || null
        });
    } catch (error) {
        console.error('Get AI keys error:', error);
        return res.status(500).render('admin/aikeys', {
            title: 'AI API Keys',
            user: req.user,
            aiKeys: [],
            ...getProviderViewData(),
            error: 'Không thể tải danh sách AI key.'
        });
    }
};

// ============================================================
// POST /admin/ai-keys
// ============================================================
const createAIKey = async (req, res) => {
    if (denyIfNotDefaultAdmin(req, res)) return;

    try {
        const { name, provider, apiKey, model } = req.body;

        // ★ Nhà cung cấp: bỏ trống → 'gemini' (hành vi cũ). Phải là nhà cung cấp đã đăng ký và đang bật
        //   (AI-database/index.json). Thêm nhà cung cấp mới ở /admin/ai-keys/Supplier.
        const rawProvider = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
        const providerValue = rawProvider === 'google' ? 'gemini' : (rawProvider || 'gemini');
        if (!isValidProvider(providerValue)) {
            return res.redirect(
                '/admin/ai-keys?error=' +
                encodeURIComponent(
                    'Nhà cung cấp không hợp lệ hoặc đang tắt. Chọn một nhà cung cấp trong danh sách (hoặc thêm ở trang Nhà cung cấp AI).'
                )
            );
        }
        const providerCfg = getProvider(providerValue);

        if (!name || !name.trim()) {
            return res.redirect('/admin/ai-keys?error=' + encodeURIComponent('Tên không được để trống.'));
        }
        if (!apiKey || !apiKey.trim()) {
            return res.redirect('/admin/ai-keys?error=' + encodeURIComponent('API Key không được để trống.'));
        }

        // ★ "Model" chỉ là nhãn gợi ý (model ưu tiên khi hiển thị/thống kê).
        // KHÔNG khoá key vào model này — key vẫn dùng được cho mọi model trong
        // SUPPORTED_MODELS lúc chấm bài (model thực tế do prompt/lesson quyết định).
        // Nếu người dùng không chọn hoặc chọn giá trị không hợp lệ → để trống (null),
        // không tự ép về DEFAULT_MODEL để tránh hiểu nhầm là bị giới hạn.
        //   ★ Kiểm tra nhãn model theo ĐÚNG danh sách của provider (Gemini ↔ SUPPORTED_MODELS,
        //     vilao.ai ↔ VILAO_MODELS); model của provider khác → null.
        const trimmedModel = typeof model === 'string' ? model.trim() : '';
        const modelIsValid = providerCfg.models.includes(trimmedModel);
        const preferredModel = trimmedModel && modelIsValid ? trimmedModel : null;

        // Mã hoá AES-256-GCM
        let masterKey;
        try {
            masterKey = getMasterKey();
        } catch (err) {
            return res.redirect('/admin/ai-keys?error=' + encodeURIComponent(err.message));
        }

        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
        const encrypted = Buffer.concat([
            cipher.update(apiKey.trim(), 'utf8'),
            cipher.final()
        ]);
        const authTag = cipher.getAuthTag();

        // 4 ký tự cuối
        const lastFour = apiKey.trim().slice(-4);

        await AIKey.create({
            name: name.trim(),
            provider: providerValue,
            model: preferredModel,                // ★ Nhãn ưu tiên (có thể null = mọi model)
            encryptedKey: encrypted.toString('hex'),
            iv: iv.toString('hex'),
            authTag: authTag.toString('hex'),
            lastFour,                            // ★ LƯU 4 KÝ TỰ CUỐI
            isActive: true,
            isRevoked: false,
            createdBy: getUserId(req)
        });

        // ★ Cảnh báo mềm theo tiền tố key (không chặn lưu)
        const warning = getKeyPrefixWarning(providerValue, apiKey.trim());
        const successMsg = warning ? 'Đã thêm API Key. ' + warning : 'Đã thêm API Key.';

        return res.redirect('/admin/ai-keys?success=' + encodeURIComponent(successMsg));
    } catch (error) {
        console.error('Create AI key error:', error);
        return res.redirect('/admin/ai-keys?error=' + encodeURIComponent('Không thể thêm key: ' + error.message));
    }
};

// ============================================================
// POST /admin/ai-keys/:id/toggle
// ============================================================
const toggleAIKey = async (req, res) => {
    if (denyIfNotDefaultAdmin(req, res)) return;

    try {
        const aiKey = await AIKey.findById(req.params.id);
        if (!aiKey) {
            return res.redirect('/admin/ai-keys?error=' + encodeURIComponent('Không tìm thấy AI key.'));
        }

        aiKey.isActive = !aiKey.isActive;
        await aiKey.save();

        return res.redirect('/admin/ai-keys?success=' + encodeURIComponent('Đã cập nhật trạng thái.'));
    } catch (error) {
        console.error('Toggle AI key error:', error);
        return res.redirect('/admin/ai-keys?error=' + encodeURIComponent('Không thể đổi trạng thái.'));
    }
};

// ============================================================
// POST /admin/ai-keys/:id/delete
// ============================================================
const deleteAIKey = async (req, res) => {
    if (denyIfNotDefaultAdmin(req, res)) return;

    try {
        const aiKey = await AIKey.findById(req.params.id);
        if (!aiKey) {
            return res.redirect('/admin/ai-keys?error=' + encodeURIComponent('Không tìm thấy key.'));
        }

        await AIKey.findByIdAndDelete(req.params.id);

        return res.redirect('/admin/ai-keys?success=' + encodeURIComponent('Đã xoá API Key.'));
    } catch (error) {
        console.error('Delete AI key error:', error);
        return res.redirect('/admin/ai-keys?error=' + encodeURIComponent('Không thể xoá.'));
    }
};

// ============================================================
// DECRYPT — dùng nội bộ (giữ lại để tương thích chỗ khác có thể đang import)
// Lưu ý: services/aiService.js có bản decrypt riêng để tránh phụ thuộc vòng
// (aiService không require controller). Nếu tách cryptoService.js sau này,
// nên hợp nhất 2 chỗ này lại làm một.
// ============================================================
const decryptAIKey = (aiKey) => {
    const masterKey = getMasterKey();
    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        masterKey,
        Buffer.from(aiKey.iv, 'hex')
    );
    decipher.setAuthTag(Buffer.from(aiKey.authTag, 'hex'));
    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(aiKey.encryptedKey, 'hex')),
        decipher.final()
    ]);
    return decrypted.toString('utf8');
};

module.exports = {
    getAIKeys,
    createAIKey,
    deleteAIKey,
    toggleAIKey,
    decryptAIKey
};
