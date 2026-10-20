import test from 'node:test';
import assert from 'node:assert/strict';
import { switchRecommendedModel } from './routing.mjs';

const original = { provider: 'p', id: 'manual' }, target = { provider: 'p', id: 'recommended' };
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
