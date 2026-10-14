const mongoose = require('mongoose');

// ============================================================
// CloudinaryAccount — 1 tài khoản Cloudinary dùng để KIỂM DUYỆT ảnh
//   CLOUDINARY_CLOUD_NAME  → cloudName   (lưu thường: dùng để hiện danh sách chọn, không phải bí mật)
//   CLOUDINARY_API_KEY     → apiKey      (AES-256-GCM)
//   CLOUDINARY_API_SECRET  → apiSecret   (AES-256-GCM)
// Không có cờ bật/tắt: đã thêm là dùng được, muốn bỏ thì xoá.
// ============================================================
const encryptedField = {
    iv: { type: String, required: true },
    content: { type: String, required: true },
    authTag: { type: String, required: true }
};

const cloudinaryAccountSchema = new mongoose.Schema(
    {
        cloudName: {
            type: String,
            required: true,
            unique: true,
            trim: true
        },

        // select:false → mặc định không bao giờ lọt ra view / JSON
        apiKey: { type: new mongoose.Schema(encryptedField, { _id: false }), required: true, select: false },
        apiSecret: { type: new mongoose.Schema(encryptedField, { _id: false }), required: true, select: false },

        // 4 ký tự cuối API Key để nhận diện
        apiKeyLastFour: { type: String, default: null },

        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
    },
    { timestamps: true }
);

module.exports = mongoose.model('CloudinaryAccount', cloudinaryAccountSchema);
