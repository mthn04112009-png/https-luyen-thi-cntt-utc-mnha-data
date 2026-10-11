const mongoose = require('mongoose');

// ★ OTP tồn tại tối đa 10 phút trong MongoDB, sau đó Mongo TỰ XOÁ (TTL index).
//   Đổi số phút ở đây là đủ — controller + TTL index đều lấy từ hằng số này.
const OTP_TTL_MINUTES = 10;
const OTP_TTL_MS = OTP_TTL_MINUTES * 60 * 1000;

const otpSchema = new mongoose.Schema(
    {
        email: {
            type: String,
            required: true,
            lowercase: true,
            trim: true,
            index: true
        },

        code: {
            type: String,
            required: true
        },

        type: {
            type: String,
            enum: ['register', 'reset'],
            required: true,
            index: true
        },

        attempts: {
            type: Number,
            default: 0
        },

        expiresAt: {
            type: Date,
            required: true,
            default: () => new Date(Date.now() + OTP_TTL_MS)
        },

        // Lưu tạm dữ liệu đăng ký (KHÔNG lưu password plaintext)
        // { name, email, passwordHash }
        payload: {
            type: mongoose.Schema.Types.Mixed,
            default: null
        }
    },
    {
        timestamps: true
    }
);

// TTL: Mongo tự xoá document khi expiresAt < now (expiresAt = lúc tạo + 10 phút)
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const OTP = mongoose.model('OTP', otpSchema);

/**
 * Đảm bảo TTL index tồn tại trong MongoDB.
 * Cần thiết vì config bật autoIndex=false ở production (Vercel) nên Mongoose
 * KHÔNG tự tạo index → OTP sẽ không bao giờ tự xoá. Hàm này idempotent:
 * index đã đúng thì Mongo bỏ qua, index cũ sai thời gian thì xoá và tạo lại.
 */
OTP.ensureTTLIndex = async function ensureTTLIndex() {
    const col = OTP.collection;
    try {
        await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    } catch (err) {
        // 85/86: index cùng key nhưng khác option (vd. expireAfterSeconds cũ)
        if (err && (err.code === 85 || err.code === 86)) {
            await col.dropIndex('expiresAt_1');
            await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
        } else {
            throw err;
        }
    }
};

module.exports = OTP;
module.exports.OTP_TTL_MS = OTP_TTL_MS;
module.exports.OTP_TTL_MINUTES = OTP_TTL_MINUTES;
