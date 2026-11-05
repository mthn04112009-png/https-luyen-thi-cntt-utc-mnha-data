// utils/githubErrors.js
// ============================================================
// Nhận biết lỗi do GitHub không dùng được (sập / bảo trì / mạng / bị giới hạn)
// và hiển thị trang báo lỗi riêng (views/errors/github-down.pug).
// ============================================================
const GITHUB_DOWN_TITLE = 'GitHub đang gặp vấn đề';
const GITHUB_DOWN_MESSAGE = 'GitHub đang gặp vấn đề, vui lòng quay lại sau.';

const NET_CODES = new Set([
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
]);
const NET_MESSAGE_RE = /fetch failed|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network (error|request)|timed? ?out/i;
const GITHUB_URL_RE = /(api\.github\.com|raw\.githubusercontent\.com|github\.com)/i;

/**
 * true nếu `err` là lỗi do GitHub không phản hồi được:
 *  - HTTP 5xx / 429 / 403 (rate limit, abuse) từ GitHub
 *  - lỗi mạng (không kết nối được, hết thời gian chờ, DNS...)
 * @param {Error} err
 * @param {{assumeGithub?:boolean}} opts  assumeGithub=true: chỗ gọi đã biết lỗi này đến từ thao tác GitHub
 */
function isGithubUnavailable(err, opts = {}) {
    if (!err) return false;

    const msg = String(err.message || '');
    const url = String(err.request?.url || err.response?.url || err.url || '');
    const fromGithub =
        opts.assumeGithub === true ||
        err.isGithub === true ||
        GITHUB_URL_RE.test(url) ||
        /api\.github\.com|raw\.githubusercontent\.com/i.test(msg);
    if (!fromGithub) return false;

    const status = Number(err.status || err.response?.status) || 0;
    if (status >= 500 && status < 600) return true;
    if (status === 429) return true;
    if (status === 403 && /rate limit|abuse|secondary|temporarily/i.test(msg)) return true;
    // Có mã HTTP 2xx-4xx (304 "không đổi", 404, 409...) = GitHub vẫn trả lời bình thường → không phải sập
    if (status > 0 && status !== 403) return false;

    // Octokit RequestError: `err.code` đã deprecated (đọc vào sẽ in cảnh báo) → chỉ đọc `cause.code` với lỗi của Octokit
    const isOctokit = err.name === 'HttpError' || (typeof err.status === 'number' && err.request);
    const code = isOctokit ? err.cause?.code : (err.code || err.cause?.code || err.errno);
    if (NET_CODES.has(code)) return true;
    if (NET_MESSAGE_RE.test(msg)) return true;

    return false;
}

/**
 * Hiển thị trang "GitHub đang gặp vấn đề" (HTTP 503, nhúng layout).
 * Yêu cầu /api, XHR hoặc Accept: json → trả JSON.
 */
function renderGithubDown(req, res, err = null) {
    const detail = process.env.NODE_ENV === 'production' || !err ? null : String(err.message || err);

    if (err) console.warn(`[github-down] ${req.method} ${req.originalUrl}: ${err.message}`);
    if (res.headersSent) return;

    const coolSec = Math.ceil(rateLimitRemainingMs() / 1000);   // đang bị GitHub chặn → báo đúng thời gian chờ còn lại
    res.set('Retry-After', String(coolSec > 0 ? Math.min(coolSec, 3600) : 60));
    res.set('Cache-Control', 'no-store');

    if (req.path.startsWith('/api') || req.xhr || req.headers.accept?.includes('json')) {
        return res.status(503).json({ success: false, code: 'GITHUB_UNAVAILABLE', message: GITHUB_DOWN_MESSAGE });
    }

    return res.status(503).render(
        'errors/github-down',
        {
            title: GITHUB_DOWN_TITLE,
            user: req.user || req.session?.user || null,
            message: GITHUB_DOWN_MESSAGE,
            retryUrl: req.originalUrl,
            retryAfterSec: coolSec > 0 ? coolSec : null,
            detail,
        },
        (renderErr, html) => {
            if (renderErr) {
                console.error("[github-down] Render view 'errors/github-down' thất bại:", renderErr.message);
                return res.status(503).type('text/plain').send(GITHUB_DOWN_MESSAGE);
            }
            return res.status(503).send(html);
        }
    );
}

// ------------------------------------------------------------
// "Sức khoẻ" GitHub: config/github.js gắn hook vào Octokit → mỗi request GitHub lỗi (sập/bảo trì/mạng)
// gọi noteFailure(), request thành công gọi noteSuccess(). Nhờ vậy middleware/githubDownGuard biết
// "GitHub vừa lỗi" để đổi MỌI phản hồi lỗi 5xx / redirect ?error= của mọi trang thành thông báo GitHub.
// ------------------------------------------------------------
const RECENT_MS = 30 * 1000;
let lastFailureAt = 0;

function noteFailure(err) {
    if (isGithubUnavailable(err, { assumeGithub: true })) lastFailureAt = Date.now();
}
function noteSuccess() {
    lastFailureAt = 0;     // GitHub trả lời được lại → hết "đang lỗi"
    if (Date.now() >= coolUntil) coolStreak = 0;   // hết hạ nhiệt mà GitHub trả lời được → lần chặn kế bắt đầu lại từ mức thấp
}
function isGithubRecentlyDown() {
    return lastFailureAt > 0 && Date.now() - lastFailureAt < RECENT_MS;
}

// ------------------------------------------------------------
// Giới hạn tốc độ / "abuse detection" (secondary rate limit) của GitHub.
// Bị chặn mà vẫn gọi dồn thì GitHub chặn LÂU hơn → khi gặp lỗi này, MỌI request GitHub đều tự dừng
// (không ra mạng) cho tới hết thời gian chờ: theo Retry-After nếu có, không thì 60s → 120s → 240s → 480s.
// ------------------------------------------------------------
const RATE_LIMIT_RE = /rate limit|abuse|secondary/i;
let coolUntil = 0;
let coolStreak = 0;

// Lưu thời điểm hết hạ nhiệt ra file tạm: nodemon/restart server KHÔNG làm mất trạng thái chặn
// (restart rồi gọi lại GitHub ngay chỉ làm GitHub chặn lâu hơn). Bỏ qua trên Vercel (mỗi instance riêng).
const fs = require('fs');
const os = require('os');
const path = require('path');
const COOL_FILE = process.env.VERCEL ? null : path.join(os.tmpdir(), 'mnha-github-cooldown.json');
try {
    if (COOL_FILE && fs.existsSync(COOL_FILE)) {
        const j = JSON.parse(fs.readFileSync(COOL_FILE, 'utf8'));
        if (Number(j.coolUntil) > Date.now()) { coolUntil = Number(j.coolUntil); coolStreak = Number(j.coolStreak) || 0; }
    }
} catch (_) { /* file hỏng → bỏ qua */ }
function saveCooldown() {
    if (!COOL_FILE) return;
    try { fs.writeFileSync(COOL_FILE, JSON.stringify({ coolUntil, coolStreak })); } catch (_) { /* không ghi được thì thôi */ }
}

// Phiên bản REST API dùng cho MỌI request. Lưu ý: Octokit tự gắn header 2022-11-28 cho từng method
// (octokit.repos.xxx) nên `request: { headers }` trong constructor KHÔNG có tác dụng và còn NGUY HIỂM (đè mất header authorization) → chỉ ghi đè trong hook.
// 2022-11-28 sẽ bị gỡ ngày 10/03/2028 (cảnh báo "POST /user/repos is deprecated").
const API_VERSION = process.env.GITHUB_API_VERSION || '2026-03-10';

function isRateLimitError(err) {
    if (!err) return false;
    const status = Number(err.status || err.response?.status) || 0;
    if (status === 429) return true;
    return status === 403 && RATE_LIMIT_RE.test(String(err.message || ''));
}

// "API rate limit exceeded for <IP>. (But here's the good news: Authenticated requests get a higher rate limit…)"
// = request đi ra KHÔNG kèm token (giới hạn chỉ 60 request/giờ/IP) → gần như chắc chắn thiếu/sai GITHUB_TOKEN.
const UNAUTH_LIMIT_RE = /rate limit exceeded for (?!user|installation|app)[0-9a-f.:]+|Authenticated requests get a higher rate limit/i;
const PRIMARY_LIMIT_RE = /API rate limit exceeded/i;   // hết quota theo GIỜ (primary) — khác "abuse/secondary" (gọi dồn)
let warnedUnauth = false;

function noteRateLimit(err) {
    const h = (err && err.response && err.response.headers) || {};
    const msg = String((err && err.message) || '');
    const primary = PRIMARY_LIMIT_RE.test(msg) || String(h['x-ratelimit-remaining']) === '0';
    let secs = Number(h['retry-after']);
    if (!(secs > 0) && (primary || String(h['x-ratelimit-remaining']) === '0')) {
        const reset = Number(h['x-ratelimit-reset']);
        if (reset > 0) secs = reset - Math.floor(Date.now() / 1000) + 2;   // đúng lúc quota được cấp lại
    }
    const fresh = Date.now() >= coolUntil;          // lỗi đầu tiên của đợt chặn mới (các request đang bay cùng báo lỗi thì không tính thêm)
    if (!(secs > 0)) secs = 60 * Math.pow(2, Math.min(coolStreak, 3));
    // secondary (abuse): tối đa 15 phút. primary (hết quota giờ): chờ đúng tới lúc reset, tối đa 1 giờ
    // (cũ: ép về 900s → gọi lại khi quota CHƯA reset → bị chặn tiếp, vòng lặp).
    secs = Math.min(Math.max(secs, 30), primary ? 3600 : 900);
    if (fresh) coolStreak++;
    coolUntil = Math.max(coolUntil, Date.now() + secs * 1000);
    saveCooldown();
    if (fresh) console.warn(`⏸️  [github] GitHub chặn tạm thời (${primary ? 'hết quota theo giờ' : 'abuse/secondary rate limit'}) → tạm dừng gọi GitHub ~${secs}s (dùng dữ liệu RAM).`);
    if (!warnedUnauth && UNAUTH_LIMIT_RE.test(msg)) {
        warnedUnauth = true;
        console.error(
            '❌ [github] Request tới GitHub đang đi ra KHÔNG kèm token (giới hạn chỉ 60 request/giờ/IP).\n' +
            '   → Kiểm tra GITHUB_TOKEN trong file .env (đúng tên biến, không thừa dấu cách/ngoặc, token chưa bị thu hồi/hết hạn)\n' +
            '     rồi chạy lại. Server sẽ in dòng "GitHub auth: …" khi khởi động để xác nhận.'
        );
    }
}

// 401 "Requires authentication" / "Bad credentials": token CÓ gửi nhưng GitHub từ chối (sai, hết hạn, bị thu hồi,
// hoặc dán thừa ký tự) → không phải lỗi code; mọi thao tác ghi (kể cả lưu session đăng nhập) sẽ thất bại.
let warnedBadToken = false;
function warnBadToken(err) {
    if (warnedBadToken) return;
    warnedBadToken = true;
    console.error(
        `❌ [github] GitHub từ chối GITHUB_TOKEN (401 ${String((err && err.message) || '')}).\n` +
        '   → Tạo token mới rồi dán vào GITHUB_TOKEN trong .env (không có dấu cách/ngoặc thừa), khởi động lại server:\n' +
        '     • Classic: https://github.com/settings/tokens  → tick scope "repo"\n' +
        '     • Fine-grained: Repository access = repo dữ liệu (GITHUB_REPO) → Permissions: Contents = Read and write, Metadata = Read\n' +
        '   Token phải thuộc tài khoản có quyền ghi vào GITHUB_OWNER/GITHUB_REPO (và các repo -1, -2… nếu có).'
    );
}

/** Số ms còn phải chờ trước khi được gọi GitHub lại (0 = gọi được). */
function rateLimitRemainingMs() {
    return Math.max(0, coolUntil - Date.now());
}

function makeCooldownError() {
    const left = rateLimitRemainingMs();
    const e = new Error(`You have triggered an abuse detection mechanism. Please wait a few minutes before you try again. (đang tạm dừng gọi GitHub, còn ~${Math.ceil(left / 1000)}s)`);
    e.status = 403;
    e.isGithub = true;
    e.isCooldown = true;
    return e;
}

// ------------------------------------------------------------
// BỘ ĐIỀU TỐC dùng chung cho MỌI Octokit của app (GitHub khuyến nghị — nguyên nhân gốc của "abuse detection"
// là gọi QUÁ DỒN: nhiều request song song, nhiều thao tác ghi liên tiếp):
//   • tối đa GITHUB_MAX_CONCURRENT (mặc định 4) request chạy cùng lúc;
//   • request GHI (POST/PUT/PATCH/DELETE, trừ /graphql — thực chất là đọc) chạy TUẦN TỰ, cách nhau
//     tối thiểu GITHUB_WRITE_GAP_MS (mặc định 1000ms; đặt 0 để tắt).
// Đang hạ nhiệt thì báo lỗi ngay cả khi request đang xếp hàng (không chờ rồi mới biết).
// ------------------------------------------------------------
const MAX_CONCURRENT = Math.max(1, Number(process.env.GITHUB_MAX_CONCURRENT || 4));
const WRITE_GAP_MS = Math.max(0, Number(process.env.GITHUB_WRITE_GAP_MS ?? 1000));
let activeCount = 0;
const slotWaiters = [];
let writeTail = Promise.resolve();
let lastWriteEnd = 0;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

function acquireSlot() {
    if (activeCount < MAX_CONCURRENT) { activeCount++; return Promise.resolve(); }
    return new Promise((resolve) => slotWaiters.push(resolve));   // slot được chuyển thẳng cho người chờ (activeCount giữ nguyên)
}
function releaseSlot() {
    const next = slotWaiters.shift();
    if (next) next(); else activeCount--;
}
function isWriteRequest(options) {
    const m = String((options && options.method) || 'GET').toUpperCase();
    if (m === 'GET' || m === 'HEAD') return false;
    const url = String((options && options.url) || '');
    return !/\/graphql\/?$/.test(url);
}

async function runThrottled(request, options) {
    if (rateLimitRemainingMs() > 0) throw makeCooldownError();
    await acquireSlot();
    try {
        if (rateLimitRemainingMs() > 0) throw makeCooldownError();
        if (!isWriteRequest(options) || WRITE_GAP_MS === 0) return await request(options);

        // ghi: xếp vào hàng đợi tuần tự
        const prev = writeTail;
        let done;
        writeTail = new Promise((r) => { done = r; });
        try {
            await prev;
            const wait = lastWriteEnd + WRITE_GAP_MS - Date.now();
            if (wait > 0) await sleepMs(wait);
            if (rateLimitRemainingMs() > 0) throw makeCooldownError();
            return await request(options);
        } finally {
            lastWriteEnd = Date.now();
            done();
        }
    } finally {
        releaseSlot();
    }
}

/** Gắn vào Octokit: đang hạ nhiệt → báo lỗi ngay (không gọi ra mạng); gặp lỗi chặn → bật hạ nhiệt; điều tốc request. */
function attachRateLimitGuard(octokit) {
    octokit.hook.before('request', (options) => {
        // Ghi đè phiên bản API (xem API_VERSION ở trên) — header của Octokit là chữ thường
        if (options && options.headers) options.headers['x-github-api-version'] = API_VERSION;
        if (rateLimitRemainingMs() > 0) throw makeCooldownError();
    });
    octokit.hook.wrap('request', (request, options) => runThrottled(request, options));
    octokit.hook.error('request', async (error) => {
        if (!error.isCooldown && isRateLimitError(error)) noteRateLimit(error);
        if (Number(error.status) === 401) warnBadToken(error);
        throw error;
    });
    return octokit;
}

/**
 * `fetch` cho Octokit: dùng fetch CÓ SẴN của Node (undici) thay cho node-fetch@2 đời cũ đi kèm Octokit 19,
 * vì node-fetch@2 trên Node mới (≥ 24) trả thân phản hồi rỗng/cụt cho request ghi → "Unexpected end of JSON input".
 * node-fetch hiểu option `timeout`, fetch gốc thì không → tự gắn AbortSignal.timeout.
 * Dùng: new Octokit({ auth, request: { timeout: ms, fetch: octokitFetch(ms) } })
 * (đặt GITHUB_NODE_FETCH=off để quay về node-fetch của Octokit)
 */
function octokitFetch(timeoutMs) {
    if (process.env.GITHUB_NODE_FETCH === 'off' || typeof globalThis.fetch !== 'function') return undefined;
    const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : 0;
    return (url, init = {}) => {
        const { agent, timeout, ...rest } = init;   // option riêng của node-fetch → bỏ
        if (ms && !rest.signal && typeof AbortSignal.timeout === 'function') rest.signal = AbortSignal.timeout(ms);
        return globalThis.fetch(url, rest);
    };
}

/**
 * In 1 dòng khi khởi động: GitHub có nhận token không, còn bao nhiêu quota.
 * GET /rate_limit KHÔNG tính vào quota. Không gọi khi đang hạ nhiệt. Không bao giờ ném lỗi.
 * (Từ API 2026-03-10 trường `rate` bị gỡ → đọc resources.core.)
 */
async function logAuthStatus(octokit) {
    try {
        if (!process.env.GITHUB_TOKEN) {
            console.warn('⚠️  GitHub auth: KHÔNG có GITHUB_TOKEN → chỉ 60 request/giờ/IP, sẽ nhanh chóng bị chặn. Hãy đặt GITHUB_TOKEN trong .env');
            return;
        }
        if (rateLimitRemainingMs() > 0) return;
        const t = String(process.env.GITHUB_TOKEN);
        console.log(`🔎 GitHub token đang dùng: ${t.slice(0, 4)}…${t.slice(-4)} (${t.length} ký tự) — so với token trong .env của bạn`);
        const res = await octokit.request('GET /rate_limit');
        const core = (res.data && res.data.resources && res.data.resources.core) || {};
        const limit = Number(core.limit) || 0;
        const authed = limit > 60;
        console.log(`${authed ? '🔑' : '⚠️ '} GitHub auth: ${authed ? 'đã xác thực' : 'KHÔNG xác thực (token sai/hết hạn?)'} — quota ${core.remaining}/${limit} (reset ${core.reset ? new Date(core.reset * 1000).toLocaleTimeString('vi-VN') : '?'}) · API ${API_VERSION}`);
    } catch (e) {
        if (Number(e.status) === 401) warnBadToken(e);
        else if (!e.isCooldown) console.warn(`⚠️  GitHub auth: không kiểm tra được (${e.message})`);
    }
}

/**
 * fetch() tới GitHub có: token (nếu có), phiên bản API mới, và dùng CHUNG bộ hạ nhiệt với Octokit.
 * Dành cho code không dùng Octokit (vd đọc AI-database/index.json): gọi KHÔNG token chỉ có 60 request/giờ/IP
 * ("API rate limit exceeded for <ip>") → luôn gửi token.
 * Ném lỗi có .status / .isGithub; bị chặn thì bật hạ nhiệt cho cả app.
 */
async function githubFetch(url, init = {}) {
    const left = rateLimitRemainingMs();
    if (left > 0) {
        const e = new Error(`GitHub đang hạ nhiệt (rate limit), còn ~${Math.ceil(left / 1000)}s`);
        e.status = 403; e.isGithub = true; e.isCooldown = true;
        throw e;
    }
    const headers = {
        'User-Agent': 'repository-mnha/1.0.0',
        'X-GitHub-Api-Version': API_VERSION,
        ...(init.headers || {}),
    };
    const tok = process.env.GITHUB_TOKEN;
    if (tok && !headers.Authorization && /(^https:\/\/api\.github\.com\/)/i.test(url)) headers.Authorization = `Bearer ${tok}`;

    let res;
    try {
        res = await fetch(url, { ...init, headers });
    } catch (netErr) {
        netErr.isGithub = true;
        noteFailure(netErr);
        throw netErr;
    }
    if (res.ok || res.status === 304 || res.status === 404) { noteSuccess(); return res; }

    let text = '';
    try { text = await res.clone().text(); } catch (_) { /* bỏ qua */ }
    const err = new Error(`GitHub ${res.status}: ${(text.match(/"message"\s*:\s*"([^"]+)"/) || [])[1] || res.statusText}`);
    err.status = res.status;
    err.isGithub = true;
    err.response = { status: res.status, headers: Object.fromEntries(res.headers.entries()) };
    if (isRateLimitError(err)) noteRateLimit(err);
    noteFailure(err);
    throw err;
}

module.exports = {
    githubFetch,
    API_VERSION,
    isRateLimitError,
    noteRateLimit,
    rateLimitRemainingMs,
    attachRateLimitGuard,
    logAuthStatus,
    octokitFetch,
    GITHUB_DOWN_TITLE,
    GITHUB_DOWN_MESSAGE,
    isGithubUnavailable,
    renderGithubDown,
    noteFailure,
    noteSuccess,
    isGithubRecentlyDown,
};
