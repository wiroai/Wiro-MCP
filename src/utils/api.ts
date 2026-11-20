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

/** What a call gets for a guid that names no agent this connection can reach, with the step that sorts it out. */
export const AGENT_NOT_FOUND_TEXT = 'Agent not found. Check the guid with list_my_agents, which lists the agents this '
  + 'connection can reach. The connected project reaches only the agents of its own workspace (personal or team), and '
  + 'get_account shows which one that is.';

const AGENT_NOT_FOUND_ANSWER = /^(user agent not found|agent not found or access denied)\.?$/i;

// Wiro's answer when a skill it has to read is not in the registry. The skill's name is the part to act on.
const UNLISTED_SKILL_ANSWER = /^[a-z-]+: skill '([\w.-]+)' .*not found in registry\.?$/i;

/** Wiro's sentence as a person reads it: an agent that cannot be reached, or a skill that is not in the registry, gets its next step. */
export function readableApiMessage(message: string): string {
  const text = message.trim();
  if (AGENT_NOT_FOUND_ANSWER.test(text)) return AGENT_NOT_FOUND_TEXT;
  const skill = UNLISTED_SKILL_ANSWER.exec(text)?.[1];
  return skill
    ? `Wiro could not work this out because the skill ${skill} is not in the skill registry. list_agent_skills shows the current names. If the request did not name this skill, the agent already has it on, and Wiro support can take it off.`
    : message;
}

/** Whether the error says the guid names no agent this connection can reach. */
export function isAgentNotFound(error: unknown): boolean {
  return error instanceof Error && error.message === AGENT_NOT_FOUND_TEXT;
}

export function apiErrorMessage(body: ApiEnvelope | undefined, fallback: string): string {
  const messages = (body?.errors ?? [])
    .map(error => (typeof error?.message === 'string' ? readableApiMessage(error.message.trim()) : ''))
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

/** The Spend Limits page of the Wiro dashboard. */
export const SPEND_LIMITS_URL = 'https://wiro.ai/panel/controls/spend-limits';

/** The Model Access page of the Wiro dashboard. */
export const MODEL_ACCESS_URL = 'https://wiro.ai/panel/controls/model-access';

/** Wiro's code for a spend limit that refused work: the wallet's, a team member's, an API key's, a surface's or an agent's. */
export const SPEND_LIMIT_CODE = 93;

// Who changes a limit: the account itself, or in a team a team admin or the organization's owner. Never an agent.
const SPEND_LIMIT_CHANGE = 'someone who can change it raises it (the account owner, a team admin or the organization\'s '
  + 'owner): get_controls shows the limit and when it resets, and manage_spend_limit changes it after the user confirms '
  + `a change summary. Spend Limits page: ${SPEND_LIMITS_URL}.`;

/** What follows a refusal by a limit that is used up: nothing ran, and trying again changes nothing until the limit does. */
export const SPEND_LIMIT_NOTE = 'A spend limit of this workspace is used up, so nothing ran and nothing was charged. '
  + `Do not try again until the limit resets or ${SPEND_LIMIT_CHANGE}`;

/**
 * What follows a refusal of work with a known price that does not fit what is left of a limit. The limit is not
 * used up, so cheaper work can still run; this same work cannot until the limit resets or is raised.
 */
export const SPEND_LIMIT_LEFT_NOTE = 'A spend limit of this workspace has less left than this costs, so nothing ran '
  + 'and nothing was charged. The limit is not used up: cheaper work, such as a run at a lower resolution, a shorter '
  + 'length or fewer outputs, may fit what is left, but start it only with the user\'s yes. This same work stays '
  + `refused until the limit resets or ${SPEND_LIMIT_CHANGE}`;

/** Added when part of a limit is held by work that is still running. */
export const SPEND_LIMIT_HELD_NOTE = 'Part of the limit is held by work that is still running: it frees up when that '
  + 'work ends, and only what it is charged counts.';

// Wiro's refusal of work with a known price that does not fit: "... has $3.10 left of $500.00, and this run costs $4.00."
const LEFT_REFUSAL = /\bhas \$\d[\d,]*(?:\.\d+)? left\b[\s\S]*?\bcosts? \$\d/i;
// Wiro's refusal names work that is still running when held estimates took part in it.
const HELD_REFUSAL = /\bheld\b|\bstill running\b/i;

/**
 * The note for a spend-limit refusal, by its shape: a limit that is used up, or work with a known price that does
 * not fit what is left. Either can name work that is still running, which holds part of the limit.
 */
export function spendLimitNote(message: string): string {
  const note = LEFT_REFUSAL.test(message) ? SPEND_LIMIT_LEFT_NOTE : SPEND_LIMIT_NOTE;
  return HELD_REFUSAL.test(message) ? `${note} ${SPEND_LIMIT_HELD_NOTE}` : note;
}

/** Wiro's code for a model that a Model Access rule blocks: the wallet's, a team member's, an API key's, a surface's or an agent's. */
export const MODEL_ACCESS_CODE = 92;

/** What to do after a Model Access refusal: the rule decides until someone changes it, so nothing is tried in its place. */
export const MODEL_ACCESS_ADVICE = 'Do not try again, and do not work around the rule on your own, for example with another model. '
  + 'Tell the user which rule blocked the model (the refusal names it; check_model_access shows every rule that blocks it and why). '
  + 'The account owner, a team admin or the organization\'s owner can change the rule with manage_model_access after a change '
  + `summary, or at ${MODEL_ACCESS_URL}, or the user can pick another model.`;

/** What follows a Model Access refusal of a run or a message: nothing ran. */
export const MODEL_ACCESS_NOTE = 'A Model Access rule of this workspace blocks this model, so nothing ran and nothing was charged. '
  + MODEL_ACCESS_ADVICE;

export function hasErrorCode(error: unknown, code: number | string): boolean {
  return error instanceof ApiResultError
    && error.codes.some(candidate => String(candidate) === String(code));
}

/** The first error message of a Wiro JSON answer, if the body is one. */
function bodyErrorMessage(responseBody: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(responseBody);
    const errors = isPlainObject(parsed) && Array.isArray(parsed.errors) ? parsed.errors : [];
    const first = errors.find(entry => isPlainObject(entry) && typeof entry.message === 'string' && entry.message.trim() !== '');
    return isPlainObject(first) ? String(first.message).trim() : undefined;
  } catch {
    return undefined;
  }
}

export function errorText(error: unknown): string {
  if (error instanceof WiroApiError && error.status === 413) {
    return 'The request was too large for the Wiro API (HTTP 413). A file is probably over the size limit.';
  }
  // Refusals such as a team key whose creator left the team arrive as HTTP
  // errors with Wiro's own sentence in the body; show that sentence.
  if (error instanceof WiroApiError && !error.hint) {
    const message = bodyErrorMessage(error.responseBody);
    if (message) return `Wiro API error ${error.status}: ${message}`;
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
