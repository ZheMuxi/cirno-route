import test from 'node:test';
import assert from 'node:assert/strict';
import { modelCatalog, candidateBatches, classifyCatalog, validateResearch } from './catalog.mjs';

const models = Array.from({ length: 11 }, (_, i) => ({
  provider: 'test-provider', id: `model-${i}`, name: `Model ${i}`,
  apiKey: 'secret-never-send', baseUrl: 'http://private-address', other: 'private-history',
}));
function researched(catalog) {
  return { schema_version: '1', researcher: 'deepseek-flash', cache_dir: '/test/cache',
    models: catalog.map(m => ({ provider: m.provider, name: m.name, status: 'documented',
      cache_hit: true, source_urls: ['https://vendor.example/model'], candidate: {
        candidate_id: m.candidate_id, model: m.model, revision: 'research-v1', capabilities: ['编程'],
        evidence: [{ evidence_id: `e-${m.candidate_id}`, source: 'configured', summary: '网页资料支持编程。' }],
      } })),
  };
}
function prediction(body) {
  return { schema_version: '1', status: 'ok', source: 'gemma', reason_codes: [],
    prediction: { schema_version: '1', status: 'ok',
      candidates: body.eligible_candidates.map(c => ({ candidate_id: c.candidate_id,
        quality_level: 3, preference_fit_level: null, uncertainty: 'medium',
        evidence_ids: [c.evidence[0].evidence_id], reason_codes: ['TASK_MATCH'] })),
    },
    metadata: { attempts: [], verified_runtime: { model: 'cirno-gemma-e4b' } },
  };
}

test('catalog projection contains only identities and stable IDs across permutations', () => {
  const first = modelCatalog(models);
  assert.deepEqual(first, modelCatalog([...models].reverse()));
  assert(!JSON.stringify(first).includes('private'));
  assert(!JSON.stringify(first).includes('secret'));
  assert.equal(new Set(first.map(m => m.candidate_id)).size, models.length);
  const local = { provider: 'cirno-local', id: 'cirno-gemma-e4b', name: 'Gemma E4B' };
  assert.equal(modelCatalog([local], { 'cirno-local/cirno-gemma-e4b': 'Exact modified checkpoint' })[0].name,
    'Exact modified checkpoint');
});

test('more than eight candidates: research first, independent bounded batches, retain every row', async () => {
  const calls = [];
  let completedResearch = false;
  const result = await classifyCatalog({ batch_size: 3 }, 'private task marker', {
    getModels: () => models,
    research: async body => {
      assert(!JSON.stringify(body).includes('private task marker'));
      assert.equal(body.models.length, 11);
      completedResearch = true;
      const data = researched(body.models);
      data.models[0].status = 'unverified'; data.models[0].candidate.evidence = [];
      return data;
    },
    localClassify: async body => {
      assert(completedResearch);
      assert.deepEqual(body.relevant_preferences, []);
      assert.equal(body.task.text, 'private task marker');
      assert(body.eligible_candidates.length <= 3);
      calls.push(body);
      return prediction(body);
    },
  });
  assert.equal(calls.length, 4);
  assert.equal(result.candidates.length, 11);
  assert.equal(result.candidates.filter(c => c.quality_level === null).length, 1);
  assert.equal(result.status, 'abstain');
  assert.equal(result.source, 'gemma');
  assert.equal(result.research.cache_hits, 11);
  assert(!JSON.stringify(result).includes('private task marker'));
  assert.equal(result.candidates[0].provider, 'test-provider');
});

test('unknown-only catalog makes no local inference and does not invent scores', async () => {
  const result = await classifyCatalog({}, 'task', {
    getModels: () => models.slice(0, 1),
    research: async body => {
      const data = researched(body.models);
      data.models[0].status = 'missing'; data.models[0].candidate.evidence = [];
      return data;
    },
    localClassify: async () => assert.fail('No evidence must not invoke Gemma'),
  });
  assert.equal(result.status, 'abstain');
  assert.equal(result.source, 'rules');
  assert.equal(result.candidates[0].quality_level, null);
});

test('batches enforce UTF-8 byte budget and preserve complete inputs', () => {
  const cards = researched(modelCatalog(models)).models.map(m => m.candidate);
  for (const c of cards) c.evidence[0].summary = '中'.repeat(1500);
  const batches = candidateBatches('task', cards, 8);
  assert(batches.every(b => b.length <= 2));
  assert.deepEqual(batches.flat(), cards);
  assert.throws(() => candidateBatches('中'.repeat(3000), cards), /CONTEXT_TOO_LARGE/);
  assert.throws(() => candidateBatches('task', cards, 0), /INVALID_BATCH_SIZE/);
});

test('rejects mismatched research identity and invented measured evidence', () => {
  const catalog = modelCatalog(models);
  let data = researched(catalog);
  data.models[0].candidate.model = 'switched-model';
  assert.throws(() => validateResearch(data, catalog), /INVALID_RESEARCH_RESULT/);
  data = researched(catalog);
  data.models[0].candidate.evidence[0].source = 'measured';
  assert.throws(() => validateResearch(data, catalog), /INVALID_RESEARCH_RESULT/);
});

test('cancellation between batches stops additional inference', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(classifyCatalog({}, 'task', {
    signal: controller.signal, getModels: () => models,
    research: async body => researched(body.models),
    localClassify: async body => { calls++; controller.abort(); return prediction(body); },
  }), /CLASSIFIER_CANCELLED/);
  assert.equal(calls, 1);
});

test('invalid tasks are rejected before catalog or research access', async () => {
  const options = { getModels: () => assert.fail(), research: () => assert.fail() };
  await assert.rejects(classifyCatalog({}, ' ', options), /EMPTY_TASK/);
  await assert.rejects(classifyCatalog({}, 'picture', { ...options, images: true }), /TEXT_ONLY/);
});

test('actual token overflow bisects batches without losing candidates or changing evidence', async () => {
  const calls = [];
  const result = await classifyCatalog({ batch_size: 8, batch_max_bytes: 28000 }, 'complete task', {
    getModels: () => models,
    research: async body => researched(body.models),
    localClassify: async body => {
      calls.push(body);
      if (body.eligible_candidates.length > 4) return {
        status: 'blocked', reason_codes: ['CONTEXT_TOO_LARGE'],
      };
      return prediction(body);
    },
  });
  assert.equal(result.context_splits, 1);
  assert.equal(result.batch_count, 3);
  assert.equal(calls.length, 4);
  assert.equal(result.candidates.length, models.length);
  assert.equal(new Set(result.candidates.map(c => c.candidate_id)).size, models.length);
  assert(calls.every(c => c.task.text === 'complete task'));
  const allCards = researched(modelCatalog(models)).models.map(m => m.candidate);
  assert.deepEqual(calls.filter(c => c.eligible_candidates.length <= 4).flatMap(c => c.eligible_candidates), allCards);
});

test('non-context errors do not trigger wasteful batch retries', async () => {
  let calls = 0;
  await assert.rejects(classifyCatalog({ batch_size: 8 }, 'task', {
    getModels: () => models,
    research: async body => researched(body.models),
    localClassify: async () => { calls++; throw new Error('MODEL_UNAVAILABLE'); },
  }), /MODEL_UNAVAILABLE/);
  assert.equal(calls, 1);
});
