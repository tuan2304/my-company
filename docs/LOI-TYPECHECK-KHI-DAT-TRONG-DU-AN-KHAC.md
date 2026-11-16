# Lỗi typecheck khi my-company nằm bên trong một dự án khác

Ngày ghi: 2026-11-13. Dự án chủ: `web96photobooth_onl` (Next.js, Windows 11, Node 24).
Dành cho: người sửa **bản gốc** my-company, để các dự án sau không gặp lại.
File này bổ sung cho `VAN-DE-GAP-TREN-DU-AN-THAT.md` (mục chưa có trong file đó).

Mỗi mục ghi rõ: ĐÃ KIỂM CHỨNG (có chạy lệnh, có kết quả) hay ĐỀ XUẤT (chưa thử).

---

## Tóm tắt

- Chạy `npm run typecheck` ở **dự án chủ** báo ~220 lỗi, gần như toàn bộ nằm trong `my-company/`.
- Chạy `tsc --noEmit` **bên trong** `my-company/` (dùng tsconfig của chính nó): **0 lỗi, exit 0**.
- Vậy code my-company **không sai**. Lỗi sinh ra vì tsc của dự án chủ quét nhầm my-company bằng cấu hình
  của dự án chủ. Đây là vấn đề **cách đặt/đóng gói**, không phải lỗi logic.

## 1. Hiện tượng (ĐÃ KIỂM CHỨNG)

`npx tsc --noEmit` chạy ở thư mục gốc dự án chủ, chia theo mã lỗi:

| Mã | Số lỗi | Ý nghĩa |
|---|---|---|
| TS7006 | 107 | Tham số ngầm có kiểu `any` (hệ quả của TS2307 bên dưới) |
| TS2307 | 105 | Không tìm thấy module (`@/lib/...`, `~/threads/...`) |
| TS18046 / TS18047 | 6 | Giá trị kiểu `unknown`/`null` (cũng là hệ quả) |
| TS5097 | 3 | Import đuôi `.ts` khi chưa bật `allowImportingTsExtensions` |

Lưu ý đếm: lần đếm đầu bằng PowerShell ra 217, lần chia theo mã ra 221. Chênh do cách đếm dòng; kết luận không đổi.
Số lỗi nằm ngoài `my-company/` của dự án chủ: **0**.

Số file my-company bị tsc của dự án chủ kéo vào: `src` 48, `data` 17, `app` 3, `skills` 1, `.next` 2.

## 2. Vì sao dự án chủ không lỗi mà my-company lỗi

Dự án chủ có `tsconfig.json` với `"include": ["**/*.ts", "**/*.tsx", ...]` và không loại trừ `my-company`.
`**/*.ts` chui vào mọi thư mục con, kể cả my-company. Khi đó tsc áp **cấu hình của dự án chủ** lên code
của my-company. Có 4 nguyên nhân, đều đã đối chiếu:

### 2.1 Alias `@/*` trỏ sai gốc (ĐÃ KIỂM CHỨNG) — nguyên nhân chính

- `paths: { "@/*": ["./src/*"] }` có ở **cả hai** tsconfig, nhưng `./src` được tính từ file tsconfig đang dùng.
  - Dùng tsconfig của my-company: `@/lib/types` → `my-company/src/lib/types.ts` (có thật).
  - Dùng tsconfig của dự án chủ: `@/lib/types` → `<dự-án-chủ>/src/lib/types` (**không có**).
- Kết quả: `@/lib/types` (22), `@/lib/api` (15), `@/lib/format` (11), `@/lib/work-groups`, `@/lib/engines`,
  `@/office/*`, `@/components/*`... đều báo TS2307.
- TS7006 và TS18046 là **hệ quả dây chuyền**: module không tìm thấy nên kiểu thành `any`, các callback
  như `.map(m => ...)` mất kiểu. Sửa TS2307 là các lỗi này tự hết. Không cần sửa từng dòng.
- Ba file lỗi nhiều nhất: `Office3D.tsx` (24), `Dashboard.tsx` (20), `Report.tsx` / `QuotaPanel.tsx` (9 mỗi file).

### 2.2 Dự án chủ không loại trừ `data/` (ĐÃ KIỂM CHỨNG)

- tsconfig my-company có `"exclude": ["node_modules","data","local","server","bin","tests","skills"]`.
  tsconfig dự án chủ không có các mục này, nên quét luôn `data/`.
- Trong `data/runs/<N>/plugin/skills/systematic-debugging/condition-based-waiting-example.ts` có
  `import ... from '~/threads/thread-manager'` và `'~/threads/types'`. Đây là **file ví dụ của skill**
  (mã minh họa của upstream), alias `~/` không tồn tại ở đâu cả. Mỗi run có một bản copy,
  nên một import hỏng nhân lên **36 lỗi** TS2307 (18 + 18).
- Cơ chế sinh ra: `server/runner.mjs:706` đặt `outDir: path.join(runDir, 'plugin')`, mỗi lần chạy
  dựng lại thư mục `plugin` trong `data/runs/<N>/` (`server/skills.mjs:172`).
- Quy mô lúc ghi: 64 run, **14 MB**, 17 file `.ts` trong `data/`. Số này chỉ tăng theo thời gian.

### 2.3 Khác biệt `allowImportingTsExtensions` (ĐÃ KIỂM CHỨNG)

- my-company bật `allowImportingTsExtensions: true` (vì `src/office/flow.ts`, `sim.ts` import đuôi `.ts`).
  Dự án chủ không bật nên báo TS5097 (3 lỗi).
- Không phải lỗi của my-company; chỉ là hai cấu hình lệch nhau.

### 2.4 my-company là một repo git riêng nằm lồng bên trong (ĐÃ KIỂM CHỨNG)

- `my-company/.git` tồn tại; dự án chủ chỉ giấu nó bằng `.git/info/exclude` (không phải submodule,
  không nằm trong `.gitignore` được commit).
- Hệ quả: CI của dự án chủ không thấy my-company (clone sạch không có thư mục này), nên **CI xanh**
  nhưng máy dev **đỏ**. Lỗi chỉ lộ trên máy có my-company, rất dễ bị bỏ qua hoặc gây hiểu nhầm
  "dự án chủ hỏng".

## 3. Cách tái hiện / kiểm chứng

```bash
# A. Từ dự án chủ: đỏ
cd <dự-án-chủ> && npx tsc --noEmit            # ~220 lỗi, đều bắt đầu bằng my-company/

# B. Trong my-company: xanh
cd <dự-án-chủ>/my-company && npx tsc --noEmit -p tsconfig.json   # exit 0

# C. Xem lỗi nào nằm ngoài my-company (kỳ vọng: rỗng)
cd <dự-án-chủ> && npx tsc --noEmit | grep -v '^my-company/'
```

## 4. Việc cần sửa ở bản gốc my-company

Mục tiêu: cài my-company vào bất kỳ dự án nào cũng **không làm hỏng** typecheck/lint/test của dự án đó.

- [x] **4.1 `doctor` phát hiện dự án chủ sẽ quét nhầm (ĐÃ LÀM 2026-11-13: `server/host-scan.mjs`, `checkHostScan` trong `server/doctor.mjs`).** Đi ngược lên các thư mục cha tìm
  `tsconfig.json`, `eslint.config.*`, `jest/vitest.config.*`. Nếu `include` bao phủ my-company mà `exclude`
  chưa có `my-company`, báo cảnh báo kèm đúng dòng cần thêm:
  `"exclude": [..., "my-company"]`. Không tự sửa file của dự án chủ nếu chưa được đồng ý.
- [x] **4.2 `init` cảnh báo khi cài lồng (ĐÃ LÀM: `bin/cli.mjs`, bước 1b).** Nếu thư mục cha có `package.json` hoặc `.git`, in rõ:
  "my-company đang nằm trong dự án khác; công cụ của dự án đó có thể quét nhầm". Gợi ý hai cách:
  (a) **khuyến nghị**: đặt my-company ở thư mục **ngang hàng** (ví dụ `D:\my-company`, đúng như bản của tác giả),
  hoặc (b) thêm `my-company` vào exclude/ignore của dự án chủ.
- [x] **4.3 Ghi vào README / HUONG-DAN-CHI-TIET.md mục "Đặt my-company ở đâu" (ĐÃ LÀM).**
  Nêu 2.1–2.4 bằng 5–6 dòng và lệnh kiểm tra ở mục 3.
- [x] **4.4 Giảm rác trong `data/runs/<N>/plugin` (ĐÃ LÀM, chọn hướng "dọn", xem ghi chú bên dưới).**
  Mỗi run copy cả gói skill, gồm cả file `.ts` ví dụ, gây 36/221 lỗi và 14 MB sau 64 run. Hướng xử lý, chọn một:
  - dùng chung một bản plugin cho các run (liên kết/junction thay vì copy), hoặc
  - bỏ file `.ts` ví dụ khi dựng `plugin` nếu agent không cần chạy chúng, hoặc
  - đặt `data/` ngoài cây dự án chủ, hoặc thêm chính sách dọn run cũ (giữ N run gần nhất).
  **Chưa kiểm chứng:** agent có đọc các file ví dụ `.ts` trong skill hay không. Phải xác nhận trước khi bỏ.
  **Đã chọn (2026-11-13):** hướng "dọn", vì không cần trả lời câu hỏi trên: file `.ts` vẫn nằm nguyên trong gói skill khi agent đang chạy (thư viện skill bị khóa băm nên cũng không sửa được), chỉ xóa bản chép `data/runs/<N>/plugin` khi run kết thúc và khi máy chủ khởi động (`removePluginCopy`, `pruneStalePluginCopies` trong `server/runner.mjs`). Mỗi lần launch dựng lại plugin từ đầu nên làm tiếp/resume không bị ảnh hưởng. Không dùng junction vì Windows hay cần quyền; không dọn "N run gần nhất" vì `plugin` là phần nặng nhất còn các file khác của run chỉ vài KB.
- [x] **4.5 Bài kiểm tra chống tái phát (ĐÃ LÀM: `tests/host-scan.test.mjs`, chạy tsc thật).** Thêm một test trong `tests/` tạo thư mục tạm có
  `tsconfig.json` với `include: ["**/*.ts"]`, đặt my-company vào trong, chạy `tsc --noEmit` và xác nhận
  `doctor` đã cảnh báo (4.1). Test này phải xanh trước khi phát hành.

Tiêu chí hoàn thành: trong một dự án thử có tsconfig `include: ["**/*.ts"]`, sau khi làm theo hướng dẫn
mới của my-company, `npx tsc --noEmit` ở dự án chủ cho **0 lỗi thuộc `my-company/`**.

## 5. Việc phía dự án chủ (web96photobooth_onl) — ĐÃ ÁP DỤNG, ĐÃ KIỂM CHỨNG (2026-11-13)

- Đã thêm `"my-company"` vào `exclude` của `tsconfig.json` ở gốc dự án chủ (1 dòng).
- Kết quả: `npx tsc --noEmit` ở dự án chủ từ ~220 lỗi xuống **0 lỗi, exit 0**.
- Dòng này chặn luôn phần lỗi do `data/runs/<N>/plugin` (mục 2.2) vì thư mục đó nằm trong `my-company/`.
- Đây chỉ là chặn **triệu chứng** ở phía dự án chủ. Gốc rễ (cài lồng không cảnh báo, mỗi run copy gói skill)
  vẫn ở bản gốc my-company và cần sửa theo mục 4, nếu không dự án sau sẽ phải tự thêm exclude như vậy.

## 6. Chưa kiểm chứng

- Chưa chạy `eslint`/test runner của dự án chủ để xem có quét nhầm my-company như tsc hay không.
- Chưa thử 4.1–4.5; mới là đề xuất dựa trên nguyên nhân đã xác minh ở mục 2.
- Chưa kiểm tra bản `D:\my-company` gốc có khác bản sao trong dự án chủ hay không.
