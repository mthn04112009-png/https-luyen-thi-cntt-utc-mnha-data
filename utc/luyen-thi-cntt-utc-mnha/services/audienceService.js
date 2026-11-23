// ============================================================
// services/audienceService.js — "AI ĐƯỢC XEM" dùng chung (Tài liệu /documents, Đề /admin/lessons, Đề trắc nghiệm /admin/quiz)
// ------------------------------------------------------------
// Giống chế độ hiển thị của Video (/videos/dashboard/new):
//   visibility = 'public'  → mọi sinh viên đã được duyệt (mặc định như cũ)
//                'private' → chỉ admin
//                'users'   → chỉ những người được chọn (allowedUserIds = id user, lưu trong JSON trên GitHub)
//   Admin luôn thấy hết. isPublished = (visibility !== 'private') — giữ tương thích với code cũ.
// Bản ghi cũ KHÔNG có visibility → suy từ isPublished (false → private, còn lại → public).
// ============================================================
const mongoose = require('mongoose');

const User = require('../models/User');
const { getActor, buildUserListFilter } = require('./userKeyService');
const { buildSearchClause } = require('../utils/search');

const VISIBILITIES = ['public', 'private', 'users'];
const MAX_ALLOWED_USERS = 300;

const isObjectId = (v) => mongoose.Types.ObjectId.isValid(String(v || '')) && String(v).length === 24;
const isAdminUser = (u) => !!(u && u.role === 'admin');
const uidOf = (u) => String((u && (u._id || u.id)) || '');

/** id người dùng gửi lên (mảng hoặc chuỗi "a,b,c") → mảng hex24 chữ thường, bỏ trùng. */
function cleanIds(raw) {
    const arr = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(/[,\s]+/) : []);
    return [...new Set(arr.map((x) => String(x || '').trim().toLowerCase()).filter(isObjectId))];
}

/** Suy chế độ hiển thị của 1 bản ghi đã lưu (bản cũ chỉ có isPublished). */
function visibilityOf(rec) {
    if (rec && VISIBILITIES.includes(rec.visibility)) return rec.visibility;
    return rec && rec.isPublished === false ? 'private' : 'public';
}

/**
 * Đọc phần "ai được xem" của form.
 *   body.visibility hợp lệ → dùng; nếu không có mà có body.isPublished (client cũ) → public/private;
 *   không có gì cả → { provided:false } (chỗ gọi tự giữ nguyên giá trị cũ / mặc định public).
 * Trả { provided, visibility, isPublished, allowedUserIds } | { error }
 */
function readAudience(body) {
    const b = body || {};
    let visibility = null;
    if (VISIBILITIES.includes(b.visibility)) visibility = b.visibility;
    else if (b.isPublished !== undefined) {
        const off = b.isPublished === false || b.isPublished === 'false' || b.isPublished === 0 || b.isPublished === '0' || b.isPublished === 'off';
        visibility = off ? 'private' : 'public';
    }
    if (!visibility) return { provided: false, visibility: 'public', isPublished: true, allowedUserIds: [] };
    const allowedUserIds = visibility === 'users' ? cleanIds(b.allowedUserIds) : [];
    if (visibility === 'users' && !allowedUserIds.length) {
        return { error: 'Hãy chọn ít nhất 1 người được xem (hoặc đổi sang chế độ khác).' };
    }
    return { provided: true, visibility, isPublished: visibility !== 'private', allowedUserIds };
}

/**
 * Kiểm tra danh sách id người được xem: tồn tại, là sinh viên, nằm trong phạm vi người dùng mà admin này quản lý.
 * Trả { ids } | { error }
 */
async function resolveAllowedUsers(req, rawIds, max) {
    const limit = max || MAX_ALLOWED_USERS;
    const ids = cleanIds(rawIds);
    if (!ids.length) return { ids: [] };
    if (ids.length > limit) return { error: `Tối đa ${limit} người cho mỗi mục.` };
    const actor = await getActor(req);
    const found = await User.find({ $and: [buildUserListFilter(actor), { role: 'student' }, { _id: { $in: ids } }] }).select('_id').lean();
    if (found.length !== ids.length) return { error: 'Có người được chọn không còn hợp lệ (không phải sinh viên của bạn). Hãy chọn lại.' };
    return { ids };
}

/** Thông tin hiển thị (tên, email) của các id đã lưu — dùng khi mở form sửa. Id không còn tồn tại thì bỏ qua. */
async function describeUsers(req, ids) {
    const list = cleanIds(ids);
    if (!list.length) return [];
    const actor = await getActor(req);
    const users = await User.find({ $and: [buildUserListFilter(actor), { _id: { $in: list } }] }).select('name email').lean();
    const by = new Map(users.map((u) => [String(u._id), u]));
    return list.filter((id) => by.has(id)).map((id) => ({ id, name: by.get(id).name || '', email: by.get(id).email || '' }));
}

/** Trạng thái đưa cho form (JSON) — dùng chung cho Tài liệu / Đề / Đề trắc nghiệm. */
async function formState(req, rec) {
    return {
        visibility: rec ? visibilityOf(rec) : 'public',
        allowedUsers: rec ? await describeUsers(req, rec.allowedUserIds) : [],
        maxUsers: MAX_ALLOWED_USERS
    };
}

/** GET …/users?q= — tìm sinh viên theo họ tên / email / 1 đoạn tên (không phân biệt hoa-thường, có/không dấu). */
async function searchUsers(req, res) {
    try {
        const actor = await getActor(req);
        const q = String(req.query.q || '').trim().slice(0, 100);
        const conds = [buildUserListFilter(actor), { role: 'student', status: 'approved' }];
        q.split(/\s+/).filter(Boolean).slice(0, 6).forEach((t) => { const c = buildSearchClause(t, ['name', 'email']); if (c) conds.push(c); });
        const filter = { $and: conds };
        const [users, total] = await Promise.all([
            User.find(filter).select('name email').sort({ name: 1 }).limit(30).lean(),
            User.countDocuments(filter)
        ]);
        res.set({ 'Cache-Control': 'private, no-store' });
        return res.json({ success: true, total, users: users.map((u) => ({ id: String(u._id), name: u.name || '', email: u.email || '' })) });
    } catch (e) {
        console.error('[audience.searchUsers]', e);
        return res.status(500).json({ success: false, message: 'Không tìm được người dùng.' });
    }
}

// ------------------------------------------------------------
// Người XEM
// ------------------------------------------------------------
/** Người xem có được thấy bản ghi này không. Admin luôn thấy. */
function canSee(user, rec) {
    if (isAdminUser(user)) return true;
    if (!rec || rec.isPublished === false || rec.visibility === 'private') return false;
    if (rec.visibility === 'users') return (rec.allowedUserIds || []).map(String).includes(uidOf(user));
    return true;
}

/** Mệnh đề lọc cho sinh viên (gộp bằng $and — KHÔNG spread cùng $or của scope.filter). */
function audienceClause(user) {
    return {
        $and: [
            { visibility: { $ne: 'private' } },
            { $or: [{ visibility: { $ne: 'users' } }, { allowedUserIds: uidOf(user) }] }
        ]
    };
}

/** Bộ lọc + (nếu không phải admin) điều kiện "ai được xem". */
function withAudience(filter, user) {
    if (isAdminUser(user)) return filter;
    return { $and: [filter, audienceClause(user)] };
}

module.exports = {
    VISIBILITIES, MAX_ALLOWED_USERS, isObjectId, cleanIds, visibilityOf, readAudience,
    resolveAllowedUsers, describeUsers, formState, searchUsers, canSee, audienceClause, withAudience
};
