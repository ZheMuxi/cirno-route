import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalBackend } from './local-backend.mjs';
import { nativeSchema } from './native-runtime/schema.mjs';

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

test('native backend is the default and the server remains explicitly selectable', () => {
  const saved = process.env.CIRNO_LOCAL_BACKEND;
  try {
    delete process.env.CIRNO_LOCAL_BACKEND;
    let backend = new LocalBackend('/example');
    assert.equal(backend.args[backend.args.indexOf('--backend') + 1], 'node-llama-cpp');
    process.env.CIRNO_LOCAL_BACKEND = 'llama-server';
    backend = new LocalBackend('/example');
    assert.equal(backend.args[backend.args.indexOf('--backend') + 1], 'llama-server');
    assert.equal(backend.child, null);
  } finally {
    if (saved === undefined) delete process.env.CIRNO_LOCAL_BACKEND;
    else process.env.CIRNO_LOCAL_BACKEND = saved;
  }
});

test('native grammar retains score bounds, tuple length and allowed evidence', () => {
  const schema = { type: 'object', additionalProperties: false, required: ['c0'], properties: {
    c0: { type: 'array', minItems: 2, maxItems: 2, prefixItems: [
      { anyOf: [{ type: 'integer', minimum: 0, maximum: 4 }, { type: 'null' }] },
      { type: 'array', items: { type: 'string', enum: ['e0'] }, maxItems: 1 },
    ] },
  } };
  const grammar = nativeSchema(schema);
  assert.deepEqual(grammar.properties.c0.prefixItems[0], { oneOf: [{ enum: [0, 1, 2, 3, 4] }, { type: 'null' }] });
  assert.deepEqual(grammar.properties.c0.prefixItems[1].items, { enum: ['e0'] });
  assert.equal(grammar.properties.c0.maxItems, 2);
  assert.equal(grammar.additionalProperties, false);
  assert.equal(schema.properties.c0.prefixItems[0].anyOf[0].maximum, 4);
  assert.throws(() => nativeSchema({ type: 'object', properties: { optional: { type: 'string' } } }), /NATIVE_SCHEMA_UNSUPPORTED/);
  assert.throws(() => nativeSchema({ $ref: '#/unknown' }), /NATIVE_SCHEMA_UNSUPPORTED/);
});
