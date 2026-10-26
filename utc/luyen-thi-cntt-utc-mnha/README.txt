https://luyen-thi-cntt-utc-mnha.vercel.app/

NHIỀU REPO GITHUB DỮ LIỆU (services/githubPool.js)
- GITHUB_REPO là repo chính. Khi đạt GITHUB_REPO_LIMIT_MB (mặc định 200MB) server tự tạo <GITHUB_REPO>-1, -2, ... rồi ghi tiếp vào repo mới nhất.
- File .json luôn ở repo chính (githubStore / webhook / đồng bộ không đổi). Chỉ file khác (PDF slide/tài liệu mã hoá, ảnh, logo, âm thanh...) mới sang repo -1, -2...; file đã có thì ghi đè đúng repo đang chứa nó; đọc gộp mọi repo.
- Sổ repo đã tạo: github/repos/index.json (repo chính) gồm id, tên repo, ngày tạo — KHÔNG lưu dung lượng.
- Dung lượng lấy từ webhook push (cùng webhook /webhooks/github đang dùng, payload.repository.size), giữ trong RAM; chưa có thì hỏi API GitHub một lần. Hiện từng repo ở trang "Web kết nối".
- Webhook push (/webhooks/github) được TỰ gắn cho repo chính và mọi repo -1, -2... khi web khởi động (chỉ web chính, 1 lần/tiến trình); secret TỰ sinh (HMAC từ SESSION_ENC_KEY/GITHUB_TOKEN..., mọi instance ra cùng giá trị) — không cần đặt GITHUB_WEBHOOK_SECRET (đặt thì dùng giá trị đó). Token cần quyền admin:repo_hook. Tắt: GITHUB_WEBHOOK_AUTO=off.
- Tắt: GITHUB_REPO_POOL=off. Test: node test/github-pool.js
