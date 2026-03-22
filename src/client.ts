import crypto from 'node:crypto';
import type {
  SearchModelsParams,
  RunModelResult,
  TaskDetailResponse,
  ToolListResponse,
  ToolDetailResponse,
  ExploreResponse,
  FileUploadResponse,
} from './types.js';
import { TERMINAL_STATUSES } from './types.js';

const DEFAULT_BASE_URL = 'https://api.wiro.ai/v1';
const DEFAULT_POLL_INTERVAL = 3000;
const DEFAULT_TIMEOUT = 120000;

export class WiroClient {
  private readonly apiKey: string;
  private readonly apiSecret?: string;
  private readonly baseUrl: string;
  public readonly authType: 'signature' | 'apikey-only';

  constructor(apiKey: string, apiSecret?: string, baseUrl?: string) {
    if (!apiKey) throw new Error('WIRO_API_KEY is required');
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = baseUrl ?? DEFAULT_BASE_URL;
    this.authType = apiSecret ? 'signature' : 'apikey-only';
  }

  private getAuthHeaders(): Record<string, string> {
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

    return headers;
  }

  private async request<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = this.getAuthHeaders();

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(`Wiro API error ${response.status}: ${text}`);
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

  async runModel(model: string, params: Record<string, unknown>): Promise<RunModelResult> {
    const [cleanslugowner, ...rest] = model.split('/');
    const cleanslugproject = rest.join('/');
    if (!cleanslugowner || !cleanslugproject) {
      throw new Error('Model must be in "owner/model" format, e.g. "openai/sora-2"');
    }
    return this.request<RunModelResult>(`/Run/${cleanslugowner}/${cleanslugproject}`, params);
  }

  async getTask(opts: { tasktoken?: string; taskid?: string }): Promise<TaskDetailResponse> {
    if (!opts.tasktoken && !opts.taskid) {
      throw new Error('Either tasktoken or taskid is required');
    }
    const body: Record<string, unknown> = {};
    if (opts.tasktoken) body.tasktoken = opts.tasktoken;
    if (opts.taskid) body.taskid = opts.taskid;
    return this.request<TaskDetailResponse>('/Task/Detail', body);
  }

  async cancelTask(tasktoken: string): Promise<Record<string, unknown>> {
    return this.request('/Task/Cancel', { tasktoken });
  }

  async killTask(tasktoken: string): Promise<Record<string, unknown>> {
    return this.request('/Task/Kill', { tasktoken });
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
    const headers = this.getAuthHeaders();
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

  async waitForTask(tasktoken: string, timeoutMs = DEFAULT_TIMEOUT): Promise<TaskDetailResponse> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const detail = await this.getTask({ tasktoken });
      const task = detail.tasklist?.[0];

      if (task) {
        if ((TERMINAL_STATUSES as readonly string[]).includes(task.status)) {
          return detail;
        }
      }

      await new Promise(resolve => setTimeout(resolve, DEFAULT_POLL_INTERVAL));
    }

    throw new Error(`Task timed out after ${timeoutMs / 1000} seconds`);
  }
}
