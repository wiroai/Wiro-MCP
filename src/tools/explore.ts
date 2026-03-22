import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WiroClient } from '../client.js';
import type { ExploreCategory } from '../types.js';

export function registerExplore(server: McpServer, client: WiroClient): void {
  server.tool(
    'explore',
    'Browse curated AI models on Wiro, organized by category. Returns featured and popular models grouped into sections like "Recently Added", "Image Generation", "Video", etc. No parameters needed — just call it to see what\'s available.',
    {},
    async () => {
      try {
        const result = await client.explore();

        if (!result.result || !result.explore?.length) {
          return {
            content: [{ type: 'text' as const, text: 'No explore data available.' }],
          };
        }

        const text = formatExplore(result.explore);

        return {
          content: [{ type: 'text' as const, text }],
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

function formatExplore(categories: ExploreCategory[]): string {
  const lines: string[] = ['## Explore Models'];
  lines.push('');

  for (const cat of categories) {
    if (!cat.tools?.length) continue;

    const totalNote = cat.total && cat.total > cat.tools.length
      ? ` (showing ${cat.tools.length} of ${cat.total})`
      : '';
    lines.push(`### ${cat.title}${totalNote}`);
    lines.push('');

    for (const tool of cat.tools) {
      const slug = `${tool.cleanslugowner}/${tool.cleanslugproject}`;
      const cats = tool.categories?.filter(c => c !== 'tool').join(', ') || '';
      const rating = parseFloat(tool.averagepoint) > 0 ? ` ⭐ ${tool.averagepoint}` : '';
      lines.push(`- **\`${slug}\`**${rating}`);
      if (cats) lines.push(`  Categories: ${cats}`);
      if (tool.description) lines.push(`  ${tool.description}`);
    }
    lines.push('');
  }

  lines.push('*Use `get_model_schema` to see full parameters and pricing for any model.*');

  return lines.join('\n');
}
