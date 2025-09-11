/**
 * SPDX-FileCopyrightText: © 2025 Talib Kareem <taazkareem@icloud.com>
 * SPDX-License-Identifier: MIT
 *
 * Universal Fetch Tool for MCP Server
 *
 * Implements a standard "fetch" tool expected by generic MCP clients
 * (e.g., OpenAI connectors). Retrieves a single document by ID and returns
 * a flat object with id, title, text, url, and optional metadata.
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Logger } from '../logger.js';
import { sponsorService } from '../utils/sponsor-service.js';
import { taskService } from '../services/shared.js';
import { toolCatalog } from './catalog.js';

const logger = new Logger('FetchTool');

export const fetchTool: Tool = {
  name: 'fetch',
  description:
    'Universal retrieval: fetch a single document by ID. Returns a flat object with id, title, text, url, and optional metadata. Input: id (string, required).',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Object ID to fetch.' }
    },
    required: ['id'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      text: { type: 'string' },
      url: { type: 'string' },
      metadata: { type: 'object', additionalProperties: true },
      raw: { type: 'object', additionalProperties: true }
    }
  }
};

export async function handleFetch(params: any) {
  try {
    const id = (typeof params === 'string')
      ? params
      : (params?.id ? String(params.id) : undefined);
    if (!id) {
      return sponsorService.createErrorResponse('Missing required parameter: id');
    }

    // Support fetching tool catalog entries (for OpenAI retrievable indexing)
    if (id.startsWith('tool:')) {
      const entry = toolCatalog.find(e => e.id === id);
      if (!entry) {
        return sponsorService.createErrorResponse(`Unknown tool id: ${id}`);
      }
      const text = `${entry.title}\n\n${entry.description}\n\nReference: ${entry.url}`;
      return {
        // Top-level fields expected by retrievable
        id: entry.id,
        title: entry.title,
        text,
        url: entry.url,
        metadata: { name: entry.name, category: 'tool' },
        raw: entry,
        // Mirrors for other clients: JSON-encoded document in content
        content: sponsorService.createResponse({
          id: entry.id,
          title: entry.title,
          text,
          url: entry.url,
          metadata: { name: entry.name, category: 'tool' }
        }).content,
        structuredContent: {
          id: entry.id,
          title: entry.title,
          text,
          url: entry.url,
          metadata: { name: entry.name, category: 'tool' }
        }
      };
    }

    const task = await taskService.getTask(id);

    // Build text and metadata
    const status = task.status?.status ?? 'unknown';
    const listName = task.list?.name ?? '';
    const url = task.url || '';
    const description = (task.text_content ?? task.description ?? '').toString();
    const textParts: string[] = [];
    if (description) textParts.push(description);
    if (status) textParts.push(`Status: ${status}`);
    if (listName) textParts.push(`List: ${listName}`);
    if (url) textParts.push(url);
    const text = textParts.join('\n');

    const metadata: Record<string, any> = {
      status,
      list: listName || undefined
    };

    return {
      // Top-level fields expected by retrievable
      id: task.id,
      title: task.name,
      text,
      url,
      metadata,
      raw: task,
      // Mirrors for other clients: JSON-encoded document in content
      content: sponsorService.createResponse({
        id: task.id,
        title: task.name,
        text,
        url,
        metadata
      }).content,
      structuredContent: {
        id: task.id,
        title: task.name,
        text,
        url,
        metadata
      }
    };
  } catch (error: any) {
    logger.error('Fetch failed', { error: error?.message });
    return sponsorService.createErrorResponse('Fetch failed', { error: String(error?.message || error) });
  }
}
