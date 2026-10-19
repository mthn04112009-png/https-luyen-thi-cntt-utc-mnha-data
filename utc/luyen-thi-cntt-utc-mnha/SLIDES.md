# Ứng dụng Slide học tập (`/slides`)

## Đường dẫn
| URL | Ai dùng | Mô tả |
|---|---|---|
| `/apps` | mọi tài khoản đã duyệt | Có thêm thẻ **Slide học tập** (cùng điều kiện quyền với Flashcards) |
| `/slides` | có quyền | 2 nút: **Dashboard** (chỉ admin) và **Môn học** |
| `/slides/subjects`, `/slides/subjects/:id` | có quyền | Chọn môn → danh sách slide của môn (bố cục giống Flashcards) |
| `/slides/study/:id` | có quyền | Xem slide: PDF nhúng từng trang (◀ ▶, phím ←/→, vuốt, zoom, toàn màn hình) + nút **Tải xuống PDF** |
| `/slides/file/:id` | có quyền | Server **giải mã** PDF rồi trả về (`?chunk=i` từng phần ≤ 3MB, `?download=1` cả file) |
| `/slides/dashboard` | admin | Danh sách, công khai/ẩn, sửa, xoá |
| `/slides/dashboard/new`, `/:id/edit` | admin | Up / sửa (chọn môn, tiêu đề, mô tả, file PDF) |

Quyền giống Môn học/Flashcards: `userKeyService.getContentScope`.

## Lưu trữ — CHỈ GitHub, KHÔNG MongoDB
```
subjects/<slug-môn>/slides/<slug-slide>_<unix>.json   thông tin (tiêu đề, mô tả, pdfFile, pdfSize, originalName, isPublished…)
subjects/<slug-môn>/slides/<slug-slide>_<unix>.pdf    PDF đã MÃ HOÁ AES-256-GCM
```
RAM chỉ giữ chỉ mục (`models/Slide.js` ← `services/githubStore.js` `KINDS.slides`), giống Flashcards.

## Mã hoá
- `services/slideCryptoService.js`, khoá = `ENCRYPTION_MASTER_KEY` (64 hex, đã có sẵn cho API key AI).
- Mỗi khung có salt riêng, khoá khung = HKDF-SHA256(master, salt). Mở file `.pdf` trên GitHub chỉ thấy dữ liệu rối (không có `%PDF-`).
- Chỉ server giải mã, khi người dùng xem/tải xuống (đã đăng nhập + đúng quyền). Cache RAM 2 phút, không ghi đĩa.
- **Localhost và Vercel phải dùng CÙNG `ENCRYPTION_MASTER_KEY`**, nếu không PDF up ở nơi này sẽ không giải mã được ở nơi kia.

## Giới hạn 20MB và cách qua được Vercel
Vercel cắt request/response > 4.5MB nên PDF **không đi 1 lần**:
1. **Up**: trình duyệt cắt PDF thành phần 2MB → `POST /slides/dashboard/upload-chunk` (server mã hoá phần đó, lưu tạm thành blob GitHub, trả `sha`)
   → `POST /slides/dashboard` kèm danh sách `sha` → server gộp thành **1 file `.pdf` mã hoá** và ghi JSON.
2. **Xem / tải**: trình duyệt gọi `/slides/file/:id?chunk=0..n` (mỗi phần ≤ 3MB), ghép lại rồi hiển thị bằng PDF.js (dự phòng: `<iframe>`).
- Giảm giới hạn (tuỳ chọn): biến môi trường `SLIDE_MAX_PDF_MB` (tối đa 50). Mặc định 20.
- Bước gộp ghi file ~27MB lên GitHub nên mất vài chục giây; `vercel.json` đang để `maxDuration: 60`.

## Việc cần làm sau khi chép code
- Không cần `npm install` thêm gói nào. PDF.js nạp từ `cdnjs.cloudflare.com` (như Tailwind/Lucide đang dùng CDN).
- Đảm bảo `ENCRYPTION_MASTER_KEY`, `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO` có trong `.env.local` và trong Environment Variables của Vercel.
- Test: `node test/slides.js`
