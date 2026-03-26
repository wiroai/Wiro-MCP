import type { Task, ToolListItem } from '../types.js';

export function formatTaskResult(task: Task): string {
  const lines: string[] = [];
  lines.push(`## Task Result`);
  lines.push('');
  lines.push(`**Status:** ${task.status}`);
  lines.push(`**Task ID:** ${task.id}`);
  if (task.modelslugowner && task.modelslugproject) {
    lines.push(`**Model:** \`${task.modelslugowner}/${task.modelslugproject}\``);
  }

  if (task.pexit === '0') {
    lines.push(`**Result:** Success`);
  } else if (task.pexit) {
    lines.push(`**Result:** Failed (exit code: ${task.pexit})`);
  }

  if (task.elapsedseconds) {
    lines.push(`**Duration:** ${task.elapsedseconds}s`);
  }

  if (task.totalcost && task.totalcost !== '0') {
    lines.push(`**Cost:** $${task.totalcost}`);
  }

  if (task.debugoutput) {
    lines.push('');
    lines.push('### Response');
    lines.push('');
    lines.push(task.debugoutput);
  }

  if (task.outputs?.length > 0) {
    lines.push('');
    lines.push('### Outputs');
    lines.push('');
    for (const output of task.outputs) {
      if (output.contenttype === 'raw' && output.content) {
        if (output.content.thinking?.length) {
          lines.push('**Thinking:**');
          for (const t of output.content.thinking) {
            lines.push(t);
          }
          lines.push('');
        }
        if (output.content.answer?.length) {
          lines.push('**Answer:**');
          for (const a of output.content.answer) {
            lines.push(a);
          }
        } else if (output.content.raw) {
          lines.push(output.content.raw);
        }
      } else if (output.url) {
        lines.push(`- **${output.name}** (${output.contenttype}, ${formatSize(output.size ?? '0')})`);
        lines.push(`  ${output.url}`);
      }
    }
  }

  return lines.join('\n');
}

export function formatModelList(models: ToolListItem[], header?: string): string {
  if (models.length === 0) return 'No models found.';

  const lines: string[] = [];
  lines.push(header ?? `## Models (${models.length} results)`);
  lines.push('');

  for (const model of models) {
    const slug = `${model.cleanslugowner}/${model.cleanslugproject}`;
    const cats = model.categories?.filter(c => c !== 'tool').join(', ') || '';
    lines.push(`### ${model.title}`);
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

  lines.push(`## ${model.title}`);
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
        const defaultVal = param.default ? ` (default: \`${param.default}\`)` : '';
        lines.push(`- **\`${param.id}\`** (${param.type})${required}${defaultVal}`);
        if (param.label) lines.push(`  ${param.label}`);
        if (param.description && param.description !== param.label) lines.push(`  ${param.description}`);
        if (param.placeholder) lines.push(`  Example: \`${param.placeholder}\``);
        if (param.note) lines.push(`  ${param.note}`);
        if (param.type === 'fileinput') lines.push(`  Pass a URL directly (e.g. \`${param.id}: "https://..."\`) or use \`${param.id}Url\` for the URL field.`);
        if (param.type === 'multifileinput') lines.push(`  Pass URLs via \`${param.id}Url\` (comma-separated) or upload files in \`${param.id}\`.`);
        if (param.type === 'combinefileinput') lines.push(`  Pass an array of URLs directly: \`${param.id}: ["https://...", "https://..."]\`. No upload needed.`);

        if (param.options?.length) {
          const optionValues = param.options.map(o => `\`${o.value}\``).join(', ');
          lines.push(`  Options: ${optionValues}`);
        }

        if (param.type === 'range' && param.min != null && param.max != null) {
          lines.push(`  Range: ${param.min} - ${param.max}${param.step ? `, step: ${param.step}` : ''}`);
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

function formatPricing(model: ToolListItem): string | null {
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
    return `$${formatPrice(min.price)} – $${formatPrice(max.price)} / ${min.label}`;
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
