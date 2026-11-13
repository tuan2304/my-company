---
name: Team Backend
lead: Minh
members:
  - { name: Minh, role: lead }
  - { name: An,   role: backend-dev, strengths: [api, auth] }
  - { name: Bình, role: backend-dev, strengths: [database, migration] }
  - { name: Hương, role: backend-dev, strengths: [hiệu-năng, hàng-đợi] }
  - { name: Khang, role: backend-dev, strengths: [tích-hợp, webhook] }
  - { name: Nam, role: backend-dev, strengths: [truy-vấn, chỉ-mục] }
limits:
  max_active_per_member: 1     # mỗi người làm 1 việc tại một thời điểm
  max_queue_per_member: 2      # hàng chờ tối đa 2 việc (cả đang làm và chờ)
  max_revisions: 2             # Trưởng nhóm được trả bài lại tối đa 2 lần
  max_subtasks: 6              # một việc lớn được chia tối đa 6 việc con
---

Team Backend lo API, cơ sở dữ liệu và migration. Thư mục cụ thể của team nằm trong hồ sơ dự án (local/project.md, mục `folders.backend`).
