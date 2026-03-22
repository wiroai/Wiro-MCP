import type { Task, ToolListItem } from '../types.js';

export function formatTaskResult(task: Task): string {
  const lines: string[] = [];
  lines.push(`## Task Result`);
  lines.push('');
  lines.push(`**Status:** ${task.status}`);
  lines.push(`**Task ID:** ${task.id}`);

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
      lines.push(`- **${output.name}** (${output.contenttype}, ${formatSize(output.size)})`);
      lines.push(`  ${output.url}`);
    }
  }

  return lines.join('\n');
}

export function formatModelList(models: ToolListItem[]): string {
  if (models.length === 0) return 'No models found.';

  const lines: string[] = [];
  lines.push(`## Models (${models.length} results)`);
  lines.push('');

  for (const model of models) {
    const slug = `${model.cleanslugowner}/${model.cleanslugproject}`;
    const cats = model.categories?.filter(c => c !== 'tool').join(', ') || '';
    lines.push(`### ${model.title}`);
    lines.push(`- **Model:** \`${slug}\``);
    if (cats) lines.push(`- **Categories:** ${cats}`);
    if (model.seodescription) lines.push(`- **Description:** ${model.seodescription}`);
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
        if (param.note) lines.push(`  ${param.note}`);

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

function formatSize(sizeStr: string): string {
  const bytes = parseInt(sizeStr, 10);
  if (isNaN(bytes)) return sizeStr;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
