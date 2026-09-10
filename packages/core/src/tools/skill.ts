import type { ToolDef, ToolContext } from './types.js';
import { scanSkills } from '../skills/discovery.js';

/** 加载技能详细说明（正文注入上下文；与 opencode 行为一致，不限制工具） */
export const skillTool: ToolDef = {
  id: 'skill',
  description:
    '加载可用技能的完整说明。仅当任务与 system 提示 <available_skills> 列表中某项技能的描述匹配时调用；name 必须取自该列表。加载后严格按技能正文行动；任务不匹配时不要调用本工具',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '技能名称（必须取自 available_skills 列表）' },
    },
    required: ['name'],
  },
  async execute(input, ctx: ToolContext) {
    const name = String(input.name ?? '').trim();
    if (!name) throw new Error('缺少 name 参数');
    // allowedSkills（I19）：脚本 ctx.use / agent.run skills 的权威覆盖——只认名单内技能；
    // 缺省跟随全局 disabledSkills
    const allowed = ctx.allowedSkills;
    const skills = (await scanSkills(ctx.cwd, ctx.builtinSkillsDir)).filter((s) =>
      allowed ? allowed.includes(s.name) : !(ctx.settings.general.disabledSkills ?? []).includes(s.name),
    );
    const skill = skills.find((s) => s.name === name) ?? skills.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!skill) {
      // 不 throw：返回引导文本让模型自行纠正（错误路径会计入 doom-loop 且不利于重试）
      if (skills.length === 0) {
        return `未找到技能「${name}」，当前无可用技能。请直接完成任务，不要再调用本工具。`;
      }
      return `未找到技能「${name}」。可用技能：${skills.map((s) => s.name).join('、')}。请从上述列表中选择正确的技能名重试；若均不匹配，直接完成任务即可。`;
    }
    return skill.body;
  },
};
