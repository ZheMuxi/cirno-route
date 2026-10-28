// Private pipe worker: loads the bundled native library, never starts an HTTP server.
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { getLlama, Gemma4ChatWrapper, LlamaChatSession } from 'node-llama-cpp';
import { nativeSchema } from './schema.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const wrapper = new Gemma4ChatWrapper({ reasoning: false });
let llama, model, context, sequence, snapshot, active, stopping = false;

function render(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 2 ||
      messages.at(-1)?.role !== 'user' || (messages.length === 2 && messages[0]?.role !== 'system') ||
      messages.some(m => typeof m.content !== 'string')) throw Error('NATIVE_MESSAGES_INVALID');
  return wrapper.generateContextState({ chatHistory: [
    ...messages.map(m => m.role === 'system' ? { type: 'system', text: m.content } : { type: 'user', text: m.content }),
    { type: 'model', response: [] },
  ] }).contextText;
}

async function initialize({ modelPath, contextTokens }) {
  if (model || !Number.isInteger(contextTokens) || contextTokens < 4096 || contextTokens > 32768)
    throw Error('NATIVE_CONFIGURATION_INVALID');
  const pkg = JSON.parse(await readFile(new URL('./node_modules/node-llama-cpp/package.json', import.meta.url), 'utf8'));
  if (pkg.version !== '3.22.2') throw Error('NATIVE_VERSION_MISMATCH');
  // Installation is explicit and locked. Never build/download code during a classification.
  llama = await getLlama({ build: 'never', skipDownload: true, progressLogs: false, logger: () => {} });
  if (llama.llamaCppRelease.repo !== 'ggml-org/llama.cpp' || llama.llamaCppRelease.release !== 'v0.7.0')
    throw Error('NATIVE_VERSION_MISMATCH');
  modelPath = await realpath(modelPath);
  model = await llama.loadModel({ modelPath, gpuLayers: 'max' });
  if (model.fileInfo.metadata.general?.architecture !== 'gemma4') throw Error('NATIVE_MODEL_UNSUPPORTED');
  context = await model.createContext({ contextSize: contextTokens, sequences: 1, batchSize: 512 });
  if (context.contextSize !== contextTokens) throw Error('NATIVE_CONFIGURATION_INVALID');
  sequence = context.getSequence();
  const sentinel = render([{ role: 'system', content: 'CIRNO_SYSTEM_SENTINEL' },
    { role: 'user', content: 'CIRNO_USER_SENTINEL' }]);
  const implementation = await readFile(new URL('./runtime.mjs', import.meta.url));
  const adapter = await readFile(new URL('./schema.mjs', import.meta.url));
  snapshot = { model_path: modelPath,
    template_sha256: hash(JSON.stringify(sentinel.toJSON())),
    runtime_version: `node-llama-cpp/${pkg.version};llama.cpp/${llama.llamaCppRelease.release};adapter/${hash(Buffer.concat([implementation, adapter]))}`,
    context_tokens: context.contextSize };
  return { ...snapshot, gpu: llama.gpu, gpu_layers: model.gpuLayers, pid: process.pid };
}

async function complete({ messages, schema, maxTokens }, signal) {
  if (!snapshot || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096)
    throw Error('NATIVE_CONFIGURATION_INVALID');
  const promptTokens = render(messages).tokenize(model.tokenizer).length;
  if (promptTokens + maxTokens + 32 > context.contextSize) throw Error('CONTEXT_TOO_LARGE');
  const grammar = await llama.createGrammarForJsonSchema(nativeSchema(schema));
  // New logical session every request. Only the token prefix cache may be reused.
  const session = new LlamaChatSession({ contextSequence: sequence, chatWrapper: wrapper,
    systemPrompt: messages[0].role === 'system' ? messages[0].content : '',
    contextShift: { strategy: () => { throw Error('CONTEXT_TOO_LARGE'); } },
  });
  const before = sequence.tokenMeter.getState();
  try {
    const result = await session.promptWithMeta(messages.at(-1).content, {
      grammar, maxTokens, temperature: 0, seed: 42, repeatPenalty: false, signal,
    });
    if (result.stopReason === 'maxTokens') throw Error('ROUTER_OUTPUT_TRUNCATED');
    if (result.stopReason === 'abort') throw Error('CLASSIFIER_CANCELLED');
    if (!['eogToken', 'stopGenerationTrigger'].includes(result.stopReason) ||
        result.response.some(item => typeof item !== 'string')) throw Error('UNEXPECTED_MODEL_CHANNEL');
    const usage = sequence.tokenMeter.diff(before);
    return { text: result.responseText, usage: { prompt_tokens: promptTokens,
      completion_tokens: usage.usedOutputTokens, evaluated_prompt_tokens: usage.usedInputTokens } };
  } finally { session.dispose(); }
}

function emit(packet) { process.stdout.write(JSON.stringify(packet) + '\n'); }
async function handle(packet) {
  if (active) { emit({ id: packet.id, error: 'CLASSIFIER_BUSY' }); return; }
  const controller = new AbortController();
  active = controller;
  try {
    let result;
    if (packet.method === 'init') result = await initialize(packet.body);
    else if (!snapshot) throw Error('NATIVE_NOT_READY');
    else if (packet.method === 'snapshot') result = snapshot;
    else if (packet.method === 'render') result = { prompt: render(packet.body.messages).toString() };
    else if (packet.method === 'complete') result = await complete(packet.body, controller.signal);
    else throw Error('UNKNOWN_METHOD');
    if (!stopping) emit({ id: packet.id, result });
  } catch (error) {
    const allowed = /^(NATIVE_[A-Z_]+|CONTEXT_TOO_LARGE|ROUTER_OUTPUT_TRUNCATED|UNEXPECTED_MODEL_CHANNEL|CLASSIFIER_CANCELLED|UNKNOWN_METHOD)$/;
    if (!stopping) emit({ id: packet.id, error: allowed.test(error.message) ? error.message : 'NATIVE_RUNTIME_ERROR' });
  } finally { active = null; }
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  active?.abort();
  const deadline = setTimeout(() => process.exit(1), 5000);
  try { await llama?.dispose(); } finally { clearTimeout(deadline); process.exit(0); }
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  if (Buffer.byteLength(buffer) > 2_000_000) { void shutdown(); return; }
  let end;
  while ((end = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    try {
      const packet = JSON.parse(line);
      if (!packet || typeof packet.id !== 'string' || packet.id.length > 64) throw Error();
      void handle(packet);
    } catch { void shutdown(); return; }
  }
});
process.stdin.on('end', shutdown);
process.stdin.on('error', shutdown);
process.stdout.on('error', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
