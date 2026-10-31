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
import {
  connectionModeRequirements,
  parseCredentialMeta,
  type ModeRequirement,
} from '../utils/agent-config.js';
import { formatUsd, toStringArray } from '../utils/user-agent.js';
import { nextActionSchema } from './schemas.js';

const PRICING_NOTE = 'A custom build costs the sum of its skills\' monthly prices, including the skills they '
  + 'depend on, and Starter has a minimum monthly price. Pro is a fixed multiple of Starter. deploy_agent '
  + 'returns the exact quote before anything is charged.';

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

function skillLine(skill: SkillSummary): string {
  const price = skill.monthlyPriceUsd > 0 ? `${formatUsd(skill.monthlyPriceUsd)} per month` : 'free';
  const credential = skill.requiresCredentials && skill.credentialKey ? `, needs \`${skill.credentialKey}\`` : '';
  const deprecated = skill.deprecated ? `, deprecated${skill.replacement ? ` (use ${skill.replacement})` : ''}` : '';
  return `- **${skill.title}** (\`${skill.name}\`): ${price}${credential}${deprecated}${skill.description ? `. ${skill.description}` : ''}`;
}

interface CredentialEntry {
  setup: CredentialSetup;
  /** The modes that can be used now, with what each one needs. */
  modes: ModeRequirement[];
}

function toCredentialEntry(credential: Record<string, unknown>, role: CredentialSetup['role']): CredentialEntry {
  return {
    setup: toCredentialSetup(credential, role),
    modes: connectionModeRequirements(parseCredentialMeta(credential), null).filter(mode => mode.available),
  };
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

function setupLines({ setup: credential, modes }: CredentialEntry): string[] {
  const lines = [`### ${credential.title} (\`${credential.key}\`, ${credential.role})`, ''];
  if (credential.oauth && modes.length > 0) {
    lines.push('How it connects (connect_agent_oauth or set_agent_credentials):');
    for (const mode of modes) {
      lines.push(`- **${mode.mode}**: ${mode.note}${mode.fields.length > 0 ? ` Fields: ${mode.fields.map(field => field.field).join(', ')}.` : ''}`);
    }
    lines.push('');
  }
  if (credential.note) lines.push(credential.note);
  if (credential.channel) {
    lines.push(`Chat channel \`${credential.channel.id}\`: it turns on once ${credential.channel.requiredFields.join(', ')} are filled.`);
  }
  for (const field of credential.fields.filter(item => item.writable)) {
    const notes = [
      field.required ? 'required' : 'optional',
      field.type,
      field.secret ? 'secret' : undefined,
      field.onlyInModes ? `only for ${field.onlyInModes.join('/')} mode` : undefined,
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
      description: 'List the skills a Wiro agent can have, with their monthly price, the skills they depend '
        + 'on and the credential each one needs. Use it to plan a custom build for deploy_agent or a skill '
        + 'change for apply_agent_skills. Without `name` it lists every skill with its title and price: look '
        + 'there for the service the user named (apply_agent_skills also answers an unknown name with close '
        + 'matches). Pass `name` with a skill name (or a credential or channel key such '
        + 'as "telegram") to get the exact fields the user must provide, with their labels, formats and setup '
        + 'help, so you know what to ask for before calling set_agent_credentials or connect_agent_oauth.',
      inputSchema: {
        name: z.string().min(1).max(100).optional()
          .describe('A skill name (for example "int-gmail-check") returns its price and the setup fields of every credential it needs. A credential or channel key (for example "telegram") returns that credential\'s setup and the ways it can connect.'),
        category: z.enum(['int', 'util']).optional()
          .describe('"int" for skills that connect to an outside service, "util" for helper skills.'),
        capability: z.string().max(100).optional()
          .describe('Only skills with this capability, for example "image_generation". include_capabilities lists the names.'),
        include_capabilities: z.boolean().default(false)
          .describe('Also return the list of capability names with descriptions.'),
        include_deprecated: z.boolean().default(false)
          .describe('Also return deprecated skills.'),
      },
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
    async ({ name, category, capability, include_capabilities, include_deprecated }, extra) => {
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
          const credentials: CredentialEntry[] = [];

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
              if (credential) credentials.push(toCredentialEntry(credential, entry.role));
            }
          } else {
            const credential = await readCredential(client, key, extra.signal);
            if (!credential || isPlatformCredentialKey(key)) {
              throw new ApiResultError(
                `No skill or credential is named "${key}". Call list_agent_skills without name to see every skill.`,
                [404],
                {},
              );
            }
            credentials.push(toCredentialEntry(credential, 'credential'));
          }

          const lines: string[] = [];
          for (const skill of skills) lines.push(`## Skill`, '', skillLine(skill));
          if (skills[0]?.dependsOn.length) lines.push('', `Also enables: ${skills[0].dependsOn.join(', ')}`);
          if (skills[0] && !skills[0].requiresCredentials) lines.push('', 'This skill needs no credentials.');
          for (const credential of credentials) lines.push('', ...setupLines(credential));
          lines.push('', PRICING_NOTE);

          return {
            content: [{ type: 'text' as const, text: lines.join('\n') }],
            structuredContent: {
              skills,
              channels: [],
              total: skills.length,
              ...(capabilities ? { capabilities } : {}),
              setup: { credentials: credentials.map(entry => entry.setup) },
              pricingNote: PRICING_NOTE,
            },
          };
        }

        const body = requireApiSuccess(
          await client.post<ApiEnvelope & { skills?: unknown; channels?: unknown }>('/Skills/List', {
            ...(category ? { category } : {}),
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
        for (const skill of skills) lines.push(skillLine(skill));
        if (channels.length > 0) {
          lines.push('', '### Chat channels', '', 'Channels are not skills. Each one turns on once its required fields are set with set_agent_credentials.');
          for (const channel of channels) lines.push(`- ${channel.title} (\`${channel.credentialKey}\`): ${channel.requiredFields.join(', ')}`);
        }
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
