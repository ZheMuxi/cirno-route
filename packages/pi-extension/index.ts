import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { fileURLToPath } from 'node:url';
import { classify, ClassifierError, formatResult, readConfig } from './core.mjs';
import { LocalBackend } from './local-backend.mjs';

type RecordData = Awaited<ReturnType<typeof classify>> | { error: string };
const ENTRY = 'cirno-classification';

export default function (pi: ExtensionAPI) {
  const cfg = readConfig(fileURLToPath(new URL('../../config/pi-classifier.json', import.meta.url)));
  const backend = new LocalBackend(fileURLToPath(new URL('../..', import.meta.url)));
  let automatic = false;
  const active = new Set<AbortController>();

  pi.registerEntryRenderer<RecordData>(ENTRY, (entry) => new Text(formatResult(entry.data), 1, 1));

  function display(data: RecordData, ctx: ExtensionContext) {
    // Custom entries stay outside model context and retain no raw task text.
    pi.appendEntry(ENTRY, data);
    if (ctx.mode === 'rpc') ctx.ui.notify(formatResult(data), 'info');
    else if (ctx.mode === 'json') process.stderr.write(JSON.stringify({ type: ENTRY, data }) + '\n');
    else if (ctx.mode === 'print') process.stderr.write(formatResult(data) + '\n');
  }

  async function run(text: string, ctx: ExtensionContext, images = false) {
    const controller = new AbortController();
    active.add(controller);
    if (ctx.mode === 'tui') ctx.ui.setStatus(ENTRY, 'Gemma 分类中…');
    try {
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
      display(await classify(cfg, text, { signal, images,
        localClassify: (body, requestSignal) => backend.classify(body, {
          signal: requestSignal,
          onProgress: (message) => {
            if (ctx.mode === 'tui') ctx.ui.setStatus(ENTRY, message);
            else if (ctx.mode === 'rpc') ctx.ui.setStatus(ENTRY, message);
            else process.stderr.write(JSON.stringify({ type: 'cirno-setup', message }) + '\n');
          },
        }),
      }), ctx);
    } catch (error) {
      display({ error: error instanceof ClassifierError ? error.code : 'CLASSIFIER_INTERNAL_ERROR' }, ctx);
    } finally {
      active.delete(controller);
      if (ctx.mode === 'tui') ctx.ui.setStatus(ENTRY, automatic ? '本地分类：开' : '本地分类：关');
    }
  }

  pi.registerCommand('classify', {
    description: '本地 Gemma 对任务的候选模型评分；只分类，不调用执行模型',
    handler: async (args, ctx) => { await run(args, ctx); },
  });
  pi.registerCommand('bakarouter', {
    description: '/bakarouter 开启普通输入自动分类；/bakarouter off 关闭',
    handler: async (args, ctx) => {
      const option = args.trim();
      if (!['', 'off'].includes(option)) {
        ctx.ui.notify('用法：/bakarouter 开启；/bakarouter off 关闭', 'info'); return;
      }
      automatic = option === '';
      ctx.ui.setStatus(ENTRY, automatic ? '本地分类：开' : '本地分类：关');
      ctx.ui.notify(`自动分类已${automatic ? '开启' : '关闭'}；执行模型由 Pi 当前选择决定。`, 'info');
    },
  });
  pi.on('session_start', async (_event, ctx) => {
    if (ctx.mode === 'tui') ctx.ui.setStatus(ENTRY, automatic ? '本地分类：开' : '本地分类：关');
  });
  pi.on('before_agent_start', async (event, ctx) => {
    if (automatic && event.messageType === 'user') await run(event.prompt, ctx, !!event.images?.length);
  });
  pi.on('session_shutdown', async () => {
    for (const controller of active) controller.abort();
    await backend.close();
  });
}
