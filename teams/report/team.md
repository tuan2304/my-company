---
name: Team Báo cáo
lead: Thảo
# Team chỉ ghi tài liệu: hồ sơ dự án chưa khai folders cho team này thì nhân viên KHÔNG ghi được file nào.
requires_folders: true
members:
  - { name: Thảo, role: lead }
  - { name: Mai, role: reporter, strengths: [báo-cáo-push, tóm-tắt-thay-đổi] }
limits:
  max_active_per_member: 1
  max_queue_per_member: 2
  max_revisions: 2
  max_subtasks: 3
---

Team Báo cáo ghi lại những gì đã đẩy lên GitHub thành tệp Markdown trong thư mục báo cáo của dự án (hồ sơ dự án, mục `folders.report`). Mỗi lần push là MỘT tệp, tên tệp là việc đã làm (không dấu, gạch ngang), nằm trong thư mục con theo tháng: reports/<năm-tháng>/<việc-đã-làm>.md. Team này KHÔNG sửa code: chỉ đọc lịch sử git và ghi tệp báo cáo. Giao việc cho team này sau khi các team khác đã xong và đã ghép, bằng cách khai depends_on các việc đó. Khi chạy lệnh `npm run push` của công ty, phần tóm tắt trong báo cáo cũng do người viết của team này đảm nhiệm.
