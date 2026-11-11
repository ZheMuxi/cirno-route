import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { LocalBackend } from './local-backend.mjs';
import { ClassifierError } from './core.mjs';

export const SEMANTIC_MODEL = JSON.parse(readFileSync(new URL('./semantic-runtime/model.json', import.meta.url), 'utf8'));
export function semanticWorkerEnv(environment = process.env, platform = process.platform) {
  // Scope allocator tuning to this expendable worker; honor an explicit user override.
  return platform === 'darwin' ? { MallocSpaceEfficient: environment.MallocSpaceEfficient ?? '1' } : {};
}
export function validVector(value) {
  if (!Array.isArray(value) || value.length !== 384 || value.some(v => !Number.isFinite(v))) return false;
  const norm = Math.sqrt(value.reduce((sum, v) => sum + v * v, 0));
  return norm > 0.99 && norm < 1.01;
}
export class SemanticBackend extends LocalBackend {
  constructor(project, cache = join(project, '.runtime/semantic/e5-small-q8')) {
    super(project, { command: process.execPath, timeoutMs: 300000, env: semanticWorkerEnv(),
      args: ['--expose-gc', fileURLToPath(new URL('./semantic-runtime/runtime.mjs', import.meta.url)), cache] });
  }
  start() {
    const tokenizer = process.env.CIRNO_SEMANTIC_TOKENIZER === 'native' ? 'tokenizers' : '@huggingface/tokenizers';
    for (const name of ['onnxruntime-node', tokenizer]) {
      if (!existsSync(new URL(`./semantic-runtime/node_modules/${name}/package.json`, import.meta.url))) {
        throw new ClassifierError('SEMANTIC_DEPENDENCY_MISSING');
      }
    }
    super.start();
  }
  async request(method, body, options) {
    // Keep warm briefly for burst input, release all native allocations while the user/model is idle.
    clearTimeout(this.idleTimer);
    try { return await super.request(method, body, options); }
    finally {
      if (!this.pending && this.child) this.idleTimer = setTimeout(() => { void this.close(); }, 15000).unref();
    }
  }
  async close() { clearTimeout(this.idleTimer); return super.close(); }
  async prepare(options) { return this.request('prepare', {}, options); }
  async embed(text, options) {
    const result = await this.request('embed', { text }, options);
    if (result?.fingerprint !== SEMANTIC_MODEL.fingerprint || !validVector(result.vector)) {
      throw new ClassifierError('SEMANTIC_VECTOR_INVALID');
    }
    return result;
  }
}
