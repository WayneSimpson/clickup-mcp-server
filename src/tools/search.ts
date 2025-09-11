/**
 * SPDX-FileCopyrightText: © 2025 Talib Kareem <taazkareem@icloud.com>
 * SPDX-License-Identifier: MIT
 *
 * Universal Search Tool for MCP Server
 *
 * Implements a standard "search" tool expected by generic MCP clients
 * (e.g., OpenAI connectors). Performs a retrieval-style search over the
 * content store and returns the top-k object IDs for follow-up fetch.
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Logger } from '../logger.js';
import { sponsorService } from '../utils/sponsor-service.js';
import { taskService } from '../services/shared.js';
import config from '../config.js';
import { toolCatalog } from './catalog.js';
import { isNameMatch } from '../utils/resolver-utils.js';

const logger = new Logger('SearchTool');

// Flexible matching for tool catalog search (handles ChatGPT query patterns)
function toolCatalogMatches(tool: any, query: string): boolean {
  const q = query.toLowerCase();
  const toolText = `${tool.id} ${tool.name} ${tool.title} ${tool.description}`.toLowerCase();
  
  // Direct substring match
  if (toolText.includes(q)) return true;
  
  // Split query on common separators and check partial matches
  const queryParts = q.split(/[\/\_\-\s]+/).filter(p => p.length > 0);
  const toolParts = toolText.split(/[\/\_\-\s]+/).filter(p => p.length > 0);
  
  // Check if significant query parts match tool parts
  let matches = 0;
  for (const qPart of queryParts) {
    if (qPart.length < 2) continue; // Skip very short parts
    for (const tPart of toolParts) {
      if (tPart.includes(qPart) || qPart.includes(tPart)) {
        matches++;
        break;
      }
    }
  }
  
  // Match if most query parts found matches
  return matches >= Math.max(1, Math.floor(queryParts.length * 0.6));
}

export const searchTool: Tool = {
  name: 'search',
  description:
    'Universal retrieval: search the content store for relevant documents by keyword(s). Returns top-k object IDs for use with the fetch tool. Inputs: query (string, required), limit (integer, default 10).',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search text to match against task names.'
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 10,
        description: 'Maximum number of results to return (default 10, max 50).'
      }
    },
    required: ['query']
  },
  outputSchema: {
    type: 'object',
    properties: {
      ids: { type: 'array', items: { type: 'string' }, description: 'Top-k object identifiers (IDs) matching the query.' },
      objectIds: { type: 'array', items: { type: 'string' }, description: 'Top-k object identifiers (IDs) matching the query.' },
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            text: { type: 'string' },
            snippet: { type: 'string' },
            url: { type: 'string' },
            status: { type: 'string' },
            list: { type: 'string' }
          },
          required: ['id', 'title']
        },
        description: 'Optional convenience payload with brief metadata for each objectId.'
      }
    },
    required: ['ids']
  }
};

export async function handleSearch(params: any) {
  try {
    const queryVal = typeof params === 'string'
      ? params
      : (params?.query ?? params?.search ?? params?.q ?? '');
    const query = String(queryVal).trim();
    const rawLimit = (params && typeof params === 'object' && 'limit' in params) ? (params as any).limit : 10;
    const limit = Math.max(1, Math.min(parseInt(String(rawLimit ?? 10), 10), 50));

    // Verbose logging for debugging ChatGPT connector behavior
    logger.info('Search invoked', { query, limit });
    if (!query) {
      // Return tool catalog entries as a non-empty baseline for indexing
      const toolMatches = toolCatalog
        .slice(0, limit)
        .map(t => ({ id: t.id, title: t.title, snippet: t.description, url: t.url }));
      const lines: string[] = [];
      lines.push(`No query provided. Showing tool catalog items (top ${toolMatches.length}).`);
      return {
        // Top-level expected by retrievable
        ids: toolMatches.map(t => t.id),
        objectIds: toolMatches.map(t => t.id),
        results: toolMatches,
        // Mirrors for other clients
        content: sponsorService.createResponse({
          results: toolMatches.map((t) => ({ id: t.id, title: t.title, url: t.url }))
        }).content,
        structuredContent: {
          ids: toolMatches.map(t => t.id),
          objectIds: toolMatches.map(t => t.id),
          results: toolMatches
        },
        toolResult: toolMatches
      };
    }

    // Get lightweight summaries to keep response small
    const summariesResp = await taskService.getTaskSummaries({
      // Use conservative, retrieval-friendly defaults
      include_closed: true,
      include_archived_lists: true,
      include_closed_lists: true,
      subtasks: true,
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
      // Fallback: return most recently updated tasks to avoid empty index
      const fallback = summariesResp.summaries
        .slice()
        .sort((a: any, b: any) => {
          const ad = a?.date_updated ? parseInt(a.date_updated, 10) : 0;
          const bd = b?.date_updated ? parseInt(b.date_updated, 10) : 0;
          return bd - ad;
        })
        .slice(0, limit);

      const lines: string[] = [];
      lines.push(`No direct matches for: "${query}". Showing recent items instead (top ${fallback.length}).`);
      lines.push('');

      const structuredResults: any[] = [];
      const objectIds: string[] = [];
      fallback.forEach((s: any, idx: number) => {
        const listName = s?.list?.name ?? 'Unknown list';
        const status = s?.status ?? 'unknown';
        const url = s?.url ?? '';
        lines.push(`${idx + 1}. ${s.name} [${status}] — List: ${listName}${url ? `\n   ${url}` : ''}`);
        structuredResults.push({
          id: s.id,
          title: s.name,
          text: `${s.name}${url ? `\n${url}` : ''}`,
          snippet: `Status: ${status}; List: ${listName}`,
          url,
          status,
          list: listName
        });
        objectIds.push(String(s.id));
      });

      // Optional: tool catalog fallback for OpenAI retrievable indexing
      if (config.openAiToolIndexFallback) {
        const toolMatches = toolCatalog.filter(t => toolCatalogMatches(t, query));
        toolMatches.slice(0, Math.max(0, limit - structuredResults.length)).forEach(t => {
          structuredResults.push({
            id: t.id,
            title: t.title,
            text: `${t.title}\n\n${t.description}\n\nReference: ${t.url}`,
            snippet: t.description,
            url: t.url
          });
          objectIds.push(t.id);
          lines.push(`• ${t.title} — ${t.name}`);
        });
      }

      // Enforce limit
      const limitedResults = structuredResults.slice(0, limit);
      const limitedIds = objectIds.slice(0, limit);

      return {
        // Top-level (what ChatGPT retrievable expects)
        ids: limitedIds,
        objectIds: limitedIds,
        results: limitedResults,
        // Mirrors for other clients
        content: sponsorService.createResponse({
          results: limitedResults.map((r) => ({ id: r.id, title: r.title, url: r.url || '' }))
        }).content,
        structuredContent: {
          ids: limitedIds,
          objectIds: limitedIds,
          results: limitedResults
        },
        toolResult: limitedResults
      };
    }

    const lines: string[] = [];
    lines.push(`Search results for: "${query}" (top ${ranked.length})`);
    lines.push('');

    const structuredResults: any[] = [];
    const objectIds: string[] = [];
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
        text: `${s.name}${url ? `\n${url}` : ''}`,
        snippet: `Status: ${status}; List: ${listName}`,
        url,
        status,
        list: listName
      });
      objectIds.push(String(s.id));
    });

    const response = {
      // Top-level expected by retrievable
      ids: objectIds,
      objectIds,
      results: structuredResults,
      // Mirrors for other clients
      content: sponsorService.createResponse({
        results: structuredResults.map((r) => ({ id: r.id, title: r.title, url: r.url || '' }))
      }).content,
      structuredContent: {
        ids: objectIds,
        objectIds,
        results: structuredResults
      },
      toolResult: structuredResults
    };
    logger.info('Search results prepared', { count: structuredResults.length });
    return response;
  } catch (error: any) {
    logger.error('Search failed', { error: error?.message });
    const message = `Search failed: ${String(error?.message || error)}`;
    // If configured, fall back to tool catalog matches so ChatGPT can still discover capabilities
    if (config.openAiToolIndexFallback) {
      const searchQuery = (params?.query || '').toString().trim();
      const toolMatches = toolCatalog
        .filter(t => toolCatalogMatches(t, searchQuery))
        .slice(0, 10)
        .map(t => ({ id: t.id, title: t.title, snippet: t.description, url: t.url }));
      const response = {
        // Top-level expected by retrievable
        ids: toolMatches.map(t => t.id),
        objectIds: toolMatches.map(t => t.id),
        results: toolMatches,
        // Mirrors for other clients
        content: sponsorService.createResponse({
          results: toolMatches.map((t) => ({ id: t.id, title: t.title, url: t.url }))
        }).content,
        structuredContent: {
          ids: toolMatches.map(t => t.id),
          objectIds: toolMatches.map(t => t.id),
          results: toolMatches
        },
        toolResult: toolMatches
      };
      logger.info('Search fallback (tool catalog)', { count: toolMatches.length });
      return response;
    }
    return {
      // Top-level expected by retrievable
      ids: [],
      objectIds: [],
      results: [],
      // Mirrors for other clients
      content: sponsorService.createResponse({ results: [] }).content,
      structuredContent: {
        ids: [],
        objectIds: [],
        results: []
      },
      toolResult: []
    };
  }
}
