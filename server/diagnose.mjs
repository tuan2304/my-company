import { nextTier } from './triage.mjs';

/**
 * Chẩn đoán một việc "làm" bị lỗi: nói rõ chuyện gì đã xảy ra, vì sao, và đưa ra các phương án để chủ chọn.
 * Hàm này thuần (không đọc file hay git): nơi gọi (recovery.mjs) gom các dữ kiện vào `facts`.
 */

const COPY = {
  timeout: {
    title: 'Làm quá thời gian cho phép',
    cause: 'Nhân viên làm mãi không xong trong thời gian tối đa của vai trò này, nên hệ thống đã dừng tiến trình. Thường do việc quá to, hoặc nhân viên bị kẹt ở một bước (chạy test lâu, đọc quá nhiều file).',
    recommended: 'continue',
  },
  max_turns: {
    title: 'Hết số lượt mà chưa xong',
    cause: 'Nhân viên dùng hết số lượt cho phép nhưng chưa báo xong. Thường do việc to hơn dự tính, hoặc model đang dùng yếu so với độ khó của việc.',
    recommended: 'continue',
  },
  crash: {
    title: 'Tiến trình Claude thoát bất thường',
    cause: 'Tiến trình claude tự thoát giữa chừng mà không báo kết quả (mạng đứt, máy ngủ đông, hoặc Claude Code gặp lỗi). Phần đã làm vẫn được giữ lại.',
    recommended: 'continue',
  },
  error_result: {
    title: 'Claude báo lỗi khi làm',
    cause: 'Claude kết thúc với một lỗi (không phải hết lượt hay hết hạn mức). Nội dung lỗi nằm ở phần Nhật ký bên dưới.',
    recommended: 'continue',
  },
  internal: {
    title: 'Lỗi nội bộ của công ty',
    cause: 'Hệ thống gặp lỗi khi chuẩn bị hoặc kết thúc việc (không phải lỗi của nhân viên). Thường do git hoặc thư mục làm việc.',
    recommended: 'redo',
  },
  no_claude: {
    title: 'Không chạy được Claude Code',
    cause: 'Máy không tìm thấy lệnh claude. Hãy cài hoặc đăng nhập Claude Code (chạy "claude" trong terminal), rồi bấm Làm lại.',
    recommended: 'redo',
  },
  engine_unsupported: {
    title: 'Engine hiện tại chưa làm được lượt này',
    cause: 'Lượt của Trưởng nhóm hoặc Giám đốc cần công cụ MCP của công ty, mà engine đang chọn (ví dụ Antigravity) chưa có. Đổi sang engine claude cho lượt này rồi bấm Làm lại.',
    recommended: 'redo',
  },
  no_member: {
    title: 'Nhân viên không còn trong cấu hình',
    cause: 'Người được giao việc đã bị xóa hoặc đổi tên trong thư mục teams. Việc này không chạy tiếp được.',
    recommended: 'skip',
  },
  rejected_final: {
    title: 'Bị Trưởng nhóm trả bài hết số lần cho phép',
    cause: 'Trưởng nhóm đã trả bài nhiều lần mà bài vẫn chưa đạt. Bạn quyết định: dặn thêm để nhân viên sửa, nhận bài như đang có, hoặc bỏ.',
    recommended: 'continue',
  },
  review_no_verdict: {
    title: 'Trưởng nhóm không đưa ra kết luận',
    cause: 'Trưởng nhóm duyệt hai lượt mà không kết luận (có thể do lỗi hoặc hết lượt). Bài nộp của nhân viên chưa chắc có vấn đề.',
    recommended: 'accept',
  },
  other: {
    title: 'Việc bị lỗi',
    cause: 'Hệ thống không phân loại được lỗi này. Xem nội dung lỗi và nhật ký bên dưới.',
    recommended: 'redo',
  },
};

/** Đoán mã lỗi từ chữ khi việc cũ chưa có mã (dữ liệu từ trước khi có tính năng này). */
export function inferCode(error) {
  const text = String(error ?? '');
  if (/Quá thời gian cho phép/.test(text)) return 'timeout';
  if (/error_max_turns/.test(text)) return 'max_turns';
  if (/thoát bất thường/.test(text)) return 'crash';
  if (/Không tìm thấy lệnh/.test(text)) return 'no_claude';
  if (/Không còn nhân viên/.test(text)) return 'no_member';
  if (/Bị trả bài quá/.test(text)) return 'rejected_final';
  if (/không đưa ra được kết luận/.test(text)) return 'review_no_verdict';
  if (/Kết thúc không thành công/.test(text)) return 'error_result';
  if (/chưa chạy được lượt của Trưởng nhóm/.test(text)) return 'engine_unsupported';
  if (/Lỗi nội bộ|Lỗi khi kết thúc việc|Không chạy được (claude|agy|codex)/.test(text)) return 'internal';
  return 'other';
}

/** Ai chạy lượt này: lượt không phải "làm" là của Trưởng nhóm (plan, review) hoặc Giám đốc (dplan, dreview). */
const LEAD_WHO = { plan: 'Trưởng nhóm', review: 'Trưởng nhóm', dplan: 'Giám đốc', dreview: 'Giám đốc' };

/** Lời giải thích viết cho nhân viên; với lượt của Trưởng nhóm/Giám đốc thì đổi người được nói tới. */
function copyOf(code, task) {
  const base = COPY[code];
  const who = LEAD_WHO[task.kind];
  if (!who) return base;
  const swap = (text) => text.replace(/Nhân viên/g, who).replace(/nhân viên/g, who);
  return { ...base, title: swap(base.title), cause: swap(base.cause) };
}

/** Phương án cho một lượt của Trưởng nhóm/Giám đốc bị lỗi: chạy lại (tiếp phiên cũ), nâng model, hoặc chạy lại từ đầu. */
function leadOptions(task, facts, code, next) {
  const who = LEAD_WHO[task.kind] ?? 'Người chạy';
  const options = [];
  if (!facts.recoverable || code === 'no_member') return options;
  if (facts.canResume) {
    options.push({ action: 'continue', label: 'Chạy lại, làm tiếp phiên cũ', hint: `${who} làm tiếp đúng phiên cũ, không mất những gì đã đọc và đã làm. Có thêm lượt và thời gian. Bạn có thể dặn thêm.`, guidance: 'optional' });
  }
  if (next) {
    options.push({ action: 'raise', label: `Nâng lên ${next.model} rồi chạy lại`, hint: `Dùng model mạnh hơn (${task.model ?? '?'} → ${next.model}), tốn hạn mức Pro nhiều hơn.${facts.canResume ? '' : ' Không còn phiên cũ nên chạy lại từ đầu.'}`, guidance: 'optional' });
  }
  options.push({ action: 'redo', label: 'Chạy lại từ đầu', hint: `Phiên mới, ${who} đọc lại yêu cầu từ đầu. Nên dặn rõ điều cần làm khác đi.`, guidance: 'recommended' });
  return options;
}

/**
 * @param {object} task Hàng trong bảng tasks (đã lỗi).
 * @param {{hasWork: boolean, canResume: boolean, recoverable: boolean, blockedReason?: string|null}} facts
 *   hasWork: nhánh có commit/thay đổi của nhân viên. canResume: còn phiên và thư mục làm việc để làm tiếp.
 *   recoverable: có cho phép xử lý không (việc con của việc lớn đã kết thúc thì chưa).
 */
export function diagnose(task, facts) {
  const code = task.failure_code && COPY[task.failure_code] ? task.failure_code : inferCode(task.error);
  const copy = copyOf(code, task);
  const next = nextTier(task.model);
  const options = [];
  const add = (action, label, hint, guidance) => options.push({ action, label, hint, guidance });

  if (LEAD_WHO[task.kind]) {
    const leadOpts = leadOptions(task, facts, code, next);
    const recommended = leadOpts.find((o) => o.action === (facts.canResume ? 'continue' : 'redo'))?.action ?? null;
    return {
      code, title: copy.title, cause: copy.cause, recommended, hasWork: false, canResume: facts.canResume,
      recoverable: facts.recoverable, blockedReason: facts.blockedReason ?? null, reopensJob: facts.reopensJob ?? null,
      reopensEpic: facts.reopensEpic ?? null, options: leadOpts,
    };
  }

  if (facts.recoverable && code !== 'no_member') {
    if (facts.canResume) {
      add('continue', 'Làm tiếp', 'Nhân viên làm tiếp đúng phiên cũ, không mất phần đã làm. Có thêm lượt và thời gian. Bạn có thể dặn thêm.', 'optional');
    }
    if (next && facts.canResume) {
      add('raise', `Nâng lên ${next.model} rồi làm tiếp`, `Dùng model mạnh hơn (${task.model ?? '?'} → ${next.model}), tốn hạn mức Pro nhiều hơn.`, 'optional');
    }
    add('redo', 'Làm lại từ đầu', 'Nhánh mới, phiên mới; nhánh cũ vẫn giữ để xem. Nên dặn rõ điều cần làm khác đi.', 'recommended');
    if (facts.hasWork) {
      add('accept', 'Nhận phần đã làm', task.job_id
        ? 'Coi như đã nộp bài với phần hiện có; Trưởng nhóm sẽ duyệt.'
        : 'Coi như xong với phần hiện có (bạn tự đọc kỹ trước khi đưa vào dự án).', false);
    }
  }
  if (facts.recoverable || code === 'no_member') {
    add('skip', 'Bỏ qua', 'Đóng việc này lại, không làm nữa. Nhánh và phần đã làm vẫn được giữ.', false);
  }

  // Chỉ gợi ý hành động đang thật sự có trong danh sách.
  const recommended = options.find((o) => o.action === copy.recommended)?.action ?? options.find((o) => o.action !== 'skip')?.action ?? null;
  return {
    code,
    title: copy.title,
    cause: copy.cause,
    recommended,
    hasWork: facts.hasWork,
    canResume: facts.canResume,
    recoverable: facts.recoverable,
    blockedReason: facts.blockedReason ?? null,
    reopensJob: facts.reopensJob ?? null,
    reopensEpic: null,
    options,
  };
}
