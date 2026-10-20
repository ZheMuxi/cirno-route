import { createHash } from 'node:crypto';
import { ClassifierError, requestJson, summarize, validateResult } from './core.mjs';
import { readFileSync } from 'node:fs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw new ClassifierError(code); };
const clean = value => typeof value === 'string' && value.length > 0 &&
  value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);

// An explicit projection keeps provider credentials, URLs and arbitrary registry fields private.
export function modelCatalog(models, researchNames = {}) {
  if (!Array.isArray(models) || models.length > 128) fail('CATALOG_TOO_LARGE');
  const seen = new Set();
  return models.map(m => {
    const name = researchNames[`${m.provider}/${m.id}`] ?? m.name ?? m.id;
    if (![m.provider, m.id, name].every(clean)) fail('INVALID_CATALOG');
    const identity = [m.provider, m.id];
    const key = JSON.stringify(identity);
    if (seen.has(key)) fail('INVALID_CATALOG');
    seen.add(key);
    return { candidate_id: `m-${hash(identity).slice(0, 16)}`, provider: m.provider,
      model: m.id, name };
  }).sort((a, b) => a.candidate_id.localeCompare(b.candidate_id));
}

export async function eligibleCatalog(cfg, models, signal) {
  const catalog = modelCatalog(models, cfg.research_names);
  // Registry availability means credentials exist. Recheck the local gateway's actual list.
  if (!catalog.some(m => m.provider === 'cirno-gateway')) return catalog;
  let key;
  try { key = readFileSync(cfg.gateway_token_file, 'utf8').trim(); }
  catch { fail('TOKEN_UNAVAILABLE'); }
  const response = await requestJson(`${cfg.gateway_url}/models`, key, { signal, timeoutMs: 10000 });
  if (!Array.isArray(response.data) || response.data.some(m => typeof m.id !== 'string')) fail('INVALID_CATALOG');
  const available = new Set(response.data.map(m => m.id));
  return catalog.filter(m => m.provider !== 'cirno-gateway' || available.has(m.model));
}

export function validateResearch(result, catalog) {
  if (result?.schema_version !== '1' || !Array.isArray(result.models) ||
      result.models.length !== catalog.length || typeof result.researcher !== 'string') fail('INVALID_RESEARCH_RESULT');
  const ids = new Set();
  const evidenceIds = new Set();
  for (const row of result.models) {
    const c = row.candidate;
    const expected = catalog.find(m => m.candidate_id === c?.candidate_id);
    if (!expected || ids.has(c.candidate_id) || c.model !== expected.model ||
        row.provider !== expected.provider || row.name !== expected.name ||
        !['documented', 'unverified', 'missing'].includes(row.status) ||
        typeof c.revision !== 'string' || !Array.isArray(c.capabilities) ||
        !Array.isArray(c.evidence) || c.evidence.length > 1 ||
        (c.evidence.length > 0) !== (row.status === 'documented')) fail('INVALID_RESEARCH_RESULT');
    ids.add(c.candidate_id);
    for (const e of c.evidence) {
      if (typeof e.evidence_id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(e.evidence_id) ||
          evidenceIds.has(e.evidence_id) || e.source !== 'configured' ||
          typeof e.summary !== 'string' || !e.summary || e.summary.length > 2000) fail('INVALID_RESEARCH_RESULT');
      evidenceIds.add(e.evidence_id);
    }
  }
  return result;
}

export function researchSummary(result) {
  return { researcher: result.researcher, cache_dir: result.cache_dir,
    total: result.models.length,
    documented: result.models.filter(m => m.status === 'documented').length,
    unknown: result.models.filter(m => m.status !== 'documented').length,
    cache_hits: result.models.filter(m => m.cache_hit).length,
    cooldown_hits: result.models.filter(m => m.cooldown_hit).length,
    errors: result.models.filter(m => m.error).map(m => ({
      candidate_id: m.candidate.candidate_id, error: m.error,
    })),
  };
}

export function formatResearch(result) {
  const s = researchSummary(result);
  return `模型资料：${s.documented}/${s.total} 有依据，${s.unknown} 未确认，${s.cache_hits} 命中缓存`
    + (s.cooldown_hits ? `，${s.cooldown_hits} 项等待重试` : '')
    + `\n研究模型：${s.researcher}\n缓存目录：${s.cache_dir}`
    + (s.errors.length ? '\n更新失败：' + result.models.filter(m => m.error)
      .map(m => `${m.provider}/${m.candidate.model} (${m.error})`).join('；') : '')
    + '\n资料来自联网研究，不代表这些 API 已逐一调用验证。';
}

function taskBody(text, cards) {
  return { schema_version: '1', task: { text }, eligible_candidates: cards, relevant_preferences: [] };
}

export function candidateBatches(text, candidates, batchSize = 3, maxBytes = 9500) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 8) fail('INVALID_BATCH_SIZE');
  if (!Number.isInteger(maxBytes) || maxBytes < 1000 || maxBytes > 58000) fail('INVALID_BATCH_BUDGET');
  const batches = [];
  let batch = [];
  // Leave room for default fields added by the Python contract; never truncate the task or a card.
  const fits = cards => Buffer.byteLength(JSON.stringify(taskBody(text, cards))) <= maxBytes;
  for (const candidate of [...candidates].sort((a, b) => a.candidate_id.localeCompare(b.candidate_id))) {
    if (!fits([candidate])) fail('CONTEXT_TOO_LARGE');
    if (batch.length && (batch.length >= batchSize || !fits([...batch, candidate]))) {
      batches.push(batch); batch = [];
    }
    batch.push(candidate);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export async function classifyCatalog(cfg, text, {
  signal, images = false, getModels, research, localClassify, onProgress = () => {},
} = {}) {
  if (images) fail('TEXT_ONLY_CLASSIFIER');
  if (typeof text !== 'string' || !text.trim()) fail('EMPTY_TASK');
  if (Buffer.byteLength(text) > 10000) fail('CONTEXT_TOO_LARGE');
  const started = performance.now();
  const catalog = await eligibleCatalog(cfg, await getModels(), signal);
  if (!catalog.length) fail('NO_ELIGIBLE_MODEL');
  const researched = validateResearch(await research({ models: catalog, action: 'ensure' }), catalog);
  const cards = researched.models.map(row => row.candidate);
  const known = cards.filter(c => c.evidence.length);
  const batches = candidateBatches(text, known, cfg.batch_size ?? 3, cfg.batch_max_bytes ?? 9500);
  const results = [];
  let contextSplits = 0;
  for (let index = 0; index < batches.length; index++) {
    const cards = batches[index];
    if (signal?.aborted) fail('CLASSIFIER_CANCELLED');
    onProgress(`Gemma 分类 ${index + 1}/${batches.length} 批…`);
    let result;
    try {
      result = await localClassify(taskBody(text, cards), signal);
    } catch (error) {
      if (error?.code !== 'CONTEXT_TOO_LARGE' || cards.length === 1) throw error;
      result = { status: 'blocked', reason_codes: ['CONTEXT_TOO_LARGE'] };
    }
    // The runtime counts actual Gemma tokens before inference. Split, never truncate evidence.
    if (cards.length > 1 && result.status === 'blocked' && result.reason_codes?.includes('CONTEXT_TOO_LARGE')) {
      const middle = Math.ceil(cards.length / 2);
      batches.splice(index, 1, cards.slice(0, middle), cards.slice(middle));
      contextSplits++;
      index--;
      continue;
    }
    results.push(summarize(validateResult(result, cards)));
  }
  // Missing or ambiguous model identity is deterministically unknown; Gemma cannot guess a score.
  const unknown = cards.filter(c => !c.evidence.length).map(c => ({
    candidate_id: c.candidate_id, quality_level: null, preference_fit_level: null,
    uncertainty: 'high', evidence_ids: [], reason_codes: ['EVIDENCE_INSUFFICIENT'],
  }));
  const rows = [...results.flatMap(r => r.candidates), ...unknown].map(row => {
    const item = catalog.find(m => m.candidate_id === row.candidate_id);
    return { ...row, model: item.model, provider: item.provider, display_name: item.name };
  });
  rows.sort((a, b) => (b.quality_level ?? -1) - (a.quality_level ?? -1)
    || a.candidate_id.localeCompare(b.candidate_id));
  const source = results.some(r => r.source === 'gemma') ? 'gemma' : 'rules';
  return {
    status: results.some(r => r.status === 'blocked') ? 'blocked'
      : unknown.length || results.some(r => r.status !== 'ok') ? 'abstain' : 'ok',
    source, candidates: rows,
    reason_codes: [...new Set([
      ...results.flatMap(r => r.reason_codes),
      ...(unknown.length ? ['CAPABILITY_RESEARCH_INCOMPLETE'] : []),
    ])],
    latency_ms: Math.round(performance.now() - started),
    task_sha256: createHash('sha256').update(text).digest('hex'),
    candidate_cards_sha256: hash(cards), pipeline_version: 'v2',
    prompt_sha256: results[0]?.prompt_sha256 ?? null,
    classifier_model: results[0]?.classifier_model ?? null,
    model_digest: results[0]?.model_digest ?? null,
    usage: results.flatMap(r => r.usage), batch_count: batches.length,
    context_splits: contextSplits, wire_format: results[0]?.wire_format ?? null,
    wire_prompt_sha256: results[0]?.wire_prompt_sha256 ?? null,
    batches: results.map(r => ({ request_id: r.request_id, status: r.status,
      candidate_cards_sha256: r.candidate_cards_sha256, latency_ms: r.latency_ms })),
    research: researchSummary(researched),
    capability_records: researched.models.map(row => ({
      candidate_id: row.candidate.candidate_id, cache_key: row.cache_key, status: row.status,
      record_sha256: row.record_sha256,
      retrieved_at: row.retrieved_at, expires_at: row.expires_at, source_urls: row.source_urls,
    })),
  };
}
