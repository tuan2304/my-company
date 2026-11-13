---
name: Team Thiết kế UI/UX
lead: Ngọc
# Team chỉ ghi tài liệu: hồ sơ dự án chưa khai folders cho team này thì nhân viên KHÔNG ghi được file nào.
requires_folders: true
members:
  - { name: Ngọc, role: lead }
  - { name: Vy, role: designer, strengths: [bố-cục, thiết-kế-hệ-thống, truy-cập] }
  - { name: Linh, role: designer, strengths: [luồng-người-dùng, màu-sắc, trạng-thái-thành-phần] }
  - { name: Hà, role: designer, strengths: [biểu-tượng, minh-họa] }
  - { name: Tiên, role: designer, strengths: [chuyển-động, nội-dung-giao-diện] }
limits:
  max_active_per_member: 1
  max_queue_per_member: 2
  max_revisions: 2
  max_subtasks: 4
---

Team Thiết kế viết ĐẶC TẢ thiết kế (bố cục, luồng người dùng, hệ màu và cỡ chữ, trạng thái của từng thành phần, quy tắc truy cập) dưới dạng tài liệu Markdown và token thiết kế trong thư mục thiết kế của dự án. Team này không viết code giao diện: Frontend làm theo đặc tả. Vì vậy với yêu cầu có giao diện mới, hãy giao cho Thiết kế trước và khai việc của Frontend phụ thuộc (depends_on) vào việc thiết kế. Thư mục cụ thể của team nằm trong hồ sơ dự án (local/project.md, mục `folders.design`).
