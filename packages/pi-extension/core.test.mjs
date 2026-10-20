import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, loopback, requestJson, validateResult, summarize, formatResult } from './core.mjs';

const candidates = [{ candidate_id: 'one', model: 'one', revision: 'test', capabilities: ['test'], evidence: [{ evidence_id: 'ev1', source: 'configured', summary: 'Test configuration.' }] }];
function result() { return { schema_version: '1', status: 'ok', source: 'gemma', prediction: { schema_version: '1', status: 'ok', candidates: [{ candidate_id: 'one', quality_level: 3, preference_fit_level: null, uncertainty: 'high', evidence_ids: ['ev1'], reason_codes: ['TASK_MATCH'] }] }, fallback_candidate_id: null, metadata: { latency_ms: 1, verified_runtime: { model: 'gemma' }, attempts: [] }, reason_codes: [] }; }
async function server(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
function config(t, url) {
  const dir = mkdtempSync(join(tmpdir(), 'cirno-pi-test-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const file = join(dir, 'token'); writeFileSync(file, 'test-key-not-a-real-secret', { mode: 0o600 });
  return { classifier_url: url, gateway_url: url, classifier_token_file: file, gateway_token_file: file, candidates };
}

test('only literal loopback HTTP endpoints, without credentials/query', () => {
  assert.equal(loopback('http://127.0.0.1:1234').hostname, '127.0.0.1');
  for (const url of ['http://localhost:1234', 'https://example.com', 'http://127.0.0.1@evil.test', 'http://127.0.0.1/?secret=1', 'http://user:pass@127.0.0.1']) assert.throws(() => loopback(url));
});
for (const [name, mutate] of Object.entries({
  'unknown candidate': r => { r.prediction.candidates[0].candidate_id = 'evil'; },
  'duplicate candidate': r => r.prediction.candidates.push(r.prediction.candidates[0]),
  'score out of range': r => { r.prediction.candidates[0].quality_level = 5; },
  'fractional score': r => { r.prediction.candidates[0].quality_level = 1.5; },
  'cross candidate evidence': r => { r.prediction.candidates[0].evidence_ids = ['other']; },
  'invented preferences': r => { r.prediction.candidates[0].preference_fit_level = 1; },
  'invented measurement': r => { r.prediction.candidates[0].reason_codes = ['OBSERVED_PERFORMANCE']; },
  'unknown fallback': r => { r.fallback_candidate_id = 'evil'; },
  'null successful score': r => { r.prediction.candidates[0].quality_level = null; },
  'contradictory status': r => { r.status = 'blocked'; },
})) test(`rejects ${name}`, () => { const r = result(); mutate(r); assert.throws(() => validateResult(r, candidates)); });

test('abstention has no made-up score or dispatch choice', () => {
  const r = result(); r.status = r.prediction.status = 'abstain'; r.source = 'rules';
  r.prediction.candidates[0].quality_level = null;
  const summary = summarize(validateResult(r, candidates));
  assert.equal(summary.candidates[0].quality_level, null);
  assert.equal('selected_model' in summary, false);
});

test('V3 missing-input diagnostics survive summary without storing untrusted extra fields', () => {
  const r = result(); r.status = r.prediction.status = 'abstain';
  r.prediction.candidates[0].quality_level = null;
  r.metadata.input_status = 'missing'; r.metadata.pipeline_version = 'v3';
  r.metadata.candidate_evidence_status = { one: 'insufficient', evil: 'private marker' };
  const summary = summarize(validateResult(r, candidates));
  assert.equal(summary.input_status, 'missing');
  assert.deepEqual(summary.candidate_evidence_status, { one: 'insufficient' });
  assert.match(formatResult(summary), /缺少完成任务所必需的输入/);
  assert.equal(JSON.stringify(summary).includes('private marker'), false);
});

test('HTTP redirect does not forward credentials', async t => {
  let calls = 0;
  const url = await server(t, (_req, res) => { calls++; res.writeHead(302, { Location: '/leak' }); res.end(); });
  await assert.rejects(requestJson(url, 'test-key'), /HTTP_302/);
  assert.equal(calls, 1);
});

test('HTTP errors do not echo response secrets', async t => {
  const url = await server(t, (_req, res) => { res.writeHead(401); res.end('sensitive-server-body'); });
  await assert.rejects(requestJson(url, 'test-key'), error => error.message === 'HTTP_401');
});

test('deadline and caller cancellation stop requests', async t => {
  const url = await server(t, () => {});
  await assert.rejects(requestJson(url, 'test-key', { timeoutMs: 20 }), /CLASSIFIER_TIMEOUT/);
  const c = new AbortController(); c.abort();
  await assert.rejects(requestJson(url, 'test-key', { signal: c.signal }), /CLASSIFIER_CANCELLED/);
});

test('bounded response rejects oversized body', async t => {
  const url = await server(t, (_req, res) => res.end('x'.repeat(300000)));
  await assert.rejects(requestJson(url, 'test-key'), /RESPONSE_TOO_LARGE|HTTP_RESPONSE_ERROR/);
});

test('classifies only live configured candidates, never sends preferences, records no raw task', async t => {
  let posted;
  const url = await server(t, (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-key-not-a-real-secret');
    if (req.url === '/models') { res.end(JSON.stringify({ data: [{ id: 'one' }, { id: 'unconfigured' }] })); return; }
    assert.equal(req.url, '/v1/classify');
    let data = ''; req.on('data', c => data += c); req.on('end', () => { posted = JSON.parse(data); res.end(JSON.stringify(result())); });
  });
  const cfg = config(t, url);
  cfg.candidates = [...candidates, { ...candidates[0], candidate_id: 'missing', model: 'missing' }];
  const summary = await classify(cfg, 'private task marker');
  assert.deepEqual(posted.relevant_preferences, []);
  assert.deepEqual(posted.eligible_candidates, candidates);
  assert.deepEqual(summary.omitted_candidates, ['missing']);
  assert.equal(JSON.stringify(summary).includes('private task marker'), false);
  assert.equal(summary.classifier_model, 'gemma');
});

test('no eligible models does not invoke classifier', async t => {
  const paths = [];
  const url = await server(t, (req, res) => { paths.push(req.url); res.end(JSON.stringify({ data: [] })); });
  await assert.rejects(classify(config(t, url), 'task'), /NO_ELIGIBLE_MODEL/);
  assert.deepEqual(paths, ['/models']);
});

test('empty, oversized and image tasks rejected before HTTP; no silent truncation', async t => {
  const cfg = config(t, 'http://127.0.0.1:1');
  await assert.rejects(classify(cfg, ' '), /EMPTY_TASK/);
  await assert.rejects(classify(cfg, '中'.repeat(4000)), /CONTEXT_TOO_LARGE/);
  await assert.rejects(classify(cfg, 'image question', { images: true }), /TEXT_ONLY_CLASSIFIER/);
});
