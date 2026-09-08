/** compaction 截断测试：常规阈值、skill 豁免（宽松上限）、截断标记。 */
import { describe, expect, it } from 'vitest';
import {
  FULL_RESULT_MAX_CHARS,
  TOOL_RESULT_TRUNCATE_CHARS,
  TOOL_RESULT_TRUNCATE_MARKER,
  truncateToolOutput,
} from '../src/compaction.js';

describe('truncateToolOutput', () => {
  it('常规工具超阈值截断并加标记', () => {
    const text = 'x'.repeat(TOOL_RESULT_TRUNCATE_CHARS + 100);
    const out = truncateToolOutput(text, 'bash');
    expect(out.length).toBe(TOOL_RESULT_TRUNCATE_CHARS + TOOL_RESULT_TRUNCATE_MARKER.length);
    expect(out.endsWith(TOOL_RESULT_TRUNCATE_MARKER)).toBe(true);
  });

  it('常规工具阈值内不截断', () => {
    const text = 'x'.repeat(TOOL_RESULT_TRUNCATE_CHARS);
    expect(truncateToolOutput(text, 'bash')).toBe(text);
  });

  it('skill 豁免常规阈值（10k~32k 之间不截断）', () => {
    const text = 'x'.repeat(TOOL_RESULT_TRUNCATE_CHARS + 1);
    expect(truncateToolOutput(text, 'skill')).toBe(text);
    expect(truncateToolOutput(text)).toBe(text.slice(0, TOOL_RESULT_TRUNCATE_CHARS) + TOOL_RESULT_TRUNCATE_MARKER);
  });

  it('skill 超宽松安全上限仍截断', () => {
    const text = 'x'.repeat(FULL_RESULT_MAX_CHARS + 1);
    const out = truncateToolOutput(text, 'skill');
    expect(out.length).toBe(FULL_RESULT_MAX_CHARS + TOOL_RESULT_TRUNCATE_MARKER.length);
    expect(out.endsWith(TOOL_RESULT_TRUNCATE_MARKER)).toBe(true);
  });

  it('未指定工具名按常规阈值（回归）', () => {
    const text = 'x'.repeat(TOOL_RESULT_TRUNCATE_CHARS + 1);
    expect(truncateToolOutput(text)).toBe(text.slice(0, TOOL_RESULT_TRUNCATE_CHARS) + TOOL_RESULT_TRUNCATE_MARKER);
  });
});
