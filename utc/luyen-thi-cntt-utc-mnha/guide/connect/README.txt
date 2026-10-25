# Web kết nối (nhiều Vercel + một GitHub/Mongo dùng chung)

Cùng một codebase, chỉ khác `.env`:

| Biến | Web chính | Web dữ liệu |
| --- | --- | --- |
| `DATA_NODE` | `off` (hoặc bỏ trống) | `on` |
| `NODE_ID` | — | mã web, vd `luyen-thi-cntt-data-1` |
| `NODE_URL` | — | `https://luyen-thi-cntt-data-1.vercel.app` |
| `NODE_NAME` | — | tên hiển thị, vd `Web dữ liệu 1` |

Mọi biến bí mật phải **GIỐNG HỆT** nhau ở tất cả Vercel project, nếu không khoá kết nối /
phiên đăng nhập / dữ liệu mã hoá sẽ không đọc được:

`MONGODB_URI`, `SESSION_SECRET`, `SESSION_ENC_KEY`, `ENCRYPTION_MASTER_KEY`,
`CONNECT_ENC_KEY`, `JWT_SECRET`, `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`,
`GITHUB_BRANCH`, `GITHUB_WEBHOOK_SECRET`, `CLOUDINARY_*`, `MAIL_*`.

`CONNECT_ENC_KEY` nên dài ≥ 32 ký tự. Mẫu đầy đủ luôn hiện ở trang `/connect`
(không lộ giá trị thật, chỉ là mẫu để bạn dán vào Vercel).

## 1. Dựng một web dữ liệu

1. Tạo Vercel project mới từ **cùng repository** này (hoặc bấm "Duplicate" project chính).
2. Copy toàn bộ biến môi trường từ web chính, sau đó sửa 4 dòng `DATA_NODE` / `NODE_ID` /
   `NODE_URL` / `NODE_NAME` như bảng trên.
3. Deploy. Mở `https://<web-dữ-liệu>/api/node/health` — phải trả về
   `{"ok":true,"id":"<NODE_ID>",...}` (endpoint này không cần MongoDB).
4. Đăng nhập bằng **admin mặc định** (`role=admin` và `userKey=null`).
   Web dữ liệu **không cho** đăng ký, OTP, quên/đặt lại mật khẩu hay tài khoản tổ chức.
5. Lần đăng nhập đầu, web tự tạo **khoá kết nối**, mã hoá rồi ghi vào `v-s/index.json`
   của repository chính. Khoá gốc chỉ hiện **một lần** ở `/connect`.
6. Vào `/connect` của web dữ liệu để xem trạng thái đăng ký, `.env` mẫu, lưu lượng tuần.
   Trang `/connect/key` cho xem lại khoá (hỏi mật khẩu) và tự kiểm tra chữ ký.

## 2. Quản lý ở web chính

`/connect` (chỉ admin mặc định) cho phép:

- Thêm web bằng URL (hoặc dán khoá kết nối có sẵn), đổi tên, bật/tắt, xoá.
- **Kiểm tra tất cả** lần lượt theo thứ tự cũ → mới: gọi `/api/node/health`, sau đó ký HMAC
  gọi `/api/node/status` để lấy lưu lượng và xác nhận khoá.
- Nhập số liệu **Fast Data Transfer / Fast Origin Transfer** chính thức của Vercel (nhập tay).
- Xem lưu lượng tuần này / tuần trước theo từng ngày.

Dữ liệu lưu trên GitHub của repo chính:

- `v-s/index.json` — sổ đăng ký web (khoá kết nối được mã hoá 2 chiều, không lưu khoá thô).
- `usage/week-<N>/index.json` — lưu lượng từng tuần, không ghi đè tuần cũ.
  File cũ `v-s/usage.json` vẫn được đọc và cộng vào.

## 3. Sự cố thường gặp

| Hiện tượng | Nguyên nhân / cách xử lý |
| --- | --- |
| `mã web không khớp` | `NODE_ID` khác mã đã thêm ở web chính. Sửa `NODE_ID` hoặc thêm lại web bằng đúng URL. |
| `sai khoá kết nối` | `CONNECT_ENC_KEY` khác nhau giữa các web, hoặc đã bấm "Đổi khoá kết nối". Đổi khoá ở web dữ liệu rồi dán khoá mới vào web chính (hoặc xoá và để web tự đăng ký lại). |
| `Web này chưa có khoá kết nối` | Chưa đăng nhập admin mặc định ở web dữ liệu lần nào, hoặc `v-s/index.json` chưa ghi được (kiểm tra `GITHUB_TOKEN`). |
| `/api/node/health` vẫn 200 nhưng `/connect` lỗi | MongoDB của web dữ liệu chưa kết nối — health cố tình không phụ thuộc Mongo. |
| Không đăng nhập được ở web dữ liệu | Chỉ `role=admin` + `userKey=null` được phép; tài khoản tổ chức/sinh viên bị từ chối. |
