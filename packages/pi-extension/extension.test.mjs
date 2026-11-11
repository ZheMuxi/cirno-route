import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension, { registerClassifier } from './index.ts';
import { HabitStore, manualTaskProfile } from './habits.mjs';

function habitHarness(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cirno-habit-extension-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new HabitStore({ file: join(dir, 'habits.json'), enabled: true, threshold: 5, min_similarity: 0.985, min_margin: 0.04 });
  const commands = new Map(), events = new Map();
  const h = { commands, events, store, calls: 0, embeds: 0, rules: 0, entries: [], notices: [], closes: 0 };
  const model = { provider: 'p', id: 'best' };
  const ctx = { mode: 'tui', model, modelRegistry: { getAvailable: () => [model] },
    ui: { notify: message => h.notices.push(message), setStatus() {} } };
  h.ctx = ctx;
  const semantic = { async embed() { h.embeds++; return { vector: [1, ...Array(383).fill(0)] }; },
    async close() { h.closes++; }, async prepare() {} };
  h.semantic = semantic;
  registerClassifier({ registerEntryRenderer() {},
    registerCommand: (name, command) => commands.set(name, command),
    on: (name, handler) => events.set(name, handler),
    appendEntry: (type, data) => h.entries.push({ type, data }),
    async setModel(m) { ctx.model = m; await events.get('model_select')({ model: m, source: 'set' }, ctx); return true; },
  }, { price_preference_file: join(dir, 'price.json') }, { close: async () => {} }, async (_cfg, _task, opts) => {
    h.calls++; h.lastOptions = opts;
    return { status: 'ok', source: 'gemma', candidates: [
      { candidate_id: 'one', provider: 'p', model: 'best', quality_level: 4, evidence_ids: ['ev'] },
    ], task_profile: { kind: 'code_implement', difficulty: 'routine', requirements: [], reusable: true } };
  }, { store, semantic, manualProfile: text => { h.rules++; return manualTaskProfile(text); } });
  h.start = (text = '写一个 Python 函数检查回文') => events.get('before_agent_start')({ messageType: 'user', prompt: text }, ctx);
  h.finish = (extra = {}) => events.get('agent_end')({ messages: [{ role: 'assistant', provider: 'p', model: ctx.model.id,
    content: [{ type: 'text', text: 'done' }], stopReason: 'stop', ...extra }] }, ctx);
  h.command = (name, args = '') => commands.get(name).handler(args, ctx);
  t.after(() => events.get('session_shutdown')());
  return h;
}

test('five successful Gemma routes enable semantic bypass; hits and /classify never reinforce', async t => {
  const h = habitHarness(t); await h.command('bakarouter');
  for (let i = 0; i < 5; i++) {
    await h.start(); assert.equal(h.lastOptions.includeTaskProfile, true); await h.finish();
  }
  assert.equal(h.calls, 5); assert.equal(h.rules, 0);
  assert.equal(h.store.read().groups[0].counts[0].count, 5);
  await h.start(); await h.finish(); await h.finish();
  assert.equal(h.calls, 5); assert.equal(h.store.read().groups[0].counts[0].count, 5);
  assert(h.notices.some(s => s.includes('习惯命中'))); assert.equal(h.entries.length, 0);
  await h.command('classify', '写一个函数');
  assert.equal(h.calls, 6); assert.equal(h.lastOptions.includeTaskProfile, false);
  assert.equal(h.entries.at(-1).type, 'cirno-classification');
  await h.command('bakahabits', 'off');
  await h.start(); await h.finish();
  assert.equal(h.calls, 7); assert.equal(h.lastOptions.includeTaskProfile, false);
  assert.equal(h.store.read().groups[0].counts[0].count, 5);
});

test('only explicit manual choice runs rules; manual selection overrides next automatic route and counts success', async t => {
  const h = habitHarness(t);
  await h.start(); await h.finish(); assert.equal(h.rules, 0); assert.equal(h.store.read().groups.length, 0);
  await h.command('bakarouter');
  await h.events.get('model_select')({ model: h.ctx.model, source: 'set' }, h.ctx);
  await h.start(); await h.finish();
  assert.equal(h.calls, 0); assert.equal(h.rules, 1); assert.equal(h.store.read().groups[0].counts[0].count, 1);
  await h.start(); await h.finish(); assert.equal(h.calls, 1); assert.equal(h.rules, 1);
  await h.events.get('model_select')({ model: h.ctx.model, source: 'restore' }, h.ctx);
  await h.start(); await h.finish(); assert.equal(h.calls, 2); assert.equal(h.rules, 1);
});

test('failed, truncated, cancelled and changed-model replies do not teach habits', async t => {
  const h = habitHarness(t); await h.command('bakarouter');
  for (const extra of [{ stopReason: 'error' }, { stopReason: 'aborted' }, { stopReason: 'length' }, { model: 'other' }, { content: [] }]) {
    await h.start(); await h.finish(extra);
  }
  assert.equal(h.store.read().groups.length, 0); assert.equal(h.embeds, 0);
  await h.start(); await h.command('bakaprice', 'cheap'); await h.finish();
  assert.equal(h.store.read().groups.length, 0);
  await h.start(); await h.events.get('session_shutdown')(); await h.finish();
  assert.equal(h.store.read().groups.length, 0);
});

test('semantic errors fall back to Gemma, changed price scope misses, and unavailable habit winners fall back', async t => {
  const h = habitHarness(t); await h.command('bakarouter');
  for (let i = 0; i < 5; i++) { await h.start(); await h.finish(); }
  h.semantic.embed = async () => { throw Error('private error'); };
  await h.start(); assert.equal(h.calls, 6); // Failure never blocks the answer or leaks details.
  assert(h.notices.every(n => !n.includes('private error')));
  h.semantic.embed = async () => ({ vector: [1, ...Array(383).fill(0)] });
  h.store.lookup = () => ({ provider: 'p', model: 'removed', count: 5, threshold: 5 });
  await h.start(); assert.equal(h.calls, 7);
  await h.command('bakaprice', 'premium');
  await h.start(); assert.equal(h.calls, 8);
  await h.command('bakahabits', 'clear'); assert.equal(h.store.read().groups.length, 0);
});

test('CIRNO_HABITS=0 restores ordinary Gemma routing without learning or loading E5', async t => {
  const previous = process.env.CIRNO_HABITS;
  process.env.CIRNO_HABITS = '0';
  t.after(() => { if (previous === undefined) delete process.env.CIRNO_HABITS; else process.env.CIRNO_HABITS = previous; });
  const h = habitHarness(t); await h.command('bakarouter');
  await h.events.get('model_select')({ model: h.ctx.model, source: 'set' }, h.ctx);
  await h.start(); await h.finish();
  assert.equal(h.calls, 1); assert.equal(h.lastOptions.includeTaskProfile, false);
  assert.equal(h.embeds, 0); assert.equal(h.rules, 0); assert.equal(h.store.read().groups.length, 0);
  await h.command('bakahabits', 'on'); assert(h.notices.at(-1).includes('CIRNO_HABITS=0'));
});

test('manual classification and unsupported images never switch models; default routing is off', async () => {
  const commands = new Map(), events = new Map(), entries = [];
  const pi = {
    registerEntryRenderer: () => {},
    registerCommand: (name, value) => commands.set(name, value),
    on: (name, value) => events.set(name, value),
    appendEntry: (type, data) => entries.push({ type, data }),
    // No dispatch API: manual commands and rejected images must not dispatch.
  };
  extension(pi);
  assert(commands.has('classify'));
  assert(commands.has('bakarouter'));
  assert(!commands.has('classifier-auto'));
  const statuses = [], notices = [];
  const ctx = { mode: 'tui', ui: { notify(message) { notices.push(message); }, setStatus(_key, value) { statuses.push(value); } } };
  await events.get('session_start')({}, ctx);
  assert.equal(statuses.at(-1), '自动路由：关');
  await events.get('before_agent_start')({ messageType: 'user', prompt: 'ordinary input' }, ctx);
  assert.equal(entries.length, 0);
  await commands.get('bakarouter').handler('', ctx);
  assert.equal(statuses.at(-1), '自动路由：开');
  await events.get('before_agent_start')({ messageType: 'custom', message: {} }, ctx);
  assert.equal(entries.length, 0);
  await events.get('before_agent_start')({ messageType: 'user', prompt: 'classify this image', images: [{}] }, ctx);
  assert.equal(entries.length, 0);
  assert.match(notices.at(-1), /TEXT_ONLY_CLASSIFIER/);
  await commands.get('bakarouter').handler('invalid', ctx);
  assert.match(notices.at(-1), /用法/);
  assert.equal(statuses.at(-1), '自动路由：开');
  await commands.get('bakarouter').handler(' off ', ctx);
  assert.equal(statuses.at(-1), '自动路由：关');
  await events.get('before_agent_start')({ messageType: 'user', prompt: 'ordinary input' }, ctx);
  assert.equal(entries.length, 0);
  await commands.get('bakarouter').handler(' ', ctx);
  await events.get('before_agent_start')({ messageType: 'user', prompt: 'classify this image', images: [{}] }, ctx);
  assert.equal(entries.length, 0);
  await commands.get('bakarouter').handler('off', ctx);
  await commands.get('classify').handler(' ', ctx);
  assert.equal(entries[0].data.error, 'EMPTY_TASK');
  await events.get('session_shutdown')();
});

test('only /classify displays scores; every reply identifies the actual execution model', async () => {
  const commands = new Map(), events = new Map(), entries = [], renderers = new Map();
  let classifications = 0;
  registerClassifier({
    registerEntryRenderer: (name, fn) => renderers.set(name, fn),
    registerCommand: (name, value) => commands.set(name, value),
    on: (name, value) => events.set(name, value),
    appendEntry: (type, data) => entries.push({ type, data }),
  }, {}, { close: async () => {} }, async () => {
    classifications++;
    return { status: 'ok', candidates: [{ candidate_id: 'candidate-secret-score', quality_level: 4 }] };
  });
  const ctx = { mode: 'tui', model: { provider: 'stale-provider', id: 'not-used' },
    ui: { notify() {}, setStatus() {} } };
  const start = () => events.get('agent_start')({}, ctx);
  const assistant = (model = 'actual-model') => ({ message: { role: 'assistant', provider: 'actual-provider', model } });
  await commands.get('bakarouter').handler('', ctx);
  await events.get('before_agent_start')({ messageType: 'user', prompt: 'hello' }, ctx);
  assert.equal(classifications, 1);
  assert.equal(entries.length, 0);
  await start();
  await events.get('message_start')({ message: { role: 'user' } }, ctx);
  await events.get('message_start')(assistant(), ctx);
  await events.get('message_end')(assistant(), ctx);
  assert.deepEqual(entries, [{ type: 'cirno-execution-model', data: { model: 'actual-provider/actual-model' } }]);
  await events.get('message_start')(assistant('switched-model'), ctx);
  assert.equal(entries.length, 2);
  await commands.get('bakarouter').handler('off', ctx);
  await events.get('before_agent_start')({ messageType: 'user', prompt: 'again' }, ctx);
  assert.equal(classifications, 1);
  await start();
  await events.get('message_start')({ message: { role: 'assistant' } }, ctx);
  await events.get('message_end')(assistant(), ctx);
  assert.equal(entries.length, 3);
  assert(entries.every(e => e.type === 'cirno-execution-model'));
  await commands.get('classify').handler('task', ctx);
  assert.equal(classifications, 2);
  assert.equal(entries.at(-1).type, 'cirno-classification');
  assert.equal(entries.length, 4);
  await events.get('session_shutdown')();
});

test('Pi price menu persists choices; only automatic user turns switch models and never show scores', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cirno-price-extension-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const prices = join(dir, 'prices.json'), prefs = join(dir, 'prefs.json');
  const rate = n => ({ input_per_million: n, output_per_million: n, source: 'user',
    checked_at: '2020-01-01', valid_until: '2099-01-01', note: 'Synthetic test price.' });
  writeFileSync(prices, JSON.stringify({ schema_version: '1', currency: 'USD',
    models: { 'p/best': rate(3), 'p/cheap': rate(1) } }));
  const cfg = { pricing_file: prices, price_preference_file: prefs };
  const commands = new Map(), events = new Map(), entries = [], notices = [], switches = [];
  const pi = {
    registerEntryRenderer() {},
    registerCommand: (name, value) => commands.set(name, value),
    on: (name, value) => events.set(name, value),
    appendEntry: (type, data) => entries.push({ type, data }),
    async setModel(model) {
      switches.push(model); ctx.model = model;
      await events.get('model_select')({ model, source: 'set' }, ctx);
      return true;
    },
  };
  let calls = 0, choice = '希望便宜';
  const ctx = { mode: 'tui', model: { provider: 'p', id: 'manual' },
    modelRegistry: { getAvailable: () => [{ provider: 'p', id: 'best' }, { provider: 'p', id: 'cheap' }] },
    ui: {
    notify: message => notices.push(message), setStatus() {},
    async select(_title, options) { assert.deepEqual(options, ['希望便宜', '均衡', '接受昂贵']); return choice; },
  } };
  const classify = async (_cfg, task, opts) => {
    calls++;
    assert.equal(task, 'unchanged task');
    assert(!('prices' in opts));
    assert(!('price_preference' in opts));
    return { status: 'ok', source: 'gemma', reason_codes: [], candidates: [
      { candidate_id: 'best', provider: 'p', model: 'best', quality_level: 4, evidence_ids: ['ev'] },
      { candidate_id: 'cheap', provider: 'p', model: 'cheap', quality_level: 3, evidence_ids: ['ev'] },
    ] };
  };
  const install = () => registerClassifier(pi, cfg, { close: async () => {} }, classify);
  install();
  await commands.get('bakaprice').handler('', ctx);
  assert.match(notices.at(-1), /价格偏好：希望便宜/);
  assert.equal(calls, 0);
  await commands.get('classify').handler('unchanged task', ctx);
  assert.equal(entries.at(-1).data.routing.recommended_candidate_id, 'cheap');
  install(); // Reload preserves explicit preference but resets automatic classification.
  await commands.get('bakaprice').handler('status', ctx);
  assert.match(notices.at(-1), /希望便宜/);
  choice = undefined;
  await commands.get('bakaprice').handler('', ctx); // Esc does not overwrite preference.
  await commands.get('bakaprice').handler('invalid', ctx);
  assert.match(notices.at(-1), /用法/);
  await commands.get('bakaprice').handler('接受昂贵', ctx);
  await commands.get('classify').handler('unchanged task', ctx);
  assert.equal(entries.at(-1).data.routing.recommended_candidate_id, 'best');
  assert.equal(calls, 2);
  assert.equal(switches.length, 0);
  await commands.get('bakarouter').handler('', ctx);
  await events.get('before_agent_start')({ messageType: 'user', prompt: 'unchanged task' }, ctx);
  assert.equal(calls, 3);
  assert.equal(entries.length, 2);
  assert.deepEqual(switches, [{ provider: 'p', id: 'best' }]);
  await commands.get('bakaprice').handler('希望便宜', ctx);
  await commands.get('classify').handler('unchanged task', ctx);
  assert.equal(ctx.model.id, 'best'); // /classify does not switch, even with automatic routing on.
  assert.equal(entries.at(-1).data.routing.model, 'cheap');
  await events.get('before_agent_start')({ messageType: 'user', prompt: 'unchanged task' }, ctx);
  assert.equal(ctx.model.id, 'cheap');
  assert.equal(switches.length, 2);
  await events.get('before_agent_start')({ messageType: 'custom', prompt: 'unchanged task' }, ctx);
  assert.equal(calls, 5); // Tool continuations/custom messages do not route again.
  await commands.get('bakarouter').handler('off', ctx);
  await events.get('before_agent_start')({ messageType: 'user', prompt: 'unchanged task' }, ctx);
  assert.equal(calls, 5);
  assert.equal(ctx.model.id, 'cheap');
  writeFileSync(prices, 'private malformed contents');
  await commands.get('classify').handler('unchanged task', ctx);
  assert.deepEqual(entries.at(-1).data, { error: 'PRICING_FILE_UNAVAILABLE' });
  assert.equal(calls, 5);
  await commands.get('bakaprice').handler('均衡', ctx);
  assert.match(notices.at(-1), /价格偏好：均衡/);
});

test('turn off/on, preference changes, manual model changes and shutdown invalidate in-flight classification', async () => {
  for (const change of ['off-on', 'preference', 'manual', 'shutdown', 'cancel']) {
    const commands = new Map(), events = new Map(), entries = [], switches = [];
    let release, started;
    const waiting = new Promise(resolve => { started = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    const controller = new AbortController();
    const ctx = { mode: 'tui', signal: controller.signal, model: { provider: 'p', id: 'original' },
      modelRegistry: { getAvailable: () => [{ provider: 'p', id: 'target' }] },
      ui: { notify() {}, setStatus() {} } };
    registerClassifier({
      registerEntryRenderer() {},
      registerCommand: (name, value) => commands.set(name, value),
      on: (name, value) => events.set(name, value),
      appendEntry: (type, data) => entries.push({ type, data }),
      setModel: async model => { switches.push(model); ctx.model = model; return true; },
    }, {}, { close: async () => {} }, async () => {
      started(); await barrier;
      return { status: 'ok', source: 'gemma', reason_codes: [], candidates: [
        { candidate_id: 'one', provider: 'p', model: 'target', quality_level: 4, evidence_ids: ['ev'] },
      ] };
    });
    await commands.get('bakarouter').handler('', ctx);
    const pending = events.get('before_agent_start')({ messageType: 'user', prompt: 'test task' }, ctx);
    await waiting;
    if (change === 'off-on') {
      await commands.get('bakarouter').handler('off', ctx);
      await commands.get('bakarouter').handler('', ctx);
    } else if (change === 'preference') await commands.get('bakaprice').handler('premium', ctx);
    else if (change === 'manual') {
      ctx.model = { provider: 'p', id: 'manual-selection' };
      await events.get('model_select')({ model: ctx.model, source: 'set' }, ctx);
    } else if (change === 'shutdown') await events.get('session_shutdown')();
    else controller.abort();
    release(); await pending;
    assert.equal(switches.length, 0, change);
    assert.equal(entries.length, 0, change);
  }
});
