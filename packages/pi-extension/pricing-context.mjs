import { PricingError, resolvePrice, validatePrices } from './pricing.mjs';

const fail = () => { throw new PricingError('PRICING_CONTEXT_INVALID'); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const rate = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100000;
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value);
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 200
  && !/[\x00-\x1f\x7f]/.test(value);
const topKeys = ['currency', 'unit', 'prices'];
const rowKeys = ['candidate_id', 'status', 'basis', 'input_per_million', 'output_per_million', 'cache_read_per_million'];
const exactKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const order = (a, b) => a.candidate_id < b.candidate_id ? -1 : a.candidate_id > b.candidate_id ? 1 : 0;

function candidateIds(candidates) {
  if (!Array.isArray(candidates) || candidates.length > 128) fail();
  const ids = candidates.map(c => c?.candidate_id);
  if (ids.some(value => !id(value)) || new Set(ids).size !== ids.length) fail();
  return new Set(ids);
}

function normalize(context) {
  if (!exactKeys(context, topKeys) || context.currency !== 'USD' || context.unit !== 'per_million_tokens'
    || !Array.isArray(context.prices) || context.prices.length > 128) fail();
  const seen = new Set();
  const prices = context.prices.map(row => {
    if (!exactKeys(row, rowKeys) || !id(row.candidate_id) || seen.has(row.candidate_id)
      || !['known', 'unknown', 'stale'].includes(row.status)
      || !['official_api', 'user', 'local', 'unknown'].includes(row.basis)) fail();
    seen.add(row.candidate_id);
    const amounts = [row.input_per_million, row.output_per_million, row.cache_read_per_million];
    if (row.status === 'known') {
      if (row.basis === 'unknown' || !amounts.slice(0, 2).every(rate)
        || (amounts[2] !== null && !rate(amounts[2]))
        || (row.basis === 'local' && !amounts.every(value => value === 0))) fail();
    } else if (row.basis !== 'unknown' || !amounts.every(value => value === null)) fail();
    // Copy only contract fields; mutable book records, notes and source URLs never enter Gemma.
    return Object.fromEntries(rowKeys.map(key => [key, row[key]]));
  }).sort(order);
  return { currency: 'USD', unit: 'per_million_tokens', prices };
}

export function normalizePricingContext(context, candidates) {
  const snapshot = normalize(context);
  const ids = candidateIds(candidates);
  if (ids.size !== snapshot.prices.length || snapshot.prices.some(row => !ids.has(row.candidate_id))) fail();
  return snapshot;
}

export function selectPricingContext(context, candidates) {
  const snapshot = normalize(context);
  const ids = candidateIds(candidates);
  snapshot.prices = snapshot.prices.filter(row => ids.has(row.candidate_id));
  if (snapshot.prices.length !== ids.size) fail();
  return snapshot;
}

// The caller supplies the effective manual + researched + verified-local price book.
// Price remains separate from capability evidence and from the user's routing preference.
export function buildPricingContext(book, catalog, now = new Date()) {
  validatePrices(book);
  candidateIds(catalog);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail();
  const prices = catalog.map(candidate => {
    if (!identity(candidate.provider) || !identity(candidate.model)) fail();
    const resolved = resolvePrice(book, candidate.provider, candidate.model, now);
    const known = resolved.status === 'known';
    const basis = !known ? 'unknown' : ['official', 'reference'].includes(resolved.source)
      ? 'official_api' : resolved.source;
    return { candidate_id: candidate.candidate_id, status: resolved.status, basis,
      input_per_million: known ? resolved.input_per_million : null,
      output_per_million: known ? resolved.output_per_million : null,
      cache_read_per_million: known ? resolved.cache_read_per_million ?? (basis === 'local' ? 0 : null) : null };
  });
  return normalizePricingContext({ currency: 'USD', unit: 'per_million_tokens', prices }, catalog);
}
