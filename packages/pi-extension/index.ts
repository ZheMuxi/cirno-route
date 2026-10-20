import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { fileURLToPath } from 'node:url';
import { classify, ClassifierError, formatResult, readConfig } from './core.mjs';
import { LocalBackend } from './local-backend.mjs';
import { classifyCatalog, eligibleCatalog, formatResearch, validateResearch } from './catalog.mjs';
import { PricePreference, PricingError, PRICE_MODES, priceMode, readPrices, recommend } from './pricing.mjs';
import { RoutingError, sameModel, switchRecommendedModel } from './routing.mjs';

type RecordData = Awaited<ReturnType<typeof classify>> | { error: string };
const ENTRY = 'cirno-classification';
const EXECUTION_ENTRY = 'cirno-execution-model';

export default function (pi: ExtensionAPI) {
  const cfg = readConfig(fileURLToPath(new URL('../../config/pi-classifier.json', import.meta.url)));
  const backend = new LocalBackend(fileURLToPath(new URL('../..', import.meta.url)));
  registerClassifier(pi, cfg, backend);
}

export function registerClassifier(pi: ExtensionAPI, cfg: ReturnType<typeof readConfig>,
  backend: LocalBackend, classifyFn = cfg.candidate_source === 'pi' ? classifyCatalog : classify) {
  let automatic = false;
  let busy = false;
  let displayedModel: string | null = null;
  let routeEpoch = 0;
  let routeState: { restoreModel: ExtensionContext['model']; switchingTo: ExtensionContext['model'] | null } | null = null;
  const active = new Set<AbortController>();
  const pricePreference = new PricePreference(cfg.price_preference_file, cfg.price_preference);

  pi.registerEntryRenderer<RecordData>(ENTRY, (entry) => new Text(formatResult(entry.data), 1, 1));
  pi.registerEntryRenderer<{ model: string }>(EXECUTION_ENTRY,
    (entry) => new Text(`本次回答模型：${entry.data.model}`, 1, 1));

  function display(data: RecordData, ctx: ExtensionContext) {
    // Custom entries stay outside model context and retain no raw task text.
    pi.appendEntry(ENTRY, data);
    if (ctx.mode === 'rpc') ctx.ui.notify(formatResult(data), 'info');
    else if (ctx.mode === 'json') process.stderr.write(JSON.stringify({ type: ENTRY, data }) + '\n');
    else if (ctx.mode === 'print') process.stderr.write(formatResult(data) + '\n');
  }

  function reportError(error: string, ctx: ExtensionContext, showScores: boolean) {
    if (showScores) display({ error }, ctx);
    else if (ctx.mode === 'tui' || ctx.mode === 'rpc') ctx.ui.notify(error === 'ROUTER_RESTORE_FAILED'
      ? `自动路由恢复失败，已停止本轮回答：${error}`
      : `自动路由未完成，保留当前模型：${error}`, 'warning');
    else process.stderr.write(JSON.stringify({ type: 'cirno-classifier-warning', error }) + '\n');
  }

  async function run(text: string, ctx: ExtensionContext, images = false, showScores = true) {
    if (busy) { reportError('CLASSIFIER_BUSY', ctx, showScores); return; }
    busy = true;
    const controller = new AbortController();
    const epoch = routeEpoch;
    const initialModel = ctx.model;
    const state = { restoreModel: initialModel, switchingTo: null };
    if (!showScores) routeState = state;
    active.add(controller);
    if (ctx.mode === 'tui') ctx.ui.setStatus(ENTRY, 'Gemma 分类中…');
    try {
      // Snapshot explicit settings at request start. Neither prices nor price preferences enter Gemma.
      const mode = pricePreference.get();
      const prices = readPrices(cfg.pricing_file);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
      const onProgress = (message: string) => {
        if (ctx.mode === 'tui' || ctx.mode === 'rpc') ctx.ui.setStatus(ENTRY, message);
        else process.stderr.write(JSON.stringify({ type: 'cirno-setup', message }) + '\n');
      };
      const result = await classifyFn(cfg, text, { signal, images,
        getModels: () => ctx.modelRegistry.getAvailable(),
        research: (body) => backend.research(body, { signal, onProgress }),
        onProgress,
        localClassify: (body, requestSignal) => backend.classify(body, {
          signal: requestSignal,
          onProgress,
        }),
      });
      // Automatic classification never appends a score entry (including on session replay).
      const recommendation = recommend(result, prices, mode);
      if (showScores) display(recommendation, ctx);
      else {
        // A changed toggle, price preference or manual model choice invalidates an in-flight route.
        const outcome = await switchRecommendedModel(recommendation, {
          getModels: () => ctx.modelRegistry.getAvailable(),
          getModel: () => ctx.model,
          setModel: (model) => pi.setModel(model),
          isAvailable: async (model) => (await eligibleCatalog(cfg, [model], signal)).length === 1,
          isActive: () => automatic && epoch === routeEpoch,
          signal, abort: () => ctx.abort(), state,
        });
        if (ctx.mode === 'json' && outcome.status !== 'skipped') {
          // No scores or task text, and no extra message in the execution model's context.
          process.stderr.write(JSON.stringify({ type: 'cirno-routing', ...outcome }) + '\n');
        }
      }
    } catch (error) {
      reportError(error instanceof ClassifierError || error instanceof PricingError || error instanceof RoutingError
        ? error.code : 'CLASSIFIER_INTERNAL_ERROR', ctx, showScores);
    } finally {
      active.delete(controller);
      if (routeState === state) routeState = null;
      busy = false;
      if (ctx.mode === 'tui') ctx.ui.setStatus(ENTRY, automatic ? '自动路由：开' : '自动路由：关');
    }
  }

  pi.registerCommand('classify', {
    description: '本地 Gemma 对任务的候选模型评分；只分类，不调用执行模型',
    handler: async (args, ctx) => { await run(args, ctx); },
  });
  pi.registerCommand('bakaprice', {
    description: '选择价格偏好：希望便宜 / 均衡 / 接受昂贵；/bakaprice status 查看当前档位',
    handler: async (args, ctx) => {
      const option = args.trim();
      const usage = '/bakaprice 希望便宜 | 均衡 | 接受昂贵（也支持 cheap / balanced / premium）';
      const notify = (message: string, error = false) => {
        if (ctx.mode === 'tui' || ctx.mode === 'rpc') ctx.ui.notify(message, error ? 'error' : 'info');
        else process.stderr.write(JSON.stringify({ type: 'cirno-price-preference', message }) + '\n');
      };
      try {
        if (option === 'status' || (!option && ctx.mode !== 'tui')) {
          notify(`当前价格偏好：${PRICE_MODES[pricePreference.get()]}。${usage}`); return;
        }
        let selected: string | undefined = option;
        if (!selected) {
          selected = await ctx.ui.select(`价格偏好（当前：${PRICE_MODES[pricePreference.get()]}）`,
            Object.values(PRICE_MODES));
          if (selected === undefined) return;
        }
        const mode = priceMode(selected);
        if (!mode) { notify(`用法：${usage}`); return; }
        pricePreference.set(mode);
        routeEpoch++;
        notify(`价格偏好：${PRICE_MODES[mode]}，已保存；自动路由开启时用于选择回答模型，/classify 只展示推荐。`);
      } catch (error) {
        notify(`价格设置未完成：${error instanceof PricingError ? error.code : 'PRICING_ERROR'}`, true);
      }
    },
  });
  pi.registerCommand('bakamodels', {
    description: '/bakamodels 查看能力缓存；/bakamodels refresh 联网更新全部候选资料',
    handler: async (args, ctx) => {
      if (!['', 'refresh'].includes(args.trim())) {
        ctx.ui.notify('用法：/bakamodels 或 /bakamodels refresh', 'info'); return;
      }
      if (busy) { ctx.ui.notify('分类器忙，请稍后重试。', 'info'); return; }
      busy = true;
      const controller = new AbortController();
      active.add(controller);
      try {
        const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
        const models = await eligibleCatalog(cfg, ctx.modelRegistry.getAvailable(), signal);
        if (!models.length) throw new ClassifierError('NO_ELIGIBLE_MODEL');
        const result = validateResearch(await backend.research({
          models, action: args.trim() === 'refresh' ? 'refresh' : 'status',
        }, { signal, onProgress: (message) => ctx.ui.setStatus(ENTRY, message) }), models);
        const message = formatResearch(result);
        if (ctx.mode === 'tui' || ctx.mode === 'rpc') ctx.ui.notify(message, 'info');
        else process.stderr.write(JSON.stringify({ type: 'cirno-research', message }) + '\n');
      } catch (error) {
        const code = error instanceof ClassifierError ? error.code : 'RESEARCH_ERROR';
        ctx.ui.notify(`模型资料不可用：${code}`, 'error');
      } finally {
        active.delete(controller); busy = false;
        ctx.ui.setStatus(ENTRY, automatic ? '自动路由：开' : '自动路由：关');
      }
    },
  });
  pi.registerCommand('bakarouter', {
    description: '/bakarouter 按任务能力与价格自动选择回答模型；/bakarouter off 关闭',
    handler: async (args, ctx) => {
      const option = args.trim();
      if (!['', 'off'].includes(option)) {
        ctx.ui.notify('用法：/bakarouter 开启；/bakarouter off 关闭', 'info'); return;
      }
      automatic = option === '';
      routeEpoch++;
      ctx.ui.setStatus(ENTRY, automatic ? '自动路由：开' : '自动路由：关');
      const message = automatic
        ? '自动路由已开启；普通输入按任务能力和价格偏好选择回答模型。/classify 仍只分类。'
        : '自动路由已关闭；后续使用当前选中的模型，可通过 /model 手动更换。';
      if (ctx.mode === 'tui' || ctx.mode === 'rpc') ctx.ui.notify(message, 'info');
      else process.stderr.write(JSON.stringify({ type: 'cirno-router-status', enabled: automatic, message }) + '\n');
    },
  });
  pi.on('session_start', async (_event, ctx) => {
    if (ctx.mode === 'tui') ctx.ui.setStatus(ENTRY, automatic ? '自动路由：开' : '自动路由：关');
  });
  pi.on('before_agent_start', async (event, ctx) => {
    if (automatic && event.messageType === 'user') await run(event.prompt, ctx, !!event.images?.length, false);
  });
  pi.on('model_select', async (event) => {
    if (routeState && event.source === 'set' && sameModel(event.model, routeState.switchingTo)) return;
    routeEpoch++;
    if (routeState) routeState.restoreModel = event.model;
  });
  pi.on('agent_start', async () => { displayedModel = null; });
  // Read the actual assistant message, so a model switched by another extension is not mislabeled.
  // message_end is a fallback for transports that omit model identity at message_start.
  for (const eventName of ['message_start', 'message_end'] as const) pi.on(eventName, async (event, ctx) => {
    const message = event.message;
    if (message.role !== 'assistant' || !message.provider || !message.model) return;
    const model = `${message.provider}/${message.model}`.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 400);
    if (model === displayedModel) return;
    displayedModel = model;
    pi.appendEntry(EXECUTION_ENTRY, { model });
    const label = `本次回答模型：${model}`;
    if (ctx.mode === 'rpc') ctx.ui.notify(label, 'info');
    else if (ctx.mode === 'json') process.stderr.write(JSON.stringify({ type: EXECUTION_ENTRY, model }) + '\n');
    else if (ctx.mode === 'print') process.stderr.write(label + '\n');
  });
  pi.on('session_shutdown', async () => {
    automatic = false;
    routeEpoch++;
    for (const controller of active) controller.abort();
    await backend.close();
  });
}
