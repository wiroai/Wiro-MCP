import type {
  Task,
  TaskSegment,
  TaskUsage,
  ToolListItem,
  ToolParameterItem,
  ToolParameterOption,
} from '../types.js';
import { isPlainObject } from './api.js';
import {
  isToolCallSegment,
  normalizeTaskRawContent,
} from './task-segments.js';

// The value Wiro accepts for an option, and a label to show next to it. Wiro
// checks an option's value, or its id when it has no value.
export function toParameterOption(option: ToolParameterOption): { label: string; value: string } {
  const value = String(option.value ?? option.id ?? '');
  const modelSlug = option.slugowner && option.slugproject ? `${option.slugowner}/${option.slugproject}` : undefined;
  return { label: String(option.label ?? option.text ?? option.name ?? modelSlug ?? value), value };
}

function usdAmount(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A successful task that Wiro has not billed yet. It reads as finished a moment
 * before its charge is recorded, so only the list price is known.
 */
export function awaitingCharge(task: Task): boolean {
  const list = usdAmount(task.totalcost);
  return task.status === 'task_postprocess_end' && task.pexit === '0'
    && usdAmount(task.chargedcost) === null && list !== null && list > 0;
}

/**
 * A cancelled task that no worker ever took, so it never ran and is never
 * charged. A row without accepttime is not counted as one.
 */
export function cancelledWhileQueued(task: Task): boolean {
  const accepted = task.accepttime;
  return task.status === 'task_cancel'
    && accepted !== undefined && accepted !== null && accepted !== ''
    && Number(accepted) === 0;
}

/**
 * A task's cost for the user: what Wiro charged once it billed the task, with
 * the list price beside it when a discount made them differ. Before Wiro bills
 * a successful task, the list price, marked as such. A cancelled task can still
 * be charged once work it had already started ends, so $0 there is only the
 * amount so far, unless it was cancelled while queued.
 */
export function formatTaskCost(task: Task): string | null {
  const list = usdAmount(task.totalcost);
  const charged = usdAmount(task.chargedcost);
  if (cancelledWhileQueued(task) && !(charged !== null && charged > 0)) {
    return '$0 (cancelled while queued, not charged)';
  }
  if (awaitingCharge(task)) return `$${list} list price; the charged amount is not recorded yet`;
  if (charged !== null) {
    if (charged === 0) return task.status === 'task_cancel' ? 'no charge recorded yet' : '$0 (not charged)';
    if (list !== null && list > 0 && Math.abs(list - charged) > 1e-9) {
      return `$${charged} charged (list price $${list})`;
    }
    return `$${charged}`;
  }
  return list !== null && list > 0 ? `$${list}` : null;
}

export function formatTaskResult(task: Task): string {
  const lines: string[] = [];
  const requireCompleteTurn = task.status === 'task_postprocess_end'
    || task.status === 'task_cancel';
  const rawProjections = (task.outputs ?? [])
    .filter(output => output.contenttype === 'raw' && output.content)
    .map(output => {
      const normalized = normalizeTaskRawContent(output.content, {
        requireCompleteTurn,
      });
      return {
        output,
        normalized,
        state: getTaskOutputProjectionState(normalized),
      };
    });
  const hasInvalidProjection = rawProjections.some(
    projection => projection.state === 'invalid',
  );
  const typedProjection = rawProjections.find(
    projection => projection.state === 'valid'
      && projection.normalized.hasSegments,
  ) ?? rawProjections.find(projection => projection.state === 'valid');
  const projectionStates = new Map(
    rawProjections.map(projection => [projection.output, projection.state]),
  );
  lines.push(`## Task Result`);
  lines.push('');
  lines.push(`**Status:** ${task.status}`);
  lines.push(`**Task ID:** ${task.id}`);
  if (task.socketaccesstoken) lines.push(`**Task Token:** ${task.socketaccesstoken}`);
  if (task.modelslugowner && task.modelslugproject) {
    lines.push(`**Model:** \`${task.modelslugowner}/${task.modelslugproject}\``);
  }

  if (task.status === 'task_cancel') {
    lines.push(`**Result:** Cancelled`);
  } else if (task.pexit === '0') {
    lines.push(`**Result:** Success`);
  } else if (task.pexit) {
    lines.push(`**Result:** Failed (exit code: ${task.pexit})`);
  }

  if (task.elapsedseconds) {
    lines.push(`**Duration:** ${task.elapsedseconds}s`);
  }

  const cost = formatTaskCost(task);
  if (cost) lines.push(`**Cost:** ${cost}`);

  if (hasInvalidProjection) {
    lines.push('');
    lines.push('### Response');
    lines.push('');
    lines.push('The structured model output could not be validated and was omitted.');
  } else if (typedProjection) {
    const { normalized } = typedProjection;
    lines.push('');
    lines.push('### Response');
    lines.push('');
    if (normalized.finishreason) {
      lines.push(`**Finish reason:** \`${normalized.finishreason}\``);
    }
    if (normalized.usage) appendTaskUsage(lines, normalized.usage);
    if (normalized.finishreason
      || normalized.usage) lines.push('');
    appendTaskSegments(lines, normalized.segments);
  } else if (task.debugoutput) {
    lines.push('');
    lines.push('### Response');
    lines.push('');
    lines.push(task.debugoutput);
  }

  if (task.debugerror) {
    lines.push('');
    lines.push('### Error');
    lines.push('');
    lines.push(task.debugerror);
  }

  const displayOutputs = (task.outputs ?? []).filter(output => {
    const projectionState = projectionStates.get(output);
    return projectionState === undefined || projectionState === 'none';
  });
  if (displayOutputs.length > 0) {
    lines.push('');
    lines.push('### Outputs');
    lines.push('');
    for (const output of displayOutputs) {
      if (output.contenttype === 'raw' && output.content) {
        const thinking = asStringArray(output.content.thinking);
        const answers = asStringArray(output.content.answer);
        if (thinking.length > 0) {
          lines.push('**Thinking:**');
          for (const t of thinking) {
            lines.push(t);
          }
          lines.push('');
        }
        if (answers.length > 0) {
          lines.push('**Answer:**');
          for (const a of answers) {
            lines.push(a);
          }
        } else if (typeof output.content.raw === 'string'
          && output.content.raw) {
          lines.push(output.content.raw);
        }
      } else if (output.url) {
        const name = escapeMarkdownLabel(output.name || 'Output');
        const contentType = output.contenttype || 'application/octet-stream';
        const metadata = `${contentType}, ${formatSize(output.size ?? '0')}`;
        if (contentType.startsWith('image/')) {
          lines.push(`**${name}** (${metadata})`);
          lines.push(`![${escapeMarkdownAlt(output.name || 'Generated image')}](${output.url})`);
          lines.push(`[Open image](${output.url})`);
        } else {
          lines.push(`- [${name}](${output.url}) (${metadata})`);
        }
      }
    }
  }

  return lines.join('\n');
}

type TaskOutputProjectionState = 'none' | 'valid' | 'invalid';

function getTaskOutputProjectionState(
  normalized: ReturnType<typeof normalizeTaskRawContent>,
): TaskOutputProjectionState {
  if (normalized.malformed) return 'invalid';
  return normalized.hasSegments
    || normalized.finishreason !== undefined
    || normalized.usage !== undefined
    ? 'valid'
    : 'none';
}

function appendTaskUsage(lines: string[], usage: TaskUsage): void {
  lines.push(
    `**Token usage:** ${usage.input_tokens} input, `
      + `${usage.output_tokens} output, ${usage.total_tokens} total`,
  );
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function appendTaskSegments(lines: string[], segments: TaskSegment[]): void {
  for (const segment of segments) {
    if (!isToolCallSegment(segment)) {
      lines.push(segment.type === 'thinking' ? '**Thinking:**' : '**Answer:**');
      lines.push(segment.text);
      lines.push('');
      continue;
    }

    const label = segment.type === 'function_call'
      ? 'Function call'
      : 'Custom tool call';
    lines.push(`**${label}:** \`${segment.name}\``);
    lines.push(`- **Status:** \`${segment.status}\``);
    lines.push(`- **Item ID:** \`${segment.id}\``);
    lines.push(`- **Call ID:** \`${segment.call_id}\``);
    lines.push(
      segment.type === 'function_call'
        ? '- **Arguments:**'
        : '- **Input:**',
    );
    appendCodeBlock(
      lines,
      segment.type === 'function_call' ? segment.arguments : segment.input,
      segment.type === 'function_call' ? 'json' : 'text',
    );
    lines.push('');
  }
}

function appendCodeBlock(
  lines: string[],
  value: string,
  language: 'json' | 'text',
): void {
  let fence = '```';
  while (value.includes(fence)) fence += '`';
  lines.push(`${fence}${language}`, value, fence);
}

export function formatTaskSubmitted(taskid: string, tasktoken: string): string {
  return `## Task Submitted\n\n`
    + `**Task ID:** ${taskid}\n`
    + `**Task Token:** ${tasktoken}\n\n`
    + 'Use `wait_for_task` with this token to wait for the result. '
    + 'Do not submit the model again for the same request.';
}

// What get_task, wait_for_task and get_task_price say when Wiro finds no task
// with that ID or token in the key's workspace.
export const TASK_NOT_FOUND = 'Task not found in this workspace. '
  + 'Check the task ID or token, or find the task with list_tasks.';

// What they say when `taskid` is not a number, such as a task token passed as
// the ID: no task can have that ID, so Wiro is not asked.
export const TASK_ID_NOT_NUMERIC = '`taskid` is the numeric Task ID that run_model and list_tasks show. '
  + 'Pass a Task Token as `tasktoken` instead.';

export function formatTaskPending(params: {
  taskid?: string;
  tasktoken?: string;
  status?: string;
  timeoutSeconds?: number;
  reason?: string;
}): string {
  const lines = ['## Task Still Running', ''];
  if (params.taskid) lines.push(`**Task ID:** ${params.taskid}`);
  if (params.tasktoken) lines.push(`**Task Token:** ${params.tasktoken}`);
  if (params.status) lines.push(`**Last Status:** ${params.status}`);
  if (params.timeoutSeconds) {
    lines.push(`**Waited:** ${params.timeoutSeconds}s`);
  }
  if (params.reason) {
    lines.push('');
    lines.push(params.reason);
  }
  lines.push('');
  lines.push('The task is still active and may still be billed when it completes.');
  lines.push('Call `wait_for_task` with the same task token or task ID now. Do not call `run_model` again.');
  return lines.join('\n');
}

export function formatTaskList(
  tasks: Task[],
  total: number,
  start = 0,
): string {
  if (tasks.length === 0) {
    return '## Task History\n\nNo model generation tasks found.';
  }

  const lines = [
    `## Task History (${total} total)`,
    '',
    `Showing ${start + 1}-${start + tasks.length}.`,
    '',
  ];

  for (const task of tasks) {
    const model = task.modelslugowner && task.modelslugproject
      ? `${task.modelslugowner}/${task.modelslugproject}`
      : 'unknown model';
    lines.push(`### Task ${task.id}`);
    lines.push(`- **Model:** \`${model}\``);
    lines.push(`- **Status:** ${task.status}`);
    if (task.starttime) lines.push(`- **Started:** ${task.starttime}`);
    if (task.elapsedseconds) lines.push(`- **Duration:** ${task.elapsedseconds}s`);
    const cost = formatTaskCost(task);
    if (cost) lines.push(`- **Cost:** ${cost}`);

    const outputLinks = (task.outputs ?? [])
      .filter(output => output.url)
      .slice(0, 3);
    for (const output of outputLinks) {
      lines.push(`- **Output:** [${escapeMarkdownLabel(output.name || 'Open result')}](${output.url})`);
    }
    lines.push(`- **Details:** call \`get_task\` with \`taskid: "${task.id}"\``);
    lines.push('');
  }

  return lines.join('\n');
}

/** A number from Tool/Detail's text fields, where "" means none. */
function rangeNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// A checkbox's catalog value means on or off. true, 1, yes, on and any other
// non-empty text are on (some models keep a command-line flag such as
// "--do_sample" there); "", false, 0, no, off, null and undefined are off.
const CHECKBOX_OFF_VALUES = new Set(['', 'false', '0', 'no', 'off', 'null', 'undefined']);

function checkboxIsOn(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return false;
  return !CHECKBOX_OFF_VALUES.has(value.trim().toLowerCase());
}

/**
 * The catalog value of a parameter: a checkbox's state as "true" or "false"
 * (from Tool/Detail's `value`, else `defaultvalue`), otherwise `defaultvalue`,
 * then `value`. Arrays are JSON text; empty means none.
 */
export function parameterDefault(item: ToolParameterItem): string | undefined {
  if (item.type === 'checkbox') {
    const initial = Object.prototype.hasOwnProperty.call(item, 'value') ? item.value : item.defaultvalue;
    return checkboxIsOn(initial) ? 'true' : 'false';
  }
  const raw = item.defaultvalue ?? item.value ?? item.default;
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (Array.isArray(raw)) return raw.length > 0 ? JSON.stringify(raw) : undefined;
  return typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
}

// A run fills an optional parameter left out of its request with the catalog
// value, except these, whose catalog value is a sample shown on the model's page:
// file inputs, ids containing "input", the prompt and the structured LLM fields.
// A run refuses a required parameter that is left out before it fills anything.
// A workflow step that leaves out any of them gets the catalog value. Two ids
// follow their own rule: a run picks a random seed when `seed` is left out or 0,
// and `parallel_tool_calls` is true whenever `tools` are sent.
const SAMPLE_TYPES = new Set(['fileinput', 'multifileinput', 'multifileinputdrop', 'combinefileinput', 'fileexplorer']);
const SAMPLE_IDS = new Set(['prompt', 'messages', 'tools', 'tool_choice', 'previousTaskToken', 'toolOutputs', 'response_format']);

export function isSampleParameter(item: ToolParameterItem): boolean {
  const id = String(item.id);
  return SAMPLE_TYPES.has(String(item.type)) || id.includes('input') || SAMPLE_IDS.has(id);
}

/** What a left-out parameter gets: `default` in a run, `sample` only in a workflow step. */
export function parameterFallback(item: ToolParameterItem): { default?: string; sample?: string } {
  const id = String(item.id);
  if (id === 'parallel_tool_calls') return { default: 'true' };
  const value = parameterDefault(item);
  if (value === undefined) return {};
  if (id === 'seed') return Number(value) === 0 ? {} : { sample: value };
  const required = item.required === true || String(item.required) === 'true';
  return !required && !isSampleParameter(item) ? { default: value } : { sample: value };
}

/** How the parameter list shows what a left-out parameter gets. */
export function parameterFallbackText(item: ToolParameterItem): string {
  const id = String(item.id);
  const { default: value, sample } = parameterFallback(item);
  const shown = (text: string) => (text.length > 120 ? `${text.slice(0, 120)}...` : text);
  if (id === 'parallel_tool_calls') return ' (default: `true` when `tools` are sent)';
  if (id === 'seed') {
    return ` (a run picks a random seed when it is left out or 0${sample !== undefined
      ? `; a workflow step that leaves it out gets \`${shown(sample)}\``
      : ''})`;
  }
  if (value !== undefined) return ` (default: \`${shown(value)}\`)`;
  if (sample === undefined) return '';
  return /\/sampleinputs\//.test(sample)
    ? ' (sample files on the model\'s page, used only by a workflow step that leaves it out)'
    : ` (sample: \`${shown(sample)}\`, used only by a workflow step that leaves it out)`;
}

// Only number and float parameters get a range, as in the run form, which
// draws a slider only for those. Bounds on other types, such as 0 to 0 on a
// text or select field, are not limits, so they get none.
const RANGE_TYPES = new Set(['number', 'float', 'range']);

export function parameterRange(item: ToolParameterItem): { min?: number; max?: number; step?: number } {
  if (!RANGE_TYPES.has(String(item.type))) return {};
  return {
    min: rangeNumber(item.minvalue) ?? rangeNumber(item.min),
    max: rangeNumber(item.maxvalue) ?? rangeNumber(item.max),
    step: rangeNumber(item.incrementby) ?? rangeNumber(item.step),
  };
}

export function formatModelList(models: ToolListItem[], header?: string): string {
  if (models.length === 0) return 'No models found.';

  const lines: string[] = [];
  lines.push(header ?? `## Models (${models.length} results)`);
  lines.push('');

  for (const model of models) {
    const slug = `${model.cleanslugowner}/${model.cleanslugproject}`;
    const cats = model.categories?.filter(c => c !== 'tool').join(', ') || '';
    lines.push(`### ${model.title || slug}`);
    lines.push(`- **Model:** \`${slug}\``);
    if (cats) lines.push(`- **Categories:** ${cats}`);
    if (model.seodescription) lines.push(`- **Description:** ${model.seodescription}`);
    const pricing = formatPricing(model);
    if (pricing) lines.push(`- **Pricing:** ${pricing}`);
    lines.push('');
  }

  return lines.join('\n');
}

export function formatModelSchema(model: ToolListItem): string {
  const lines: string[] = [];
  const slug = `${model.cleanslugowner}/${model.cleanslugproject}`;

  lines.push(`## ${model.title || slug}`);
  lines.push(`**Model:** \`${slug}\``);
  if (model.seodescription) lines.push(`**Description:** ${model.seodescription}`);
  const cats = model.categories?.filter(c => c !== 'tool').join(', ') || '';
  if (cats) lines.push(`**Categories:** ${cats}`);
  lines.push('');

  const pricingSection = formatPricingDetailed(model);
  if (pricingSection) {
    lines.push(pricingSection);
    lines.push('');
  }

  if (model.parameters && model.parameters.length > 0) {
    lines.push('### Parameters');
    lines.push('');

    for (const group of model.parameters) {
      if (group.title) {
        lines.push(`#### ${group.title}`);
        lines.push('');
      }

      for (const param of group.items) {
        const required = param.required ? ' **(required)**' : '';
        const defaultVal = parameterFallbackText(param);
        lines.push(`- **\`${param.id}\`** (${param.type})${required}${defaultVal}`);
        if (param.label) lines.push(`  ${param.label}`);
        if (param.description && param.description !== param.label) lines.push(`  ${param.description}`);
        if (param.placeholder) lines.push(`  Example: \`${param.placeholder}\``);
        if (param.note) lines.push(`  ${param.note}`);
        if (param.type === 'fileinput') lines.push(`  Pass a URL directly (e.g. \`${param.id}: "https://..."\`) or use \`${param.id}Url\` for the URL field.`);
        if (param.type === 'multifileinput') lines.push(`  Pass the URLs comma-separated in \`${param.id.replace('Multiple', '')}UrlMultiple\`.`);
        if (param.type === 'combinefileinput') lines.push(`  Pass an array of URLs directly: \`${param.id}: ["https://...", "https://..."]\`. No upload needed.`);
        if (param.type === 'json' || param.type === 'json-array') lines.push(`  Pass this as a structured JSON value inside the ordinary \`params\` object.`);

        if (param.options?.length) {
          const optionValues = param.options
            .map(toParameterOption)
            .map(o => (o.label === o.value ? `\`${o.value}\`` : `\`${o.value}\` (${o.label})`))
            .join(', ');
          lines.push(`  Options: ${optionValues}`);
        }

        const range = parameterRange(param);
        if (range.min !== undefined || range.max !== undefined) {
          lines.push(`  Range: ${range.min ?? 'no minimum'} to ${range.max ?? 'no maximum'}${range.step ? `, step ${range.step}` : ''}`);
        }
      }
      lines.push('');
    }
  }

  lines.push('### Usage');
  lines.push('');
  lines.push('Use `run_model` with this model:');
  lines.push('```json');
  lines.push(`{ "model": "${slug}", "params": { ... } }`);
  lines.push('```');

  return lines.join('\n');
}

const PRICE_METHOD_LABELS: Record<string, string> = {
  cpr: 'per request',
  cps: 'per second',
  cpo: 'per output',
  cpt: 'per token',
  'cp-pixel': 'per megapixel',
  'cp-audiosecondslength': 'per audio second',
  'cp-promptlength': 'per character',
  'cp-outputVideoLength': 'per video second',
  'cp-realtimeturn': 'per turn',
  'cp-readoutput': 'usage-based',
};

/** One option of a model's `dynamicprice` list. */
interface DynamicPriceRow {
  price: number;
  priceMethod: string;
  // A value is a string, such as 'QUANTITY:1', or a number, such as a duration of 10.
  inputs?: Record<string, unknown>;
  note?: string;
  priceExtra?: number;
  priceInput?: number;
}

function parseDynamicPrice(dynamicprice?: string): DynamicPriceRow[] | null {
  if (!dynamicprice) return null;
  try {
    const parsed: DynamicPriceRow[] = typeof dynamicprice === 'string' ? JSON.parse(dynamicprice) : dynamicprice;
    return Array.isArray(parsed) && parsed.length > 0 && parsed.every(row => isPlainObject(row)) ? parsed : null;
  } catch {
    return null;
  }
}

/** A price row's note on one line, or undefined when it has none. */
function priceNote(row: DynamicPriceRow): string | undefined {
  const note = typeof row.note === 'string' ? row.note.replace(/\s+/g, ' ').trim() : '';
  return note || undefined;
}

// A cp-readoutput run sets its own price when it completes, from what it used,
// such as tokens, and the row's note gives the rates. A price-0 row with a note
// has its price in the note too.
function usageBilledRow(row: DynamicPriceRow): boolean {
  return row.priceMethod === 'cp-readoutput'
    || (Number(row.price) === 0 && priceNote(row) !== undefined);
}

/** Whether a price of the model is set from usage, so it has no estimate before a run. */
export function isUsageBilled(model: ToolListItem): boolean {
  return parseDynamicPrice(model.dynamicprice)?.some(usageBilledRow) ?? false;
}

function usagePrice(row: DynamicPriceRow, detailed = false): string {
  const note = priceNote(row);
  if (row.priceMethod !== 'cp-readoutput') return note ?? '';
  const listed = Number(row.price) > 0 ? formatPrice(row.price) : undefined;
  if (detailed) {
    return [listed && `About $${listed}.`, note, 'The price is set from usage when the run completes.']
      .filter(Boolean)
      .join(' ');
  }
  return `usage-based${listed ? `, about $${listed}` : ''}: ${note ?? 'the price is set from usage when the run completes'}`;
}

/** "$a", or "$a to $b" from the lowest amount to the highest; undefined when there is none. */
function amountRange(amounts: number[]): string | undefined {
  if (amounts.length === 0) return undefined;
  const low = Math.min(...amounts);
  const high = Math.max(...amounts);
  return low === high ? `$${formatPrice(low)}` : `$${formatPrice(low)} to $${formatPrice(high)}`;
}

/** The rows' amounts in an extra price field, counting only those above 0. */
function extraAmounts(rows: DynamicPriceRow[], field: 'priceExtra' | 'priceInput'): number[] {
  return rows
    .map(row => usdAmount(row[field]))
    .filter((amount): amount is number => amount !== null && amount > 0);
}

// cp-pixel bills the output by the megapixel: `price` for the first one and
// `priceExtra` for each one after it. Each input image adds `priceInput` per
// megapixel, up to 4 per image.
function pixelPrice(rows: DynamicPriceRow[], detailed = false): string {
  const parts = [`${amountRange(rows.map(row => row.price))} for the first megapixel of output`];
  const extra = amountRange(extraAmounts(rows, 'priceExtra'));
  const input = amountRange(extraAmounts(rows, 'priceInput'));
  if (extra) parts.push(`+${extra} per extra megapixel`);
  if (input) {
    parts.push(detailed
      ? `+${input} per megapixel of each input image, up to 4 per image`
      : `+${input} per input image megapixel`);
  }
  return parts.join(', ');
}

const PIXEL_TIERS = 'A megapixel is 1024x1024 pixels, and a started one counts in full: a 2048x2048 image is 4.';

/** One row's price in the schema; a plain price names its unit unless the table header does. */
function rowPriceDetailed(row: DynamicPriceRow, withUnit: boolean): string {
  if (usageBilledRow(row)) return usagePrice(row, true);
  if (row.priceMethod === 'cp-pixel') return pixelPrice([row], true);
  const price = `$${formatPrice(row.price)}`;
  return withUnit ? `${price} / ${PRICE_METHOD_LABELS[row.priceMethod] ?? row.priceMethod}` : price;
}

function formatPricingDetailed(model: ToolListItem): string | null {
  const dynamicResult = formatDynamicPriceDetailed(model.dynamicprice);
  if (dynamicResult) return dynamicResult;

  const cps = parseFloat(model.cps ?? '0');
  const approx = parseFloat(model.approximatelycost ?? '0');
  if (approx > 0 || cps > 0) {
    const lines: string[] = ['### Pricing'];
    if (cps > 0) lines.push(`- **Rate:** $${formatPrice(cps)} per second`);
    if (approx > 0) lines.push(`- **Estimated cost:** ~$${formatPrice(approx)} per run`);
    return lines.join('\n');
  }
  return null;
}

function formatDynamicPriceDetailed(dynamicprice?: string): string | null {
  const parsed = parseDynamicPrice(dynamicprice);
  if (!parsed) return null;
  try {
    const method = parsed[0].priceMethod;
    const methodLabel = PRICE_METHOD_LABELS[method] ?? method;
    const lines: string[] = [`### Pricing (${methodLabel})`];

    const inputKeys = new Set<string>();
    for (const p of parsed) {
      if (p.inputs) {
        for (const k of Object.keys(p.inputs)) inputKeys.add(k);
      }
    }
    const keys = [...inputKeys];

    if (parsed.length === 1 && keys.length === 0) {
      lines.push(rowPriceDetailed(parsed[0], true));
    } else if (keys.length > 0) {
      // A run uses the row with the highest QUANTITY at or below the number of
      // items it sends, so an input's highest QUANTITY row covers any more.
      const topQuantity = new Map<string, number>();
      for (const p of parsed) {
        for (const [k, raw] of Object.entries(p.inputs ?? {})) {
          const v = String(raw);
          if (v.startsWith('QUANTITY:')) topQuantity.set(k, Math.max(topQuantity.get(k) ?? 0, Number(v.split(':')[1])));
        }
      }
      lines.push(`| ${keys.join(' | ')} | Price |`);
      lines.push(`| ${keys.map(() => '---').join(' | ')} | --- |`);
      for (const p of parsed) {
        const values = keys.map(k => {
          const v = String(p.inputs?.[k] ?? '-');
          if (!v.startsWith('QUANTITY:')) return v;
          const count = v.split(':')[1];
          return Number(count) > 0 && Number(count) === topQuantity.get(k) ? `qty: ${count} or more` : `qty: ${count}`;
        });
        lines.push(`| ${values.join(' | ')} | ${rowPriceDetailed(p, false)} |`);
      }
    } else {
      for (const p of parsed) {
        lines.push(`- ${rowPriceDetailed(p, true)}`);
      }
    }

    if (parsed.some(p => p.priceMethod === 'cp-pixel')) lines.push('', PIXEL_TIERS);
    return lines.join('\n');
  } catch {
    return null;
  }
}

/** The model's price on one line; `detailed` adds the rules a schema quote needs, such as how megapixels count. */
export function formatPricing(model: ToolListItem, detailed = false): string | null {
  const dynamicResult = formatDynamicPrice(model.dynamicprice, detailed);
  if (dynamicResult) return dynamicResult;

  const cps = parseFloat(model.cps ?? '0');
  const approx = parseFloat(model.approximatelycost ?? '0');
  if (approx > 0) {
    return `~$${formatPrice(approx)} per run (estimated)`;
  }
  if (cps > 0) {
    return `$${formatPrice(cps)} per second`;
  }
  return null;
}

function formatDynamicPrice(dynamicprice?: string, detailed = false): string | null {
  const parsed = parseDynamicPrice(dynamicprice);
  if (!parsed) return null;
  try {
    const usage = [...new Set(parsed.filter(usageBilledRow).map(p => usagePrice(p)))];
    const priced = parsed.filter(p => !usageBilledRow(p));
    if (priced.length === 0) return usage.join('; ');
    if (priced.every(p => p.priceMethod === 'cp-pixel')) {
      const pixel = [pixelPrice(priced, detailed), ...usage].join('; ');
      return detailed ? `${pixel}. ${PIXEL_TIERS}` : pixel;
    }

    const uniquePrices = new Map<string, { price: number; label: string }>();
    for (const p of priced) {
      const label = PRICE_METHOD_LABELS[p.priceMethod] ?? p.priceMethod;
      const key = `${p.price}-${label}`;
      if (!uniquePrices.has(key)) {
        uniquePrices.set(key, { price: p.price, label });
      }
    }

    const entries = [...uniquePrices.values()].sort((a, b) => a.price - b.price);
    const min = entries[0];
    const max = entries[entries.length - 1];
    const range = entries.length === 1
      ? `$${formatPrice(min.price)} / ${min.label}`
      : `$${formatPrice(min.price)} to $${formatPrice(max.price)} / ${min.label}`;
    return [range, ...usage].join('; ');
  } catch {
    return null;
  }
}

function formatPrice(price: number): string {
  return parseFloat(price.toFixed(6)).toString();
}

export function formatSize(sizeStr: string): string {
  const bytes = parseInt(sizeStr, 10);
  if (isNaN(bytes)) return sizeStr;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\\[\]])/g, '\\$1');
}

function escapeMarkdownAlt(value: string): string {
  return value.replace(/([\\[\]])/g, '\\$1');
}
