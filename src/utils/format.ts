import type {
  Task,
  TaskSegment,
  TaskUsage,
  ToolListItem,
  ToolParameterGroup,
  ToolParameterItem,
  ToolParameterOption,
} from '../types.js';
import { isPlainObject } from './api.js';
import {
  isToolCallSegment,
  normalizeTaskRawContent,
} from './task-segments.js';
import {
  MODEL_ANSWER_LABEL,
  MODEL_THINKING_LABEL,
  quotedBlock,
  RUN_ERROR_LABEL,
  RUN_RESPONSE_LABEL,
} from './quoted-text.js';

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
    lines.push(...quotedBlock(RUN_RESPONSE_LABEL, task.debugoutput));
  }

  if (task.debugerror) {
    lines.push('');
    lines.push('### Error');
    lines.push('');
    lines.push(...quotedBlock(RUN_ERROR_LABEL, task.debugerror));
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
          lines.push(...quotedBlock(MODEL_THINKING_LABEL, thinking.join('\n')));
          lines.push('');
        }
        if (answers.length > 0) {
          lines.push(...quotedBlock(MODEL_ANSWER_LABEL, answers.join('\n')));
        } else if (typeof output.content.raw === 'string'
          && output.content.raw) {
          lines.push(...quotedBlock(MODEL_ANSWER_LABEL, output.content.raw));
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
      lines.push(...quotedBlock(
        segment.type === 'thinking' ? MODEL_THINKING_LABEL : MODEL_ANSWER_LABEL,
        segment.text,
      ));
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
    const discount = discountPercent(model);
    if (discount !== null) lines.push(`- **Your discount:** ${discount}% off the part of a charge paid from deposits`);
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
  const discount = discountPercent(model);
  if (discount !== null) {
    lines.push(`**Your discount:** ${discount}% off the part of a charge paid from deposits. Charges use coupon credit and store revenue first, at the list price.`);
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

// The units of the ten price methods Wiro bills by. A row with any other method
// has no fixed price: its run is charged for the time it takes. A live model's
// price is its rates (see livePrice), so its unit is never shown.
const PRICE_METHOD_LABELS: Record<string, string> = {
  cpr: 'per request',
  cps: 'per second of run time',
  cpo: 'per output',
  cpt: 'per input and output token',
  'cp-pixel': 'by image size',
  'cp-audiosecondslength': 'per second of audio in inputAudio',
  'cp-promptlength': 'per prompt character',
  'cp-outputVideoLength': 'per video second',
  'cp-realtimeturn': 'per turn',
  'cp-readoutput': 'set by the run when it ends',
};

// What a unit price counts, where its unit alone leaves it open.
const PRICE_METHOD_RULES: Record<string, string> = {
  cpt: 'Input and output tokens count together, and generated audio counts as output tokens, so the total is known only when the run ends.',
  'cp-promptlength': 'Every character of the `prompt` value counts, including the brackets, keys and quotes of a JSON prompt.',
};

const NO_FIXED_PRICE = 'No fixed price: the charge follows the time the run takes and is set when it ends';

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

/** Whether a price list is empty, which Wiro bills by run time like a model without one. */
function hasEmptyPriceList(dynamicprice: unknown): boolean {
  if (Array.isArray(dynamicprice)) return dynamicprice.length === 0;
  if (typeof dynamicprice !== 'string') return false;
  try {
    const parsed: unknown = JSON.parse(dynamicprice);
    return Array.isArray(parsed) && parsed.length === 0;
  } catch {
    return false;
  }
}

/** A price row's note on one line, or undefined when it has none. */
function priceNote(row: DynamicPriceRow): string | undefined {
  const note = typeof row.note === 'string' ? row.note.replace(/\s+/g, ' ').trim() : '';
  return note || undefined;
}

function isBilledMethod(row: DynamicPriceRow): boolean {
  return Object.prototype.hasOwnProperty.call(PRICE_METHOD_LABELS, row.priceMethod);
}

const isLive = (row: DynamicPriceRow): boolean => row.priceMethod === 'cp-realtimeturn';
const isMetered = (row: DynamicPriceRow): boolean => row.priceMethod === 'cp-readoutput';
const isPixel = (row: DynamicPriceRow): boolean => row.priceMethod === 'cp-pixel';

// A live model is charged turn by turn while its session runs, at the rates in
// its note, so a row price is not what a session costs. One per-turn row makes
// the whole list live.
function livePrice(rows: DynamicPriceRow[]): string | null {
  if (!rows.some(isLive)) return null;
  const note = rows.map(row => priceNote(row)).find(Boolean);
  return note
    ? `Billed turn by turn during the live session. Rates: ${note}`
    : 'Billed turn by turn during the live session. No fixed price per run.';
}

// A cp-readoutput run reports what it cost when it ends, from what it used,
// such as tokens. The row's note gives the rates, and a price above 0 is a
// listed estimate.
function meteredEstimate(row: DynamicPriceRow): number | undefined {
  const price = usdAmount(row.price);
  return price !== null && price > 0 ? price : undefined;
}

function meteredPrice(row: DynamicPriceRow): string {
  const estimate = meteredEstimate(row);
  const head = estimate === undefined
    ? 'Set by the run when it ends'
    : `Set by the run when it ends (listed estimate $${formatPrice(estimate)})`;
  const note = priceNote(row);
  return note ? `${head}: ${note}` : `${head}. The finished task shows the cost.`;
}

/**
 * The estimated cost of one run that a price list gives: the listed estimate of
 * a price set when the run ends, else null, since the price is in `pricing`.
 * Undefined for a model without a price list.
 */
export function listedEstimate(model: ToolListItem): number | null | undefined {
  const rows = parseDynamicPrice(model.dynamicprice);
  if (!rows) return undefined;
  if (!rows.every(isMetered)) return null;
  return rows.map(meteredEstimate).find(estimate => estimate !== undefined) ?? null;
}

/** "$a", or "$a to $b" from the lowest amount to the highest; undefined when there is none. */
function amountRange(amounts: number[]): string | undefined {
  if (amounts.length === 0) return undefined;
  const low = Math.min(...amounts);
  const high = Math.max(...amounts);
  return low === high ? `$${formatPrice(low)}` : `$${formatPrice(low)} to $${formatPrice(high)}`;
}

function positiveAmount(value: unknown): number {
  const amount = usdAmount(value);
  return amount !== null && amount > 0 ? amount : 0;
}

function quantityOf(value: unknown): number | null {
  const match = /^QUANTITY:(\d+)$/.exec(String(value));
  return match ? Number(match[1]) : null;
}

// cp-pixel counts pixels in blocks of 1024 x 1024, and part of a block counts
// as a whole one. `price` covers the first block of the first output image and
// `priceExtra` each further block of it. On a row that needs input images
// (QUANTITY:1 or more), each input image adds `priceInput` per block, up to 4.
const PIXEL_BLOCK = '1024 x 1024';
const PIXEL_INPUT_BLOCKS_MAX = 4;
const PIXEL_RULES = `Pixels are counted in blocks of ${PIXEL_BLOCK} (1,048,576 pixels), and part of a block `
  + 'counts as a whole one: 1000 x 1050 is 2 blocks. Only the first output image is measured.';

function pixelInputRate(row: DynamicPriceRow): number {
  const needsInput = Object.values(row.inputs ?? {}).some(value => (quantityOf(value) ?? 0) >= 1);
  return needsInput ? positiveAmount(row.priceInput) : 0;
}

/** The search line: the first block of output, then each extra that a row sets. */
function pixelPrice(rows: DynamicPriceRow[]): string {
  const extra = amountRange(rows.map(row => positiveAmount(row.priceExtra)).filter(amount => amount > 0));
  const input = amountRange(rows.map(pixelInputRate).filter(amount => amount > 0));
  let text = `${amountRange(rows.map(row => Number(row.price)))} per run for an output image up to ${PIXEL_BLOCK} pixels`;
  if (extra) text += `, plus ${extra} per further ${PIXEL_BLOCK} block`;
  if (input) text += `, plus ${input} per ${PIXEL_BLOCK} block of each input image (at most ${PIXEL_INPUT_BLOCKS_MAX} blocks per image)`;
  return text;
}

/**
 * When a cp-pixel row applies: "No `inputImage`", "With `inputImage`", "1 to 2
 * `inputImage` files". A run uses the row with the highest count at or below
 * the number of files it sends.
 */
function pixelRowCondition(row: DynamicPriceRow, rows: DynamicPriceRow[]): string {
  const parts = Object.entries(row.inputs ?? {}).map(([key, value]) => {
    const count = quantityOf(value);
    if (count === null) return `\`${key}\` ${String(value)}`;
    if (count === 0) return `no \`${key}\``;
    const next = rows
      .map(other => quantityOf(other.inputs?.[key]))
      .filter((other): other is number => other !== null && other > count)
      .sort((a, b) => a - b)[0];
    if (next === undefined) return count === 1 ? `with \`${key}\`` : `${count} or more \`${key}\` files`;
    if (next === count + 1) return `${count} \`${key}\` file${count === 1 ? '' : 's'}`;
    return `${count} to ${next - 1} \`${key}\` files`;
  });
  const text = parts.length > 0 ? parts.join(', ') : 'every run';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function pixelRowRates(row: DynamicPriceRow): string {
  const extra = positiveAmount(row.priceExtra);
  const input = pixelInputRate(row);
  let text = `$${formatPrice(Number(row.price))} for the first block of the output image`;
  if (extra > 0) text += `, plus $${formatPrice(extra)} for each further block`;
  if (input > 0) {
    text += `, plus $${formatPrice(input)} per block of each input image, at most `
      + `${PIXEL_INPUT_BLOCKS_MAX} blocks ($${formatPrice(input * PIXEL_INPUT_BLOCKS_MAX)}) per image`;
  }
  return text;
}

// get_model_schema checks the rows against the model's settings: a run uses a
// row only when its settings carry each of the row's values, and a run that
// matches no row is charged for the time it takes.
function settingItems(parameters?: ToolParameterGroup[] | null): Map<string, ToolParameterItem> {
  const items = new Map<string, ToolParameterItem>();
  for (const group of parameters ?? []) {
    for (const item of group?.items ?? []) items.set(String(item.id), item);
  }
  return items;
}

// The values a setting accepts, or null when they are not all known: no option
// list, or options loaded from a list.
function acceptedValues(item: ToolParameterItem): string[] | null {
  const loaded = item.optionsLoad;
  if (!item.options?.length || (Array.isArray(loaded) ? loaded.length > 0 : Boolean(loaded))) return null;
  const values = item.options.map(option => toParameterOption(option).value).filter(value => value.trim() !== '');
  return values.length > 0 ? values : null;
}

// A row value matches a setting value the way Wiro compares them: 5 matches "5".
function samePriceValue(priceValue: unknown, value: string): boolean {
  return typeof priceValue === 'number' ? Number(value) === priceValue : String(priceValue) === value;
}

// A count (QUANTITY:n) needs the setting unless n is 0.
function priceRowCanApply(row: DynamicPriceRow, items: Map<string, ToolParameterItem>): boolean {
  return Object.entries(row.inputs ?? {}).every(([key, value]) => {
    const quantity = quantityOf(value);
    if (quantity !== null) return quantity === 0 || items.has(key);
    const item = items.get(key);
    if (!item) return false;
    const accepted = acceptedValues(item);
    return accepted === null || accepted.some(option => samePriceValue(value, option));
  });
}

/** Whether a run can get a row Wiro bills by its method; without settings, every row counts. */
function fixedPriceApplies(rows: DynamicPriceRow[], items: Map<string, ToolParameterItem>): boolean {
  return rows.some(row => isBilledMethod(row) && (items.size === 0 || priceRowCanApply(row, items)));
}

// The offered values of a priced setting that no row prices.
function unpricedOptionLines(rows: DynamicPriceRow[], items: Map<string, ToolParameterItem>): string[] {
  const keys = [...new Set(rows.flatMap(row => Object.keys(row.inputs ?? {})))];
  const lines: string[] = [];
  for (const key of keys) {
    const item = items.get(key);
    const accepted = item ? acceptedValues(item) : null;
    if (!accepted) continue;
    // A row that leaves the key out matches every value of it.
    if (fixedPriceApplies(rows.filter(row => row.inputs?.[key] === undefined), items)) continue;
    const priced = rows.map(row => row.inputs?.[key]).filter(value => value !== undefined);
    if (priced.some(value => quantityOf(value) !== null)) continue;
    const missing = [...new Set(accepted.filter(option => !priced.some(value => samePriceValue(value, option))))];
    if (missing.length > 0) {
      lines.push(`Other values of \`${key}\` (${missing.map(value => `\`${value}\``).join(', ')}): no fixed price; the charge follows the time the run takes.`);
    }
  }
  return lines;
}

/**
 * The notes of a model's price rows, each once, in row order, as its page shows
 * them. Rows without a fixed price leave theirs out.
 */
export function pricingNotes(model: ToolListItem): string[] {
  const rows = parseDynamicPrice(model.dynamicprice);
  if (!rows) return [];
  const live = rows.some(isLive);
  if (!live && !fixedPriceApplies(rows, settingItems(model.parameters))) return [];
  const notes = rows.filter(row => live || isBilledMethod(row)).map(row => priceNote(row));
  return [...new Set(notes.filter((note): note is string => note !== undefined))];
}

// A model without a price list is billed for its run time: at its own rate,
// or at quegroupcps when its own rate is 0.
function runTimeRate(model: ToolListItem): number {
  const own = positiveAmount(model.cps);
  return own > 0 ? own : positiveAmount(model.quegroupcps);
}

/** One row's price in the schema; a plain price names its unit unless the table header does. */
function rowPriceDetailed(row: DynamicPriceRow, withUnit: boolean): string {
  if (!isBilledMethod(row)) return withUnit ? NO_FIXED_PRICE : 'No fixed price, charged for run time';
  if (isMetered(row)) return meteredPrice(row);
  if (isPixel(row)) return pixelRowRates(row);
  const price = `$${formatPrice(row.price)}`;
  return withUnit ? `${price} / ${PRICE_METHOD_LABELS[row.priceMethod]}` : price;
}

function formatPricingDetailed(model: ToolListItem): string | null {
  const rows = parseDynamicPrice(model.dynamicprice);
  const dynamicResult = rows ? formatDynamicPriceDetailed(rows, settingItems(model.parameters)) : null;
  if (dynamicResult) return dynamicResult;

  const rate = runTimeRate(model);
  const approx = parseFloat(String(model.approximatelycost ?? '0'));
  if (approx > 0 || rate > 0) {
    const lines: string[] = ['### Pricing'];
    if (rate > 0) lines.push(`- **Rate:** $${formatPrice(rate)} per second of run time`);
    if (approx > 0) lines.push(`- **Estimated cost:** ~$${formatPrice(approx)} per run`);
    return lines.join('\n');
  }
  return null;
}

function formatDynamicPriceDetailed(rows: DynamicPriceRow[], items: Map<string, ToolParameterItem>): string | null {
  try {
    const live = livePrice(rows);
    if (live) return `### Pricing\n${live}`;
    if (!fixedPriceApplies(rows, items)) return `### Pricing\n${NO_FIXED_PRICE}.`;
    if (rows.every(isMetered)) {
      const texts = [...new Set(rows.map(meteredPrice))];
      if (texts.length === 1) return `### Pricing\n${texts[0]}`;
    }

    // A note every row shares is shown once; notes that differ go with their
    // rows. A metered row's note is part of its price.
    const notes = rows.map(row => (isBilledMethod(row) && !isMetered(row) ? priceNote(row) : undefined));
    const distinctNotes = [...new Set(notes.filter((note): note is string => note !== undefined))];
    const sharedNote = distinctNotes.length === 1 && notes.every(note => note === distinctNotes[0])
      ? distinctNotes[0]
      : undefined;
    const rowNotes = distinctNotes.length > 0 && sharedNote === undefined;
    const keys = [...new Set(rows.flatMap(row => Object.keys(row.inputs ?? {})))];
    const pixel = rows.every(isPixel);
    const single = !pixel && rows.length === 1 && keys.length === 0;
    const after: string[] = [];
    let lines: string[];

    if (pixel) {
      lines = ['### Pricing (by image size)', PIXEL_RULES];
      rows.forEach((row, i) => {
        lines.push(`- ${pixelRowCondition(row, rows)}: ${pixelRowRates(row)}.${rowNotes && notes[i] ? ` Note: ${notes[i]}` : ''}`);
      });
      const plain = rows.find(row => Object.values(row.inputs ?? {}).every(value => quantityOf(value) === 0));
      if (plain) {
        const cost = Number(plain.price) + positiveAmount(plain.priceExtra);
        lines.push(`- Example: a 1440 x 1440 output with no input image is 2 blocks, so $${formatPrice(cost)}.`);
      }
    } else {
      const method = rows.find(isBilledMethod)?.priceMethod ?? '';
      lines = [`### Pricing (${PRICE_METHOD_LABELS[method]})`];
      if (single) {
        lines.push(rowPriceDetailed(rows[0], true));
      } else if (keys.length > 0) {
        // A run uses the row with the highest QUANTITY at or below the number of
        // items it sends, so an input's highest QUANTITY row covers any more.
        const topQuantity = new Map<string, number>();
        for (const row of rows) {
          for (const [key, value] of Object.entries(row.inputs ?? {})) {
            const count = quantityOf(value);
            if (count !== null) topQuantity.set(key, Math.max(topQuantity.get(key) ?? 0, count));
          }
        }
        lines.push(`| ${keys.join(' | ')} | Price |${rowNotes ? ' Note |' : ''}`);
        lines.push(`| ${keys.map(() => '---').join(' | ')} | --- |${rowNotes ? ' --- |' : ''}`);
        rows.forEach((row, i) => {
          const values = keys.map(key => {
            const value = String(row.inputs?.[key] ?? '-');
            const count = quantityOf(value);
            if (count === null) return value;
            return count > 0 && count === topQuantity.get(key) ? `qty: ${count} or more` : `qty: ${count}`;
          });
          const noteCell = rowNotes ? ` ${(notes[i] ?? '').replace(/\|/g, '\\|')} |` : '';
          lines.push(`| ${values.join(' | ')} | ${rowPriceDetailed(row, false)} |${noteCell}`);
        });
        after.push(...unpricedOptionLines(rows, items));
      } else {
        rows.forEach((row, i) => {
          lines.push(`- ${rowPriceDetailed(row, true)}${rowNotes && notes[i] ? `. Note: ${notes[i]}` : ''}`);
        });
      }
    }

    // A single price is followed directly by what it counts; a table or a list
    // first gets a blank line, so these do not read as one of its rows.
    after.push(...new Set(rows.map(row => PRICE_METHOD_RULES[row.priceMethod]).filter(Boolean)));
    if (sharedNote) after.push(`Note: ${sharedNote}`);
    if (after.length > 0) lines.push(...(single ? [] : ['']), ...after);
    return lines.join('\n');
  } catch {
    return null;
  }
}

/**
 * The model's price on one line. `detailed`, for get_model_schema, also checks
 * the rows against the model's settings and adds the rules a quote needs, such
 * as how pixels are counted.
 */
export function formatPricing(model: ToolListItem, detailed = false): string | null {
  const rows = parseDynamicPrice(model.dynamicprice);
  const dynamicResult = rows ? formatDynamicPrice(rows, detailed, settingItems(detailed ? model.parameters : null)) : null;
  if (dynamicResult) return dynamicResult;

  const approx = parseFloat(String(model.approximatelycost ?? '0'));
  if (approx > 0) {
    return `~$${formatPrice(approx)} per run (estimated)`;
  }
  const rate = runTimeRate(model);
  if (rate > 0) {
    return `$${formatPrice(rate)} per second of run time`;
  }
  if (hasEmptyPriceList(model.dynamicprice)) {
    return 'per second of run time; `get_model_schema` gives the rate';
  }
  return null;
}

function formatDynamicPrice(rows: DynamicPriceRow[], detailed: boolean, items: Map<string, ToolParameterItem>): string | null {
  try {
    const live = livePrice(rows);
    if (live) return live;
    if (!fixedPriceApplies(rows, items)) return NO_FIXED_PRICE;

    const unit = rows.filter(row => isBilledMethod(row) && !isMetered(row) && !isPixel(row));
    const pixel = rows.filter(isPixel);
    const parts: string[] = [];
    if (unit.length > 0) {
      const uniquePrices = new Map<string, { price: number; label: string }>();
      for (const p of unit) {
        const label = PRICE_METHOD_LABELS[p.priceMethod];
        const key = `${p.price}-${label}`;
        if (!uniquePrices.has(key)) {
          uniquePrices.set(key, { price: p.price, label });
        }
      }
      const entries = [...uniquePrices.values()].sort((a, b) => a.price - b.price);
      const min = entries[0];
      const max = entries[entries.length - 1];
      parts.push(entries.length === 1
        ? `$${formatPrice(min.price)} / ${min.label}`
        : `$${formatPrice(min.price)} to $${formatPrice(max.price)} / ${min.label}`);
    }
    if (pixel.length > 0) parts.push(pixelPrice(pixel));
    parts.push(...new Set(rows.filter(isMetered).map(meteredPrice)));

    const line = `${parts.join('; ')}${rows.some(row => !isBilledMethod(row)) ? ', other settings have no fixed price' : ''}`;
    // Without settings (search rows), unpricedOptionLines finds nothing.
    const rules = [...new Set([
      ...unpricedOptionLines(rows, items),
      ...(pixel.length > 0 ? [PIXEL_RULES] : []),
      ...unit.map(row => PRICE_METHOD_RULES[row.priceMethod]).filter(Boolean),
    ])];
    if (!detailed || rules.length === 0) return line;
    return `${line.endsWith('.') ? line : `${line}.`} ${rules.join(' ')}`;
  } catch {
    return null;
  }
}

/**
 * The caller's discount on a model in percent, or null when there is none. Wiro
 * takes it off the part of a charge paid from deposits; coupon credit and store
 * revenue pay first, at the list price.
 */
export function discountPercent(model: Pick<ToolListItem, 'discount'>): number | null {
  const { discount } = model;
  const value = typeof discount === 'number'
    ? discount
    : typeof discount === 'string' ? Number(discount.trim().replace(/%$/, '')) : Number.NaN;
  return Number.isFinite(value) && value > 0 && value <= 100 ? Math.round(value * 100) / 100 : null;
}

/** A USD amount with up to 6 decimals and no trailing zeros. */
export function formatPrice(price: number): string {
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
