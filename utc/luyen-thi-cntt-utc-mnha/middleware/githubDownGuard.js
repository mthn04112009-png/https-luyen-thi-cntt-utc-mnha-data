// middleware/githubDownGuard.js
// ============================================================
// Khi GitHub đang lỗi (sập / bảo trì / mạng / bị giới hạn) thì MỌI trang đều báo thống nhất,
// kể cả những controller tự bắt lỗi rồi trả lỗi riêng:
//   - res.render(...) / res.json(...) với mã >= 500        → trang "GitHub đang gặp vấn đề" (HTML)
//                                                            hoặc JSON { code: "GITHUB_UNAVAILABLE", message }
//   - res.redirect("...?error=...")                        → thay nội dung error bằng thông báo GitHub
// Chỉ kích hoạt khi GitHub vừa lỗi trong ~30 giây gần nhất (xem utils/githubErrors.js);
// GitHub hoạt động bình thường thì middleware này không đổi gì.
// Dữ liệu đã nạp trong RAM vẫn được phục vụ khi GitHub lỗi (githubStore.ensureFresh) nên
// trang chỉ báo lỗi khi THỰC SỰ không đọc/ghi được (vd: server vừa khởi động chưa nạp xong, nộp bài, lưu bài).
// ============================================================
const {
    GITHUB_DOWN_MESSAGE,
    isGithubRecentlyDown,
    renderGithubDown,
} = require('../utils/githubErrors');

const DOWN_VIEW = 'errors/github-down';

module.exports = function githubDownGuard(req, res, next) {
    const origRender = res.render.bind(res);
    const origJson = res.json.bind(res);
    const origRedirect = res.redirect.bind(res);

    res.render = function patchedRender(view, ...rest) {
        if (view !== DOWN_VIEW && res.statusCode >= 500 && isGithubRecentlyDown()) {
            return renderGithubDown(req, res, null);
        }
        return origRender(view, ...rest);
    };

    res.json = function patchedJson(body) {
        if (res.statusCode >= 500 && isGithubRecentlyDown()) {
            res.status(503);
            res.set('Retry-After', '60');
            return origJson({
                success: false,
                code: 'GITHUB_UNAVAILABLE',
                message: GITHUB_DOWN_MESSAGE,
                error: GITHUB_DOWN_MESSAGE,
            });
        }
        return origJson(body);
    };

    res.redirect = function patchedRedirect(a, b) {
        let status = 302;
        let url = a;
        if (typeof a === 'number') { status = a; url = b; }

        if (typeof url === 'string' && url.startsWith('/') && isGithubRecentlyDown()) {
            try {
                const u = new URL(url, 'http://local');
                if (u.searchParams.has('error')) {
                    u.searchParams.set('error', GITHUB_DOWN_MESSAGE);
                    url = u.pathname + u.search + u.hash;
                }
            } catch (_) { /* giữ nguyên url */ }
        }
        return origRedirect(status, url);
    };

    next();
};
