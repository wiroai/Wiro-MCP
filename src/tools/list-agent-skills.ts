import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import {
  ApiResultError,
  asString,
  errorResult,
  isPlainObject,
  requireApiSuccess,
  type ApiEnvelope,
} from '../utils/api.js';
import {
  credentialSetupSchema,
  isPlatformCredentialKey,
  skillSummarySchema,
  toCredentialSetup,
  toSkillSummary,
  type CredentialSetup,
  type CredentialSetupItem,
  type SkillSummary,
} from '../utils/agent-catalog.js';
import { loadSkillRegistry, registryTitles } from '../utils/agent-config.js';
import { connectorLabel, listCatalog, readConnector } from '../utils/agent-connectors.js';
import { AGENT_AI_USAGE, skillLabel, toStringArray } from '../utils/user-agent.js';
import { nextActionSchema, strictInput } from './schemas.js';

const PRICING_NOTE = 'Every plan (Starter, Pro or Max) includes every skill and connector, so neither changes an agent\'s '
  + 'price: a custom build costs its plan\'s price, and turning a skill on or off later costs nothing. A skill\'s '
  + `work uses ${AGENT_AI_USAGE}, and model runs it starts are billed to the wallet of the workspace that owns `
  + 'the Wiro project connected to the agent. deploy_agent returns the exact quote before anything is charged.';

const channelSchema = z.object({
  id: z.string(),
  title: z.string(),
  credentialKey: z.string(),
  requiredFields: z.array(z.string()),
});

type Channel = z.infer<typeof channelSchema>;

type CredentialEnvelope = ApiEnvelope & { credential?: unknown };

async function readCredential(
  client: WiroClient,
  key: string,
  signal: AbortSignal,
): Promise<Record<string, unknown> | null> {
  const body = await client.post<CredentialEnvelope>('/Credentials/Detail', { key }, signal);
  return body?.result === true && isPlainObject(body.credential) ? body.credential : null;
}

function toChannels(value: unknown): Channel[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isPlainObject).map(channel => {
    const id = asString(channel.id) ?? '';
    return {
      id,
      title: asString(channel.title) ?? id,
      credentialKey: asString(channel.credential_key) ?? id,
      requiredFields: toStringArray(channel.required_fields),
    };
  });
}

/**
 * The catalog's connectors by slug, read once when a listed skill works with any, so they are named by title. Null
 * when none is needed or the catalog cannot be read.
 */
async function connectorCatalog(
  client: WiroClient,
  skills: SkillSummary[],
  signal: AbortSignal,
): Promise<Map<string, { slug: string; title: string }> | null> {
  if (!skills.some(skill => skill.suggestedConnectors?.length)) return null;
  const catalog = await listCatalog(client, {}, signal).catch(() => null);
  return catalog ? new Map(catalog.map(connector => [connector.slug, { slug: connector.slug, title: connector.title }])) : null;
}

/**
 * The Connectors a skill works with, by title: the ones the active catalog lists, as an add card names them. Unread,
 * the catalog leaves them by slug.
 */
function worksWith(skill: SkillSummary, catalog: Map<string, { slug: string; title: string }> | null): string[] {
  const slugs = skill.suggestedConnectors ?? [];
  if (!catalog) return slugs.map(slug => connectorLabel({ slug }));
  return slugs.flatMap(slug => {
    const connector = catalog.get(slug);
    return connector ? [connectorLabel(connector)] : [];
  });
}

function skillLine(skill: SkillSummary, connectors: string[] = []): string {
  const notes = [
    skill.requiresCredentials && skill.credentialKey ? `needs \`${skill.credentialKey}\`` : null,
    connectors.length > 0 ? `works with ${connectors.join(', ')}` : null,
    skill.deprecated ? `deprecated${skill.replacement ? ` (use ${skill.replacement})` : ''}` : null,
  ].filter(Boolean).join(', ');
  const description = skill.description ?? '';
  const details = [notes, description].filter(Boolean).join('. ');
  return `- **${skill.title}** (\`${skill.name}\`)${details ? `: ${details}` : ''}`;
}


/** The keys of a list's entries, one line each, with a list inside an entry indented below it. */
function entryLines(items: CredentialSetupItem[], depth: number): string[] {
  return items.flatMap(item => {
    const notes = [
      item.required === undefined ? undefined : item.required ? 'required' : 'optional',
      item.type,
      item.options ? `one of: ${item.options.map(option => option.value || '(empty)').join(', ')}` : undefined,
    ].filter(Boolean).join(', ');
    const help = item.help ? `: ${item.help.replace(/\n/g, ' ')}` : '';
    const indent = '  '.repeat(depth);
    return [
      `${indent}- **${item.label ?? item.key}** (\`${item.key}\`${notes ? `, ${notes}` : ''})${help}`,
      ...(item.itemFields ? [`${indent}  Each entry:`, ...entryLines(item.itemFields, depth + 1)] : []),
    ];
  });
}

function setupLines(credential: CredentialSetup): string[] {
  const lines = [`### ${credential.title} (\`${credential.key}\`, ${credential.role})`, ''];
  if (credential.note) lines.push(credential.note);
  if (credential.channel) {
    lines.push(`Chat channel \`${credential.channel.id}\`: it turns on once ${credential.channel.requiredFields.join(', ')} are filled.`);
  }
  for (const field of credential.fields.filter(item => item.writable)) {
    const notes = [
      field.required ? 'required' : 'optional',
      field.type,
      field.secret ? 'secret' : undefined,
    ].filter(Boolean).join(', ');
    lines.push(`- **${field.label}** (\`${field.key}\`, ${notes})`);
    if (field.help) lines.push(`  ${field.help.replace(/\n/g, ' ')}`);
    if (field.itemFields) lines.push('  Each entry:', ...entryLines(field.itemFields, 1));
  }
  return lines;
}

export function registerListAgentSkills(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'list_agent_skills',
    {
      title: 'List Wiro agent skills',
      description: 'List the Skills a Wiro agent can have (how it works: reporting, copywriting, video, voice '
        + 'calls and more), the skills they depend on, the credentials they need, the Connectors they work with '
        + '(suggestedConnectors, none of which connects by itself), and the chat channels. Every plan '
        + 'includes every skill, so a skill has no price of its own. Use it to plan a custom build for deploy_agent or '
        + 'a skill change for apply_agent_skills. Outside services (ad accounts, stores, social accounts, mailboxes) '
        + 'are not skills but Connectors: list_agent_connectors lists them. Pass `name` with a skill name (or a '
        + 'credential or channel key such as "telegram") to get the exact fields the user must provide, with their '
        + 'labels, formats and setup help, so you know what to ask for before calling set_agent_credentials. A Wiro '
        + 'project (credential "wiro") is connected with bind_agent_project, with no key to paste.',
      inputSchema: strictInput({
        name: z.string().min(1).max(100).optional()
          .describe('A skill name (for example "util-video-creator") returns the skill and the setup fields of every credential it needs. A credential or channel key (for example "telegram") returns that credential\'s setup.'),
        capability: z.string().max(100).optional()
          .describe('Only skills with this capability, for example "video_generation". include_capabilities lists the names.'),
        include_capabilities: z.boolean().default(false)
          .describe('Also return the list of capability names with descriptions.'),
        include_deprecated: z.boolean().default(false)
          .describe('Also return deprecated skills.'),
      }),
      outputSchema: {
        skills: z.array(skillSummarySchema),
        channels: z.array(channelSchema),
        total: z.number().int().nonnegative(),
        capabilities: z.array(z.object({ name: z.string(), description: z.string().optional() })).optional(),
        setup: z.object({ credentials: z.array(credentialSetupSchema) }).optional(),
        pricingNote: z.string(),
        nextAction: nextActionSchema.optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ name, capability, include_capabilities, include_deprecated }, extra) => {
      try {
        let capabilities: Array<{ name: string; description?: string }> | undefined;
        if (include_capabilities) {
          const body = requireApiSuccess(
            await client.post<ApiEnvelope & { capabilities?: unknown }>('/Skills/Capabilities', {}, extra.signal),
            'The capability list could not be read.',
          );
          capabilities = (Array.isArray(body.capabilities) ? body.capabilities : [])
            .filter(isPlainObject)
            .flatMap(item => {
              const capabilityName = asString(item.name);
              const description = asString(item.description);
              return capabilityName ? [{ name: capabilityName, ...(description ? { description } : {}) }] : [];
            });
        }

        if (name) {
          const key = name.trim();
          const detail = await client.post<ApiEnvelope & { skill?: unknown }>('/Skills/Detail', { name: key }, extra.signal);
          let skills: SkillSummary[] = [];
          const credentials: CredentialSetup[] = [];

          if (detail?.result === true && isPlainObject(detail.skill)) {
            const skill = toSkillSummary(detail.skill);
            skills = [skill];
            const keys = skill.requiresCredentials
              ? [
                ...(skill.credentialKey ? [{ key: skill.credentialKey, role: 'primary' as const }] : []),
                ...(skill.additionalCredentialKeys ?? []).map(extraKey => ({ key: extraKey, role: 'additional' as const })),
              ]
              : [];
            for (const entry of keys) {
              if (isPlatformCredentialKey(entry.key)) continue;
              const credential = await readCredential(client, entry.key, extra.signal);
              if (credential) credentials.push(toCredentialSetup(credential, entry.role));
            }
          } else {
            const credential = await readCredential(client, key, extra.signal);
            if (!credential || isPlatformCredentialKey(key)) {
              const connector = await readConnector(client, key.toLowerCase(), extra.signal).catch(() => null);
              throw new ApiResultError(connector
                ? `${connector.title} is a Connector, not a skill: list_agent_connectors with name "${connector.slug}" shows how it connects, and connect_agent_connector connects it.`
                : `No skill or credential is named "${key}". Call list_agent_skills without name to see every skill, or list_agent_connectors for the outside services.`,
              [404],
              {},
              );
            }
            credentials.push(toCredentialSetup(credential, 'credential'));
          }

          const lines: string[] = [];
          const catalog = await connectorCatalog(client, skills, extra.signal);
          for (const skill of skills) lines.push(`## Skill`, '', skillLine(skill));
          if (skills[0]?.dependsOn.length) {
            const titles = await loadSkillRegistry(client, extra.signal).then(registryTitles).catch(() => new Map<string, string>());
            lines.push('', `Also enables: ${skills[0].dependsOn.map(name => skillLabel(name, titles)).join(', ')}`);
          }
          if (skills[0] && !skills[0].requiresCredentials) lines.push('', 'This skill needs no credentials.');
          const connectors = skills[0] ? worksWith(skills[0], catalog) : [];
          if (connectors.length > 0) {
            lines.push('', `Works with these Connectors: ${connectors.join(', ')}. None connects by itself: `
              + 'connect_agent_connector connects each one, and list_agent_connectors with its slug shows how.');
          }
          for (const credential of credentials) lines.push('', ...setupLines(credential));
          lines.push('', PRICING_NOTE);

          return {
            content: [{ type: 'text' as const, text: lines.join('\n') }],
            structuredContent: {
              skills,
              channels: [],
              total: skills.length,
              ...(capabilities ? { capabilities } : {}),
              setup: { credentials },
              pricingNote: PRICING_NOTE,
            },
          };
        }

        const body = requireApiSuccess(
          await client.post<ApiEnvelope & { skills?: unknown; channels?: unknown }>('/Skills/List', {
            ...(capability?.trim() ? { capability: capability.trim() } : {}),
          }, extra.signal),
          'The skill list could not be read.',
        );
        const skills = (Array.isArray(body.skills) ? body.skills : [])
          .filter(isPlainObject)
          .map(toSkillSummary)
          .filter(skill => skill.name && (include_deprecated || !skill.deprecated));
        const channels = toChannels(body.channels);

        const lines = [`## Agent skills (${skills.length})`, ''];
        if (skills.length === 0) lines.push('No skills matched.');
        const catalog = await connectorCatalog(client, skills, extra.signal);
        for (const skill of skills) lines.push(skillLine(skill, worksWith(skill, catalog)));
        if (channels.length > 0) {
          lines.push('', '### Chat channels', '', 'Channels are not skills. Each one turns on once its required fields are set with set_agent_credentials.');
          for (const channel of channels) lines.push(`- ${channel.title} (\`${channel.credentialKey}\`): ${channel.requiredFields.join(', ')}`);
        }
        lines.push('', 'Outside services are Connectors: list_agent_connectors lists them.');
        if (capabilities?.length) {
          lines.push('', '### Capabilities', '');
          for (const item of capabilities) lines.push(`- \`${item.name}\`${item.description ? `: ${item.description}` : ''}`);
        }
        lines.push('', PRICING_NOTE);
        const firstWithCredentials = skills.find(skill => skill.requiresCredentials);

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: {
            skills,
            channels,
            total: skills.length,
            ...(capabilities ? { capabilities } : {}),
            pricingNote: PRICING_NOTE,
            ...(firstWithCredentials
              ? {
                nextAction: {
                  tool: 'list_agent_skills',
                  arguments: { name: firstWithCredentials.name },
                  reason: 'See exactly which credential fields a skill needs before choosing it.',
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
