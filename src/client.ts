import crypto from 'node:crypto';
import net from 'node:net';
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
export type { Task, TaskOutput, TaskOutputRawContent, ToolListItem, ToolParameterGroup, ToolParameterItem } from './types.js';

const DEFAULT_BASE_URL = 'https://api.wiro.ai/v1';
const DEFAULT_TIMEOUT = 120000;
const FAST_POLL_INTERVAL = 2000;
const NORMAL_POLL_INTERVAL = 5000;
const SLOW_POLL_INTERVAL = 10000;
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 5;

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

export interface TrustedProxyContext {
  clientIp: string;
  sharedSecret: string;
}

export interface WiroClientOptions {
  trustedProxy?: TrustedProxyContext;
}

export class WiroApiError extends Error {
  readonly status: number;
  readonly responseBody: string;

  constructor(status: number, responseBody: string) {
    super(`Wiro API error ${status}: ${responseBody}`);
    this.name = 'WiroApiError';
    this.status = status;
    this.responseBody = responseBody;
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

export class WiroClient {
  private readonly apiKey: string;
  private readonly apiSecret?: string;
  private readonly baseUrl: string;
  private readonly trustedProxy?: TrustedProxyContext;
  public readonly authType: 'signature' | 'apikey-only';

  constructor(
    apiKey: string,
    apiSecret?: string,
    baseUrl?: string,
    options: WiroClientOptions = {},
  ) {
    if (!apiKey) throw new Error('WIRO_API_KEY is required');
    if (options.trustedProxy) {
      if (net.isIP(options.trustedProxy.clientIp) === 0) {
        throw new Error('trustedProxy.clientIp must be a valid IPv4 or IPv6 address');
      }
      if (options.trustedProxy.sharedSecret.length < 32) {
        throw new Error('trustedProxy.sharedSecret must be at least 32 characters');
      }
    }
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = baseUrl ?? DEFAULT_BASE_URL;
    this.trustedProxy = options.trustedProxy;
    this.authType = apiSecret ? 'signature' : 'apikey-only';
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

    if (this.trustedProxy) {
      const timestamp = Date.now().toString();
      const payload = [
        timestamp,
        this.trustedProxy.clientIp,
        this.apiKey,
        pathname,
      ].join('\n');
      headers['x-wiro-proxy-client-ip'] = this.trustedProxy.clientIp;
      headers['x-wiro-proxy-timestamp'] = timestamp;
      headers['x-wiro-proxy-signature'] = crypto
        .createHmac('sha256', this.trustedProxy.sharedSecret)
        .update(payload)
        .digest('hex');
    }

    return headers;
  }

  private async request<T>(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = this.getAuthHeaders(new URL(url).pathname);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });

    const text = await response.text();

    if (!response.ok) {
      throw new WiroApiError(response.status, text);
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Invalid JSON response: ${text}`);
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
    return this.request<ToolListResponse>('/Tool/List', body);
  }

  async explore(): Promise<ExploreResponse> {
    return this.request<ExploreResponse>('/Tool/Explore', {});
  }

  async getModelSchema(model: string): Promise<ToolDetailResponse> {
    const [cleanslugowner, ...rest] = model.split('/');
    const cleanslugproject = rest.join('/');
    if (!cleanslugowner || !cleanslugproject) {
      throw new Error('Model must be in "owner/model" format, e.g. "openai/sora-2"');
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
  ): Promise<RunModelResult> {
    const [cleanslugowner, ...rest] = model.split('/');
    const cleanslugproject = rest.join('/');
    if (!cleanslugowner || !cleanslugproject) {
      throw new Error('Model must be in "owner/model" format, e.g. "openai/sora-2"');
    }
    return this.request<RunModelResult>(
      `/Run/${cleanslugowner}/${cleanslugproject}`,
      params,
      signal,
    );
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
    const fileResponse = await fetch(fileUrl);
    if (!fileResponse.ok) {
      throw new Error(`Failed to download file from ${fileUrl}: ${fileResponse.status}`);
    }

    const blob = await fileResponse.blob();
    const resolvedName = fileName
      ?? fileUrl.split('/').pop()?.split('?')[0]
      ?? 'upload';

    const formData = new FormData();
    formData.append('file', blob, resolvedName);

    const url = `${this.baseUrl}/File/Upload`;
    const headers = this.getAuthHeaders(new URL(url).pathname);
    delete headers['Content-Type'];

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: formData,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Wiro API error ${response.status}: ${text}`);
    }

    try {
      return JSON.parse(text) as FileUploadResponse;
    } catch {
      throw new Error(`Invalid JSON response: ${text}`);
    }
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

        if (error instanceof WiroApiError
          && error.status >= 400
          && error.status < 500
          && error.status !== 408
          && error.status !== 429) {
          throw new TaskPollingError(
            `Task status request failed with HTTP ${error.status}`,
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
