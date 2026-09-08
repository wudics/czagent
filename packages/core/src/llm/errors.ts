export type LLMErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'quota'
  | 'invalid'
  | 'context_overflow'
  | 'provider'
  | 'network'
  | 'cancelled'
  | 'unknown';

export interface LLMErrorOptions {
  status?: number;
  retryable?: boolean;
  retryAfterMs?: number;
}

export class LLMError extends Error {
  readonly kind: LLMErrorKind;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly status?: number;

  constructor(kind: LLMErrorKind, message: string, opts: LLMErrorOptions = {}) {
    super(message);
    this.name = 'LLMError';
    this.kind = kind;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

const CONTEXT_OVERFLOW_RE =
  /prompt is too long|context_length_exceeded|too many tokens|maximum context|token limit|input is too long|请求token数超限|超出.*上下文/i;

export function classifyHttpError(status: number, bodyText: string, retryAfterMs?: number): LLMError {
  if (status === 401 || status === 403) {
    return new LLMError('auth', bodyText || `HTTP ${status}`, { status });
  }
  if (status === 429) {
    const isQuota = /quota|insufficient|balance|余额|acount balance/i.test(bodyText);
    return new LLMError(isQuota ? 'quota' : 'rate_limit', bodyText || `HTTP ${status}`, {
      status,
      retryable: true,
      retryAfterMs,
    });
  }
  if (status === 400 || status === 404 || status === 409 || status === 413 || status === 422) {
    if (CONTEXT_OVERFLOW_RE.test(bodyText)) {
      return new LLMError('context_overflow', bodyText, { status });
    }
    return new LLMError('invalid', bodyText || `HTTP ${status}`, { status });
  }
  if (status >= 500) {
    return new LLMError('provider', bodyText || `HTTP ${status}`, { status, retryable: true });
  }
  return new LLMError('unknown', bodyText || `HTTP ${status}`, { status });
}

/** 面向用户的中文可读信息 */
export function friendlyLLMMessage(err: LLMError): string {
  switch (err.kind) {
    case 'auth':
      return '认证失败：请检查该平台的 API Key 是否正确。';
    case 'rate_limit':
      return '请求过于频繁（限流），请稍后重试。';
    case 'quota':
      return '账户余额不足或额度已用完，请充值后重试。';
    case 'context_overflow':
      return '内容超出模型上下文限制，建议开启新的会话或精简输入。';
    case 'invalid':
      return `请求无效：${err.message}`;
    case 'provider':
      return '模型服务暂时异常，请稍后重试。';
    case 'network':
      return '网络请求失败，请检查网络连接。';
    case 'cancelled':
      return '已取消。';
    default:
      return err.message || '未知错误';
  }
}
