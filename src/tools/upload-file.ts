import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { formatSize } from '../utils/format.js';

export function registerUploadFile(server: McpServer, client: WiroClient): void {
  server.tool(
    'upload_file',
    'Upload a file from a URL to Wiro for use as model input. Note: most models accept direct URLs in file parameters (e.g. inputImage, inputImageUrl) without uploading first. Only use this when the model requires a Wiro-hosted file or when you need to reuse the same file across multiple runs.',
    {
      url: z.string().url().describe('URL of the file to upload (image, audio, video, document)'),
      file_name: z.string().optional().describe('Custom filename for the upload. If not provided, derived from the URL.'),
    },
    async ({ url, file_name }) => {
      try {
        const result = await client.uploadFile(url, file_name);

        if (!result.result || !result.list?.length) {
          const errorMsg = result.errors?.map(e => e.message).join(', ') || 'Upload failed';
          return {
            content: [{ type: 'text' as const, text: `## Error\n\n${errorMsg}` }],
            isError: true,
          };
        }

        const file = result.list[0];
        const lines: string[] = [];
        lines.push('## File Uploaded');
        lines.push('');
        lines.push(`**File:** ${file.name}`);
        if (file.contenttype) lines.push(`**Type:** ${file.contenttype}`);
        if (file.size) lines.push(`**Size:** ${formatSize(file.size)}`);
        if (file.url) lines.push(`**URL:** ${file.url}`);
        lines.push('');
        lines.push('Use this URL as input to any model that accepts file parameters.');

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
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
