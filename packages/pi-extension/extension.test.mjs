import test from 'node:test';
import assert from 'node:assert/strict';
import extension from './index.ts';

test('extension is classification-only, uses non-context entries, handles unsupported images', async () => {
  const commands = new Map(), events = new Map(), entries = [];
  const pi = {
    registerEntryRenderer: () => {},
    registerCommand: (name, value) => commands.set(name, value),
    on: (name, value) => events.set(name, value),
    appendEntry: (type, data) => entries.push({ type, data }),
    // No setModel/registerVirtualModel/sendMessage API: accidental dispatch fails this test.
  };
  extension(pi);
  assert(commands.has('classify'));
  assert(commands.has('bakarouter'));
  assert(!commands.has('classifier-auto'));
  const statuses = [], notices = [];
  const ctx = { mode: 'tui', ui: { notify(message) { notices.push(message); }, setStatus(_key, value) { statuses.push(value); } } };
  await events.get('session_start')({}, ctx);
  assert.equal(statuses.at(-1), '本地分类：关');
  await events.get('before_agent_start')({ messageType: 'user', prompt: 'ordinary input' }, ctx);
  assert.equal(entries.length, 0);
  await commands.get('bakarouter').handler('', ctx);
  assert.equal(statuses.at(-1), '本地分类：开');
  await events.get('before_agent_start')({ messageType: 'custom', message: {} }, ctx);
  assert.equal(entries.length, 0);
  await events.get('before_agent_start')({ messageType: 'user', prompt: 'classify this image', images: [{}] }, ctx);
  assert.equal(entries[0].data.error, 'TEXT_ONLY_CLASSIFIER');
  await commands.get('bakarouter').handler('invalid', ctx);
  assert.match(notices.at(-1), /用法/);
  assert.equal(statuses.at(-1), '本地分类：开');
  await commands.get('bakarouter').handler(' off ', ctx);
  assert.equal(statuses.at(-1), '本地分类：关');
  await events.get('before_agent_start')({ messageType: 'user', prompt: 'ordinary input' }, ctx);
  assert.equal(entries.length, 1);
  await commands.get('bakarouter').handler(' ', ctx);
  await events.get('before_agent_start')({ messageType: 'user', prompt: 'classify this image', images: [{}] }, ctx);
  assert.equal(entries.length, 2);
  await commands.get('bakarouter').handler('off', ctx);
  await commands.get('classify').handler(' ', ctx);
  assert.equal(entries[2].data.error, 'EMPTY_TASK');
  await events.get('session_shutdown')();
});
