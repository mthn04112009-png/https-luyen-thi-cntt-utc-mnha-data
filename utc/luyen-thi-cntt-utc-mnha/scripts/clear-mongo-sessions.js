// scripts/clear-mongo-sessions.js
// ============================================================
// XOÁ HẾT dữ liệu collection "sessions" (connect-mongo cũ) trong MongoDB.
// Từ khi server dùng services/githubSessionStore.js, session chỉ đọc/ghi ở GitHub: cookies/index.json.
//
//   Xem trước (mặc định, KHÔNG thay đổi gì):  node scripts/clear-mongo-sessions.js
//   Xoá thật:                                  node scripts/clear-mongo-sessions.js --yes      (hoặc --run)
//   Xoá thật + xoá luôn collection:            node scripts/clear-mongo-sessions.js --yes --drop
//   Bỏ qua bước kiểm tra GitHub (nguy hiểm):   node scripts/clear-mongo-sessions.js --yes --force
//
// AN TOÀN: trước khi xoá, script đối chiếu MỌI session còn hạn trong MongoDB với cookies/index.json
// trên GitHub (tìm theo sid mã hoá + giải mã thử). Thiếu session nào ⇒ TỪ CHỐI xoá (người đó sẽ bị
// đăng xuất) và nhắc chạy: node migrateMongoToGithub.js --only=sessions --run
// Session đã hết hạn luôn được xoá, không cần kiểm tra.
//
// Cần .env có MONGO_URI (hoặc MONGODB_URI) + GITHUB_TOKEN/GITHUB_OWNER/GITHUB_REPO + ENCRYPTION_MASTER_KEY.
// ============================================================
require('dotenv').config();
const mongoose = require('mongoose');
const githubService = require('../services/githubService');
const cookieCrypto = require('../services/cookieCryptoService');
const GithubSessionStore = require('../services/githubSessionStore');

const argv = process.argv.slice(2);
const RUN = argv.includes('--yes') || argv.includes('--run');
const FORCE = argv.includes('--force');
const DROP = argv.includes('--drop');

(async () => {
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!uri) {
        console.error('❌ Thiếu MONGO_URI / MONGODB_URI trong .env');
        process.exit(1);
    }

    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
    console.log('✅ Đã kết nối MongoDB:', mongoose.connection.host);
    console.log(RUN ? '🚀 CHẠY THẬT' : '🔎 XEM TRƯỚC (thêm --yes để xoá thật)');

    const col = mongoose.connection.db.collection('sessions');
    const exists = (await mongoose.connection.db.listCollections({ name: 'sessions' }, { nameOnly: true }).toArray()).length > 0;
    if (!exists) {
        console.log('✅ Collection "sessions" không tồn tại — không có gì để xoá.');
        await mongoose.disconnect();
        return;
    }

    const total = await col.countDocuments({});
    const live = await col.find(
        { $or: [{ expires: { $gt: new Date() } }, { expires: { $exists: false } }, { expires: null }] },
        { projection: { _id: 1 } }
    ).toArray();
    console.log(`• Trong MongoDB: ${total} session (còn hạn: ${live.length}, đã hết hạn: ${total - live.length})`);

    // ---- Đối chiếu với GitHub ----
    let missing = [];
    if (FORCE) {
        console.log('⚠️  --force: bỏ qua bước kiểm tra GitHub.');
    } else if (live.length) {
        if (!githubService.isConfigured) {
            console.error('❌ GitHub chưa cấu hình (GITHUB_TOKEN/GITHUB_OWNER/GITHUB_REPO) nên không kiểm tra được → không xoá. (Dùng --force nếu chắc chắn.)');
            process.exit(1);
        }
        const file = await githubService.readJsonFile(GithubSessionStore.COOKIES_PATH);
        const onGh = GithubSessionStore.extractSessions(file);
        console.log(`• Trên GitHub (${GithubSessionStore.COOKIES_PATH}): ${Object.keys(onGh).length} session`);

        for (const d of live) {
            const sid = typeof d._id === 'string' ? d._id : null;
            let ok = false;
            if (sid) {
                try {
                    const key = cookieCrypto.encryptSid(sid);
                    ok = Boolean(GithubSessionStore.readEntry(key, onGh[key]));   // có + còn hạn + giải mã được
                } catch (_) { ok = false; }
            }
            if (!ok) missing.push(String(d._id));
        }
        if (missing.length) {
            console.error(`❌ ${missing.length}/${live.length} session còn hạn CHƯA có (hoặc không giải mã được) trên GitHub:`);
            missing.slice(0, 10).forEach((id) => console.error(`     - ${id.slice(0, 6)}…`));
            console.error('   → chạy: node migrateMongoToGithub.js --only=sessions --run   rồi chạy lại script này.');
            console.error('   (Muốn xoá bỏ qua kiểm tra: thêm --force — những người đó sẽ phải đăng nhập lại.)');
            await mongoose.disconnect();
            process.exit(1);
        }
        console.log(`✅ ${live.length}/${live.length} session còn hạn đều đã có trên GitHub và giải mã được.`);
    }

    if (!RUN) {
        console.log(`\n[xem trước] Sẽ ${DROP ? 'XOÁ CẢ collection' : `xoá ${total} document trong`} "sessions". Thêm --yes để thực hiện.`);
        await mongoose.disconnect();
        return;
    }

    if (DROP) {
        await col.drop();
        console.log('🗑️  Đã xoá collection "sessions".');
    } else {
        const r = await col.deleteMany({});
        console.log(`🗑️  Đã xoá ${r.deletedCount} document trong collection "sessions".`);
    }
    console.log('ℹ️  Từ giờ server chỉ đọc session ở GitHub (cookies/index.json).');
    await mongoose.disconnect();
})().catch((e) => {
    console.error('❌', e);
    process.exit(1);
});
