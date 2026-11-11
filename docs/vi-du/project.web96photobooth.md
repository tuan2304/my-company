---
# ============================================================================
# HỒ SƠ DỰ ÁN: web96photobooth_onl  (bản tối ưu, để chủ dự án tự chỉnh)
# ----------------------------------------------------------------------------
# QUAN TRỌNG: công cụ này nằm ở D:\my-company nên mặc định sẽ coi D:\ là dự án.
# Phải trỏ đúng dự án trước khi chạy, bằng MỘT trong hai cách:
#   - đặt biến môi trường COMPANY_PROJECT_ROOT=D:\web96photobooth_onl
#   - hoặc thêm  --project D:\web96photobooth_onl  vào lệnh my-company
# Mọi đường dẫn trong "folders" bên dưới tính từ gốc dự án đó, không phải từ D:\my-company.
# ============================================================================
name: web96photobooth_onl
stack: [Next.js, React, TypeScript, Supabase, Cloudflare Workers, Cloudflare R2, Node.js]

# Thư mục mỗi team ĐƯỢC SỬA. Khóa là id team (tên thư mục trong teams/).
# Team viết code để [] = sửa được MỌI NƠI; team tài liệu (design, security, report) để [] = KHÔNG ghi được gì.
# Khớp theo tiền tố: "src/lib" gồm cả src/lib/abc.ts; ghi tên một file cũng được. "!" = loại trừ.
folders:
  backend:  [src/app/api, src/lib, src/proxy.ts, supabase, print-agent, cloudflare-worker.ts, cloudflare-print-relay.ts]
  # src/app/api thuộc backend: frontend lấy cả src/app rồi loại trừ nó, nên route mới ở src/app tự thuộc frontend.
  frontend: [src/app, "!src/app/api", src/components, src/lib, public]
  # src/lib trùng giữa backend và frontend là CÓ CHỦ ĐÍCH (lẫn code server và client, không tách được).
  quality:  [tests, scripts/verify-core.cjs]
  # verify-core.cjs là danh sách test chạy trong CI: test mới phải thêm vào đó. File này trùng với devops (có chủ đích).
  devops:   [.github, scripts, wrangler.jsonc, open-next.config.ts, next.config.ts, tsconfig.json, tsconfig.worker.json]
  # package.json và package-lock.json cố ý KHÔNG giao cho ai: thêm thư viện phải do chủ duyệt.
  design:   [DESIGN.md, docs/BRAND_IDENTITY.md]
  # Dự án chưa có thư mục thiết kế riêng. Muốn nhà thiết kế viết đặc tả mới thì tạo docs/design rồi thêm vào đây.
  security: [docs/security]   # thư mục tạo khi có báo cáo đầu tiên
  report:   [reports]   # id của Team Báo cáo là "report" (thư mục teams/report). Khóa cũ "reports" vẫn được hiểu nhưng doctor nhắc đổi.

commands:
  install: npm install
  test: npm run test:core
  typecheck: npm run typecheck
  build: npm run build
  verify: npm run verify
  # Dự án chưa có lệnh lint (không có ESLint; Prettier chỉ nằm trong devDependencies, không có cấu hình).

# Lệnh Bash agent được TỰ chạy (khớp theo tiền tố, kể cả khi có thêm tham số). Chỉ lệnh đọc hoặc an toàn.
# KHÔNG đưa vào: npm run dev/start (chạy mãi), cf:deploy, cf:secrets, cf:build (ghi lại bản print-agent đã commit),
# node scripts/verify-cloud-storage.cjs (gọi dịch vụ thật). git push luôn bị chặn cứng.
allowed_commands: [git status, git diff, npm run test:core, npm run test:admin, npm run test:print-manager, npm run typecheck, npm run cf:typecheck, npm run build, npm run verify, node tests/*]
# "node tests/*" cho phép chạy MỘT test riêng (ví dụ node tests/color-filters.cjs) thay vì cả bộ mất hơn 2 phút.
# Muốn xem lịch sử git cho team Bảo mật/Báo cáo thì thêm: git log, git show, git blame (chỉ đọc).

# Không bắt buộc: cách chạy bản xem thử để chụp ảnh khi thi đấu skill ({port} được thay bằng một cổng trống).
# Chưa bật vì script dev đã cố định "--hostname 0.0.0.0 --port 3100": thêm --port {port} có thể không ghi đè được và mở cổng ra mạng LAN.
# preview:
#   command: npm run dev -- --port {port}
#   url: http://localhost:{port}
#   pages: [/studio]
#   wait_seconds: 90

# Thư mục của dự án được nối vào mỗi worktree. Mặc định chỉ node_modules.
# CHƯA KIỂM CHỨNG: .env.local và public/vendor/mediapipe/wasm bị gitignore nên không có trong worktree,
# có thể làm npm run build hoặc vài test hỏng. Nếu thấy vậy, thử thêm public/vendor vào đây.
# worktree_links: [node_modules]

conventions: |
  Đọc AGENTS.md, PRODUCT.md, GLOSSARY.md trước; Next.js bản này khác bản quen thuộc, xem node_modules/next/dist/docs trước khi viết code Next.
  Tên tệp: src/lib/*.ts viết thường nối gạch ngang (print-order.ts); component PascalCase.tsx; hook useXxx.ts; mỗi nhóm giao diện có file .css riêng; import nội bộ dùng alias @/ (trỏ vào src/).
  Route API (src/app/api/**/route.ts): khai export const runtime = "nodejs", bọc try/catch, ném HttpError(status, thông báo) và trả lỗi bằng failure(e) trong src/lib/admin-server.ts; phản hồi dữ liệu riêng tư gắn header noStore.
  Thông báo lỗi và chữ hiển thị mặc định bằng tiếng Việt, có bản tiếng Anh (src/lib/english.json, admin-english.json); thuật ngữ theo GLOSSARY.md, không viết "frame/layout" bằng tiếng Anh trong chữ tiếng Việt.
  Giữ phân biệt: layout khác frame, ô ảnh khác ảnh chụp; không làm mất ảnh nguồn và dữ liệu lớp khi sửa frame.
  Test là script Node CommonJS thuần trong tests/*.cjs, dùng node:assert/strict, không có framework; DB và RLS kiểm bằng PGlite trên supabase/migrations; test mới phải thêm tên vào danh sách trong scripts/verify-core.cjs thì CI mới chạy.
  Sửa hành vi hoặc lỗi thì viết test đỏ ở ranh giới công khai trước, rồi mới sửa; chỉnh giao diện hoặc tài liệu thuần túy không cần test giả.
  Migration Supabase đặt trong supabase/migrations, đánh số tăng dần (NNN_ten.sql; migration mới nhất dùng dấu thời gian) và có test lược đồ trong tests/.
  Không đọc hay in .env hay khóa bí mật; biến môi trường mới thì ghi vào .env.example. Không push, không deploy.
  Lỗi đã biết trên Windows: tests/print-queue-actions.cjs đạt hết kiểm tra rồi tiến trình Node chết lúc thoát (Assertion UV_HANDLE_CLOSING, mã 127), làm npm run test:core dừng tại đó. Không do thay đổi của bạn và không tự sửa; chạy từng test liên quan bằng node tests/<tên>.cjs và ghi chuyện này vào phần "Điều còn dang dở".
---

<!-- Hồ sơ này quyết định lệnh nào agent được tự chạy và thư mục nào được sửa. Xem lại trước khi chạy việc thật. -->
