// ============================================================
// services/groupService.js — NHÓM NGƯỜI DÙNG (dùng cho "Chỉ hiển thị với…") lưu ở GitHub
// ------------------------------------------------------------
//   userkeys/groups/index.json
//   { "version": 1, "updatedAt": "<ISO>", "groups": [ { id, name, userKey, memberIds[], createdBy, createdAt, updatedAt }, ... ] }
//
// - userKey = id tổ chức (User Key) sở hữu nhóm; null = tổ chức default. Mỗi admin chỉ thấy / sửa nhóm của đúng tổ chức mình.
// - memberIds = id sinh viên (hex24). Thành viên được kiểm tra lại là sinh viên thuộc phạm vi của admin khi lưu.
// - Đọc: nạp cả file vào RAM; quá TTL thì nạp lại nền (stale-while-revalidate). Có HÀM ĐỒNG BỘ (groupIdsOfUser)
//   để audienceService lọc danh sách mà không phải đổi sang async — middleware warm() trong server.js nạp sẵn cache.
// - Ghi: đọc file mới nhất → gộp đúng nhóm đó → ghi bằng khoá SHA (lệch SHA thì đọc lại gộp lại, tối đa 4 lần).
// - Chưa có file trên GitHub = chưa có nhóm nào (không lỗi).
// ============================================================
const mongoose = require('mongoose');

let githubService = null;
function gh() {
    if (!githubService) githubService = require('./githubService');
    return githubService;
}

const GROUPS_PATH = 'userkeys/groups/index.json';
const CACHE_TTL_MS = Number(process.env.GROUPS_CACHE_TTL_MS || 20000);
const ERROR_RETRY_MS = 5000;
const MAX_WRITE_TRIES = 4;
const MAX_NAME_LEN = 100;
const MAX_MEMBERS = 1000;
const MAX_GROUPS = 300;

const isHex24 = (v) => /^[a-f0-9]{24}$/.test(String(v || '').toLowerCase());
const hex = (v) => (v == null || v === '' ? null : String(v._id || v).toLowerCase());
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const iso = (d) => (d ? new Date(d).toISOString() : null);
const cleanIds = (arr) => [...new Set((Array.isArray(arr) ? arr : [])
    .map((x) => String(x || '').trim().toLowerCase()).filter(isHex24))].slice(0, MAX_MEMBERS);

/** JSON thô → nhóm trong RAM (sai dữ liệu → null). */
function parseRow(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = hex(raw.id !== undefined ? raw.id : raw._id);
    const name = str(raw.name).slice(0, MAX_NAME_LEN);
    if (!id || !isHex24(id) || !name) return null;
    return {
        id, name,
        userKey: isHex24(hex(raw.userKey)) ? hex(raw.userKey) : null,
        memberIds: cleanIds(raw.memberIds),
        createdBy: isHex24(hex(raw.createdBy)) ? hex(raw.createdBy) : null,
        createdAt: iso(raw.createdAt) || new Date().toISOString(),
        updatedAt: iso(raw.updatedAt) || iso(raw.createdAt) || new Date().toISOString()
    };
}

const toRow = (g) => ({
    id: g.id, name: g.name, userKey: g.userKey || null, memberIds: g.memberIds || [],
    createdBy: g.createdBy || null, createdAt: g.createdAt, updatedAt: g.updatedAt
});

function extractRows(data) {
    if (Array.isArray(data)) return data;
    return data && Array.isArray(data.groups) ? data.groups : [];
}

// ------------------------------------------------------------
// Trạng thái RAM
// ------------------------------------------------------------
const state = {
    groups: new Map(),       // id → nhóm
    byUser: new Map(),       // userId → [groupId, …]  (chỉ mục ngược để lọc nhanh, đồng bộ)
    sha: null,
    loadedAt: 0,
    loading: null,
    chain: Promise.resolve(),
    lastError: null
};

function rebuildIndex() {
    state.byUser = new Map();
    for (const g of state.groups.values()) {
        for (const uid of g.memberIds) {
            if (!state.byUser.has(uid)) state.byUser.set(uid, []);
            state.byUser.get(uid).push(g.id);
        }
    }
}

function applyRows(rows) {
    const next = new Map();
    for (const raw of rows) {
        const g = parseRow(raw);
        if (g) next.set(g.id, g);
    }
    state.groups = next;
    rebuildIndex();
}

function load(force = false) {
    if (state.loading) return state.loading;
    state.loading = (async () => {
        try {
            const res = await gh().readJsonFileWithSha(GROUPS_PATH);
            if (res) {
                if (force || !state.loadedAt || res.sha !== state.sha) applyRows(extractRows(res.data));
                state.sha = res.sha;
            } else {
                applyRows([]);
                state.sha = null;
            }
            state.loadedAt = Date.now();
            state.lastError = null;
        } catch (e) {
            state.lastError = e.message;
            if (!state.loadedAt) throw e;                         // chưa có dữ liệu nào → báo lỗi thật
            state.loadedAt = Date.now() - CACHE_TTL_MS + ERROR_RETRY_MS;
            console.warn(`⚠️ [groupService] không đọc được ${GROUPS_PATH}: ${e.message} — dùng dữ liệu RAM hiện có.`);
        } finally {
            state.loading = null;
        }
    })();
    return state.loading;
}

/** Nạp nếu chưa có / quá TTL. Lần đầu thì ĐỢI; các lần sau nạp nền. */
async function ensureFresh() {
    if (!gh().isConfigured) return;
    if (!state.loadedAt) return load();
    if (Date.now() - state.loadedAt > CACHE_TTL_MS) load().catch(() => {});
}

async function reload() {
    if (!gh().isConfigured) return;
    if (state.loading) await state.loading.catch(() => {});
    return load(true);
}

/** Express middleware: nạp sẵn nhóm để các hàm đồng bộ bên dưới có dữ liệu. Lỗi GitHub không chặn request. */
function warm(req, res, next) {
    ensureFresh().then(() => next(), (e) => { console.warn('[groupService.warm]', e.message); next(); });
}

// ------------------------------------------------------------
// Đọc (đồng bộ, từ RAM)
// ------------------------------------------------------------
/** Khoá phạm vi của 1 admin (actor): id tổ chức hoặc null (default). */
const scopeOf = (actor) => (actor && actor.userKey ? hex(actor.userKey) : null);

function get(id) {
    return state.groups.get(hex(id)) || null;
}

/** Nhóm của 1 tổ chức (userKey = null → default), sắp theo tên. */
function listForScope(userKey) {
    const k = userKey ? hex(userKey) : null;
    return [...state.groups.values()].filter((g) => (g.userKey || null) === k)
        .sort((a, b) => a.name.localeCompare(b.name, 'vi'));
}

/** Nhóm có nằm trong phạm vi của actor không. */
const inScope = (g, actor) => !!g && (g.userKey || null) === scopeOf(actor);

/** Các id nhóm mà 1 người dùng đang là thành viên. */
function groupIdsOfUser(uid) {
    return state.byUser.get(hex(uid)) || [];
}

/** Hợp các thành viên của nhiều nhóm → Set<userId>. */
function memberSetOf(groupIds) {
    const set = new Set();
    for (const gid of groupIds || []) { const g = get(gid); if (g) g.memberIds.forEach((m) => set.add(m)); }
    return set;
}

// ------------------------------------------------------------
// Ghi
// ------------------------------------------------------------
function enqueue(fn) {
    const run = state.chain.then(fn, fn);
    state.chain = run.catch(() => {});
    return run;
}

/** op = { upsert: group } | { removeId } */
async function writeMerge(op) {
    const service = gh();
    if (!service.isConfigured) throw new Error('GitHub chưa cấu hình (GITHUB_TOKEN/OWNER/REPO) nên không lưu được nhóm.');
    let lastErr = null;
    for (let i = 0; i < MAX_WRITE_TRIES; i++) {
        const cur = await service.readJsonFileWithSha(GROUPS_PATH);
        const rows = extractRows(cur && cur.data).slice();
        const idx = (id) => rows.findIndex((r) => hex(r && (r.id !== undefined ? r.id : r._id)) === id);
        let message;
        if (op.upsert) {
            const row = toRow(op.upsert);
            const at = idx(row.id);
            if (at === -1) { rows.push(row); message = `[groups] thêm nhóm: ${row.name}`; }
            else { rows[at] = row; message = `[groups] cập nhật nhóm: ${row.name}`; }
        } else {
            const at = idx(op.removeId);
            if (at === -1) { applyRows(rows); return; }
            message = `[groups] xoá nhóm: ${rows[at].name || op.removeId}`;
            rows.splice(at, 1);
        }
        const doc = { version: 1, updatedAt: new Date().toISOString(), groups: rows };
        try {
            const w = await service.writeJsonFileIfSha(GROUPS_PATH, doc, cur ? cur.sha : null, message);
            state.sha = w.sha;
            state.loadedAt = Date.now();
            applyRows(rows);
            return;
        } catch (e) {
            lastErr = e;
            if ((e.name !== 'HttpError' && e.code === 'SHA_CONFLICT') && i < MAX_WRITE_TRIES - 1) continue;
            throw e;
        }
    }
    throw lastErr;
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

function checkName(name, scope, exceptId) {
    const n = str(name);
    if (!n) throw httpError(400, 'Vui lòng nhập tên nhóm.');
    if (n.length > MAX_NAME_LEN) throw httpError(400, `Tên nhóm tối đa ${MAX_NAME_LEN} ký tự.`);
    const low = n.toLowerCase();
    if (listForScope(scope).some((g) => g.id !== exceptId && g.name.toLowerCase() === low)) {
        throw httpError(400, 'Đã có nhóm trùng tên.');
    }
    return n;
}

/** Tạo nhóm. Ném lỗi có .status khi dữ liệu sai. */
async function create({ name, userKey, memberIds, createdBy }) {
    await reload();
    const scope = userKey ? hex(userKey) : null;
    const n = checkName(name, scope, null);
    if (listForScope(scope).length >= MAX_GROUPS) throw httpError(400, `Tối đa ${MAX_GROUPS} nhóm.`);
    const now = new Date().toISOString();
    const g = {
        id: new mongoose.Types.ObjectId().toHexString(), name: n, userKey: scope,
        memberIds: cleanIds(memberIds), createdBy: hex(createdBy), createdAt: now, updatedAt: now
    };
    await enqueue(() => writeMerge({ upsert: g }));
    return get(g.id) || g;
}

/** Sửa tên / thành viên. patch = { name?, memberIds? } */
async function update(id, patch) {
    await reload();
    const cur = get(id);
    if (!cur) throw httpError(404, 'Không tìm thấy nhóm.');
    const next = Object.assign({}, cur, {
        name: patch.name !== undefined ? checkName(patch.name, cur.userKey, cur.id) : cur.name,
        memberIds: patch.memberIds !== undefined ? cleanIds(patch.memberIds) : cur.memberIds,
        updatedAt: new Date().toISOString()
    });
    await enqueue(() => writeMerge({ upsert: next }));
    return get(id) || next;
}

async function remove(id) {
    await reload();
    if (!get(id)) throw httpError(404, 'Không tìm thấy nhóm.');
    await enqueue(() => writeMerge({ removeId: hex(id) }));
}

/** Webhook push: commit đụng userkeys/groups/index.json (hoặc không chắc) → nạp lại. */
async function onPush(payload) {
    if (!payload || typeof payload !== 'object') return false;
    const commits = Array.isArray(payload.commits) ? payload.commits : [];
    const touched = payload.forced || commits.length >= 20 || commits.some((c) =>
        [].concat(c.added || [], c.modified || [], c.removed || []).includes(GROUPS_PATH));
    if (!touched) return false;
    await reload();
    return true;
}

function _reset() {      // chỉ cho test
    state.groups = new Map(); state.byUser = new Map(); state.sha = null; state.loadedAt = 0;
    state.loading = null; state.chain = Promise.resolve(); state.lastError = null;
}

module.exports = {
    GROUPS_PATH, MAX_NAME_LEN, MAX_MEMBERS, MAX_GROUPS,
    ensureFresh, reload, warm, onPush, scopeOf, inScope, get, listForScope, groupIdsOfUser, memberSetOf,
    create, update, remove, parseRow, _reset, _state: state
};
