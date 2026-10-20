import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PricePreference, priceMode, readPrices, validatePrices, resolvePrice, recommend, formatPrice } from './pricing.mjs';
import { readConfig, formatResult } from './core.mjs';

const now = new Date('2026-10-21T08:00:00Z');
const price = (input, output) => ({
  input_per_million: input, output_per_million: output, source: 'user',
  checked_at: '2026-10-21', valid_until: '2026-11-20', note: 'Test rates, not real model prices.',
});
const book = (models = {}) => ({ schema_version: '1', currency: 'USD', models });
const row = (id, quality) => ({ candidate_id: id, provider: 'p', model: id,
  quality_level: quality, preference_fit_level: null, uncertainty: 'medium',
  evidence_ids: quality === null ? [] : [`${id}-evidence`], reason_codes: ['TASK_MATCH'] });
const result = (rows) => ({ status: 'ok', source: 'gemma', candidates: rows, reason_codes: [] });
const chosen = (r, b, mode) => recommend(r, b, mode, now).routing.recommended_candidate_id;

test('three modes trade off price and quality without changing quality scores or dropping candidates', () => {
  const r = result([row('best', 4), row('budget', 3), row('poor', 2), row('unknown', null)]);
  const original = structuredClone(r);
  const b = book({ 'p/best': price(1, 3), 'p/budget': price(1, 1), 'p/poor': price(0, 0) });
  assert.equal(chosen(r, b, 'cheap'), 'budget');
  assert.equal(chosen(r, b, 'balanced'), 'best');
  assert.equal(chosen(r, b, 'premium'), 'best');
  b.models['p/best'] = price(5, 5);
  assert.equal(chosen(r, b, 'balanced'), 'budget');
  assert.equal(chosen(r, b, 'premium'), 'best');
  for (const mode of ['cheap', 'balanced', 'premium']) {
    const ranked = recommend(r, b, mode, now);
    assert.equal(ranked.candidates.length, 4);
    for (const candidate of ranked.candidates) {
      const { pricing, ...unchanged } = candidate;
      assert.deepEqual(unchanged, original.candidates.find(c => c.candidate_id === candidate.candidate_id));
    }
  }
  assert.deepEqual(r, original);
});

test('balanced threshold is strict; premium prefers expensive ties, independent of candidate order', () => {
  const b = book({ 'p/a': price(1, 2), 'p/b': price(0.5, 0.5) });
  assert.equal(chosen(result([row('a', 4), row('b', 3)]), b, 'balanced'), 'a');
  const rows = [row('a', 4), row('b', 4), row('z', 4), row('c', null)];
  for (const mode of ['cheap', 'balanced', 'premium']) {
    const first = recommend(result(rows), b, mode, now);
    const reversed = recommend(result([...rows].reverse()), b, mode, now);
    assert.deepEqual(first, reversed);
    assert.equal(first.routing.recommended_candidate_id, mode === 'premium' ? 'a' : 'b');
  }
  assert.equal(chosen(result([row('z', 4), row('a', 4)]), book(), 'premium'), 'a');
});

test('premium keeps quality first and never treats missing or expired prices as expensive', () => {
  const b = book({ 'p/high': price(100, 100), 'p/best': price(1, 1),
    'p/stale': { ...price(1000, 1000), checked_at: '2026-09-01', valid_until: '2026-10-01' } });
  assert.equal(chosen(result([row('high', 3), row('best', 4)]), b, 'premium'), 'best');
  assert.equal(chosen(result([row('high', 4), row('best', 4), row('unknown', 4), row('stale', 4)]), b, 'premium'), 'high');
  assert.equal(chosen(result([row('best', 4), row('stale', 4)]), b, 'premium'), 'best');
  assert.equal(recommend(result([row('best', 4)]), b, 'premium', now).routing.reason, 'QUALITY_FIRST_EXPENSIVE_TIE');
});

test('unknown, stale and alias prices are not zero; explicit zero is valid', () => {
  const b = book({ 'p/a': price(1, 1), 'p/old': { ...price(0, 0), valid_until: '2026-10-21' },
    'p/free': price(0, 0), 'p/null': { input_per_million: null, output_per_million: null } });
  validatePrices(b);
  assert.equal(resolvePrice(b, 'p', 'a-thinking', now).status, 'unknown');
  assert.equal(resolvePrice(b, 'different-provider', 'a', now).status, 'unknown');
  assert.equal(resolvePrice(b, 'p', 'null', now).status, 'unknown');
  assert.equal(resolvePrice(b, 'p', 'old', new Date('2026-10-22')).status, 'stale');
  assert.equal(resolvePrice(b, 'p', 'a', new Date('2026-10-20')).status, 'stale');
  assert.equal(resolvePrice(b, 'p', 'free', now).comparison_cost, 0);
  assert.equal(chosen(result([row('free', 3), row('a', 4)]), b, 'cheap'), 'free');
  assert.equal(chosen(result([row('unpriced', 4), row('a', 3)]), b, 'cheap'), 'a');
  assert.equal(chosen(result([row('unpriced', 4), row('a', 3)]), b, 'premium'), 'unpriced');
  assert.match(formatPrice(resolvePrice(b, 'p', 'unpriced', now)), /未知/);
});

test('prices never turn abstention, blocked input, rules fallback or weak evidence into a recommendation', () => {
  const b = book({ 'p/a': price(0, 0) });
  for (const mode of ['cheap', 'balanced', 'premium']) {
    for (const r of [
      result([row('a', null)]), result([row('a', 2)]),
      result([{ ...row('a', 4), evidence_ids: [] }]),
      { ...result([row('a', 4)]), status: 'blocked' },
      { ...result([row('a', 4)]), source: 'rules' },
      { ...result([row('a', 4)]), input_status: 'missing' },
    ]) assert.equal(chosen(r, b, mode), null);
    // A catalog with unknown rows may still recommend its evidenced candidates.
    assert.equal(chosen({ ...result([row('a', 4), row('b', null)]), status: 'abstain' }, b, mode), 'a');
  }
});

test('pricing rejects currency mixing, invalid amounts/dates and unsafe official source URLs', () => {
  for (const b of [
    { ...book(), currency: 'CNY' },
    book({ 'p/a': price(-1, 2) }), book({ 'p/a': price('0', 2) }),
    book({ 'p/a': price(NaN, 2) }), book({ 'p/a': price(1, Infinity) }),
    book({ 'p/a': price(null, 2) }),
    book({ 'p/a': { ...price(1, 2), checked_at: '2026-02-30' } }),
    book({ 'p/a': { ...price(1, 2), valid_until: '2025-01-01' } }),
    book({ 'p/a': { ...price(1, 2), source: 'reference', source_url: 'https://secret@example.com' } }),
    book({ 'p/a': { ...price(1, 2), source: 'official', source_url: 'file:///tmp/price' } }),
  ]) assert.throws(() => validatePrices(b), /PRICING_CONFIG_INVALID/);
  assert.throws(() => recommend(result([]), book(), 'other', now), /PRICE_PREFERENCE_INVALID/);
});

test('explicit preference persists atomically, defaults to balanced, accepts Chinese and English', t => {
  const dir = mkdtempSync(join(tmpdir(), 'cirno-price-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const file = join(dir, 'private/preferences.json');
  const prefs = new PricePreference(file);
  assert.equal(prefs.get(), 'balanced');
  assert.equal(prefs.set('希望便宜'), 'cheap');
  assert.equal(new PricePreference(file).get(), 'cheap');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(prefs.set('接受昂贵'), 'premium');
  assert.equal(new PricePreference(file).get(), 'premium');
  assert.throws(() => prefs.set('bad'), /PRICE_PREFERENCE_INVALID/);
  assert.equal(prefs.get(), 'premium');
  writeFileSync(file, '{"schema_version":"1","price_preference":"bad"}');
  assert.throws(() => prefs.get(), /PRICE_PREFERENCE_INVALID/);
  assert.equal(prefs.set('balanced'), 'balanced');
  assert.equal(prefs.get(), 'balanced');
  assert.equal(priceMode('均衡'), 'balanced');
  assert.equal(priceMode('__proto__'), null);
});

test('price file errors are redacted; config paths resolve from the config directory', t => {
  const dir = mkdtempSync(join(tmpdir(), 'cirno-price-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const file = join(dir, 'prices.json');
  writeFileSync(file, 'secret unparseable contents');
  assert.throws(() => readPrices(file), error => error.message === 'PRICING_FILE_UNAVAILABLE');
  assert.throws(() => readPrices(join(dir, 'missing')), /PRICING_FILE_UNAVAILABLE/);
  const configFile = fileURLToPath(new URL('../../config/pi-classifier.json', import.meta.url));
  const cfg = readConfig(configFile);
  assert.equal(cfg.price_preference, 'balanced');
  assert.equal(readPrices(cfg.pricing_file).currency, 'USD');
  const invalid = JSON.parse(readFileSync(configFile));
  invalid.price_preference = 'bad';
  writeFileSync(file, JSON.stringify(invalid));
  assert.throws(() => readConfig(file), /INVALID_CONFIG/);
});

test('price display separates quality, reference cost, sources and unknowns', () => {
  const b = book({ 'p/a': { ...price(1, 2), source: 'reference', source_url: 'https://example.com/prices' } });
  const ranked = recommend(result([row('a', 4), row('missing', null)]), b, 'premium', now);
  const display = formatResult(ranked);
  assert.match(display, /价格偏好：接受昂贵 · 推荐：p\/a/);
  assert.match(display, /输入 1 \/ 输出 2/);
  assert.match(display, /官方参考价/);
  assert.match(display, /价格未知/);
  assert.match(display, /不是本次账单/);
  assert.match(display, /1 已配置 · 1 未知/);
  assert.equal(ranked.routing.price_book_sha256.length, 64);
});
