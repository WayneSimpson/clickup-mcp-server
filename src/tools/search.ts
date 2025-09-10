/**
 * SPDX-FileCopyrightText: © 2025 Talib Kareem <taazkareem@icloud.com>
 * SPDX-License-Identifier: MIT
 *
 * Search Tool for MCP Server
 *
 * Exposes a standard "search" tool so ChatGPT connectors mark this server
 * as retrievable. Searches ClickUp tasks by name/keywords across the workspace
 * and returns top matches in a concise textual summary.
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Logger } from '../logger.js';
import { sponsorService } from '../utils/sponsor-service.js';
import { taskService } from '../services/shared.js';
import { isNameMatch } from '../utils/resolver-utils.js';

const logger = new Logger('SearchTool');

export const searchTool: Tool = {
  name: 'search',
  description:
    'Search ClickUp tasks by keyword(s) across the workspace. Returns a ranked list of matching tasks with list, status, and URL. Parameters: query (string, required), limit (number, default 10).',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search text to match against task names.'
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (default 10).'
      },
      include_closed: { type: 'boolean', description: 'Include closed tasks.' },
      include_archived_lists: { type: 'boolean' },
      include_closed_lists: { type: 'boolean' },
      subtasks: { type: 'boolean' }
    },
    required: ['query']
  },
  outputSchema: {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            snippet: { type: 'string' },
            url: { type: 'string' },
            status: { type: 'string' },
            list: { type: 'string' }
          },
          required: ['id', 'title']
        }
      }
    }
  }
};

export async function handleSearch(params: any) {
  try {
    const query = (params?.query || '').toString().trim();
    const limit = Math.max(1, Math.min(Number(params?.limit ?? 10), 50));
    if (!query) {
      return sponsorService.createErrorResponse('Missing required parameter: query');
    }

    // Get lightweight summaries to keep response small
    const summariesResp = await taskService.getTaskSummaries({
      include_closed: params?.include_closed ?? true,
      include_archived_lists: params?.include_archived_lists ?? true,
      include_closed_lists: params?.include_closed_lists ?? true,
      subtasks: params?.subtasks ?? true,
      detail_level: 'summary'
    } as any);

    const ranked = summariesResp.summaries
      .map((t: any) => {
        const match = isNameMatch(t.name, query);
        return { t, score: match.score, matched: match.isMatch, reason: match.reason };
      })
      .filter(r => r.matched)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const ad = a.t?.date_updated ? parseInt(a.t.date_updated, 10) : 0;
        const bd = b.t?.date_updated ? parseInt(b.t.date_updated, 10) : 0;
        return bd - ad;
      })
      .slice(0, limit);

    if (ranked.length === 0) {
      return sponsorService.createResponse(`No results found for "${query}".`);
    }

    const lines: string[] = [];
    lines.push(`Search results for: "${query}" (top ${ranked.length})`);
    lines.push('');

    const structuredResults: any[] = [];
    ranked.forEach((r, idx) => {
      const s = r.t;
      const listName = s?.list?.name ?? 'Unknown list';
      const status = s?.status ?? 'unknown';
      const url = s?.url ?? '';
      lines.push(
        `${idx + 1}. ${s.name} [${status}] — List: ${listName}${url ? `\n   ${url}` : ''}`
      );
      structuredResults.push({
        id: s.id,
        title: s.name,
        snippet: `Status: ${status}; List: ${listName}`,
        url,
        status,
        list: listName
      });
    });

    return {
      content: sponsorService.createResponse(lines.join('\n')).content,
      structuredContent: { results: structuredResults }
    };
  } catch (error: any) {
    logger.error('Search failed', { error: error?.message });
    return sponsorService.createErrorResponse('Search failed', { error: String(error?.message || error) });
  }
}
