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

## Sửa lỗi hiệu ứng (2026-11-06) — `public/js/pptxPlayer.js`
- **Fade (và mọi hiệu ứng có `opacity`: Zoom, Peek, Bounce, Blinds/Checker/… → fade) không mờ dần mà hiện ra tức thì.** Nguyên nhân: `el.animate(..., { composite: 'add' })` — với `opacity`, `add` CỘNG vào giá trị gốc (1 + 0…1 → luôn bị cắt về 1). Sửa: tách mỗi hiệu ứng entr/exit thành 2 animation: `transform` dùng `add`, `opacity`/`clipPath` dùng `replace`.
- Exit-fade giờ mờ đi rồi mới ẩn (trước đây biến mất đột ngột).
- Appear (presetID 1) ẩn đúng tới lúc bắt đầu (tôn trọng độ trễ) rồi hiện hẳn.
- Đã kiểm trên Chromium thật với `error.pptx` (8 slide, 21–22 bước/slide, toàn Fade presetID 10 + auto-start ở slide 2) và các bản biến thể appear / fly / box / circle / diamond / peek / plus / wipe / zoom / split / stretch / bounce / blinds / exit-fade / exit-fly: mỗi bước hiện đúng phần tử, cuối slide không còn phần tử nào bị ẩn, không còn animation/style thừa.

## PPTX tự đổi sang PDF khi up
- Khi admin chọn `.pptx/.ppt` ở form Slide, `public/js/studyFileForm.js` gửi file tới dịch vụ Python `converter/server.py` (LibreOffice), nhận PDF về rồi up PDF như bình thường → trang xem dùng trình xem PDF (`pdfPageMode`).
- Bật bằng biến môi trường của web: `PPTX_CONVERTER_URL` (vd `http://localhost:5001`) và tuỳ chọn `PPTX_CONVERTER_TOKEN`. Không đặt URL = up PPTX nguyên bản như cũ.
- Vercel không có LibreOffice → chạy converter ở máy admin (`python converter/server.py`) hoặc dựng `converter/Dockerfile` lên Render/Railway/VPS.
- Lỗi đổi (converter tắt, quá 5 phút…) → báo lỗi và không up gì.
- Đổi tay một file: `python converter/pptx_to_pdf.py bai-giang.pptx`.
- File `.pptx` đã up từ trước vẫn xem được bằng lõi tự viết `public/js/pptxPlayer.js` (có hiệu ứng/chuyển cảnh).

## Zoom khi xem PPTX (lõi pptxPlayer.js)
- Thanh công cụ có `− 100% +`; các mức: 50 · 75 · 100 · 115 · **135** · 150 · 175 · 200 · 300%. 100% = vừa khung. Bấm số % để về 100%.
- Phím `+` / `-` / `0`, hoặc `Ctrl` + lăn chuột. Khi > 100%: lăn chuột để cuộn, kéo chuột (hoặc vuốt trên điện thoại) để di chuyển; bấm không kéo vẫn là "tiếp".
- Mức zoom được nhớ (localStorage `slPptxZoom`) cho lần xem sau. API: `player.setZoom(1.35)`.

## ⚠️ Sửa lỗi viền đen quanh mọi khung chữ (2026-11-12) — `public/js/pptxPlayer.js` › `Ctx.prototype.lineSpec` — **KHÔNG CHỈNH LẠI**
- **Triệu chứng:** xem PPTX (vd. slide "Round Robin q = 2" có biểu đồ Gantt), mọi hộp chữ (tiêu đề, đề bài, nhãn thời gian 0·2·3·5…, khung "Chờ = CT − AT − BT") đều bị **viền đen mảnh**; các nhãn sát nhau (2|3, 7|8, 16|17) nhìn như bị chồng/đè lên nhau.
- **Nguyên nhân:** file PPTX (tạo bằng html2pptx/pptxgenjs) ghi `<a:ln/>` **RỖNG** cho hộp chữ/hình (không màu, không `<a:noFill/>`, không `<p:style>`). Theo chuẩn OOXML và PowerPoint, `<a:ln/>` rỗng = **không có viền**. Code cũ gán màu **đen mặc định** khi không có màu (`if (!c) c = { rgb: [0,0,0] }`) nên vẽ viền.
- **Cách sửa:** `lineSpec` chỉ vẽ viền khi có **màu thật** (từ `<a:ln><a:solidFill|gradFill>` hoặc `<p:style><a:lnRef idx>0>`); không có màu → `return null` (`if (none || !c) return null;`).
- **QUY TẮC cho lần sửa sau:**
  1. **Không** thêm lại màu đen mặc định / không coi `<a:ln/>` rỗng là "có viền".
  2. Đường kẻ thật (`prst="line"`, connector) vẫn có viền vì có `<a:solidFill>` trong `<a:ln>`; nhánh vẽ đường trong `shapeGeometry` (`var ln2 = line || {…đen…}`) giữ nguyên.
  3. Sau khi sửa `lineSpec`/`shapeGeometry`/`fillSpec`, mở lại slide "Round Robin q = 2" (hoặc file bất kỳ do pptxgenjs tạo) và kiểm tra: **không** có viền quanh khung chữ, thanh Gantt P1/P2/P3… hiện đủ, nhãn thời gian không có ô viền.
- Comment cảnh báo tương ứng nằm ngay trong code `lineSpec` (tìm chuỗi `ĐỪNG SỬA LẠI`).
