import { createHash } from 'node:crypto';
import { eligibleCatalog } from './catalog.mjs';
import { ClassifierError } from './core.mjs';
import { validProfile } from './habits.mjs';

const fail = code => { throw new ClassifierError(code); };
const dimensions = ['frontend','coding','math','reasoning','knowledge','text','chinese'];
const safe = s => typeof s === 'string' && s.length > 0 && s.length <= 200 && !/[\x00-\x1f\x7f]/.test(s);

export function validateBoardConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail('INVALID_BENCHMARK_CONFIG');
  if (config.models !== undefined && (!config.models || typeof config.models !== 'object' || Array.isArray(config.models))) fail('INVALID_BENCHMARK_CONFIG');
  for (const [id, row] of Object.entries(config.models ?? {})) {
    let url;
    try { url = new URL(row.source_url); } catch { fail('INVALID_BENCHMARK_CONFIG'); }
    if (!safe(id) || !id.includes('/') || url.protocol !== 'https:' || url.username || url.password
      || /artificial[\W_]*analysis/i.test(row.source_url)
      || (row.canonical !== undefined && !safe(row.canonical))
      || (row.environment !== undefined && !safe(row.environment))
      || Object.entries(row.hard ?? {}).some(([k,v]) => !['tools','web','vision','structured_output','long_context'].includes(k) || typeof v !== 'boolean'))
      fail('INVALID_BENCHMARK_CONFIG');
    if (row.canonical) {
      const quoted = typeof row.identity_quote === 'string' && row.identity_quote.length <= 800
        ? row.identity_quote.toLowerCase() : '';
      const ids = [id.slice(id.indexOf('/') + 1).toLowerCase(), row.canonical.toLowerCase()];
      // An alias mentioned only inside a longer version suffix is insufficient.
      const [long, short] = ids.sort((a, b) => b.length - a.length);
      const mentions = (quote, name) => new RegExp('(?<![a-z0-9_.-])' + name.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&')
        + '(?![a-z0-9_-]|\\.[a-z0-9])', 'i').test(quote);
      if (!mentions(quoted, long) || (short !== long && !mentions(quoted.replaceAll(long, ' '), short))
        || /artificial[\W_]*analysis/i.test(quoted))
        fail('INVALID_BENCHMARK_ALIAS_EVIDENCE');
    }
  }
}

export function formatBoards(s, running = false) {
  return ['榜单评分 ' + s.policy + (running ? ' · 后台同步中' : ''), ...s.sources.map(b => {
    const check = b.checked ? ' · 上次检查 ' + new Date(b.checked * 1000).toISOString() : '';
    return b.source + ' · ' + (b.enabled ? (b.version ?? '尚无有效快照') + ' · ' + b.count + ' 条' : '待导入官方快照')
      + (b.error ? ' · ' + b.error : '') + check;
  })].join('\n');
}

export class BoardRouting {
  constructor(config, backend, admin) {
    validateBoardConfig(config);
    this.config = config; this.backend = backend; this.admin = admin;
    this.profiles = new Map();
    this.refreshing = null;
    this.adminQueue = Promise.resolve();
    this.shutdown = new AbortController();
  }
  adminRequest(body) {
    const { signal } = this.shutdown;
    const request = this.adminQueue.then(() => {
      signal.throwIfAborted();
      return this.admin.request('board_admin', body, { signal });
    });
    // A download, import and status check share one serial worker. Release its
    // native Parquet allocations as soon as the last queued request finishes.
    const drained = request.catch(() => {});
    this.adminQueue = drained;
    void drained.then(() => {
      if (this.admin !== this.backend && this.adminQueue === drained) return this.admin.close();
    }).catch(() => {});
    return request;
  }
  start() {
    if (this.shutdown.signal.aborted) this.shutdown = new AbortController();
    return this.refresh('due');
  }
  async close() {
    this.shutdown.abort();
    await Promise.allSettled([this.admin !== this.backend && this.admin.close(), this.refreshing, this.adminQueue]);
  }
  refresh(action) {
    if (this.refreshing) {
      if (action === 'refresh' && this.refreshAction === 'due') return this.refreshing.then(() => this.refresh(action));
      return this.refreshing;
    }
    this.refreshAction = action;
    this.initialStatus = this.adminRequest({ action:'status' });
    this.refreshing = this.adminRequest({ action }).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async status() {
    if (this.refreshing) return this.initialStatus;
    return this.adminRequest({ action: 'status' });
  }
  async import(source, path) {
    if (this.refreshing) await this.refreshing;
    return this.adminRequest({ action: 'import', source, path });
  }
  async score(cfg, text, { signal, images, getModels, activeTools, thinking, worker, coordinator, onProgress }) {
    if (!text?.trim() || Buffer.byteLength(text) > 10000) fail(text?.trim() ? 'CONTEXT_TOO_LARGE' : 'EMPTY_TASK');
    const started = performance.now();
    const live = getModels().filter(m => (!m.type || m.type === 'chat') && m.api !== 'pi-virtual'
      && (cfg.candidate_source === 'pi' || cfg.candidates.some(c => (c.provider ?? 'cirno-gateway') === m.provider && c.model === m.id)));
    if (images && !live.some(m => m.input?.includes('image')
      || (!m.input && this.config.models?.[m.provider + '/' + m.id]?.hard?.vision))) fail('TEXT_ONLY_CLASSIFIER');
    const catalog = await eligibleCatalog(cfg, live, signal);
    if (!catalog.length) fail('NO_ELIGIBLE_MODEL');
    const key = createHash('sha256').update(text).digest('hex');
    let needs = this.profiles.get(key);
    if (!needs) {
      onProgress?.('Gemma 分析任务能力与硬性要求…');
      needs = await this.backend.request('benchmark_profile', { text }, { signal, onProgress });
      if (!validProfile(needs?.task_profile) || !dimensions.includes(needs.primary)
        || ![...dimensions, 'none'].includes(needs.secondary) || !Number.isSafeInteger(needs.context_tokens)
        || needs.context_tokens < 0 || !['ready','missing','unclear'].includes(needs.input_status)) fail('TASK_PROFILE_INVALID');
      if (this.profiles.size >= 64) this.profiles.delete(this.profiles.keys().next().value);
      this.profiles.set(key, needs);
    }
    const required = new Set(needs.task_profile.requirements);
    if (coordinator) required.add('tools');
    if (images) required.add('vision');
    if (needs.context_tokens > 0) required.add('long_context');
    const task = { primary: needs.primary, secondary: needs.secondary, input_status: needs.input_status,
      webdev_focus:needs.webdev_focus ?? 'overall', specialty:needs.specialty ?? 'general',
      task_profile: { ...needs.task_profile, requirements: [...required] } };
    const models = catalog.map(c => {
      const m = live.find(m => m.provider === c.provider && m.id === c.model);
      const override = this.config.models?.[c.provider + '/' + c.model] ?? {};
      const hard = { ...override.hard };
      if (Array.isArray(m.input)) hard.vision = m.input.includes('image') && hard.vision !== false;
      if (Number.isFinite(m.contextWindow)) hard.long_context = m.contextWindow >= (needs.context_tokens || 32768) && hard.long_context !== false;
      else if (needs.context_tokens > 0) hard.long_context = false;
      if (!activeTools.length || worker) hard.tools = false;
      if (worker || (!activeTools.some(t => /web|browse|search.internet/i.test(t)) && hard.web !== true)) hard.web = false;
      if (worker) hard.vision = false;
      const level = worker ? null : (m.thinkingLevelMap && Object.hasOwn(m.thinkingLevelMap, thinking)
        ? m.thinkingLevelMap[thinking] : thinking);
      const effort = m.reasoning && typeof level === 'string' ? (level === 'off' ? 'none' : level) : '';
      return { candidate_id:c.candidate_id, provider:c.provider, model:c.model, hard, effort,
        ...(override.canonical ? {canonical:override.canonical} : {}), ...(override.environment ? {environment:override.environment} : {}) };
    });
    onProgress?.('读取本地榜单并核对任务所需分项…');
    const firstSync = this.refreshing;
    if (firstSync) {
      try {
        if (!(await this.initialStatus).sources.some(s => s.enabled && s.version)) {
          onProgress?.('首次使用，等待官方榜单同步结果…');
          await firstSync;
        }
      } catch {
        // The scoring worker handles local read errors and targeted fallback independently.
      }
    }
    signal?.throwIfAborted();
    const result = await this.backend.request('board_score', { needs:task, models }, { signal, onProgress });
    if (result.score_scale !== 10 || !Array.isArray(result.candidates) || result.candidates.length !== models.length
      || result.candidates.some((r,i) => r.candidate_id !== models[i].candidate_id || r.provider !== models[i].provider
        || r.model !== models[i].model || (r.quality_level !== null && (!Number.isFinite(r.quality_level) || r.quality_level < 0 || r.quality_level > 10))))
      fail('INVALID_BENCHMARK_RESULT');
    for (const row of result.candidates) {
      const mapping = this.config.models?.[row.provider + '/' + row.model];
      if (mapping?.canonical) row.alias = { model:mapping.canonical, source_url:mapping.source_url };
    }
    return { ...result, latency_ms:Math.round(performance.now()-started), task_sha256:key };
  }
}
