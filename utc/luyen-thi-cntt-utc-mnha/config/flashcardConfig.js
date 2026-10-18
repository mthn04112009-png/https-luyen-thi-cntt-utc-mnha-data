// config/flashcardConfig.js
// ============================================================
// Hằng số cho ỨNG DỤNG FLASHCARD (/flashcards). KHÔNG đặt trong .env.
//
// Lưu trữ: GitHub  subjects/<slug-môn>/flashcards/<slug-flashcard>_<unix>.json
// Có 2 chế độ học:
//   - 'language' (học ngoại ngữ): có phiên âm (IPA), nút NGHE + ĐỌC (Web Speech API của trình duyệt),
//     chọn được 1 ngôn ngữ cho cả bộ thẻ (giống chọn 1 AI cho 1 bài).
//   - 'theory'  (học lý thuyết): câu hỏi → câu trả lời; KHÔNG có phiên âm, KHÔNG có nghe/đọc.
//
// Định dạng nhập nội dung (giống cách nhập bài trắc nghiệm):
//   +) từ ngoại ngữ            (học lý thuyết: câu hỏi)
//   <link ảnh raw.githubusercontent.com — tuỳ chọn, ngay dưới dòng +)>
//   ++) phiên âm IPA           (chỉ học ngoại ngữ; bỏ dòng này nếu không có)
//   => nghĩa tiếng Việt        (học lý thuyết: câu trả lời)
// ============================================================

const MODES = ['language', 'theory'];

const MODE_LABEL = {
    language: 'Học ngoại ngữ',
    theory: 'Học lý thuyết'
};

const MODE_HINT = {
    language: 'Từ/câu ngoại ngữ + phiên âm + nghĩa tiếng Việt. Có nút Nghe và Đọc.',
    theory: 'Câu hỏi + câu trả lời. Không có phiên âm, không có Nghe/Đọc.'
};

// Ngôn ngữ cho nút Nghe / Đọc (mã BCP-47 của Web Speech API). Chọn 1 ngôn ngữ cho cả bộ thẻ.
const LANGUAGES = [
    { code: 'en-US', label: 'Tiếng Anh (Mỹ)', name: 'English (US)' },
    { code: 'en-GB', label: 'Tiếng Anh (Anh)', name: 'English (UK)' },
    { code: 'zh-CN', label: 'Tiếng Trung (phổ thông)', name: 'Chinese (Mandarin)' },
    { code: 'ja-JP', label: 'Tiếng Nhật', name: 'Japanese' },
    { code: 'ko-KR', label: 'Tiếng Hàn', name: 'Korean' },
    { code: 'fr-FR', label: 'Tiếng Pháp', name: 'French' },
    { code: 'de-DE', label: 'Tiếng Đức', name: 'German' },
    { code: 'es-ES', label: 'Tiếng Tây Ban Nha', name: 'Spanish' },
    { code: 'it-IT', label: 'Tiếng Ý', name: 'Italian' },
    { code: 'pt-BR', label: 'Tiếng Bồ Đào Nha (Brazil)', name: 'Portuguese (Brazil)' },
    { code: 'ru-RU', label: 'Tiếng Nga', name: 'Russian' },
    { code: 'th-TH', label: 'Tiếng Thái', name: 'Thai' }
];
const DEFAULT_LANGUAGE = 'en-US';
const LANGUAGE_CODES = LANGUAGES.map((l) => l.code);

const LIMITS = {
    MAX_CARDS: 500,
    MAX_FRONT_LEN: 600,
    MAX_BACK_LEN: 2000,
    MAX_IPA_LEN: 120,
    MAX_TITLE_LEN: 200,
    MAX_DESC_LEN: 1000,
    MAX_RAW_LEN: 200000
};

// Ảnh chỉ nhận link do chính hệ thống tạo (upload → kiểm duyệt Cloudinary → GitHub cache/image/…)
const ALLOWED_IMAGE_HOSTS = ['raw.githubusercontent.com'];

// ------------------------------------------------------------
// PROMPT MẪU — dán vào AI (ChatGPT, Gemini…) cùng nội dung thô để AI chuyển thành định dạng flashcard.
// {LANG} được thay bằng tên ngôn ngữ đang chọn (chỉ chế độ học ngoại ngữ).
// ------------------------------------------------------------
const PROMPT_LANGUAGE = `Bạn là trợ lý tạo FLASHCARD học ngoại ngữ ({LANG}). Hãy chuyển nội dung tôi gửi bên dưới (danh sách từ vựng, đoạn văn, bài học, ghi chú…) thành các flashcard theo ĐÚNG định dạng sau và CHỈ trả về một khối văn bản thuần (không giải thích thêm, không markdown, không đánh số):

+) từ / cụm từ / câu bằng {LANG}
++) phiên âm (IPA hoặc cách đọc: pinyin, romaji, romanja…; nếu không có thì BỎ dòng này)
=> nghĩa tiếng Việt

QUY TẮC:
1. Mỗi flashcard là một khối liên tiếp: dòng "+)" trước, dòng "++)" tiếp theo (nếu có), dòng "=>" cuối cùng. Các flashcard cách nhau bằng một dòng trống.
2. Dòng "+)" chỉ chứa nội dung {LANG}; dòng "=>" chỉ chứa nghĩa tiếng Việt ngắn gọn, chính xác theo ngữ cảnh. Không thêm số thứ tự, không thêm dấu * hay - đầu dòng.
3. Phiên âm viết thuần, KHÔNG bọc trong dấu gạch chéo (ví dụ: ədˈmaɪə chứ không phải /ədˈmaɪə/).
4. Giữ nguyên chính tả/dấu của từ gốc; không tự bịa thêm từ ngoài nội dung được gửi. Nếu nội dung gốc đã có nghĩa, giữ nghĩa đó.
5. Nếu cụm từ/câu quá dài thì giữ nguyên trên một dòng; không tự xuống dòng giữa chừng.
6. Nếu có thẻ nào nên có ảnh minh hoạ (đồ vật, con vật, địa điểm…), ghi số thứ tự của các thẻ đó ở DÒNG CUỐI CÙNG theo dạng: //image: 2,5,9 (không có thẻ nào cần ảnh thì KHÔNG viết dòng này). Không tự bịa link ảnh.
7. Chỉ trả về đúng khối flashcard, không có lời dẫn.

VÍ DỤ:
+) admire
++) ədˈmaɪə
=> ngưỡng mộ

+) The hero made a great sacrifice for his country.
=> Vị anh hùng đã hy sinh to lớn cho đất nước.

NỘI DUNG CẦN CHUYỂN:
(dán nội dung của bạn vào đây)`;

const PROMPT_THEORY = `Bạn là trợ lý tạo FLASHCARD học LÝ THUYẾT. Hãy chuyển nội dung tôi gửi bên dưới (giáo trình, bài giảng, ghi chú, đề cương…) thành các flashcard dạng CÂU HỎI → CÂU TRẢ LỜI theo ĐÚNG định dạng sau và CHỈ trả về một khối văn bản thuần (không giải thích thêm, không markdown, không đánh số):

+) câu hỏi
=> câu trả lời

QUY TẮC:
1. Mỗi flashcard là một khối gồm dòng "+)" rồi dòng "=>" ngay sau. Các flashcard cách nhau bằng một dòng trống. KHÔNG dùng dòng "++)".
2. Mỗi thẻ chỉ hỏi MỘT ý. Câu hỏi rõ nghĩa, tự đứng được (không viết "ở trên", "đoạn trước").
3. Câu trả lời ngắn gọn, đúng trọng tâm (ưu tiên 1–2 câu hoặc một cụm từ/định nghĩa). Nếu đáp án là một con số/thuật ngữ ngắn thì chỉ ghi đúng con số/thuật ngữ đó.
4. Chỉ dùng thông tin có trong nội dung được gửi; không tự bịa thêm kiến thức.
5. Công thức toán (CHỈ khi thật sự cần): nhúng tự nhiên trong câu, công thức trong dòng đặt giữa $...$, công thức đứng riêng đặt giữa $$...$$. Muốn xuống dòng thì gõ đúng hai ký tự \\n (dấu gạch chéo ngược + chữ n) rồi viết tiếp. Không cần công thức thì viết chữ bình thường. Ký hiệu tiền tệ "$" viết là \\$.
6. Nếu có thẻ nào nên có ảnh minh hoạ (sơ đồ, hình vẽ…), ghi số thứ tự các thẻ đó ở DÒNG CUỐI CÙNG theo dạng: //image: 3,7 (không có thì KHÔNG viết dòng này). Không tự bịa link ảnh.
7. Chỉ trả về đúng khối flashcard, không có lời dẫn.

VÍ DỤ:
+) Độ phức tạp thời gian của tìm kiếm nhị phân là gì?
=> O(log n)

+) Giải phương trình $x^2-5x+6=0$.
=> x = 2 hoặc x = 3

NỘI DUNG CẦN CHUYỂN:
(dán nội dung của bạn vào đây)`;

function languageName(code) {
    const l = LANGUAGES.find((x) => x.code === code);
    return l ? l.label : code;
}

/** Prompt theo chế độ (và ngôn ngữ nếu học ngoại ngữ). */
function buildPrompt(mode, langCode) {
    if (mode === 'theory') return PROMPT_THEORY;
    const name = (LANGUAGES.find((x) => x.code === langCode) || LANGUAGES[0]).label.replace(/^Tiếng /, '');
    return PROMPT_LANGUAGE.replace(/\{LANG\}/g, name);
}

module.exports = {
    MODES,
    MODE_LABEL,
    MODE_HINT,
    LANGUAGES,
    LANGUAGE_CODES,
    DEFAULT_LANGUAGE,
    LIMITS,
    ALLOWED_IMAGE_HOSTS,
    PROMPT_LANGUAGE,
    PROMPT_THEORY,
    languageName,
    buildPrompt
};
