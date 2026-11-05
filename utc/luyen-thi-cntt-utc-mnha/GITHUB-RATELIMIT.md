# GitHub: abuse detection / rate limit / API version

Cập nhật 2026-11-06. Áp dụng cho CẢ 2 dự án (luyen-thi-cntt-utc-mnha và repository-mnha) — cùng file `utils/githubErrors.js`.

## Triệu chứng đã gặp
```
⏸️ [github] GitHub chặn tạm thời (abuse/rate limit) → tạm dừng gọi GitHub ~900s
⚠️ [aiProviderService] không đọc được AI-database/index.json: API rate limit exceeded for <IP>. (Authenticated requests get a higher rate limit…)
GET /slides/dashboard 503   ← "You have triggered an abuse detection mechanism…"
"POST https://api.github.com/user/repos" is deprecated. It is scheduled to be removed on Fri, 10 Mar 2028
```

## Nguyên nhân & cách sửa
| Vấn đề | Sửa |
|---|---|
| Gọi GitHub quá dồn (song song, nhiều thao tác ghi liên tiếp) → secondary rate limit | **Bộ điều tốc dùng chung** trong `attachRateLimitGuard`: tối đa `GITHUB_MAX_CONCURRENT` (4) request cùng lúc; request GHI chạy tuần tự, cách nhau `GITHUB_WRITE_GAP_MS` (1000ms; `0` = tắt) |
| "API rate limit exceeded for **<IP>**" = request đi ra **không kèm token** (60 req/giờ/IP) | Khi gặp lỗi này in hướng dẫn kiểm tra `GITHUB_TOKEN`; khi khởi động in `GitHub auth: …` (token có được nhận không, quota còn bao nhiêu — `GET /rate_limit` không tốn quota) |
| Hết quota theo giờ nhưng chỉ chờ tối đa 900s → gọi lại khi chưa reset → bị chặn tiếp | Primary limit: chờ đúng tới `x-ratelimit-reset` (tối đa 3600s). Secondary vẫn theo `Retry-After`/lùi dần, tối đa 900s |
| Đang hạ nhiệt mà `aiProviderService` vẫn thử lại mỗi 15s + spam log | Chờ hết hạ nhiệt mới đọc lại, không in log cho lỗi hạ nhiệt |
| Trang 503 chỉ nói "thử lại sau ít phút" | `Retry-After` = thời gian hạ nhiệt còn lại; trang `errors/github-down` hiện "thử lại sau ~N phút" (app Luyện thi) |
| Cảnh báo `POST /user/repos is deprecated` | Octokit gắn sẵn `X-GitHub-Api-Version: 2022-11-28` cho từng `octokit.repos.*` nên header ở constructor vô hiệu → **ép `2026-03-10` trong hook** `before request`. Dự án repository-mnha trước đây chưa gắn hook này (cả client chính lẫn `createClient`) — nay đã gắn. Đổi phiên bản: `GITHUB_API_VERSION` |

Đã đối chiếu bản 2026-03-10: không đổi gì với các endpoint đang dùng (contents, git blob/tree/ref, webhook, GraphQL). Lưu ý: tạo repo (`POST /user/repos`, `/orgs/{org}/repos`) bị chặn thương mại trả **451** thay vì 422; `GET /rate_limit` bỏ trường `rate` (code đọc `resources.core`).

## Biến môi trường (tuỳ chọn)
```
GITHUB_MAX_CONCURRENT=4     # số request GitHub chạy cùng lúc
GITHUB_WRITE_GAP_MS=1000    # khoảng cách tối thiểu giữa 2 request ghi (0 = tắt)
GITHUB_API_VERSION=2026-03-10
```

## NGUYÊN NHÂN GỐC của "KHÔNG xác thực" / 401 dù token đúng
`new Octokit({ request: { headers: { 'X-GitHub-Api-Version': … } } })`: Octokit gộp `options.request` ĐÈ lên request thật nên `headers` ở đây **thay toàn bộ header, mất `authorization`** → mọi request ra như chưa đăng nhập (60 req/giờ/IP, 401 khi ghi). Đã bỏ `headers` khỏi `request` ở `config/github.js` và `createClient()` (cả 2 dự án). Tuyệt đối không thêm lại; phiên bản API chỉ ép trong hook.

## "Unexpected end of JSON input" khi ghi (PUT contents / lưu session)
Sau khi sửa xác thực, request GHI nhận về thân phản hồi rỗng/cụt (status 500 do Octokit bọc lỗi), còn GET vẫn chạy. Nghi `node-fetch@2` (đi kèm Octokit 19) không hợp Node 26. Đã chuyển mọi Octokit sang `fetch` có sẵn của Node qua `octokitFetch(timeout)` trong `utils/githubErrors.js` (tự gắn `AbortSignal.timeout`). Cần quay lại cách cũ: `GITHUB_NODE_FETCH=off`. Nếu vẫn lỗi: chạy Node LTS (22/24) thay vì 26.

## Lỗi 401 "Requires authentication" khi lưu session / ghi cookies/index.json
Request GHI đã gửi `authorization: token …` nhưng GitHub trả 401 → **token trong `.env` không hợp lệ** (sai, hết hạn, bị thu hồi, hoặc thiếu quyền với repo dữ liệu). Cùng nguyên nhân với dòng "API rate limit exceeded for <IP>" ở trên (GitHub coi request là chưa xác thực). Hậu quả: đăng nhập xong không lưu được session → `/admin/dashboard` quay lại `/auth/login`.
Cách xử lý: tạo token mới (classic: scope `repo`; fine-grained: Contents = Read and write trên repo dữ liệu), dán vào `GITHUB_TOKEN`, restart. Server nay in hướng dẫn này khi gặp 401 và dòng `GitHub auth:` lúc khởi động.
Cảnh báo `[@octokit/request-error] error.code is deprecated`: do code đọc `e.code === 'SHA_CONFLICT'` trên lỗi Octokit → đã chặn bằng `e.name !== 'HttpError'` ở mọi chỗ kiểm tra SHA_CONFLICT.

## Nếu vẫn bị chặn
1. Chờ hết thời gian hạ nhiệt (lưu ở file tạm `mnha-github-cooldown.json` nên restart/nodemon KHÔNG xoá). Đừng xoá file này để "thử lại" — gọi lại sớm làm GitHub chặn lâu hơn.
2. Xem dòng `GitHub auth:` lúc khởi động: nếu báo KHÔNG xác thực → sửa `GITHUB_TOKEN` trong `.env`.
3. Hạn chế restart liên tục khi đang bị chặn: mỗi lần khởi động nạp lại dữ liệu từ GitHub.
4. Nếu 2 dự án dùng chung 1 token/1 IP thì quota/giới hạn cũng dùng chung — chạy cả hai cùng lúc dễ chạm giới hạn hơn.

## Kiểm thử
Đã kiểm bằng giả lập hook của Octokit (header phiên bản, giới hạn song song, giãn cách ghi, báo lỗi nhanh khi hạ nhiệt, cooldown primary/secondary) và `node test/github-pool.js` (repository-mnha). Chưa chạy với GitHub thật.
