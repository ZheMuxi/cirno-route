import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalBackend } from './local-backend.mjs';
import { nativeSchema } from './native-runtime/schema.mjs';
import { SemanticBackend, semanticWorkerEnv } from './semantic-backend.mjs';
import { CompactPrefixIndex, createCompactTokenizer } from './semantic-runtime/compact-tokenizer.mjs';

function fixture(t, { stall = false } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'cirno-backend-'));
  const worker = join(project, 'worker.mjs');
  writeFileSync(worker, `
    import readline from 'node:readline';
    const lines = readline.createInterface({input:process.stdin});
    lines.on('line', line => {
      const r=JSON.parse(line);
      process.stdout.write(JSON.stringify({type:'progress', id:r.id, stage:'starting-model'})+'\\n');
      if (!${stall}) process.stdout.write(JSON.stringify({type:'result', id:r.id, result:{pid:process.pid, method:r.method, body:r.body, scoped:process.env.CIRNO_WORKER_TEST}})+'\\n');
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

test('worker environment overrides reach only the owned child', async t => {
  const saved = process.env.CIRNO_WORKER_TEST;
  const backend = fixture(t);
  backend.env = { CIRNO_WORKER_TEST: 'scoped-value' };
  assert.equal((await backend.classify({})).scoped, 'scoped-value');
  assert.equal(process.env.CIRNO_WORKER_TEST, saved);
});

test('semantic allocator settings are macOS-only and respect explicit overrides', () => {
  assert.deepEqual(semanticWorkerEnv({}, 'darwin'), { MallocSpaceEfficient: '1' });
  assert.deepEqual(semanticWorkerEnv({ MallocSpaceEfficient: '0' }, 'darwin'), { MallocSpaceEfficient: '0' });
  assert.deepEqual(semanticWorkerEnv({}, 'linux'), {});
  assert.deepEqual(semanticWorkerEnv({}, 'win32'), {});
  const semantic = new SemanticBackend('/example');
  assert(semantic.args.includes('--expose-gc'));
  assert.equal(new LocalBackend('/example').env, undefined);
});

test('compact prefix search preserves all overlapping multilingual tokens and character offsets', () => {
  const vocabulary = ['a', 'ab', 'abc', 'abd', '中', '中文', '日', '😀', '😀中', '😀中文', '▁', '▁a', 'é'];
  const index = new CompactPrefixIndex(vocabulary);
  for (const text of ['abcd', 'abz', '中文。', '😀中文a', '▁ab', 'éa', 'unknown']) {
    const chars = [...text];
    for (let begin = 0; begin < chars.length; begin++) {
      const suffix = chars.slice(begin).join('');
      const expected = vocabulary.filter(word => suffix.startsWith(word)).sort((a, b) => a.length - b.length);
      assert.deepEqual([...index.common_prefix_search(chars, begin)], expected);
    }
  }
  assert.deepEqual([...index.common_prefix_search([], 0)], []);
  assert.deepEqual(vocabulary.slice(0, 3), ['a', 'ab', 'abc']);
});

test('compact tokenizer rejects incompatible model and normalizer contracts', () => {
  for (const config of [{}, { model: { type: 'BPE' } }, { model: { type: 'Unigram', unk_id: 3 } },
    { model: { type: 'Unigram', unk_id: 3 }, normalizer: { type: 'NFKC' } }]) {
    assert.throws(() => createCompactTokenizer(config), /SEMANTIC_TOKENIZER_INVALID/);
  }
});

test('compact Unigram retains token IDs, special tokens and full over-limit input', () => {
  // Tiny identity charsmap: the synthetic vocabulary exercises the same pinned library integration.
  const identityMap = Buffer.alloc(9);
  identityMap.writeUInt32LE(4);
  const specials = ['<s>', '</s>'];
  const config = {
    decoder: null,
    model: { type: 'Unigram', unk_id: 3, vocab: [
      ['<s>', 0], ['<pad>', 0], ['</s>', 0], ['<unk>', 0], ['▁', -5],
      ['a', -5], ['ab', -1], ['b', -5], ['中', -1], ['😀', -1],
    ] },
    normalizer: { type: 'Sequence', normalizers: [
      { type: 'Precompiled', precompiled_charsmap: identityMap.toString('base64') },
      { type: 'Replace', pattern: { Regex: ' {2,}' }, content: ' ' },
    ] },
    pre_tokenizer: { type: 'Metaspace', replacement: '▁', add_prefix_space: true },
    added_tokens: specials.map((content, index) => ({ id: index * 2, content,
      single_word: false, lstrip: false, rstrip: false, normalized: false, special: true })),
    post_processor: { type: 'TemplateProcessing', pair: [], single: [
      { SpecialToken: { id: '<s>', type_id: 0 } }, { Sequence: { id: 'A', type_id: 0 } },
      { SpecialToken: { id: '</s>', type_id: 0 } },
    ], special_tokens: Object.fromEntries(specials.map((id, index) => [id, { id, ids: [index * 2], tokens: [id] }])) },
  };
  const encode = createCompactTokenizer(config);
  const result = encode('ab  中文😀');
  assert.deepEqual(result.ids, [0, 4, 6, 4, 8, 3, 9, 2]);
  assert.deepEqual(result.mask, Array(8).fill(1));
  assert.deepEqual(result.types, Array(8).fill(0));
  assert.deepEqual(encode('ab</s>中').ids, [0, 4, 6, 2, 4, 8, 2]);
  assert.deepEqual(encode('\ud800'), encode('\ufffd'));
  assert.equal(encode('a'.repeat(520)).ids.length, 523);
  assert.equal(config.model.vocab.length, 10);
});
