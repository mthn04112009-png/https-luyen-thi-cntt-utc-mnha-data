// ============================================================
// services/audienceService.js — "AI ĐƯỢC XEM" dùng chung (Tài liệu /documents, Đề /admin/lessons, Đề trắc nghiệm /admin/quiz)
// ------------------------------------------------------------
// Giống chế độ hiển thị của Video (/videos/dashboard/new):
//   visibility = 'public'  → mọi sinh viên đã được duyệt (mặc định như cũ)
//                'private' → chỉ admin
//                'users'   → chỉ những người / NHÓM được chọn (allowedUserIds = id user, allowedGroupIds = id nhóm — lưu trong JSON trên GitHub;
//                            nhóm do admin tạo ở /admin/user-keys/groups, lưu ở userkeys/groups/index.json)
//   Admin luôn thấy hết. isPublished = (visibility !== 'private') — giữ tương thích với code cũ.
// Bản ghi cũ KHÔNG có visibility → suy từ isPublished (false → private, còn lại → public).
// ============================================================
const mongoose = require('mongoose');

const User = require('../models/User');
const { getActor, buildUserListFilter } = require('./userKeyService');
const { buildSearchClause } = require('../utils/search');
const groupService = require('./groupService');

const VISIBILITIES = ['public', 'private', 'users'];
const MAX_ALLOWED_USERS = 300;
const MAX_ALLOWED_GROUPS = 50;

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
    if (!visibility) return { provided: false, visibility: 'public', isPublished: true, allowedUserIds: [], allowedGroupIds: [] };
    const allowedUserIds = visibility === 'users' ? cleanIds(b.allowedUserIds) : [];
    const allowedGroupIds = visibility === 'users' ? cleanIds(b.allowedGroupIds) : [];
    if (visibility === 'users' && !allowedUserIds.length && !allowedGroupIds.length) {
        return { error: 'Hãy chọn ít nhất 1 nhóm hoặc 1 tài khoản được xem (hoặc đổi sang chế độ khác).' };
    }
    return { provided: true, visibility, isPublished: visibility !== 'private', allowedUserIds, allowedGroupIds };
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

/**
 * Kiểm tra CẢ người lẫn nhóm của phần "Chỉ hiển thị với…".
 *   - nhóm phải tồn tại và thuộc tổ chức của admin này;
 *   - người phải là sinh viên trong phạm vi admin;
 *   - ★ người đã nằm trong 1 nhóm được chọn thì BỎ khỏi danh sách người (chỉ giữ nhóm có người đó) → tránh trùng lặp.
 * Trả { ids, groupIds, removed: [userId…] } | { error }
 */
async function resolveAudienceTargets(req, aud) {
    const a = aud || {};
    const groupIds = cleanIds(a.allowedGroupIds);
    if (groupIds.length > MAX_ALLOWED_GROUPS) return { error: `Tối đa ${MAX_ALLOWED_GROUPS} nhóm cho mỗi mục.` };
    if (groupIds.length) {
        await groupService.ensureFresh().catch(() => {});
        const actor = await getActor(req);
        if (!groupIds.every((id) => groupService.inScope(groupService.get(id), actor))) {
            return { error: 'Có nhóm không còn tồn tại hoặc không thuộc tổ chức của bạn. Hãy chọn lại.' };
        }
    }
    const inGroups = groupService.memberSetOf(groupIds);
    const wanted = cleanIds(a.allowedUserIds);
    const removed = wanted.filter((id) => inGroups.has(id));
    const users = await resolveAllowedUsers(req, wanted.filter((id) => !inGroups.has(id)));
    if (users.error) return users;
    return { ids: users.ids, groupIds, removed };
}

/** Thông tin hiển thị của các nhóm đã lưu (chỉ nhóm còn tồn tại, đúng tổ chức). */
async function describeGroups(req, ids) {
    const list = cleanIds(ids);
    if (!list.length) return [];
    await groupService.ensureFresh().catch(() => {});
    const actor = await getActor(req);
    return list.map((id) => groupService.get(id)).filter((g) => groupService.inScope(g, actor)).map(groupInfo);
}

const groupInfo = (g) => ({ id: g.id, name: g.name, count: g.memberIds.length, memberIds: g.memberIds });

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
        allowedGroups: rec ? await describeGroups(req, rec.allowedGroupIds) : [],
        maxUsers: MAX_ALLOWED_USERS,
        maxGroups: MAX_ALLOWED_GROUPS
    };
}

const fold = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

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
        // ★ Nhóm của tổ chức này khớp từ khoá (tìm theo tên nhóm, không phân biệt hoa-thường / dấu)
        let groups = [];
        if (String(req.query.groups) !== '0') {
            await groupService.ensureFresh().catch(() => {});
            const toks = q.split(/\s+/).filter(Boolean).slice(0, 6).map(fold);
            groups = groupService.listForScope(groupService.scopeOf(actor))
                .filter((g) => { const n = fold(g.name); return toks.every((t) => n.includes(t)); })
                .slice(0, 30).map(groupInfo);
        }
        res.set({ 'Cache-Control': 'private, no-store' });
        return res.json({ success: true, total, groups, users: users.map((u) => ({ id: String(u._id), name: u.name || '', email: u.email || '' })) });
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
    if (rec.visibility === 'users') {
        const uid = uidOf(user);
        if ((rec.allowedUserIds || []).map(String).includes(uid)) return true;
        const mine = groupService.groupIdsOfUser(uid);                       // ★ hoặc thuộc 1 nhóm được chọn
        return mine.length > 0 && (rec.allowedGroupIds || []).map(String).some((g) => mine.includes(g));
    }
    return true;
}

/** Mệnh đề lọc cho sinh viên (gộp bằng $and — KHÔNG spread cùng $or của scope.filter). */
function audienceClause(user) {
    const uid = uidOf(user);
    const mine = groupService.groupIdsOfUser(uid);      // ★ nhóm mà người này là thành viên (RAM — warm() nạp sẵn)
    return {
        $and: [
            { visibility: { $ne: 'private' } },
            { $or: [{ visibility: { $ne: 'users' } }, { allowedUserIds: uid }, ...mine.map((g) => ({ allowedGroupIds: g }))] }
        ]
    };
}

/** Bộ lọc + (nếu không phải admin) điều kiện "ai được xem". */
function withAudience(filter, user) {
    if (isAdminUser(user)) return filter;
    return { $and: [filter, audienceClause(user)] };
}

module.exports = {
    VISIBILITIES, MAX_ALLOWED_USERS, MAX_ALLOWED_GROUPS, isObjectId, cleanIds, visibilityOf, readAudience,
    resolveAllowedUsers, resolveAudienceTargets, describeUsers, describeGroups, formState, searchUsers, canSee, audienceClause, withAudience
};
