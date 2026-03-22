import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const DOCS_URL = 'https://wiro.ai/docs/llms.txt';

export function registerSearchDocs(server: McpServer): void {
  server.tool(
    'search_docs',
    'Search the Wiro documentation for guides, API references, examples, and how-to information. Returns relevant sections from the docs.',
    {
      query: z.string().describe('What you\'re looking for, e.g. "how to upload a file", "websocket", "authentication", "LLM streaming"'),
    },
    async ({ query }) => {
      try {
        const response = await fetch(DOCS_URL);
        if (!response.ok) {
          throw new Error(`Failed to fetch docs: ${response.status}`);
        }
        const content = await response.text();

        const sections = splitSections(content);
        const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 2);
        const scored = sections.map(s => ({
          ...s,
          score: scoreSection(s, keywords),
        }));

        const matches = scored
          .filter(s => s.score > 0)
          .sort((a, b) => b.score - a.score);

        if (matches.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `No documentation found matching "${query}".\n\nFull documentation: https://wiro.ai/docs`,
            }],
          };
        }

        const result = matches
          .slice(0, 5)
          .map(m => m.text)
          .join('\n\n---\n\n');

        return {
          content: [{
            type: 'text' as const,
            text: `## Documentation Results for "${query}"\n\n${result}\n\n---\n*Full documentation: https://wiro.ai/docs*`,
          }],
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

interface Section {
  title: string;
  text: string;
}

function splitSections(content: string): Section[] {
  const lines = content.split('\n');
  const sections: Section[] = [];
  let current: string[] = [];
  let currentTitle = '';

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (current.length > 0) {
        sections.push({ title: currentTitle, text: current.join('\n').trim() });
      }
      currentTitle = line.replace(/^##\s*/, '');
      current = [line];
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) {
    sections.push({ title: currentTitle, text: current.join('\n').trim() });
  }

  return sections;
}

function scoreSection(section: Section, keywords: string[]): number {
  const titleLower = section.title.toLowerCase();
  const textLower = section.text.toLowerCase();
  let score = 0;

  for (const kw of keywords) {
    if (titleLower.includes(kw)) score += 3;
    const occurrences = textLower.split(kw).length - 1;
    score += Math.min(occurrences, 5);
  }

  return score;
}
