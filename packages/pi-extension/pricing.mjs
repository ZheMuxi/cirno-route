import { readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const PRICE_MODES = Object.freeze({
  cheap: '希望便宜', balanced: '均衡', premium: '接受昂贵',
});
export class PricingError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new PricingError(code); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const rate = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100000;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 500
  && !/[\x00-\x1f\x7f]/.test(value);

export function priceMode(value) {
  return Object.keys(PRICE_MODES).find(k => k === value || PRICE_MODES[k] === value) ?? null;
}

export function validatePrices(data) {
  if (data?.schema_version !== '1' || data.currency !== 'USD' || !plain(data.models)
      || Object.keys(data.models).length > 256) fail('PRICING_CONFIG_INVALID');
  for (const [id, p] of Object.entries(data.models)) {
    if (!text(id) || !id.includes('/') || !plain(p)) fail('PRICING_CONFIG_INVALID');
    if (p.input_per_million === null && p.output_per_million === null) continue;
    if (!rate(p.input_per_million) || !rate(p.output_per_million)
        || (p.cache_read_per_million != null && !rate(p.cache_read_per_million))
        || !['official', 'reference', 'user', 'local'].includes(p.source)
        || !date(p.checked_at) || !date(p.valid_until) || p.valid_until < p.checked_at
        || !text(p.note)) fail('PRICING_CONFIG_INVALID');
    if (['official', 'reference'].includes(p.source)) {
      let url;
      try { url = new URL(p.source_url); } catch { fail('PRICING_CONFIG_INVALID'); }
      if (url.protocol !== 'https:' || url.username || url.password) fail('PRICING_CONFIG_INVALID');
    }
  }
  return data;
}

export function readPrices(file) {
  if (!file) return { schema_version: '1', currency: 'USD', models: {} };
  try {
    const raw = readFileSync(file, 'utf8');
    if (Buffer.byteLength(raw) > 262144) fail('PRICING_CONFIG_INVALID');
    return validatePrices(JSON.parse(raw));
  } catch (error) {
    if (error instanceof PricingError) throw error;
    fail('PRICING_FILE_UNAVAILABLE');
  }
}

export function resolvePrice(book, provider, model, now = new Date()) {
  const key = `${provider}/${model}`;
  const p = Object.hasOwn(book.models, key) ? book.models[key] : null;
  if (!p || p.input_per_million === null) return { status: 'unknown', currency: 'USD' };
  const day = now.toISOString().slice(0, 10);
  if (day > p.valid_until || day < p.checked_at) {
    return { ...p, status: 'stale', currency: 'USD', comparison_cost: null };
  }
  // A common workload is comparable; it is not a prediction of this conversation's bill.
  return { ...p, status: 'known', currency: 'USD',
    comparison_cost: (p.input_per_million + p.output_per_million) / 1000 };
}

export class PricePreference {
  constructor(file, defaultMode = 'balanced') {
    this.file = file;
    this.defaultMode = priceMode(defaultMode);
    if (!this.defaultMode) fail('PRICE_PREFERENCE_INVALID');
    this.memory = this.defaultMode;
  }
  get() {
    if (!this.file) return this.memory;
    try {
      const raw = readFileSync(this.file, 'utf8');
      if (Buffer.byteLength(raw) > 4096) fail('PRICE_PREFERENCE_INVALID');
      const data = JSON.parse(raw);
      if (data.schema_version !== '1' || !Object.hasOwn(PRICE_MODES, data.price_preference)) {
        fail('PRICE_PREFERENCE_INVALID');
      }
      return data.price_preference;
    } catch (error) {
      if (error.code === 'ENOENT') return this.defaultMode;
      fail('PRICE_PREFERENCE_INVALID');
    }
  }
  set(value) {
    const mode = priceMode(value);
    if (!mode) fail('PRICE_PREFERENCE_INVALID');
    if (this.file) {
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
        writeFileSync(temp, JSON.stringify({ schema_version: '1', price_preference: mode }) + '\n',
          { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        renameSync(temp, this.file);
      } catch { fail('PRICE_PREFERENCE_SAVE_FAILED'); }
      finally { try { unlinkSync(temp); } catch {} }
    }
    this.memory = mode;
    return mode;
  }
}

const cost = row => row.pricing.status === 'known' ? row.pricing.comparison_cost : Infinity;
const quality = (a, b) => (b.quality_level ?? -1) - (a.quality_level ?? -1);
const cheap = (a, b) => {
  const aCost = cost(a), bCost = cost(b);
  return (aCost === bCost ? 0 : aCost < bCost ? -1 : 1) || quality(a, b)
    || a.candidate_id.localeCompare(b.candidate_id);
};
const best = (a, b) => quality(a, b) || cheap(a, b);
const expensive = (a, b) => {
  const aKnown = a.pricing.status === 'known', bKnown = b.pricing.status === 'known';
  if (aKnown !== bKnown) return aKnown ? -1 : 1;
  return (aKnown ? cost(b) - cost(a) : 0) || a.candidate_id.localeCompare(b.candidate_id);
};

export function recommend(result, book, mode = 'balanced', now = new Date()) {
  if (!Object.hasOwn(PRICE_MODES, mode)) fail('PRICE_PREFERENCE_INVALID');
  const candidates = result.candidates.map(row => ({
    ...row, pricing: resolvePrice(book, row.provider, row.model, now),
  }));
  // Unknown/unsupported/partial capabilities never become suitable merely by being cheap.
  const eligible = result.status === 'blocked' || result.input_status === 'missing'
    || result.source !== 'gemma' ? []
    : candidates.filter(r => Number.isInteger(r.quality_level) && r.quality_level >= 3
      && r.quality_level <= 4 && r.evidence_ids?.length);
  const highest = Math.max(0, ...eligible.map(r => r.quality_level));
  const top = eligible.filter(r => r.quality_level === highest).sort(mode === 'premium' ? expensive : cheap);
  const comparable = eligible.filter(r => r.quality_level >= highest - 1
    && r.pricing.status === 'known').sort(cheap);
  let selected = top[0] ?? null;
  let reason = selected ? (mode === 'premium' ? 'QUALITY_FIRST_EXPENSIVE_TIE' : 'QUALITY_FIRST')
    : 'NO_SUITABLE_CANDIDATE';
  if (mode === 'cheap' && comparable.length) {
    selected = comparable[0];
    reason = 'CHEAPEST_SUITABLE';
  } else if (mode === 'balanced' && comparable.length && selected
      && Number.isFinite(cost(selected)) && cost(selected) > 3 * cost(comparable[0])) {
    selected = comparable[0];
    reason = 'LARGE_SAVING_WITH_SMALL_QUALITY_GAP';
  }
  if (selected && !Number.isFinite(cost(selected))) reason = 'PRICE_UNKNOWN_QUALITY_ONLY';
  candidates.sort((a, b) => {
    if (a.candidate_id === b.candidate_id) return 0;
    if (a.candidate_id === selected?.candidate_id) return -1;
    if (b.candidate_id === selected?.candidate_id) return 1;
    return mode === 'premium' ? quality(a, b) || expensive(a, b) : best(a, b);
  });
  return { ...result, candidates,
    routing: {
      policy_version: 'quality-price-v1', price_preference: mode,
      recommended_candidate_id: selected?.candidate_id ?? null,
      provider: selected?.provider ?? null, model: selected?.model ?? null,
      reason, minimum_quality: 3,
      comparison: { currency: 'USD', input_tokens: 1000, output_tokens: 1000, cache_hit_ratio: 0 },
      known_prices: candidates.filter(r => r.pricing.status === 'known').length,
      unknown_prices: candidates.filter(r => r.pricing.status !== 'known').length,
      price_book_sha256: createHash('sha256').update(JSON.stringify(book)).digest('hex'),
      evaluated_at: now.toISOString(),
    },
  };
}

export function formatPrice(price) {
  if (!price || price.status === 'unknown') return '价格未知';
  if (price.status === 'stale') return '价格已过期，未参与比较';
  const kind = { official: '官方标准价', reference: '官方参考价', user: '用户配置价', local: '本地 API 成本' }[price.source];
  return `USD/百万 token 输入 ${price.input_per_million} / 输出 ${price.output_per_million}`
    + ` · 1k+1k 约 $${price.comparison_cost.toFixed(6)} · ${kind}`;
}

export function formatRecommendation(routing) {
  if (!routing) return '';
  const reasons = {
    QUALITY_FIRST: '能力优先，同分比较价格',
    QUALITY_FIRST_EXPENSIVE_TIE: '能力优先，同分选择已知价格较高的模型',
    CHEAPEST_SUITABLE: '在达到能力门槛的候选中优先低价',
    LARGE_SAVING_WITH_SMALL_QUALITY_GAP: '能力差距不超过 1 级且参考成本节省超过三分之二',
    PRICE_UNKNOWN_QUALITY_ONLY: '缺少可比价格，退回能力优先',
    NO_SUITABLE_CANDIDATE: '当前没有可推荐的候选，需要有效分类、必要任务资料及至少 3/4 的有依据评分',
  };
  return `价格偏好：${PRICE_MODES[routing.price_preference]} · 推荐：`
    + (routing.model ? `${routing.provider}/${routing.model}` : '暂不推荐')
    + `\n${reasons[routing.reason] ?? routing.reason}`;
}
