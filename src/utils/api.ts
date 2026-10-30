import { WiroApiError } from '../client.js';

// Wiro reports each outcome in the response body (`result` and `errors`), so
// every endpoint body is checked here.

export interface ApiErrorItem {
  code?: number | string;
  message?: string;
}

export interface ApiEnvelope {
  result?: boolean;
  errors?: ApiErrorItem[];
}

export class ApiResultError extends Error {
  readonly codes: Array<number | string>;
  readonly body: Record<string, unknown>;

  constructor(message: string, codes: Array<number | string>, body: Record<string, unknown>) {
    super(message);
    this.name = 'ApiResultError';
    this.codes = codes;
    this.body = body;
  }
}

export function apiErrorMessage(body: ApiEnvelope | undefined, fallback: string): string {
  const messages = (body?.errors ?? [])
    .map(error => (typeof error?.message === 'string' ? error.message.trim() : ''))
    .filter(Boolean);
  return [...new Set(messages)].join(', ') || fallback;
}

/** Returns the body when `result` is true, otherwise throws ApiResultError. */
export function requireApiSuccess<T extends ApiEnvelope>(body: T, fallback: string): T {
  if (body?.result === true) return body;
  const codes = (body?.errors ?? [])
    .map(error => error?.code)
    .filter((code): code is number | string => code !== undefined && code !== null);
  throw new ApiResultError(
    apiErrorMessage(body, fallback),
    codes,
    (body ?? {}) as Record<string, unknown>,
  );
}

/**
 * True when a request may have reached Wiro and done its work even though no
 * usable answer came back: a network failure, a timeout, or a 5xx/408/429.
 * A result:false body or another 4xx is a clean refusal.
 */
export function isOutcomeUnknown(error: unknown): boolean {
  if (error instanceof ApiResultError) return false;
  if (error instanceof WiroApiError) {
    return error.status >= 500 || error.status === 408 || error.status === 429;
  }
  return true;
}

export function hasErrorCode(error: unknown, code: number | string): boolean {
  return error instanceof ApiResultError
    && error.codes.some(candidate => String(candidate) === String(code));
}

export function errorText(error: unknown): string {
  if (error instanceof WiroApiError && error.status === 413) {
    return 'The request was too large for the Wiro API (HTTP 413). A file is probably over the size limit.';
  }
  return error instanceof Error ? error.message : String(error);
}

export function errorResult(error: unknown) {
  return {
    content: [{ type: 'text' as const, text: `## Error\n\n${errorText(error)}` }],
    isError: true,
  };
}

export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function toInteger(value: unknown, fallback = 0): number {
  const parsed = toNumber(value);
  return parsed === null ? fallback : Math.trunc(parsed);
}

export function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Unix seconds (number or numeric string) to an ISO time, or undefined. */
export function unixToIso(value: unknown): string | undefined {
  const seconds = toNumber(value);
  if (seconds === null || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

export function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

export function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}
