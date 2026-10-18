// services/flashcardParserService.js
// ============================================================
// Chuyển văn bản nhập tay / do AI sinh ra  ⇄  danh sách flashcard.
//
//   +) từ ngoại ngữ            (học lý thuyết: câu hỏi)        — bắt buộc, bắt đầu một thẻ
//   https://raw.githubusercontent.com/...   ảnh (tuỳ chọn)      — một dòng chỉ chứa link, đặt ngay dưới "+)"
//   ++) phiên âm IPA           (chỉ học ngoại ngữ)              — tuỳ chọn, đặt trước "=>"
//   => nghĩa tiếng Việt        (học lý thuyết: câu trả lời)     — bắt buộc
//
// - Nội dung có thể kéo dài nhiều dòng: dòng không bắt đầu bằng "+)", "++)", "=>" được nối vào trường đang mở.
//   Dòng cần bắt đầu bằng đúng các ký hiệu đó thì thêm "\" ở đầu (serialize tự làm).
// - Dòng "//image: 2,5" (AI báo thẻ nên có ảnh) và rào ``` được loại bỏ; số thẻ gợi ý trả về ở imageHints.
// - Văn bản là THUẦN (không HTML): khi hiển thị luôn escape. "\n" (2 ký tự) hiển thị là xuống dòng.
// ============================================================
const cfg = require('../config/flashcardConfig');

const RE = {
    FRONT: /^\+\)/,
    IPA: /^\+\+\)/,
    BACK: /^=>/,
    IMAGE: /^https?:\/\/\S+$/,
    ESCAPED: /^\\(\+\+\)|\+\)|=>|https?:\/\/\S+$)/
};

function isImageUrl(line) {
    if (!RE.IMAGE.test(line)) return false;
    try {
        const u = new URL(line);
        return u.protocol === 'https:' && cfg.ALLOWED_IMAGE_HOSTS.includes(u.hostname);
    } catch (_) {
        return false;
    }
}

function stripFences(raw) {
    if (!raw) return { text: '', imageHints: [] };
    let s = String(raw).replace(/\r\n?/g, '\n').replace(/\s+$/, '');
    // rào ``` ở đầu / cuối (giữ số dòng bằng dòng trống)
    s = s.replace(/^\s*```[a-zA-Z]*[ \t]*(\n|$)/, (m) => m.replace(/[^\n]/g, ''));
    s = s.replace(/(\n)?[ \t]*```\s*$/, '');

    // dòng "//image: 2,5,9" — lấy gợi ý rồi xoá nội dung nhưng GIỮ dòng trống để số dòng báo lỗi đúng
    const imageHints = [];
    s = s.replace(/^[ \t]*\/\/[ \t]*image[ \t]*:(.*)$/gim, (m, list) => {
        String(list).split(/[,\s;]+/).forEach((n) => {
            const v = parseInt(n, 10);
            if (Number.isInteger(v) && v > 0 && !imageHints.includes(v)) imageHints.push(v);
        });
        return '';
    });

    // dấu ngoặc kép bao quanh cả khối
    const t = s.trim();
    if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
        s = t.slice(1, -1);
    }
    return { text: s, imageHints };
}

function cleanIpa(s) {
    let v = String(s || '').trim();
    // bỏ dấu / / hoặc [ ] bao quanh (AI hay thêm vào)
    const m = v.match(/^[/[]\s*(.*?)\s*[/\]]$/);
    if (m) v = m[1];
    return v.trim();
}

/**
 * @param {string} text  nội dung nhập
 * @param {'language'|'theory'} mode
 * @returns {{cards: object[], errors: {line:number,message:string}[], imageHints: number[]}}
 */
function parse(text, mode) {
    const isLang = mode !== 'theory';
    const { text: raw, imageHints } = stripFences(text);
    const errors = [];
    const cards = [];

    if (raw.length > cfg.LIMITS.MAX_RAW_LEN) {
        return { cards: [], errors: [{ line: 0, message: `Nội dung quá dài (tối đa ${cfg.LIMITS.MAX_RAW_LEN} ký tự).` }], imageHints };
    }

    let cur = null;
    let open = null;     // 'front' | 'ipa' | 'back'
    const err = (line, message) => errors.push({ line, message });

    const finish = () => {
        if (!cur) return;
        const where = `Thẻ bắt đầu ở dòng ${cur.line}`;
        if (!cur.front) err(cur.line, `${where}: thiếu nội dung sau "+)".`);
        else if (cur.back === null) err(cur.line, `${where}: thiếu dòng "=>" (${isLang ? 'nghĩa tiếng Việt' : 'câu trả lời'}).`);
        else if (!cur.back) err(cur.line, `${where}: nội dung sau "=>" đang trống.`);
        else {
            if (cur.front.length > cfg.LIMITS.MAX_FRONT_LEN) err(cur.line, `${where}: nội dung "+)" quá dài (tối đa ${cfg.LIMITS.MAX_FRONT_LEN} ký tự).`);
            if (cur.back.length > cfg.LIMITS.MAX_BACK_LEN) err(cur.line, `${where}: nội dung "=>" quá dài (tối đa ${cfg.LIMITS.MAX_BACK_LEN} ký tự).`);
            if (cur.ipa && cur.ipa.length > cfg.LIMITS.MAX_IPA_LEN) err(cur.line, `${where}: phiên âm quá dài (tối đa ${cfg.LIMITS.MAX_IPA_LEN} ký tự).`);
            cards.push({
                id: 'c' + (cards.length + 1),
                front: cur.front,
                back: cur.back,
                ipa: isLang && cur.ipa ? cleanIpa(cur.ipa) : '',
                image: cur.image || ''
            });
        }
        cur = null;
        open = null;
    };

    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const lineNo = i + 1;
        const trim = lines[i].trim();
        if (!trim) continue;

        // 1) dòng bắt đầu bằng "\" + ký hiệu → văn bản thường (đã escape)
        const esc = RE.ESCAPED.test(trim);
        const body = esc ? trim.slice(1) : trim;

        if (!esc && RE.IPA.test(trim)) {
            if (!cur) { err(lineNo, 'Dòng "++)" phải nằm ngay sau một dòng "+)".'); continue; }
            if (!isLang) { err(lineNo, 'Chế độ "Học lý thuyết" không dùng dòng "++)" (phiên âm). Hãy xoá dòng này.'); continue; }
            if (cur.back !== null) { err(lineNo, 'Dòng "++)" phải đặt TRƯỚC dòng "=>".'); continue; }
            if (cur.ipa !== null) { err(lineNo, 'Mỗi thẻ chỉ có một dòng "++)".'); continue; }
            cur.ipa = trim.slice(3).trim();
            open = 'ipa';
            continue;
        }

        if (!esc && RE.FRONT.test(trim)) {
            finish();
            cur = { line: lineNo, front: trim.slice(2).trim(), ipa: null, back: null, image: '' };
            open = 'front';
            continue;
        }

        if (!esc && RE.BACK.test(trim)) {
            if (!cur) { err(lineNo, 'Dòng "=>" phải nằm ngay sau một dòng "+)".'); continue; }
            if (cur.back !== null) { err(lineNo, 'Mỗi thẻ chỉ có một dòng "=>".'); continue; }
            cur.back = trim.slice(2).trim();
            open = 'back';
            continue;
        }

        // 2) dòng chỉ chứa link
        if (!esc && RE.IMAGE.test(trim)) {
            if (!cur) { err(lineNo, 'Link ảnh phải nằm dưới dòng "+)" của thẻ.'); continue; }
            if (isImageUrl(trim)) {
                if (cur.image) err(lineNo, 'Mỗi thẻ chỉ có một ảnh.');
                else cur.image = trim;
                continue;
            }
            if (open !== 'back') {
                err(lineNo, 'Link ảnh không hợp lệ: chỉ nhận ảnh tải lên bằng nút "Thêm ảnh" (raw.githubusercontent.com).');
                continue;
            }
            // trong phần trả lời: coi như văn bản thường
        }

        // 3) nối tiếp trường đang mở
        if (!cur) { err(lineNo, 'Dòng này nằm ngoài flashcard. Mỗi thẻ phải bắt đầu bằng "+)".'); continue; }
        if (open === 'front') cur.front += '\n' + body;
        else if (open === 'ipa') cur.ipa += ' ' + body;
        else cur.back += '\n' + body;
    }
    finish();

    if (!cards.length && !errors.length) errors.push({ line: 0, message: 'Chưa có flashcard nào. Mỗi thẻ gồm dòng "+)" và dòng "=>".' });
    if (cards.length > cfg.LIMITS.MAX_CARDS) {
        errors.push({ line: 0, message: `Tối đa ${cfg.LIMITS.MAX_CARDS} thẻ mỗi bộ (đang có ${cards.length}). Hãy tách thành nhiều bộ.` });
    }
    return { cards, errors, imageHints };
}

// ------------------------------------------------------------
// Ngược lại: danh sách thẻ → văn bản (đổ vào ô nhập khi SỬA)
// ------------------------------------------------------------
function escapeContinuation(text) {
    const lines = String(text == null ? '' : text).split('\n');
    return lines.map((l, i) => {
        if (i === 0) return l;
        const t = l.trim();
        return /^(\+\+\)|\+\)|=>|https?:\/\/\S+$)/.test(t) ? '\\' + t : l;
    }).join('\n');
}

function serialize(cards, mode) {
    const isLang = mode !== 'theory';
    return (cards || []).map((c) => {
        const out = ['+) ' + escapeContinuation(c.front)];
        if (c.image) out.push(c.image);
        if (isLang && c.ipa) out.push('++) ' + String(c.ipa).replace(/\n/g, ' '));
        out.push('=> ' + escapeContinuation(c.back));
        return out.join('\n');
    }).join('\n\n');
}

module.exports = { parse, serialize, stripFences, isImageUrl, cleanIpa };
