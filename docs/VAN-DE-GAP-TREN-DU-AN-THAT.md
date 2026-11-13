# Việc còn tồn đọng (rút ra từ lần đưa my-company vào dự án web96photobooth_onl)

Cập nhật 2026-11-13. Các lỗi mức 1-2 và đề xuất B1-B3, B5 đã sửa xong ở bản gốc nên đã bỏ khỏi file này;
xem lịch sử git nếu cần đọc lại phân tích cũ. Chỉ giữ những gì **chưa xong** hoặc cần chủ quyết.

---

## Đã kiểm chứng (ghi lại để khỏi làm lại)

- **Clone sạch**: 17/17 skill nguyên vẹn, bản sửa `.gitignore` hoạt động. Sau khi commit thì chạy lại một lần `git clone ... && npm install && npm run doctor` cho chắc.
- **`allowed_commands` với agent thật**: mẫu `node tests/*` khớp đúng (thử với haiku). Cú pháp khớp theo tiền tố đã ghi ở README.
- **Đường cơ sở test đỏ có sẵn**: đã làm. `npm run baseline [-- --timeout <giây>]` chạy các lệnh test/typecheck/verify/lint của hồ sơ
  rồi in khối `known_failures:` để dán vào `local/project.md`; khối này được đưa vào lời giao việc để agent không sửa lỗi không phải của mình.
  Lệnh từ chối chạy nếu thư mục dự án không có `package.json` (tránh ghi nhầm "đỏ" do sai thư mục).
- **Worktree sạch**: typecheck và test chạy được. `test:core` trên web96 chết với cùng lỗi Node 24/Windows (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`, mã 127)
  có sẵn ở nhánh gốc, không do công cụ. **`build` của Next.js hỏng trong worktree** vì `node_modules` là junction (Turbopack và webpack đều không resolve qua junction),
  nên mẫu hồ sơ do `init` sinh ra đã bỏ `build` khỏi `allowed_commands` với dự án Next.js. Hồ sơ web96 hiện có vẫn còn `build` (chưa sửa, chủ quyết).

---

## Còn lại

### 1. Skill `ponytail-*` (chủ quyết)

Thư viện chỉ có `ponytail`. Dự án web96 còn có `ponytail-review`, `ponytail-audit`, `ponytail-debt`, `ponytail-gain`, `ponytail-help`.
`ponytail-review` hợp với `security-reviewer` hoặc Trưởng nhóm. Phải tải về khu cách ly, đọc và duyệt rồi mới `npm run skills add ...`.
Chưa kiểm nguồn `DietrichGebert/ponytail/skills/ponytail-review` có tồn tại không. Phiên làm việc tự động đã bị chặn khi tải mã bên thứ ba chưa duyệt,
nên bước tải về cần chủ tự chạy (hoặc cho phép rõ ràng).

### 2. Dọn `local/project.md`

`local/project.md` là hồ sơ riêng của web96 nằm trong bản gốc. Nội dung đã lưu thành ví dụ ở `docs/vi-du/`,
nên file này có thể xóa. Chủ đã quyết giữ lại lúc này.
