import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { asString, isPlainObject, toNumber, type ApiEnvelope } from '../utils/api.js';
import { formatModelSchema } from '../utils/format.js';
import { toStructuredModelDetail } from '../utils/structured.js';
import { modelDetailOutputSchema } from './schemas.js';

const UTILITY_PREFIX = 'workflow-utilities/';

interface UtilityDetailResponse extends ApiEnvelope {
  utility?: Array<Record<string, unknown>>;
}

function optionalNumber(value: unknown): number | undefined {
  const parsed = toNumber(value);
  return parsed === null ? undefined : parsed;
}

// Workflow utilities are built-in steps (pick a file from a model's outputs,
// merge or split text). They are not models, but a workflow author needs the
// same view of them: parameter ids and the output ports to reference.
async function getUtilitySchema(client: WiroClient, slug: string) {
  const result = await client.post<UtilityDetailResponse>('/Workflow/UtilityDetail', { slug });
  const utility = result.result === true ? result.utility?.[0] : undefined;
  if (!utility) return null;

  const groups = Array.isArray(utility.parameters) ? utility.parameters.filter(isPlainObject) : [];
  const parameters = groups.map(group => ({
    title: asString(group.title) || 'Parameters',
    items: (Array.isArray(group.items) ? group.items.filter(isPlainObject) : []).map(item => {
      const notes = [
        asString(item.note),
        item.wireOnly === true ? 'Wire only: set it to a reference such as "$node-<id>.outputs".' : undefined,
        item.configOnly === true ? 'Static value only: references are not allowed.' : undefined,
      ].filter((note): note is string => Boolean(note))
        .map(note => (/[.!?]$/.test(note) ? note : `${note}.`))
        .join(' ');
      return {
        id: String(item.id ?? ''),
        type: String(item.type ?? 'text'),
        label: asString(item.label) || String(item.id ?? ''),
        ...(item.defaultvalue !== undefined && item.defaultvalue !== '' ? { default: String(item.defaultvalue) } : {}),
        required: item.required === true || String(item.required) === 'true',
        ...(notes ? { note: notes } : {}),
        options: (Array.isArray(item.options) ? item.options.filter(isPlainObject) : []).map(option => ({
          label: String(option.text ?? option.value ?? ''),
          value: String(option.value ?? ''),
        })),
        ...(optionalNumber(item.minvalue) !== undefined ? { min: optionalNumber(item.minvalue) } : {}),
        ...(optionalNumber(item.maxvalue) !== undefined ? { max: optionalNumber(item.maxvalue) } : {}),
        ...(optionalNumber(item.incrementby) !== undefined ? { step: optionalNumber(item.incrementby) } : {}),
        advanced: item.advanced === true,
      };
    }),
  }));
  const outputs = (Array.isArray(utility.outputs) ? utility.outputs.filter(isPlainObject) : []).map(port => ({
    id: String(port.id ?? ''),
    label: asString(port.label) || String(port.id ?? ''),
    type: asString(port.type) || 'string',
  }));
  const dynamicOutputs = utility.dynamicOutputs === true;

  return {
    model: {
      slug,
      title: asString(utility.title) || slug,
      ...(asString(utility.description) ? { description: asString(utility.description) } : {}),
      categories: ['workflow-utility'],
      parameters,
      outputs,
      ...(dynamicOutputs ? { dynamicOutputs } : {}),
    },
    nextAction: {
      tool: 'get_playbook',
      arguments: { topics: ['workflows'] },
      reason: 'Utilities are workflow steps, not runnable models. See how to wire them into a workflow.',
    },
  };
}

// The workflows group can load this tool without run_model. A model is then
// only usable as a workflow step, so the result points there instead.
function workflowStepUsage(text: string, slug: string): string {
  const usage = text.lastIndexOf('\n### Usage');
  return [
    usage >= 0 ? text.slice(0, usage) : text,
    '',
    '### Usage',
    '',
    `Use this model as a workflow step: \`"type": "run"\`, \`"tool": "${slug}"\`, and the parameter ids above as the keys of \`input\`. \`get_playbook\` with the topic "workflows" shows the full format.`,
  ].join('\n');
}

export interface GetModelSchemaOptions {
  /** Whether run_model is registered too. Defaults to true. */
  runModel?: boolean;
}

export function registerGetModelSchema(
  server: McpServer,
  client: WiroClient,
  options: GetModelSchemaOptions = {},
): void {
  const runModel = options.runModel !== false;
  server.registerTool(
    'get_model_schema',
    {
      title: 'Get a Wiro model schema',
      description: (runModel
        ? 'Get one model’s typed parameters, options, defaults, required '
          + 'fields, and pricing. Catalog fields such as `previousTaskToken` must be '
          + 'discovered here; use it with `toolOutputs` for tool results or with one '
          + 'new prompt/messages value for a stateful next turn. Fill required '
          + 'parameters and follow the returned `run_model` next action exactly once. '
        : 'Get one model’s typed parameters, options, defaults, required '
          + 'fields, and pricing, to use the model as a workflow step: its parameter '
          + 'ids are the keys of the step’s input. ')
        + 'It also describes the built-in workflow utilities (workflow-utilities/output-filter, '
        + 'workflow-utilities/merge-text, workflow-utilities/split-text): their parameters and '
        + 'the output ports other workflow steps reference.',
      inputSchema: {
        model: z.string().describe('Model slug in "owner/model" format, e.g. "openai/sora-2", "black-forest-labs/flux-2-pro", or a workflow utility such as "workflow-utilities/output-filter".'),
      },
      outputSchema: modelDetailOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ model }) => {
      try {
        if (model.startsWith(UTILITY_PREFIX)) {
          const utility = await getUtilitySchema(client, model);
          if (!utility) {
            return {
              content: [{ type: 'text' as const, text: `Workflow utility "${model}" not found. The built-in utilities are workflow-utilities/output-filter, workflow-utilities/merge-text and workflow-utilities/split-text.` }],
              isError: true,
            };
          }
          const lines = [`## ${utility.model.title} (\`${model}\`)`, ''];
          if (utility.model.description) lines.push(utility.model.description, '');
          lines.push('### Parameters', '');
          for (const item of utility.model.parameters.flatMap(group => group.items)) {
            lines.push(`- \`${item.id}\` (${item.type}${item.required ? ', required' : ''})${item.default !== undefined ? ` default ${item.default}` : ''}: ${item.label}${item.note ? `. ${item.note}` : ''}`);
          }
          lines.push('', '### Output ports', '');
          for (const port of utility.model.outputs) {
            lines.push(`- \`${port.id}\` (${port.type}): reference it as \`$node-<step id>.${port.id}\``);
          }
          if (utility.model.dynamicOutputs) {
            lines.push('', 'The number of output ports follows the step\'s `count` parameter.');
          }
          return {
            content: [{ type: 'text' as const, text: lines.join('\n') }],
            structuredContent: utility,
          };
        }

        const result = await client.getModelSchema(model);

        const modelData = result.tool?.[0];
        if (!result.result || !modelData) {
          return {
            content: [{ type: 'text' as const, text: `Model "${model}" not found.` }],
            isError: true,
          };
        }

        const text = formatModelSchema(modelData);
        const detail = toStructuredModelDetail(modelData);
        if (!runModel) {
          return {
            content: [{ type: 'text' as const, text: workflowStepUsage(text, detail.model.slug) }],
            structuredContent: {
              ...detail,
              nextAction: {
                tool: 'get_playbook',
                arguments: { topics: ['workflows'] },
                reason: 'Use this model as a workflow step; the playbook shows the step format. Running a model on its own needs the models tool group, which is not loaded.',
              },
            },
          };
        }

        return {
          content: [{ type: 'text' as const, text }],
          structuredContent: detail,
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `## Error\n\n${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );
}
