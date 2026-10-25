// services/connect/usage.js — đếm lưu lượng của từng web (phục vụ trang /connect).
//
//   Fast Data Transfer      ≈ dữ liệu trình duyệt ⇄ web      (bytes vào + ra, đếm theo request)
//   Fast Origin Transfer    ≈ dữ liệu web ⇄ GitHub           (bytes ghi/đọc qua githubService)
//
//   Vercel không có API công khai cho 2 chỉ số này, nên đây là số ĐO THỰC TẾ của ứng dụng
//   (xấp xỉ, mỗi instance serverless giữ bộ đếm và ghi lên GitHub định kỳ). Số chính thức của
//   Vercel vẫn nhập tay ở /connect (lưu cùng sổ đăng ký).
//
//   LƯU TRỮ — KHÔNG XOÁ gì cả, mỗi TUẦN một file riêng (thứ Hai → Chủ nhật, ngày theo UTC):
//     usage/week-<N>/index.json
//       { v:2, week:N, from:"YYYY-MM-DD", to:"YYYY-MM-DD",
//         nodes:{ "<id>": { days:{ "YYYY-MM-DD":{in,out,originIn,originOut,req} }, updatedAt } } }
//   N = số thứ tự tuần tính từ tuần chứa CONNECT_USAGE_EPOCH (mặc định 2026-01-05 = tuần 1).
//   File cũ v-s/usage.json (bản trước) vẫn được ĐỌC và cộng vào, nhưng không ghi thêm.
'use strict';
const registry = require('./registry');

const DIR = () => String(process.env.CONNECT_USAGE_DIR || 'usage').replace(/^\/+|\/+$/g, '');
const LEGACY_FILE = () => process.env.CONNECT_USAGE_PATH || 'v-s/usage.json';
const FLUSH_MS = Number(process.env.CONNECT_USAGE_FLUSH_MS) > 0 ? Number(process.env.CONNECT_USAGE_FLUSH_MS) : 45 * 1000;
const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;
const CACHE_MS = 8 * 1000;
const LEGACY_CACHE_MS = 60 * 1000;

const utcMidnight = (ms) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
const mondayOf = (ms) => { const m = utcMidnight(ms); return m - ((new Date(m).getUTCDay() + 6) % 7) * DAY_MS; };
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const EPOCH = () => {
    const t = Date.parse(process.env.CONNECT_USAGE_EPOCH || '2026-01-05');
    return mondayOf(Number.isFinite(t) ? t : Date.parse('2026-01-05'));
};
/** Số thứ tự tuần (1, 2, 3 …) của tuần chứa thời điểm ms. */
const weekNo = (ms) => Math.floor((mondayOf(ms) - EPOCH()) / WEEK_MS) + 1;
const weekStartOf = (n) => EPOCH() + (n - 1) * WEEK_MS;
const weekPath = (n) => `${DIR()}/week-${n}/index.json`;
/** File của tuần hiện tại (hiện ở trang /connect). */
const FILE = () => weekPath(weekNo(Date.now()));

function nodeId() {
    if (process.env.NODE_ID) return String(process.env.NODE_ID);
    if (process.env.NODE_URL) {
        try { return registry.idForUrl(registry.cleanUrl(process.env.NODE_URL)); } catch (_) {
            try { return registry.idForUrl(String(process.env.NODE_URL).replace(/\/+$/, '')); } catch (__) { /* ignore */ }
        }
    }
    return 'main';
}

const KEYS = ['in', 'out', 'originIn', 'originOut', 'req'];
const pending = { in: 0, out: 0, originIn: 0, originOut: 0, req: 0 };
let timer = null;
let flushing = null;
let inFlush = false;   // đang tự ghi chính file lưu lượng → byte origin của lần ghi này KHÔNG được hẹn flush tiếp (tránh vòng lặp commit vô tận)
let lastError = null;

const day = () => new Date().toISOString().slice(0, 10);

function note({ in: bytesIn = 0, out: bytesOut = 0, req = 0 } = {}) {
    pending.in += Math.max(0, Number(bytesIn) || 0);
    pending.out += Math.max(0, Number(bytesOut) || 0);
    pending.req += Math.max(0, Number(req) || 0);
}
function noteOrigin({ in: read = 0, out: write = 0 } = {}) {
    pending.originIn += Math.max(0, Number(read) || 0);
    pending.originOut += Math.max(0, Number(write) || 0);
    if (!inFlush) schedule();
}
function hasPending() { return KEYS.some((k) => pending[k] > 0); }
function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; flush().catch(() => { /* đã log */ }); }, FLUSH_MS);
    if (timer.unref) timer.unref();
}

const empty = () => ({ in: 0, out: 0, originIn: 0, originOut: 0, req: 0 });
function add(a, b) {
    for (const k of KEYS) a[k] += Number(b && b[k]) || 0;
    return a;
}

function normalize(raw) {
    const d = raw && typeof raw === 'object' ? raw : {};
    if (!d.nodes || typeof d.nodes !== 'object') d.nodes = {};
    return d;
}

/** Ghi bộ đếm đang giữ vào file của TUẦN hôm nay. force=false: bỏ qua nếu chưa có gì / vừa ghi xong. */
async function flush({ force = false } = {}) {
    if (!force && !hasPending()) return { skipped: true };
    if (flushing) return flushing;
    flushing = (async () => {
        inFlush = true;
        const snapshot = { ...pending };
        const id = nodeId(), today = day();
        const no = weekNo(Date.now()), file = weekPath(no);
        const start = weekStartOf(no);
        const gh = require('../githubService');
        let last = null;
        for (let attempt = 0; attempt < 6; attempt++) {
            const cur = await gh.readJsonFileWithSha(file);
            const d = normalize(cur ? cur.data : {});
            d.v = 2; d.week = no; d.from = isoDay(start); d.to = isoDay(start + 6 * DAY_MS);
            const n = d.nodes[id] || (d.nodes[id] = { days: {} });
            if (!n.days) n.days = {};
            const row = n.days[today] || (n.days[today] = empty());
            for (const k of KEYS) row[k] = (Number(row[k]) || 0) + snapshot[k];
            n.updatedAt = new Date().toISOString();
            d.updatedAt = n.updatedAt;
            try {
                await gh.writeJsonFileIfSha(file, d, cur ? cur.sha : null, 'connect: lưu lượng tuần ' + no + ' · ' + id);
                for (const k of KEYS) pending[k] -= snapshot[k];
                lastError = null;
                _weekCache.delete(no);
                return { ok: true, id, week: no, file, day: today, row };
            } catch (e) {
                last = e;
                if (e.code !== 'SHA_CONFLICT') break;
                await new Promise((ok) => setTimeout(ok, 200 * (attempt + 1)));
            }
        }
        lastError = last ? last.message : 'không ghi được';
        console.warn('[connect/usage]', lastError);
        return { ok: false, error: lastError };
    })().finally(() => { flushing = null; inFlush = false; });
    return flushing;
}

// ---------------------------------------------------------------- ĐỌC (gộp file tuần + file cũ)
const _weekCache = new Map();               // số tuần → { at, doc }
let _legacy = null, _legacyAt = 0;

async function readWeek(no) {
    if (no < 1) return null;
    const hit = _weekCache.get(no);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.doc;
    const doc = await require('../githubService').readJsonFile(weekPath(no)).catch(() => null);
    _weekCache.set(no, { at: Date.now(), doc });
    return doc;
}
async function readLegacy() {
    if (_legacy !== null && Date.now() - _legacyAt < LEGACY_CACHE_MS) return _legacy;
    _legacy = normalize(await require('../githubService').readJsonFile(LEGACY_FILE()).catch(() => null));
    _legacyAt = Date.now();
    return _legacy;
}

/** Gộp các ngày: { id → { days:{date→row}, updatedAt } } từ file cũ + các file tuần được yêu cầu. */
async function loadNodes(nos) {
    const out = {};
    const merge = (src) => {
        for (const [id, n] of Object.entries((src && src.nodes) || {})) {
            if (!n || !n.days) continue;
            const o = out[id] || (out[id] = { days: {}, updatedAt: null });
            for (const [k, row] of Object.entries(n.days)) add(o.days[k] || (o.days[k] = empty()), row);
            if (n.updatedAt && (!o.updatedAt || n.updatedAt > o.updatedAt)) o.updatedAt = n.updatedAt;
        }
    };
    merge(await readLegacy());
    const docs = await Promise.all([...new Set(nos)].map((n) => readWeek(n)));
    docs.forEach(merge);
    return out;
}

function sumDays(rows, fromMs, toMs) {
    const t = empty();
    for (let ms = fromMs; ms <= toMs; ms += DAY_MS) add(t, rows && rows[isoDay(ms)]);
    return t;
}
function weeksBetween(fromMs, toMs) {
    const a = weekNo(fromMs), b = weekNo(toMs), r = [];
    for (let n = Math.max(1, a); n <= b; n++) r.push(n);
    return r;
}

/** Số liệu của các web: hôm nay / `days` ngày gần nhất + lần cuối ghi. */
async function snapshotAll(ids, { days = 30 } = {}) {
    const todayMs = utcMidnight(Date.now()), fromMs = todayMs - (days - 1) * DAY_MS;
    const nodes = await loadNodes(weeksBetween(fromMs, todayMs));
    const res = {};
    for (const id of ids) {
        const n = nodes[id] || { days: {}, updatedAt: null };
        res[id] = { id, today: sumDays(n.days, todayMs, todayMs), month: sumDays(n.days, fromMs, todayMs), updatedAt: n.updatedAt, lastError };
    }
    return res;
}
async function snapshot(id, opts) { return (await snapshotAll([id], opts))[id]; }

// ---------------------------------------------------------------- XEM THEO TUẦN
const DOW_NAMES = ['Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy', 'Chủ nhật'];

/** offset: 0 = tuần này, -1 = tuần trước … (số nguyên ≤ 0, không lùi quá tuần 1). */
function clampWeek(w) {
    let n = parseInt(w, 10);
    if (!Number.isFinite(n) || n > 0) return 0;
    const oldest = 1 - weekNo(Date.now());           // offset của tuần 1
    return Math.max(n, oldest, -5000);
}

/** Dựng 1 TUẦN đủ 7 ngày (thứ Hai → Chủ nhật, UTC). rows = { "YYYY-MM-DD": {...} } của 1 web. Ngày chưa tới: future. */
function buildWeek(rows, offset = 0) {
    rows = rows || {};
    offset = clampWeek(offset);
    const todayMs = utcMidnight(Date.now());
    const start = mondayOf(todayMs) + offset * WEEK_MS;
    const no = weekNo(start);
    const days = [];
    for (let i = 0; i < 7; i++) {
        const ms = start + i * DAY_MS, k = isoDay(ms);
        days.push(Object.assign({ date: k, dow: i, name: DOW_NAMES[i], future: ms > todayMs, today: ms === todayMs }, empty(), ms > todayMs ? {} : (rows[k] || {})));
    }
    const total = days.reduce((a, r) => add(a, r), empty());
    return {
        offset, week: no, file: weekPath(no),
        from: isoDay(start), to: isoDay(start + 6 * DAY_MS),
        days, total,
        prevTotal: sumDays(rows, start - WEEK_MS, start - DAY_MS),
        hasPrev: no > 1,
        hasNext: offset < 0
    };
}

/** Một tuần của nhiều web (đọc file tuần đó + tuần trước để so sánh): { id → tuần }. */
async function historyAll(ids, { week = 0 } = {}) {
    const offset = clampWeek(week);
    const start = mondayOf(Date.now()) + offset * WEEK_MS;
    const nodes = await loadNodes([weekNo(start), weekNo(start) - 1]);
    const res = {};
    for (const id of ids) res[id] = buildWeek(nodes[id] && nodes[id].days, offset);
    return res;
}
async function history(id, opts) { return (await historyAll([id], opts))[id]; }

/** Middleware đếm request/response (gắn ở web chính và web dữ liệu). */
function middleware() {
    return function usageCounter(req, res, next) {
        let wrote = 0;
        const inBytes = Number(req.headers && req.headers['content-length']) || 0;
        const w = res.write, e = res.end;
        res.write = function (chunk, ...rest) {
            if (chunk) wrote += typeof chunk === 'string' ? Buffer.byteLength(chunk) : (chunk.length || 0);
            return w.call(this, chunk, ...rest);
        };
        res.end = function (chunk, ...rest) {
            if (chunk && typeof chunk !== 'function') wrote += typeof chunk === 'string' ? Buffer.byteLength(chunk) : (chunk.length || 0);
            return e.call(this, chunk, ...rest);
        };
        res.on('finish', () => { note({ in: inBytes, out: wrote, req: 1 }); schedule(); });
        next();
    };
}

function formatBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return (Math.round(n * 10) / 10) + ' ' + u[i];
}
const bytesToGb = (n) => Math.round((Number(n) || 0) / (1024 ** 3) * 100) / 100;

module.exports = {
    note, noteOrigin, schedule, flush, snapshot, snapshotAll, history, historyAll, buildWeek, clampWeek,
    middleware, formatBytes, bytesToGb, nodeId, FILE, DIR, weekPath, weekNo, hasPending
};
