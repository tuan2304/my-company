import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileMap, renderFileMap } from '../server/file-map.mjs';
import { removeDir, tmpDir } from './helpers.mjs';

function setupTree() {
  const root = tmpDir();
  const put = (rel, content = 'x') => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  };
  put('src/server/api.mjs');
  put('src/server/db.mjs');
  put('src/server/private/secret.mjs');
  put('src/app/page.tsx');
  put('src/app/a/b/c/d/e/sau.ts');
  put('node_modules/goi/index.js');
  put('src/server/node_modules/x.js');
  put('.git/HEAD');
  put('.company-tmp/thu.mjs');
  put('README.md');
  return { root, put };
}

test('fileMap liệt kê file trong phạm vi, bỏ node_modules/.git/thư mục nháp, tôn trọng loại trừ "!", báo mục chưa có', () => {
  const { root } = setupTree();
  try {
    const all = fileMap({ root, scopes: [] });
    assert.ok(all.entries.includes('README.md') && all.entries.includes('src/server/api.mjs'));
    assert.ok(!all.entries.some((e) => /node_modules|\.git\/|\.company-tmp/.test(e)), 'không liệt kê thư mục sinh ra hay nháp');
    assert.equal(all.truncated, false);

    const scoped = fileMap({ root, scopes: ['src/server', '!src/server/private', 'docs/moi'] });
    assert.deepEqual(scoped.entries, ['src/server/api.mjs', 'src/server/db.mjs']);
    assert.deepEqual(scoped.missing, ['docs/moi']);

    const one = fileMap({ root, scopes: ['src/app/page.tsx'] });
    assert.deepEqual(one.entries, ['src/app/page.tsx'], 'phạm vi là một file thì liệt kê đúng file đó');
    assert.deepEqual(fileMap({ root, scopes: ['../ngoai'] }).entries, [], 'không đi ra ngoài gốc');
  } finally {
    removeDir(root);
  }
});

test('fileMap có trần số mục và độ sâu; renderFileMap ra đoạn đề bài, rỗng khi không có gì', () => {
  const { root, put } = setupTree();
  try {
    for (let i = 0; i < 20; i += 1) put(`src/many/f${String(i).padStart(2, '0')}.ts`);
    const capped = fileMap({ root, scopes: ['src/many'], maxEntries: 5 });
    assert.equal(capped.entries.length, 5);
    assert.equal(capped.truncated, true);

    const shallow = fileMap({ root, scopes: ['src/app'], maxDepth: 2 });
    assert.ok(shallow.entries.includes('src/app/page.tsx'));
    assert.ok(shallow.entries.some((e) => /\(…\)$/.test(e)), 'thư mục sâu hơn trần được ghi là "(…)" thay vì liệt kê hết');
    assert.ok(!shallow.entries.includes('src/app/a/b/c/d/e/sau.ts'));

    const text = renderFileMap({ root, scopes: ['src/server', 'docs/moi'], maxEntries: 2 });
    assert.match(text, /^## Bản đồ file trong phạm vi của bạn/);
    assert.match(text, /- src\/server\/api\.mjs\n- src\/server\/db\.mjs\n- … \(còn nữa, chỉ liệt kê 2 mục đầu\)/);
    assert.match(text, /- docs\/moi: chưa có/);
    assert.equal(renderFileMap({ root: path.join(root, 'khong-co'), scopes: [] }), '', 'gốc không tồn tại thì không có đoạn nào');
    assert.equal(renderFileMap({ root, scopes: ['src/server/private'], title: 'T' }).startsWith('## T'), true, 'tiêu đề tùy chỉnh');
  } finally {
    removeDir(root);
  }
});
