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
Mọi file đều **mã hoá AES-256-GCM**. Khi up, **trình duyệt tự mã hoá** (Web Crypto, `public/js/studyFileForm.js`); khoá từng khung = HKDF(`ENCRYPTION_MASTER_KEY`, salt) do server cấp qua `POST …/dashboard/upload-keys` (khoá gốc không rời server). Định dạng `SLD2` không đổi nên file cũ giải mã y như trước (`services/slideCryptoService.js`). Khi xem/tải, server giải mã từng
file-phần rồi **nối liền mạch** thành file gốc. RAM chỉ giữ chỉ mục (`models/Slide.js`, `models/Document.js` ← `githubStore.js`).
JSON bản đầu (chỉ có `pdfFile`/`pdfSize`) vẫn đọc được.

## Giới hạn
- Mặc định tối đa **100MB / file** (đổi bằng biến môi trường `STUDYFILE_MAX_MB`, tối đa 200).
- Mỗi file lưu trên GitHub ≤ **23MB**.

## Vì sao up/xem đi theo từng phần (chạy được trên Vercel)
Vercel cắt request/response > 4.5MB, và mỗi function chạy tối đa 60s (`vercel.json`).
1. **Up** (`public/js/studyFileForm.js`): cắt file thành phần 2MB → xin khoá ở `POST …/dashboard/upload-keys` (lô ≤ 16 salt) → **mã hoá ngay trong trình duyệt** → `POST …/dashboard/upload-chunk?index=&total=&ext=` (body nhị phân `application/octet-stream`; server KHÔNG mã hoá, chỉ kiểm tra cấu trúc rồi lưu tạm thành blob GitHub; khung 0 được giải mã thử để bắt sớm khoá/định dạng sai)
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

## Giải mã tại trình duyệt (tiết kiệm băng thông Vercel)

- `ctrl.study` nhúng `direct` (token 2 giờ + URL raw GitHub của từng file-phần (đúng repo chứa file: repo chính hoặc <repo>-1, -2… theo `githubService.repoFor`) + `keyUrl`) vào trang xem.
- Trình duyệt tải thẳng file mã hoá từ `raw.githubusercontent.com` (repo public), đọc header từng khung,
  `POST {base}/keys/:sid { token, salts }` → server kiểm tra quyền + token rồi trả **khoá riêng của từng khung**
  (`deriveFrameKeys`, HKDF-SHA256 từ `ENCRYPTION_MASTER_KEY`; khoá gốc không rời server).
- **Vừa tải vừa giải mã** theo luồng (`response.body`): đủ một khung (~2MB) thì xin khoá + giải mã bằng Web Crypto
  (AES-256-GCM, AAD = "SLD2"+index+total) rồi ghi thẳng vào mảng đã cấp sẵn đúng kích thước file — không giữ cả file mã hoá, không ghép lần cuối.
- File > 30MB: không giữ bản giải mã để dùng lại, PDF.js nhận thẳng mảng (không `slice`) → RAM ≈ 1× kích thước file.
- Nút "Tải xuống": Chrome/Edge máy tính ghi **thẳng từng khung xuống đĩa** (`showSaveFilePicker`, gần như không tốn RAM);
  trình duyệt khác gom thành `Blob`; file nhỏ đang có sẵn trong RAM thì dùng lại.
- Mọi lỗi (GitHub/CORS/token hết hạn/trình duyệt cũ) → tự quay về đường cũ `GET {base}/file/:sid?chunk=i` (server giải mã).
- Token gắn tài khoản + file (HMAC), hết hạn sau 2 giờ; mỗi lần cấp khoá ghi `console.log` (xem ở Vercel Logs).

## Bảo mật khoá (cập nhật)
- `POST {base}/keys/:sid` chỉ cấp khoá cho salt **thuộc đúng file đó**: server quét header các khung (Range request lên raw GitHub, dự phòng đọc cả file-phần), cache RAM 30 phút. Salt lạ → 403 (log `TỪ CHỐI`). Lý do: repo public nên salt của mọi file đều đọc được.
- Giới hạn tần suất (`express-rate-limit`, theo tài khoản): `/keys/:sid` 300 lần/phút, `/dashboard/upload-keys` 120 lần/phút.
- Đường cũ "server mã hoá" (`upload-chunk` nhận JSON `{data:base64}`) mặc định TẮT → trả 410; bật tạm bằng biến môi trường `ALLOW_SERVER_ENCRYPT=1`.
- Up qua "web kết nối" (data node): khung mã hoá gửi thẳng web kết nối như trước; xin khoá luôn ở web chính. **`ENCRYPTION_MASTER_KEY` của web chính và web kết nối phải giống nhau.**
- Test: `node test/studyfiles.browser-encrypt.js`.

## Up THẲNG lên Cloudflare R2 (không tốn băng thông Vercel)

Luồng GitHub ở trên: mỗi byte file đi qua Vercel 2–3 lần (khung → server → tải lại blob để ghép → ghi file-phần lên GitHub). Khi cấu hình R2, up đi **thẳng từ trình duyệt lên R2**:

1. `POST …/dashboard/direct-init` (JSON nhỏ): server chia file-phần (cùng `groupFrames`) và cấp **URL PUT ký sẵn** cho từng file-phần (`services/r2Service.js`; chỉ đúng 1 key, hết hạn 2 giờ, khoá R2 không rời server).
2. Trình duyệt mã hoá khung (`SLD2`, y hệt cũ), ghép `magic + khung` thành từng file-phần ≤ 23MB rồi `PUT` thẳng lên R2.
3. `POST …/dashboard/direct-done`: server HEAD từng file-phần, đọc vài chục byte header, **giải thử khung 0** (bắt sai khoá / không phải PDF/PPTX) rồi trả chữ ký HMAC (thêm `'r2'`) → `POST …/dashboard` ghi JSON như cũ, `parts[i].store = "r2"`.
4. Xem/tải: `buildDirect` trả URL R2 (public nếu có `R2_PUBLIC_BASE`, không thì URL GET ký sẵn 6 giờ); trình duyệt tải + giải mã như với GitHub. Đường dự phòng `?chunk=i` đọc từ R2. Xoá / thay file cũng xoá object R2.

Chỉ file mới up sau khi bật R2 nằm ở R2; file cũ trên GitHub vẫn xem/xoá bình thường (mỗi file-phần tự ghi nơi lưu).

**Biến môi trường (Vercel + `.env.local`):** `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (thiếu 1 biến → dùng luồng GitHub cũ); tuỳ chọn `R2_ENDPOINT`, `R2_PUBLIC_BASE`, `R2_REGION`; `STUDYFILE_DIRECT=off` để tắt.
Token R2 chỉ cần quyền *Object Read & Write* trên đúng bucket này.

**Bắt buộc bật CORS cho bucket** (R2 → bucket → Settings → CORS policy):
```json
[{ "AllowedOrigins": ["https://ten-mien-cua-ban.vercel.app"], "AllowedMethods": ["GET", "PUT", "HEAD"],
   "AllowedHeaders": ["*"], "ExposeHeaders": ["Content-Length", "Content-Range", "ETag"], "MaxAgeSeconds": 3600 }]
```
Chưa bật CORS / R2 lỗi: trình duyệt báo "⚠ Không up thẳng lên R2 được…" rồi tự up lại bằng luồng GitHub cũ (vẫn chạy, nhưng tốn băng thông).

Test: `node test/studyfiles.direct-r2.js`.

## Up THẲNG lên GitHub bằng token tạm (GitHub App) — khi không có R2

Không cấu hình R2 nhưng đã nhập **GitHub App** ở `/connect` (mục *GitHub App*, private key được **mã hoá** lưu ở repo chính `v-s/github-app.json`; hoặc đặt `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID` trong `.env`):

1. `POST …/dashboard/direct-init` → `mode: 'github'` + `gh` = {owner, repo, branch, **token tạm**} của repo đang nhận file (`githubPool.active`) + kế hoạch các file-phần.
   Token là *installation token*: **hết hạn sau 1 giờ, chỉ 1 repo, chỉ Contents:write**. PAT thật (`GITHUB_TOKEN`) và private key không bao giờ xuống trình duyệt.
2. Trình duyệt mã hoá khung (`SLD2`), ghép `magic + khung` thành từng file-phần ≤ 23MB rồi `POST /git/blobs` **thẳng lên api.github.com** (không qua Vercel).
3. `POST …/dashboard/direct-done` {shas:[…]} (JSON vài trăm byte): server gom các blob vào **một commit** (`githubService.commitFiles`), kiểm kích thước + header (Range trên raw GitHub, dự phòng đọc blob theo sha), **giải thử khung 0**, rồi trả chữ ký HMAC như `upload-part` (không có `store`).
   Sai kích thước / sai định dạng / không phải PDF-PPTX → xoá file-phần vừa commit và báo lỗi.
4. `create` / `update` ghi JSON như cũ. Xem/tải không đổi (file nằm ở GitHub như luồng thường).

Lỗi (token hết hạn, hết hạn mức, CORS, mạng) → trình duyệt báo "⚠ Không up thẳng được…" rồi tự up lại bằng luồng cũ qua máy chủ. Có R2 thì R2 được ưu tiên.
Tắt đường GitHub trực tiếp: `GH_DIRECT=off` (hoặc `STUDYFILE_DIRECT=off` để tắt mọi up thẳng).

Cách tạo App: GitHub → Settings → Developer settings → GitHub Apps → New (tắt Webhook), *Repository permissions → Contents: Read and write*; tạo private key `.pem`; **Install App** lên tài khoản chứa repo, chọn *All repositories* (để repo `-1`, `-2`… cũng được cấp token).

Test: `node test/studyfiles.direct-gh.js`.

## Hướng dẫn làm file PPTX cho trình chiếu (giọng đọc, âm thanh, …)
Bản đầy đủ nằm ở đầu `public/js/pptxPlayer.js`; bản rút gọn hiện thành khung **📘 Hướng dẫn** trên trang up Slide (`/slides/dashboard/new`, `views/studyfiles/form.pug`, chỉ hiện ở mục có `pptx` trong `exts`).
- **Lời giảng tự đọc**: viết trong *Ghi chú* của slide, mỗi đoạn bắt đầu `[Mở slide – …]` hoặc `[Click N – …]`; thêm `| vi|en|zh|ja|…` cuối ngoặc để chỉ rõ tiếng. Đọc bằng giọng TTS của trình duyệt, thiếu giọng thì dùng Google Dịch (`translate_tts`). Nút 🔊/🔇 bật–tắt.
- **Nút đọc to** trên hình ảnh: `title="tts:{JSON}"` — `{"t":"sheep","r":0.9}`, `"v":"m|f"`, `"lang":"zh"`, `{"seq":[…]}`, `"ph":"ə"` (âm IPA tự tổng hợp), `"label"`.
- **Âm thanh**: hình có hyperlink tới tệp trực tiếp `.mp3 .wav .ogg .oga .m4a .aac` → phát tại chỗ. **YouTube**: hình có hyperlink YouTube → phát ngay trong slide.
- Chuyển cảnh / hiệu ứng / tự chuyển slide: làm bằng PowerPoint như bình thường.
- Chưa hỗ trợ: radar/scatter/bubble/3D, SmartArt, video & âm thanh nhúng trong file, WordArt; `.ppt` chỉ tải xuống.
- Nếu đặt `PPTX_CONVERTER_URL`, form tự đổi PPTX → PDF khi up → mất hiệu ứng / lời giảng / nút phát âm.
