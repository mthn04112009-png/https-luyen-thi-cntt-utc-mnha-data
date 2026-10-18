# Ứng dụng Flashcards

## Đường dẫn
| URL | Ai dùng | Mô tả |
|---|---|---|
| `/apps` | mọi tài khoản đã duyệt | Danh sách ứng dụng được cấp quyền. Không có → "Không có ứng dụng nào được cấp quyền". |
| `/flashcards` | có quyền | 2 nút: **Dashboard** (chỉ admin) và **Môn học** |
| `/flashcards/subjects` | có quyền | Chọn môn (sinh viên chỉ thấy môn có flashcard công khai) |
| `/flashcards/subjects/:id` | có quyền | Các bộ flashcard của môn (bố cục giống `/subjects/:id`) |
| `/flashcards/study/:id` | có quyền | Học: 🃏 Thẻ học · ✍️ Luyện tập (4 cấp) · 📝 Kiểm tra |
| `/flashcards/dashboard` | admin | Danh sách, công khai/ẩn, sửa, xoá |
| `/flashcards/dashboard/new`, `/:id/edit` | admin | Tạo / sửa |

**Quyền** giống Môn học: admin default thấy tất cả; admin user_key chỉ thấy/sửa của tổ chức mình;
sinh viên thấy bộ **đã công khai** thuộc môn họ được xem (`userKeyService.getContentScope`).
Ứng dụng Flashcards hiện với sinh viên khi họ có ít nhất 1 bộ thẻ xem được; admin luôn thấy.

## Lưu trữ
`subjects/<slug-môn>/flashcards/<slug-flashcard>_<timestamp>.json` trên GitHub
(RAM chỉ giữ chỉ mục: tiêu đề, chế độ, ngôn ngữ, số thẻ… — thẻ nằm trong file và đọc khi học).

```json
{ "type":"flashcard", "flashcardId":"…", "title":"Unit 1", "slug":"unit-1", "subjectSlug":"tieng-anh-12",
  "description":"", "mode":"language|theory", "language":"en-US", "cardCount":2, "isPublished":true,
  "createdBy":"…", "createdAt":"…", "updatedAt":"…",
  "cards":[ { "id":"c1", "front":"admire", "ipa":"ədˈmaɪə", "back":"ngưỡng mộ", "image":"" } ] }
```

## Định dạng nhập
```
+) admire                     ← từ ngoại ngữ (Học lý thuyết: câu hỏi)
https://raw.githubusercontent.com/…   ← ảnh (tuỳ chọn, ngay dưới dòng +) — dùng nút "Thêm ảnh")
++) ədˈmaɪə                   ← phiên âm (chỉ Học ngoại ngữ, tuỳ chọn)
=> ngưỡng mộ                  ← nghĩa tiếng Việt (Học lý thuyết: câu trả lời)
```
Mỗi thẻ cách nhau một dòng trống; nội dung có thể nhiều dòng; `\n` = xuống dòng; công thức toán dùng `$...$`.
Prompt chuyển đổi bằng AI có sẵn ở cột phải trang tạo/sửa (tự đổi theo hình thức học).

## Nghe & Đọc (chỉ Học ngoại ngữ)
Dùng Web Speech API của trình duyệt (khuyên dùng Chrome/Edge): **Nghe** = `speechSynthesis`,
**Đọc** = `SpeechRecognition`; ngôn ngữ chọn một lần cho cả bộ thẻ. Không cần khoá API.

## Kiểm thử
`node test/flashcards.js` (lưu trữ GitHub) · `node test/run.js` (store chung).
