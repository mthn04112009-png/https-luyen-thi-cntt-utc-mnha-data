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

    res.set('Retry-After', '60');
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
}
function isGithubRecentlyDown() {
    return lastFailureAt > 0 && Date.now() - lastFailureAt < RECENT_MS;
}

module.exports = {
    GITHUB_DOWN_TITLE,
    GITHUB_DOWN_MESSAGE,
    isGithubUnavailable,
    renderGithubDown,
    noteFailure,
    noteSuccess,
    isGithubRecentlyDown,
};
