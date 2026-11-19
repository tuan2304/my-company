import { diagnose } from './diagnose.mjs';
import { UserError } from './errors.mjs';
import { shorten } from './guard.mjs';
import { canProceed, usableJobs } from './epics.mjs';
import { applyLead, cleanGuidance, evidenceOf, factsFor, reopenParent } from './recovery.mjs';

/**
 * Xử lý một yêu cầu (epic) đã kết thúc ở "lỗi" hoặc "cần xem". Trước đây chủ chỉ đọc được lỗi.
 * Chẩn đoán theo nguyên nhân thật:
 *   plan_failed / plan_empty   Giám đốc không lập được kế hoạch, hoặc lập xong mà không giao việc nào  → chạy lại lượt lập kế hoạch
 *   jobs_bad                   có việc của team lỗi / cần xem / bị dừng                               → mở từng việc để cứu, hoặc bỏ phần lỗi
 *   conflict                   ghép kết quả các team bị xung đột                                      → chỉ giải thích (cần gộp tay)
 *   review_failed              Giám đốc kiểm tra mà không kết luận được                               → chạy lại lượt kiểm tra
 *   verdict_attention          Giám đốc kết luận "chưa đạt"                                           → chủ vẫn nhận kết quả để duyệt
 */

const RESCUABLE = ['attention', 'failed'];
const STATUS_WHY = {
  planning: 'Giám đốc đang lập kế hoạch.',
  awaiting_plan: 'Kế hoạch đang chờ bạn duyệt.',
  running: 'Các team đang làm.',
  integrating: 'Đang ghép kết quả các team.',
  reviewing: 'Giám đốc đang kiểm tra.',
  awaiting_result: 'Kết quả đang chờ bạn duyệt.',
  done: 'Yêu cầu đã hoàn thành.',
  stopped: 'Yêu cầu đã bị dừng.',
  rejected: 'Bạn đã không duyệt kết quả của yêu cầu này.',
};

function classify(epic, jobs, dplan, dreview) {
  if (jobs.length === 0) return dplan?.status === 'failed' ? 'plan_failed' : 'plan_empty';
  if (epic.verdict === 'attention') return 'verdict_attention';
  if (epic.conflict_files || /ghép kết quả/.test(epic.error ?? '')) return 'conflict';
  if (jobs.some((j) => j.status !== 'done')) return 'jobs_bad';
  if (!epic.verdict && dreview) return 'review_failed';
  return 'other';
}

const FIXED_COPY = {
  plan_empty: {
    title: 'Giám đốc chưa giao việc nào cho team',
    cause: 'Giám đốc lập kế hoạch xong nhưng không tạo việc nào cho các team, nên yêu cầu không có gì để làm. Thường do mô tả quá chung hoặc Giám đốc thấy việc không thuộc team nào. Hãy cho Giám đốc lập lại kèm lời dặn rõ team nào làm gì.',
  },
  conflict: {
    title: 'Ghép kết quả các team bị xung đột',
    cause: 'Hai team sửa trùng chỗ nên không ghép tự động được. Nhánh của từng việc vẫn được giữ: bạn có thể gộp tay trong dự án (git merge các nhánh company/job…) rồi tự kiểm tra, hoặc dừng yêu cầu.',
  },
  jobs_bad: {
    title: 'Có việc của team chưa đạt',
    cause: 'Yêu cầu chỉ đi tiếp khi mọi việc của team xong. Hãy mở từng việc lỗi bên dưới để cứu: việc con lỗi thì làm tiếp, làm lại hoặc nhận phần đã làm; Trưởng nhóm chưa chia được việc thì cho lập kế hoạch lại. Xong thì yêu cầu tự chạy tiếp. Hoặc bỏ phần lỗi để Giám đốc kiểm tra phần đã có.',
  },
  other: {
    title: 'Yêu cầu dừng ở trạng thái cần xem',
    cause: 'Hệ thống không phân loại được nguyên nhân. Xem nội dung lỗi và nhật ký bên dưới.',
  },
};

/** Gom dữ kiện rồi chẩn đoán. Trả về cả lượt Giám đốc liên quan (nếu có) để chạy lại. */
async function analyze({ store, projectRoot, id }) {
  const epic = store.getEpic(id);
  if (!epic) throw new UserError('Không có yêu cầu này.');
  const jobs = store.epicJobs(id);
  const tasks = store.epicTasks(id);
  const dplan = tasks.filter((t) => t.kind === 'dplan').at(-1) ?? null;
  const dreview = tasks.filter((t) => t.kind === 'dreview').at(-1) ?? null;
  const code = classify(epic, jobs, dplan, dreview);
  const recoverable = RESCUABLE.includes(epic.status);
  const badJobs = jobs
    .filter((j) => j.status !== 'done')
    .map((j) => ({ id: j.id, title: j.title, status: j.status, lead: j.lead, error: j.error ? shorten(j.error, 200) : null }));

  let copy = FIXED_COPY[code] ?? FIXED_COPY.other;
  let options = [];
  let recommended = null;
  let run = null;
  let evidence = [];

  if (recoverable && ['plan_failed', 'plan_empty', 'review_failed'].includes(code)) {
    run = code === 'review_failed' ? dreview : dplan;
    if (run) {
      const facts = await factsFor({ store, projectRoot, task: run, force: true });
      const d = diagnose(run, facts);
      options = d.options;
      recommended = d.recommended;
      evidence = evidenceOf(store, run.id);
      if (run.status === 'failed') {
        const what = code === 'review_failed' ? 'Giám đốc không kiểm tra xong' : 'Giám đốc không lập được kế hoạch';
        copy = { title: `${what}: ${d.title}`, cause: d.cause };
      } else if (code === 'review_failed') {
        copy = {
          title: 'Giám đốc kiểm tra mà không kết luận',
          cause: 'Giám đốc kiểm tra kết quả hai lượt nhưng không đưa ra kết luận (có thể hết lượt hoặc quên gọi công cụ kết thúc). Hãy cho Giám đốc kiểm tra lại, nên dặn rõ phải kết luận bằng finish_epic.',
        };
      }
      if (!facts.recoverable) {
        // Lượt không chạy lại được (đã có lượt mới hơn, v.v.): nói rõ thay vì để trống.
        options = [];
        copy = { ...copy, cause: `${copy.cause} (Không chạy lại được: ${facts.blockedReason})` };
      }
    }
  } else if (recoverable && code === 'verdict_attention') {
    copy = {
      title: 'Giám đốc đánh giá kết quả chưa đạt',
      cause: `${epic.final_report ? `Báo cáo của Giám đốc: ${shorten(epic.final_report, 600)} ` : ''}Bạn có thể vẫn nhận kết quả này để tự duyệt, hoặc dừng ở đây.`,
    };
    if (epic.merge_branch) {
      options = [{
        action: 'accept', label: 'Vẫn nhận kết quả để duyệt',
        hint: 'Chuyển yêu cầu sang chờ bạn duyệt kết quả, dù Giám đốc đánh giá chưa đạt. Bạn tự đọc báo cáo và kiểm tra kỹ trước khi duyệt.',
        guidance: false,
      }];
    }
  } else if (recoverable && code === 'conflict' && epic.conflict_files) {
    try {
      const files = JSON.parse(epic.conflict_files);
      if (files.length) copy = { ...copy, cause: `${copy.cause} File xung đột: ${files.join(', ')}.` };
    } catch {
      /* danh sách file hỏng: bỏ qua */
    }
  }

  if (recoverable && code === 'jobs_bad') {
    // Việc chưa chạy vì việc nó phụ thuộc không xong: chủ quyết cho từng việc.
    for (const j of jobs.filter((j) => j.status === 'blocked')) {
      options.push({
        action: `start_job:${j.id}`, label: `Chạy việc #${j.id} (${j.team}) trên phần đã có`,
        hint: `"${shorten(j.title, 60)}" chưa chạy vì việc nó phụ thuộc không xong. Cho chạy ngay: gốc là phần đã được duyệt của các việc nó chờ (nếu có), còn lại là mã gốc của yêu cầu.`,
        guidance: false,
      });
      options.push({
        action: `cancel_job:${j.id}`, label: `Hủy việc #${j.id} (${j.team})`,
        hint: `Không chạy "${shorten(j.title, 60)}" nữa. Các việc khác giữ nguyên; bạn vẫn có thể bỏ phần lỗi để Giám đốc kiểm tra phần đã có.`,
        guidance: false,
      });
    }
  }
  if (recoverable && code === 'jobs_bad' && canProceed(epic, jobs)) {
    const onlyPrevious = usableJobs(epic, jobs).length === 0;
    options.push({
      action: 'proceed', label: 'Bỏ phần lỗi, cho Giám đốc kiểm tra phần đã có',
      hint: onlyPrevious
        ? `Đợt làm lại không có việc nào xong, nên Giám đốc kiểm tra kết quả đã ghép của đợt trước (nhánh ${epic.merge_branch}). Phần lỗi bị bỏ; Giám đốc sẽ ghi rõ phần còn thiếu trong báo cáo.`
        : 'Ghép các việc đã xong (và phần đã duyệt của việc "cần xem") rồi giao Giám đốc kiểm tra. Phần lỗi bị bỏ; Giám đốc sẽ ghi rõ phần còn thiếu trong báo cáo.',
      guidance: false,
    });
  }

  const diagnosis = {
    code, title: copy.title, cause: copy.cause, recommended, hasWork: false, canResume: false,
    recoverable: recoverable && (options.length > 0 || badJobs.length > 0),
    blockedReason: recoverable ? null : (STATUS_WHY[epic.status] ?? `Yêu cầu đang ở trạng thái "${epic.status}".`),
    reopensJob: null, reopensEpic: null, options, badJobs,
  };
  if (recoverable && !diagnosis.recoverable) diagnosis.blockedReason = 'Không có cách xử lý tự động cho trường hợp này. Xem nội dung lỗi bên dưới.';
  if (!evidence.length && epic.plan_task_id) evidence = evidenceOf(store, epic.plan_task_id);
  return { epic, diagnosis, run, evidence };
}


/** Thông tin cho màn hình xử lý yêu cầu lỗi (cùng dạng với inspectFailure của việc). */
export async function inspectEpicFailure({ store, projectRoot, id }) {
  const { diagnosis, evidence } = await analyze({ store, projectRoot, id });
  return { diagnosis, evidence, work: null };
}

/**
 * Thực hiện một lựa chọn của chủ cho yêu cầu lỗi:
 *   continue / raise / redo  chạy lại lượt Giám đốc (lập kế hoạch hoặc kiểm tra) bị lỗi
 *   proceed                  bỏ phần lỗi, cho Giám đốc kiểm tra phần đã có
 *   accept                   vẫn nhận kết quả mà Giám đốc đánh giá chưa đạt
 * @param {import('./runner.mjs').Runner} runner
 */
export async function recoverEpic(runner, id, { action, guidance } = {}) {
  const { store } = runner;
  if (!store.getEpic(id)) throw new UserError('Không có yêu cầu này.');
  runner.recovering ??= new Set();
  const key = `epic:${id}`;
  if (runner.recovering.has(key)) throw new UserError('Yêu cầu này đang được xử lý, đợi một chút.');
  runner.recovering.add(key);
  let rerunId = null;
  try {
    const { epic, diagnosis, run } = await analyze({ store, projectRoot: runner.cfg.projectRoot, id });
    if (!RESCUABLE.includes(epic.status)) throw new UserError(diagnosis.blockedReason);
    const option = diagnosis.options.find((o) => o.action === action);
    if (!option) {
      const valid = diagnosis.options.map((o) => o.action).join(', ') || '(không có)';
      throw new UserError(`Không thể "${action}" với yêu cầu này lúc này. Các lựa chọn hiện có: ${valid}.`);
    }
    const note = cleanGuidance(guidance);
    if (note && !option.guidance) throw new UserError('Lựa chọn này không nhận lời dặn.');

    if (action === 'accept') {
      runner.epics.update(id, { status: 'awaiting_result', error: null, finished_at: null });
      runner.epics.log(epic, 'job', 'Chủ vẫn nhận kết quả dù Giám đốc đánh giá chưa đạt. Chờ chủ duyệt kết quả.');
    } else if (action === 'proceed') {
      await runner.epics.proceed(id);
    } else if (action.startsWith('start_job:') || action.startsWith('cancel_job:')) {
      const jobId = Number(action.split(':')[1]);
      if (action.startsWith('start_job:')) await runner.epics.startBlocked(id, jobId);
      else await runner.epics.cancelBlocked(id, jobId);
    } else {
      // continue / raise / redo: chạy lại lượt Giám đốc.
      const facts = await factsFor({ store, projectRoot: runner.cfg.projectRoot, task: run, force: true });
      if (!facts.recoverable) throw new UserError(facts.blockedReason);
      const undo = await reopenParent(runner, facts);
      try {
        applyLead(runner, run, { action, note });
      } catch (err) {
        await undo();
        throw err;
      }
      rerunId = run.id;
    }
  } finally {
    runner.recovering.delete(key);
  }
  if (rerunId !== null) await runner.notifyJobs(rerunId);
  runner.schedule();
  return store.getEpic(id);
}
