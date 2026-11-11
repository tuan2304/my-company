import assert from 'node:assert/strict';
import test from 'node:test';
import { runDoctor } from '../server/doctor.mjs';
import { claudeEngine } from '../server/engines/claude.mjs';
import { getEngine, listEngines } from '../server/engines/index.mjs';
import * as runner from '../server/runner.mjs';
import { makeProject, removeDir, testConfig, tmpDir } from './helpers.mjs';

test('getEngine: mặc định là claude, tên lạ thì báo lỗi nêu rõ các engine hiện có', () => {
  assert.equal(getEngine({}), claudeEngine);
  assert.equal(getEngine({ engine: 'claude' }), claudeEngine);
  assert.throws(() => getEngine({ engine: 'nope' }), /Engine "nope" không tồn tại.*claude, agy/);
  assert.deepEqual(listEngines().map((e) => e.id), ['claude', 'agy']);
});

test('loadConfig đọc COMPANY_ENGINE, mặc định claude', () => {
  const root = tmpDir();
  try {
    const { project, local } = makeProject(root);
    assert.equal(testConfig(root, project, local).engine, 'claude');
    assert.equal(testConfig(root, project, local, { engine: 'other' }).engine, 'other');
  } finally {
    removeDir(root);
  }
});

test('engine claude: command lấy lệnh và tham số đứng trước từ cấu hình', () => {
  assert.deepEqual(claudeEngine.command({ claudeBin: 'claude', claudeArgsPrefix: [] }), { bin: 'claude', prefix: [] });
  assert.deepEqual(claudeEngine.command({ claudeBin: 'node', claudeArgsPrefix: ['fake.mjs'] }), { bin: 'node', prefix: ['fake.mjs'] });
  assert.deepEqual(claudeEngine.command({ claudeBin: 'claude' }), { bin: 'claude', prefix: [] });
});

test('engine claude: parseLine trả mảng sự kiện, dòng không phải object thì trả null để runner ghi "raw"', () => {
  assert.deepEqual(claudeEngine.parseLine('{"type":"result","subtype":"success"}'), [{ type: 'result', subtype: 'success' }]);
  for (const line of ['không phải json', '{hỏng', 'null', '42', '"chuỗi"', 'true']) {
    assert.equal(claudeEngine.parseLine(line), null, line);
  }
});

test('engine claude: parseTriageOutput đọc object, mảng sự kiện, lỗi và đầu ra rác', () => {
  assert.deepEqual(
    claudeEngine.parseTriageOutput(JSON.stringify({ type: 'result', result: '{"level":"easy"}', usage: { input_tokens: 3 }, total_cost_usd: 0.5 })),
    { result: '{"level":"easy"}', isError: false, usage: { input_tokens: 3 }, costUsd: 0.5 },
  );
  const arr = [{ type: 'system' }, { type: 'result', result: 'x', is_error: true }, { type: 'other' }];
  assert.deepEqual(claudeEngine.parseTriageOutput(JSON.stringify(arr)), { result: 'x', isError: true, usage: {}, costUsd: 0 });
  assert.equal(claudeEngine.parseTriageOutput(JSON.stringify([{ type: 'system' }])), null);
  assert.equal(claudeEngine.parseTriageOutput('rác'), null);
  assert.equal(claudeEngine.parseTriageOutput(''), null);
});

test('engine claude: triageArgs đặt model nhỏ nhất, không công cụ, một lượt và đưa nguyên lời nhắc đánh giá', () => {
  const args = claudeEngine.triageArgs('RUBRIC-X');
  assert.equal(args[args.indexOf('--model') + 1], 'haiku');
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--max-turns') + 1], '1');
  assert.equal(args[args.indexOf('--system-prompt') + 1], 'RUBRIC-X');
});

test('runner vẫn xuất các hàm dựng tham số cũ, và chúng chính là hàm của engine', () => {
  assert.equal(runner.buildClaudeArgs, claudeEngine.taskArgs);
  assert.equal(runner.buildAnswerArgs, claudeEngine.answerArgs);
  assert.equal(runner.buildLeadArgs, claudeEngine.leadArgs);
  assert.equal(runner.buildGuardSettings, claudeEngine.guardSettings);
  assert.equal(typeof runner.buildAllowedTools, 'function');
});

test('Runner dùng engine theo cấu hình và từ chối khởi tạo khi tên engine sai', () => {
  const root = tmpDir();
  try {
    const { project, local } = makeProject(root);
    const good = new runner.Runner({ cfg: testConfig(root, project, local), store: {}, getTeams: () => [], getProject: () => null });
    assert.equal(good.engine, claudeEngine);
    assert.throws(
      () => new runner.Runner({ cfg: testConfig(root, project, local, { engine: 'nope' }), store: {}, getTeams: () => [], getProject: () => null }),
      /Engine "nope" không tồn tại/,
    );
  } finally {
    removeDir(root);
  }
});

test('doctor: tên engine sai chỉ thành một dòng lỗi "engine", không làm sập các kiểm tra còn lại', async () => {
  const root = tmpDir();
  try {
    const { project, local } = makeProject(root);
    const checks = await runDoctor(testConfig(root, project, local, { engine: 'nope' }));
    const engineCheck = checks.find((c) => c.id === 'engine');
    assert.equal(engineCheck?.level, 'fail');
    assert.match(engineCheck.detail, /không tồn tại/);
    assert.ok(checks.some((c) => c.id === 'node'), 'các kiểm tra khác vẫn chạy');
    assert.ok(checks.some((c) => c.id === 'git'));
  } finally {
    removeDir(root);
  }
});

test('doctor: với engine claude cho ra dòng "claude" (và không có dòng "engine")', async () => {
  const root = tmpDir();
  try {
    const { project, local } = makeProject(root);
    const checks = await runDoctor(testConfig(root, project, local));
    assert.ok(checks.some((c) => c.id === 'claude'));
    assert.ok(!checks.some((c) => c.id === 'engine'));
  } finally {
    removeDir(root);
  }
});
