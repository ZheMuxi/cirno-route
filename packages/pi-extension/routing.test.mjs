import test from 'node:test';
import assert from 'node:assert/strict';
import { switchRecommendedModel, switchHabitModel } from './routing.mjs';
import { HabitStore, hash, habitScope, manualTaskProfile } from './habits.mjs';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const original = { provider: 'p', id: 'manual' }, target = { provider: 'p', id: 'recommended' };
const vector = (a = 1) => [a, Math.sqrt(1 - a * a), ...Array(382).fill(0)];
const profile = { kind: 'code_implement', difficulty: 'routine', requirements: [], reusable: true };
function habitStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cirno-habit-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new HabitStore({ file: join(dir, 'habits.json'), enabled: true, threshold: 5, min_similarity: 0.985, min_margin: 0.04 });
}
function sample(i, overrides = {}) {
  return { id: String(i), source: 'gemma', scope: hash('scope'), profile, embedding: vector(),
    taskHash: hash('private task ' + i), provider: target.provider, model: target.id, ...overrides };
}

test('habit learns five successes, is idempotent, and habit hits never reinforce or retain raw prompts', async t => {
  const store = habitStore(t), scope = hash('scope');
  for (let i = 0; i < 4; i++) await store.record(sample(i));
  assert(!store.eligible(scope)); assert.equal(store.lookup(scope, vector()), null);
  await store.record(sample(4));
  assert.equal(store.lookup(scope, vector()).count, 5);
  const raw = readFileSync(store.file, 'utf8');
  await store.record(sample(4)); await store.record(sample(5, { source: 'habit' }));
  assert.equal(readFileSync(store.file, 'utf8'), raw);
  assert(!raw.includes('private task')); assert.equal(statSync(store.file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(store.file, '..')), ['habits.json']);
});

test('habit requires unique most-used model, isolates price/config scopes, and considers immature competing types', async t => {
  const store = habitStore(t), scope = hash('scope');
  for (let i = 0; i < 5; i++) await store.record(sample(i));
  assert.equal(store.lookup(hash('other-price'), vector()), null);
  for (let i = 5; i < 10; i++) await store.record(sample(i, { model: 'other' }));
  assert.equal(store.lookup(scope, vector()), null); // 5:5 tie.
  await store.record(sample(10)); assert.equal(store.lookup(scope, vector()).model, target.id);
  await store.record(sample(11, { profile: { ...profile, kind: 'code_explain' }, embedding: vector(0.98) }));
  assert.equal(store.lookup(scope, vector()), null); // Competing type has only one observation.
  const book = { schema_version: '1', currency: 'USD', models: {} };
  assert.notEqual(habitScope('cheap', book, [target]), habitScope('premium', book, [target]));
  assert.equal(habitScope('balanced', book, [target, original]), habitScope('balanced', book, [original, target]));
  assert.notEqual(habitScope('balanced', book, [target]), habitScope('balanced', book, [{ ...target, baseUrl: 'https://example.org' }]));
});

test('habit validates vectors and profiles, serializes concurrent writers, supports disabling and clearing', async t => {
  const store = habitStore(t);
  await assert.rejects(store.record(sample(0, { embedding: [1] })), /SEMANTIC|HABITS_RECORD_INVALID/);
  await assert.rejects(store.record(sample(0, { profile: { ...profile, kind: 'unknown' } })), /HABITS_RECORD_INVALID/);
  await Promise.all(Array.from({ length: 10 }, (_, i) => store.record(sample(i))));
  assert.equal(store.read().groups[0].counts[0].count, 10);
  await store.configure({ enabled: false }); await store.record(sample(11));
  assert.equal(store.read().groups[0].counts[0].count, 10);
  assert.equal(store.lookup(hash('scope'), vector()), null);
  await assert.rejects(store.configure({ threshold: 0 }), /HABITS_THRESHOLD_INVALID/);
  await store.configure({ clear: true, enabled: true, threshold: 7 });
  assert.equal(store.read().groups.length, 0); assert.equal(store.read().threshold, 7);
  writeFileSync(store.file, 'private invalid data');
  assert.throws(() => store.read(), error => error.message === 'HABITS_FILE_INVALID');
  await store.configure({ clear: true }); assert.equal(store.read().groups.length, 0);
  await store.record(sample(20, { shouldRecord: () => false }));
  assert.equal(store.read().groups.length, 0);
});

test('manual rules distinguish operation and reject ambiguous/context-dependent tasks', () => {
  assert.equal(manualTaskProfile('写一个 Python 函数检查回文').kind, 'code_implement');
  assert.equal(manualTaskProfile('证明素数有无限多个').kind, 'math_prove');
  assert.equal(manualTaskProfile('Translate the following sentence: hello').kind, 'translate');
  assert.equal(manualTaskProfile('继续修改上面的代码'), null);
  assert.equal(manualTaskProfile('写一个函数然后解释它'), null);
  assert.equal(manualTaskProfile('翻译下面的内容。'), null);
});

test('habit routing uses exact target with availability, cancellation and restoration guards', async () => {
  const hit = { provider: target.provider, model: target.id, count: 5, threshold: 5 };
  const h = harness();
  assert.equal((await switchHabitModel(hit, 'balanced', h.options)).source, 'habit');
  await assert.rejects(switchHabitModel({ ...hit, count: 4 }, 'balanced', h.options), /HABIT_NOT_READY/);
  const missing = harness({ isAvailable: async () => false });
  await assert.rejects(switchHabitModel(hit, 'balanced', missing.options), /ROUTER_MODEL_UNAVAILABLE/);
  const stale = harness();
  stale.options.setModel = async m => { stale.model = m; stale.active = false; return true; };
  assert.equal((await switchHabitModel(hit, 'balanced', stale.options)).status, 'skipped');
  assert.equal(stale.model, original);
});
const result = () => ({
  status: 'abstain', source: 'gemma', candidates: [
    { candidate_id: 'one', provider: target.provider, model: target.id, quality_level: 4, evidence_ids: ['e'] },
    { candidate_id: 'unknown', quality_level: null, evidence_ids: [] },
  ],
  routing: { recommended_candidate_id: 'one', provider: target.provider, model: target.id,
    price_preference: 'balanced', reason: 'QUALITY_FIRST' },
});
function harness(overrides = {}) {
  const h = { model: original, calls: [], active: true, aborted: false };
  h.options = {
    getModels: () => [original, target],
    getModel: () => h.model,
    setModel: async model => { h.calls.push(model); h.model = model; return true; },
    isAvailable: async () => true,
    isActive: () => h.active,
    abort: () => { h.aborted = true; },
    state: { restoreModel: original, switchingTo: null },
    ...overrides,
  };
  return h;
}

test('switches the exact registry model, retaining other unknown candidates; same model is not switched twice', async () => {
  const h = harness();
  const outcome = await switchRecommendedModel(result(), h.options);
  assert.equal(outcome.status, 'switched');
  assert.deepEqual(h.calls, [target]);
  assert.equal(h.model, target);
  assert(!('candidates' in outcome));
  assert.equal((await switchRecommendedModel(result(), h.options)).status, 'unchanged');
  assert.equal(h.calls.length, 1);
});

test('abstained or forged choices never dispatch, even with an expensive price preference', async () => {
  for (const mutate of [
    r => { r.source = 'rules'; }, r => { r.status = 'blocked'; },
    r => { r.input_status = 'missing'; }, r => { r.candidates[0].quality_level = null; },
    r => { r.candidates[0].quality_level = 2; }, r => { r.candidates[0].evidence_ids = []; },
    r => { r.routing.recommended_candidate_id = 'unknown'; },
    r => { r.routing.provider = 'other'; }, r => { r.routing.model = 'other'; },
  ]) {
    const h = harness(), r = result(); mutate(r);
    await assert.rejects(switchRecommendedModel(r, h.options), /ROUTER_NO_SUITABLE_MODEL/);
    assert.equal(h.calls.length, 0);
  }
});

test('model removed from registry or gateway does not dispatch and does not retry other models', async () => {
  for (const overrides of [
    { getModels: () => [original] },
    { isAvailable: async () => false },
    { isAvailable: async () => { throw Error('private gateway response'); } },
  ]) {
    const h = harness(overrides);
    await assert.rejects(switchRecommendedModel(result(), h.options), error => error.message === 'ROUTER_MODEL_UNAVAILABLE');
    assert.equal(h.model, original);
    assert.equal(h.calls.length, 0);
  }
});

test('disabled/cancelled route is skipped, including changes during availability checks', async () => {
  const c = new AbortController(); c.abort();
  const h1 = harness({ signal: c.signal });
  assert.equal((await switchRecommendedModel(result(), h1.options)).status, 'skipped');
  assert.equal(h1.calls.length, 0);
  const h2 = harness(); h2.active = false;
  assert.equal((await switchRecommendedModel(result(), h2.options)).status, 'skipped');
  assert.equal(h2.calls.length, 0);
  const h3 = harness();
  h3.options.isAvailable = async () => { h3.active = false; return true; };
  assert.equal((await switchRecommendedModel(result(), h3.options)).status, 'skipped');
  assert.equal(h3.calls.length, 0);
});

test('SDK false/throw leaves the current model and returns a fixed error without leaking auth details', async () => {
  for (const setModel of [async () => false, async () => { throw Error('secret auth failure'); }]) {
    const h = harness({ setModel });
    await assert.rejects(switchRecommendedModel(result(), h.options), error => error.message === 'ROUTER_SWITCH_FAILED');
    assert.equal(h.model, original);
    assert.equal(h.aborted, false);
  }
});

test('cancel or toggle off while SDK auth is pending rolls back its late model switch', async () => {
  for (const change of ['toggle', 'abort']) {
    const c = new AbortController(), h = harness({ signal: c.signal });
    h.options.setModel = async model => {
      h.calls.push(model); h.model = model;
      if (model === target) {
        if (change === 'toggle') h.active = false;
        else c.abort();
      }
      return true;
    };
    assert.equal((await switchRecommendedModel(result(), h.options)).status, 'skipped');
    assert.deepEqual(h.calls, [target, original]);
    assert.equal(h.model, original);
  }
});

test('late switch restores the latest manual choice, not an earlier model; failed restore aborts execution', async () => {
  const manual = { provider: 'p', id: 'new-manual' }, h = harness();
  h.options.setModel = async model => {
    h.calls.push(model); h.model = model;
    if (model === target) {
      h.options.state.restoreModel = manual; // model_select observed during authentication
      h.active = false;
    }
    return true;
  };
  assert.equal((await switchRecommendedModel(result(), h.options)).status, 'skipped');
  assert.equal(h.model, manual);
  const failed = harness();
  failed.options.setModel = async model => {
    if (model === original) return false;
    failed.model = model; failed.active = false; return true;
  };
  await assert.rejects(switchRecommendedModel(result(), failed.options), /ROUTER_RESTORE_FAILED/);
  assert(failed.aborted);
});

test('SDK exceptions after a partial switch are rolled back; a newer manual selection is kept', async () => {
  const h = harness();
  h.options.setModel = async model => {
    h.model = model; h.calls.push(model);
    if (model === target) throw Error('private error after state mutation');
    return true;
  };
  await assert.rejects(switchRecommendedModel(result(), h.options), /ROUTER_SWITCH_FAILED/);
  assert.equal(h.model, original);
  assert.deepEqual(h.calls, [target, original]);
  const newer = { provider: 'p', id: 'newer' }, other = harness();
  other.options.setModel = async () => { other.model = newer; other.active = false; return true; };
  assert.equal((await switchRecommendedModel(result(), other.options)).status, 'skipped');
  assert.equal(other.model, newer);
});
