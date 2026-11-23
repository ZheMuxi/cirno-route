import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync,
  unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { PricingError, readPrices, resolvePrice, validatePrices } from './pricing.mjs';

const empty = () => ({ schema_version: '1', currency: 'USD', models: {} });
const fail = code => { throw new PricingError(code); };
const identity = model => `${model.provider}/${model.id}`;
const current = (entry, now) => resolvePrice(
  { models: { 'p/m': entry } }, 'p', 'm', now).status === 'known';

function readAutomatic(file) {
  if (!file) return empty();
  try {
    const raw = readFileSync(file, 'utf8');
    if (Buffer.byteLength(raw) > 262144) fail('PRICING_CONFIG_INVALID');
    return validatePrices(JSON.parse(raw));
  } catch (error) {
    if (error.code === 'ENOENT') return empty();
    if (error instanceof PricingError) throw error;
    fail('PRICING_FILE_UNAVAILABLE');
  }
}

function endpoint(value) {
  if (typeof value !== 'string' || !value || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.search || url.hash || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) return null;
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.href;
  } catch { return null; }
}

// Zero API cost follows an explicit deployment binding, never a model-name guess,
// registry cost default, or the fact that a cloud proxy happens to use localhost.
function localEntries(models, localModels) {
  const output = {};
  for (const model of models) {
    const url = endpoint(model.baseUrl);
    if (!url) continue;
    const declared = localModels.some(row => row?.provider === model.provider
      && row.model === model.id && endpoint(row.base_url) === url);
    if (!declared) continue;
    output[identity(model)] = {
      input_per_million: 0, output_per_million: 0, cache_read_per_million: 0,
      source: 'local', billing_mode: 'token', checked_at: '1970-01-01', valid_until: '9999-12-31',
      note: '已明确登记本机推理：API token 费用为 0，不含电力、内存和硬件成本。',
      local_binding: { provider: model.provider, model: model.id, base_url: url },
    };
  }
  return output;
}

function effective(base, automatic, options) {
  const now = options.now ?? new Date();
  const entries = {};
  for (const book of [base, automatic]) {
    for (const [key, entry] of Object.entries(book.models)) {
      // Local prices are rebuilt from currently matching deployments below.
      if (entry.source === 'local') continue;
      const old = entries[key];
      if (!old) { entries[key] = entry; continue; }
      const oldCurrent = current(old, now), nextCurrent = current(entry, now);
      if (oldCurrent !== nextCurrent) {
        if (nextCurrent) entries[key] = entry;
      } else if (old.source === 'user') {
        continue;
      } else if (entry.source === 'user' || (entry.checked_at ?? '') >= (old.checked_at ?? '')) {
        entries[key] = entry;
      }
    }
  }
  const local = localEntries(options.models ?? [], options.localModels ?? []);
  return { ...empty(), models: { ...entries, ...local } };
}

export function loadEffectivePrices(cfg, options = {}) {
  return effective(readPrices(cfg.pricing_file), readAutomatic(cfg.researched_pricing_file), options);
}

function researchEntry(price, now) {
  if (!price || price.status !== 'known' || price.currency !== 'USD'
    || !['official', 'reference'].includes(price.source)) return null;
  const entry = {
    input_per_million: price.input_per_million, output_per_million: price.output_per_million,
    cache_read_per_million: price.cache_read_per_million ?? null,
    source: price.source, source_url: price.source_url, checked_at: price.checked_at,
    valid_until: price.valid_until, note: price.note,
    billing_mode: 'token',
  };
  for (const field of ['pricing_basis', 'reference_provider', 'reference_model']) {
    if (price[field] !== undefined) entry[field] = price[field];
  }
  if (price.expires_at !== undefined) entry.expires_at = price.expires_at;
  try { validatePrices({ ...empty(), models: { 'p/m': entry } }); } catch { return null; }
  // A fabricated future/expired quote is not made current by saving it now.
  return current(entry, now) ? entry : null;
}

export function syncResearchPrices(cfg, result, options = {}) {
  const now = options.now ?? new Date();
  const base = readPrices(cfg.pricing_file);
  let previous = readAutomatic(cfg.researched_pricing_file);
  const stats = { updated: 0, preserved: 0, rejected: 0, subscriptions: 0,
    local: Object.keys(localEntries(options.models ?? [], options.localModels ?? [])).length, error: null };
  const fallback = () => ({ book: effective(base, previous, options), ...stats });
  if (!cfg.researched_pricing_file) return fallback();
  if (cfg.pricing_file && resolve(cfg.researched_pricing_file) === resolve(cfg.pricing_file)) {
    stats.error = 'PRICING_SAVE_FAILED'; return fallback();
  }
  const file = cfg.researched_pricing_file, lock = `${file}.lock`;
  const temporary = `${file}.${randomUUID()}.tmp`;
  let lockFd, outputFd;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try { lockFd = openSync(lock, 'wx', 0o600); }
    catch (error) { stats.error = error.code === 'EEXIST' ? 'PRICING_FILE_BUSY' : 'PRICING_SAVE_FAILED'; return fallback(); }
    previous = readAutomatic(file);
    const next = { ...empty(), models: { ...previous.models } };
    const allowed = new Set((options.models ?? []).map(identity));
    const seen = new Set();
    const rows = Array.isArray(result?.models) ? result.models : [];
    for (const row of rows) {
      const key = `${row?.provider}/${row?.candidate?.model}`;
      if (!allowed.has(key) || seen.has(key)) { stats.rejected++; continue; }
      seen.add(key);
      if (row.pricing?.status === 'unknown' || row.pricing === undefined) {
        if (Object.hasOwn(next.models, key)) stats.preserved++;
        continue;
      }
      const entry = researchEntry(row.pricing, now);
      if (!entry) { stats.rejected++; continue; }
      const old = next.models[key];
      // Capability errors do not invalidate independent price evidence. A failed
      // price refresh may also return its still-valid cached quote: restore it
      // when needed, but never replace a current automatic price with that fallback.
      if (row.price_error && old && current(old, now)) { stats.preserved++; continue; }
      if (old && current(old, now) && old.checked_at > entry.checked_at) { stats.preserved++; continue; }
      if (JSON.stringify(old) === JSON.stringify(entry)) { stats.preserved++; continue; }
      next.models[key] = entry; stats.updated++;
    }
    validatePrices(next);
    if (stats.updated) {
      const raw = JSON.stringify(next, null, 2) + '\n';
      if (Buffer.byteLength(raw) > 262144) fail('PRICING_CONFIG_INVALID');
      outputFd = openSync(temporary, 'wx', 0o600);
      writeFileSync(outputFd, raw); fsyncSync(outputFd); closeSync(outputFd); outputFd = undefined;
      renameSync(temporary, file);
    }
    return { book: effective(base, next, options), ...stats };
  } catch (error) {
    stats.updated = 0; stats.subscriptions = 0;
    stats.error = error instanceof PricingError ? error.code : 'PRICING_SAVE_FAILED';
    return fallback();
  } finally {
    if (outputFd !== undefined) closeSync(outputFd);
    try { unlinkSync(temporary); } catch {}
    if (lockFd !== undefined) { closeSync(lockFd); try { unlinkSync(lock); } catch {} }
  }
}
