# Đề xuất thêm và tối ưu my-company (rút ra từ dự án web96photobooth_onl)

Ngày ghi: 2026-11-11. Đọc kèm [VAN-DE-GAP-TREN-DU-AN-THAT.md](VAN-DE-GAP-TREN-DU-AN-THAT.md) (danh sách lỗi).
File này nói về những thứ **nên thêm hoặc đổi** ở bản gốc, và những thay đổi đã làm riêng ở bản trong dự án
mà bản gốc chưa có. Chưa có mục nào được áp dụng vào code của bản gốc.

---

## A. Thay đổi đã làm ở bản trong dự án web96, bản gốc CHƯA có

Bản trong dự án: `d:\web96photobooth_onl\my-company` (clone riêng, có `.git` riêng).

| # | Thay đổi | Ở đâu | Cần đưa về gốc? |
|---|---|---|---|
| A1 | Đổi `data/` thành `/data/`, `local/` thành `/local/` | `.gitignore` | **Có**, xem mục 1.1 trong file lỗi |
| A2 | Chép lại thư mục `data/` của skill `ui-ux-pro-max` (đúng commit `b7d5353`, hash khớp `skills.lock`) | `skills/library/ui-ux-pro-max/data/` | **Có**: commit thư mục này lên gốc |
| A3 | Hồ sơ dự án đã điền đủ | `local/project.md` | Không (riêng dự án). Bản mẫu đã lưu ở [vi-du/project.web96photobooth.md](vi-du/project.web96photobooth.md) |
| A4 | Thêm `ponytail` cho `devops-engineer` bằng cách ghi đè cả team devops | `local/teams/devops/` | Tùy, xem mục B1 |

Trạng thái sau các thay đổi trên (ở bản trong dự án): `npm run doctor` 0 lỗi, 17/17 skill nguyên vẹn.
Chưa chạy thử một lần agent thật.

---

## B. Đề xuất cho bản gốc

### B1. Nạp ponytail cho `devops-engineer` mặc định (ĐÃ KIỂM CHỨNG hiện trạng, đề xuất là ý kiến)

Hiện trạng, đo bằng chính hàm `composeSkillPack` trên 15 vai trò (không tính Giám đốc):

| Vai trò | Nạp ponytail |
|---|---|
| backend-dev, frontend-dev | **Có** (đã khai trong file vai trò) |
| devops-engineer | Không |
| qa, designer, security-reviewer, reporter, các Trưởng nhóm | Không |

- `devops-engineer` viết CI, cấu hình, Dockerfile: cũng là "viết code", ponytail hợp lý. Đề xuất thêm một dòng
  `- ponytail` vào `teams/devops/devops-engineer.md` ở bản gốc để mọi dự án đều có.
- **Không** nên thêm cho `qa` một cách mặc định: ponytail ưu tiên thay đổi nhỏ nhất, dễ xung đột với việc
  viết đủ test. Nếu muốn thử, làm ở một dự án trước và đo kết quả.
- Các vai trò chỉ đọc/ghi báo cáo (security, reporter, designer, lead) không cần.

### B2. Cho phép ghi đè MỘT vai trò thay vì cả team (ĐÃ KIỂM CHỨNG hiện trạng)

- `server/teams.mjs` (hàm `loadTeams`): thư mục `local/teams/<id>/` **thay thế cả team** cùng id
  (`teams[index] = team`). Muốn chỉ thêm một skill cho một vai trò, phải sao cả thư mục team
  (`team.md`, `lead.md`, file vai trò) vào `local/teams/`.
- Hậu quả: bản sao đó **không tự cập nhật** khi bản gốc sửa team; dễ trôi lệch âm thầm.
- **Đề xuất:** cho phép `local/teams/<id>/<vai-trò>.md` ghi đè riêng file vai trò, hoặc thêm khóa trong hồ sơ
  dự án, ví dụ:
  ```yaml
  role_skills:
    devops-engineer: [ponytail]   # thêm vào skills mặc định của vai trò, không thay thế
  ```
  Cách thứ hai nhỏ hơn: `composeSkillPack` (`server/skills.mjs`) đã gộp `role.skills` với `skillSet`, chỉ cần
  thêm nguồn thứ ba từ hồ sơ dự án.

### B3. Lệnh xem "vai trò nào nạp skill nào" (ĐÃ KIỂM CHỨNG cách làm)

- Để kiểm tra việc thêm ponytail, tôi phải viết một đoạn `node -e` gọi `loadConfig`, `loadTeams`, `loadProject`,
  `composeSkillPack` rồi in kết quả từng vai trò (nạp gì, bỏ gì và lý do).
- **Đề xuất:** biến nó thành lệnh `my-company skills roles`, và để `doctor` cảnh báo khi một vai trò khai
  skill mà bị bỏ (chưa duyệt, thiếu `SKILL.md`, khác hash). Hiện `composeSkillPack` trả về `skipped` nhưng
  chỉ người gọi hàm mới thấy.

### B4. Bổ sung các skill ponytail còn lại vào thư viện (CHƯA KIỂM CHỨNG nguồn)

- Dự án web96 có `ponytail-review`, `ponytail-audit`, `ponytail-debt`, `ponytail-gain`, `ponytail-help` trong
  `.agents/skills/`. Thư viện my-company chỉ có `ponytail` (nguồn `DietrichGebert/ponytail/skills/ponytail`,
  commit `96608e0`).
- `ponytail-review` hợp với `security-reviewer` hoặc Trưởng nhóm duyệt kết quả. Chưa kiểm đường dẫn nguồn
  `DietrichGebert/ponytail/skills/ponytail-review` có tồn tại không, và chưa đọc nội dung các skill này.
- **Việc cần làm:** đọc từng skill, kiểm quyền chúng đòi hỏi, rồi mới `my-company skills add` nếu duyệt.

### B5. Thư mục ví dụ hồ sơ dự án (ĐÃ LÀM)

- Đã đặt [vi-du/project.web96photobooth.md](vi-du/project.web96photobooth.md) trong `docs/vi-du/` (được git theo dõi,
  khác với `local/` bị bỏ qua). Hồ sơ này có chú thích từng mục (ý nghĩa `[]`, lệnh nên và không nên cho, `worktree_links`).
- **Đề xuất:** README trỏ tới thư mục này, và để `init` sinh bản nháp với đúng kiểu chú thích đó
  (hiện bản nháp chỉ có ví dụ ngắn bằng comment).
- Lưu ý: file ví dụ có phần "trỏ đúng dự án" (`COMPANY_PROJECT_ROOT`); phần này chỉ cần khi công cụ **không**
  nằm trong thư mục dự án.

---

## C. Việc dọn nhà ở `D:\my-company` (cần bạn quyết)

- `D:\my-company\local\project.md` là hồ sơ riêng của web96 nằm trong bản gốc dùng chung. Nội dung đã được lưu
  thành ví dụ ở B5, nên **file trong `local/` có thể xóa** để bản gốc không dính dự án cụ thể. Tôi chưa xóa.
- `D:\my-company` đang có sẵn thay đổi chưa commit trong `server/` (`config.mjs`, `doctor.mjs`, `runner.mjs`,
  `triage.mjs`, thư mục `server/engines/` chưa theo dõi). Tôi không đụng vào; nên commit hoặc tách ra trước khi
  áp dụng các đề xuất trên để dễ xem diff.

---

## Danh sách việc (cập nhật 2026-11-11, đã làm ở bản gốc, CHƯA commit)

- [x] A1, A2 = mục 1.1 của file lỗi. **Còn lại:** commit `skills/library/ui-ux-pro-max/data/` rồi thử clone sạch + `doctor`.
- [x] B1 `ponytail` đã thêm cho `devops-engineer` (không thêm cho `qa`). Kiểm bằng `npm run skills -- roles`.
- [x] B2 Chọn cách khóa `role_skills` trong hồ sơ dự án (cộng thêm, không thay thế; vai trò gõ nhầm thì doctor cảnh báo).
      Ghi chú: khóa theo id vai trò, nên `lead` áp cho Trưởng nhóm của mọi team.
- [x] B3 Lệnh `my-company skills roles` (`npm run skills -- roles`); `doctor` cảnh báo skill khai mà bị bỏ.
- [ ] B4 Chưa làm: phải tải các skill `ponytail-*` về khu cách ly, đọc và duyệt (`npm run skills add ...`). Để chủ quyết.
- [x] B5 README trỏ tới `docs/vi-du/`; bản nháp `init` có chú thích từng mục (ý nghĩa `[]`, `!`, lệnh bị bỏ, `role_skills`, `worktree_links`).
      File ví dụ web96 đã sửa theo quy tắc mới (`report`, bỏ `shared`, frontend dùng `"!src/app/api"`).
- [ ] C Chủ quyết KHÔNG xóa `local/project.md` lúc này; chưa commit.
