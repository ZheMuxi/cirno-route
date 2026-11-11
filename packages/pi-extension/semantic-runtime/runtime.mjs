// Private local-only inference. Network access is restricted to fixed public model downloads.
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { InferenceSession, Tensor } from 'onnxruntime-node';

const manifest = JSON.parse(await readFile(new URL('./model.json', import.meta.url), 'utf8'));
const cache = resolve(process.argv[2]);
let tokenizer, model, active = false, stopping = false, activeTask;
const shutdown = new AbortController();
const emit = value => { if (!stopping) process.stdout.write(JSON.stringify(value) + '\n'); };
const memoryStats = () => ({ rss_bytes: process.memoryUsage().rss, peak_rss_bytes: process.resourceUsage().maxRSS * 1024 });
async function valid(path, entry) {
  try {
    if ((await stat(path)).size !== entry.size) return false;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex') === entry.sha256;
  } catch { return false; }
}
async function prepare(id) {
  if (model) return;
  for (const entry of manifest.files) {
    const path = join(cache, entry.name);
    if (await valid(path, entry)) continue;
    emit({ type: 'progress', id, stage: 'downloading-semantic-model' });
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = path + '.' + randomUUID() + '.part';
    let file;
    try {
      const response = await fetch(`https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/${entry.name}`, {
        signal: AbortSignal.any([AbortSignal.timeout(240000), shutdown.signal]),
      });
      if (!response.ok || !response.body) throw Error('SEMANTIC_DOWNLOAD_FAILED');
      file = await open(temp, 'wx', 0o600);
      const hash = createHash('sha256');
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > entry.size) throw Error('SEMANTIC_MODEL_INVALID');
        hash.update(chunk);
        await file.writeFile(chunk);
      }
      if (size !== entry.size || hash.digest('hex') !== entry.sha256) throw Error('SEMANTIC_MODEL_INVALID');
      await file.close(); file = null;
      await rename(temp, path);
    } finally { await file?.close(); await unlink(temp).catch(() => {}); }
  }
  emit({ type: 'progress', id, stage: 'loading-semantic-model' });
  tokenizer = await loadTokenizer();
  // JSON parsing and vocabulary sorting leave short-lived objects; collect before ORT loads.
  // Only used at startup, never on the warm inference path.
  global.gc?.();
  model = await InferenceSession.create(join(cache, 'onnx/model_quantized.onnx'), {
    executionProviders: ['cpu'], intraOpNumThreads: 2, interOpNumThreads: 1, executionMode: 'sequential',
    // Reuse intermediate buffers: avoids repeatedly allocating/madvise-ing large tensors on macOS.
    // No per-shape memory-pattern cache; the short-lived worker releases the arena after idle.
    enableCpuMemArena: true, enableMemPattern: false, graphOptimizationLevel: 'basic',
  });
}
async function loadTokenizer() {
  if (process.env.CIRNO_SEMANTIC_TOKENIZER === 'native') {
    const { Tokenizer } = await import('tokenizers');
    const native = Tokenizer.fromFile(join(cache, 'tokenizer.json'));
    native.disablePadding(); native.disableTruncation();
    return async text => {
      const encoded = await native.encode(text, null, { addSpecialTokens: true });
      return { ids: encoded.getIds(), mask: encoded.getAttentionMask(), types: encoded.getTypeIds() };
    };
  }
  const { createCompactTokenizer } = await import('./compact-tokenizer.mjs');
  return createCompactTokenizer(JSON.parse(await readFile(join(cache, 'tokenizer.json'), 'utf8')));
}
async function embed(text) {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 10000) throw Error('SEMANTIC_INPUT_INVALID');
  const started = performance.now();
  // Symmetric similarity: BOTH stored tasks and queries use the trained query prefix.
  const { ids, mask, types } = await tokenizer('query: ' + text);
  const tokens = ids.length;
  if (tokens > manifest.max_tokens) throw Error('SEMANTIC_INPUT_TOO_LONG');
  const inputs = { input_ids: new Tensor('int64', BigInt64Array.from(ids, BigInt), [1, tokens]),
    attention_mask: new Tensor('int64', BigInt64Array.from(mask, BigInt), [1, tokens]),
    token_type_ids: new Tensor('int64', BigInt64Array.from(types, BigInt), [1, tokens]) };
  let outputs;
  try {
    outputs = await model.run(inputs);
    const hidden = outputs.last_hidden_state;
    if (!hidden || hidden.dims.join(',') !== `1,${tokens},${manifest.dimensions}`) throw Error('SEMANTIC_VECTOR_INVALID');
    const vector = Array(manifest.dimensions).fill(0);
    // Mean-pool non-padding tokens, then L2 normalize (E5 model-card protocol).
    for (let t = 0; t < tokens; t++) if (mask[t]) {
      for (let d = 0; d < vector.length; d++) vector[d] += hidden.data[t * vector.length + d];
    }
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    for (let d = 0; d < vector.length; d++) vector[d] /= norm;
    if (vector.length !== manifest.dimensions || vector.some(v => !Number.isFinite(v))) throw Error('SEMANTIC_VECTOR_INVALID');
    return { vector, tokens, fingerprint: manifest.fingerprint,
      latency_ms: Math.round(performance.now() - started), ...memoryStats() };
  } finally {
    for (const tensor of Object.values(outputs ?? {})) tensor?.dispose?.();
    for (const tensor of Object.values(inputs)) tensor?.dispose?.();
  }
}
async function handle(packet) {
  if (active) { emit({ type: 'error', id: packet.id, code: 'SEMANTIC_BUSY' }); return; }
  active = true;
  try {
    if (!['embed', 'prepare'].includes(packet.method)) throw Error('SEMANTIC_METHOD_INVALID');
    await prepare(packet.id);
    const result = packet.method === 'embed' ? await embed(packet.body?.text)
      : { fingerprint: manifest.fingerprint, ...memoryStats() };
    emit({ type: 'result', id: packet.id, result });
  } catch (error) {
    emit({ type: 'error', id: packet.id, code: /^SEMANTIC_[A-Z_]+$/.test(error.message) ? error.message : 'SEMANTIC_UNAVAILABLE' });
  } finally { active = false; }
}
async function close() {
  if (stopping) return;
  stopping = true;
  shutdown.abort();
  const timer = setTimeout(() => process.exit(1), 2000);
  try { await activeTask; await model?.release(); }
  finally {
    clearTimeout(timer);
    process.stdin.destroy();
    // Let native ORT threads unwind; forced process.exit races the native mutex teardown.
    process.exitCode = 0;
  }
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (stopping) return;
  buffer += chunk;
  if (Buffer.byteLength(buffer) > 60000) { void close(); return; }
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    try {
      const packet = JSON.parse(line);
      if (typeof packet.id !== 'string' || packet.id.length > 64) throw Error();
      if (active) emit({ type: 'error', id: packet.id, code: 'SEMANTIC_BUSY' });
      else activeTask = handle(packet);
    } catch { void close(); return; }
  }
});
for (const name of ['end', 'error']) process.stdin.on(name, close);
process.stdout.on('error', close);
process.on('SIGTERM', close);
process.on('SIGINT', close);
