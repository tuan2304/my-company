---
name: Team Bảo mật
lead: Hải
# Team chỉ ghi tài liệu: hồ sơ dự án chưa khai folders cho team này thì nhân viên KHÔNG ghi được file nào.
requires_folders: true
members:
  - { name: Hải, role: lead }
  - { name: Trinh, role: security-reviewer, strengths: [review-mã, xác-thực, phụ-thuộc] }
limits:
  max_active_per_member: 1
  max_queue_per_member: 2
  max_revisions: 2
  max_subtasks: 4
---

Team Bảo mật rà soát code đã ghép của các team khác tìm lỗ hổng (xác thực, phân quyền, dữ liệu vào, lộ bí mật, cấu hình mặc định nguy hiểm, phụ thuộc rủi ro) và viết báo cáo vào thư mục báo cáo bảo mật của dự án. Team này KHÔNG sửa code chính: lỗi tìm được ghi rõ (vị trí, cách tái hiện, mức độ, cách sửa gợi ý) để Giám đốc giao việc sửa. Việc rà soát chạy trên kết quả đã ghép nên phải khai depends_on các việc của Backend và Frontend. Thư mục cụ thể của team nằm trong hồ sơ dự án (local/project.md, mục `folders.security`).
