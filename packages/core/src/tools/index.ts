import { ToolRegistry, INTERNAL_TOOLS } from './registry.js';
import { readTool } from './read.js';
import { grepTool } from './grep.js';
import { globTool } from './glob.js';
import { webfetchTool } from './webfetch.js';
import { websearchTool } from './websearch/websearch.js';
import { skillTool } from './skill.js';
import { embedTool, rerankTool, imageGenerateTool, imageEditTool, videoGenerateTool, videoFromFrameTool, ttsTool, asrTool } from './multimodal.js';
import { bashTool } from './bash.js';
import { writeTool } from './write.js';
import { editTool } from './edit.js';
import { patchTool } from './patch.js';
import { planTool, planExitTool } from './plan.js';
import { questionTool } from './question.js';
import { todoTool } from './todo.js';
import { taskTool } from './task.js';

export * from './types.js';
export { ToolRegistry, INTERNAL_TOOLS } from './registry.js';
export { readTool, grepTool, globTool, webfetchTool, websearchTool, skillTool, embedTool, rerankTool, imageGenerateTool, imageEditTool, videoGenerateTool, videoFromFrameTool, ttsTool, asrTool, bashTool, writeTool, editTool, patchTool, planTool, planExitTool, questionTool, todoTool, taskTool };
export { resolveToolPath } from './read.js';

export function createDefaultRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.registerAll([readTool, grepTool, globTool, webfetchTool, websearchTool, skillTool, embedTool, rerankTool, imageGenerateTool, imageEditTool, videoGenerateTool, videoFromFrameTool, ttsTool, asrTool, bashTool, writeTool, editTool, patchTool, planTool, planExitTool, questionTool, todoTool, taskTool]);
  return reg;
}
