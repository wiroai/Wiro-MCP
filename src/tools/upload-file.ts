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
      description: 'Copy a file from a public http(s) URL to Wiro, up to about 100 MB, '
        + 'and get a Wiro link back. Model file fields take public URLs directly, so use '
        + 'this only when the same file feeds several runs. Single files only, not .zip '
        + 'archives. A file that is only attached in the chat has no URL: ask the user for '
        + 'a public link.',
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
          // An archive is stored as a folder of its files, which has no link.
          const text = file.contenttype === 'folder'
            ? `## Error\n\nThe archive was unpacked into the folder "${file.name}" in your Wiro files, `
              + 'so there is no single link for it. Do not upload it again. Pass the archive\'s '
              + 'public URL to the model directly, or upload its files one at a time.'
            : '## Error\n\nUpload succeeded but no reusable file URL was returned.';
          return {
            content: [{ type: 'text' as const, text }],
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
