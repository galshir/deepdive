export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'NOT_CONNECTED'
  | 'CONNECTION'
  | 'READ_ONLY'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'LIMIT'
  | 'DB_ERROR'
  | 'DECLINED';

export class DeepDiveError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
  ) {
    super(message);
    this.name = 'DeepDiveError';
  }
}

export const validationError = (message: string) => new DeepDiveError(message, 'VALIDATION');

/**
 * Converts any thrown value into a user-safe message.
 * Known secrets are redacted verbatim; common credential patterns are masked too.
 */
export function toSafeMessage(err: unknown, secrets: readonly string[] = []): string {
  let message: string;
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    message = typeof code === 'string' && !(err instanceof DeepDiveError) && !err.message.includes(code) ? `${code}: ${err.message}` : err.message;
  } else if (typeof err === 'string') {
    message = err;
  } else {
    message = 'Unknown error';
  }
  for (const secret of secrets) {
    if (secret && secret.length >= 3) message = message.split(secret).join('••••');
  }
  message = message
    .replace(/(password|passwd|pwd)(\s*[=:]\s*)\S+/gi, '$1$2••••')
    .replace(/(mysql:\/\/)[^@\s]*@/gi, '$1••••@');
  return message.length > 2000 ? `${message.slice(0, 2000)}…` : message;
}

export function errorCode(err: unknown): ErrorCode | undefined {
  return err instanceof DeepDiveError ? err.code : undefined;
}
