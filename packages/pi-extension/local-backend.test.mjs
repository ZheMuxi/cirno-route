import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalBackend } from './local-backend.mjs';

function fixture(t, { stall = false } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'cirno-backend-'));
  const worker = join(project, 'worker.mjs');
  writeFileSync(worker, `
    import readline from 'node:readline';
    const lines = readline.createInterface({input:process.stdin});
    lines.on('line', line => {
      const r=JSON.parse(line);
      process.stdout.write(JSON.stringify({type:'progress', id:r.id, stage:'starting-model'})+'\\n');
      if (!${stall}) process.stdout.write(JSON.stringify({type:'result', id:r.id, result:{pid:process.pid, method:r.method, body:r.body}})+'\\n');
    });
    lines.on('close', () => process.exit(0));
  `);
  const backend = new LocalBackend(project, { command: process.execPath, args: [worker], timeoutMs: 1000 });
  t.after(async () => { await backend.close(); rmSync(project, { recursive: true }); });
  return backend;
}

test('lazy worker, same process reused; close reaps child and next call restarts', async t => {
  const backend = fixture(t);
  assert.equal(backend.child, null);
  const progress = [];
  const first = await backend.classify({}, { onProgress: text => progress.push(text) });
  assert.equal((await backend.classify({})).pid, first.pid);
  assert(progress.some(p => p.includes('加载')));
  await backend.close();
  assert.throws(() => process.kill(first.pid, 0), {code:'ESRCH'});
  assert.notEqual((await backend.classify({})).pid, first.pid);
});

test('cancelling a classification closes owned worker and rejects promptly', async t => {
  const backend = fixture(t, { stall: true });
  const controller = new AbortController();
  const running = backend.classify({}, { signal: controller.signal });
  const rejected = assert.rejects(running, /CLASSIFIER_CANCELLED/);
  const pid = backend.child.pid;
  controller.abort();
  await rejected;
  await backend.close();
  assert.throws(() => process.kill(pid, 0), {code:'ESRCH'});
});

test('overlapping requests are refused without a second process', async t => {
  const backend = fixture(t, { stall: true });
  const first = backend.classify({});
  const rejected = assert.rejects(first, /CLASSIFIER_CANCELLED/);
  await assert.rejects(backend.classify({}), /CLASSIFIER_BUSY/);
  await backend.close();
  await rejected;
});

test('research forwards the action over the same worker without confusing it with classification', async t => {
  const backend = fixture(t);
  const request = { models: [{ candidate_id: 'one' }], action: 'refresh' };
  const research = await backend.research(request);
  assert.equal(research.method, 'research');
  assert.deepEqual(research.body, request);
  const classification = await backend.classify({ task: { text: 'local-only' } });
  assert.equal(classification.method, 'classify');
  assert.equal(classification.pid, research.pid);
});

test('oversized catalog is rejected before spawning the worker or truncating stdin', async t => {
  const backend = fixture(t);
  await assert.rejects(backend.research({ name: '中'.repeat(21000) }), /REQUEST_TOO_LARGE/);
  assert.equal(backend.child, null);
});
