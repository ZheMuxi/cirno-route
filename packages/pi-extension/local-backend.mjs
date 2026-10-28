import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ClassifierError } from './core.mjs';

const stages = {
  'waiting-for-download': '等待其他 Pi 完成依赖准备…',
  'downloading-runtime': '下载 llama.cpp',
  'downloading-model': '下载 Gemma 权重',
  'starting-model': '加载本地 Gemma…',
  'starting-native-model': '通过 node-llama-cpp 加载本地 Gemma…',
  'checking-model': '校验模型与模板…',
  'researching-models': '查询并整理模型能力资料',
  ready: 'Gemma 分类中…',
};

export class LocalBackend {
  constructor(project, { command, args, timeoutMs = 7200000 } = {}) {
    this.project = project;
    this.command = command ?? join(project, '.venv/bin/python');
    this.args = args ?? ['-m', 'cirno_route.worker', '--config', join(project, 'config.json'),
      '--backend', process.env.CIRNO_LOCAL_BACKEND ?? 'node-llama-cpp',
      ...(process.env.CIRNO_RUNTIME_REUSE === '0' ? ['--no-reuse'] : [])];
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.pending = null;
    this.closing = null;
  }

  start() {
    const directory = join(this.project, '.runtime');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const log = openSync(join(directory, 'pi-local-backend.log'), 'a', 0o600);
    let child;
    try {
      child = spawn(this.command, this.args, {
        cwd: this.project, detached: true, stdio: ['pipe', 'pipe', log],
        env: { ...process.env, CIRNO_NODE_BIN: process.execPath },
      });
    } finally { closeSync(log); }
    this.child = child;
    let buffer = '';
    const failed = () => {
      if (this.child !== child) return;
      this.child = null;
      this.pending?.reject(new ClassifierError('LOCAL_BACKEND_EXITED'));
    };
    child.once('error', failed);
    child.once('exit', failed);
    child.stdin.on('error', failed);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 2097152) {
        this.pending?.reject(new ClassifierError('LOCAL_BACKEND_PROTOCOL_ERROR'));
        void this.close(); return;
      }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let record;
        try { record = JSON.parse(line); } catch {
          this.pending?.reject(new ClassifierError('LOCAL_BACKEND_PROTOCOL_ERROR'));
          void this.close(); return;
        }
        if (!this.pending || record.id !== this.pending.id) continue;
        if (record.type === 'progress' && stages[record.stage]) {
          const percent = Number.isInteger(record.percent) && record.percent >= 0 && record.percent <= 100 ? ` ${record.percent}%` : '';
          const count = Number.isInteger(record.completed) && Number.isInteger(record.total)
            && record.completed >= 0 && record.completed <= record.total && record.total <= 128
            ? ` ${record.completed}/${record.total}` : '';
          this.pending.onProgress?.(stages[record.stage] + percent + count);
        } else if (record.type === 'result') this.pending.resolve(record.result);
        else if (record.type === 'error') this.pending.reject(new ClassifierError(
          typeof record.code === 'string' && /^[A-Z_]{1,80}$/.test(record.code) ? record.code : 'LOCAL_BACKEND_ERROR'
        ));
      }
    });
  }

  async classify(body, { signal, onProgress } = {}) {
    return this.request('classify', body, { signal, onProgress });
  }

  async research(body, { signal, onProgress } = {}) {
    return this.request('research', body, { signal, onProgress });
  }

  async request(method, body, { signal, onProgress } = {}) {
    if (this.closing) await this.closing;
    if (signal?.aborted) throw new ClassifierError('CLASSIFIER_CANCELLED');
    if (this.pending) throw new ClassifierError('CLASSIFIER_BUSY');
    if (Buffer.byteLength(JSON.stringify(body)) > 60000) throw new ClassifierError('REQUEST_TOO_LARGE');
    if (!this.child) this.start();
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      let timer;
      const finish = (fn, value) => {
        if (this.pending?.id !== id) return;
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        this.pending = null; fn(value);
      };
      const abort = () => {
        finish(reject, new ClassifierError('CLASSIFIER_CANCELLED'));
        void this.close();
      };
      this.pending = { id, onProgress,
        resolve: value => finish(resolve, value), reject: error => finish(reject, error) };
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        finish(reject, new ClassifierError('LOCAL_BACKEND_TIMEOUT'));
        void this.close();
      }, this.timeoutMs);
      this.child.stdin.write(JSON.stringify({ id, method, body }) + '\n');
    });
  }

  async close() {
    if (this.closing) return this.closing;
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.pending?.reject(new ClassifierError('CLASSIFIER_CANCELLED'));
    this.closing = new Promise(resolve => {
      let killTimer;
      const done = () => { clearTimeout(killTimer); resolve(); };
      child.once('exit', done); child.once('error', done);
      // Closing stdin is also the crash-cleanup signal if Pi itself is terminated.
      child.stdin.end();
      if (child.exitCode !== null || child.signalCode !== null) { done(); return; }
      killTimer = setTimeout(() => {
        // A detached process group contains only this worker and its owned llama child.
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
        done();
      }, 10000);
    });
    try { await this.closing; } finally { this.closing = null; }
  }
}
