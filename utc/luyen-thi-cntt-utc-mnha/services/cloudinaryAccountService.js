// ============================================================
// CLOUDINARY ACCOUNT SERVICE
// ------------------------------------------------------------
//  - Tài khoản Cloudinary lưu ở MongoDB (apiKey / apiSecret mã hoá AES-256-GCM).
//  - Tương thích ngược: nếu .env vẫn có đủ CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET
//    thì tài khoản đó cũng xuất hiện trong danh sách (trừ khi đã có cùng cloudName trong DB).
//  - listCloudNames()  → danh sách tên cho ô chọn (KHÔNG chứa key/secret)
//  - resolveAccounts() → kiểm tra tên được chọn rồi trả credentials đã giải mã (chỉ dùng trong RAM)
// ============================================================

const CloudinaryAccount = require('../models/CloudinaryAccount');
const { encrypt, decrypt, maskKey } = require('./cryptoService');

const MAX_SELECTED = 5; // tối đa số tài khoản dùng kiểm duyệt cho 1 ảnh (mỗi tài khoản = 1 lần upload)

function envAccount() {
    const cloudName = (process.env.CLOUDINARY_CLOUD_NAME || '').trim();
    const apiKey = (process.env.CLOUDINARY_API_KEY || '').trim();
    const apiSecret = (process.env.CLOUDINARY_API_SECRET || '').trim();
    if (!cloudName || !apiKey || !apiSecret) return null;
    return { cloudName, apiKey, apiSecret };
}

function fail(message, status) {
    const e = new Error(message);
    e.status = status;
    return e;
}

/** @returns {Promise<string[]>} tên cloud (đã sắp xếp) cho ô chọn */
async function listCloudNames() {
    let names = [];
    try {
        const docs = await CloudinaryAccount.find({}).select('cloudName').sort({ cloudName: 1 }).lean();
        names = docs.map(d => d.cloudName);
    } catch (e) {
        console.error('[cloudinaryAccount] Không đọc được danh sách từ MongoDB:', e.message);
    }
    const env = envAccount();
    if (env && !names.includes(env.cloudName)) names.push(env.cloudName);
    return names;
}

/** Danh sách cho trang quản trị (kèm 4 ký tự cuối key). Không trả secret. */
async function listForAdmin() {
    const docs = await CloudinaryAccount.find({})
        .populate('createdBy', 'name email')
        .sort({ createdAt: -1 })
        .lean();
    const rows = docs.map(d => ({
        _id: d._id,
        cloudName: d.cloudName,
        maskedKey: d.apiKeyLastFour ? '••••••••' + d.apiKeyLastFour : '••••••••••••',
        createdBy: d.createdBy,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        source: 'db'
    }));
    const env = envAccount();
    if (env && !rows.some(r => r.cloudName === env.cloudName)) {
        rows.push({
            _id: null,
            cloudName: env.cloudName,
            maskedKey: '••••••••' + maskKey(env.apiKey).replace('...', ''),
            createdBy: null,
            createdAt: null,
            updatedAt: null,
            source: 'env'
        });
    }
    return rows;
}

/** Thêm mới hoặc cập nhật (cùng cloudName) — mã hoá apiKey + apiSecret. */
async function upsertAccount({ cloudName, apiKey, apiSecret, userId }) {
    const name = String(cloudName || '').trim();
    const key = String(apiKey || '').trim();
    const secret = String(apiSecret || '').trim();

    if (!name) throw fail('CLOUDINARY_CLOUD_NAME không được để trống.', 400);
    if (!/^[A-Za-z0-9_-]{2,64}$/.test(name)) {
        throw fail('CLOUDINARY_CLOUD_NAME chỉ gồm chữ, số, dấu - và _ (2–64 ký tự).', 400);
    }
    if (!key) throw fail('CLOUDINARY_API_KEY không được để trống.', 400);
    if (!secret) throw fail('CLOUDINARY_API_SECRET không được để trống.', 400);

    const payload = {
        apiKey: encrypt(key),
        apiSecret: encrypt(secret),
        apiKeyLastFour: key.slice(-4)
    };

    const existing = await CloudinaryAccount.findOne({ cloudName: name }).select('_id');
    if (existing) {
        await CloudinaryAccount.updateOne({ _id: existing._id }, { $set: payload });
        return { created: false, cloudName: name };
    }
    await CloudinaryAccount.create({ cloudName: name, ...payload, createdBy: userId || null });
    return { created: true, cloudName: name };
}

async function deleteAccount(id) {
    return CloudinaryAccount.findByIdAndDelete(id);
}

/**
 * Chuẩn hoá danh sách tên được chọn (mảng hoặc chuỗi "a,b") → mảng không trùng.
 */
function parseNames(input) {
    const arr = Array.isArray(input) ? input : String(input || '').split(',');
    const out = [];
    for (const raw of arr) {
        const n = String(raw || '').trim();
        if (n && !out.includes(n)) out.push(n);
    }
    return out;
}

/**
 * Kiểm tên đã chọn có trong hệ thống không rồi trả credentials giải mã.
 * @throws Error (400) nếu chưa chọn / chọn tên không tồn tại / chọn quá nhiều
 * @returns {Promise<{cloudName:string, apiKey:string, apiSecret:string}[]>}
 */
async function resolveAccounts(selected) {
    const names = parseNames(selected);
    if (!names.length) throw fail('Hãy chọn ít nhất một CLOUDINARY_CLOUD_NAME để kiểm duyệt ảnh.', 400);
    if (names.length > MAX_SELECTED) throw fail(`Chỉ được chọn tối đa ${MAX_SELECTED} tài khoản Cloudinary.`, 400);

    const docs = await CloudinaryAccount.find({ cloudName: { $in: names } }).select('+apiKey +apiSecret');
    const byName = new Map(docs.map(d => [d.cloudName, d]));
    const env = envAccount();

    const out = [];
    for (const name of names) {
        const doc = byName.get(name);
        if (doc) {
            try {
                out.push({
                    cloudName: doc.cloudName,
                    apiKey: decrypt(doc.apiKey),
                    apiSecret: decrypt(doc.apiSecret)
                });
            } catch (e) {
                console.error(`[cloudinaryAccount] Giải mã "${name}" lỗi:`, e.message);
                throw fail(`Không đọc được cấu hình Cloudinary "${name}". Hãy nhập lại key trong trang quản trị.`, 503);
            }
        } else if (env && env.cloudName === name) {
            out.push(env);
        } else {
            throw fail(`Tài khoản Cloudinary "${name}" không tồn tại.`, 400);
        }
    }
    return out;
}

module.exports = {
    MAX_SELECTED,
    listCloudNames,
    listForAdmin,
    upsertAccount,
    deleteAccount,
    parseNames,
    resolveAccounts
};
