import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { errorResult, errorText, requireApiSuccess } from '../utils/api.js';
import { DEFAULT_WAIT_SECONDS } from '../utils/poll.js';
import {
  agentDetailSchema,
  formatAgentDetail,
  nextStepForAgent,
  readAgentDetail,
  readAgentStatus,
  selectableModelSlugs,
  toAgentDetail,
} from '../utils/user-agent.js';
import { nextActionSchema } from './schemas.js';

const COMMANDS = [
  'agent_help',
  'new_session',
  'agent_status',
  'agent_limits',
  'last_scan',
  'last_heartbeat',
  'agent_restart',
  'clear_all_sessions',
  'clear_history',
];

const MODEL_FIELDS = {
  chat_model: 'chatmodel',
  cron_model: 'cronmodel',
  voice_prep_model: 'voiceprepmodel',
  voice_postcall_model: 'voicepostcallmodel',
} as const;

export function registerUpdateAgent(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'update_agent',
    {
      title: 'Update a Wiro agent',
      description: 'Change a deployed agent\'s name, description, cover or categories, and its settings: '
        + 'timezone (used by scheduled tasks), team session mode, the models used for chat, scheduled tasks '
        + 'and voice calls, and which slash commands are available. Only the fields you pass change. A '
        + 'running or starting agent restarts to apply the change. Calling it with only agent_guid re-checks '
        + 'the setup of an agent waiting for setup, after its credentials were set. Skills, credentials and '
        + 'custom instructions have their own tools (apply_agent_skills, set_agent_credentials, '
        + 'manage_agent_custom_skill).',
      inputSchema: {
        agent_guid: z.string().min(1).max(100)
          .describe('The deployed agent\'s guid, from list_my_agents or deploy_agent.'),
        title: z.string().trim().min(1).max(200).optional()
          .describe('New name.'),
        description: z.string().max(5_000).nullable().optional()
          .describe('New description; null clears it.'),
        cover: z.string().url().max(2_048).nullable().optional()
          .describe('New https cover image URL; null goes back to the template cover.'),
        categories: z.array(z.string().min(1).max(100)).min(1).max(20).optional()
          .describe('New category list (at least one).'),
        timezone: z.string().max(100).nullable().optional()
          .describe('IANA timezone such as "Europe/Istanbul" for scheduled tasks; null or "UTC" means UTC.'),
        team_session_mode: z.enum(['private', 'collaborative']).optional()
          .describe('private gives each person their own chat history; collaborative shares one history in team chats.'),
        chat_model: z.string().max(200).nullable().optional()
          .describe('Model for chat turns: a slug from the model list in get_my_agent, which shows each model\'s credits per 1M tokens. null resets to the default. The plan price stays the same.'),
        cron_model: z.string().max(200).nullable().optional()
          .describe('Model for scheduled tasks; same rules as chat_model.'),
        voice_prep_model: z.string().max(200).nullable().optional()
          .describe('Model that prepares voice calls; same rules as chat_model.'),
        voice_postcall_model: z.string().max(200).nullable().optional()
          .describe('Model that summarizes voice calls; same rules as chat_model.'),
        enabled_commands: z.array(z.string().min(1).max(100)).max(50).optional()
          .describe(`Slash commands the agent offers; [] hides all of them. Commands today: ${COMMANDS.join(', ')}.`),
      },
      outputSchema: {
        agent: agentDetailSchema,
        changed: z.array(z.string()),
        restarted: z.boolean(),
        message: z.string(),
        nextAction: nextActionSchema.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      try {
        const guid = args.agent_guid.trim();
        const before = await readAgentDetail(client, guid, extra.signal);
        const previous = readAgentStatus(before);

        const profile: Record<string, unknown> = {};
        if (args.title !== undefined) profile.title = args.title;
        if (args.description !== undefined) profile.description = args.description;
        if (args.cover !== undefined) profile.cover = args.cover;
        if (args.categories !== undefined) profile.categories = args.categories;

        const settings: Record<string, unknown> = {};
        const settingNames: string[] = [];
        if (args.timezone !== undefined) {
          settings.timezone = args.timezone;
          settingNames.push('timezone');
        }
        if (args.team_session_mode !== undefined) {
          settings.teamsessionmode = args.team_session_mode;
          settingNames.push('team_session_mode');
        }
        if (args.enabled_commands !== undefined) {
          settings.enabledcommands = [...new Set(args.enabled_commands)];
          settingNames.push('enabled_commands');
        }
        const selectable = selectableModelSlugs(before);
        for (const [input, field] of Object.entries(MODEL_FIELDS) as Array<[keyof typeof MODEL_FIELDS, string]>) {
          const value = args[input];
          if (value === undefined) continue;
          if (value !== null && value !== '' && selectable.size > 0 && !selectable.has(value)) {
            throw new Error(`${input} "${value}" is not a selectable model. Choose one of: ${[...selectable].join(', ')}.`);
          }
          settings[field] = value === '' ? null : value;
          settingNames.push(input);
        }

        // An update restarts a running agent, so it is only sent for profile
        // fields or to finish the setup of a status 6 agent.
        const sendProfile = Object.keys(profile).length > 0 || previous === 6;
        const sendSettings = Object.keys(settings).length > 0;
        if (!sendProfile && !sendSettings) {
          throw new Error('Nothing to update. Pass at least one field to change.');
        }

        const changed: string[] = [];
        if (sendProfile) {
          requireApiSuccess(
            await client.post('/UserAgent/Update', { guid, ...profile }, extra.signal),
            'The agent could not be updated.',
          );
          changed.push(...Object.keys(profile));
        }
        if (sendSettings) {
          try {
            requireApiSuccess(
              await client.post('/UserAgent/UpdateSettings', { useragentguid: guid, ...settings }, extra.signal),
              'The agent settings could not be updated.',
            );
          } catch (error) {
            if (changed.length === 0) throw error;
            throw new Error(`${errorText(error)}\n\nThe ${changed.join(', ')} change was saved; the settings were not.`);
          }
          changed.push(...settingNames);
        }

        let after = before;
        let readFailed = false;
        try {
          after = await readAgentDetail(client, guid, extra.signal);
        } catch {
          // The change was saved; only the follow-up read failed.
          readFailed = true;
        }
        const agent = toAgentDetail(after);
        const restarted = previous === 3 || previous === 4;
        const setupFinished = previous === 6 && agent.status !== 6;
        const message = [
          changed.length > 0 ? `Saved: ${changed.join(', ')}.` : 'Setup re-checked.',
          restarted ? 'The agent restarts to apply the change.' : '',
          setupFinished ? 'Setup is complete; the agent can be started.' : '',
          previous === 6 && agent.status === 6 && agent.missingCredentials.length > 0
            ? `Setup is still waiting for: ${agent.missingCredentials.map(item => item.title).join(', ')}.`
            : '',
          readFailed ? 'The updated agent could not be read back; get_my_agent shows the new state.' : '',
        ].filter(Boolean).join(' ');
        const nextAction = restarted
          ? {
            tool: 'get_my_agent',
            arguments: { agent_guid: guid, wait_seconds: DEFAULT_WAIT_SECONDS },
            reason: 'Wait until the agent is running again.',
          }
          : nextStepForAgent(agent, DEFAULT_WAIT_SECONDS);

        return {
          content: [{ type: 'text' as const, text: `${message}\n\n${formatAgentDetail(agent)}` }],
          structuredContent: {
            agent,
            changed,
            restarted,
            message,
            ...(nextAction ? { nextAction } : {}),
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
