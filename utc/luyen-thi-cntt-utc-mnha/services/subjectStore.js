// ============================================================
// services/subjectStore.js — MÔN HỌC lưu ở GitHub (KHÔNG còn ở MongoDB)
// ------------------------------------------------------------
//   subjects/index.json
//   { "version": 1, "updatedAt": "<ISO>", "subjects": [ { _id, name, code, slug, ... }, ... ] }
//
// - Dùng cho models/Subject.js (qua services/githubModel.createModel) nên controller
//   vẫn gọi NGUYÊN API cũ: Subject.find / findOne / findById / create / save / updateOne ...
// - Đọc: nạp cả file vào RAM; quá TTL thì nạp lại nền (stale-while-revalidate);
//   webhook push có đụng subjects/index.json → nạp lại ngay (githubStore.applyPush gọi onPush).
// - Ghi (thêm / sửa / xoá môn): đọc file mới nhất → gộp đúng bản ghi đó → ghi bằng khoá SHA
//   (lệch SHA thì đọc lại gộp lại, tối đa 4 lần) → không ghi đè thay đổi của nơi khác.
// - Chưa có file trên GitHub = chưa có môn nào (không lỗi). GitHub lỗi lúc nạp lần đầu → ném lỗi
//   (không trả danh sách rỗng giả).
// ============================================================
const { toObjectId } = require('./githubModel');

let githubService = null;
function gh() {
    if (!githubService) githubService = require('./githubService');
    return githubService;
}

const SUBJECTS_PATH = 'subjects/index.json';
const CACHE_TTL_MS = Number(process.env.SUBJECTS_CACHE_TTL_MS || 20000);
const ERROR_RETRY_MS = 5000;
const MAX_WRITE_TRIES = 4;

const ID_FIELDS = ['promptId', 'quizPromptId', 'userKey', 'createdBy', 'updatedBy', 'deletedBy'];

const FIELDS = ['name', 'code', 'slug', 'description', 'order', 'githubFolder', 'promptId', 'quizPromptId',
    'isPublished', 'userKey', 'createdBy', 'updatedBy', 'deletedAt', 'deletedBy', 'deletedForever',
    'createdAt', 'updatedAt'];

const hex = (v) => (v == null ? null : String(v.toHexString ? v.toHexString() : v));
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const iso = (d) => (d ? new Date(d).toISOString() : null);
const stable = (v) => JSON.stringify(v);

function toDate(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'object' && !(v instanceof Date)) {
        if (v.$date === undefined) return null;
        v = (v.$date && typeof v.$date === 'object' && v.$date.$numberLong !== undefined) ? Number(v.$date.$numberLong) : v.$date;
    }
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}

function defaults() {
    return {
        name: '', code: null, slug: null, description: '', order: 0, githubFolder: null,
        promptId: null, quizPromptId: null, isPublished: true, userKey: null,
        createdBy: null, updatedBy: null, deletedAt: null, deletedBy: null, deletedForever: false
    };
}

/** JSON (hoặc document Mongo thô / Extended JSON {$oid}/{$date}) → bản ghi trong RAM. Sai dữ liệu → null. */
function parseRow(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const _id = toObjectId(raw._id !== undefined ? raw._id : raw.id);
    const name = str(raw.name).slice(0, 200);
    if (!_id || !name) return null;
    const rec = Object.assign(defaults(), { _id, name });
    rec.code = str(raw.code) || null;
    rec.slug = str(raw.slug).toLowerCase() || null;
    rec.description = typeof raw.description === 'string' ? raw.description : '';
    rec.order = Number.isFinite(Number(raw.order)) ? Number(raw.order) : 0;
    rec.githubFolder = str(raw.githubFolder) || null;
    rec.isPublished = raw.isPublished !== false;
    rec.deletedForever = raw.deletedForever === true;
    for (const k of ID_FIELDS) rec[k] = toObjectId(raw[k]);
    rec.deletedAt = toDate(raw.deletedAt);
    rec.createdAt = toDate(raw.createdAt) || new Date();
    rec.updatedAt = toDate(raw.updatedAt) || rec.createdAt;
    return rec;
}

/** bản ghi RAM → 1 phần tử trong file JSON */
function toRow(r) {
    return {
        _id: hex(r._id), name: r.name, code: r.code || null, slug: r.slug || null,
        description: r.description || '', order: Number(r.order) || 0, githubFolder: r.githubFolder || null,
        promptId: hex(r.promptId), quizPromptId: hex(r.quizPromptId),
        isPublished: r.isPublished !== false, userKey: hex(r.userKey),
        createdBy: hex(r.createdBy), updatedBy: hex(r.updatedBy),
        deletedAt: iso(r.deletedAt), deletedBy: hex(r.deletedBy), deletedForever: r.deletedForever === true,
        createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt)
    };
}

function extractRows(data) {
    if (Array.isArray(data)) return data;
    return data && Array.isArray(data.subjects) ? data.subjects : [];
}

// ------------------------------------------------------------
// Trạng thái RAM
// ------------------------------------------------------------
const state = {
    recs: new Map(),      // id(hex) → record
    dirty: new Map(),     // id(hex) → số lần ghi đang chờ (không để lần nạp lại đè bản local)
    sha: null,
    loadedAt: 0,
    loading: null,
    chain: Promise.resolve(),
    lastError: null
};

function applyRows(rows) {
    const seen = new Set();
    for (const raw of rows) {
        const rec = parseRow(raw);
        if (!rec) continue;
        const id = hex(rec._id);
        seen.add(id);
        if (state.dirty.has(id)) continue;
        const cur = state.recs.get(id);
        if (cur) { for (const k of Object.keys(cur)) delete cur[k]; Object.assign(cur, rec); }
        else state.recs.set(id, rec);
    }
    for (const id of [...state.recs.keys()]) {
        if (!seen.has(id) && !state.dirty.has(id)) state.recs.delete(id);
    }
}

function load(force = false) {
    if (state.loading) return state.loading;
    state.loading = (async () => {
        try {
            const res = await gh().readJsonFileWithSha(SUBJECTS_PATH);
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
            if (!state.loadedAt) throw e;                       // chưa có dữ liệu nào → báo lỗi thật
            state.loadedAt = Date.now() - CACHE_TTL_MS + ERROR_RETRY_MS;
            console.warn(`⚠️ [subjectStore] không đọc được ${SUBJECTS_PATH}: ${e.message} — dùng dữ liệu RAM hiện có.`);
        } finally {
            state.loading = null;
        }
    })();
    return state.loading;
}

async function ensureFresh() {
    if (!gh().isConfigured) return;
    if (!state.loadedAt) return load();
    if (Date.now() - state.loadedAt > CACHE_TTL_MS) load().catch(() => {});
}

/** Nạp lại ngay từ GitHub (đợi lần nạp đang chạy xong rồi nạp lần nữa để chắc chắn mới). */
async function reload() {
    if (!gh().isConfigured) return;
    if (state.loading) await state.loading.catch(() => {});
    return load(true);
}

/** Nạp lại nếu dữ liệu RAM cũ hơn `ms` mili-giây. */
async function refreshIfOlderThan(ms = 2000) {
    if (!gh().isConfigured) return;
    if (state.loadedAt && Date.now() - state.loadedAt <= ms) return;
    return reload();
}

/** Webhook push: nếu có commit đụng subjects/index.json (hoặc không chắc) → nạp lại. */
async function onPush(payload) {
    if (!payload || typeof payload !== 'object') return false;
    const commits = Array.isArray(payload.commits) ? payload.commits : [];
    const touched = payload.forced || commits.length >= 20 || commits.some((c) =>
        [].concat(c.added || [], c.modified || [], c.removed || []).includes(SUBJECTS_PATH));
    if (!touched) return false;
    await reload();
    return true;
}

// ------------------------------------------------------------
// Ghi
// ------------------------------------------------------------
function normalize(rec) {
    if (typeof rec.name === 'string') rec.name = rec.name.trim().slice(0, 200);
    if (typeof rec.code === 'string') rec.code = rec.code.trim() || null;
    if (typeof rec.slug === 'string') rec.slug = rec.slug.trim().toLowerCase() || null;
    return rec;
}

function enqueue(fn) {
    const run = state.chain.then(fn, fn);
    state.chain = run.catch(() => {});
    return run;
}

function bump(id, n) {
    const v = (state.dirty.get(id) || 0) + n;
    if (v > 0) state.dirty.set(id, v); else state.dirty.delete(id);
}

async function writeMerge({ upsert, removeId }) {
    const service = gh();
    if (!service.isConfigured) throw new Error('GitHub chưa cấu hình (GITHUB_TOKEN/OWNER/REPO) nên không lưu được môn học.');
    let lastErr = null;
    for (let i = 0; i < MAX_WRITE_TRIES; i++) {
        const cur = await service.readJsonFileWithSha(SUBJECTS_PATH);
        const rows = extractRows(cur && cur.data).slice();
        const idOf = (r) => hex(toObjectId(r && r._id));
        let message;

        if (upsert) {
            const row = toRow(upsert);
            const idx = rows.findIndex((r) => idOf(r) === row._id);
            if (idx === -1) { rows.push(row); message = `[subjects] thêm môn học: ${row.name}`; }
            else {
                const old = parseRow(rows[idx]);
                if (old && stable(toRow(old)) === stable(row)) {   // không đổi gì → khỏi commit
                    if (cur) state.sha = cur.sha;
                    applyRows(rows);
                    return;
                }
                rows[idx] = row;
                message = row.deletedForever ? `[subjects] xoá vĩnh viễn môn học: ${row.name}`
                    : row.deletedAt ? `[subjects] xoá môn học: ${row.name}` : `[subjects] cập nhật môn học: ${row.name}`;
            }
        } else {
            const idx = rows.findIndex((r) => idOf(r) === removeId);
            if (idx === -1) { applyRows(rows); return; }
            message = `[subjects] xoá khỏi danh sách: ${rows[idx].name || removeId}`;
            rows.splice(idx, 1);
        }

        const doc = { version: 1, updatedAt: new Date().toISOString(), subjects: rows };
        try {
            const w = await service.writeJsonFileIfSha(SUBJECTS_PATH, doc, cur ? cur.sha : null, message);
            state.sha = w.sha;
            state.loadedAt = Date.now();
            applyRows(rows);
            return;
        } catch (e) {
            lastErr = e;
            if (e.code === 'SHA_CONFLICT' && i < MAX_WRITE_TRIES - 1) continue;
            throw e;
        }
    }
    throw lastErr;
}

// ------------------------------------------------------------
// Store cho githubModel.createModel
// ------------------------------------------------------------
const store = {
    async all() { await ensureFresh(); return [...state.recs.values()]; },
    byId(id) { return state.recs.get(hex(id)) || null; },
    upsert(rec) {
        rec._id = toObjectId(rec._id) || rec._id;
        normalize(rec);
        const id = hex(rec._id);
        const old = state.recs.get(id);
        if (old && old !== rec) { Object.assign(old, rec); return old; }
        state.recs.set(id, rec);
        return rec;
    },
    async persist(rec) {
        const live = state.recs.get(hex(rec._id)) || rec;
        normalize(live);
        if (!live.name) throw new Error('Tên môn học không được để trống.');
        const id = hex(live._id);
        bump(id, 1);
        try {
            await enqueue(() => writeMerge({ upsert: live }));
        } catch (e) {
            bump(id, -1);
            await load(true).catch(() => {});      // đồng bộ lại với GitHub (bỏ bản chưa lưu được)
            throw e;
        }
        bump(id, -1);
    },
    async remove(rec) {
        const id = hex(rec._id);
        state.recs.delete(id);
        bump(id, 1);
        try {
            await enqueue(() => writeMerge({ removeId: id }));
        } catch (e) {
            bump(id, -1);
            await load(true).catch(() => {});
            throw e;
        }
        bump(id, -1);
    }
};

function _reset() {      // chỉ cho test
    state.recs.clear(); state.dirty.clear(); state.sha = null; state.loadedAt = 0;
    state.loading = null; state.chain = Promise.resolve(); state.lastError = null;
}

module.exports = {
    SUBJECTS_PATH, FIELDS, store, defaults, parseRow, toRow, extractRows,
    ensureFresh, reload, refreshIfOlderThan, onPush, _reset, _state: state
};
