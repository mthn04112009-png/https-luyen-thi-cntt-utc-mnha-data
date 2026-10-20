# Slide bài học (`/slides`) và Tài liệu học tập (`/documents`)

Hai ứng dụng dùng CHUNG một bộ code (`controllers/studyFile.controller.js`, `routes/studyFile.js`, `views/studyfiles/*`),
khác nhau ở cấu hình trong `config/studyFileConfig.js` (`APPS`).

| | Slide bài học | Tài liệu học tập |
|---|---|---|
| URL | `/slides` | `/documents` |
| Định dạng up | `.pdf` `.ppt` `.pptx` | `.pdf` |
| Cách xem | PDF: từng trang như slide · PPTX: trình chiếu có chuyển cảnh + hiệu ứng · PPT: tải xuống | Cuộn dọc liên tục, phóng to/nhỏ, đúng khổ ngang/dọc từng trang |
| Lưu trên GitHub | `subjects/<môn>/slides/<tên>_<timestamp>.json` + file mã hoá | `subjects/<môn>/documents/<tên>_<timestamp>.json` + file mã hoá |

Trang `/<app>`: 2 nút **Dashboard** (admin) và **Môn học**; quyền giống Flashcards/Môn học (`getContentScope`). Cả 2 thẻ hiện trong `/apps`.

## Lưu trữ — CHỈ GitHub, KHÔNG MongoDB
```
subjects/<môn>/<slides|documents>/<tên>_<timestamp>.json        thông tin (tiêu đề, mô tả, parts[], fileExt, fileSize, …)
subjects/<môn>/<slides|documents>/<tên>_<timestamp>.pdf         nếu file ≤ 23MB (đuôi .pdf/.ppt/.pptx theo file gốc)
subjects/<môn>/<slides|documents>/<tên>_<timestamp>-1.pdf       nếu file > 23MB: chia nhỏ -1, -2, -3, …
                                                    -2.pdf      mỗi file lưu trên GitHub ≤ 23.000.000 byte
```
Mọi file đều **mã hoá AES-256-GCM** (`services/slideCryptoService.js`, khoá `ENCRYPTION_MASTER_KEY`). Khi xem/tải, server giải mã từng
file-phần rồi **nối liền mạch** thành file gốc. RAM chỉ giữ chỉ mục (`models/Slide.js`, `models/Document.js` ← `githubStore.js`).
JSON bản đầu (chỉ có `pdfFile`/`pdfSize`) vẫn đọc được.

## Giới hạn
- Mặc định tối đa **100MB / file** (đổi bằng biến môi trường `STUDYFILE_MAX_MB`, tối đa 200).
- Mỗi file lưu trên GitHub ≤ **23MB**.

## Vì sao up/xem đi theo từng phần (chạy được trên Vercel)
Vercel cắt request/response > 4.5MB, và mỗi function chạy tối đa 60s (`vercel.json`).
1. **Up** (`public/js/studyFileForm.js`): cắt file thành phần 2MB → `POST …/dashboard/upload-chunk` (server mã hoá 1 khung, lưu tạm thành blob GitHub)
   → gom các khung thành file-phần ≤ 23MB, mỗi file-phần 1 request `POST …/dashboard/upload-part` (server kiểm tra, ghi `*.pdf` hoặc `*-n.pdf`, trả chữ ký HMAC)
   → `POST …/dashboard` ghi JSON (server kiểm tra chữ ký nên client không thể khai man đường dẫn/kích thước).
2. **Xem/tải** (`public/js/studyFileViewer.js`): `GET …/file/:id?chunk=i` trả từng phần ≤ 4MB, trình duyệt ghép lại.

## Xem PPTX: chuyển cảnh và hiệu ứng (`public/js/pptxPlayer.js`)
Tự đọc file .pptx bằng JSZip và dựng lại slide trong trình duyệt (file không gửi đi đâu).
- **Chuyển cảnh**: fade, push, cover, pull, wipe, split, zoom, circle, diamond, plus, cut, random; nhóm của PowerPoint 2010+ được quy về kiểu gần nhất.
  Đọc đúng thời lượng; "tự chuyển theo thời gian" có nút ⏱ bật/tắt.
- **Hiệu ứng**: vào / ra / nhấn mạnh / đường chuyển động — appear, fly in/out, fade, wipe, zoom, box, circle, diamond, split, spin, grow/shrink, pulse…
  theo đúng thứ tự *khi click / cùng lúc / sau hiệu ứng trước*, độ trễ và độ dài trong file; hiệu ứng theo từng đoạn văn. Click/→/Space = bước tiếp, ← = lùi.
- **Chưa hỗ trợ**: biểu đồ, SmartArt, video/âm thanh nhúng, WordArt (hiện khung báo "chưa hỗ trợ"); blinds/checker/strips/wheel/wedge được thay bằng fade;
  font không có sẵn trên máy người xem được thay bằng font gần nhất nên có thể lệch chữ đôi chút.
- **`.ppt` (PowerPoint 97–2003)**: up và tải xuống được, nhưng trình duyệt không đọc được định dạng này → trang xem hướng dẫn lưu lại thành `.pptx`.

## Cần có
- Không cần cài thêm gói npm. Thư viện nạp từ `cdnjs.cloudflare.com`: PDF.js 3.11.174, JSZip 3.10.1 (PDF.js lỗi → dự phòng `<iframe>`).
- `.env.local` và Vercel đều có `ENCRYPTION_MASTER_KEY` (GIỐNG NHAU), `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`.

## Test
- `node test/studyfiles.js` — mã hoá, chia/nối file, toàn bộ luồng up → xem → sửa → xoá, từ chối dữ liệu xấu, tương thích JSON cũ.
- `python3 test/browser/make_test_deck.py && node test/browser/viewer.browser.js` — mở trang xem trong Chromium thật (cần playwright, pdf-lib, pdfjs-dist, jszip, python-pptx).
