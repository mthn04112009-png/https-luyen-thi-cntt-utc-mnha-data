// scripts/clean-otps.js
// 1) Xoá toàn bộ dữ liệu collection "otps" trong MongoDB
// 2) Đảm bảo TTL index (expiresAt) để Mongo TỰ XOÁ OTP sau 10 phút
//
//   Xem trước (mặc định, KHÔNG thay đổi gì):  node scripts/clean-otps.js
//   Chạy thật:                                 node scripts/clean-otps.js --yes
//   Chỉ tạo/sửa TTL index, giữ dữ liệu:        node scripts/clean-otps.js --yes --index-only
//
// Cần .env có MONGO_URI (hoặc MONGODB_URI).
require('dotenv').config();
const mongoose = require('mongoose');
const OTP = require('../models/OTP');

(async () => {
  const really = process.argv.includes('--yes');
  const indexOnly = process.argv.includes('--index-only');
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;

  if (!uri) {
    console.error('❌ Thiếu MONGO_URI / MONGODB_URI trong .env');
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  console.log('✅ Đã kết nối MongoDB:', mongoose.connection.host);
  console.log(really ? 'CHẠY THẬT' : 'XEM TRƯỚC (thêm --yes để thực hiện)');

  // ---- 1) Xoá dữ liệu ----
  const total = await OTP.collection.countDocuments();
  if (indexOnly) {
    console.log('• Bỏ qua bước xoá dữ liệu (--index-only)');
  } else if (!really) {
    console.log(`• Sẽ xoá ${total} bản ghi trong "otps"`);
  } else {
    const r = await OTP.collection.deleteMany({});
    console.log(`• Đã xoá ${r.deletedCount} bản ghi trong "otps"`);
  }

  // ---- 2) TTL index ----
  let indexes = [];
  try { indexes = await OTP.collection.indexes(); } catch (_) { /* chưa có collection */ }
  const ttl = indexes.find((i) => i.key && i.key.expiresAt === 1);
  const ok = ttl && ttl.expireAfterSeconds === 0;

  if (ok) {
    console.log('• TTL index trên expiresAt đã đúng');
  } else if (!really) {
    console.log('• Sẽ tạo TTL index trên expiresAt (OTP hết hạn sau 10 phút thì tự xoá)');
  } else {
    await OTP.ensureTTLIndex();
    console.log('• Đã tạo TTL index trên expiresAt: OTP tự xoá sau 10 phút');
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
