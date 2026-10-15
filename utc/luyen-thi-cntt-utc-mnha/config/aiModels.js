// ============================================================
// CONFIG - NHÀ CUNG CẤP AI + MODEL  (đọc từ AI-database/index.json trên GitHub)
// ------------------------------------------------------------
// Trước đây file này chứa cứng danh sách model Gemini / vilao.ai, địa chỉ API, max_tokens.
// Nay dữ liệu đó nằm ở JSON trên GitHub (xem services/aiProviderService.js, trang /admin/ai-keys/Supplier);
// file này chỉ còn LOGIC chọn model / nhãn / nhận diện lỗi, đọc dữ liệu từ registry.
//   - Chưa có AI-database/index.json (chưa chạy migrate) → dùng bản mặc định config/aiProviderSeed.js
//     → hành vi y hệt phiên bản cũ.
//   - Key API vẫn lấy từ MongoDB (collection aikeys); field `provider` của key = `id` nhà cung cấp.
//
// Provider:
//   kind 'gemini' → SDK @google/genai; model chọn lúc chấm bài (getSafeModel, DEFAULT_MODEL như cũ).
//   kind 'openai' → API tương thích OpenAI (vilao.ai, ChatGPT, DeepSeek…);
//                   modelPerKey = true  → model gắn trên key thắng (vilao.ai: mỗi key subscribe riêng từng model)
//                   modelPerKey = false → model chọn lúc chấm, thiếu thì lấy model trên key / mặc định.
//
// ⚠️ Các hằng SUPPORTED_MODELS / VILAO_MODELS / AI_PROVIDERS vẫn export để tương thích, và được CẬP NHẬT TẠI CHỖ
//    khi JSON đổi. Các hằng đơn (DEFAULT_MODEL, VILAO_BASE_URL…) chỉ là giá trị mặc định lúc khởi động
//    (đã lỗi thời nếu sửa trên web) → code mới dùng các hàm get*() bên dưới.
// ============================================================
const registry = require('../services/aiProviderService');
const seed = require('./aiProviderSeed');

const GEMINI_ID = 'gemini';

// ------------------------------------------------------------
// Hằng tương thích (mảng được cập nhật tại chỗ)
// ------------------------------------------------------------
const SUPPORTED_MODELS = [];     // model Gemini
const VILAO_MODELS = [];         // model vilao.ai
const AI_PROVIDERS = [];         // id + alias hợp lệ (giá trị field provider)

function replaceContents(arr, items) {
    arr.length = 0;
    for (const x of items) arr.push(x);
}

function syncCompat() {
    const g = registry.getProvider(GEMINI_ID);
    const v = registry.listProviders({ includeDisabled: true }).find((p) => p.id === 'vilao');
    replaceContents(SUPPORTED_MODELS, g ? g.models : []);
    replaceContents(VILAO_MODELS, v ? v.models : []);
    const ids = [];
    for (const p of registry.listProviders({ includeDisabled: true })) {
        ids.push(p.id);
        for (const a of p.aliases || []) ids.push(a);
    }
    replaceContents(AI_PROVIDERS, ids);
}
syncCompat();
registry.onChange(syncCompat);

// Giá trị mặc định lúc khởi động (lỗi thời nếu sửa trên web — dùng hàm get*() thay thế)
const _seedG = seed.seedProviders().find((p) => p.id === 'gemini');
const _seedV = seed.seedProviders().find((p) => p.id === 'vilao');
const DEFAULT_MODEL = _seedG.defaultModel;
const VILAO_BASE_URL = _seedV.baseUrl;
const VILAO_DEFAULT_MODEL = _seedV.defaultModel;
const VILAO_MAX_TOKENS = _seedV.maxTokens;

// ------------------------------------------------------------
// Truy cập nhà cung cấp
// ------------------------------------------------------------
const getProvider = (p) => registry.getProvider(p);
const listProviders = (opts) => registry.listProviders(opts);

// 'google' / id lạ / thiếu → 'gemini'; id đã đăng ký → chính nó
function normalizeProvider(provider) {
    return registry.resolveProviderId(provider);
}

function getProviderKind(provider) {
    return getProvider(provider).kind;
}

// Nhà cung cấp gọi bằng API kiểu OpenAI (vilao.ai, ChatGPT, DeepSeek…)
function isOpenAiProvider(provider) {
    return getProviderKind(provider) === 'openai';
}

// Giá trị provider có nằm trong danh sách nhà cung cấp đã đăng ký không (kể cả alias, kể cả đang tắt)
function isKnownProvider(provider) {
    return registry.isKnownProvider(provider);
}

// Có thể gán cho KEY MỚI: đã đăng ký và đang bật
function isValidProvider(provider) {
    if (typeof provider !== 'string' || !provider.trim()) return false;
    if (!registry.isKnownProvider(provider)) return false;
    return getProvider(provider).enabled !== false;
}

function getProviderLabel(provider) {
    return getProvider(provider).label || String(provider || 'Gemini');
}

function getModelsForProvider(provider) {
    return getProvider(provider).models.slice();
}

function getDefaultModelByProvider(provider) {
    return getProvider(provider).defaultModel;
}

// ------------------------------------------------------------
// GEMINI (giữ nguyên hành vi cũ)
// ------------------------------------------------------------
function isSupportedModel(model) {
    return typeof model === 'string' && getProvider(GEMINI_ID).models.includes(model);
}

function getDefaultGeminiModel() {
    return getProvider(GEMINI_ID).defaultModel;
}

function getSafeModel(model = null) {
    return isSupportedModel(model) ? model : getDefaultGeminiModel();
}

// Chuỗi model dự phòng khi 503 (trước đây FALLBACK_MODEL_CHAIN trong aiService.js)
function getFallbackModelChain(provider = GEMINI_ID) {
    const p = getProvider(provider);
    return (p.fallbackModels || []).filter((m) => p.models.includes(m));
}

// ------------------------------------------------------------
// Tên model do admin nhập (provider kiểu openai nhận tên tuỳ ý, chặn ký tự lạ)
// ------------------------------------------------------------
const MODEL_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._\-:\/]{0,99}$/;

function isValidModelName(model) {
    return typeof model === 'string' && MODEL_NAME_REGEX.test(model.trim());
}

// Tên model của Gemini gửi sang nhà cung cấp khác sẽ lỗi → coi là "ngoại lai"
// (trừ khi chính nhà cung cấp đó liệt kê model này)
function isForeignModel(provider, name) {
    return isSupportedModel(name) && !getProvider(provider).models.includes(name);
}

// ------------------------------------------------------------
// vilao.ai / provider kiểu OpenAI — tương thích tên hàm cũ
// ------------------------------------------------------------
function isSupportedVilaoModel(model) {
    const v = registry.listProviders({ includeDisabled: true }).find((p) => p.id === 'vilao');
    return typeof model === 'string' && !!v && v.models.includes(model);
}

function getSafeVilaoModel(model = null) {
    return getSafeModelByProvider('vilao', model);
}

// Làm sạch 1 tên model theo provider (không đụng DB).
//   gemini → y hệt getSafeModel
//   openai → tên hợp lệ bất kỳ (nếu provider cho phép allowCustomModel) hoặc phải nằm trong danh sách;
//            tên model Gemini / rỗng / sai định dạng → model mặc định của provider
function getSafeModelByProvider(provider, model = null) {
    const p = getProvider(provider);
    if (p.kind !== 'openai') return getSafeModel(model);
    if (!isValidModelName(model)) return p.defaultModel;
    const name = model.trim();
    if (isForeignModel(p.id, name)) return p.defaultModel;
    if (!p.allowCustomModel && !p.models.includes(name)) return p.defaultModel;
    return name;
}

// Chọn model cuối cùng từ document AIKey lấy từ MongoDB.
//   gemini                  : requestedModel → keyDoc.model → DEFAULT_MODEL   (giữ hành vi cũ)
//   openai + modelPerKey    : keyDoc.model → requestedModel → model mặc định   (vilao.ai)
//   openai (model lúc chấm) : requestedModel → keyDoc.model → model mặc định   (ChatGPT, DeepSeek…)
function resolveModelForKey(keyDoc, requestedModel = null) {
    const provider = normalizeProvider(keyDoc && keyDoc.provider);
    const p = getProvider(provider);
    const keyModel = keyDoc && keyDoc.model;

    if (p.kind === 'openai') {
        const keyOk = isValidModelName(keyModel) && !isForeignModel(p.id, keyModel.trim());
        if (p.modelPerKey) {
            if (keyOk) return keyModel.trim();
            return getSafeModelByProvider(p.id, requestedModel);
        }
        const wanted = isValidModelName(requestedModel) && !isForeignModel(p.id, requestedModel.trim());
        if (wanted) return getSafeModelByProvider(p.id, requestedModel);
        if (keyOk) return keyModel.trim();
        return p.defaultModel;
    }

    // Gemini: giữ nguyên
    if (isSupportedModel(requestedModel)) return requestedModel;
    if (isSupportedModel(keyModel)) return keyModel;
    return getDefaultGeminiModel();
}

// Một lần lấy đủ thông tin cần gọi + snapshot lưu Submission → { provider, model, keyName, label }
function resolveAiTarget(keyDoc, requestedModel = null) {
    const provider = normalizeProvider(keyDoc && keyDoc.provider);
    const keyName = keyDoc && typeof keyDoc.name === 'string' ? keyDoc.name : '';
    return {
        provider,
        model: resolveModelForKey(keyDoc, requestedModel),
        keyName,
        label: formatAiLabel(provider, keyName)
    };
}

// Danh sách model đổ vào dropdown, THEO KEY (key lấy từ MongoDB). Không có key → null.
function getModelOptionsForKey(keyDoc) {
    if (!keyDoc) return null;
    const provider = normalizeProvider(keyDoc.provider);
    const p = getProvider(provider);

    if (p.kind === 'openai') {
        const km = typeof keyDoc.model === 'string' ? keyDoc.model.trim() : '';
        if (p.modelPerKey && isValidModelName(km) && !isForeignModel(p.id, km)) {
            return { provider, models: [km], defaultModel: km, fixed: true };
        }
        return { provider, models: p.models.slice(), defaultModel: p.defaultModel, fixed: false };
    }
    return { provider, models: p.models.slice(), defaultModel: p.defaultModel, fixed: false };
}

// ------------------------------------------------------------
// Nhận diện lỗi "chưa subscribe model" (cấu hình theo từng nhà cung cấp: errors.subscribeRegex)
//   vilao.ai: 403 "Please subscribe to model in the API Key: gpt-4o"
// ------------------------------------------------------------
function isSubscribeError(provider, statusCode, errorMessage) {
    const p = getProvider(provider);
    const src = p.errors && p.errors.subscribeRegex;
    if (!src) return false;
    if (Number(statusCode) !== 403) return false;
    if (typeof errorMessage !== 'string') return false;
    try { return new RegExp(src, 'i').test(errorMessage); } catch (_) { return false; }
}

function extractMissingModel(provider, errorMessage) {
    const p = getProvider(provider);
    const src = p.errors && p.errors.missingModelRegex;
    if (!src || typeof errorMessage !== 'string') return null;
    try {
        const m = errorMessage.match(new RegExp(src, 'i'));
        return m && m[1] ? m[1] : null;
    } catch (_) { return null; }
}

// Tên cũ (chỉ cho vilao.ai) — giữ để tương thích
function isVilaoSubscribeError(statusCode, errorMessage) {
    return isSubscribeError('vilao', statusCode, errorMessage);
}
function extractVilaoMissingModel(errorMessage) {
    return extractMissingModel('vilao', errorMessage);
}

// ------------------------------------------------------------
// Nhãn hiển thị:  "{Tên nhà cung cấp}: {tên key}"  (không có tên key → chỉ tên nhà cung cấp)
// ⚠️ Nhãn làm lộ TÊN KEY cho sinh viên → đặt tên key không chứa thông tin nhạy cảm.
// ------------------------------------------------------------
function formatAiLabel(provider, keyName) {
    const base = getProviderLabel(provider);
    const name = typeof keyName === 'string' ? keyName.trim() : '';
    return name ? `${base}: ${name}` : base;
}

// ------------------------------------------------------------
// Dữ liệu công khai cho trình duyệt (form chọn nhà cung cấp / model). Không chứa bí mật.
// ------------------------------------------------------------
function getProvidersForClient({ includeDisabled = false } = {}) {
    return listProviders({ includeDisabled }).map((p) => ({
        id: p.id,
        label: p.label,
        kind: p.kind,
        enabled: p.enabled !== false,
        models: p.models.slice(),
        defaultModel: p.defaultModel,
        modelPerKey: !!p.modelPerKey,
        allowCustomModel: !!p.allowCustomModel,
        keyPrefixes: (p.keyPrefixes || []).slice(),
        keyPlaceholder: p.keyPlaceholder || ''
    }));
}

module.exports = {
    // Gemini (giữ nguyên tên)
    SUPPORTED_MODELS,
    DEFAULT_MODEL,
    isSupportedModel,
    getSafeModel,
    getDefaultGeminiModel,
    getFallbackModelChain,

    // vilao.ai (giữ nguyên tên — tương thích)
    VILAO_BASE_URL,
    VILAO_MODELS,
    VILAO_DEFAULT_MODEL,
    VILAO_MAX_TOKENS,
    isSupportedVilaoModel,
    getSafeVilaoModel,
    isVilaoSubscribeError,
    extractVilaoMissingModel,

    // Nhà cung cấp (đọc từ JSON)
    AI_PROVIDERS,
    getProvider,
    listProviders,
    getProviderKind,
    getProviderLabel,
    isOpenAiProvider,
    isValidProvider,
    isKnownProvider,
    normalizeProvider,
    getModelsForProvider,
    getProvidersForClient,
    isSubscribeError,
    extractMissingModel,
    formatAiLabel,

    // Chọn model theo provider (model lấy từ AIKey trong MongoDB)
    isValidModelName,
    getDefaultModelByProvider,
    getSafeModelByProvider,
    resolveModelForKey,
    resolveAiTarget,
    getModelOptionsForKey
};
