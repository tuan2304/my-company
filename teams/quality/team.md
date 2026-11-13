---
name: Team Chất lượng
lead: Phúc
members:
  - { name: Phúc, role: lead }
  - { name: Quân, role: qa, strengths: [tích-hợp, api] }
  - { name: Giang, role: qa, strengths: [e2e, giao-diện] }
  - { name: Tú, role: qa, strengths: [hồi-quy, dữ-liệu-kiểm-thử] }
  - { name: Bảo, role: qa, strengths: [hiệu-năng, kiểm-thử-tải] }
  - { name: Oanh, role: qa, strengths: [xác-nhận-lỗi, kịch-bản-người-dùng] }
limits:
  max_active_per_member: 1
  max_queue_per_member: 2
  max_revisions: 2
  max_subtasks: 6
---

Team Chất lượng viết và chạy test tích hợp, e2e trên kết quả đã ghép của các team khác, và báo lỗi tìm được. Thư mục cụ thể của team nằm trong hồ sơ dự án (local/project.md, mục `folders.quality`); QA chỉ sửa test, không sửa code chính.
