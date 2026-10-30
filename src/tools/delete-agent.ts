import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import {
  ApiResultError,
  errorResult,
  isPlainObject,
  requireApiSuccess,
  unixToIso,
  type ApiEnvelope,
} from '../utils/api.js';
import { DEFAULT_WAIT_SECONDS } from '../utils/poll.js';
import {
  agentStatusLabel,
  agentStatusLabelSchema,
  describeAgentStatus,
  readAgentDetail,
  readAgentStatus,
  toAgentDetail,
  type NextAction,
} from '../utils/user-agent.js';
import { nextActionSchema } from './schemas.js';

export function registerDeleteAgent(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'delete_agent',
    {
      title: 'Delete a Wiro agent',
      description: 'Delete a deployed agent. This cannot be undone: the agent disappears from every list at '
        + 'once, its data is removed later and there is no restore. The order is: cancel the plan with manage_agent_billing (no '
        + 'refund for the rest of the period), stop the agent with control_agent, then delete it. Without '
        + 'confirm: true the tool only checks what is still in the way and describes the deletion; repeat '
        + 'the call with confirm: true after the user agrees.',
      inputSchema: {
        agent_guid: z.string().min(1).max(100)
          .describe('The deployed agent\'s guid, from list_my_agents.'),
        confirm: z.boolean().default(false)
          .describe('false only checks and describes the deletion. true deletes the agent. Set it only after the user agreed.'),
      },
      outputSchema: {
        agentGuid: z.string(),
        title: z.string(),
        deleted: z.boolean(),
        deletedAt: z.string().optional(),
        status: z.number().int().nullable(),
        statusLabel: agentStatusLabelSchema,
        blockers: z.array(z.string()),
        message: z.string(),
        nextAction: nextActionSchema.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ agent_guid, confirm }, extra) => {
      try {
        const guid = agent_guid.trim();
        const row = await readAgentDetail(client, guid, extra.signal);
        const agent = toAgentDetail(row);
        const status = readAgentStatus(row);
        const subscription = isPlainObject(row.subscription) ? row.subscription : null;

        const blockers: string[] = [];
        let nextAction: NextAction | undefined;
        // A wallet plan that was already cancelled cannot charge again, so it does not block.
        const planBlocks = subscription?.status === 'active'
          && !(subscription.provider === 'prepaid' && subscription.pendingdowngrade === 'cancel');
        if (planBlocks) {
          if (subscription?.provider === 'prepaid') {
            blockers.push('The plan is still active. Cancel it first with manage_agent_billing action cancel; the rest of the paid period is not refunded.');
            nextAction = {
              tool: 'manage_agent_billing',
              arguments: { agent_guid: guid, action: 'cancel' },
              reason: 'Cancel the plan before deleting the agent.',
            };
          } else {
            blockers.push(`The plan is billed by card and still active. It has to end first; cancel it from the dashboard (${agent.dashboardUrl}) and delete the agent after the period ends.`);
          }
        }
        if (status === 1 || status === 2 || status === 3 || status === 4) {
          blockers.push(`The agent is ${describeAgentStatus(status).toLowerCase()}. Stop it with control_agent and wait until it is stopped.`);
          nextAction ??= {
            tool: 'control_agent',
            arguments: { agent_guid: guid, action: 'stop', wait_seconds: DEFAULT_WAIT_SECONDS },
            reason: 'Stop the agent before deleting it.',
          };
        }

        const base = {
          agentGuid: guid,
          title: agent.title,
          status,
          statusLabel: agentStatusLabel(status),
          blockers,
        };

        if (blockers.length > 0) {
          const message = `The agent cannot be deleted yet.\n\n${blockers.map(item => `- ${item}`).join('\n')}`;
          return {
            content: [{ type: 'text' as const, text: `## Delete ${agent.title}: blocked\n\n${message}` }],
            structuredContent: { ...base, deleted: false, message, ...(nextAction ? { nextAction } : {}) },
          };
        }

        if (!confirm) {
          const forfeit = subscription?.status === 'active'
            ? ' Its cancelled plan is still paid until the period ends; that time is lost and not refunded.'
            : '';
          const message = `Deleting ${agent.title} (${guid}) removes it from every list at once and cannot be undone.${forfeit}`;
          return {
            content: [{ type: 'text' as const, text: `## Delete ${agent.title}: confirm first\n\n${message}\n\nCall delete_agent again with confirm: true after the user agrees.` }],
            structuredContent: {
              ...base,
              deleted: false,
              message,
              nextAction: {
                tool: 'delete_agent',
                arguments: { agent_guid: guid, confirm: true },
                reason: 'Ask the user to confirm the deletion first. It cannot be undone.',
              },
            },
          };
        }

        let body: ApiEnvelope & { useragent?: unknown };
        try {
          body = requireApiSuccess(
            await client.post<ApiEnvelope & { useragent?: unknown }>('/UserAgent/Delete', { useragentguid: guid }, extra.signal),
            'The agent could not be deleted.',
          );
        } catch (error) {
          if (error instanceof ApiResultError && /stop the agent/i.test(error.message)) {
            const message = 'The agent still has a process running on its agent host. Stop it with control_agent, wait until it is stopped, then delete it.';
            return {
              content: [{ type: 'text' as const, text: `## Delete ${agent.title}: blocked\n\n${message}` }],
              structuredContent: {
                ...base,
                deleted: false,
                blockers: [message],
                message,
                nextAction: {
                  tool: 'control_agent',
                  arguments: { agent_guid: guid, action: 'stop', wait_seconds: DEFAULT_WAIT_SECONDS },
                  reason: 'Stop the agent before deleting it.',
                },
              },
            };
          }
          throw error;
        }
        const deletedAt = isPlainObject(body.useragent) ? unixToIso(body.useragent.deletedat) : undefined;
        const message = `${agent.title} was deleted. It no longer appears in any list and cannot be restored.`;
        return {
          content: [{ type: 'text' as const, text: `## Deleted\n\n${message}` }],
          structuredContent: {
            ...base,
            deleted: true,
            ...(deletedAt ? { deletedAt } : {}),
            message,
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
