import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import {
  ApiResultError,
  asString,
  errorResult,
  errorText,
  hasErrorCode,
  MODEL_ACCESS_CODE,
  modelAccessAdvice,
  requireApiSuccess,
  type ApiEnvelope,
  type RefusalNoteOptions,
} from '../utils/api.js';
import { answeredLive, LIVE_CHANGE_NOTE, pausedSkillTitles } from '../utils/agent-config.js';
import { CHAT_SETUP_DESCRIPTION, CHAT_SETUP_MODES } from '../utils/agent-setup.js';
import { DEFAULT_WAIT_SECONDS } from '../utils/poll.js';
import {
  activeSkillTitles,
  agentDetailSchema,
  formatAgentDetail,
  nextStepForAgent,
  readAgentDetail,
  readAgentStatus,
  selectableModelSlugs,
  startNeedsPlan,
  toAgentDetail,
} from '../utils/user-agent.js';
import { nextActionSchema, strictInput } from './schemas.js';

// A new name Wiro applied to the running agent with no restart. Of the profile fields, only the title reaches it.
const LIVE_NAME_NOTE = 'The running agent uses the new name from its next message, with no restart.';

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

export function registerUpdateAgent(server: McpServer, client: WiroClient, notes: RefusalNoteOptions = {}): void {
  server.registerTool(
    'update_agent',
    {
      title: 'Update a Wiro agent',
      description: 'Change a deployed agent\'s name, description, cover or categories, and its settings: '
        + 'timezone (used by scheduled tasks), team session mode, the models used for chat, scheduled tasks '
        + 'and voice calls, which slash commands are available, and setup from chat (chat_setup). Only the fields you pass change. On a '
        + 'running or starting agent, a setting that changes restarts it to apply the change, which takes a minute or '
        + 'two; a new name reaches a running agent from its next message, with no restart, and a new description, '
        + 'cover or categories, a setting it already has, or chat_setup moved between "all" and "webchat" leaves it '
        + 'running. The result says which happened. Calling it with '
        + 'only agent_guid refreshes the setup status of an agent waiting for setup, after its credentials were set. Skills, credentials and '
        + 'custom instructions have their own tools (apply_agent_skills, set_agent_credentials, '
        + 'manage_agent_custom_skill). On a team agent this needs a team admin or the person who deployed it; '
        + 'other team members can read the agent with get_my_agent and message it.',
      inputSchema: strictInput({
        agent_guid: z.string().min(1).max(100)
          .describe('The deployed agent\'s guid, from list_my_agents or deploy_agent.'),
        title: z.string().trim().min(1).max(200).optional()
          .describe('New name.'),
        description: z.string().max(5_000).nullable().optional()
          .describe('New description; null clears it.'),
        cover: z.url().max(2_048).nullable().optional()
          .describe('New https cover image URL; null goes back to the template cover.'),
        categories: z.array(z.string().min(1).max(100)).min(1).max(20).optional()
          .describe('New category list (at least one).'),
        timezone: z.string().max(100).nullable().optional()
          .describe('IANA timezone such as "Europe/Istanbul" for scheduled tasks; null or "UTC" means UTC.'),
        team_session_mode: z.enum(['private', 'collaborative']).optional()
          .describe('private gives each person their own chat history; collaborative shares one history in team chats.'),
        chat_model: z.string().max(200).nullable().optional()
          .describe('Model for chat turns: a slug from the model list in get_my_agent, which shows what each model costs in USD per 1M tokens. null resets to the default. The plan price stays the same.'),
        cron_model: z.string().max(200).nullable().optional()
          .describe('Model for scheduled tasks; same rules as chat_model.'),
        voice_prep_model: z.string().max(200).nullable().optional()
          .describe('Model that prepares voice calls; same rules as chat_model.'),
        voice_postcall_model: z.string().max(200).nullable().optional()
          .describe('Model that summarizes voice calls; same rules as chat_model.'),
        enabled_commands: z.array(z.string().min(1).max(100)).max(50).optional()
          .describe(`Slash commands the agent offers; [] hides all of them. Commands today: ${COMMANDS.join(', ')}.`),
        chat_setup: z.enum(CHAT_SETUP_MODES).nullable().optional()
          .describe(`${CHAT_SETUP_DESCRIPTION} null goes back to the default, "all".`),
      }),
      outputSchema: {
        agent: agentDetailSchema,
        changed: z.array(z.string()),
        restarted: z.boolean(),
        live: z.boolean().optional()
          .describe('true when the running agent got the change with no restart, as Wiro answers it.'),
        message: z.string(),
        nextAction: nextActionSchema.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
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
        if (args.chat_setup !== undefined) {
          settings.chatsetup = args.chat_setup;
          settingNames.push('chat_setup');
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

        // An Update that names no field restarts a running agent, so it is only
        // sent with profile fields, or with none to finish the setup of a status
        // 6 agent. Among the profile fields, only a changed title reaches a running
        // agent: live, or with a restart from a Wiro that does not apply it live.
        const sendProfile = Object.keys(profile).length > 0 || previous === 6;
        const sendSettings = Object.keys(settings).length > 0;
        if (!sendProfile && !sendSettings) {
          throw new Error('Nothing to update. Pass at least one field to change.');
        }

        const running = previous === 3 || previous === 4;
        const changed: string[] = [];
        let restarting: unknown;
        let profileLive = false;
        if (sendProfile) {
          try {
            const answer = requireApiSuccess(
              await client.post<ApiEnvelope & { restarting?: unknown; live?: unknown }>('/UserAgent/Update', { guid, ...profile }, extra.signal),
              'The agent could not be updated.',
            );
            restarting = answer.restarting;
            profileLive = answeredLive(answer);
          } catch (error) {
            // An answer that says whether the agent restarts means the change was saved.
            if (!(error instanceof ApiResultError) || typeof error.body.restarting !== 'boolean') throw error;
            restarting = error.body.restarting;
            profileLive = answeredLive(error.body);
          }
          changed.push(...Object.keys(profile));
        }
        // An answer without the field goes by the status read before the update. A new name a running agent got live
        // restarts nothing.
        const profileRestarts = sendProfile && !profileLive && (restarting === true || (restarting === undefined && running));
        const profileLiveNote = profile.title !== undefined ? LIVE_NAME_NOTE : LIVE_CHANGE_NOTE;
        let settingsAnswer: { restart?: unknown; live?: unknown } = {};
        if (sendSettings) {
          try {
            settingsAnswer = requireApiSuccess(
              await client.post<ApiEnvelope & { restart?: unknown; live?: unknown }>('/UserAgent/UpdateSettings', { useragentguid: guid, ...settings }, extra.signal),
              'The agent settings could not be updated.',
            );
          } catch (error) {
            // A Model Access rule (such as the agent's own) blocks a model it was given.
            const blocked = hasErrorCode(error, MODEL_ACCESS_CODE);
            if (changed.length === 0 && !blocked) throw error;
            const reason = blocked ? `${errorText(error)} ${modelAccessAdvice(notes)}` : errorText(error);
            if (changed.length === 0) throw new Error(`${reason}\n\nThe settings were not saved.`);
            throw new Error(`${reason}\n\nThe ${changed.join(', ')} change was saved; the settings were not.`
              + (profileRestarts ? ' The agent restarts to apply the saved change.' : profileLive ? ` ${profileLiveNote}` : ''));
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
        // UpdateSettings restarts a running agent only when a setting moves. A Wiro that applies changes live says
        // what it did (restart). Otherwise it sets the agent stopping before it answers: read back still starting or
        // running, nothing moved. Without the read it is not known.
        const afterStatus = readFailed ? null : readAgentStatus(after);
        const settingsOutcome = asString(settingsAnswer.restart);
        const settingsLive = sendSettings && running && answeredLive(settingsAnswer);
        const settingsRestart: boolean | null = !(sendSettings && running)
          ? false
          : settingsOutcome === 'scheduled'
            ? true
            : settingsOutcome === 'live' || settingsOutcome === 'none'
              ? false
              : afterStatus === null ? null : afterStatus !== 3 && afterStatus !== 4;
        const restarted = profileRestarts || settingsRestart === true;
        const live = !restarted && (profileLive || settingsLive);
        const mayRestart = !restarted && settingsRestart === null;
        // Without the read-back the row is from before the change: the saved fields
        // go over it, a changed model is left out, and a restart leaves the status unknown.
        const agent = toAgentDetail(readFailed
          ? {
            ...before,
            ...profile,
            ...settings,
            ...(settings.enabledcommands !== undefined ? { enabledCommands: settings.enabledcommands } : {}),
            // The value in effect is not known without the read: a house agent keeps it off.
            ...(settings.chatsetup !== undefined ? { chatSetup: undefined } : {}),
            ...(settingNames.some(name => name in MODEL_FIELDS) ? { agentModel: undefined } : {}),
            ...(restarted || mayRestart ? { status: null } : {}),
          }
          : after);
        const setupFinished = previous === 6 && agent.status !== 6;
        const message = [
          changed.length > 0 ? `Saved: ${changed.join(', ')}.` : 'Setup status refreshed.',
          restarted ? 'The agent restarts to apply the change.' : live ? (profileLive && !settingsLive ? profileLiveNote : LIVE_CHANGE_NOTE) : '',
          mayRestart ? 'If a setting changed, the agent restarts to apply it.' : !restarted && !live && running ? 'The agent keeps running.' : '',
          setupFinished
            ? `Setup is complete; the agent ${startNeedsPlan(agent) ? 'needs an active plan before it can start' : 'can be started'}.`
            : '',
          previous === 6 && agent.status === 6 && agent.missingCredentials.length > 0
            ? `Setup is still waiting for: ${agent.missingCredentials.map(item => item.title).join(', ')}.`
            : '',
          readFailed ? 'The updated agent could not be read back; get_my_agent shows the new state.' : '',
        ].filter(Boolean).join(' ');
        const nextAction = restarted || mayRestart
          ? {
            tool: 'get_my_agent',
            arguments: { agent_guid: guid, wait_seconds: DEFAULT_WAIT_SECONDS },
            reason: restarted ? 'Wait until the agent is running again.' : 'See whether the agent restarted, and wait until it is running.',
          }
          : nextStepForAgent(agent, DEFAULT_WAIT_SECONDS);
        const titles = new Map([...activeSkillTitles(after), ...await pausedSkillTitles(client, agent.scheduledTasks, extra.signal)]);

        return {
          content: [{ type: 'text' as const, text: `${message}\n\n${formatAgentDetail(agent, false, titles)}` }],
          structuredContent: {
            agent,
            changed,
            restarted,
            ...(live ? { live } : {}),
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
