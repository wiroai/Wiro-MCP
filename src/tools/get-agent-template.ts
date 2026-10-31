import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { errorResult, isPlainObject, requireApiSuccess, type ApiEnvelope } from '../utils/api.js';
import {
  templateDetailSchema,
  toTemplateDetail,
  type CredentialRequirement,
  type TemplateDetail,
} from '../utils/agent-catalog.js';
import { formatCredits, formatUsd, isGuid } from '../utils/user-agent.js';
import { nextActionSchema } from './schemas.js';

function credentialLine(credential: CredentialRequirement): string {
  const fields = credential.fields
    .filter(field => !field.onlyInModes || field.onlyInModes.length === 0)
    .map(field => `${field.label}${field.required ? '' : ' (optional)'}`);
  const how = credential.oauth ? 'connect with connect_agent_oauth' : 'set with set_agent_credentials';
  return `- ${credential.title} (\`${credential.key}\`): ${fields.length > 0 ? `${fields.join(', ')}; ` : ''}${how}`;
}

function formatTemplate(template: TemplateDetail): string {
  const lines = [`## ${template.title} (\`${template.slug}\`)`, ''];
  if (template.summary) lines.push(template.summary, '');
  if (template.pricing) {
    const { starter, pro } = template.pricing;
    lines.push(
      `**Starter:** ${formatUsd(starter.priceUsd)} per 30 days, ${formatCredits(starter.monthlyCredits)} credits per month`,
      `**Pro:** ${formatUsd(pro.priceUsd)} per 30 days, ${formatCredits(pro.monthlyCredits)} credits per month`,
      'Prices are paid from the Wiro wallet when deploying and renew every 30 days until the plan is cancelled. Credits pay for the agent\'s chat and scheduled tasks (100 credits = 1 USD). Model runs it starts, for images, videos or voice calls, are billed to the wallet of the Wiro API key saved on the agent.',
    );
  } else {
    lines.push('**Pricing:** unavailable right now. Do not deploy this template until it can be priced.');
  }
  if (template.skills.length > 0) {
    lines.push('', `**Skills:** ${template.skills.map(skill => skill.title ?? skill.name).join(', ')}`);
  }
  lines.push('', '### Credentials the user must provide', '');
  if (template.requiredCredentials.length === 0) lines.push('None are required to finish setup.');
  for (const credential of template.requiredCredentials) lines.push(credentialLine(credential));
  if (template.optionalCredentials.length > 0) {
    lines.push('', '### Optional credentials', '');
    for (const credential of template.optionalCredentials) lines.push(credentialLine(credential));
  }
  if ([...template.requiredCredentials, ...template.optionalCredentials].some(credential => credential.oauth)) {
    lines.push('', 'A service that connects through connect_agent_oauth uses a sign-in link, a token or the user\'s own app keys: '
      + 'list_agent_skills with its key shows which, so tell the user before deploying.');
  }
  if (template.channels.length > 0) {
    lines.push('', `**Chat channels (optional):** ${template.channels.map(channel => `${channel.title} (${channel.requiredFields.join(', ')})`).join('; ')}`);
  }
  if (template.models.selectable.length > 0) {
    lines.push('', `**Chat models:** ${template.models.selectable.map(model => model.label ?? model.slug).join(', ')}${template.models.default ? ` (default ${template.models.default})` : ''}`);
  }
  if (template.description) lines.push('', '### About', '', template.description);
  return lines.join('\n');
}

export function registerGetAgentTemplate(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'get_agent_template',
    {
      title: 'Get a Wiro agent template',
      description: 'Read one agent template before deploying it: its skills, the credentials the user must '
        + 'provide (with the field labels to ask for), the optional chat channels, the selectable chat models '
        + 'with their token rates in credits per 1M tokens, and the exact Starter and Pro prices that '
        + 'deploy_agent charges. Required credentials can be added after deployment, but skills that need '
        + 'them do not work until they are set.',
      inputSchema: {
        template: z.string().min(1).max(200)
          .describe('Template slug or guid from list_agent_templates.'),
        include_tasks: z.boolean().default(false)
          .describe('Also return the template\'s scheduled tasks and custom instructions (key, description, schedule, shortened instruction text).'),
      },
      outputSchema: {
        template: templateDetailSchema,
        nextAction: nextActionSchema.optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ template, include_tasks }, extra) => {
      try {
        const reference = template.trim();
        const body = requireApiSuccess(
          await client.post<ApiEnvelope & { agents?: unknown }>('/Agent/Detail', {
            ...(isGuid(reference) ? { guid: reference } : { slug: reference }),
            ...(include_tasks ? { type: 'full' } : {}),
          }, extra.signal),
          'The agent template could not be read.',
        );
        const row = Array.isArray(body.agents) ? body.agents.find(isPlainObject) : undefined;
        if (!row) throw new Error(`No agent template was found for "${reference}".`);
        const detail = toTemplateDetail(row);

        return {
          content: [{ type: 'text' as const, text: formatTemplate(detail) }],
          structuredContent: {
            template: detail,
            ...(detail.pricing
              ? {
                nextAction: {
                  tool: 'deploy_agent',
                  arguments: { template: detail.slug || detail.guid, tier: 'starter' },
                  reason: 'Get the exact deployment quote. Nothing is charged until the user approves and the call is repeated with confirm: true.',
                },
              }
              : {}),
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
