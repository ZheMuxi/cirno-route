import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { classify, ClassifierError, formatResult, readConfig } from './core.mjs';
import { LocalBackend } from './local-backend.mjs';
import { classifyCatalog, eligibleCatalog, formatResearch, validateResearch } from './catalog.mjs';
import { PricePreference, PricingError, PRICE_MODES, priceMode, recommend, resolvePrice } from './pricing.mjs';
import { loadEffectivePrices, syncResearchPrices } from './pricing-sync.mjs';
import { buildPricingContext } from './pricing-context.mjs';
import { RoutingError, sameModel, switchRecommendedModel, switchHabitModel } from './routing.mjs';
import { SemanticBackend } from './semantic-backend.mjs';
import { HabitStore, HabitError, hash, habitScope, manualTaskProfile, validProfile, TAXONOMY } from './habits.mjs';
import { createPrivacyGuard } from './privacy.mjs';
import { PrivacyError } from './privacy-policy.mjs';
import { ModelHealth } from './model-health.mjs';

type RecordData = Awaited<ReturnType<typeof classify>> | { error: string };
const ENTRY = 'cirno-classification';
const EXECUTION_ENTRY = 'cirno-execution-model';
const TURN_GUIDELINE = '遵守本轮用户明确要求的交付内容和输出格式。历史对话只作为必要背景，不附加上一独立任务的答案；用户明确要求续接时保留相关上下文。';

export default function (pi: ExtensionAPI) {
  const cfg = readConfig(fileURLToPath(new URL('../../config/pi-classifier.json', import.meta.url)));
  const backend = new LocalBackend(fileURLToPath(new URL('../..', import.meta.url)));
  registerClassifier(pi, cfg, backend);
}

export function registerClassifier(pi: ExtensionAPI, cfg: ReturnType<typeof readConfig>,
  backend: LocalBackend, classifyFn = cfg.candidate_source === 'pi' ? classifyCatalog : classify,
  habitServices?: { store: HabitStore; semantic: SemanticBackend; manualProfile?: typeof manualTaskProfile }) {
  let automatic = false;
  let busy = false;
  let displayedModel: string | null = null;
  let routeEpoch = 0;
  let routeState: { restoreModel: ExtensionContext['model']; switchingTo: ExtensionContext['model'] | null } | null = null;
  const active = new Set<AbortController>();
  const pricePreference = new PricePreference(cfg.price_preference_file, cfg.price_preference);
  const habits = process.env.CIRNO_HABITS === '0' ? null : habitServices ?? (cfg.habits ? {
    store: new HabitStore(cfg.habits),
    semantic: new SemanticBackend(fileURLToPath(new URL('../..', import.meta.url)), cfg.habits.cache),
  } : null);
  let manualModel: ExtensionContext['model'] | null = null;
  const health = new ModelHealth();
  let turnModels: NonNullable<ExtensionContext['model']>[] = [];
  let turnHealthMessages: any[] = [];
  function snapshotModels(ctx: ExtensionContext) {
    turnModels = (ctx.modelRegistry?.getAvailable() ?? []).map(model => ({ ...model }));
    if (ctx.model && !turnModels.some(model => sameModel(model, ctx.model))) turnModels.push({ ...ctx.model });
  }
  let pendingUse: { id: string; source: string; text: string; profile: any; scope: string;
    provider: string; model: string; epoch: number; embedding?: number[] } | null = null;
  // Store only derived vectors/labels in this process; never task text or a cached model choice.
  const verifiedTasks = new Map<string, { vector: number[]; profile: any; groupKey: string }>();
  const privacy = createPrivacyGuard(pi, cfg, { onChange: () => {
    routeEpoch++; pendingUse = null; manualModel = null;
    verifiedTasks.clear();
    for (const controller of active) controller.abort();
  } });

  function pricingOptions(ctx: ExtensionContext) {
    const registered = privacy.policy?.read().models.filter(model => model.kind === 'local') ?? [];
    return { models: ctx.modelRegistry?.getAvailable() ?? [], localModels: [
      ...(cfg.local_price_models ?? []),
      ...registered.map(model => ({ provider: model.provider, model: model.id, base_url: model.baseUrl })),
    ] };
  }
  function effectivePrices(ctx: ExtensionContext) {
    return loadEffectivePrices(cfg, pricingOptions(ctx));
  }
  function updatePrices(result, ctx: ExtensionContext) {
    const update = syncResearchPrices(cfg, result, pricingOptions(ctx));
    if (update.error) {
      const message = `模型能力查询已完成，价格保存未完成：${update.error}；继续使用有效旧价。`;
      if (ctx.mode === 'tui' || ctx.mode === 'rpc') ctx.ui.notify(message, 'warning');
      else process.stderr.write(JSON.stringify({ type: 'cirno-pricing-warning', message }) + '\n');
    }
    return update;
  }

  function habitNotice(message: string, ctx: ExtensionContext, warning = false) {
    if (ctx.mode === 'tui' || ctx.mode === 'rpc') ctx.ui.notify(message, warning ? 'warning' : 'info');
    else process.stderr.write(JSON.stringify({ type: 'cirno-habits', message }) + '\n');
  }
  function habitFailure(error: unknown, ctx: ExtensionContext) {
    const code = error instanceof HabitError || error instanceof ClassifierError ? error.code : 'HABITS_UNAVAILABLE';
    habitNotice(`习惯功能未完成：${code}；继续使用原有路由。`, ctx, true);
  }
  function learningEnabled(ctx: ExtensionContext) {
    try { return !!habits?.store.enabled(); } catch (error) { habitFailure(error, ctx); return false; }
  }

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
      : error === 'TASK_INPUT_MISSING' ? '本轮已暂停：请补充原文、代码或附件等必要材料后重新发送。'
      : error === 'TASK_INPUT_UNCLEAR' ? '本轮已暂停：请说明要完成的任务，并提供所指的材料。'
      : `自动路由未完成，已停止本轮回答：${error}`, 'warning');
    else process.stderr.write(JSON.stringify({ type: 'cirno-classifier-warning', error }) + '\n');
  }

  async function run(text: string, ctx: ExtensionContext, images = false, showScores = true) {
    if (busy) {
      if (!showScores) ctx.abort?.();
      reportError('CLASSIFIER_BUSY', ctx, showScores); return;
    }
    busy = true;
    const controller = new AbortController();
    const epoch = routeEpoch;
    const initialModel = ctx.model;
    const state = { restoreModel: initialModel, switchingTo: null };
    if (!showScores) routeState = state;
    active.add(controller);
    if (ctx.mode === 'tui') ctx.ui.setStatus(ENTRY, 'Gemma 分类中…');
    try {
      const restricted = privacy.restricted(ctx, text);
      const permittedModels = () => privacy.models(ctx, ctx.modelRegistry?.getAvailable() ?? []);
      const getModels = () => permittedModels().filter(model => showScores || health.isAvailable(model));
      if (restricted && !permittedModels().length) throw new PrivacyError('PRIVACY_NO_ALLOWED_MODEL');
      // Freeze preference; research may refresh prices before this turn's recommendation.
      // Numeric prices enter a separate context table, never capability evidence.
      const mode = pricePreference.get();
      let prices = effectivePrices(ctx);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
      const onProgress = (message: string) => {
        if (ctx.mode === 'tui' || ctx.mode === 'rpc') ctx.ui.setStatus(ENTRY, message);
        else process.stderr.write(JSON.stringify({ type: 'cirno-setup', message }) + '\n');
      };
      const routeOptions = {
        getModels, getModel: () => ctx.model,
        setModel: (model) => pi.setModel(model),
        isAvailable: async (model) => health.isAvailable(model)
          && (await eligibleCatalog(cfg, [model], signal)).length === 1,
        isActive: () => automatic && epoch === routeEpoch,
        signal, abort: () => ctx.abort(), state,
      };
      const learn = !showScores && !images && learningEnabled(ctx);
      let scope: string | undefined, embedding: number[] | undefined;
      if (learn && habits) {
        // Temporary channel failures must not create a different learning scope.
        scope = habitScope(mode, prices, permittedModels());
        try {
          if (habits.store.eligible(scope)) {
            const cacheKey = hash([scope, hash(text)]);
            const canVerify = cfg.habits?.verify_uncertain !== false && typeof backend.profile === 'function';
            let verification = '';
            let hit = habits.store.lookupExact(scope, hash(text));
            const cached = canVerify ? verifiedTasks.get(cacheKey) : null;
            if (!hit && cached) {
              const checked = habits.store.lookupVerified(scope, cached.vector, cached.profile);
              if (checked?.group_key === cached.groupKey) {
                hit = checked; verification = '（已核验缓存）';
              } else verifiedTasks.delete(cacheKey);
            }
            if (!hit) {
              const encoded = await habits.semantic.embed(text, { signal, onProgress });
              embedding = encoded.vector;
              hit = habits.store.lookup(scope, embedding);
              if (!hit && canVerify) {
                const candidate = habits.store.verificationCandidate(scope, embedding);
                if (candidate) {
                  onProgress('Gemma 核验任务类型与要求…');
                  const checked = await backend.profile(text, { signal, onProgress });
                  if (signal.aborted || !routeOptions.isActive()) return;
                  if (checked?.schema_version !== '1' || !['ready', 'missing', 'unclear'].includes(checked.input_status)
                    || !validProfile(checked.task_profile)) throw new ClassifierError('TASK_PROFILE_INVALID');
                  if (checked.input_status !== 'ready') {
                    throw new RoutingError(checked.input_status === 'missing' ? 'TASK_INPUT_MISSING' : 'TASK_INPUT_UNCLEAR');
                  }
                  hit = habits.store.lookupVerified(scope, embedding, checked.task_profile);
                  if (hit?.group_key !== candidate.group_key) hit = null;
                  if (hit) {
                    verifiedTasks.delete(cacheKey);
                    verifiedTasks.set(cacheKey, { vector: embedding, profile: checked.task_profile, groupKey: hit.group_key });
                    if (verifiedTasks.size > 64) verifiedTasks.delete(verifiedTasks.keys().next().value!);
                    verification = '（Gemma 已核验，跳过全候选评分）';
                  }
                }
              }
            }
            // A price refresh or expiry during semantic verification invalidates
            // this habit's scope; classify against the current prices instead.
            if (hit && scope === habitScope(mode, effectivePrices(ctx), permittedModels())) {
              const outcome = await switchHabitModel(hit, mode, routeOptions);
              if (outcome.status !== 'skipped') {
                habitNotice(`习惯命中${verification}：${TAXONOMY.kinds[hit.profile.kind]} → ${hit.provider}/${hit.model}（已累计 ${hit.count} 次）；${verification ? '不增加计数或样本。' : '本轮跳过 Gemma，不增加计数。'}`, ctx);
              }
              return;
            }
          }
        } catch (error) {
          if (error instanceof RoutingError && ['ROUTER_RESTORE_FAILED', 'TASK_INPUT_MISSING', 'TASK_INPUT_UNCLEAR'].includes(error.code)) throw error;
          if (signal.aborted || epoch !== routeEpoch) return;
          // Long inputs and uncertain matches simply use Gemma; unavailable winners never select a runner-up.
          if (!(error instanceof RoutingError) && !(error instanceof ClassifierError && error.code === 'SEMANTIC_INPUT_TOO_LONG')) habitFailure(error, ctx);
        }
      }
      if (signal.aborted || (!showScores && epoch !== routeEpoch)) return;
      const classificationConfig = restricted && cfg.candidate_source !== 'pi'
        ? { ...cfg, candidates: cfg.candidates.filter(c => getModels().some(m =>
          m.provider === (c.provider ?? 'cirno-gateway') && m.id === c.model)) } : cfg;
      if (restricted && classificationConfig.candidate_source !== 'pi' && !classificationConfig.candidates.length) {
        throw new PrivacyError('PRIVACY_NO_ALLOWED_MODEL');
      }
      const result = await classifyFn(classificationConfig, text, { signal, images,
        includeTaskProfile: learn,
        getModels,
        getPricingContext: catalog => buildPricingContext(effectivePrices(ctx), catalog),
        research: async (body) => {
          const researched = validateResearch(await backend.research(body, { signal, onProgress }), body.models);
          if (!signal.aborted) prices = updatePrices(researched, ctx).book;
          return researched;
        },
        onProgress,
        localClassify: (body, requestSignal) => backend.classify(body, {
          signal: requestSignal,
          onProgress,
        }),
      });
      // Check again after classification: trust or endpoints may have changed while it ran.
      if (privacy.restricted(ctx)) result.candidates = result.candidates.filter(row =>
        getModels().some(m => m.provider === row.provider && m.id === row.model));
      if (!showScores) {
        result.candidates = result.candidates.filter(row => !(ctx.modelRegistry?.getAvailable() ?? []).some(model =>
          model.provider === row.provider && model.id === row.model && !health.isAvailable(model)));
        if (['missing', 'unclear'].includes(result.input_status)) {
          throw new RoutingError(result.input_status === 'missing' ? 'TASK_INPUT_MISSING' : 'TASK_INPUT_UNCLEAR');
        }
      }
      // Automatic classification never appends a score entry (including on session replay).
      // Endpoint bindings may have changed while the remote research was running.
      prices = effectivePrices(ctx);
      if (learn) scope = habitScope(mode, prices, permittedModels());
      const recommendation = recommend(result, prices, mode);
      if (showScores) display(recommendation, ctx);
      else {
        // A changed toggle, price preference or manual model choice invalidates an in-flight route.
        const outcome = await switchRecommendedModel(recommendation, routeOptions);
        if (outcome.status !== 'skipped' && learn && scope && validProfile(result.task_profile) && result.task_profile.reusable) {
          pendingUse = { id: randomUUID(), source: 'gemma', text, profile: result.task_profile,
            scope, provider: outcome.provider, model: outcome.model, epoch, embedding };
        } else if (outcome.status !== 'skipped' && learn) {
          habitNotice('本轮类型或任务材料不适合复用，不计入习惯；回答模型仍按分类结果选择。', ctx);
        }
        if (ctx.mode === 'json' && outcome.status !== 'skipped') {
          // No scores or task text, and no extra message in the execution model's context.
          process.stderr.write(JSON.stringify({ type: 'cirno-routing', ...outcome }) + '\n');
        }
      }
    } catch (error) {
      // A newer manual selection or toggle owns the turn; don't abort it for a stale route.
      if (!showScores && (!automatic || epoch !== routeEpoch)) return;
      if (!showScores) { pendingUse = null; ctx.abort?.(); }
      if (error instanceof PrivacyError) {
        if (showScores) display({ error: error.code }, ctx);
        else {
          habitNotice(`文件保护已拦截：${error.code}；请通过 /bakaprivacy 配置本地或可信模型。`, ctx, true);
        }
        return;
      }
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
        verifiedTasks.clear();
        pendingUse = null;
        notify(`价格偏好：${PRICE_MODES[mode]}，已保存；自动路由开启时用于选择回答模型，/classify 只展示推荐。`);
      } catch (error) {
        notify(`价格设置未完成：${error instanceof PricingError ? error.code : 'PRICING_ERROR'}`, true);
      }
    },
  });
  pi.registerCommand('bakamodels', {
    description: '/bakamodels 查看能力与价格；/bakamodels refresh 联网更新全部候选能力和价格',
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
        const update = args.trim() === 'refresh' && !signal.aborted ? updatePrices(result, ctx) : null;
        const book = update?.book ?? effectivePrices(ctx);
        const statuses = models.map(model => resolvePrice(book, model.provider, model.model).status);
        const unresolvedPrices = result.models.filter(row =>
          resolvePrice(book, row.provider, row.candidate.model).status !== 'known').map(row => {
          const note = typeof row.pricing?.note === 'string'
            ? row.pricing.note.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120) : '没有有效价格资料';
          return `${row.provider}/${row.candidate.model}：${note}`;
        });
        const message = formatResearch(result) + `\n价格：${statuses.filter(s => s === 'known').length} 可比 · ${statuses.filter(s => s !== 'known').length} 未知/过期（官方 API 参考价，本地为 0）`
          + (update ? `；本次更新 ${update.updated} 项` : '（只读查看）')
          + (unresolvedPrices.length ? '\n未确认价格：\n' + unresolvedPrices.join('\n') : '');
        if (ctx.mode === 'tui' || ctx.mode === 'rpc') ctx.ui.notify(message, 'info');
        else process.stderr.write(JSON.stringify({ type: 'cirno-research', message }) + '\n');
      } catch (error) {
        const code = error instanceof ClassifierError || error instanceof PricingError ? error.code : 'RESEARCH_ERROR';
        ctx.ui.notify(`模型资料不可用：${code}`, 'error');
      } finally {
        active.delete(controller); busy = false;
        ctx.ui.setStatus(ENTRY, automatic ? '自动路由：开' : '自动路由：关');
      }
    },
  });
  pi.registerCommand('bakarouter', {
    description: '/bakarouter 开启自动路由；off 关闭；status 查看状态及失败模型冷却',
    handler: async (args, ctx) => {
      const option = args.trim();
      if (option === 'status') {
        const models = ctx.modelRegistry?.getAvailable() ?? [];
        const cooling = health.status().filter(row => row.retryAfterMs > 0 && models.some(model =>
          model.provider === row.provider && model.id === row.model && !health.isAvailable(model)));
        habitNotice(`自动路由：${automatic ? '开' : '关'}。` + (cooling.length
          ? '\n暂时跳过：' + cooling.map(row => `${row.provider}/${row.model}（约 ${Math.ceil(row.retryAfterMs / 1000)} 秒后可重试）`).join('；')
          : '没有处于冷却期的模型。'), ctx);
        return;
      }
      if (!['', 'off'].includes(option)) {
        ctx.ui.notify('用法：/bakarouter 开启；/bakarouter off 关闭；/bakarouter status 查看状态', 'info'); return;
      }
      automatic = option === '';
      routeEpoch++;
      verifiedTasks.clear();
      pendingUse = null;
      manualModel = null;
      ctx.ui.setStatus(ENTRY, automatic ? '自动路由：开' : '自动路由：关');
      const message = automatic
        ? '自动路由已开启；普通输入按任务能力和价格偏好选择回答模型。/classify 仍只分类。'
        : '自动路由已关闭；后续使用当前选中的模型，可通过 /model 手动更换。';
      if (ctx.mode === 'tui' || ctx.mode === 'rpc') ctx.ui.notify(message, 'info');
      else process.stderr.write(JSON.stringify({ type: 'cirno-router-status', enabled: automatic, message }) + '\n');
    },
  });
  pi.registerCommand('bakahabits', {
    description: '习惯路由：status / on / off / threshold 5 / prepare / clear',
    handler: async (args, ctx) => {
      if (!habits) { habitNotice('习惯功能未配置或已由 CIRNO_HABITS=0 禁用。', ctx); return; }
      const option = args.trim() || 'status';
      const threshold = /^threshold ([1-9]\d{0,3})$/.exec(option);
      if (!['status', 'on', 'off', 'prepare', 'clear'].includes(option) && !threshold) {
        habitNotice('用法：/bakahabits status | on | off | threshold 5 | prepare | clear', ctx); return;
      }
      if (busy && option === 'prepare') { habitNotice('分类器忙，请稍后重试。', ctx); return; }
      const controller = new AbortController(); active.add(controller);
      try {
        if (option === 'prepare') {
          await habits.semantic.prepare({ signal: controller.signal, onProgress: message => ctx.ui.setStatus(ENTRY, message) });
          habitNotice('多语言匹配模型已准备好，后续推理在本机运行。', ctx); return;
        }
        if (option !== 'status') {
          routeEpoch++; pendingUse = null;
          verifiedTasks.clear();
          await habits.store.configure({ ...(threshold ? { threshold: Number(threshold[1]) } : {}),
            ...(['on', 'off'].includes(option) ? { enabled: option === 'on' } : {}), clear: option === 'clear' });
          if (option === 'off') await habits.semantic.close();
        }
        const data = habits.store.read();
        const count = data.groups.reduce((n, g) => n + g.counts.reduce((s, c) => s + c.count, 0), 0);
        habitNotice(`习惯学习：${data.enabled ? '开' : '关'}；门槛 ${data.threshold} 次；${data.groups.length} 个类型/价格范围，${count} 次成功使用。近邻 Gemma 核验：${cfg.habits?.verify_uncertain === false ? '关' : '开'}。命中不强化；/bakahabits off 恢复每次 Gemma 分类，clear 清空记录。`, ctx);
      } catch (error) { habitFailure(error, ctx); }
      finally { active.delete(controller); ctx.ui.setStatus(ENTRY, automatic ? '自动路由：开' : '自动路由：关'); }
    },
  });
  pi.on('session_start', async (_event, ctx) => {
    routeEpoch++; pendingUse = null; manualModel = null;
    verifiedTasks.clear();
    privacy.start(ctx);
    if (ctx.mode === 'tui') ctx.ui.setStatus(ENTRY, automatic ? '自动路由：开' : '自动路由：关');
  });
  pi.on('before_agent_start', async (event, ctx) => {
    pendingUse = null;
    snapshotModels(ctx);
    turnHealthMessages = [];
    try { privacy.observe(event, ctx); }
    catch { privacy.enforce(ctx); return; }
    if (event.messageType !== 'user') { privacy.enforce(ctx); return; }
    if (automatic && event.systemPromptOptions) {
      const options = event.systemPromptOptions;
      if (options.customPrompt) {
        if (!options.appendSystemPrompt?.includes(TURN_GUIDELINE)) {
          options.appendSystemPrompt = [options.appendSystemPrompt, TURN_GUIDELINE].filter(Boolean).join('\n');
        }
      } else if (!options.promptGuidelines.includes(TURN_GUIDELINE)) options.promptGuidelines.push(TURN_GUIDELINE);
    }
    // An explicit manual selection owns the next turn; when routing is off it remains the current choice.
    if (manualModel && sameModel(manualModel, ctx.model) && learningEnabled(ctx)) {
      if (!privacy.enforce(ctx)) return;
      if (!event.images?.length) {
        try {
          const profile = (habitServices?.manualProfile ?? manualTaskProfile)(event.prompt);
          if (profile?.reusable && validProfile(profile)) pendingUse = { id: randomUUID(), source: 'manual',
            text: event.prompt, profile, scope: habitScope(pricePreference.get(), effectivePrices(ctx), privacy.models(ctx, ctx.modelRegistry.getAvailable())),
            provider: ctx.model!.provider, model: ctx.model!.id, epoch: routeEpoch };
        } catch (error) { habitFailure(error, ctx); }
      }
      if (automatic) manualModel = null;
      return;
    }
    if (automatic) await run(event.prompt, ctx, !!event.images?.length, false);
    if (!privacy.enforce(ctx)) pendingUse = null;
  });
  pi.on('model_select', async (event) => {
    if (routeState && event.source === 'set' && sameModel(event.model, routeState.switchingTo)) return;
    routeEpoch++;
    verifiedTasks.clear();
    pendingUse = null;
    manualModel = event.source === 'restore' ? null : event.model;
    if (routeState) routeState.restoreModel = event.model;
  });
  pi.on('agent_start', async (_event, ctx) => { displayedModel = null; snapshotModels(ctx); });
  pi.on('agent_end', async (event, ctx) => {
    // Pi may emit agent_end for each automatic retry. Count only after the entire run settles.
    // Retain outcome metadata only, never task text or provider error bodies.
    const final = event.messages.findLast(message => message.role === 'assistant');
    if (final) turnHealthMessages.push({ role: 'assistant', provider: final.provider, model: final.model,
      stopReason: final.stopReason, content: [{ type: 'text',
        text: final.content.some(part => part.type === 'text' && part.text.trim()) ? 'nonempty' : '' }] });
    if (event.messages.some(message => message.role === 'toolResult' && message.isError)) {
      turnHealthMessages.push({ role: 'toolResult', isError: true });
    }
    const use = pendingUse; pendingUse = null;
    if (!use || !habits || use.epoch !== routeEpoch || ctx.signal?.aborted) return;
    const replies = event.messages.filter(m => m.role === 'assistant');
    const last = replies.at(-1);
    // Count one completed answer, never tool continuations, failed/truncated attempts, or a different model.
    if (!last || last.stopReason !== 'stop' || !last.content.some(c => c.type === 'text' && c.text.trim())
      || replies.some(m => m.provider !== use.provider || m.model !== use.model || ['error','aborted','length'].includes(m.stopReason))
      || event.messages.some(m => m.role === 'toolResult' && m.isError)
      || event.messages.filter(m => m.role === 'user').length > 1) return;
    const controller = new AbortController(); active.add(controller);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
    try {
      if (!habits.store.enabled()) return;
      const embedding = use.embedding ?? (await habits.semantic.embed(use.text, { signal,
        onProgress: message => ctx.ui.setStatus(ENTRY, message) })).vector;
      if (signal.aborted || use.epoch !== routeEpoch) return;
      await habits.store.record({ ...use, embedding, taskHash: hash(use.text),
        shouldRecord: () => !signal.aborted && use.epoch === routeEpoch });
    } catch (error) {
      if (!signal.aborted && !(error instanceof ClassifierError && error.code === 'SEMANTIC_INPUT_TOO_LONG')) habitFailure(error, ctx);
    } finally { active.delete(controller); ctx.ui.setStatus(ENTRY, automatic ? '自动路由：开' : '自动路由：关'); }
  });
  pi.on('agent_settled', async (event, ctx) => {
    health.recordTurn(turnHealthMessages, { cancelled: event.aborted || !!ctx.signal?.aborted, models: turnModels });
    turnHealthMessages = [];
  });
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
    pendingUse = null; manualModel = null;
    verifiedTasks.clear();
    for (const controller of active) controller.abort();
    privacy.close();
    await Promise.all([backend.close(), habits?.semantic.close()]);
  });
}
