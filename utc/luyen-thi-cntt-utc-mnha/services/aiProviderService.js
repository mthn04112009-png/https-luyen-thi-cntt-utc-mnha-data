// ============================================================
// services/aiProviderService.js
// DANH SÁCH NHÀ CUNG CẤP AI (Gemini, vilao.ai, ChatGPT, DeepSeek…) lưu trên GitHub:
//       AI-database/index.json
//   {
//     "version": 1, "updatedAt": "<ISO>",
//     "providers": [ { id, label, kind, baseUrl, chatPath, maxTokens, models, defaultModel, ... }, ... ]
//   }
// ------------------------------------------------------------
// - `id` = giá trị field `provider` của AIKey trong MongoDB ('gemini', 'vilao', 'openai', …).
// - KEY API (mã hoá AES-256-GCM) vẫn nằm trong MongoDB; file JSON này KHÔNG chứa key nào.
// - kind:
//     'gemini' → gọi bằng SDK @google/genai (model chọn lúc chấm bài)
//     'openai' → API tương thích OpenAI: POST {baseUrl}{chatPath}  (vilao.ai, OpenAI, DeepSeek, OpenRouter…)
// - Dữ liệu nằm trong RAM (đọc đồng bộ qua getProvider/listProviders); tự nạp lại từ GitHub sau TTL.
//   Chưa có file trên GitHub / GitHub lỗi → dùng bản mặc định config/aiProviderSeed.js (app chạy như cũ).
// - Sửa trên web (/admin/ai-keys/Supplier) → ghi GitHub bằng khoá SHA (không ghi đè thay đổi của nơi khác).
// ============================================================
const githubService = require('./githubService');
const seed = require('../config/aiProviderSeed');

const AI_DB_PATH = 'AI-database/index.json';
const CACHE_TTL_MS = 45 * 1000;
const ERROR_RETRY_MS = 15 * 1000;

const ID_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\-:\/]{0,99}$/;
const RESERVED_IDS = new Set(['google', 'default', 'auto', 'all', 'none', 'supplier', 'cloudinary']);

// ------------------------------------------------------------
// Trạng thái trong RAM
// ------------------------------------------------------------
const state = {
    doc: null,          // JSON đã chuẩn hoá
    source: 'seed',     // 'github' | 'seed'
    sha: null,
    loadedAt: 0,
    lastError: null
};
let loading = null;
const listeners = [];

function clone(v) { return JSON.parse(JSON.stringify(v)); }
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ------------------------------------------------------------
// Kiểm tra dữ liệu
// ------------------------------------------------------------
function isValidModelName(m) { return typeof m === 'string' && MODEL_RE.test(m.trim()); }

function parseList(v) {
    if (Array.isArray(v)) return v.map((x) => String(x == null ? '' : x).trim()).filter(Boolean);
    if (typeof v === 'string') return v.split(/[\r\n,;]+/).map((x) => x.trim()).filter(Boolean);
    return [];
}

function uniq(list) { return Array.from(new Set(list)); }

// Chỉ cho gọi HTTPS tới host công khai (admin nhập địa chỉ → tránh trỏ vào mạng nội bộ)
function validateBaseUrl(raw) {
    let u;
    try { u = new URL(String(raw || '').trim()); } catch (_) { return { error: 'Địa chỉ API (baseUrl) không hợp lệ. Ví dụ: https://api.openai.com' }; }
    if (u.protocol !== 'https:') return { error: 'Địa chỉ API phải dùng https://' };
    if (u.username || u.password) return { error: 'Địa chỉ API không được chứa user/mật khẩu.' };
    const host = u.hostname.toLowerCase();
    if (
        host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') ||
        /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || !host.includes('.')
    ) {
        return { error: 'Địa chỉ API phải là tên miền công khai (không dùng localhost / địa chỉ IP / mạng nội bộ).' };
    }
    const base = u.origin + (u.pathname && u.pathname !== '/' ? u.pathname.replace(/\/+$/, '') : '');
    return { value: base };
}

function validateRegex(src) {
    if (src == null || src === '') return { value: '' };
    const s = String(src);
    if (s.length > 200) return { error: 'Biểu thức regex quá dài (tối đa 200 ký tự).' };
    try { new RegExp(s, 'i'); } catch (_) { return { error: 'Biểu thức regex không hợp lệ: ' + s }; }
    return { value: s };
}

/**
 * Chuẩn hoá + kiểm tra 1 nhà cung cấp.
 * @param {object} raw     dữ liệu thô (form / JSON)
 * @param {object} [prev]  bản hiện có (khi sửa) — id/kind/builtin/aliases giữ nguyên
 * @returns {{value?:object, errors:string[]}}
 */
function normalizeProviderInput(raw, prev = null) {
    const errors = [];
    const r = isPlainObject(raw) ? raw : {};
    const out = {};

    // id
    const id = prev ? prev.id : String(r.id || '').trim().toLowerCase();
    if (!prev) {
        if (!ID_RE.test(id)) errors.push('Mã nhà cung cấp (id) gồm 2–32 ký tự a-z, 0-9, "-" hoặc "_", bắt đầu bằng chữ. Ví dụ: openai, deepseek.');
        else if (RESERVED_IDS.has(id) || id === 'gemini') errors.push(`Mã "${id}" đã được hệ thống giữ lại.`);
    }
    out.id = id;

    // label / mô tả
    const label = String(r.label == null ? (prev && prev.label) || '' : r.label).trim();
    if (!label || label.length > 60) errors.push('Tên hiển thị bắt buộc (tối đa 60 ký tự).');
    out.label = label;
    out.description = String(r.description == null ? (prev && prev.description) || '' : r.description).trim().slice(0, 300);

    // kind: chỉ 'gemini' (builtin) hoặc 'openai'
    out.kind = prev ? prev.kind : 'openai';
    out.builtin = !!(prev && prev.builtin);
    out.aliases = prev && Array.isArray(prev.aliases) ? prev.aliases.slice() : [];
    out.enabled = r.enabled === undefined ? (prev ? prev.enabled !== false : true) : (r.enabled === true || r.enabled === 'true' || r.enabled === 'on' || r.enabled === '1' || r.enabled === 1);
    if (out.builtin) out.enabled = true; // Gemini luôn bật

    // API (chỉ loại openai)
    if (out.kind === 'openai') {
        const bu = validateBaseUrl(r.baseUrl == null ? prev && prev.baseUrl : r.baseUrl);
        if (bu.error) errors.push(bu.error); else out.baseUrl = bu.value;

        const chatPath = String(r.chatPath == null ? (prev && prev.chatPath) || '/v1/chat/completions' : r.chatPath).trim() || '/v1/chat/completions';
        if (!/^\/[A-Za-z0-9._~\-\/]{0,198}$/.test(chatPath) || chatPath.includes('..')) errors.push('Đường dẫn chat (chatPath) phải bắt đầu bằng "/", ví dụ /v1/chat/completions.');
        else out.chatPath = chatPath;

        const authHeader = String(r.authHeader == null ? (prev && prev.authHeader) || 'Authorization' : r.authHeader).trim() || 'Authorization';
        if (!/^[A-Za-z0-9-]{1,50}$/.test(authHeader)) errors.push('Tên header xác thực không hợp lệ.');
        else out.authHeader = authHeader;

        let scheme = r.authScheme == null ? (prev && prev.authScheme !== undefined ? prev.authScheme : 'Bearer') : String(r.authScheme).trim();
        if (!/^[A-Za-z]{0,20}$/.test(scheme)) { errors.push('Kiểu xác thực (authScheme) chỉ gồm chữ cái, ví dụ Bearer (để trống = gửi key trần).'); scheme = 'Bearer'; }
        out.authScheme = scheme;

        const mt = Number(r.maxTokens == null ? (prev && prev.maxTokens) || 4096 : r.maxTokens);
        if (!Number.isInteger(mt) || mt < 1 || mt > 200000) errors.push('max_tokens phải là số nguyên từ 1 đến 200000.');
        else out.maxTokens = mt;

        out.systemPrompt = String(r.systemPrompt == null ? (prev && prev.systemPrompt) || seed.DEFAULT_SYSTEM_PROMPT : r.systemPrompt).trim().slice(0, 1000) || seed.DEFAULT_SYSTEM_PROMPT;

        // Phát hiện lỗi "chưa subscribe model" (tuỳ chọn, kiểu vilao.ai)
        const errsIn = isPlainObject(r.errors) ? r.errors : {};
        const prevErr = (prev && prev.errors) || {};
        const sub = validateRegex(errsIn.subscribeRegex !== undefined ? errsIn.subscribeRegex : (r.subscribeRegex !== undefined ? r.subscribeRegex : prevErr.subscribeRegex));
        const mis = validateRegex(errsIn.missingModelRegex !== undefined ? errsIn.missingModelRegex : (r.missingModelRegex !== undefined ? r.missingModelRegex : prevErr.missingModelRegex));
        if (sub.error) errors.push(sub.error);
        if (mis.error) errors.push(mis.error);
        if (sub.value || mis.value) out.errors = { subscribeRegex: sub.value || '', missingModelRegex: mis.value || '' };
    }

    // model
    const modelsRaw = r.models === undefined ? (prev && prev.models) : r.models;
    let models = uniq(parseList(modelsRaw));
    const bad = models.filter((m) => !isValidModelName(m));
    if (bad.length) errors.push('Tên model không hợp lệ: ' + bad.slice(0, 5).join(', ') + ' (chỉ gồm chữ, số, . _ - : /).');
    models = models.filter(isValidModelName);
    if (models.length > 200) errors.push('Tối đa 200 model.');

    let defaultModel = String(r.defaultModel == null ? (prev && prev.defaultModel) || '' : r.defaultModel).trim();
    if (!defaultModel && models.length) defaultModel = models[0];
    if (!isValidModelName(defaultModel)) errors.push('Model mặc định bắt buộc và hợp lệ.');
    else if (!models.includes(defaultModel)) models.unshift(defaultModel);
    out.models = models;
    out.defaultModel = defaultModel;

    const fbRaw = r.fallbackModels === undefined ? (prev && prev.fallbackModels) : r.fallbackModels;
    out.fallbackModels = uniq(parseList(fbRaw)).filter(isValidModelName);

    const flag = (v, d) => (v === undefined ? d : (v === true || v === 'true' || v === 'on' || v === '1' || v === 1));
    out.modelPerKey = out.builtin ? false : flag(r.modelPerKey, prev ? !!prev.modelPerKey : false);
    out.allowCustomModel = out.builtin ? false : flag(r.allowCustomModel, prev ? prev.allowCustomModel !== false : true);

    // gợi ý key
    out.keyPrefixes = uniq(parseList(r.keyPrefixes === undefined ? prev && prev.keyPrefixes : r.keyPrefixes)).map((s) => s.slice(0, 20)).slice(0, 5);
    out.keyPlaceholder = String(r.keyPlaceholder == null ? (prev && prev.keyPlaceholder) || '' : r.keyPlaceholder).trim().slice(0, 40);

    if (prev && prev.jsVars) out.jsVars = prev.jsVars;
    out.createdAt = (prev && prev.createdAt) || new Date().toISOString();
    // Chỉ đổi mốc "cập nhật" khi người dùng thật sự lưu (r.touch); nạp/chuẩn hoá lại thì giữ nguyên
    out.updatedAt = r.touch ? new Date().toISOString() : ((prev && prev.updatedAt) || out.createdAt);
    if (r.updatedBy || (prev && prev.updatedBy)) out.updatedBy = String(r.updatedBy || prev.updatedBy).slice(0, 100);

    return errors.length ? { errors } : { value: out, errors: [] };
}

/** Chuẩn hoá cả tài liệu; nhà cung cấp hỏng bị bỏ qua (kèm cảnh báo); luôn có 'gemini'. */
function sanitizeDocument(doc) {
    const seedGemini = seed.seedProviders().find((p) => p.id === 'gemini');
    const out = { version: 1, updatedAt: (doc && doc.updatedAt) || new Date().toISOString(), note: (doc && doc.note) || seed.buildSeedDocument().note, providers: [] };
    const seen = new Set();
    const list = doc && Array.isArray(doc.providers) ? doc.providers : [];

    for (const raw of list) {
        if (!isPlainObject(raw)) continue;
        const id = String(raw.id || '').trim().toLowerCase();
        if (!id || seen.has(id)) continue;
        const isGemini = id === 'gemini';
        // Dùng chính dữ liệu đã lưu làm "prev" để giữ id/kind/builtin/aliases, rồi kiểm tra lại từng trường
        const prev = {
            id,
            kind: isGemini ? 'gemini' : 'openai',
            builtin: isGemini,
            aliases: isGemini ? ['google'] : (Array.isArray(raw.aliases) ? raw.aliases.filter((a) => typeof a === 'string').slice(0, 5) : []),
            jsVars: isPlainObject(raw.jsVars) ? raw.jsVars : undefined,
            createdAt: raw.createdAt,
            updatedAt: raw.updatedAt,
            updatedBy: raw.updatedBy,
            enabled: raw.enabled !== false
        };
        const r = normalizeProviderInput(raw, prev);
        if (!r.value) {
            console.warn(`⚠️ [aiProviderService] bỏ qua nhà cung cấp "${id}" trong ${AI_DB_PATH}: ${r.errors.join(' | ')}`);
            continue;
        }
        seen.add(id);
        out.providers.push(r.value);
    }

    if (!seen.has('gemini')) {
        console.warn(`⚠️ [aiProviderService] ${AI_DB_PATH} thiếu "gemini" → dùng bản mặc định.`);
        out.providers.unshift(seedGemini);
    }
    return out;
}

// ------------------------------------------------------------
// Truy cập đồng bộ (đọc từ RAM)
// ------------------------------------------------------------
function ensureInit() {
    if (!state.doc) state.doc = sanitizeDocument(seed.buildSeedDocument());
}

function listProviders({ includeDisabled = false } = {}) {
    ensureInit();
    return state.doc.providers.filter((p) => includeDisabled || p.enabled !== false);
}

/** 'google' / 'GEMINI' / id lạ / null → id nhà cung cấp hợp lệ (mặc định 'gemini'). */
function resolveProviderId(raw) {
    ensureInit();
    const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!s) return 'gemini';
    for (const p of state.doc.providers) {
        if (p.id === s || (p.aliases || []).includes(s)) return p.id;
    }
    return 'gemini';
}

/** Có đúng là nhà cung cấp đã đăng ký (kể cả alias)? */
function isKnownProvider(raw) {
    ensureInit();
    const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    return !!s && state.doc.providers.some((p) => p.id === s || (p.aliases || []).includes(s));
}

function getProvider(raw) {
    ensureInit();
    const id = resolveProviderId(raw);
    return state.doc.providers.find((p) => p.id === id) || state.doc.providers[0];
}

function getDocument() { ensureInit(); return clone(state.doc); }
function getStatus() {
    ensureInit();
    return { source: state.source, sha: state.sha, loadedAt: state.loadedAt, path: AI_DB_PATH, lastError: state.lastError, total: state.doc.providers.length };
}
function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }

function apply(doc, source, sha) {
    state.doc = sanitizeDocument(doc);
    state.source = source;
    state.sha = sha || null;
    state.loadedAt = Date.now();
    state.lastError = null;
    for (const fn of listeners) { try { fn(state.doc); } catch (e) { console.warn('[aiProviderService] listener lỗi:', e.message); } }
}

// Nạp mặc định ngay khi require → mọi hàm đồng bộ dùng được trước khi GitHub trả lời
apply(seed.buildSeedDocument(), 'seed', null);
state.loadedAt = 0;

// ------------------------------------------------------------
// Nạp từ GitHub
// ------------------------------------------------------------
async function load() {
    if (loading) return loading;
    loading = (async () => {
        try {
            if (!githubService.isConfigured) {
                apply(seed.buildSeedDocument(), 'seed', null);
                return state.doc;
            }
            const res = await githubService.readJsonFileWithSha(AI_DB_PATH);
            if (res && res.data) apply(res.data, 'github', res.sha);
            else apply(seed.buildSeedDocument(), 'seed', null);   // chưa migrate → mặc định
            return state.doc;
        } catch (e) {
            state.lastError = e.message;
            state.loadedAt = Date.now() - CACHE_TTL_MS + ERROR_RETRY_MS;   // thử lại sau ~15s, đang dùng bản RAM cũ
            console.warn(`⚠️ [aiProviderService] không đọc được ${AI_DB_PATH}: ${e.message} — dùng bản đang có (${state.source}).`);
            return state.doc;
        } finally {
            loading = null;
        }
    })();
    return loading;
}

/**
 * Đảm bảo dữ liệu mới:
 *   - lần đầu (hoặc force) → ĐỢI đọc xong;
 *   - sau đó quá TTL → trả ngay bản đang có, nạp lại nền (stale-while-revalidate).
 */
async function ensureFresh({ force = false } = {}) {
    const age = Date.now() - state.loadedAt;
    if (force || !state.loadedAt) return load();
    if (age > CACHE_TTL_MS) load().catch(() => {});
    return state.doc;
}

function middleware(req, res, next) {
    const p = req.path || '';
    // /api/node/* được web chính dò trực tiếp: không kéo theo GitHub/AI để health luôn nhanh.
    if (p.startsWith('/css') || p.startsWith('/js') || p.startsWith('/images') || p.startsWith('/webhooks') || p.startsWith('/api/node') || p === '/favicon.ico') return next();
    ensureFresh().then(() => next(), () => next());
}

// ------------------------------------------------------------
// Ghi lên GitHub (thêm / sửa / xoá nhà cung cấp)
// ------------------------------------------------------------
async function mutate(mutator, message) {
    if (!githubService.isConfigured) throw new Error('GitHub chưa cấu hình (GITHUB_TOKEN/OWNER/REPO) nên không lưu được danh sách nhà cung cấp AI.');
    let lastErr = null;
    for (let i = 0; i < 3; i++) {
        const cur = await githubService.readJsonFileWithSha(AI_DB_PATH);
        const base = sanitizeDocument(cur && cur.data ? cur.data : seed.buildSeedDocument());
        const next = await mutator(clone(base));
        next.version = 1;
        next.updatedAt = new Date().toISOString();
        const clean = sanitizeDocument(next);
        clean.updatedAt = next.updatedAt;
        try {
            const w = await githubService.writeJsonFileIfSha(AI_DB_PATH, clean, cur ? cur.sha : null, message);
            apply(clean, 'github', w.sha);
            return clean;
        } catch (e) {
            lastErr = e;
            if (e.code === 'SHA_CONFLICT' && i < 2) continue;
            throw e;
        }
    }
    throw lastErr;
}

/** Thêm mới (isNew) hoặc sửa 1 nhà cung cấp. Trả { provider } hoặc ném lỗi có .errors[] */
async function upsertProvider(input, { isNew = false, actor = '' } = {}) {
    let saved = null;
    const raw = Object.assign({}, input, { touch: true }, actor ? { updatedBy: actor } : {});
    await mutate((doc) => {
        const id = String(raw.id || '').trim().toLowerCase();
        const idx = doc.providers.findIndex((p) => p.id === id);
        if (isNew && idx !== -1) { const e = new Error(`Mã "${id}" đã tồn tại.`); e.errors = [e.message]; throw e; }
        if (!isNew && idx === -1) { const e = new Error('Không tìm thấy nhà cung cấp.'); e.errors = [e.message]; throw e; }
        const prev = isNew ? null : doc.providers[idx];
        const r = normalizeProviderInput(raw, prev);
        if (!r.value) { const e = new Error(r.errors[0]); e.errors = r.errors; throw e; }
        if (isNew) doc.providers.push(r.value); else doc.providers[idx] = r.value;
        saved = r.value;
        return doc;
    }, `${isNew ? 'Thêm' : 'Sửa'} nhà cung cấp AI: ${raw.id}`);
    return { provider: saved };
}

async function setEnabled(id, enabled, { actor = '' } = {}) {
    const pid = String(id || '').trim().toLowerCase();
    await mutate((doc) => {
        const p = doc.providers.find((x) => x.id === pid);
        if (!p) { const e = new Error('Không tìm thấy nhà cung cấp.'); e.errors = [e.message]; throw e; }
        if (p.builtin) { const e = new Error('Gemini luôn bật, không thể tắt.'); e.errors = [e.message]; throw e; }
        p.enabled = !!enabled;
        p.updatedAt = new Date().toISOString();
        if (actor) p.updatedBy = String(actor).slice(0, 100);
        return doc;
    }, `${enabled ? 'Bật' : 'Tắt'} nhà cung cấp AI: ${pid}`);
}

async function deleteProvider(id) {
    const pid = String(id || '').trim().toLowerCase();
    await mutate((doc) => {
        const p = doc.providers.find((x) => x.id === pid);
        if (!p) { const e = new Error('Không tìm thấy nhà cung cấp.'); e.errors = [e.message]; throw e; }
        if (p.builtin) { const e = new Error('Không thể xoá Gemini (nhà cung cấp mặc định).'); e.errors = [e.message]; throw e; }
        doc.providers = doc.providers.filter((x) => x.id !== pid);
        return doc;
    }, `Xoá nhà cung cấp AI: ${pid}`);
}

module.exports = {
    AI_DB_PATH,
    // đọc đồng bộ (RAM)
    listProviders,
    getProvider,
    resolveProviderId,
    isKnownProvider,
    getDocument,
    getStatus,
    onChange,
    // nạp / middleware
    ensureFresh,
    middleware,
    // ghi
    upsertProvider,
    setEnabled,
    deleteProvider,
    // dùng cho migrate script + kiểm tra
    sanitizeDocument,
    normalizeProviderInput,
    validateBaseUrl,
    isValidModelName
};
