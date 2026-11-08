# Thêm đội tự ghi báo cáo mỗi lần đẩy

- Ngày push: 2026-11-08
- Nhánh: `master`
- Kho: https://github.com/tuan2304/my-comany
- Số commit: 1
- Số file thay đổi: 16

## Đã làm gì
- Thêm đội Báo cáo (`teams/report`) gồm Thảo làm trưởng nhóm và Mai làm người viết báo cáo, mỗi lần đẩy lên GitHub sẽ có một báo cáo.
- Thêm lệnh `npm run push`: đẩy code, viết báo cáo theo vai trò của Mai, chỉ commit tệp báo cáo rồi đẩy lần nữa. Lần đẩy chỉ chạm vào `reports/` thì bỏ qua.
- Báo cáo được lưu theo `reports/<năm-tháng>/<việc-đã-làm>.md`.
- Văn phòng giờ có 8 đội với 20 người; đội thứ 7 đặt ở tầng 2.
- Thêm `folders.reports` vào bản nháp khởi tạo, và cập nhật README.

## Ảnh hưởng
Mỗi lần đẩy code sẽ có một báo cáo ngắn để chủ dự án đọc mà không cần biết git. Văn phòng ảo có thêm một đội và tầng 2 được dùng đến.

## Cần chú ý
- Dữ liệu không có kết quả chạy test. Các tệp test đã được sửa, nhưng chưa thấy kết quả nào xác nhận chúng pass.
- Bốn tệp trong `src/` chỉ thay đổi một dòng mỗi tệp. Dữ liệu không cho biết nội dung thay đổi là gì.
- Dữ liệu không ghi cách xử lý khi commit báo cáo hoặc lần đẩy thứ hai thất bại.

## Các commit

- `c3815a1` Add Report team and push-report script; drop KE-HOACH.md comments (tuan2304, 2026-11-08)

## Thay đổi theo thư mục

| Thư mục | File | Dòng thêm | Dòng xóa |
|---|---:|---:|---:|
| scripts | 1 | 227 | 0 |
| tests | 4 | 135 | 9 |
| teams | 3 | 60 | 0 |
| reports | 1 | 42 | 0 |
| (thư mục gốc) | 2 | 13 | 2 |
| src | 4 | 4 | 4 |
| server | 1 | 1 | 0 |

## File thay đổi

- `package.json` +1 -0
- `README.md` +12 -2
- `reports/2026-11/lam-moi-anh-chup-va-gif-huong-dan.md` +42 -0
- `scripts/push-report.mjs` +227 -0
- `server/project.mjs` +1 -0
- `src/components/EpicForm.tsx` +1 -1
- `src/office/flow.ts` +1 -1
- `src/office/layout.ts` +1 -1
- `src/office/status.ts` +1 -1
- `teams/report/lead.md` +19 -0
- `teams/report/reporter.md` +27 -0
- `teams/report/team.md` +14 -0
- `tests/epics.test.mjs` +2 -2
- `tests/office-floor.test.mjs` +9 -6
- `tests/push-report.test.mjs` +116 -0
- `tests/teams-skills.test.mjs` +8 -1
