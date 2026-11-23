# Nhóm người dùng + "Chỉ hiển thị với…" (nhóm / tài khoản)

## Quản lý nhóm
- Trang: `/admin/user-keys/groups` (mọi admin; mỗi admin chỉ thấy nhóm của tổ chức mình). Tạo: `/groups/new`, sửa: `/groups/:id/edit`.
- Lưu ở GitHub: `userkeys/groups/index.json` — `{ groups: [{ id, name, userKey, memberIds[], createdBy, createdAt, updatedAt }] }` (`services/groupService.js`).
- Đọc vào RAM (TTL 20s, `GROUPS_CACHE_TTL_MS`), middleware `groupService.warm` trong `server.js` nạp sẵn để lọc đồng bộ.

## Chỉ hiển thị với…
- Có ở: Đề tự luận (`/admin/lessons/:id/edit`), Đề trắc nghiệm, Tài liệu, **Slide**, **Flashcards**.
- JSON mỗi mục lưu: `visibility` (`public|private|users`), `allowedUserIds[]`, `allowedGroupIds[]`.
- Sinh viên thấy mục khi: công khai, hoặc có id trong `allowedUserIds`, hoặc thuộc 1 nhóm trong `allowedGroupIds`.
- Bộ chọn có 2 phần **👥 Nhóm** và **👤 Tài khoản** (huy hiệu riêng, chip khác màu).
- Tài khoản đã nằm trong nhóm được chọn → báo lỗi đỏ và tự bỏ tài khoản đó, chỉ giữ nhóm (client + server đều kiểm tra).
- Xoá nhóm: các mục đang dùng nhóm đó sẽ không còn ai thấy qua nhóm này (trang nhóm có cột "Đang dùng ở" và cảnh báo khi xoá).
