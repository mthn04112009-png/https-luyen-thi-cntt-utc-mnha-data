// config/videoConfig.js
// ============================================================
// Hằng số cho ỨNG DỤNG VIDEO BÀI GIẢNG (/videos) — lưu TRÊN GITHUB (repo CHÍNH, chỉ JSON):
//   subjects/<slug-môn>/videos/<slug-bài>_<unix>.json
// Mỗi "bài video" chứa NHIỀU video; mã nhúng <iframe> của từng video được MÃ HOÁ 2 CHIỀU
// (AES-256-GCM, services/videoCryptoService.js) nên mở JSON trên GitHub không thấy link video.
// ============================================================

const APP = {
    key: 'videos', dir: 'videos', base: '/videos', idKey: 'videoId',
    name: 'Video bài giảng', noun: 'bài video',
    description: 'Xem video bài giảng (YouTube, Vimeo, ok.ru, vk.com…) theo từng môn học; mỗi bài có thể gồm nhiều video.',
    icon: 'video'
};

const LIMITS = {
    MAX_VIDEOS: 50,            // số video tối đa trong 1 bài
    MAX_TITLE_LEN: 200,
    MAX_DESC_LEN: 1000,
    MAX_VIDEO_TITLE_LEN: 150,
    MAX_EMBED_LEN: 4000,       // độ dài tối đa của mã nhúng dán vào
    MAX_ENC_LEN: 8192          // độ dài tối đa của chuỗi đã mã hoá
};

// Cho nhúng MỌI nguồn (YouTube, Vimeo, ok.ru, vk.com, Drive…) miễn là https.
// Vẫn chặn ở videoEmbedService: đúng 1 thẻ iframe, không srcdoc / onload…, không user:pass@ trong URL.
// Nếu muốn chặn bớt host: biến môi trường VIDEO_BLOCK_HOSTS="host1.com,host2.com"
function blockedHosts() {
    return String(process.env.VIDEO_BLOCK_HOSTS || '').split(',')
        .map((x) => x.trim().toLowerCase()).filter((x) => /^[a-z0-9.-]+$/.test(x));
}

/** host có được phép nhúng không (mặc định: tất cả, trừ host bị chặn). */
function isAllowedSource(hostname) {
    const host = String(hostname || '').toLowerCase();
    if (!host || !host.includes('.')) return false;                 // chặn "localhost", tên nội bộ
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':')) return false;   // chặn IP trần (tránh gọi mạng nội bộ)
    return !blockedHosts().some((h) => host === h || host.endsWith('.' + h));
}

// Quyền cấp cho iframe (do web đặt, KHÔNG lấy từ mã nhúng của admin)
const IFRAME_ALLOW = 'accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen';
const IFRAME_REFERRER = 'strict-origin-when-cross-origin';

module.exports = { APP, LIMITS, isAllowedSource, IFRAME_ALLOW, IFRAME_REFERRER };
