/**
 * SPDX-FileCopyrightText: © 2025 Talib Kareem <taazkareem@icloud.com>
 * SPDX-License-Identifier: MIT
 *
 * Fetch Tool for MCP Server
 *
 * Exposes a standard "fetch" tool so ChatGPT connectors consider this server
 * retrievable. Fetches a ClickUp task by id or by parsing a task URL.
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Logger } from '../logger.js';
import { sponsorService } from '../utils/sponsor-service.js';
import { taskService } from '../services/shared.js';

const logger = new Logger('FetchTool');

export const fetchTool: Tool = {
  name: 'fetch',
  description:
    'Fetch a ClickUp entity by identifier. Supports { id } for tasks, or { url } for task URLs. Returns full details and a concise summary.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Task ID to fetch.' }
    },
    required: ['id'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      result: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'string' },
          list: { type: 'string' },
          url: { type: 'string' }
        },
        required: ['id', 'title']
      }
    }
  }
};

export async function handleFetch(params: any) {
  try {
    const taskId = params?.id ? String(params.id) : undefined;
    if (!taskId) {
      return sponsorService.createErrorResponse('Missing required parameter: id');
    }

    const task = await taskService.getTask(taskId);

    const summaryLines: string[] = [];
    summaryLines.push(`Task: ${task.name}`);
    summaryLines.push(`Status: ${task.status?.status ?? 'unknown'}`);
    if (task.list?.name) summaryLines.push(`List: ${task.list.name}`);
    if (task.url) summaryLines.push(task.url);

    return {
      content: sponsorService.createResponse(summaryLines.join('\n')).content,
      structuredContent: {
        result: {
          id: task.id,
          title: task.name,
          status: task.status?.status,
          list: task.list?.name,
          url: task.url
        }
      }
    };
  } catch (error: any) {
    logger.error('Fetch failed', { error: error?.message });
    return sponsorService.createErrorResponse('Fetch failed', { error: String(error?.message || error) });
  }
}
