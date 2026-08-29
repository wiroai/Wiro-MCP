export interface WiroCredentials {
  apiKey: string;
  apiSecret?: string;
}

export interface SearchModelsParams {
  search?: string;
  categories?: string[];
  slugowner?: string;
  start?: number;
  limit?: number;
  sort?: string;
  order?: string;
}

export interface ListTasksParams {
  start?: number;
  limit?: number;
  model?: string;
}

export interface RunModelResult {
  result: boolean;
  errors: Array<{ message: string }>;
  taskid: string;
  socketaccesstoken: string;
}

export type TaskFinishReason =
  | 'stop'
  | 'tool_calls'
  | 'length'
  | 'content_filter'
  | 'error';

export type TaskToolCallStatus =
  | 'in_progress'
  | 'completed'
  | 'incomplete';

export interface TaskTextSegment {
  type: 'thinking' | 'answer';
  text: string;
}

export interface TaskFunctionCallSegment {
  type: 'function_call';
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status: TaskToolCallStatus;
}

export interface TaskCustomToolCallSegment {
  type: 'custom_tool_call';
  id: string;
  call_id: string;
  name: string;
  input: string;
  status: TaskToolCallStatus;
}

export type TaskToolCallSegment =
  | TaskFunctionCallSegment
  | TaskCustomToolCallSegment;

export type TaskSegment =
  | TaskTextSegment
  | TaskToolCallSegment;

export interface TaskUsage {
  input_tokens: number;
  input_tokens_details?: Record<string, number>;
  output_tokens: number;
  output_tokens_details?: Record<string, number>;
  total_tokens: number;
  server_tool_use?: Record<string, number>;
}

export interface TaskOutputRawContent {
  prompt?: string;
  raw?: string;
  thinking?: string[] | null;
  answer?: string[] | null;
  segments?: TaskSegment[] | null;
  finishreason?: TaskFinishReason | null;
  usage?: TaskUsage | null;
}

export interface TaskOutput {
  name?: string;
  contenttype: string;
  size?: string;
  url?: string;
  content?: TaskOutputRawContent;
}

export interface Task {
  id: string;
  socketaccesstoken: string;
  parameters: Record<string, unknown>;
  status: string;
  pexit: string;
  debugoutput: string;
  debugerror?: string;
  starttime: string;
  endtime: string;
  elapsedseconds: string;
  totalcost: string;
  outputs: TaskOutput[];
  modeldescription?: string;
  modelslugowner?: string;
  modelslugproject?: string;
}

export interface TaskDetailResponse {
  result: boolean;
  errors: Array<{ message: string }>;
  total: string;
  tasklist: Task[];
}

export type TaskListResponse = TaskDetailResponse;

export interface ToolParameterItem {
  id: string;
  type: string;
  label: string;
  description?: string;
  default?: string;
  required?: boolean;
  placeholder?: string;
  note?: string;
  options?: Array<{ label: string; value: string }>;
  min?: number;
  max?: number;
  step?: number;
  advanced?: boolean;
  jsonschema?: Record<string, unknown> | string | null;
}

export interface ToolParameterGroup {
  title: string;
  items: ToolParameterItem[];
}

export interface ToolListItem {
  id: string;
  title: string;
  slugowner: string;
  slugproject: string;
  cleanslugowner: string;
  cleanslugproject: string;
  description: string;
  seodescription: string;
  categories: string[];
  image: string;
  computingtime?: string;
  parameters: ToolParameterGroup[] | null;
  readme?: string;
  samples?: string[];
  tags?: string[];
  marketplace?: number;
  dynamicprice?: string;
  cps?: string;
  approximatelycost?: string;
  seotitle?: string;
  taskstat?: {
    runcount: number;
    successcount: string;
    errorcount: string;
    lastruntime: string;
  };
}

export interface ToolListResponse {
  result: boolean;
  errors: Array<{ message: string }>;
  total: number | string;
  tool: ToolListItem[];
}

export interface ToolDetailResponse {
  result: boolean;
  errors: Array<{ message: string }>;
  tool: ToolListItem[];
}

export interface ExploreItem {
  id: string;
  cleanslugowner: string;
  cleanslugproject: string;
  image: string;
  description: string;
  categories: string[];
  commentcount: string;
  ratedusercount: string;
  averagepoint: string;
  discount?: number | string | null;
}

export interface ExploreCategory {
  id: string;
  title: string;
  tools: ExploreItem[];
  url?: string;
  total?: number;
}

export interface ExploreResponse {
  result: boolean;
  errors: Array<{ message: string }>;
  explore: ExploreCategory[];
}

export interface FileUploadItem {
  id: string;
  name: string;
  contenttype: string;
  size: string;
  url: string;
}

export interface FileUploadResponse {
  result: boolean;
  errors: Array<{ code: number; message: string }>;
  list: FileUploadItem[];
}

export const TERMINAL_STATUSES = [
  'task_postprocess_end',
  'task_cancel',
] as const;
