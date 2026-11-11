# Vấn đề gặp khi đưa my-company vào một dự án thật (web96photobooth_onl)

Ngày ghi: 2026-11-11. Dự án thử: `web96photobooth_onl` (Next.js, Windows 11, Node 24.14.1).
Mục đích: danh sách việc cần sửa ở **bản gốc** (repo `tuan2304/my-comany`) để dự án sau không gặp lại.

Mỗi mục ghi rõ: đã kiểm chứng hay chưa. Số dòng là của bản `D:\my-company` ngày ghi, có thể lệch sau này.

---

## Mức 1: ảnh hưởng MỌI dự án mới

### 1.1 `.gitignore` làm clone mới thiếu file của skill, `doctor` báo lỗi (ĐÃ KIỂM CHỨNG)

- **Hiện tượng:** clone về, chạy `npm run doctor` báo
  `[LỖI] Skill bị đổi hoặc thiếu: ui-ux-pro-max (nội dung đã bị đổi so với lúc duyệt)`.
- **Nguyên nhân:** `.gitignore` dòng 8-9 có `data/` và `local/` **không neo gốc**, nên khớp cả thư mục
  lồng bên trong, gồm `skills/library/ui-ux-pro-max/data/`. Trên máy tác giả thư mục có, nhưng git chỉ
  theo dõi 7 file; bản clone thiếu thư mục này nên hash khác `skills.lock`.
- **Bằng chứng:** lấy lại đúng commit đã khóa (`b7d5353...`) từ upstream, bỏ các file `excluded`: hash ra
  `6fad6438...` đúng bằng hash trong `skills.lock`. Khác biệt duy nhất là thiếu `data/`.
- **Sửa ở bản gốc:**
  1. Đổi thành `/data/` và `/local/` (chỉ neo ở gốc repo).
  2. Commit `skills/library/ui-ux-pro-max/data/` (đúng các file đã duyệt, không gồm file `excluded`).
  3. Kiểm lại bằng clone sạch: `git clone ... && npm install && npm run doctor` phải 0 lỗi.
- **Đã làm ở đâu:** chỉ ở bản sao trong dự án web96 (đổi `.gitignore` và chép lại `data/`), **chưa** ở bản gốc.

### 1.2 Danh sách thư mục RỖNG nghĩa là "sửa được mọi nơi" (ĐÃ KIỂM CHỨNG)

- **Hiện tượng:** mẫu hồ sơ sinh ra `folders` toàn `[]`. Ai đọc cũng hiểu là "chưa khai báo/không được sửa".
- **Thực tế:** `server/runner.mjs:590` lấy `allow = project.folders[team.id] ?? []`, và
  `server/path-guard.mjs` (hàm `decide`, đoạn `prefixes.length > 0`) chỉ chặn khi danh sách **không** rỗng.
  Rỗng = không chặn gì (ngoài `.env`, `.git`, file ngoài worktree).
- **Hậu quả:** `security-reviewer`, `reporter`, `designer` có công cụ Write nhưng vai trò nói "không sửa code".
  Để `[]` thì họ sửa được cả mã nguồn. Hook là lớp chặn cứng duy nhất, nên đây là lỗ hổng im lặng.
- **Sửa ở bản gốc (chọn một):**
  - Với vai trò chỉ ghi báo cáo/đặc tả: rỗng = **cấm ghi hoàn toàn**, hoặc
  - `doctor` cảnh báo khi team có vai trò Write mà `folders` rỗng, và nói rõ ý nghĩa của `[]`.
  - Đổi chú thích trong mẫu thành: "[] = KHÔNG giới hạn".

### 1.3 Khóa `reports` trong mẫu không khớp id của team (ĐÃ KIỂM CHỨNG)

- **Hiện tượng:** mẫu hồ sơ (`server/project.mjs:93`) có khóa `reports`, nhưng team báo cáo nằm ở
  `teams/report/` nên id là `report`. Guard đọc `folders[team.id]` = `folders.report`.
- **Hậu quả:** điền `reports: [reports]` mà không điền `report` thì Team Báo cáo vẫn không bị giới hạn (xem 1.2).
  Đã thử bằng `decide()`: chỉ khi thêm khóa `report` thì ghi ra ngoài `reports/` mới bị chặn.
- **Sửa:** đổi tên một trong hai cho khớp (đổi mẫu thành `report`, hoặc đổi thư mục team thành `reports`), và
  cho `doctor` cảnh báo khóa trong `folders` không khớp id team nào.

---

## Mức 2: gây khó chịu, tốn lượt agent

### 2.1 `init` đoán lệnh quá hẹp (ĐÃ KIỂM CHỨNG)

- `detectStack` (`server/project.mjs:70`) chỉ tìm script tên `install`, `test`, `lint`, `build`.
- Dự án web96 có `test:core`, `test:admin`, `typecheck`, `verify`, `cf:typecheck`, nhưng bản nháp chỉ có
  `install` và `build`, và `allowed_commands` chỉ gồm `git status, git diff, npm run build`.
  Nếu giữ nguyên, QA không chạy được test nào.
- **Sửa:** quét thêm mọi script bắt đầu bằng `test`, và `typecheck`, `verify`, `check`; đánh dấu rõ
  script nào có vẻ nguy hiểm (`deploy`, `publish`, `release`, `start`, `dev`) để KHÔNG tự đưa vào.
- Nhận diện công nghệ cũng thiếu: không thấy Cloudflare (`wrangler.jsonc`), R2 (`@aws-sdk/client-s3`).

### 2.2 Thư mục gốc dự án âm thầm là thư mục cha (ĐỌC TỪ CODE, chưa chạy `doctor` ở `D:\`)

- `server/config.mjs:32`: gốc dự án = `COMPANY_PROJECT_ROOT` hoặc `path.dirname(TOOL_DIR)`.
- README bảo clone vào `.my-company` (dấu chấm đầu). Ở dự án thử, thư mục tên `my-company` (không dấu chấm)
  nên đường dẫn trong lời nhắc (`.my-company/local/project.md`) không khớp thực tế. Còn clone ở `D:\my-company`
  thì gốc dự án thành `D:\`.
- **Sửa:** `doctor` cảnh báo khi gốc dự án không có `.git` hoặc `package.json`, hoặc là gốc ổ đĩa; và khi tên
  thư mục công cụ khác `.my-company`.
- Lỗi chính tả URL trong README: `my-comany` (thiếu một chữ `p`). Khớp với tên repo hiện tại, nên chỉ cần để ý.

### 2.3 Báo lỗi skill quá chung chung (ĐÃ KIỂM CHỨNG)

- `verifyLibrary` (`server/skills.mjs`) chỉ trả "nội dung đã bị đổi so với lúc duyệt". Không phân biệt
  **thiếu file**, **file bị sửa**, **thừa file**, nên mất thời gian truy nguyên (xem 1.1).
- **Sửa:** ghi vào `skills.lock` danh sách file kèm hash từng file; `skills verify` in ra file thiếu/đổi/thừa.

### 2.4 Khóa `shared` có trong mẫu nhưng không được dùng (ĐÃ KIỂM CHỨNG)

- `grep` toàn `server/` không thấy chỗ nào đọc `folders.shared`. Điền vào cũng không có tác dụng.
- **Sửa:** bỏ khỏi mẫu, hoặc cài đặt ý nghĩa thật (ví dụ thư mục ai cũng được sửa).

### 2.5 Khớp thư mục chỉ theo tiền tố, không có loại trừ (QUAN SÁT KHI CẤU HÌNH)

- `src/app` chứa cả `src/app/api` (của backend). Muốn tách phải liệt kê từng mục con của frontend;
  route mới ở cấp cao nhất sẽ không thuộc team nào.
- Thư mục lẫn việc của hai team (như `src/lib`) buộc phải khai trùng cho cả hai.
- **Sửa (tùy chọn):** hỗ trợ loại trừ (`!src/app/api`) hoặc quy tắc "đường dẫn dài nhất thắng".

### 2.6 Chạy một test riêng bằng `allowed_commands` (CHƯA KIỂM CHỨNG)

- Khớp theo tiền tố (`Bash(<lệnh>)` và `Bash(<lệnh> *)`), nên `npm run test:core` không cho phép `node tests/x.cjs`.
- Đã thêm mục `node tests/*` vào hồ sơ web96 để cho phép từng test riêng, nhưng **chưa chạy thử** để xác nhận
  mẫu này khớp đúng. Cần thử một lần với agent thật trước khi tin.
- **Sửa:** ghi rõ cú pháp khớp trong README/mẫu hồ sơ, kèm ví dụ đã thử.

---

## Mức 3: gợi ý cải tiến, chưa chắc là lỗi

### 3.1 Không phân biệt "test đỏ có sẵn" với "test đỏ do agent gây ra" (VẤN ĐỀ CỦA DỰ ÁN, công cụ không bắt được)

- Ở web96, `tests/print-queue-actions.cjs` đạt hết kiểm tra rồi tiến trình Node chết lúc thoát với
  `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c` (mã thoát 127), chạy riêng cũng vậy.
  Làm `npm run test:core` dừng sau khoảng 2 phút; `npm run verify` không bao giờ tới bước build.
  Đây là lỗi có sẵn của dự án (nghi liên quan SQLite thử nghiệm của Node 24 trên Windows, chưa xác nhận).
- Công cụ không biết điều đó nên agent có thể tốn lượt đi sửa lỗi không phải của mình.
- **Gợi ý:** trước khi giao việc, chạy lệnh test trên nhánh gốc để lấy "đường cơ sở" các test đã đỏ, rồi
  báo cho agent. Tạm thời đã ghi lỗi này vào mục `conventions` của hồ sơ.

### 3.2 Worktree chỉ nối `node_modules` (CHƯA KIỂM CHỨNG)

- `worktree_links` mặc định `['node_modules']`. Các file bị gitignore nhưng cần để chạy (như `.env.local`,
  thư mục sinh ra bởi `postinstall`) sẽ **không có** trong worktree của nhân viên.
- Chưa thử `npm run build` hay `npm run test:core` trong một worktree sạch nên không biết có hỏng thật không.
- **Việc cần làm:** tạo một worktree thử, chạy `build` và test; nếu hỏng thì cho `doctor` hoặc `init`
  gợi ý giá trị `worktree_links`.

---

## Danh sách việc (cập nhật 2026-11-11, đã sửa ở bản gốc `D:my-company`, CHƯA commit)

- [x] 1.1 `.gitignore` neo `/data/`, `/local/`; `skills/library/ui-ux-pro-max/data/` giờ hiện ra để commit. Đã kiểm: mọi file trong
      `skills/library` đều không còn bị git bỏ qua (test `project-profile`). **Còn lại:** commit rồi thử clone sạch + `doctor`.
- [x] 1.2 Team tài liệu khai `requires_folders: true` (design, security, report): `folders` rỗng = **cấm ghi** (hook chế độ `scoped`,
      Trưởng nhóm cũng không giao được việc). Team code giữ "rỗng = không giới hạn". Mẫu ghi rõ cả hai; `doctor` cảnh báo từng loại.
- [x] 1.3 Mẫu dùng `report`. Hồ sơ cũ có `reports` vẫn được hiểu là `report` (doctor nhắc đổi tên); doctor cảnh báo khóa lạ.
- [x] 2.1 `init` lấy mọi script `test*`, `typecheck`, `verify`, `check*`, `lint*`, `build`; bỏ (và ghi chú) `dev/start/serve/watch/
      deploy/publish/release/secrets/migrate/seed/prod...`. Nhận diện Cloudflare Workers, S3/R2, pnpm/yarn/bun.
- [x] 2.2 `doctor`: LỖI khi gốc dự án là gốc ổ đĩa; CHÚ Ý khi không giống dự án, hoặc thư mục công cụ không tên `.my-company` mà
      gốc tự lấy từ thư mục cha. (Chạy ở `D:my-company` nay báo đúng "Gốc dự án đang là gốc ổ đĩa: d:\".)
- [x] 2.3 `skills.lock` có hash từng file (đã ghi bổ sung cho 17 skill nguyên vẹn); `skills verify`/`doctor` nêu file thiếu/bị sửa/thừa.
- [x] 2.4 Bỏ `shared` khỏi mẫu; doctor báo nếu còn.
- [x] 2.5 Hỗ trợ loại trừ `"!src/app/api"` (hook, kiểm phạm vi của Trưởng nhóm, lời nhắc).
- [ ] 2.6 Chưa chạy agent thật (tốn hạn mức). README đã ghi cú pháp `Bash(X)` + `Bash(X *)` và ghi rõ `node tests/*` chưa được thử.
- [ ] 3.1 Đường cơ sở test đỏ có sẵn: chưa làm. Mẫu hồ sơ nhắc ghi test đỏ sẵn vào `conventions`.
- [ ] 3.2 Thử worktree sạch với `build` và test: chưa làm (cần chạy trên dự án thật). Mẫu hồ sơ đã nhắc về file bị gitignore.

## Đã kiểm chứng ở dự án web96 (để tham khảo)

- `npm run doctor`: 0 lỗi, 0 chú ý (sau khi sửa 1.1 trong bản sao của dự án).
- `decide()` của hook chặn file: chặn/cho phép đúng với 8 trường hợp (security, report, quality, frontend, backend).
- `skills verify`: 17/17 skill nguyên vẹn sau khi chép lại `data/`.
- `npm run test:core`: **không** chạy hết (xem 3.1).
