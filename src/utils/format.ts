import type {
  Task,
  TaskSegment,
  TaskUsage,
  ToolListItem,
  ToolParameterItem,
  ToolParameterOption,
} from '../types.js';
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
 * A task's cost for the user: what Wiro charged once it billed the task, with
 * the list price beside it when a discount made them differ. Before Wiro bills
 * it, the list price.
 */
export function formatTaskCost(task: Task): string | null {
  const list = usdAmount(task.totalcost);
  const charged = usdAmount(task.chargedcost);
  if (charged !== null) {
    if (charged === 0) return '$0 (not charged)';
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

// A run checks a range only on number and float parameters, and the run form
// draws a slider only for those. Other types carry placeholder bounds in the
// catalog (0 to 0 on a text or select field), so they get none.
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
  'cp-pixel': 'per pixel',
  'cp-audiosecondslength': 'per audio second',
  'cp-promptlength': 'per character',
  'cp-outputVideoLength': 'per video second',
  'cp-realtimeturn': 'per turn',
  'cp-readoutput': 'model-reported',
};

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
  if (!dynamicprice) return null;
  try {
    const parsed: Array<{ price: number; priceMethod: string; inputs?: Record<string, string> }> =
      typeof dynamicprice === 'string' ? JSON.parse(dynamicprice) : dynamicprice;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;

    const method = parsed[0].priceMethod;
    const methodLabel = PRICE_METHOD_LABELS[method] ?? method;
    const lines: string[] = [`### Pricing (${methodLabel})`];

    if (parsed.length === 1 && (!parsed[0].inputs || Object.keys(parsed[0].inputs).length === 0)) {
      lines.push(`$${formatPrice(parsed[0].price)} / ${methodLabel}`);
      return lines.join('\n');
    }

    const inputKeys = new Set<string>();
    for (const p of parsed) {
      if (p.inputs) {
        for (const k of Object.keys(p.inputs)) inputKeys.add(k);
      }
    }
    const keys = [...inputKeys];

    if (keys.length > 0) {
      lines.push(`| ${keys.join(' | ')} | Price |`);
      lines.push(`| ${keys.map(() => '---').join(' | ')} | --- |`);
      for (const p of parsed) {
        const values = keys.map(k => {
          const v = p.inputs?.[k] ?? '-';
          return v.startsWith('QUANTITY:') ? `qty: ${v.split(':')[1]}` : v;
        });
        lines.push(`| ${values.join(' | ')} | $${formatPrice(p.price)} |`);
      }
    } else {
      for (const p of parsed) {
        lines.push(`- $${formatPrice(p.price)} / ${PRICE_METHOD_LABELS[p.priceMethod] ?? p.priceMethod}`);
      }
    }

    return lines.join('\n');
  } catch {
    return null;
  }
}

export function formatPricing(model: ToolListItem): string | null {
  const dynamicResult = formatDynamicPrice(model.dynamicprice);
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

function formatDynamicPrice(dynamicprice?: string): string | null {
  if (!dynamicprice) return null;
  try {
    const parsed: Array<{ price: number; priceMethod: string; inputs?: Record<string, string> }> =
      typeof dynamicprice === 'string' ? JSON.parse(dynamicprice) : dynamicprice;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;

    const uniquePrices = new Map<string, { price: number; label: string }>();
    for (const p of parsed) {
      const label = PRICE_METHOD_LABELS[p.priceMethod] ?? p.priceMethod;
      const key = `${p.price}-${label}`;
      if (!uniquePrices.has(key)) {
        uniquePrices.set(key, { price: p.price, label });
      }
    }

    const entries = [...uniquePrices.values()].sort((a, b) => a.price - b.price);
    if (entries.length === 1) {
      const e = entries[0];
      return `$${formatPrice(e.price)} / ${e.label}`;
    }

    const min = entries[0];
    const max = entries[entries.length - 1];
    return `$${formatPrice(min.price)} to $${formatPrice(max.price)} / ${min.label}`;
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
