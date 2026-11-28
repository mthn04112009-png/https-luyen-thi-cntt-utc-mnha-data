# Ghi chú cho AI / người sửa code sau này (bản `luyen-thi-cntt-utc-mnha`)

Đọc file này TRƯỚC khi sửa. Chủ dự án có **2 bản zip** (bản này + bản `tu-luyen-thi-cntt-utc-mnha`); ghi chú của cả hai nằm ở đây và ở `AI-NOTES.md` của bản kia.

## 0. QUY TẮC GIAO FILE — làm TỰ ĐỘNG, không chờ chủ dự án nhắc
Sau MỖI lần sửa code xong (dù nhỏ), **tự đóng gói và đưa lại ĐỦ CẢ 2 file zip đầy đủ** (không đưa file lẻ, không đưa bản vá, không hỏi lại):

| Zip | Thư mục gốc BÊN TRONG zip | Ghi chú |
|---|---|---|
| `luyen-thi-cntt-utc-mnha.zip` | `temp/` (đúng tên này, đừng đổi) | bản chính: Express + Pug + GitHub làm kho dữ liệu, chạy Vercel |
| `tu-luyen-thi-cntt-utc-mnha.zip` | `tu-luyen-thi-cntt-utc-mnha/` | bản theo từng tài khoản: frontend tĩnh (GitHub Pages) + backend Vercel |

- Bản chưa sửa gì vẫn đưa lại nguyên vẹn (chủ dự án muốn luôn có đủ cặp zip mới nhất).
- Đóng gói giữ nguyên cấu trúc cũ, KHÔNG kèm `node_modules`: `cd <thư mục cha> && zip -qr <tên>.zip <thư-mục-gốc> -x '*/node_modules/*'`.
- Đưa file bằng `present_files`; ghi 1–3 dòng: đã sửa gì, đã chạy test nào, phần nào CHƯA kiểm thử với dịch vụ thật.
- Cập nhật mục "Lịch sử thay đổi" cuối file này (và file kia nếu có sửa) trước khi đóng gói.

## 1. Hai bản khác nhau thế nào (đừng trộn lẫn)
- **Bản này (`temp/`)**: Express 5 + Pug, MongoDB chỉ là lớp tương thích — dữ liệu thật nằm ở **GitHub** (`services/githubStore.js`, nhóm repo `githubPool.js`). Có Slide / Tài liệu / Flashcard / Video / Quiz / tự luận có **vẽ tay + ảnh + PDF** kiểm duyệt bằng Cloudinary, web kết nối (`/connect`), GitHub App, Cloudflare R2.
- **Bản `tu-luyen-...`**: KHÔNG Express, KHÔNG Mongo, KHÔNG Cloudinary; mỗi tài khoản tự lưu bài. Chủ dự án **đã chủ động bỏ** vẽ tay / ảnh / PDF / Cloudinary ở bản đó → **đừng thêm tính năng ảnh-kiểm-duyệt vào bản kia** (xem `AI-NOTES.md` của nó).
- Sửa tính năng ở bản này thì KHÔNG tự "đồng bộ" sang bản kia, trừ khi chủ dự án yêu cầu.

## 2. Bản đồ code bản này (rút gọn)
- Tài liệu có sẵn: `README.txt` (nhóm repo GitHub, sáng/tối, OTP), `STUDYFILES.md` (Slide/Tài liệu: mã hoá, up thẳng R2/GitHub App), `SLIDES.md`, `FLASHCARDS.md`, `GROUPS.md`, `GITHUB-RATELIMIT.md`, `guide/`.
- Up file/ảnh thẳng không qua Vercel: Slide/Tài liệu → `controllers/studyFile.controller.js` (R2 hoặc GitHub App); **ảnh → mục 3 dưới đây**.
- Token tạm GitHub: `services/githubAppToken.js` (cấu hình ở `/connect` → `services/connect/githubApp.js`, file `v-s/github-app.json`).
- Tài khoản Cloudinary có **3 nguồn**, gộp ở `services/cloudinaryAccountService.js`: MongoDB (Quản trị → API Key → Cloudinary) + **repo chính** (nhập ở `/connect`, `services/connect/cloudinaryStore.js`, file `v-s/cloudinary.json`, mã hoá) + `.env`.
- Test (không cần Mongo/GitHub thật): `node test/direct-image.js`, `node test/direct-image.client.js`, `node test/studyfiles.direct-gh.js`, `node test/studyfiles.direct-r2.js`, `node test/studyfiles.js`.

## 3. Up ảnh THẲNG từ trình duyệt (Cloudinary duyệt → GitHub) — không qua máy chủ
Áp dụng cho: ảnh câu hỏi trắc nghiệm (`/admin/quiz/upload-image`), ảnh trong flashcard, ảnh viết tay / PDF→ảnh của bài tự luận (`/submissions/drawing-upload`).

```
init    POST <base>/direct-init     máy chủ ký sẵn tham số upload từng tài khoản Cloudinary (api_secret KHÔNG xuống trình duyệt; `moderation` do máy chủ ấn định)
upload  trình duyệt → api.cloudinary.com/v1_1/<cloud>/image/upload   (type private, duyệt đồng bộ)
verify  POST <base>/direct-verify   máy chủ HỎI LẠI Cloudinary Admin API (không tin lời trình duyệt) → XOÁ bản Cloudinary → nếu TẤT CẢ tài khoản duyệt mới cấp token tạm GitHub App
put     trình duyệt → api.github.com/repos/…/contents/<path>   (token tạm 1 giờ, 1 repo, Contents:write)
done    POST <base>/direct-done     máy chủ đọc lại file, so kích thước + MD5(etag Cloudinary) với ảnh đã duyệt; khác → XOÁ file + 422 IMAGE_MISMATCH
```
- Code: `services/directImageService.js` (logic) · `controllers/directImage.controller.js` (quiz + drawing) · `public/js/directImage.js` (trình duyệt, `MnhaDirectImage.run`) · 3 nơi gọi: `public/js/quizEditor.js`, `public/js/flashcardForm.js`, `views/student/lesson.pug` (2 chỗ).
- Quiz: link raw `cache/image/<ts>.<ext>` · Drawing: file tạm `drawing-uploads/<userId>/<uploadId>.<ext>` + token HMAC y như luồng cũ (`submission.controller` không đổi).
- **Tự quay về luồng cũ** (ảnh đi qua máy chủ, `controllers/quizImageUpload.controller.js` / `drawingUpload.controller.js` — GIỮ NGUYÊN, đừng xoá) khi: chưa nhập GitHub App, Cloudinary/GitHub/CORS/token lỗi, `MOD_UNVERIFIED`. **Dừng hẳn** (không quay về) khi 422 `SENSITIVE_IMAGE` / `IMAGE_MISMATCH`, 413, 429.
- Điều kiện chạy thẳng: GitHub App đã nhập ở `/connect` (hoặc `GITHUB_APP_*`) + ≥ 1 tài khoản Cloudinary có add-on moderation. Cloudinary nhập ở `/connect` → mục **Cloudinary** (giống GitHub App).
- Biến môi trường: `IMAGE_DIRECT=off` (hoặc `GH_DIRECT=off` / `STUDYFILE_DIRECT=off`) tắt up thẳng · `IMAGE_DIRECT_TRUST_CLIENT_MODERATION=1` chỉ bật nếu Admin API của Cloudinary không trả trạng thái duyệt (tin kết quả trình duyệt báo, vẫn kiểm ảnh có thật + etag) · `IMAGE_DIRECT_STRICT_HASH=off` bỏ so MD5 (chỉ so kích thước + magic bytes) · `CLOUDINARY_INDEX_PATH` đổi nơi lưu · `CLOUDINARY_API_BASE` (test).
- Giới hạn Vercel 4.5MB không còn áp dụng cho luồng thẳng (ảnh tối đa `CLOUDINARY_MAX_BYTES`, mặc định 10MB); luồng cũ vẫn nén ≤ 3MB.
- **CHƯA kiểm thử với Cloudinary / GitHub thật** (sandbox không có mạng, test dùng fetch giả): 2 giả định cần xác nhận trên web thật — (1) `GET /resources/image/private/<id>?moderation=true` trả `moderation[]` hoặc `moderation_status`; (2) `etag` của ảnh = MD5 file gốc. Sai (1) → log `kết quả kiểm duyệt "missing"` và web tự dùng luồng cũ (an toàn, chỉ mất lợi ích) → bật `IMAGE_DIRECT_TRUST_CLIENT_MODERATION=1` nếu muốn. Sai (2) → log `ẢNH KHÔNG KHỚP … md5=` → đặt `IMAGE_DIRECT_STRICT_HASH=off`.
- Bảo mật cần nhớ: token tạm ghi được MỌI đường dẫn trong repo (quyền Contents:write của cả repo) trong 1 giờ — chỉ cấp sau khi ảnh đã được duyệt, và người nhận là admin (quiz) / người đã đăng nhập (drawing, giới hạn 12 ảnh/10 phút). Đây là cùng mức rủi ro với up Slide thẳng GitHub.

### 3b. Ảnh câu hỏi MÃ HOÁ (không kiểm duyệt) — nút thứ 2 ở `/admin/quiz/new|edit`
Mỗi câu / chùm có **2 nút**: `⬆ Tải ảnh lên (kiểm duyệt)` (MẶC ĐỊNH, luồng mục 3) và `🔒 Tải ảnh lên (mã hoá)`.
- Mã hoá: trình duyệt nén (≤ 3MB trên Vercel) → xin khoá `POST /admin/quiz/upload-image/enc-key {salt}` → tự mã hoá AES-256-GCM → `POST /admin/quiz/upload-image/enc {data}` → máy chủ giải mã thử (đúng GCM + đúng là ảnh) rồi ghi `cache/image/<ts>.enc` lên GitHub → link raw điền vào ô link ảnh. KHÔNG qua Cloudinary.
- Định dạng: `"QIM1" | salt(16) | iv(12) | tag(16) | ciphertext`, AAD = "QIM1", khoá = HKDF(ENCRYPTION_MASTER_KEY, salt, "luyen-thi-cntt:quiz-image:v1") (INFO riêng, khoá này không mở được slide/tài liệu). Code: `services/quizImageCryptoService.js`, 3 hàm cuối của `controllers/quizImageUpload.controller.js`, route trong `routes/quiz.js`.
- Xem ảnh: `public/js/quizEncImage.js` (nạp ở `views/layout.pug`) theo dõi mọi `<img>` có link `…/cache/image/*.enc` → `POST /api/quiz-image/keys {salts}` (cần đăng nhập + được duyệt) → giải mã bằng Web Crypto → gán blob. Chạy ở trang làm bài, xem lại, kết quả, xem trước của trình soạn — không cần sửa từng nơi hiển thị.
- `GET /admin/quiz/upload-image/config` trả thêm `encEnabled` (= GitHub đã cấu hình + `ENCRYPTION_MASTER_KEY` hợp lệ). Đổi `ENCRYPTION_MASTER_KEY` thì mọi ảnh `.enc` cũ không giải mã được.
- Ảnh mã hoá đi qua máy chủ dạng base64 (chưa up thẳng GitHub như luồng kiểm duyệt) nên vẫn bị trần Vercel 4.5MB → trình duyệt nén ≤ 3MB.
- Test: `node test/quiz-image-enc.js`. CHƯA thử trên web thật (pug / trình duyệt thật / GitHub thật).

## 4. Bẫy đã gặp / lưu ý
- `.json` luôn ở repo chính; ảnh/PDF có thể ở repo `-1`, `-2…` (githubPool). Với ảnh up thẳng, link raw dùng đúng repo trong phiếu `done` (không đoán lại bằng `repoForSync`).
- Route `/admin/quiz/upload-image/direct-*` và `/submissions/drawing-upload/direct-*` phải đứng TRƯỚC `/:id`, `/:lessonId`.
- File `.pug` không chạy thử được trong sandbox (không có `pug`): sau khi sửa view, kiểm tra thụt lề cẩn thận và nhờ chủ dự án mở thử trang `/connect`.

## 5. Lịch sử thay đổi
- **Up ảnh thẳng Cloudinary → GitHub** (mục 3): thêm `directImageService`, `directImage.controller`, `directImage.js`, `cloudinaryStore` (nhập Cloudinary ở `/connect`), 3 route direct-* ×2, sửa 4 nơi gọi ở trình duyệt, view admin Cloudinary hiện nguồn "Nhập ở /connect", test `direct-image.js` + `direct-image.client.js`.
- **Fix mất link ảnh sau khi up ảnh rồi Lưu** (`public/js/quizEditor.js`): `syncTextareasToState` trước đây so ô dán với text lúc mở form, nên up ảnh (chỉ đổi `state`) xong bấm Lưu thì bị parse lại từ ô dán cũ → đè mất link ảnh (cả `/admin/quiz/new` lẫn `/admin/quiz/:id/edit`). Nay có cờ `taDirty[k]` (chỉ true khi người dùng gõ vào ô dán; reset khi Chuyển/Xuất/sync) + `keepImages()` giữ link ảnh nếu phải parse lại. Máy chủ (`buildQuiz`/`parsePart`) không lỗi. Flashcard không bị (ảnh chèn thẳng vào ô nội dung). CHƯA thử trên web thật.
- **Ảnh câu hỏi mã hoá** (mục 3b): thêm nút `🔒 Tải ảnh lên (mã hoá)` cạnh nút kiểm duyệt (mặc định vẫn kiểm duyệt); thêm `quizImageCryptoService`, `quizEncImage.js`, 3 route (`enc-key`, `enc`, `/api/quiz-image/keys`), `test/quiz-image-enc.js`; sửa `quizEditor.js`, `quiz-form.pug`, `layout.pug`, `quiz-form.css`.
