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
  capitalized,
  CATEGORY_KEYS,
  changedBySchema,
  changedByText,
  CONTROL_SCOPES,
  controlsPageUrl,
  decisionReason,
  isCategory,
  readRuleList,
  resolveAgent,
  resolveMember,
  resolveProject,
  ruleSummary,
  SURFACE_DESCRIPTIONS,
  SURFACE_LABELS,
  SURFACES,
  targetArgument,
  targetText,
  toCheckedRun,
  toRuleDecisions,
  whoCanChange,
  type ControlsWorkspace,
  type Surface,
} from '../utils/controls.js';
import { jsonSpan, quotedSpan } from '../utils/quoted-text.js';
import { nextActionSchema, strictInput } from './schemas.js';

interface CheckContext {
  surface: Surface;
  project?: { id: string; name?: string; thisConnection?: boolean };
  member?: { uuid: string; name?: string };
  agent?: { guid: string; name?: string };
  /** A run through this connection, as no context was named. */
  thisConnection: boolean;
  /** Wiro did not say which surface this connection counts as, so api was assumed. */
  surfaceAssumed?: boolean;
  /** The run comes in with an API key that the call could not name, so that key's own rule is not part of the check. */
  keyLeftOut?: boolean;
}

const FIX_REASON = 'Shows what allowing this model in that rule changes; nothing changes without the user\'s yes.';

// Wiro's answer for a model it does not know, or a name that is not an owner/slug.
const UNKNOWN_MODEL = / is not a model on Wiro\.?$| is not a model's owner\/slug or id\.?$/i;

// The ways in that always come with an API key. A dashboard run has none, and an agent's run uses the agent's own.
const KEY_SURFACES: ReadonlySet<Surface> = new Set<Surface>(['api', 'mcp', 'llm-gateway', 'extension']);

function memberText(member: { uuid: string; name?: string }): string {
  return `team member ${member.name ? quotedSpan(member.name) : `with user id ${quotedSpan(member.uuid)}`}`;
}

function contextText(context: CheckContext): string {
  const surface = `surface \`${context.surface}\` (${SURFACE_DESCRIPTIONS[context.surface]})`;
  const key = context.project
    ? context.project.thisConnection
      ? `this connection's API key (project id ${quotedSpan(context.project.id)})`
      : `the API key of project ${context.project.name ? `${quotedSpan(context.project.name)} (id ${quotedSpan(context.project.id)})` : `id ${quotedSpan(context.project.id)}`}`
    : undefined;
  const withKey = key ? `, with ${key}` : '';
  if (context.agent) {
    const agent = context.agent.name ? `${quotedSpan(context.agent.name)} (guid ${quotedSpan(context.agent.guid)})` : `with guid ${quotedSpan(context.agent.guid)}`;
    return `a run that agent ${agent} starts${withKey}${context.member ? `, as ${memberText(context.member)}` : ''}`;
  }
  if (context.thisConnection) return `a run through this connection: ${surface}${withKey}${context.member ? `, as ${memberText(context.member)}` : ''}`;
  return `a run${context.member ? ` by ${memberText(context.member)}` : ''} through ${surface}${withKey}`;
}

export function registerCheckModelAccess(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'check_model_access',
    {
      title: 'Check whether Wiro Model Access rules allow a model',
      description: 'Check how the Model Access rules of the connected project\'s workspace decide one model for one '
        + 'run: rule by rule (the whole wallet\'s, the member\'s, the API key\'s, the surface\'s and the agent\'s), why '
        + 'each decides as it does (the model\'s own entry, one of its categories, or what the rule does with every '
        + 'model it does not name), and the refusal text a run would get (error code 92). Nothing runs and nothing is '
        + 'charged. With no member, project, surface or agent it checks a run through this connection. A way in that '
        + 'comes with an API key (api, mcp, llm-gateway, extension) is checked with this connection\'s key unless project '
        + 'names another, and a run with a key counts as the person who created that key. When the model is blocked and '
        + 'this connection can change the rules, nextAction is the change summary that would allow it in the first rule '
        + 'that blocks it.',
      inputSchema: strictInput({
        model: z.string().trim().min(1).max(200)
          .describe('The model, by owner/slug as search_models shows it, or by its id.'),
        member: z.string().trim().min(1).max(320).optional()
          .describe('Team only: the team member whose run to check, by e-mail or user id. Left out, the person who created the connected project. A run with an API key counts as the person who created the key, so with project or agent that person is checked.'),
        project: z.string().trim().min(1).max(200).optional()
          .describe('The API key the run uses, by its project id or exact name. Left out, this connection\'s own key when nothing else is named, or when surface is api, mcp, llm-gateway or extension and no member is named.'),
        surface: z.enum(SURFACES).optional()
          .describe('The way in: web (the dashboard), api (an API key, a local install of this server included), mcp (the hosted MCP server), llm-gateway, extension or agent. Left out, the surface this connection counts as when nothing else is named, api with a project, and web for a member.'),
        agent: z.string().trim().min(1).max(200).optional()
          .describe('A deployed agent, by name or guid: checks a run the agent starts (surface agent).'),
      }),
      outputSchema: {
        model: z.string().describe('The model\'s owner/slug, as Wiro names it.'),
        categories: z.array(z.enum(CATEGORY_KEYS)).describe('The model\'s categories.'),
        context: z.object({
          surface: z.enum(SURFACES),
          project: z.object({ id: z.string(), name: z.string().optional(), thisConnection: z.boolean().optional() }).optional(),
          member: z.object({ uuid: z.string(), name: z.string().optional() }).optional(),
          agent: z.object({ guid: z.string(), name: z.string().optional() }).optional(),
          thisConnection: z.boolean().describe('True for a run through this connection.'),
          keyLeftOut: z.boolean().optional().describe('True when the run comes in with an API key the call did not name, so that key\'s own rule is not part of this check.'),
        }).describe('The run Wiro checked. A run with an API key counts as the person who created the key.'),
        allowed: z.boolean(),
        message: z.string().nullable().describe('The refusal text a run would get, with error code 92; null when it is allowed.'),
        rules: z.array(z.object({
          guid: z.string().optional(),
          scope: z.enum(CONTROL_SCOPES),
          target: z.string().optional(),
          targetName: z.string().optional(),
          decides: z.enum(['allow', 'block']),
          by: z.enum(['model', 'category', 'default']).describe('What in the rule decides: the model\'s own entry, one of its categories, or what the rule gives every model it does not name.'),
          category: z.string().nullable(),
          summary: z.string(),
          updatedBy: changedBySchema.optional(),
        })).describe('Every rule that applies to this run, widest first.'),
        canManage: z.boolean().describe('Whether this connection can change the rules.'),
        fixes: z.array(nextActionSchema).optional()
          .describe('For each rule that blocks the model, the change summary that would allow it there. Every one must change for the model to run.'),
        nextAction: nextActionSchema.optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ model, member, project, surface, agent }, extra) => {
      try {
        const signal = extra.signal;
        if (agent !== undefined && surface !== undefined && surface !== 'agent') {
          throw new Error('A run an agent starts counts as surface agent: leave out surface, or leave out agent.');
        }
        if (surface === 'agent' && agent === undefined) {
          throw new Error('Surface agent is the runs a deployed agent starts: name the agent with `agent`.');
        }
        if (surface === 'web' && project !== undefined) {
          throw new Error('A dashboard run (surface web) uses no API key: leave out project, or pick the surface the key is used on.');
        }
        const list = await readRuleList(client, signal);
        const { workspace, caller, labels } = list;
        const canManage = workspace.canManage === true;

        const named = member !== undefined || project !== undefined || surface !== undefined || agent !== undefined;
        const keySurface = surface !== undefined && KEY_SURFACES.has(surface);
        const context: CheckContext = { surface: 'api', thisConnection: !named };
        if (agent !== undefined) {
          const found = await resolveAgent(client, agent, signal);
          context.agent = { guid: found.guid, ...(found.name ? { name: found.name } : {}) };
        }
        if (member !== undefined) {
          const found = await resolveMember(client, member, workspace, signal);
          context.member = { uuid: found.uuid, ...(found.name ? { name: found.name } : {}) };
        }
        // A run through the API, MCP, the LLM gateway or an extension always comes with a key: left out, this
        // connection's. A member's own key is not known, so for a member that key's rule stays out of the check.
        if (project !== undefined || !named || (keySurface && member === undefined)) {
          const found = await resolveProject(client, project, caller, signal);
          context.project = { id: found.id, ...(found.name ? { name: found.name } : {}), ...(found.connected ? { thisConnection: true } : {}) };
        } else if (keySurface) {
          context.keyLeftOut = true;
        }
        if (agent !== undefined) {
          context.surface = 'agent';
        } else if (surface !== undefined) {
          context.surface = surface;
        } else if (!named || context.project?.thisConnection) {
          context.surface = caller?.surface ?? 'api';
          if (!caller?.surface) context.surfaceAssumed = true;
        } else if (context.project) {
          context.surface = 'api';
        } else {
          context.surface = 'web';
        }

        let body: ApiEnvelope & { check?: unknown };
        try {
          body = requireApiSuccess(
            await client.post<ApiEnvelope & { check?: unknown }>('/ModelAccess/Check', {
              model,
              surface: context.surface,
              ...(context.member ? { member: context.member.uuid } : {}),
              ...(context.project ? { project: context.project.id } : {}),
              ...(context.agent ? { agent: context.agent.guid } : {}),
            }, signal),
            'The model could not be checked.',
          );
        } catch (error) {
          if (!signal.aborted && error instanceof ApiResultError && UNKNOWN_MODEL.test(error.message.trim())) {
            throw new Error(`${error.message.trim()} search_models finds a model's owner/slug.`);
          }
          throw error;
        }
        const check = isPlainObject(body.check) ? body.check : {};
        const modelName = asString(check.model)?.trim() || model;
        const categories = (Array.isArray(check.categories) ? check.categories : []).filter(isCategory);
        const checked = toRuleDecisions(check.rules);
        // A rule that blocks decides the run, whatever Wiro's own flag says.
        const allowed = check.allowed === true && !checked.some(entry => entry.decides === 'block');
        const message = allowed ? null : asString(check.message)?.trim() || null;
        const blocking = checked.filter(entry => entry.decides === 'block');

        // Wiro says which run it checked: a key, an agent's included, acts as the person who created it.
        const asked = context.member;
        const run = toCheckedRun(check.context);
        if (run) {
          const ours = context.project?.id === run.project?.id ? context.project : undefined;
          context.surface = run.surface;
          context.member = run.member;
          if (run.project) {
            const projectName = run.project.name ?? ours?.name;
            context.project = {
              id: run.project.id,
              ...(projectName ? { name: projectName } : {}),
              ...(caller?.projectId === run.project.id || ours?.thisConnection ? { thisConnection: true } : {}),
            };
          } else {
            context.project = undefined;
          }
          if (run.agent) context.agent = run.agent;
        }
        const otherPerson = asked && context.member && asked.uuid.toLowerCase() !== context.member.uuid.toLowerCase() ? asked : undefined;

        const fixes = !allowed && canManage
          ? blocking.map(entry => ({
            tool: 'manage_model_access',
            arguments: {
              action: 'update',
              scope: entry.rule.scope,
              ...targetArgument(entry.rule.scope, entry.rule.target),
              models: [{ model: modelName, access: 'allow' }],
            },
            reason: FIX_REASON,
          }))
          : [];

        const kind: ControlsWorkspace['kind'] = workspace.kind;
        const lines = [`## Model Access check: ${quotedSpan(modelName)}`, '', `**Run checked:** ${contextText(context)}`];
        if (categories.length > 0) lines.push(`**Categories of this model:** ${categories.map(key => labels[key]).join(', ')}`);
        if (context.surfaceAssumed) {
          lines.push('Wiro did not say which surface this connection counts as, so this checked api. A connection to the hosted server counts as mcp: check again with surface mcp for that.');
        }
        if (otherPerson && context.member) {
          lines.push(`A run with an API key counts as the person who created the key, so this checked a run by ${memberText(context.member)}, `
            + `not by ${memberText(otherPerson)}. For that member's own runs, name a key they created with project, or leave out project and agent.`);
        }
        if (context.keyLeftOut) {
          lines.push(`A run through ${SURFACE_LABELS[context.surface]} comes with an API key, and that key's own rule is not part of this check. `
            + 'A key counts as the person who created it: to include its rule, name a key this member created with project.');
        }
        lines.push('');
        if (allowed) {
          lines.push(checked.length === 0
            ? '**Allowed.** No Model Access rule applies to this run, so every model can run.'
            : '**Allowed.** Every rule that applies to this run allows it.');
        } else {
          lines.push(`**Blocked.** Wiro refuses such a run with error code 92 before it starts${message ? `: ${message}` : '.'}`);
        }
        if (checked.length > 0) {
          lines.push('', `**Rules that apply (${checked.length}), widest first:**`);
          for (const entry of checked) {
            const view = { scope: entry.rule.scope, target: entry.rule.target, targetName: entry.rule.targetName };
            const changed = changedByText(entry.rule, kind, caller);
            lines.push(`- Rule for ${targetText(view, kind)}: ${entry.decides === 'block' ? 'blocks' : 'allows'} it, as it `
              + `${decisionReason(entry, labels)}. The rule: ${ruleSummary(entry.rule, labels, { quote: true, maxModels: 10 })}.`
              + `${changed ? ` ${capitalized(changed)}.` : ''}`);
          }
        }
        if (!allowed) {
          lines.push('');
          if (blocking.length > 1) {
            lines.push(`${blocking.length} rules block it, and every rule that applies must allow a model, so each of them must change: a narrower rule cannot open what a wider one blocks.`);
          }
          lines.push(canManage
            ? 'This connection can change the rules, after the user confirms a change summary. A model the rules allow is the other way out.'
            : `This connection can only read the rules: ${whoCanChange(kind)} can change them, with their own connection or at ${controlsPageUrl('model-access', workspace)}. Or the user can pick another model.`);
        }
        const nextAction = fixes[0];
        if (nextAction) lines.push('', `**Next:** \`${nextAction.tool}\` with ${jsonSpan(nextAction.arguments)}. ${nextAction.reason}`);

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: {
            model: modelName,
            categories,
            context: {
              surface: context.surface,
              ...(context.project ? { project: context.project } : {}),
              ...(context.member ? { member: context.member } : {}),
              ...(context.agent ? { agent: context.agent } : {}),
              thisConnection: context.thisConnection,
              ...(context.keyLeftOut ? { keyLeftOut: true } : {}),
            },
            allowed,
            message,
            rules: checked.map(entry => ({
              ...(entry.rule.guid ? { guid: entry.rule.guid } : {}),
              scope: entry.rule.scope,
              ...(entry.rule.scope !== 'account' ? { target: entry.rule.target } : {}),
              ...(entry.rule.targetName ? { targetName: entry.rule.targetName } : {}),
              decides: entry.decides,
              by: entry.by,
              category: entry.category,
              summary: ruleSummary(entry.rule, labels),
              ...(entry.rule.updatedBy ? { updatedBy: entry.rule.updatedBy } : {}),
            })),
            canManage,
            ...(fixes.length > 0 ? { fixes, nextAction } : {}),
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
