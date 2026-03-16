import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { intake } from '../../operator/index.js';

export function registerCapture(server: McpServer) {
  server.registerTool(
    'capture',
    {
      description:
        'Save a new thought to your brain from any AI tool. ' +
        'The thought is held in a synthesis buffer (Operator), evaluated by an LLM, ' +
        'then routed to the Gatekeeper queue before being stored. ' +
        'Use this to capture insights, decisions, preferences, tasks, or ideas while working. ' +
        'Always provide a capture_reason explaining why this thought is worth storing.',
      inputSchema: {
        content: z.string().min(3).describe(
          'The thought to capture, in plain language',
        ),
        capture_reason: z.string().optional().describe(
          'Why this thought is being captured now — context, trigger, or decision rationale. ' +
          'Required for auto-captures; omit only for explicit user-initiated captures.',
        ),
      },
    },
    async ({ content, capture_reason }) => {
      try {
        await intake(content, 'mcp', capture_reason);
        return {
          content: [{
            type: 'text' as const,
            text: `✓ Held for synthesis\n  Run 'memo web' to inspect or 'memo review' to see GK queue.`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );
}
