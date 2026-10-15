// utils/aiLabel.js
// Nhãn hiển thị nhà cung cấp AI. Dữ liệu cũ không có provider => coi là Gemini.
//   gemini + "Key A" -> "Gemini: Key A"      (không có tên -> "Gemini")
//   vilao  + "Key B" -> "vilao.ai: Key B"    (không có tên -> "vilao.ai")
//   openai + "Key C" -> "ChatGPT (OpenAI): Key C"   (tên hiển thị lấy từ AI-database/index.json)
// Danh sách nhà cung cấp đọc từ JSON trên GitHub (xem config/aiModels.js, services/aiProviderService.js).

const { formatAiLabel, normalizeProvider, getProviderLabel } = require('../config/aiModels');

function providerName(provider) {
    return getProviderLabel(provider);
}

// Tương thích tên cũ (trước đây là object cố định {gemini, vilao}); nay đọc động từ registry
const PROVIDER_NAMES = new Proxy({}, {
    get: (_t, id) => (typeof id === 'string' ? getProviderLabel(id) : undefined),
    has: () => true
});

module.exports = { formatAiLabel, providerName, normalizeProvider, PROVIDER_NAMES };
