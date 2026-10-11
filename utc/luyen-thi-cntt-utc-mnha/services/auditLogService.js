// services/auditLogService.js
// ============================================================
// AUDIT LOG LƯU TRÊN GITHUB (thay cho collection `auditlogs` của MongoDB)
// ------------------------------------------------------------
// Toàn bộ nhật ký nằm trong MỘT file:  auditlogs/index.json
//   {
//     "version": 1,
//     "updatedAt": "<ISO>",
//     "total": <số bản ghi>,
//     "logs": [ { id, actor, actorName?, actorEmail?, action, entity, entityId,
//                 description, metadata, ipAddress, userAgent, createdAt }, ... ]  // cũ → mới
//   }
//
// - create(): ghi nối tiếp qua hàng đợi trong tiến trình + githubService.updateJsonFile
//   (đọc → thêm → ghi bằng đúng SHA; GitHub trả 409 thì tự đọc lại và thử lại).
// - list():   đọc file (cache 15 giây), lọc/tìm kiếm, sắp MỚI → CŨ, phân trang,
//             gắn tên người thực hiện từ collection users.
// - Nhận cả 2 kiểu field cũ của dự án:
//     {actor, entity, entityId, description, metadata, ipAddress, userAgent}
//     {adminId, targetType, targetId, detail}            (user.controller / layoutService)
// - Lỗi GitHub chỉ cảnh báo (create không ném lỗi) để không làm hỏng thao tác chính.
// ============================================================
const crypto = require('crypto');
const githubService = require('./githubService');

const AUDIT_PATH = 'auditlogs/index.json';
const CACHE_TTL_MS = 15 * 1000;
const MAX_TEXT = 2000;

let cache = null;            // { at, doc }
let chain = Promise.resolve();   // hàng đợi ghi

const emptyDoc = () => ({ version: 1, updatedAt: new Date().toISOString(), total: 0, logs: [] });

function newId() {
    // 24 ký tự hex, bắt đầu bằng mốc thời gian (giống ObjectId) → sắp theo id cũng đúng thời gian
    const ts = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
    return ts + crypto.randomBytes(8).toString('hex');
}

const str = (v, max = MAX_TEXT) => (v === null || v === undefined ? '' : String(v)).slice(0, max);
const idOrNull = (v) => (v === null || v === undefined || v === '' ? null : String(v));

// Chuyển object bất kỳ (ObjectId, Date, Mongoose doc...) thành JSON thuần
function plain(v) {
    if (v === null || v === undefined) return {};
    if (typeof v !== 'object') return { value: v };
    try { return JSON.parse(JSON.stringify(v)); } catch (_) { return {}; }
}

function normalize(doc = {}) {
    const meta = doc.metadata !== undefined ? doc.metadata : doc.detail;
    let description = doc.description;
    if ((description === undefined || description === '') && typeof doc.detail === 'string') description = doc.detail;

    return {
        id: doc.id || (doc._id ? String(doc._id) : newId()),
        actor: idOrNull(doc.actor || doc.adminId),
        ...(doc.actorName ? { actorName: str(doc.actorName, 200) } : {}),
        ...(doc.actorEmail ? { actorEmail: str(doc.actorEmail, 200) } : {}),
        action: str(doc.action, 200) || 'unknown',
        entity: str(doc.entity || doc.targetType, 200) || 'System',
        entityId: idOrNull(doc.entityId || doc.targetId),
        description: str(description),
        metadata: typeof meta === 'string' ? { detail: meta } : plain(meta),
        ipAddress: str(doc.ipAddress || doc.ip, 100),
        userAgent: str(doc.userAgent, 400),
        createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : new Date().toISOString(),
    };
}

// ------------------------------------------------------------
// GHI
// ------------------------------------------------------------
async function appendMany(entries, message) {
    if (!githubService.isConfigured) throw new Error('GitHub chưa cấu hình (GITHUB_TOKEN/OWNER/REPO)');
    const apply = (cur) => {
        const doc = cur && Array.isArray(cur.logs) ? cur : emptyDoc();
        const seen = new Set(doc.logs.map((l) => l.id));
        for (const e of entries) if (!seen.has(e.id)) { doc.logs.push(e); seen.add(e.id); }
        doc.version = 1;
        doc.total = doc.logs.length;
        doc.updatedAt = new Date().toISOString();
        return doc;
    };

    try {
        await githubService.updateJsonFile(AUDIT_PATH, apply, message);
    } catch (e) {
        if (!/không tồn tại/i.test(e.message || '')) throw e;
        // File chưa có → tạo mới (nếu ai đó vừa tạo cùng lúc thì SHA_CONFLICT → cập nhật lại)
        try {
            await githubService.writeJsonFileIfSha(AUDIT_PATH, apply(null), null, message);
        } catch (e2) {
            if (e2.code !== 'SHA_CONFLICT') throw e2;
            await githubService.updateJsonFile(AUDIT_PATH, apply, message);
        }
    }
    cache = null;
}

/**
 * Ghi 1 bản ghi. Không bao giờ ném lỗi (chỉ cảnh báo) → trả về entry hoặc null.
 * Gọi giống `AuditLog.create(...)` cũ nên các controller không phải sửa.
 */
function create(doc) {
    let entry;
    try { entry = normalize(doc); } catch (e) {
        console.warn('[auditLog] dữ liệu không hợp lệ:', e.message);
        return Promise.resolve(null);
    }
    const job = chain.then(async () => {
        try {
            await appendMany([entry], `Audit log: ${entry.action}`);
            return entry;
        } catch (e) {
            console.warn(`[auditLog] không ghi được "${entry.action}" lên GitHub:`, e.message);
            return null;
        }
    });
    chain = job.catch(() => {});
    return job;
}

/** Ghi nhiều bản ghi trong 1 commit (dùng cho script chuyển dữ liệu). Ném lỗi nếu thất bại. */
function createMany(docs, message = 'Audit log: nhập dữ liệu') {
    const entries = docs.map(normalize);
    const job = chain.then(() => appendMany(entries, message).then(() => entries));
    chain = job.catch(() => {});
    return job;
}

// ------------------------------------------------------------
// ĐỌC
// ------------------------------------------------------------
async function readAll({ force = false } = {}) {
    if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.doc;
    if (!githubService.isConfigured) return emptyDoc();
    let doc;
    try {
        doc = (await githubService.readJsonFile(AUDIT_PATH)) || emptyDoc();
    } catch (e) {
        e.isGithub = true;   // để trang audit-log biết đây là lỗi GitHub (sập/bảo trì/mạng)
        throw e;
    }
    if (!Array.isArray(doc.logs)) doc.logs = [];
    cache = { at: Date.now(), doc };
    return doc;
}

const fold = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase();

/**
 * @param {{page?:number, limit?:number, q?:string, action?:string, entity?:string}} opts
 * @returns {{logs:Array, total:number, page:number, pages:number, limit:number, actions:string[], entities:string[]}}
 */
async function list(opts = {}) {
    const limit = Math.min(200, Math.max(1, Number(opts.limit) || 50));
    const doc = await readAll({ force: !!opts.force });
    const all = doc.logs;

    const actions = [...new Set(all.map((l) => l.action).filter(Boolean))].sort();
    const entities = [...new Set(all.map((l) => l.entity).filter(Boolean))].sort();

    // người thực hiện: tra tên từ users (chỉ cho các id có trong danh sách sau khi lọc ở bước dưới)
    let names = new Map();
    try {
        const User = require('../models/User');
        const ids = [...new Set(all.map((l) => l.actor).filter((x) => /^[a-f0-9]{24}$/i.test(String(x || ''))))];
        if (ids.length) {
            const users = await User.find({ _id: { $in: ids } }).select('name email').lean();
            names = new Map(users.map((u) => [String(u._id), { name: u.name, email: u.email }]));
        }
    } catch (_) { /* không có User model/Mongo → dùng tên đã lưu sẵn */ }

    const withActor = (l) => {
        const u = names.get(String(l.actor));
        return {
            ...l,
            actorInfo: u
                ? { name: u.name, email: u.email }
                : (l.actorName || l.actorEmail ? { name: l.actorName, email: l.actorEmail } : null),
        };
    };

    const q = fold(opts.q).trim();
    const action = String(opts.action || '').trim();
    const entity = String(opts.entity || '').trim();

    let rows = all;
    if (action) rows = rows.filter((l) => l.action === action);
    if (entity) rows = rows.filter((l) => l.entity === entity);
    rows = rows.map(withActor);
    if (q) {
        rows = rows.filter((l) => fold([
            l.action, l.entity, l.entityId, l.description, l.ipAddress,
            l.actorInfo && l.actorInfo.name, l.actorInfo && l.actorInfo.email,
            JSON.stringify(l.metadata || {}),
        ].join(' ')).includes(q));
    }

    rows = rows.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : (a.id < b.id ? 1 : -1)));

    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(pages, Math.max(1, Number(opts.page) || 1));
    return { logs: rows.slice((page - 1) * limit, page * limit), total, page, pages, limit, actions, entities, grandTotal: all.length };
}

module.exports = { AUDIT_PATH, create, createMany, list, readAll, normalize };
