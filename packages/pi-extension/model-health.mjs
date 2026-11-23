import { createHash } from 'node:crypto';

const clean = (value, maximum = 500) => typeof value === 'string' && value.length > 0
  && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);

function identity(model) {
  const id = model?.id ?? model?.model;
  if (!clean(model?.provider, 200) || !clean(id)) return null;
  return { provider: model.provider, model: id, key: JSON.stringify([model.provider, id]) };
}

function binding(model) {
  const fields = [model?.api ?? '', model?.baseUrl ?? ''];
  if (fields.some(value => typeof value !== 'string' || value.length > 4096)) return null;
  // Keep endpoint credentials or arbitrary error text out of the in-memory status records.
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

/**
 * Temporary execution-channel health, independent of capability scores and habits.
 * Pass the turn's registry model snapshot in recordTurn(messages, { models }) so failures are
 * attributed to the endpoint used for that turn, not a later configuration change.
 * This class does not probe APIs, retry requests, or select an alternative model.
 */
export class ModelHealth {
  constructor({ now = () => Date.now(), threshold = 2, cooldownMs = 120000, windowMs = 300000 } = {}) {
    if (typeof now !== 'function' || !Number.isInteger(threshold) || threshold < 2
      || !Number.isFinite(cooldownMs) || cooldownMs <= 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError('MODEL_HEALTH_CONFIG_INVALID');
    }
    this.now = now;
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.windowMs = windowMs;
    this.records = new Map();
    this.observed = new WeakSet();
  }

  time() {
    const now = this.now();
    if (!Number.isFinite(now)) throw new RangeError('MODEL_HEALTH_CLOCK_INVALID');
    return now;
  }

  prune(now) {
    for (const [key, record] of this.records) {
      record.failures = record.failures.filter(at => at >= now - this.windowMs && at <= now);
      if (!record.failures.length && record.until <= now) this.records.delete(key);
    }
  }

  recordTurn(messages, { cancelled = false, models } = {}) {
    if (cancelled || !Array.isArray(messages)) return false;
    const final = messages.findLast(message => message?.role === 'assistant');
    if (!final || typeof final !== 'object' || this.observed.has(final)) return false;
    const success = final.stopReason === 'stop' && Array.isArray(final.content)
      && final.content.some(part => part?.type === 'text' && typeof part.text === 'string' && part.text.trim());
    const failure = final.stopReason === 'error'
      && !messages.some(message => message?.role === 'toolResult' && message.isError);
    if (!success && !failure) return false;
    const actual = identity(final);
    if (!actual) return false;
    let model = final;
    if (models !== undefined) {
      if (!Array.isArray(models)) return false;
      const matches = models.filter(candidate => identity(candidate)?.key === actual.key);
      if (matches.length !== 1) return false; // Do not guess aliases or another provider's identity.
      model = matches[0];
    }
    const fingerprint = binding(model);
    if (!fingerprint) return false;
    this.observed.add(final);
    const now = this.time();
    this.prune(now);
    if (success) {
      // A success at one endpoint must not erase failures of a differently configured endpoint.
      if (this.records.get(actual.key)?.binding === fingerprint) this.records.delete(actual.key);
      return true;
    }
    let record = this.records.get(actual.key);
    if (!record || record.binding !== fingerprint) {
      record = { provider: actual.provider, model: actual.model, binding: fingerprint, failures: [], until: 0 };
      this.records.set(actual.key, record);
    }
    record.failures.push(now);
    if (record.failures.length >= this.threshold) record.until = now + this.cooldownMs;
    return true;
  }

  isAvailable(model) {
    const now = this.time();
    this.prune(now);
    const actual = identity(model);
    if (!actual) return true; // Model validation belongs to the registry/router, not this health cache.
    const record = this.records.get(actual.key);
    return !record || record.binding !== binding(model) || record.until <= now;
  }

  status() {
    const now = this.time();
    this.prune(now);
    return [...this.records.values()].map(record => ({
      provider: record.provider, model: record.model,
      retryAfterMs: Math.max(0, record.until - now), failures: record.failures.length,
    })).sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
  }
}
