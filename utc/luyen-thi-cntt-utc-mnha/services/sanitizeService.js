/**
 * Làm sạch nội dung do user nhập trước khi đưa vào prompt cho AI.
 *
 * Mục tiêu:
 *  - Loại bỏ các mẫu "ignore previous instructions", "you are now...", v.v.
 *  - Cắt bớt nếu quá dài (tránh tốn token / lỗi context).
 *  - Escape các delimiter đặc biệt (```, <|...|>, ###).
 *  - Bọc nội dung trong delimiter rõ ràng để AI phân biệt.
 */

const MAX_ANSWER_LENGTH = 20000; // 20k ký tự

// Các pattern prompt injection phổ biến
const INJECTION_PATTERNS = [
    /ignore\s+(all\s+)?(previous|above|prior)\s+instructions?/gi,
    /disregard\s+(all\s+)?(previous|above|prior)\s+instructions?/gi,
    /forget\s+(all\s+)?(previous|above|prior)\s+instructions?/gi,
    /you\s+are\s+now\s+(a|an)?\s*\w+/gi,
    /new\s+instructions?:/gi,
    /system\s*prompt/gi,
    /<\|.*?\|>/g,                // <|im_start|> ... <|im_end|>
    /###\s*(instruction|system|assistant|user)/gi,
    /give\s+me\s+(a\s+)?(full|max|perfect)\s+(score|mark|point)/gi,
    /give\s+me\s+10\s*(score|point|mark)?/gi,
    /award\s+(full|max|perfect)\s+(score|mark|point)/gi
];

/**
 * Escape các delimiter có thể bị lợi dụng để "đóng" prompt.
 */
function escapeDelimiters(text) {
    return text
        .replace(/```/g, '` ` `')          // phá code fence
        .replace(/"""+/g, '"" ""')         // phá triple quote
        .replace(/<<<|>>>/g, '')           // bỏ <<< >>>
        .replace(/={4,}/g, '===')          // bỏ dấu = dài
        .replace(/-{4,}/g, '---');         // bỏ dấu - dài
}

/**
 * @param {string} raw - nội dung gốc
 * @param {object} opts
 * @param {number} [opts.maxLength] - độ dài tối đa (mặc định 20000)
 * @returns {string} nội dung đã làm sạch
 */
function sanitizeForAI(raw, opts = {}) {
    const maxLength = opts.maxLength || MAX_ANSWER_LENGTH;

    if (raw == null) return '';

    let text = String(raw);

    // Loại HTML tags nếu cần (nếu muốn giữ code thì bỏ dòng này)
    // text = text.replace(/<[^>]+>/g, ' ');

    // Chuẩn hoá Unicode để tránh homograph attack
    text = text.normalize('NFC');

    // Escape delimiter
    text = escapeDelimiters(text);

    // Loại bỏ các mẫu injection
    for (const pattern of INJECTION_PATTERNS) {
        text = text.replace(pattern, '[đã lọc]');
    }

    // Cắt độ dài
    if (text.length > maxLength) {
        text =
            text.slice(0, maxLength) +
            `\n\n[...đã cắt bớt ${text.length - maxLength} ký tự...]`;
    }

    return text.trim();
}

/**
 * Bọc nội dung user trong delimiter rõ ràng để AI phân biệt
 * giữa "hướng dẫn hệ thống" và "nội dung do user nhập".
 */
function wrapUserContent(label, content) {
    const clean = sanitizeForAI(content);
    return [
        `<<<BEGIN_${label}>>>`,
        clean,
        `<<<END_${label}>>>`
    ].join('\n');
}

// ============================================================
// ★ TRẮC NGHIỆM
// ============================================================

// sanitize-html (package.json: "sanitize-html"). Nếu thiếu package → FAIL CLOSED:
// escape toàn bộ HTML thay vì để HTML thô lọt qua.
let sanitizeHtmlLib = null;
try {
    sanitizeHtmlLib = require('sanitize-html');
} catch (_) {
    console.warn('⚠️ [sanitizeService] Chưa cài sanitize-html — giải thích sẽ bị escape toàn bộ. Chạy: npm i sanitize-html');
}

const EXPLANATION_ALLOWED_TAGS = [
    'b', 'i', 'u', 'strong', 'em', 'br', 'p', 'ul', 'ol', 'li',
    'code', 'pre', 'sub', 'sup', 'span', 'a',
    // bảng (câu hỏi chùm có bảng số liệu)
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption'
];

function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ------------------------------------------------------------
// ★ Chuẩn hoá đầu vào TRƯỚC khi sanitize (idempotent: lưu bao nhiêu lần cũng không đổi)
//   1. Gộp escape chồng (&amp;lt; → &lt;) do các lần lưu cũ để lại.
//   2. Khôi phục thẻ allowlist KHÔNG thuộc tính bị escape (&lt;code&gt;count&lt;/code&gt; → <code>count</code>).
//   3. Mọi dấu "<" còn lại KHÔNG mở một thẻ allowlist (VD "i<n", "<count>") → escape thành chữ thường,
//      để parser HTML không coi là thẻ rồi nuốt mất phần giải thích phía sau.
// ------------------------------------------------------------
const TAG_ALT = EXPLANATION_ALLOWED_TAGS.join('|');
const RE_STACKED_ESC = /&(?:amp;)+(lt|gt|quot|#0*39|#x0*27|amp);/gi;
const RE_ESCAPED_BARE_TAG = new RegExp('&lt;(/?)(' + TAG_ALT + ')(\\s*/?)&gt;', 'gi');
const RE_STRAY_LT = new RegExp('<(?!/?(?:' + TAG_ALT + ')(?=[\\s/>])[^<>]*>)', 'gi');

function normalizeExplanationInput(raw) {
    return String(raw)
        .replace(RE_STACKED_ESC, '&$1;')
        .replace(RE_ESCAPED_BARE_TAG, '<$1$2$3>')
        .replace(RE_STRAY_LT, '&lt;');
}

// Bộ làm sạch dự phòng (không cần package) — chỉ dùng khi thiếu sanitize-html.
// Giữ thẻ allowlist (bỏ mọi thuộc tính, trừ href https của <a> và colspan/rowspan của th/td),
// escape phần còn lại, tự đóng thẻ còn mở, bỏ thẻ đóng thừa.
const VOID_TAGS = new Set(['br']);
function fallbackSanitize(input) {
    const text = (t) => t.replace(/&(?!(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);)/gi, '&amp;').replace(/>/g, '&gt;');
    const re = /<(\/?)([a-z][a-z0-9]*)([^<>]*)>/gi;
    const stack = [];
    let out = '', last = 0, m;
    while ((m = re.exec(input))) {
        out += text(input.slice(last, m.index));
        last = re.lastIndex;
        const closing = m[1] === '/', name = m[2].toLowerCase(), attrs = m[3] || '';
        if (!EXPLANATION_ALLOWED_TAGS.includes(name)) continue; // thẻ lạ: bỏ thẻ, giữ chữ
        if (closing) {
            const at = stack.lastIndexOf(name);
            if (at === -1) continue;
            while (stack.length > at) out += '</' + stack.pop() + '>';
            continue;
        }
        if (VOID_TAGS.has(name)) { out += '<' + name + '>'; continue; }
        let extra = '';
        if (name === 'a') {
            const h = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
            const url = h ? (h[1] || h[2] || '').trim() : '';
            extra = ' href="' + (/^https:\/\//i.test(url) ? url.replace(/"/g, '&quot;') : '') + '" rel="noopener noreferrer" target="_blank"';
        } else if (name === 'th' || name === 'td') {
            ['colspan', 'rowspan'].forEach((k) => {
                const v = new RegExp(k + '\\s*=\\s*["\']?(\\d{1,2})', 'i').exec(attrs);
                if (v) extra += ' ' + k + '="' + v[1] + '"';
            });
        }
        out += '<' + name + extra + '>';
        stack.push(name);
    }
    out += text(input.slice(last));
    while (stack.length) out += '</' + stack.pop() + '>';
    return out;
}

/**
 * Làm sạch HTML giải thích (`++)`) của câu trắc nghiệm.
 * Gọi 2 lớp: khi LƯU đề và khi HIỂN THỊ. Chỉ sau hàm này mới được render bằng `!=`.
 * ★ Idempotent: <code>count</code> giữ nguyên là thẻ; "i<n" giữ nguyên là chữ; không escape chồng.
 */
function sanitizeExplanationHtml(raw, opts = {}) {
    if (raw == null || raw === '') return '';
    // Chùm có bảng thường dài hơn 3000 ký tự → gọi với { maxLength: MAX_CLUSTER_TEXT } (hoặc dùng sanitizeClusterHtml)
    const maxLength = opts.maxLength || 3000;
    const input = normalizeExplanationInput(String(raw).slice(0, maxLength));

    if (!sanitizeHtmlLib) return fallbackSanitize(input).trim();

    return sanitizeHtmlLib(input, {
        allowedTags: EXPLANATION_ALLOWED_TAGS,
        allowedAttributes: {
            a: ['href', 'rel', 'target'],
            span: [], // không cho style/class/on*
            th: ['colspan', 'rowspan'],
            td: ['colspan', 'rowspan']
        },
        allowedSchemes: ['https'],
        allowedSchemesAppliedToAttributes: ['href'],
        allowProtocolRelative: false,
        disallowedTagsMode: 'discard',
        transformTags: {
            a: (tagName, attribs) => ({
                tagName: 'a',
                attribs: { href: attribs.href || '', rel: 'noopener noreferrer', target: '_blank' }
            })
        }
    }).trim();
}

/**
 * Đưa HTML đã lưu về dạng DỄ SỬA trong ô nhập (form sửa đề):
 * &lt;code&gt; → <code>, "i&lt;n" → "i<n". Lưu lại sẽ được chuẩn hoá lại bởi sanitizeExplanationHtml.
 */
function htmlToEditable(html) {
    if (html == null) return html;
    return String(html)
        .replace(RE_STACKED_ESC, '&$1;')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#0*39;|&#x0*27;/gi, "'")
        .replace(/&amp;/gi, '&');
}

/**
 * Làm sạch nội dung CHÙM (có thể chứa bảng, dài hơn giải thích).
 * Cùng allowlist với giải thích (đã gồm table/thead/tbody/tr/th/td/caption).
 */
function sanitizeClusterHtml(raw, opts = {}) {
    return sanitizeExplanationHtml(raw, { maxLength: opts.maxLength || 10000 });
}

/**
 * Dữ liệu bài làm trắc nghiệm gửi cho AI. Đáp án gõ tự do (ô `fill`) là nơi
 * sinh viên có thể chèn lệnh → sanitize từng giá trị rồi bọc delimiter,
 * giống {bài_làm} của tự luận.
 *
 * @param {Array<{id:string, part:string, studentAnswer:any, correct:boolean}>} items
 */
function wrapQuizAnswers(items = []) {
    const lines = items.map((it) => {
        const ans = Array.isArray(it.studentAnswer)
            ? it.studentAnswer.join(', ')
            : (it.studentAnswer === null || it.studentAnswer === undefined || it.studentAnswer === ''
                ? '(bỏ trống)'
                : String(it.studentAnswer));
        const clean = sanitizeForAI(ans, { maxLength: 500 }) || '(bỏ trống)';
        return `${it.id} [${it.correct ? 'ĐÚNG' : 'SAI'}]: ${clean}`;
    });
    return [
        '<<<BEGIN_QUIZ_ANSWERS>>>',
        lines.join('\n'),
        '<<<END_QUIZ_ANSWERS>>>'
    ].join('\n');
}

module.exports = {
    sanitizeForAI,
    wrapUserContent,
    escapeDelimiters,
    // trắc nghiệm
    sanitizeExplanationHtml,
    sanitizeClusterHtml,
    htmlToEditable,
    wrapQuizAnswers,
    escapeHtml
};