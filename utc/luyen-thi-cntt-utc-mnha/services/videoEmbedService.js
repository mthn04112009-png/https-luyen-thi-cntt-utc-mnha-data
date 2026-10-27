// ============================================================
// videoEmbedService — đọc + KIỂM TRA mã nhúng <iframe> do admin dán vào
// ------------------------------------------------------------
// Chấp nhận ĐÚNG 1 thẻ <iframe> (không chữ/thẻ nào khác bên ngoài), src https (mọi nguồn, trừ host bị chặn trong config/videoConfig.js). Trả { ok, src, ratio, title }; web tự dựng lại thẻ iframe với thuộc tính do web đặt
// (không bao giờ in nguyên văn HTML của admin) và tự co giãn theo tỉ lệ width/height của mã nhúng.
// ============================================================
const cfg = require('../config/videoConfig');

function decodeEntities(s) {
    return String(s || '')
        .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#0*39;/g, "'").replace(/&apos;/gi, "'")
        .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

/** Đọc các thuộc tính của thẻ mở <iframe ...> (hỗ trợ "…", '…' hoặc không nháy). */
function readAttrs(openTag) {
    const out = {};
    const body = openTag.replace(/^<iframe\b/i, '').replace(/\/?>$/, '');
    const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let m;
    while ((m = re.exec(body))) {
        const k = m[1].toLowerCase();
        if (!(k in out)) out[k] = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : ''));
    }
    return out;
}

function parseEmbed(code) {
    if (typeof code !== 'string') return { ok: false, error: 'Mã nhúng không hợp lệ.' };
    const text = code.trim();
    if (!text) return { ok: false, error: 'Vui lòng dán mã nhúng <iframe>.' };
    if (text.length > cfg.LIMITS.MAX_EMBED_LEN) return { ok: false, error: `Mã nhúng quá dài (tối đa ${cfg.LIMITS.MAX_EMBED_LEN} ký tự).` };

    // phải là đúng 1 thẻ iframe và KHÔNG có gì khác bên ngoài
    const tags = text.match(/<iframe\b/gi) || [];
    if (tags.length > 1) return { ok: false, error: 'Mỗi video chỉ dán 1 mã nhúng <iframe>. Muốn thêm video khác, bấm "Thêm video".' };
    const m = /^<iframe\b((?:"[^"]*"|'[^']*'|[^>"'])*)>\s*(?:<\/iframe\s*>)?$/i.exec(text);
    if (!m) return { ok: false, error: 'Mã nhúng phải là đúng 1 thẻ <iframe …></iframe> (copy nguyên từ Chia sẻ → Nhúng).' };
    const attrs = readAttrs('<iframe' + m[1]);

    for (const k of Object.keys(attrs)) {
        if (/^on/i.test(k)) return { ok: false, error: 'Mã nhúng chứa thuộc tính sự kiện (onload…) — không được phép.' };
    }
    if (!attrs.src) return { ok: false, error: 'Mã nhúng thiếu thuộc tính src.' };
    if (attrs.srcdoc !== undefined) return { ok: false, error: 'Mã nhúng chứa srcdoc — không được phép.' };

    let src = decodeEntities(attrs.src).trim();
    if (src.startsWith('//')) src = 'https:' + src;
    let u;
    try { u = new URL(src); } catch (_) { return { ok: false, error: 'Đường dẫn src trong mã nhúng không hợp lệ.' }; }
    if (u.protocol !== 'https:') return { ok: false, error: 'Chỉ nhận mã nhúng dùng https.' };
    if (u.username || u.password) return { ok: false, error: 'Đường dẫn src không hợp lệ.' };
    if (!cfg.isAllowedSource(u.hostname)) {
        return { ok: false, error: 'Nguồn video không hợp lệ (cần địa chỉ web https, không phải IP hay tên nội bộ).' };
    }
    // bỏ autoplay (nhiều video xếp dọc không được tự phát cùng lúc); giữ các tham số khác (start, list, h…)
    u.searchParams.delete('autoplay');
    u.hash = '';

    // tỉ lệ khung hình từ width/height (mặc định 16:9)
    let ratio = 16 / 9;
    const w = parseFloat(attrs.width), h = parseFloat(attrs.height);
    if (w > 0 && h > 0 && isFinite(w) && isFinite(h)) {
        const r = w / h;
        if (r >= 0.4 && r <= 3.5) ratio = r;
    }
    const title = decodeEntities(attrs.title || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, cfg.LIMITS.MAX_VIDEO_TITLE_LEN);
    return { ok: true, src: u.toString(), ratio: Math.round(ratio * 10000) / 10000, title };
}

module.exports = { parseEmbed };
