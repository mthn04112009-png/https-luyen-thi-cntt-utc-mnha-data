const mongoose = require('mongoose');

const aiKeySchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true
        },

        // ★ Nhà cung cấp AI = `id` trong AI-database/index.json (GitHub):
        //   'gemini' (mặc định) | 'vilao' | 'openai' | 'deepseek' | … (thêm trên web: /admin/ai-keys/Supplier).
        //   'google' là giá trị cũ của Gemini (alias). Doc cũ thiếu provider ⇒ coi là 'gemini'.
        //   KHÔNG dùng enum cứng nữa — danh sách nhà cung cấp là dữ liệu động, được kiểm tra ở
        //   aikey.controller (isValidProvider) trước khi lưu. Query .lean() không áp default →
        //   nơi đọc phải đi qua normalizeProvider() (config/aiModels.js).
        provider: {
            type: String,
            trim: true,
            lowercase: true,
            maxlength: 32,
            default: 'gemini'
        },

        // Model dùng cho key
        //   provider openai-kind có modelPerKey (vilao.ai) → ★ MODEL THỰC TẾ ĐƯỢC GỌI
        //                     (aiService.resolveModelForKey). Phải là model mà key ĐÃ subscribe trên
        //                     dashboard nhà cung cấp, nếu để trống sẽ dùng model mặc định của nhà cung cấp
        //                     và có thể dính 403 "Please subscribe to model".
        //   provider gemini → chỉ là nhãn gợi ý, aiService KHÔNG dùng (giữ nguyên
        //                     hành vi cũ: getSafeModel(model yêu cầu))
        model: {
            type: String,
            default: null
        },

        // AES-256-GCM encrypted API key
        encryptedKey: {
            type: String,
            required: true,
            select: false
        },

        iv: {
            type: String,
            required: true,
            select: false
        },

        authTag: {
            type: String,
            required: true,
            select: false
        },

        // 4 ký tự cuối để hiển thị
        lastFour: {
            type: String,
            default: null
        },

        // ★ Admin bật/tắt THỦ CÔNG
        isActive: {
            type: Boolean,
            default: true,
            index: true
        },

        // ★ Revoke VĨNH VIỄN
        isRevoked: {
            type: Boolean,
            default: false,
            index: true
        },

        // ★ TỰ ĐỘNG disable TẠM THỜI khi hết quota
        //   Key tự bật lại khi disabledUntil < now
        disabledUntil: {
            type: Date,
            default: null,
            index: true
        },

        usageCount: {
            type: Number,
            default: 0,
            min: 0
        },

        lastUsedAt: {
            type: Date,
            default: null
        },

        quotaErrorCount: {
            type: Number,
            default: 0,
            min: 0
        },

        revokedAt: {
            type: Date,
            default: null
        },

        revokedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null
        },

        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null
        }
    },
    {
        timestamps: true
    }
);

// Index cho query tìm key active
aiKeySchema.index({ isActive: 1, isRevoked: 1, disabledUntil: 1 });

// Virtual: providerLabel (tên nhà cung cấp lấy từ AI-database/index.json: "Gemini" / "vilao.ai" / …)
aiKeySchema.virtual('providerLabel').get(function () {
    // require trễ: tránh vòng phụ thuộc khi nạp model
    const { getProviderLabel } = require('../config/aiModels');
    return getProviderLabel(this.provider);
});

// Virtual: maskedKey
aiKeySchema.virtual('maskedKey').get(function () {
    if (!this.lastFour) return '••••••••••••••••';
    return '••••••••••••' + this.lastFour;
});

aiKeySchema.set('toObject', { virtuals: true });
aiKeySchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('AIKey', aiKeySchema);