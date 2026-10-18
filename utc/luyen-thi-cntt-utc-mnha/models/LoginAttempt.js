// models/LoginAttempt.js
// ============================================================
// Bộ đếm đăng nhập sai theo (email + IP + thiết bị).
// Lưu ở MongoDB (không dùng RAM) để chạy đúng cả trên Vercel serverless
// lẫn localhost. Mongo tự xoá bản ghi hết hạn bằng TTL index (expiresAt).
// ============================================================
const mongoose = require('mongoose');

const loginAttemptSchema = new mongoose.Schema(
    {
        key: { type: String, required: true, unique: true, index: true }, // sha256(email|ip|deviceId)
        email: { type: String, default: '' },
        ip: { type: String, default: '' },
        userAgent: { type: String, default: '' },
        device: { type: String, default: '' },
        count: { type: Number, default: 0 },
        firstAttemptAt: { type: Date, default: null },
        lastAttemptAt: { type: Date, default: null },
        lockedAt: { type: Date, default: null },     // lúc sai lần 5/5
        lockedUntil: { type: Date, default: null },  // lockedAt + 60 giây
        expiresAt: { type: Date, required: true }    // TTL
    },
    { timestamps: false }
);

loginAttemptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.LoginAttempt || mongoose.model('LoginAttempt', loginAttemptSchema);
