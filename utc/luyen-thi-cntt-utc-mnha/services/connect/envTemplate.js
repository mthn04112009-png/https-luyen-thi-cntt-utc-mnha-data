// services/connect/envTemplate.js — mẫu .env dùng CHUNG cho web chính + mọi web dữ liệu.
//
//   Các biến bí mật (token, khoá mã hoá, Mongo URI) phải GIỐNG HỆT nhau ở mọi web
//   thì khoá kết nối / dữ liệu mã hoá mới đọc được. Chỉ 4 biến
//   DATA_NODE / NODE_ID / NODE_URL / NODE_NAME là khác nhau giữa các web.
'use strict';

const SECRETS = [
    'MONGODB_URI',
    'SESSION_SECRET',
    'SESSION_ENC_KEY',
    'ENCRYPTION_MASTER_KEY',
    'CONNECT_ENC_KEY',
    'GITHUB_TOKEN',
    'GITHUB_WEBHOOK_SECRET',
    'JWT_SECRET',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET',
    'MAIL_PASS'
];

function current(name, fallback = '') {
    const v = process.env[name];
    return v == null ? fallback : String(v);
}

/**
 * @param {{id?:string,url?:string,name?:string,dataNode?:boolean,showSecrets?:boolean}} o
 * @returns {string} nội dung .env
 */
function envTemplate(o = {}) {
    const id = o.id || 'luyen-thi-cntt-data-1';
    const url = o.url || 'https://' + id + '.vercel.app';
    const name = o.name || id;
    const dataNode = o.dataNode !== false;
    const secret = (k, fallback) => (o.showSecrets ? (current(k) || fallback) : fallback);

    const lines = [
        '# ============================================================',
        '# LUYỆN THI CNTT UTC — .env DÙNG CHUNG (web chính + web dữ liệu)',
        '# ------------------------------------------------------------',
        '# • Các dòng BÍ MẬT bên dưới phải GIỐNG HỆT nhau ở mọi Vercel project.',
        '# • Mỗi web dữ liệu chỉ đổi DATA_NODE / NODE_ID / NODE_URL / NODE_NAME.',
        '# • Trên web chính để DATA_NODE=off (hoặc bỏ trống).',
        '# ============================================================',
        '',
        '# --- Chế độ ---',
        `DATA_NODE=${dataNode ? 'on' : 'off'}`,
        `NODE_ID=${id}`,
        `NODE_URL=${url}`,
        `NODE_NAME=${name}`,
        'NODE_ENV=production',
        'TZ=Asia/Ho_Chi_Minh',
        '',
        '# --- Database dùng chung ---',
        `MONGODB_URI=${secret('MONGODB_URI', 'mongodb+srv://...')}`,
        '',
        '# --- Phiên đăng nhập + mã hoá (GIỐNG HỆT mọi web) ---',
        `SESSION_SECRET=${secret('SESSION_SECRET', 'chuoi-bi-mat-cho-session')}`,
        `SESSION_ENC_KEY=${secret('SESSION_ENC_KEY', 'khoa-32-ky-tu-tro-len-de-ma-hoa-session')}`,
        `ENCRYPTION_MASTER_KEY=${secret('ENCRYPTION_MASTER_KEY', 'khoa-hex-64-ky-tu-de-ma-hoa-du-lieu')}`,
        `CONNECT_ENC_KEY=${secret('CONNECT_ENC_KEY', 'khoa-32-ky-tu-tro-len-de-ma-hoa-khoa-ket-noi')}`,
        `JWT_SECRET=${secret('JWT_SECRET', 'chuoi-bi-mat-cho-jwt')}`,
        '',
        '# --- GitHub repo chính (GIỐNG HỆT mọi web) ---',
        `GITHUB_TOKEN=${secret('GITHUB_TOKEN', 'ghp_...')}`,
        `GITHUB_OWNER=${current('GITHUB_OWNER', 'your-account')}`,
        `GITHUB_REPO=${current('GITHUB_REPO', 'luyen-thi-cntt-utc-mnha-database')}`,
        `GITHUB_BRANCH=${current('GITHUB_BRANCH', 'main')}`,
        `GITHUB_WEBHOOK_SECRET=${secret('GITHUB_WEBHOOK_SECRET', 'chuoi-bi-mat-webhook-github')}`,
        '',
        '# --- Sổ đăng ký web kết nối + lưu lượng (trong repo chính) ---',
        `CONNECT_INDEX_PATH=${current('CONNECT_INDEX_PATH', 'v-s/index.json')}`,
        `CONNECT_USAGE_DIR=${current('CONNECT_USAGE_DIR', 'usage')}`,
        `CONNECT_USAGE_PATH=${current('CONNECT_USAGE_PATH', 'v-s/usage.json')}`,
        `CONNECT_USAGE_EPOCH=${current('CONNECT_USAGE_EPOCH', '2026-01-05')}`,
        `CONNECT_PROBE_TIMEOUT_MS=${current('CONNECT_PROBE_TIMEOUT_MS', '4000')}`,
        '',
        '# --- Cloudinary (ảnh câu hỏi / kiểm duyệt) ---',
        `CLOUDINARY_CLOUD_NAME=${current('CLOUDINARY_CLOUD_NAME', '')}`,
        `CLOUDINARY_API_KEY=${secret('CLOUDINARY_API_KEY', '')}`,
        `CLOUDINARY_API_SECRET=${secret('CLOUDINARY_API_SECRET', '')}`,
        `CLOUDINARY_MODERATION=${current('CLOUDINARY_MODERATION', 'aws_rek')}`,
        `CLOUDINARY_MAX_BYTES=${current('CLOUDINARY_MAX_BYTES', String(10 * 1024 * 1024))}`,
        '',
        '# --- Email (OTP / thông báo) ---',
        `MAIL_HOST=${current('MAIL_HOST', 'smtp.gmail.com')}`,
        `MAIL_PORT=${current('MAIL_PORT', '465')}`,
        `MAIL_SECURE=${current('MAIL_SECURE', 'true')}`,
        `MAIL_USER=${current('MAIL_USER', '')}`,
        `MAIL_PASS=${secret('MAIL_PASS', '')}`,
        `MAIL_FROM=${current('MAIL_FROM', '')}`,
        '',
        '# --- Tuỳ chọn (chỉ cần khi dùng) ---',
        `MAIN_URL=${current('MAIN_URL', 'https://luyen-thi-cntt-utc-mnha.vercel.app')}`,
        `STUDYFILE_MAX_MB=${current('STUDYFILE_MAX_MB', '')}`,
        `SLIDE_MAX_PDF_MB=${current('SLIDE_MAX_PDF_MB', '')}`,
        ''
    ];
    return lines.join('\n');
}

/** Chỉ các biến cần đổi giữa các web (để so sánh nhanh). */
const DIFFERENT_KEYS = ['DATA_NODE', 'NODE_ID', 'NODE_URL', 'NODE_NAME'];

module.exports = { envTemplate, DIFFERENT_KEYS, SECRETS };
