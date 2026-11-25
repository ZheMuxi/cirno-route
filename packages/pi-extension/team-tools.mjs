import { Type } from '@earendil-works/pi-ai';
import { ClassifierError } from './core.mjs';
import { PrivacyError } from './privacy-policy.mjs';
import { PricingError } from './pricing.mjs';
import { MAX_CONTEXT, TeamError } from './team-router.mjs';

export const TEAM_TOOLS = ['cirno_team_assign', 'cirno_team_dispatch'];
const part = Type.Object({
  role: Type.String({ minLength: 1, maxLength: 60, description: '工作职责，如规划、后端、前端、审阅；不要指定型号。' }),
  brief: Type.String({ minLength: 1, maxLength: 8000, description: '该部分可以独立理解的具体任务、交付物与验收条件。' }),
}, { additionalProperties: false });
const delivery = Type.Object({
  id: Type.String({ description: '本轮分工表给出的工作包 ID。' }),
  context: Type.Optional(Type.String({ maxLength: MAX_CONTEXT, description: '仅传本工作包所需资料，例如接口契约或必要源码。' })),
  feedback: Type.Optional(Type.String({ maxLength: 2400, description: '要求已派发工作包返工时，说明问题与修改要求。' })),
  reassign: Type.Optional(Type.Boolean({ description: '返工时要求路由器排除此前模型，重新按价格偏好选模。' })),
}, { additionalProperties: false });

export function registerTeamTools(pi, getTeam) {
  for (const [index, name] of TEAM_TOOLS.entries()) {
    const assign = index === 0;
    pi.registerTool({
      name, label: assign ? '路由器分工' : '统筹派发与接收汇报',
      defaultActive: false, executionMode: 'sequential',
      description: assign ? '按任务需要拆分工作包，可一次提交全部分工，后续也可追加。本地路由器依据能力和价格偏好选模，返回分工表。'
        : '按分工表 ID 派发任务给执行模型，等待各自的交付物。相互独立的工作包可以一次派发，系统最多同时执行两个。',
      parameters: assign
        ? Type.Object({ parts: Type.Array(part, { minItems: 1 }) }, { additionalProperties: false })
        : Type.Object({ jobs: Type.Array(delivery, { minItems: 1 }) }, { additionalProperties: false }),
      async execute(_id, args, signal, _update, ctx) {
        const team = getTeam();
        if (!team) throw new Error('TEAM_INACTIVE');
        try {
          const value = assign ? await team.assign(args.parts, ctx, signal) : await team.dispatch(args.jobs, ctx, signal);
          return { content: [{ type: 'text', text: JSON.stringify(value) }], details: { count: value.length } };
        } catch (e) {
          if (e instanceof PrivacyError) ctx.abort();
          const known = e instanceof TeamError || e instanceof PrivacyError || e instanceof ClassifierError || e instanceof PricingError;
          throw new Error(known ? e.code : 'TEAM_UNAVAILABLE');
        }
      },
    });
  }
}
