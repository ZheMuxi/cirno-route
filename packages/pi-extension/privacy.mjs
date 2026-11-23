import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { PrivacyPolicy, PrivacyError, toolPaths } from './privacy-policy.mjs';
import { installPrivacyTransport } from './privacy-transport.mjs';

const ENTRY = 'cirno-private-session';
const BLOCKED = '文件保护已拦截请求：当前模型不在本地／可信名单内。请使用 /bakaprivacy 配置允许的模型，或在新会话处理非保护内容。';
const UNAVAILABLE = '文件保护不可用，已停止请求。请检查本地规则文件及锁定的 Pi 版本，不会退回不受保护的发送。';

// Deliberately ignore binary attachment data, credentials and arbitrary object prototypes.
function strings(value, visit, seen = new Set()) {
  if (typeof value === 'string') { visit(value); return; }
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) { for (const item of value) strings(item, visit, seen); return; }
  for (const [key, item] of Object.entries(value)) {
    if (['data', 'apiKey', 'headers', 'env'].includes(key)) continue;
    strings(item, visit, seen);
  }
}

export function createPrivacyGuard(pi, cfg, { onChange = () => {} } = {}) {
  if (!cfg.privacy_file) return {
    start() {}, observe() { return false; }, restricted() { return false; },
    models(_ctx, models) { return models; }, enforce() { return true; }, close() {},
  };
  const policy = new PrivacyPolicy(cfg.privacy_file);
  let context, transport, transportRegistry, transportError = false;
  let lastNotice = '', lastNoticeAt = 0;
  const memory = new Set(), entriesWritten = new Set();
  const fallbackId = randomUUID();
  const sessionId = ctx => ctx.sessionManager?.getSessionId?.() ?? fallbackId;
  const cwd = ctx => ctx.cwd ?? process.cwd();
  function notify(message, ctx, warning = true) {
    if (warning && message === lastNotice && Date.now() - lastNoticeAt < 500) return;
    lastNotice = message; lastNoticeAt = Date.now();
    if (ctx.mode === 'tui' || ctx.mode === 'rpc') ctx.ui.notify(message, warning ? 'warning' : 'info');
    else process.stderr.write(JSON.stringify({ type: 'cirno-file-privacy', message }) + '\n');
  }
  function mark(ctx) {
    const id = sessionId(ctx);
    memory.add(id); // Keep the deny state even if persistence fails.
    if (!policy.isMarked(id)) policy.markSession(id);
    if (!entriesWritten.has(id)) {
      pi.appendEntry(ENTRY, { restricted: true });
      entriesWritten.add(id);
    }
  }
  function scan(value, ctx) {
    let matched = false;
    strings(value, text => { if (!matched && policy.matchesText(text, cwd(ctx))) matched = true; });
    if (matched) mark(ctx);
    return matched;
  }
  function observe(value, ctx) {
    context = ctx;
    // Validate persisted state on every send; once marked, no need to repeatedly scan all history.
    if (policy.isMarked(sessionId(ctx))) { memory.add(sessionId(ctx)); return true; }
    if (memory.has(sessionId(ctx))) { mark(ctx); return true; }
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    if (entries.some(e => e.type === 'custom' && e.customType === ENTRY && e.data?.restricted === true)) {
      mark(ctx); return true;
    }
    if (policy.hasRules()) {
      // Custom SDK/system prompt inputs can arrive without any file provenance.
      // Treat opaque overrides conservatively when file protection is configured.
      const promptOptions = value?.systemPromptOptions;
      if (promptOptions && ['customPrompt', 'appendSystemPrompt', 'forceSystemPrompt'].some(key =>
        typeof promptOptions[key] === 'string' && promptOptions[key].trim())) {
        mark(ctx); return true;
      }
      // Pi inserts these files as plain system text and otherwise loses their provenance.
      const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
      const sources = [join(cwd(ctx), '.pi', 'SYSTEM.md'), join(cwd(ctx), '.pi', 'APPEND_SYSTEM.md'),
        join(agentDir, 'SYSTEM.md'), join(agentDir, 'APPEND_SYSTEM.md')];
      for (let i = 0; i < process.argv.length - 1; i++) {
        if (['--system-prompt', '--append-system-prompt'].includes(process.argv[i])) sources.push(process.argv[i + 1]);
      }
      for (const path of sources) {
        if (existsSync(path) && policy.matchesPath(path, cwd(ctx))) { mark(ctx); return true; }
      }
      scan(entries, ctx);
      scan(ctx.getSystemPrompt?.() ?? '', ctx);
      scan(value, ctx);
      if (policy.matchesPath(cwd(ctx), cwd(ctx))) mark(ctx);
    }
    return memory.has(sessionId(ctx)) || policy.isMarked(sessionId(ctx));
  }
  function blocked(ctx, unavailable = false) {
    ctx.abort?.();
    notify(unavailable ? UNAVAILABLE : BLOCKED, ctx);
    return false;
  }
  const guard = {
    policy,
    start(ctx) {
      context = ctx;
      if (transportRegistry !== ctx.modelRegistry) {
        transport?.close(); transport = undefined; transportRegistry = ctx.modelRegistry;
        try { transport = installPrivacyTransport(ctx.modelRegistry, guard); transportError = false; }
        catch { transportError = true; }
      }
      try {
        observe(undefined, ctx);
        if (transportError && (policy.hasRules() || policy.isMarked(sessionId(ctx)))) {
          blocked(ctx, true);
          // Pi event errors are swallowed. Stop the host on an unsupported transport instead.
          ctx.shutdown?.();
        }
      } catch { blocked(ctx, true); ctx.shutdown?.(); }
    },
    observe,
    restricted(ctx, value) { return observe(value, ctx); },
    models(ctx, models) {
      if (!observe(undefined, ctx)) return models;
      if (transportError) throw new PrivacyError('PRIVACY_GUARD_UNAVAILABLE');
      return models.filter(model => policy.allowed(model));
    },
    enforce(ctx) {
      try {
        if (observe(undefined, ctx) && (transportError || !policy.allowed(ctx.model))) return blocked(ctx, transportError);
        return true;
      } catch { return blocked(ctx, true); }
    },
    // This is called outside Pi's exception-swallowing event runner, at the final provider boundary.
    assertRequest(model, body) {
      if (!context) throw new PrivacyError('PRIVACY_GUARD_UNAVAILABLE');
      try {
        if (observe(body, context) && !policy.allowed(model)) {
          notify(BLOCKED, context);
          throw new PrivacyError('PRIVACY_MODEL_BLOCKED');
        }
      } catch (error) {
        notify(error?.code === 'PRIVACY_MODEL_BLOCKED' ? BLOCKED : UNAVAILABLE, context);
        throw new PrivacyError(error?.code === 'PRIVACY_MODEL_BLOCKED' ? error.code : 'PRIVACY_GUARD_UNAVAILABLE');
      }
    },
    close() { transport?.close(); transport = undefined; transportRegistry = undefined; },
  };

  pi.registerCommand('bakaprivacy', {
    description: '文件保护：status / add 路径 / remove 路径 / trust 模型 / local 模型 / revoke 模型',
    handler: async (args, ctx) => {
      context = ctx;
      const match = /^(\S+)(?:\s+([\s\S]+))?$/.exec(args.trim() || 'status');
      const command = match?.[1], value = match?.[2]?.trim();
      try {
        if (command === 'status' && !value) {
          const data = policy.read();
          const protectedSession = observe(undefined, ctx);
          notify(`文件保护：${transportError ? '发送守卫不可用' : '已加载'}；当前会话${protectedSession ? '受保护' : '未标记'}。\n`
            + `保护路径（目录递归）：${data.paths.map(p => p.path).join('；') || '无'}\n`
            + `允许模型：${data.models.map(m => `${m.provider}/${m.id} [${m.kind}] ${m.baseUrl}`).join('；') || '无'}\n`
            + '用法：/bakaprivacy add 路径 | remove 路径 | trust provider/model | local provider/model | revoke provider/model', ctx, false);
          return;
        }
        if (!value || !['add', 'remove', 'trust', 'local', 'revoke'].includes(command)) {
          notify('用法：/bakaprivacy status | add 路径 | remove 路径 | trust provider/model | local provider/model | revoke provider/model', ctx, false); return;
        }
        if (transportError || !transport) throw new PrivacyError('PRIVACY_GUARD_UNAVAILABLE');
        // Cancel any in-flight selection before changing a security rule.
        onChange();
        if (ctx.isIdle?.() === false) ctx.abort?.();
        if (command === 'add') policy.addPath(value, cwd(ctx));
        else if (command === 'remove') policy.removePath(value, cwd(ctx));
        else if (command === 'revoke') policy.revokeModel(value);
        else {
          const matches = ctx.modelRegistry.getAll().filter(m => `${m.provider}/${m.id}` === value);
          if (matches.length !== 1) throw new PrivacyError(matches.length ? 'PRIVACY_MODEL_AMBIGUOUS' : 'PRIVACY_MODEL_NOT_FOUND');
          policy.allowModel(matches[0], command === 'local' ? 'local' : 'trusted');
        }
        observe(undefined, ctx);
        notify(command === 'local'
          ? '已按你的明确声明登记本地模型。回环地址也可能是云代理，请仅对确实在本机推理的端点使用 local。'
          : '文件保护规则已保存。已有受保护会话保持限制；处理非保护任务可新建会话。', ctx, false);
      } catch (error) {
        notify(`文件保护设置未完成：${error instanceof PrivacyError ? error.code : 'PRIVACY_CONFIG_ERROR'}`, ctx);
      }
    },
  });

  pi.on('input', async (event, ctx) => {
    try {
      // Prompt templates expand to bare text, so inspect their source before Pi expands them.
      const commandName = /^\/(\S+)/.exec(event.text)?.[1];
      if (commandName && policy.hasRules()) {
        const command = (pi.getCommands?.() ?? []).find(c => ['prompt', 'skill'].includes(c.source)
          && (c.name === commandName || `skill:${c.name}` === commandName));
        if (command?.sourceInfo?.path && policy.matchesPath(command.sourceInfo.path, cwd(ctx))) mark(ctx);
      }
      // Idle automatic routing may choose an allowed model later. Streaming steering must stop now.
      if (observe(event.text, ctx) && ctx.isIdle?.() === false && !policy.allowed(ctx.model)) {
        blocked(ctx); return { action: 'handled' };
      }
    } catch { blocked(ctx, true); return { action: 'handled' }; }
  });
  pi.on('context_with_system', async (event, ctx) => {
    try { observe(event.messages, ctx); guard.enforce(ctx); }
    catch { blocked(ctx, true); }
  });
  pi.on('tool_call', async (event, ctx) => {
    try {
      if (['write', 'edit'].includes(event.toolName) && typeof event.input?.path === 'string') {
        const settings = resolve(cfg.privacy_file);
        for (const path of toolPaths(event.input.path, cwd(ctx))) {
          let alias = false;
          try {
            const a = statSync(path), b = statSync(settings);
            alias = a.dev === b.dev && a.ino === b.ino;
          } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
          if (path === settings || alias) return { block: true, terminate: true,
            reason: 'PRIVACY_POLICY_WRITE_BLOCKED：请由用户通过 /bakaprivacy 修改保护规则。' };
        }
      }
      observe(event.input, ctx);
      const rules = policy.hasRules();
      if (rules && ['read', 'edit', 'write'].includes(event.toolName)) {
        if (typeof event.input?.path !== 'string') throw new PrivacyError('PRIVACY_PATH_UNRESOLVED');
        if (toolPaths(event.input.path, cwd(ctx), event.toolName === 'read')
          .some(path => policy.matchesPath(path, cwd(ctx)))) mark(ctx);
      }
      const sensitive = observe(undefined, ctx);
      const opaque = rules && !['read', 'edit', 'write'].includes(event.toolName);
      if ((sensitive || opaque) && !policy.allowed(ctx.model)) {
        blocked(ctx);
        return { block: true, terminate: true, reason: 'PRIVACY_TOOL_BLOCKED：受保护文件仅允许本地或可信模型；动态文件访问在不可信模型下被禁止。' };
      }
      // A permitted opaque tool can read protected data without retaining its original path.
      if (opaque) mark(ctx);
    } catch {
      blocked(ctx, true);
      return { block: true, terminate: true, reason: 'PRIVACY_GUARD_UNAVAILABLE' };
    }
  });
  pi.on('tool_result', async (event, ctx) => {
    try {
      // Recheck effective arguments in case a later tool handler normalized or changed them.
      if (policy.hasRules() && ['read', 'edit', 'write'].includes(event.toolName)
        && typeof event.input?.path === 'string'
        && toolPaths(event.input.path, cwd(ctx), event.toolName === 'read')
          .some(path => policy.matchesPath(path, cwd(ctx)))) mark(ctx);
      observe([event.input, event.content, event.structuredContent, event.details], ctx);
      if (!guard.enforce(ctx)) return { content: [{ type: 'text', text: 'PRIVACY_TOOL_RESULT_BLOCKED' }],
        details: undefined, structuredContent: undefined, isError: true };
    } catch {
      blocked(ctx, true);
      return { content: [{ type: 'text', text: 'PRIVACY_GUARD_UNAVAILABLE' }], isError: true };
    }
  });
  pi.on('user_bash', async (event, ctx) => {
    try {
      observe(event.command, ctx);
      if ((policy.hasRules() || observe(undefined, ctx)) && !policy.allowed(ctx.model)) {
        blocked(ctx);
        return { result: { output: 'PRIVACY_SHELL_BLOCKED：请先选择本地或可信模型。', exitCode: 1, cancelled: false, truncated: false } };
      }
      // Opaque shell output could contain any protected file. Conservatively taint before execution.
      if (policy.hasRules()) mark(ctx);
    } catch {
      blocked(ctx, true);
      return { result: { output: 'PRIVACY_GUARD_UNAVAILABLE', exitCode: 1, cancelled: false, truncated: false } };
    }
  });
  for (const eventName of ['session_before_compact', 'session_before_tree']) pi.on(eventName, async (event, ctx) => {
    try { observe(event, ctx); if (!guard.enforce(ctx)) return { cancel: true }; }
    catch { blocked(ctx, true); return { cancel: true }; }
  });
  pi.on('cache_warming_decision', async (_event, ctx) => {
    try { if (policy.hasRules() || observe(undefined, ctx)) return { action: 'stop' }; }
    catch { return { action: 'stop' }; }
  });
  return guard;
}
