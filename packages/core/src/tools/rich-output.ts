/** 富工具输出：工具除文本外可向消息流追加 image/file part（由 SessionManager 识别并落 parts）。 */

export interface RichToolImage {
  dataUrl: string;
  name?: string;
}

export interface RichToolFile {
  path: string;
  name?: string;
  kind?: string;
}

export interface RichToolMarkdown {
  /** 消息流中的展示标题（可空，仅正文渲染） */
  title?: string;
  /** Markdown 全文（追加为可见 text part；模型只收外层 text） */
  text: string;
}

export interface RichToolOutput {
  /** 给模型的文本（tool-result 的 output） */
  text: string;
  /** 追加到消息流的图片（渲染层直接显示） */
  images?: RichToolImage[];
  /** 追加到消息流的文件 chip */
  files?: RichToolFile[];
  /** 追加到消息流的可见 Markdown 文档（如 plan 工具提交的计划；不回传模型） */
  markdown?: RichToolMarkdown;
}

const MARKER = '__rich_tool_output__';

/** 打上标记（工具返回值用） */
export function richOutput(out: RichToolOutput): RichToolOutput & { [MARKER]: true } {
  return { ...out, [MARKER]: true } as RichToolOutput & { [MARKER]: true };
}

/** 识别富输出（结构 + 标记双校验，避免把普通对象误判） */
export function isRichToolOutput(v: unknown): v is RichToolOutput & { [MARKER]: true } {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>)[MARKER] === true &&
    typeof (v as RichToolOutput).text === 'string'
  );
}
