// controllers/userGroup.controller.js
// ============================================================
// QUẢN LÝ NHÓM (/admin/user-keys/groups) — nhóm sinh viên dùng cho "Chỉ hiển thị với…"
//   GET  /admin/user-keys/groups              danh sách nhóm
//   GET  /admin/user-keys/groups/new          form tạo
//   GET  /admin/user-keys/groups/:id/edit     form sửa (đổi tên + thành viên)
//   GET  /admin/user-keys/groups/users?q=     tìm sinh viên để thêm vào nhóm
//   POST /admin/user-keys/groups              tạo   { name, memberIds }
//   POST /admin/user-keys/groups/:id          sửa   { name, memberIds }
//   POST /admin/user-keys/groups/:id/delete   xoá
// Lưu trữ: GitHub — userkeys/groups/index.json (services/groupService.js).
// Quyền: MỌI admin (default và admin tổ chức); mỗi admin chỉ thấy / sửa nhóm của đúng tổ chức mình
//        và chỉ thêm được sinh viên thuộc phạm vi mình quản lý (userKeyService.buildUserListFilter).
// ============================================================
const User = require('../models/User');
const groupService = require('../services/groupService');
const audience = require('../services/audienceService');
const { getActor, buildUserListFilter } = require('../services/userKeyService');

const viewUser = (req) => req.user || req.session?.user || null;
const go = (res, msg, type) => res.redirect(`/admin/user-keys/groups?${type || 'success'}=${encodeURIComponent(msg)}`);
const fail = (res, status, message) => res.status(status).json({ success: false, message });
const safeJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const renderError = (res, status, message) =>
    res.status(status).render('error', { title: status === 404 ? 'Không tìm thấy' : 'Lỗi', message, statusCode: status, stack: null });

async function loadActor(req) {
    const actor = await getActor(req);
    if (!actor || actor.role !== 'admin') return null;
    await groupService.reload().catch((e) => { console.warn('[groups] reload:', e.message); });
    return actor;
}

/** Chỉ giữ thành viên hợp lệ: sinh viên thuộc phạm vi của admin. Trả { ids } | { error }. */
async function checkMembers(actor, raw) {
    const ids = audience.cleanIds(raw);
    if (ids.length > groupService.MAX_MEMBERS) return { error: `Mỗi nhóm tối đa ${groupService.MAX_MEMBERS} thành viên.` };
    if (!ids.length) return { ids: [] };
    const found = await User.find({ $and: [buildUserListFilter(actor), { role: 'student' }, { _id: { $in: ids } }] }).select('_id').lean();
    if (found.length !== ids.length) return { error: 'Có tài khoản không hợp lệ (không phải sinh viên của bạn). Hãy chọn lại.' };
    return { ids };
}

/** id → { id, name, email } cho các thành viên (bỏ người không còn tồn tại / ngoài phạm vi). */
async function describeMembers(actor, ids) {
    const list = audience.cleanIds(ids);
    if (!list.length) return new Map();
    const users = await User.find({ $and: [buildUserListFilter(actor), { _id: { $in: list } }] }).select('name email').lean();
    return new Map(users.map((u) => [String(u._id), { id: String(u._id), name: u.name || '', email: u.email || '' }]));
}

/** Số mục (đề / slide / flashcard / tài liệu) đang dùng nhóm này trong "Chỉ hiển thị với". */
async function usageCount(groupId) {
    try {
        const models = ['Lesson', 'Slide', 'Flashcard', 'Document'].map((n) => require(`../models/${n}`));
        const counts = await Promise.all(models.map((M) => M.countDocuments({ allowedGroupIds: groupId, isDeleted: { $ne: true } })));
        return counts.reduce((a, b) => a + b, 0);
    } catch (_) { return 0; }
}

// ------------------------------------------------------------
async function list(req, res, next) {
    try {
        const actor = await loadActor(req);
        if (!actor) return renderError(res, 403, 'Chỉ admin mới quản lý được nhóm.');
        const groups = groupService.listForScope(groupService.scopeOf(actor));
        const all = new Set(); groups.forEach((g) => g.memberIds.forEach((m) => all.add(m)));
        const byId = await describeMembers(actor, [...all]);
        const rows = await Promise.all(groups.map(async (g) => {
            const members = g.memberIds.map((id) => byId.get(id)).filter(Boolean);
            return { id: g.id, name: g.name, count: members.length, members: members.slice(0, 8), more: Math.max(0, members.length - 8), updatedAt: g.updatedAt, used: await usageCount(g.id) };
        }));
        res.render('admin/usergroups', {
            title: 'Quản lý nhóm', user: viewUser(req), groups: rows,
            isDefaultAdmin: !actor.userKey,
            error: req.query.error || null, success: req.query.success || null
        });
    } catch (err) { next(err); }
}

async function renderForm(req, res, next, group) {
    try {
        const actor = await loadActor(req);
        if (!actor) return renderError(res, 403, 'Chỉ admin mới quản lý được nhóm.');
        let members = [];
        if (group) {
            const byId = await describeMembers(actor, group.memberIds);
            members = group.memberIds.map((id) => byId.get(id)).filter(Boolean);
        }
        const state = {
            id: group ? group.id : null, name: group ? group.name : '', members,
            maxMembers: groupService.MAX_MEMBERS, maxName: groupService.MAX_NAME_LEN,
            searchUrl: '/admin/user-keys/groups/users', base: '/admin/user-keys/groups'
        };
        res.render('admin/usergroup-form', {
            title: group ? 'Sửa nhóm' : 'Tạo nhóm', user: viewUser(req), editing: !!group,
            gmStateJson: safeJson(state)
        });
    } catch (err) { next(err); }
}

const newForm = (req, res, next) => renderForm(req, res, next, null);

async function editForm(req, res, next) {
    try {
        const actor = await loadActor(req);
        if (!actor) return renderError(res, 403, 'Chỉ admin mới quản lý được nhóm.');
        const g = groupService.get(req.params.id);
        if (!groupService.inScope(g, actor)) return renderError(res, 404, 'Không tìm thấy nhóm.');
        return renderForm(req, res, next, g);
    } catch (err) { next(err); }
}

/** GET …/users?q= — chỉ tìm sinh viên (không kèm nhóm). */
function searchMembers(req, res) {
    req.query.groups = '0';
    return audience.searchUsers(req, res);
}

async function create(req, res) {
    try {
        const actor = await loadActor(req);
        if (!actor) return fail(res, 403, 'Chỉ admin mới quản lý được nhóm.');
        const m = await checkMembers(actor, (req.body || {}).memberIds);
        if (m.error) return fail(res, 400, m.error);
        const g = await groupService.create({ name: (req.body || {}).name, userKey: actor.userKey || null, memberIds: m.ids, createdBy: actor._id });
        return res.json({ success: true, id: g.id, redirect: `/admin/user-keys/groups?success=${encodeURIComponent(`Đã tạo nhóm "${g.name}" (${g.memberIds.length} người).`)}` });
    } catch (e) {
        if (e && e.status) return fail(res, e.status, e.message);
        console.error('[groups.create]', e);
        return fail(res, 500, 'Không lưu được nhóm: ' + (e.message || 'lỗi máy chủ'));
    }
}

async function update(req, res) {
    try {
        const actor = await loadActor(req);
        if (!actor) return fail(res, 403, 'Chỉ admin mới quản lý được nhóm.');
        const cur = groupService.get(req.params.id);
        if (!groupService.inScope(cur, actor)) return fail(res, 404, 'Không tìm thấy nhóm.');
        const m = await checkMembers(actor, (req.body || {}).memberIds);
        if (m.error) return fail(res, 400, m.error);
        const g = await groupService.update(cur.id, { name: (req.body || {}).name, memberIds: m.ids });
        return res.json({ success: true, id: g.id, redirect: `/admin/user-keys/groups?success=${encodeURIComponent(`Đã lưu nhóm "${g.name}" (${g.memberIds.length} người).`)}` });
    } catch (e) {
        if (e && e.status) return fail(res, e.status, e.message);
        console.error('[groups.update]', e);
        return fail(res, 500, 'Không lưu được nhóm: ' + (e.message || 'lỗi máy chủ'));
    }
}

async function remove(req, res) {
    try {
        const actor = await loadActor(req);
        if (!actor) return go(res, 'Chỉ admin mới quản lý được nhóm.', 'error');
        const g = groupService.get(req.params.id);
        if (!groupService.inScope(g, actor)) return go(res, 'Không tìm thấy nhóm.', 'error');
        const used = await usageCount(g.id);
        await groupService.remove(g.id);
        return go(res, `Đã xoá nhóm "${g.name}".` + (used ? ` Lưu ý: ${used} mục đang dùng nhóm này — hãy mở lại để chọn người / nhóm khác.` : ''));
    } catch (e) {
        console.error('[groups.remove]', e);
        return go(res, 'Không xoá được nhóm: ' + (e.message || 'lỗi máy chủ'), 'error');
    }
}

module.exports = { list, newForm, editForm, searchMembers, create, update, remove };
