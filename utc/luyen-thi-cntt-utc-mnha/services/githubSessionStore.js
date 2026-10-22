// services/githubSessionStore.js
// ============================================================
// SESSION STORE LƯU TRÊN GITHUB (thay cho connect-mongo / collection `sessions`)
// ------------------------------------------------------------
// Toàn bộ session nằm trong MỘT file:  cookies/index.json
//   {
//     "version": 1,
//     "updatedAt": "<ISO>",
//     "total": <số session>,
//     "sessions": {
//        "<sid đã mã hoá>": { "e": "<hết hạn ISO>", "u": "<cập nhật ISO>", "d": "<dữ liệu session đã mã hoá>" },
//        ...
//     }
//   }
// Mã hoá/giải mã: xem services/cookieCryptoService.js (AES-256-GCM, 2 chiều).
//
// Cách hoạt động:
//  • get():     đọc file từ GitHub (cache RAM ngắn, mặc định 10 giây) → tra theo sid mã hoá → giải mã.
//               Không giải mã được / hết hạn ⇒ coi như không có session (không ném lỗi).
//  • set()/destroy(): gom các thay đổi cùng lúc thành 1 commit (đọc → áp dụng → ghi bằng đúng SHA;
//               GitHub báo SHA lệch thì tự đọc lại và thử lại). Callback chỉ gọi SAU khi commit xong
//               (an toàn cho Vercel serverless: không có việc ghi "chạy ngầm" sau khi trả response).
//  • Mỗi lần ghi tự dọn session đã hết hạn → file không phình mãi.
//  • KHÔNG có touch(): express-session chỉ ghi khi session thật sự thay đổi (resave:false), nên không
//    tốn 1 commit cho mỗi request. Hạn session = hạn cookie lúc tạo (24 giờ), không tự gia hạn.
// ============================================================
const session = require('express-session');
const githubService = require('./githubService');
const cookieCrypto = require('./cookieCryptoService');

const COOKIES_PATH = 'cookies/index.json';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CONFLICT_RETRY = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const newPending = () => ({ sets: new Map(), dels: new Set(), waiters: [] });

function extractSessions(doc) {
    const s = doc && doc.sessions;
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
}

function expiryMs(sess, fallbackTtl, explicitExpires) {
    if (explicitExpires) {
        const t = new Date(explicitExpires).getTime();
        if (Number.isFinite(t)) return t;
    }
    const c = sess && sess.cookie;
    if (c && c.expires) {
        const t = new Date(c.expires).getTime();
        if (Number.isFinite(t)) return t;
    }
    const ttl = c && Number(c.originalMaxAge) > 0 ? Number(c.originalMaxAge) : fallbackTtl;
    return Date.now() + ttl;
}

/**
 * Dựng 1 bản ghi để lưu vào cookies/index.json từ (sid thật, đối tượng session).
 * Dùng chung cho store và script chuyển dữ liệu từ MongoDB.
 */
function buildEntry(sid, sess, { expires = null, ttlMs = DEFAULT_TTL_MS } = {}) {
    const key = cookieCrypto.encryptSid(sid);
    return {
        key,
        entry: {
            e: new Date(expiryMs(sess, ttlMs, expires)).toISOString(),
            u: new Date().toISOString(),
            d: cookieCrypto.encryptData(JSON.stringify(sess), key)
        }
    };
}

const isExpired = (entry, now = Date.now()) => {
    const t = entry && entry.e ? new Date(entry.e).getTime() : NaN;
    return !Number.isFinite(t) || t <= now;
};

/**
 * Có nên dọn bản ghi này khỏi file khi ghi không? Chỉ dọn bản ghi ĐÚNG ĐỊNH DẠNG của store này đã hết hạn
 * (hoặc định dạng `exp` dạng số của dự án repository-mnha dùng chung file) — bản ghi lạ thì GIỮ NGUYÊN,
 * để 2 dự án dùng chung cookies/index.json cũng không xoá nhầm session của nhau.
 */
const isPrunable = (entry, now = Date.now()) => {
    if (!entry || typeof entry !== 'object') return true;
    if (entry.e !== undefined) return isExpired(entry, now);
    if (typeof entry.exp === 'number') return entry.exp <= now;
    return false;
};

/** Giải mã 1 bản ghi → object session, hoặc null nếu hết hạn/hỏng. */
function readEntry(key, entry) {
    if (!entry || isExpired(entry)) return null;
    try {
        return JSON.parse(cookieCrypto.decryptData(entry.d, key));
    } catch (e) {
        console.warn('[sessionStore] không giải mã được 1 session (sai khoá/bị sửa) → bỏ qua:', e.message);
        return null;
    }
}

class GithubSessionStore extends session.Store {
    constructor(opts = {}) {
        super();
        this.path = opts.path || COOKIES_PATH;
        this.readTtlMs = opts.readCacheMs ?? (Number(process.env.SESSION_READ_CACHE_MS) || 10 * 1000);
        this.defaultTtlMs = opts.ttlMs || DEFAULT_TTL_MS;
        this.batchDelayMs = opts.batchDelayMs ?? 50;
        this._cache = null;        // { at, sessions }
        this._loading = null;
        this._pending = newPending();
        this._running = null;
    }

    // ---------------- ĐỌC ----------------
    async _load(force = false) {
        const c = this._cache;
        if (!force && c && Date.now() - c.at < this.readTtlMs) return c.sessions;
        if (this._loading) return this._loading;

        this._loading = (async () => {
            try {
                const cur = await githubService.readJsonFileWithSha(this.path);
                const sessions = extractSessions(cur && cur.data);
                this._cache = { at: Date.now(), sessions };
                return sessions;
            } catch (e) {
                if (this._cache) {   // GitHub lỗi tạm thời → dùng bản RAM cũ, thử lại sau ~2 giây
                    console.warn(`[sessionStore] đọc GitHub lỗi, dùng bản RAM cũ: ${e.message}`);
                    this._cache.at = Date.now() - this.readTtlMs + 2000;
                    return this._cache.sessions;
                }
                throw e;
            } finally {
                this._loading = null;
            }
        })();
        return this._loading;
    }

    get(sid, cb) {
        (async () => {
            if (typeof sid !== 'string' || !sid) return null;
            const key = cookieCrypto.encryptSid(sid);
            const sessions = await this._load();
            return readEntry(key, sessions[key]);
        })().then((s) => cb(null, s), (err) => cb(err));
    }

    // ---------------- GHI ----------------
    set(sid, sess, cb) {
        let built;
        try {
            built = buildEntry(sid, sess, { ttlMs: this.defaultTtlMs });
        } catch (err) {
            return cb && cb(err);
        }
        this._enqueue({ sets: [[built.key, built.entry]] }).then(() => cb && cb(null), (err) => cb && cb(err));
    }

    destroy(sid, cb) {
        (async () => {
            if (typeof sid !== 'string' || !sid) return;
            const key = cookieCrypto.encryptSid(sid);
            // RAM mới tải và không có session này ⇒ khỏi tốn 1 commit
            const c = this._cache;
            if (c && Date.now() - c.at < this.readTtlMs && !c.sessions[key] && !this._pending.sets.has(key)) return;
            await this._enqueue({ dels: [key] });
        })().then(() => cb && cb(null), (err) => cb && cb(err));
    }

    _enqueue({ sets = [], dels = [] }) {
        const p = this._pending;
        for (const [k, v] of sets) { p.sets.set(k, v); p.dels.delete(k); }
        for (const k of dels) { p.dels.add(k); p.sets.delete(k); }
        const done = new Promise((resolve, reject) => p.waiters.push({ resolve, reject }));
        this._kick();
        return done;
    }

    _hasPending() {
        const p = this._pending;
        return p.sets.size > 0 || p.dels.size > 0 || p.waiters.length > 0;
    }

    _kick() {
        if (this._running) return;
        this._running = (async () => {
            await sleep(this.batchDelayMs);   // gom các thay đổi đến cùng lúc vào 1 commit
            while (this._hasPending()) {
                const batch = this._pending;
                this._pending = newPending();
                try {
                    await this._commit(batch);
                    batch.waiters.forEach((w) => w.resolve());
                } catch (e) {
                    console.warn(`[sessionStore] ghi ${this.path} lên GitHub thất bại: ${e.message}`);
                    batch.waiters.forEach((w) => w.reject(e));
                }
            }
        })().finally(() => {
            this._running = null;
            if (this._hasPending()) this._kick();   // có việc mới chen vào đúng lúc vừa xong
        });
    }

    async _commit(batch) {
        let lastErr = null;
        for (let attempt = 1; attempt <= MAX_CONFLICT_RETRY; attempt++) {
            const cur = await githubService.readJsonFileWithSha(this.path);
            const sessions = { ...extractSessions(cur && cur.data) };

            const now = Date.now();
            for (const [k, v] of Object.entries(sessions)) if (isPrunable(v, now)) delete sessions[k];
            for (const k of batch.dels) delete sessions[k];
            for (const [k, v] of batch.sets) sessions[k] = v;

            const doc = {
                version: 1,
                updatedAt: new Date().toISOString(),
                total: Object.keys(sessions).length,
                sessions
            };
            try {
                await githubService.writeJsonFileIfSha(
                    this.path, doc, cur ? cur.sha : null,
                    `[sessions] +${batch.sets.size} -${batch.dels.size} (còn ${doc.total})`
                );
                this._cache = { at: Date.now(), sessions };
                return;
            } catch (e) {
                if (e.code !== 'SHA_CONFLICT') throw e;
                lastErr = e;   // instance khác vừa ghi → đọc lại, áp dụng lại, thử tiếp
                await sleep(100 * attempt + Math.random() * 200);
            }
        }
        throw lastErr || new Error('Không ghi được cookies/index.json (xung đột SHA liên tục).');
    }
}

module.exports = GithubSessionStore;
module.exports.COOKIES_PATH = COOKIES_PATH;
module.exports.DEFAULT_TTL_MS = DEFAULT_TTL_MS;
module.exports.buildEntry = buildEntry;
module.exports.readEntry = readEntry;
module.exports.extractSessions = extractSessions;
module.exports.isExpired = isExpired;
module.exports.isPrunable = isPrunable;
