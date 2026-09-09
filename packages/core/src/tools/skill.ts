import type { ToolDef, ToolContext } from './types.js';
import { scanSkills } from '../skills/discovery.js';

/** 加载技能详细说明（正文注入上下文；与 opencode 行为一致，不限制工具） */
export const skillTool: ToolDef = {
  id: 'skill',
  description:
    '加载可用技能的完整说明。当任务与 system 提示中 <available_skills> 列表的某项匹配时，先用本工具加载该技能的正文，再按其指导行动',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '技能名称（见 available_skills 列表）' },
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
    const skill = skills.find((s) => s.name === name);
    if (!skill) {
      throw new Error(`未找到技能：${name}（可用：${skills.map((s) => s.name).join('、') || '无'}）`);
    }
    return skill.body;
  },
};
