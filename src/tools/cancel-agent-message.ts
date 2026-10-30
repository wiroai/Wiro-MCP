import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { apiErrorMessage, errorResult } from '../utils/api.js';
import {
  agentMessageSchema,
  formatAgentMessage,
  messageStateSchema,
  type AgentMessage,
} from '../utils/agent-message.js';
import {
  AGENT_INPUT_DESCRIPTION,
  agentRequestBody,
  callAgent,
  readAgentMessage,
  resolveAgentTarget,
  resolveReadSession,
} from '../utils/agent-targets.js';
import { notFoundMessage, projectAgentMessage } from '../utils/agent-turns.js';

// The cancel is written at once, but a turn that is already finishing can still
// end normally, so the result is read back after a short pause.
const READ_BACK_DELAY_MS = 1_500;

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      const error = new Error('The wait was cancelled by the client');
      error.name = 'AbortError';
      reject(error);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function registerCancelAgentMessage(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'cancel_agent_message',
    {
      title: 'Cancel an agent message',
      description: 'Stop a turn that Studio, the Workflow Agent or one of your deployed agents is still working '
        + 'on. Only queued or running turns can be cancelled; a finished turn is reported as it ended. The turn '
        + 'can still finish normally if it was already completing, so the final status is read back and '
        + 'returned. Usage up to the cancel stays billed. For Studio, model runs the turn already started keep '
        + 'running and cannot be stopped from here; list_studio_results shows them.',
      inputSchema: {
        agent: z.string().min(1).describe(AGENT_INPUT_DESCRIPTION),
        message_id: z.string().min(1).describe('The message id from send_agent_message.'),
        session: z.string().optional().describe('The session the message was sent in. Required for Studio and '
          + 'the Workflow Agent unless it was "default".'),
      },
      outputSchema: {
        agent: z.string(),
        agentKind: z.enum(['studio', 'workflow-agent', 'deployed']),
        session: z.string().optional(),
        messageId: z.string(),
        cancelAccepted: z.boolean(),
        finalStatus: z.string().optional(),
        finalState: messageStateSchema.optional(),
        message: agentMessageSchema.optional(),
        notes: z.array(z.string()),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ agent, message_id, session }, extra) => {
      try {
        const target = resolveAgentTarget(agent);
        const readSession = resolveReadSession(target, session);
        const response = await callAgent(
          client,
          target,
          'cancel',
          agentRequestBody(target, readSession, { messageguid: message_id }),
          extra.signal,
        );
        const notes: string[] = [];
        const base = {
          agent: target.agent,
          agentKind: target.kind,
          ...(readSession !== undefined ? { session: readSession } : {}),
          messageId: message_id,
        };

        if (response.result !== true) {
          const text = apiErrorMessage(response, 'The message could not be cancelled.');
          const ended = /cannot be cancelled \(status: ([A-Za-z_]+)\)/i.exec(text);
          if (!ended) {
            if (/message not found/i.test(text)) throw new Error(notFoundMessage(target));
            throw new Error(text);
          }
          const status = ended[1]!;
          notes.push(`The turn had already ended (${status}); there was nothing to cancel.`);
          return {
            content: [{ type: 'text' as const, text: `## Nothing to cancel\n\nThe turn had already ended with status ${status}.` }],
            structuredContent: { ...base, cancelAccepted: false, finalStatus: status, notes },
          };
        }

        let message: AgentMessage | undefined;
        try {
          await delay(READ_BACK_DELAY_MS, extra.signal);
          const row = await readAgentMessage(client, target, message_id, readSession, extra.signal);
          message = projectAgentMessage(target, row, false).message;
        } catch (error) {
          if (extra.signal.aborted) throw error;
          notes.push('The final status could not be read back. Check it with get_agent_message.');
        }
        if (message && message.status !== 'agent_cancel') {
          notes.push(message.state === 'running' || message.state === 'submitted'
            ? 'The cancel was accepted but the turn has not stopped yet. Check again with get_agent_message.'
            : `The turn finished anyway, with status ${message.status}.`);
        }
        if (target.kind === 'studio') {
          notes.push('Model runs this turn already started keep running and are billed if they succeed. '
            + 'list_studio_results shows them.');
        }

        const lines = ['## Cancel requested', ''];
        if (message) lines.push(formatAgentMessage(message, 'Reply so far'));
        for (const note of notes) lines.push(`- ${note}`);
        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: {
            ...base,
            cancelAccepted: true,
            ...(message ? { finalStatus: message.status, finalState: message.state, message } : {}),
            notes,
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
