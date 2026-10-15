// ============================================================
// config/aiProviderSeed.js
// DỮ LIỆU MẶC ĐỊNH của các nhà cung cấp AI (chuyển từ config/aiModels.js + services/aiService.js).
// ------------------------------------------------------------
// - Nguồn THẬT của danh sách nhà cung cấp / API / biến API / model là file JSON trên GitHub:
//       AI-database/index.json
//   (đọc bởi services/aiProviderService.js; sửa trên web tại /admin/ai-keys/Supplier).
// - File này chỉ dùng cho 2 việc:
//     1. migrateMongoToGithub.js --only=aiproviders  → tạo AI-database/index.json lần đầu.
//     2. Dự phòng khi GitHub chưa có / không đọc được file trên → app vẫn chạy như cũ (Gemini + vilao.ai).
// - Giá trị `id` ('gemini', 'vilao') CHÍNH LÀ giá trị field `provider` của các key đang lưu trong MongoDB
//   → giữ nguyên để không phải sửa dữ liệu key cũ. 'google' là giá trị cũ của Gemini (alias).
// - Key API (đã mã hoá AES-256-GCM) KHÔNG nằm ở đây / trên GitHub: vẫn lưu trong MongoDB (collection aikeys).
// ============================================================

const GEMINI_MODELS = [
    // === Alias tự động trỏ model mới nhất (khuyên dùng) ===
    'gemini-flash-latest',
    'gemini-flash-lite-latest',
    'gemini-pro-latest',

    // === Gemini 3.x (mới nhất) ===
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3-flash',
    'gemini-3.1-pro',

    // === Gemini 2.5 (backup) ===
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-pro',

    // === Gemini 2.x (legacy) ===
    'gemini-2-flash',
    'gemini-2-flash-lite',

    // === Gemma (open-source model của Google) ===
    'gemma-4-31b-it',
    'gemma-4-26b-a4b-it'
];

// Model dự phòng khi model chính 503 (trước đây: FALLBACK_MODEL_CHAIN trong aiService.js)
const GEMINI_FALLBACK_MODELS = [
    'gemini-3.6-flash',
    'gemini-flash-lite-latest',
    'gemini-3.5-flash-lite',
    'gemini-flash-latest',
    'gemini-2-flash-lite'
];

// Danh sách model vilao.ai (OpenAI-compatible). Thứ tự: rẻ/nhẹ → mạnh/đắt.
const VILAO_MODELS = [
    'gpt-4o-mini',
    'gpt-4o',
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4.1-nano',
    'gpt-4-turbo',
    'gpt-3.5-turbo',
    'occ/claude-opus-5',
    'claude-3-5-sonnet',
    'claude-3-5-haiku',
    'claude-3-opus',
    'gemini-1.5-pro',
    'gemini-1.5-flash',
    'llama-3.1-70b',
    'llama-3.1-8b',
    'chib/deepseek-v4.1-flash'
];

const DEFAULT_SYSTEM_PROMPT =
    'Bạn là trợ lý AI chấm bài. Làm đúng theo yêu cầu và định dạng đầu ra ' +
    'được nêu trong tin nhắn của người dùng.';

function seedProviders() {
    return [
        {
            id: 'gemini',
            label: 'Gemini',
            description: 'Google Gemini (SDK @google/genai). Model chọn lúc chấm bài.',
            kind: 'gemini',
            builtin: true,
            enabled: true,
            aliases: ['google'],
            models: GEMINI_MODELS.slice(),
            defaultModel: 'gemini-flash-latest',
            fallbackModels: GEMINI_FALLBACK_MODELS.slice(),
            modelPerKey: false,
            allowCustomModel: false,
            keyPrefixes: ['AIza', 'AQ.'],
            keyPlaceholder: 'AIza...',
            // Tên biến cũ trong JS (để đối chiếu khi chuyển sang JSON)
            jsVars: {
                models: 'SUPPORTED_MODELS',
                defaultModel: 'DEFAULT_MODEL',
                fallbackModels: 'FALLBACK_MODEL_CHAIN'
            }
        },
        {
            id: 'vilao',
            label: 'vilao.ai',
            description: 'vilao.ai — API tương thích OpenAI. Mỗi key subscribe riêng từng model → model gắn trên key.',
            kind: 'openai',
            builtin: false,
            enabled: true,
            aliases: [],
            baseUrl: 'https://api.vilao.ai',
            chatPath: '/v1/chat/completions',
            authHeader: 'Authorization',
            authScheme: 'Bearer',
            maxTokens: 4096,
            systemPrompt: DEFAULT_SYSTEM_PROMPT,
            models: VILAO_MODELS.slice(),
            defaultModel: 'gpt-4o-mini',
            fallbackModels: [],
            modelPerKey: true,
            allowCustomModel: true,
            keyPrefixes: ['sk-'],
            keyPlaceholder: 'sk-...',
            errors: {
                subscribeRegex: 'subscribe\\s+to\\s+model',
                missingModelRegex: 'API\\s*Key\\s*:\\s*([A-Za-z0-9._\\-:]+)'
            },
            jsVars: {
                baseUrl: 'VILAO_BASE_URL',
                models: 'VILAO_MODELS',
                defaultModel: 'VILAO_DEFAULT_MODEL',
                maxTokens: 'VILAO_MAX_TOKENS'
            }
        }
    ];
}

function buildSeedDocument() {
    return {
        version: 1,
        updatedAt: new Date().toISOString(),
        note: 'Danh sách nhà cung cấp AI (API, biến API, model). Key API KHÔNG lưu ở đây — lưu mã hoá trong MongoDB (aikeys). Sửa tại /admin/ai-keys/Supplier.',
        providers: seedProviders()
    };
}

// Mẫu điền nhanh trên trang /admin/ai-keys/Supplier (người dùng tự kiểm tra lại với tài liệu nhà cung cấp)
const PROVIDER_TEMPLATES = [
    {
        templateId: 'openai',
        id: 'openai',
        label: 'ChatGPT (OpenAI)',
        kind: 'openai',
        baseUrl: 'https://api.openai.com',
        chatPath: '/v1/chat/completions',
        maxTokens: 4096,
        models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini'],
        defaultModel: 'gpt-4o-mini',
        modelPerKey: false,
        keyPrefixes: ['sk-'],
        keyPlaceholder: 'sk-...'
    },
    {
        templateId: 'deepseek',
        id: 'deepseek',
        label: 'DeepSeek',
        kind: 'openai',
        baseUrl: 'https://api.deepseek.com',
        chatPath: '/chat/completions',
        maxTokens: 4096,
        models: ['deepseek-chat', 'deepseek-reasoner'],
        defaultModel: 'deepseek-chat',
        modelPerKey: false,
        keyPrefixes: ['sk-'],
        keyPlaceholder: 'sk-...'
    },
    {
        templateId: 'openrouter',
        id: 'openrouter',
        label: 'OpenRouter',
        kind: 'openai',
        baseUrl: 'https://openrouter.ai',
        chatPath: '/api/v1/chat/completions',
        maxTokens: 4096,
        models: ['openai/gpt-4o-mini', 'deepseek/deepseek-chat'],
        defaultModel: 'openai/gpt-4o-mini',
        modelPerKey: false,
        keyPrefixes: ['sk-or-'],
        keyPlaceholder: 'sk-or-...'
    }
];

module.exports = {
    GEMINI_MODELS,
    GEMINI_FALLBACK_MODELS,
    VILAO_MODELS,
    DEFAULT_SYSTEM_PROMPT,
    seedProviders,
    buildSeedDocument,
    PROVIDER_TEMPLATES
};
