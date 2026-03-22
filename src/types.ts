export interface WiroCredentials {
  apiKey: string;
  apiSecret?: string;
}

export interface SearchModelsParams {
  search?: string;
  categories?: string[];
  start?: number;
  limit?: number;
}

export interface RunModelResult {
  result: boolean;
  errors: Array<{ message: string }>;
  taskid: string;
  socketaccesstoken: string;
}

export interface TaskOutput {
  name: string;
  contenttype: string;
  size: string;
  url: string;
}

export interface Task {
  id: string;
  socketaccesstoken: string;
  parameters: Record<string, unknown>;
  status: string;
  pexit: string;
  debugoutput: string;
  starttime: string;
  endtime: string;
  elapsedseconds: string;
  totalcost: string;
  outputs: TaskOutput[];
  modeldescription?: string;
}

export interface TaskDetailResponse {
  result: boolean;
  errors: Array<{ message: string }>;
  total: string;
  tasklist: Task[];
}

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

export const TERMINAL_STATUSES = [
  'task_postprocess_end',
  'task_cancel',
] as const;
