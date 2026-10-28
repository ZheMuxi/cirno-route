import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { priceMode, formatPrice, formatRecommendation } from './pricing.mjs';

export class ClassifierError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new ClassifierError(code); };
const idPattern = /^[a-zA-Z0-9_.:-]{1,100}$/;
const safeCodes = new Set(['TASK_MATCH', 'CAPABILITY_LIMIT', 'EVIDENCE_INSUFFICIENT', 'OBSERVED_PERFORMANCE']);

export function loopback(value) {
  let url;
  try { url = new URL(value); } catch { fail('INVALID_LOCAL_URL'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) fail('INVALID_LOCAL_URL');
  return url;
}

export function readConfig(file) {
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  if (cfg.schema_version !== '1' || !Array.isArray(cfg.candidates) || !cfg.candidates.length || cfg.candidates.length > 8) fail('INVALID_CONFIG');
  if (cfg.candidate_source !== undefined && !['configured', 'pi'].includes(cfg.candidate_source)) fail('INVALID_CONFIG');
  if (cfg.batch_size !== undefined && (!Number.isInteger(cfg.batch_size) || cfg.batch_size < 1 || cfg.batch_size > 8)) fail('INVALID_CONFIG');
  if (cfg.batch_max_bytes !== undefined && (!Number.isInteger(cfg.batch_max_bytes) ||
      cfg.batch_max_bytes < 1000 || cfg.batch_max_bytes > 58000)) fail('INVALID_CONFIG');
  if (cfg.price_preference !== undefined && !priceMode(cfg.price_preference)) fail('INVALID_CONFIG');
  for (const key of ['pricing_file', 'price_preference_file']) {
    if (cfg[key] !== undefined) {
      if (typeof cfg[key] !== 'string' || !cfg[key].trim()) fail('INVALID_CONFIG');
      cfg[key] = resolve(dirname(file), cfg[key]);
    }
  }
  if (cfg.research_names !== undefined && (!cfg.research_names || Array.isArray(cfg.research_names)
    || typeof cfg.research_names !== 'object' || Object.values(cfg.research_names).some(
      name => typeof name !== 'string' || !name || name.length > 200 || /[\x00-\x1f\x7f]/.test(name)))) fail('INVALID_CONFIG');
  loopback(cfg.classifier_url); loopback(cfg.gateway_url);
  const ids = new Set(), evidence = new Set();
  for (const c of cfg.candidates) {
    if (!idPattern.test(c.candidate_id) || ids.has(c.candidate_id) || typeof c.model !== 'string' || !c.model || typeof c.revision !== 'string') fail('INVALID_CONFIG');
    ids.add(c.candidate_id);
    if (!Array.isArray(c.capabilities) || !Array.isArray(c.evidence)) fail('INVALID_CONFIG');
    for (const e of c.evidence) {
      if (!idPattern.test(e.evidence_id) || evidence.has(e.evidence_id) || e.source !== 'configured' || typeof e.summary !== 'string' || !e.summary) fail('INVALID_CONFIG');
      evidence.add(e.evidence_id);
    }
  }
  cfg.classifier_token_file = resolve(dirname(file), cfg.classifier_token_file);
  cfg.gateway_token_file = resolve(dirname(file), cfg.gateway_token_file);
  return cfg;
}

function token(file) {
  try {
    const value = readFileSync(file, 'utf8').trim();
    if (!/^[\x21-\x7e]{16,512}$/.test(value)) fail('TOKEN_INVALID');
    return value;
  } catch { fail('TOKEN_UNAVAILABLE'); }
}

// node:http makes a direct loopback request, independent of HTTP_PROXY/HTTPS_PROXY.
// Never follow redirects or surface server bodies/credentials in error messages.
export async function requestJson(value, key, { body, signal, timeoutMs = 95000 } = {}) {
  const url = loopback(value);
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolveResponse, reject) => {
    const req = http.request(url, {
      method: payload ? 'POST' : 'GET', signal: combined,
      headers: { Authorization: `Bearer ${key}`, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
    }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 262144) { req.destroy(new ClassifierError('RESPONSE_TOO_LARGE')); return; }
        chunks.push(chunk);
      });
      res.on('error', () => reject(new ClassifierError('HTTP_RESPONSE_ERROR')));
      res.on('end', () => {
        if (res.statusCode !== 200 && !(res.statusCode === 409 && payload)) {
          reject(new ClassifierError(`HTTP_${res.statusCode}`)); return;
        }
        try { resolveResponse(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new ClassifierError('INVALID_JSON')); }
      });
    });
    req.on('error', (error) => reject(new ClassifierError(
      combined.aborted ? (timeout.aborted ? 'CLASSIFIER_TIMEOUT' : 'CLASSIFIER_CANCELLED') :
        error instanceof ClassifierError ? error.code : 'SERVICE_UNAVAILABLE'
    )));
    req.end(payload);
  });
}

export function validateResult(result, candidates) {
  if (result?.schema_version !== '1' || !['ok', 'abstain', 'blocked'].includes(result.status) || !['gemma', 'rules'].includes(result.source)) fail('INVALID_RESULT');
  const prediction = result.prediction;
  if (prediction?.schema_version !== '1' || !['ok', 'abstain'].includes(prediction.status) || !Array.isArray(prediction.candidates)) fail('INVALID_RESULT');
  if ((result.status === 'ok') !== (prediction.status === 'ok') || (result.status === 'ok' && result.source !== 'gemma')) fail('INVALID_RESULT');
  const ids = new Set();
  if (prediction.candidates.length !== candidates.length) fail('CANDIDATE_MISMATCH');
  for (const row of prediction.candidates) {
    const card = candidates.find(c => c.candidate_id === row.candidate_id);
    if (!card || ids.has(row.candidate_id)) fail('CANDIDATE_MISMATCH');
    ids.add(row.candidate_id);
    if (row.quality_level !== null && (!Number.isInteger(row.quality_level) || row.quality_level < 0 || row.quality_level > 4)) fail('INVALID_SCORE');
    if (row.preference_fit_level !== null || !['low', 'medium', 'high'].includes(row.uncertainty)) fail('INVALID_RESULT');
    if (!Array.isArray(row.evidence_ids) || new Set(row.evidence_ids).size !== row.evidence_ids.length || row.evidence_ids.some(id => !card.evidence.some(e => e.evidence_id === id))) fail('INVALID_EVIDENCE');
    if (!Array.isArray(row.reason_codes) || !row.reason_codes.length || new Set(row.reason_codes).size !== row.reason_codes.length || row.reason_codes.some(r => !safeCodes.has(r))) fail('INVALID_REASON');
    if (row.reason_codes.includes('OBSERVED_PERFORMANCE') && !card.evidence.some(e => row.evidence_ids.includes(e.evidence_id) && e.source === 'measured')) fail('INVALID_EVIDENCE');
    if ((row.quality_level !== null && !row.evidence_ids.length) || (result.status === 'ok' && row.quality_level === null)) fail('INVALID_EVIDENCE');
  }
  if (result.fallback_candidate_id != null && !ids.has(result.fallback_candidate_id)) fail('INVALID_FALLBACK');
  return result;
}

export function summarize(result) {
  const rows = result.prediction.candidates.map(c => ({
    candidate_id: c.candidate_id, quality_level: c.quality_level,
    preference_fit_level: c.preference_fit_level, uncertainty: c.uncertainty,
    evidence_ids: c.evidence_ids, reason_codes: c.reason_codes,
  }));
  // Tied scores remain tied. This is a ranking display, never a dispatch decision.
  rows.sort((a, b) => (b.quality_level ?? -1) - (a.quality_level ?? -1));
  return {
    status: result.status, source: result.source, candidates: rows,
    reason_codes: Array.isArray(result.reason_codes) ? result.reason_codes.filter(r => /^[A-Z_]{1,80}$/.test(r)) : [],
    latency_ms: Number.isFinite(result.metadata?.latency_ms) ? result.metadata.latency_ms : null,
    request_id: typeof result.metadata?.request_id === 'string' ? result.metadata.request_id.slice(0, 80) : null,
    usage: (result.metadata?.attempts ?? []).map(a => a.usage),
    wire_format: result.metadata?.wire_format ?? null,
    wire_prompt_sha256: result.metadata?.wire_prompt_sha256 ?? null,
    candidate_cards_sha256: result.metadata?.candidate_cards_sha256,
    prompt_sha256: result.metadata?.router_prompt_sha256,
    input_check_prompt_sha256: result.metadata?.input_check_prompt_sha256 ?? null,
    evidence_check_prompt_sha256: result.metadata?.evidence_check_prompt_sha256 ?? null,
    limit_check_prompt_sha256: result.metadata?.limit_check_prompt_sha256 ?? null,
    pipeline_version: ['v2', 'v3'].includes(result.metadata?.pipeline_version) ? result.metadata.pipeline_version : null,
    input_status: ['ready', 'missing'].includes(result.metadata?.input_status) ? result.metadata.input_status : null,
    candidate_evidence_status: Object.fromEntries(rows.flatMap(c => {
      const state = result.metadata?.candidate_evidence_status?.[c.candidate_id];
      return ['supported', 'unsupported', 'insufficient'].includes(state) ? [[c.candidate_id, state]] : [];
    })),
    classifier_model: result.metadata?.verified_runtime?.model ?? null,
    runtime_version: result.metadata?.verified_runtime?.runtime_version ?? null,
    model_digest: result.metadata?.verified_runtime?.model_digest ?? null,
    local_backend: result.metadata?.local_backend ?? null,
  };
}

export async function classify(cfg, text, { signal, images = false, localClassify } = {}) {
  if (images) fail('TEXT_ONLY_CLASSIFIER');
  if (typeof text !== 'string' || !text.trim()) fail('EMPTY_TASK');
  // Reject oversized inputs intact; do not silently drop the end of a task.
  if (Buffer.byteLength(text) > 10000) fail('CONTEXT_TOO_LARGE');
  const catalog = await requestJson(`${cfg.gateway_url}/models`, token(cfg.gateway_token_file), { signal, timeoutMs: 10000 });
  if (!Array.isArray(catalog.data) || catalog.data.some(m => typeof m.id !== 'string')) fail('INVALID_CATALOG');
  const available = new Set(catalog.data.map(m => m.id));
  const candidates = cfg.candidates.filter(c => available.has(c.model));
  if (!candidates.length) fail('NO_ELIGIBLE_MODEL');
  const body = { schema_version: '1', task: { text }, eligible_candidates: candidates, relevant_preferences: [] };
  if (Buffer.byteLength(JSON.stringify(body)) > 10000) fail('CONTEXT_TOO_LARGE');
  const result = localClassify
    ? await localClassify(body, signal)
    : await requestJson(`${cfg.classifier_url}/v1/classify`, token(cfg.classifier_token_file), { body, signal });
  const summary = summarize(validateResult(result, candidates));
  summary.candidates = summary.candidates.map(row => {
    const card = candidates.find(c => c.candidate_id === row.candidate_id);
    return { ...row, provider: card.provider ?? 'cirno-gateway', model: card.model };
  });
  return { ...summary, task_sha256: createHash('sha256').update(text).digest('hex'),
    omitted_candidates: cfg.candidates.filter(c => !available.has(c.model)).map(c => c.candidate_id) };
}

export function formatResult(result) {
  if (result.error) return `本地分类不可用：${result.error}`;
  const lines = [`本地分类：${result.status} · ${result.source} · ${result.latency_ms ?? '?'} ms`];
  if (result.local_backend?.mode === 'node-llama-cpp') lines.push('分类后端：node-llama-cpp（插件内置原生库）');
  if (result.input_status === 'missing') lines.push('资料检查：缺少完成任务所必需的输入。');
  else if (Object.values(result.candidate_evidence_status ?? {}).includes('insufficient')) lines.push('资料检查：部分候选的能力证据不足，保留其他有依据的评分。');
  if (result.research) lines.push(`联网能力资料：${result.research.documented}/${result.research.total} 有依据 · ${result.research.cache_hits} 命中缓存 · ${result.batch_count} 批分类`);
  if (result.routing) {
    lines.push(formatRecommendation(result.routing));
    lines.push(`价格：${result.routing.known_prices} 已配置 · ${result.routing.unknown_prices} 未知/过期；按 1k 输入 + 1k 输出比较，不是本次账单。`);
  }
  for (const row of result.candidates) {
    lines.push(`${row.provider && row.model ? `${row.provider}/${row.model}` : row.candidate_id}: ${row.quality_level ?? '弃权'}/4 · 不确定性 ${row.uncertainty}`);
    if (row.pricing) lines.push(`  ${formatPrice(row.pricing)}`);
  }
  if (result.reason_codes.length) lines.push(result.reason_codes.join(', '));
  lines.push(result.research
    ? '仅评分建议；联网资料不代表本地实测，跨批评分尚未校准。'
    : '仅评分建议；能力资料为配置依据，尚无本地成功率校准。');
  return lines.join('\n');
}
