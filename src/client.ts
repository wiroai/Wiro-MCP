import crypto from 'node:crypto';
import type {
  ListTasksParams,
  SearchModelsParams,
  RunModelResult,
  TaskDetailResponse,
  TaskListResponse,
  ToolListResponse,
  ToolDetailResponse,
  ExploreResponse,
  FileUploadResponse,
  Task,
} from './types.js';
import { TERMINAL_STATUSES } from './types.js';
import { fetchPublicFile } from './utils/remote-file.js';

export type {
  ListTasksParams,
  SearchModelsParams,
  RunModelResult,
  TaskDetailResponse,
  TaskListResponse,
  ToolListResponse,
  ToolDetailResponse,
  ExploreResponse,
  FileUploadResponse,
} from './types.js';
export type {
  Task,
  TaskCustomToolCallSegment,
  TaskFinishReason,
  TaskFunctionCallSegment,
  TaskOutput,
  TaskOutputRawContent,
  TaskSegment,
  TaskTextSegment,
  TaskToolCallSegment,
  TaskToolCallStatus,
  TaskUsage,
  ToolListItem,
  ToolParameterGroup,
  ToolParameterItem,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.wiro.ai/v1';
const DEFAULT_TIMEOUT = 120000;
const FAST_POLL_INTERVAL = 2000;
const NORMAL_POLL_INTERVAL = 5000;
const SLOW_POLL_INTERVAL = 10000;
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 5;
const DEFAULT_MISSING_SECRET_HINT = 'This project uses signature-based auth. '
  + 'Pass its API secret to WiroClient along with the API key.';
const MAX_UPLOAD_BYTES = Math.floor(0.1 * 1024 ** 3);
// The upload endpoint unpacks a .zip archive into a folder of its files, and a
// folder has no single link, so uploadFile does not send one.
const ARCHIVE_MEDIA_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/x-zip',
]);
const ARCHIVE_UPLOAD_MESSAGE = 'A .zip archive cannot be uploaded as one file. '
  + 'Pass the archive\'s public URL to the model directly, or upload its files one at a time.';

export interface TaskReference {
  tasktoken?: string;
  taskid?: string;
}

export interface WaitForTaskOptions {
  signal?: AbortSignal;
  onPoll?: (
    task: Task,
    context: { attempt: number; elapsedMs: number },
  ) => void | Promise<void>;
  pollIntervalMs?: number;
  maxConsecutiveErrors?: number;
}

/**
 * Returns the headers to add to one Wiro API request. `pathname` is the path of
 * the request URL, base path included, such as `/v1/Tool/List`, and `apiKey`
 * is the API key the request is sent with.
 */
export type RequestHeadersHook = (
  request: { pathname: string; apiKey: string },
) => Record<string, string>;

export interface WiroClientOptions {
  /**
   * Called for every Wiro API request the client sends, JSON and multipart.
   * The headers it returns are sent after the client's own. Their values must
   * be strings, and they may not set x-api-key, x-signature, x-nonce or
   * Content-Type: the request then fails before it is sent.
   */
  requestHeaders?: RequestHeadersHook;
  // Shown instead of the API's "x-signature and x-nonce headers are required"
  // error when the project needs signature auth and no API secret was given.
  // Say where your users enter the secret.
  missingSecretHint?: string;
}

const MAX_PAGE_TEXT = 200;
const PAGE_MARKUP = /<\/?(?:!doctype|html|head|body|title|h[1-6]|center|div|p|pre|hr|br)\b/i;
const PAGE_ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': '\'',
  '&amp;': '&',
};

function pageText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:nbsp|lt|gt|quot|#39|amp);/g, entity => PAGE_ENTITIES[entity] ?? entity)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * An answer body as an error message shows it. JSON and plain text stay as
 * they are. Text that starts like JSON but does not parse becomes one fixed
 * line, so no part of a row reaches a message. A web page, such as the error
 * page of a proxy between the client and the API, becomes one short line: its
 * title, or else its text. `responseBody` keeps the full answer.
 */
function bodyForMessage(body: string, status?: number): string {
  try {
    JSON.parse(body);
    return body;
  } catch {
    // Not JSON.
  }
  if (/^\s*[{[]/.test(body)) return 'the answer could not be read';
  if (!PAGE_MARKUP.test(body)) return body;
  const title = pageText(/<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(body)?.[1] ?? '');
  const full = title || pageText(body);
  // "504 Gateway Time-out" after "Wiro API error 504:" would repeat the code.
  const text = (status !== undefined ? full.replace(new RegExp(`^${status}\\b\\s*:?\\s*`), '') : '') || full;
  if (!text) return 'the answer was a web page with no text';
  return text.length > MAX_PAGE_TEXT ? `${text.slice(0, MAX_PAGE_TEXT)}...` : text;
}

export class WiroApiError extends Error {
  readonly status: number;
  readonly responseBody: string;
  readonly hint?: string;

  constructor(status: number, responseBody: string, hint?: string) {
    super(`Wiro API error ${status}: ${hint ?? bodyForMessage(responseBody, status)}`);
    this.name = 'WiroApiError';
    this.status = status;
    this.responseBody = responseBody;
    this.hint = hint;
  }
}

export class TaskWaitTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly lastDetail?: TaskDetailResponse;
  readonly lastError?: unknown;

  constructor(timeoutMs: number, lastDetail?: TaskDetailResponse, lastError?: unknown) {
    super(`Task timed out after ${timeoutMs / 1000} seconds`);
    this.name = 'TaskWaitTimeoutError';
    this.timeoutMs = timeoutMs;
    this.lastDetail = lastDetail;
    this.lastError = lastError;
  }
}

export class TaskPollingError extends Error {
  readonly lastDetail?: TaskDetailResponse;
  readonly lastError?: unknown;

  constructor(message: string, lastDetail?: TaskDetailResponse, lastError?: unknown) {
    super(message);
    this.name = 'TaskPollingError';
    this.lastDetail = lastDetail;
    this.lastError = lastError;
  }
}

/** True when a value can be a task ID: Wiro task IDs are whole numbers. */
export function isTaskId(value: string): boolean {
  return /^\d+$/.test(value.trim());
}

// No task ID is larger than this.
const MAX_TASK_ID = 9223372036854775807n;

/** True when a whole number is larger than any task ID, so no task has it. */
export function isTaskIdTooLarge(value: string): boolean {
  if (!isTaskId(value)) return false;
  const digits = value.trim().replace(/^0+/, '');
  return digits.length > 19 || BigInt(digits || '0') > MAX_TASK_ID;
}

// Task/Detail's answer when no task matches the reference in the key's
// workspace: an unknown task and another workspace's task get the same one.
const TASK_NOT_FOUND_ERRORS = ['task-not-founded', 'coretask-not-founded'];

/** True when a task status answer says the task is not in the key's workspace. */
export function isTaskNotFound(detail?: TaskDetailResponse): boolean {
  if (!detail || detail.result) return false;
  return (detail.errors ?? [])
    .some(error => TASK_NOT_FOUND_ERRORS.includes(String(error?.message ?? '').trim()));
}

// WiroClient sets these itself, so a requestHeaders hook may not.
const CLIENT_HEADERS = new Set(['x-api-key', 'x-signature', 'x-nonce', 'content-type', 'x-wiro-run-key']);

/** The header a run request carries its run key in (see `RunModelOptions.runKey`). */
export const RUN_KEY_HEADER = 'x-wiro-run-key';

/** How the last call serving a keyed run ended, for `releaseRun`. */
export type RunReleaseOutcome = 'answered' | 'unanswered' | 'failed';

export interface RunModelOptions {
  /**
   * 64 hex characters naming this run request: the same caller, model and
   * parameters give the same key. Wiro then answers a repeat of the request
   * that comes as a retry (10 seconds or more after it, or after its call
   * ended unanswered) with the first request's task, flagged `runkeyreused`,
   * instead of starting and billing a new one, whichever server process sends
   * it. Call `releaseRun` once the last call serving the run has ended.
   */
  runKey?: string;
}

/** Checks what a requestHeaders hook returned and copies it. */
function checkRequestHeaders(headers: unknown): Record<string, string> {
  const prototype = typeof headers === 'object' && headers !== null
    ? Object.getPrototypeOf(headers)
    : undefined;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('requestHeaders must return a plain object of header names and string values');
  }
  const checked: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers as object)) {
    if (typeof value !== 'string') {
      throw new TypeError(`requestHeaders returned a non-string value for ${name}`);
    }
    if (CLIENT_HEADERS.has(name.toLowerCase())) {
      throw new Error(`requestHeaders cannot set ${name}; WiroClient sets it`);
    }
    checked[name] = value;
  }
  return checked;
}

export class WiroClient {
  private readonly apiKey: string;
  private readonly apiSecret?: string;
  private readonly baseUrl: string;
  private readonly requestHeaders?: RequestHeadersHook;
  private readonly missingSecretHint: string;
  public readonly authType: 'signature' | 'apikey-only';

  constructor(
    apiKey: string,
    apiSecret?: string,
    baseUrl?: string,
    options: WiroClientOptions = {},
  ) {
    if (!apiKey) throw new Error('WIRO_API_KEY is required');
    // Ignoring it would send every request without the headers its caller
    // expects, so code written for an older version fails here instead.
    if ('trustedProxy' in options) {
      throw new Error('The trustedProxy option was removed in 1.5.0; pass requestHeaders instead.');
    }
    if (options.requestHeaders !== undefined && typeof options.requestHeaders !== 'function') {
      throw new TypeError('requestHeaders must be a function');
    }
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = baseUrl ?? DEFAULT_BASE_URL;
    this.requestHeaders = options.requestHeaders;
    this.missingSecretHint = options.missingSecretHint ?? DEFAULT_MISSING_SECRET_HINT;
    this.authType = apiSecret ? 'signature' : 'apikey-only';
  }

  /** A short, non-reversible id of this client's API key, for per-caller bookkeeping. */
  get identity(): string {
    return crypto.createHash('sha256').update(this.apiKey).digest('hex').slice(0, 16);
  }

  /** Whether a value is this client's API key. The key itself stays inside the client. */
  isOwnApiKey(value: unknown): boolean {
    return typeof value === 'string' && value === this.apiKey;
  }

  // Without a secret, the only 401 that mentions a signature is a project
  // that requires signature auth.
  private toApiError(status: number, responseBody: string): WiroApiError {
    const missingSecret = status === 401
      && this.authType === 'apikey-only'
      && /signature/i.test(responseBody);
    return new WiroApiError(
      status,
      responseBody,
      missingSecret ? this.missingSecretHint : undefined,
    );
  }

  private getAuthHeaders(pathname: string): Record<string, string> {
    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
      'Content-Type': 'application/json',
    };

    if (this.authType === 'signature' && this.apiSecret) {
      const nonce = Date.now().toString();
      const signature = crypto
        .createHmac('sha256', this.apiKey)
        .update(this.apiSecret + nonce)
        .digest('hex');
      headers['x-signature'] = signature;
      headers['x-nonce'] = nonce;
    }

    const requestHeaders = this.requestHeaders;
    if (requestHeaders) {
      Object.assign(headers, checkRequestHeaders(requestHeaders({ pathname, apiKey: this.apiKey })));
    }

    return headers;
  }

  private async request<T>(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = { ...this.getAuthHeaders(new URL(url).pathname), ...extraHeaders };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });

    const text = await response.text();

    if (!response.ok) {
      throw this.toApiError(response.status, text);
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Invalid JSON response: ${bodyForMessage(text)}`);
    }
  }

  /**
   * Calls any Wiro API endpoint with this client's credentials, for example
   * `post('/Workflow/List', { scope: 'my' })`. Wiro reports each outcome in the
   * response body, so check `result` on the returned body.
   */
  async post<T = Record<string, unknown>>(
    path: string,
    body: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    return this.request<T>(path, body, signal);
  }

  /** Same as `post`, for endpoints that take multipart/form-data. */
  async postForm<T = Record<string, unknown>>(
    path: string,
    form: FormData,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = this.getAuthHeaders(new URL(url).pathname);
    delete headers['Content-Type'];

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: form,
      signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw this.toApiError(response.status, text);
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Invalid JSON response: ${bodyForMessage(text)}`);
    }
  }

  async searchModels(params: SearchModelsParams = {}): Promise<ToolListResponse> {
    const body: Record<string, unknown> = {
      start: String(params.start ?? 0),
      limit: String(params.limit ?? 20),
      search: params.search ?? '',
      categories: params.categories ?? [],
      sort: params.sort ?? 'relevance',
      hideworkflows: true,
      summary: true,
    };
    if (params.slugowner) body.slugowner = params.slugowner;
    if (params.order) body.order = params.order;
    // A search that no model matches in full comes back with the results for
    // the longest run of its words that some model has, plus `searchused` and
    // `searchignored`. An API without the fallback ignores the flag.
    if (params.search?.trim()) body.searchfallback = true;
    return this.request<ToolListResponse>('/Tool/List', body);
  }

  async explore(): Promise<ExploreResponse> {
    return this.request<ExploreResponse>('/Tool/Explore', {});
  }

  async getModelSchema(model: string): Promise<ToolDetailResponse> {
    const [cleanslugowner, ...rest] = model.split('/');
    const cleanslugproject = rest.join('/');
    if (!cleanslugowner || !cleanslugproject) {
      throw new Error('Model must be in "owner/model" format, e.g. "google/veo3-1"');
    }
    return this.request<ToolDetailResponse>('/Tool/Detail', {
      slugowner: cleanslugowner,
      slugproject: cleanslugproject,
    });
  }

  async runModel(
    model: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    options: RunModelOptions = {},
  ): Promise<RunModelResult> {
    const [cleanslugowner, ...rest] = model.split('/');
    const cleanslugproject = rest.join('/');
    if (!cleanslugowner || !cleanslugproject) {
      throw new Error('Model must be in "owner/model" format, e.g. "google/veo3-1"');
    }
    const { runKey } = options;
    if (runKey !== undefined && !/^[0-9a-f]{64}$/.test(runKey)) {
      throw new Error('runKey must be 64 lowercase hex characters');
    }
    return this.request<RunModelResult>(
      `/Run/${cleanslugowner}/${cleanslugproject}`,
      params,
      signal,
      runKey ? { [RUN_KEY_HEADER]: runKey } : undefined,
    );
  }

  /**
   * Tells Wiro the last call serving a keyed run ended: `answered` (its answer
   * reached the client, so the same request is a new run from now on),
   * `failed` (its task is not worth continuing) or `unanswered` (the client
   * left first, so a repeat in the next 10 minutes continues the task).
   */
  async releaseRun(
    runKey: string,
    taskid: string,
    outcome: RunReleaseOutcome,
    signal?: AbortSignal,
  ): Promise<{ result: boolean; errors?: Array<{ message: string }>; released?: boolean }> {
    return this.request('/Run/Release', { runkey: runKey, taskid, outcome }, signal);
  }

  async getTask(opts: TaskReference, signal?: AbortSignal): Promise<TaskDetailResponse> {
    if (!opts.tasktoken && !opts.taskid) {
      throw new Error('Either tasktoken or taskid is required');
    }
    const body: Record<string, unknown> = {};
    if (opts.tasktoken) body.tasktoken = opts.tasktoken;
    if (opts.taskid) body.taskid = opts.taskid;
    return this.request<TaskDetailResponse>('/Task/Detail', body, signal);
  }

  async listTasks(
    params: ListTasksParams = {},
    signal?: AbortSignal,
  ): Promise<TaskListResponse> {
    const body: Record<string, unknown> = {
      type: 'model',
      sort: 'id',
      order: 'DESC',
      start: String(params.start ?? 0),
      limit: String(params.limit ?? 20),
    };
    if (params.model) body.modelName = params.model;
    return this.request<TaskListResponse>('/Task/List', body, signal);
  }

  async cancelTask(
    task: string | TaskReference,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const reference = normalizeTaskReference(task);
    let taskid = reference.taskid;

    if (!taskid && reference.tasktoken) {
      const detail = await this.getTask({ tasktoken: reference.tasktoken }, signal);
      taskid = detail.tasklist?.[0]?.id;
    }

    if (!taskid) {
      throw new Error('Unable to resolve task ID for cancellation');
    }

    return this.request('/Task/Cancel', { taskid }, signal);
  }

  async killTask(
    task: string | TaskReference,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const reference = normalizeTaskReference(task);
    const body: Record<string, unknown> = {};

    if (reference.taskid) {
      body.taskid = reference.taskid;
    } else if (reference.tasktoken) {
      body.socketaccesstoken = reference.tasktoken;
    } else {
      throw new Error('Either tasktoken or taskid is required');
    }

    return this.request('/Task/Kill', body, signal);
  }

  async uploadFile(fileUrl: string, fileName?: string): Promise<FileUploadResponse> {
    // Public http(s) hosts only; see utils/remote-file.ts. The upload endpoint
    // refuses files over 0.1 GiB, so a bigger one is not downloaded at all.
    const remote = await fetchPublicFile(fileUrl, { maxBytes: MAX_UPLOAD_BYTES });
    const blob = new Blob([remote.data], remote.contentType ? { type: remote.contentType } : {});
    // blob.type is what the upload sends: lowercased, with any parameters.
    if (ARCHIVE_MEDIA_TYPES.has((blob.type.split(';')[0] ?? '').trim())) {
      throw new Error(ARCHIVE_UPLOAD_MESSAGE);
    }
    const resolvedName = fileName
      ?? fileUrl.split('/').pop()?.split('?')[0]
      ?? 'upload';

    const formData = new FormData();
    formData.append('file', blob, resolvedName);

    return this.postForm<FileUploadResponse>('/File/Upload', formData);
  }

  async waitForTask(
    task: string | TaskReference,
    timeoutMs = DEFAULT_TIMEOUT,
    options: WaitForTaskOptions = {},
  ): Promise<TaskDetailResponse> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('timeoutMs must be a positive number');
    }

    const reference = normalizeTaskReference(task);
    if (!reference.tasktoken && !reference.taskid) {
      throw new Error('Either tasktoken or taskid is required');
    }

    const startedAt = Date.now();
    const deadline = Date.now() + timeoutMs;
    const maxConsecutiveErrors = options.maxConsecutiveErrors
      ?? DEFAULT_MAX_CONSECUTIVE_ERRORS;
    let consecutiveErrors = 0;
    let attempt = 0;
    let lastDetail: TaskDetailResponse | undefined;
    let lastError: unknown;

    while (Date.now() < deadline) {
      throwIfAborted(options.signal);
      const remainingMs = Math.max(1, deadline - Date.now());
      const pollSignal = createDeadlineSignal(options.signal, remainingMs);

      try {
        const detail = await this.getTask(reference, pollSignal.signal);
        lastDetail = detail;

        if (!detail.result) {
          const message = detail.errors?.map(error => error.message).join(', ')
            || 'Task status request failed';
          throw new Error(message);
        }

        const currentTask = detail.tasklist?.[0];
        if (!currentTask) {
          throw new Error('Task not found');
        }

        consecutiveErrors = 0;
        attempt += 1;
        await options.onPoll?.(currentTask, {
          attempt,
          elapsedMs: Date.now() - startedAt,
        });

        if ((TERMINAL_STATUSES as readonly string[]).includes(currentTask.status)) {
          return detail;
        }
      } catch (error) {
        if (options.signal?.aborted) {
          throw createAbortError();
        }
        if (pollSignal.didTimeout()) {
          lastError = error;
          break;
        }

        lastError = error;
        consecutiveErrors += 1;

        // No task matches in this workspace, so asking again cannot find one.
        if (isTaskNotFound(lastDetail)) {
          throw new TaskPollingError('Task not found in this workspace', lastDetail, error);
        }

        if (error instanceof WiroApiError
          && error.status >= 400
          && error.status < 500
          && error.status !== 408
          && error.status !== 429) {
          throw new TaskPollingError(
            `Task status request failed with HTTP ${error.status}`
              + (error.hint ? `. ${error.hint}` : ''),
            lastDetail,
            error,
          );
        }

        if (consecutiveErrors >= maxConsecutiveErrors) {
          throw new TaskPollingError(
            `Task status check failed ${consecutiveErrors} times in a row`,
            lastDetail,
            error,
          );
        }
      } finally {
        pollSignal.cleanup();
      }

      const remainingAfterPoll = deadline - Date.now();
      if (remainingAfterPoll <= 0) break;

      const interval = options.pollIntervalMs
        ?? getPollInterval(Date.now() - startedAt);
      await sleep(
        Math.min(interval, remainingAfterPoll),
        options.signal,
      );
    }

    throw new TaskWaitTimeoutError(timeoutMs, lastDetail, lastError);
  }
}

function normalizeTaskReference(task: string | TaskReference): TaskReference {
  return typeof task === 'string' ? { tasktoken: task } : task;
}

function getPollInterval(elapsedMs: number): number {
  if (elapsedMs < 15000) return FAST_POLL_INTERVAL;
  if (elapsedMs < 60000) return NORMAL_POLL_INTERVAL;
  return SLOW_POLL_INTERVAL;
}

function createAbortError(): Error {
  const error = new Error('Task wait aborted by client');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(createAbortError());
    };

    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function createDeadlineSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;

  const onParentAbort = (): void => controller.abort();
  if (parentSignal?.aborted) {
    controller.abort();
  } else {
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onParentAbort);
    },
  };
}
