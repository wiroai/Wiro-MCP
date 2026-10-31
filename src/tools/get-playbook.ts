import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  PLAYBOOK_SUMMARIES,
  PLAYBOOK_TITLES,
  PLAYBOOK_TOPICS,
  PLAYBOOKS,
} from '../playbooks.js';

const topicSchema = z.enum(PLAYBOOK_TOPICS);

const topicList = PLAYBOOK_TOPICS
  .map(topic => `${topic} (${PLAYBOOK_SUMMARIES[topic]})`)
  .join('; ');

export function registerGetPlaybook(server: McpServer): void {
  server.registerTool(
    'get_playbook',
    {
      title: 'Read a Wiro playbook',
      description: 'Read Wiro playbooks: short guides with the order of calls, '
        + 'the formats and the money rules for one kind of job. Read the '
        + 'relevant topic before a multi-step job, such as building or running '
        + 'a workflow, deploying or setting up an agent, or a Studio session, '
        + 'and follow it. Read getting-started before the first workflow, Studio, '
        + 'agent or billing job in a conversation; for a job that only uses models, '
        + `the models topic is enough. Topics: ${topicList}. `
        + 'Several topics can be read in one call.',
      inputSchema: {
        topics: z.array(topicSchema).min(1)
          .describe('One or more playbook topics to read, e.g. ["workflows"] or ["agents", "billing"].'),
      },
      outputSchema: {
        topics: z.array(z.object({
          topic: topicSchema,
          title: z.string(),
          markdown: z.string(),
        })),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        // The guides ship inside the package; nothing outside the server is read.
        openWorldHint: false,
      },
    },
    async ({ topics }) => {
      const entries = [...new Set(topics)].map(topic => ({
        topic,
        title: PLAYBOOK_TITLES[topic],
        markdown: PLAYBOOKS[topic],
      }));
      return {
        content: [{
          type: 'text' as const,
          text: entries.map(entry => entry.markdown.trim()).join('\n\n---\n\n'),
        }],
        structuredContent: { topics: entries },
      };
    },
  );
}
