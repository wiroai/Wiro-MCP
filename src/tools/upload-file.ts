import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { formatSize } from '../utils/format.js';
import { toStructuredFile } from '../utils/structured.js';
import { uploadedFileOutputSchema } from './schemas.js';

export function registerUploadFile(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'upload_file',
    {
      title: 'Upload a file to Wiro',
      description: 'Upload a remotely accessible file to Wiro. Most models '
        + 'accept source URLs directly, so use this only when the model schema '
        + 'requires a Wiro-hosted file or the same file will be reused.',
      inputSchema: {
        url: z.string().url().describe('URL of the file to upload (image, audio, video, or document).'),
        file_name: z.string().optional().describe('Optional filename. Defaults to the URL filename.'),
      },
      outputSchema: uploadedFileOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
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
        if (!file.url) {
          return {
            content: [{
              type: 'text' as const,
              text: '## Error\n\nUpload succeeded but no reusable file URL was returned.',
            }],
            isError: true,
          };
        }
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
          content: [
            { type: 'text' as const, text: lines.join('\n') },
            ...(file.url
              ? [{
                type: 'resource_link' as const,
                uri: file.url,
                name: file.name,
                description: 'File uploaded to Wiro',
                mimeType: file.contenttype,
              }]
              : []),
          ],
          structuredContent: {
            file: toStructuredFile(file),
          },
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
