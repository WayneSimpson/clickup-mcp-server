/**
 * SPDX-FileCopyrightText: © 2025 Talib Kareem <taazkareem@icloud.com>
 * SPDX-License-Identifier: MIT
 *
 * SSE and HTTP Streamable Transport Server
 *
 * This module provides HTTP Streamable and legacy SSE transport support
 * for the ClickUp MCP Server. It reuses the unified server configuration
 * from server.ts to avoid code duplication.
 */

import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import https from 'https';
import http from 'http';
import fs from 'fs';
import { server, configureServer } from './server.js';
import configuration from './config.js';
import {
  createOriginValidationMiddleware,
  createRateLimitMiddleware,
  createCorsMiddleware,
  createSecurityHeadersMiddleware,
  createSecurityLoggingMiddleware,
  createInputValidationMiddleware
} from './middleware/security.js';
import { Logger } from './logger.js';

const app = express();
const logger = new Logger('SSEServer');

export function startSSEServer() {
  // Configure the unified server first
  configureServer();

  // Apply security middleware (all are opt-in via environment variables)
  logger.info('Configuring security middleware', {
    securityFeatures: configuration.enableSecurityFeatures,
    originValidation: configuration.enableOriginValidation,
    rateLimit: configuration.enableRateLimit,
    cors: configuration.enableCors
  });

  // Always apply input validation (reasonable defaults)
  app.use(createInputValidationMiddleware());

  // Apply optional security middleware
  app.use(createSecurityLoggingMiddleware());
  app.use(createSecurityHeadersMiddleware());
  app.use(createCorsMiddleware());
  app.use(createOriginValidationMiddleware());
  app.use(createRateLimitMiddleware());

  // Normalize Accept header for MCP endpoints to satisfy MCP Streamable HTTP spec
  // The POST /mcp request MUST include both application/json and text/event-stream
  // We defensively add them if clients/proxies omit one
  app.use((req, _res, next) => {
    if (req.path === '/mcp') {
      const original = (req.headers['accept'] || '').toString();
      const parts = original.split(',').map(s => s.trim()).filter(Boolean);
      let changed = false;
      if (!parts.some(p => p.includes('application/json'))) {
        parts.push('application/json');
        changed = true;
      }
      if (!parts.some(p => p.includes('text/event-stream'))) {
        parts.push('text/event-stream');
        changed = true;
      }
      if (changed) {
        const updated = Array.from(new Set(parts)).join(', ');
        (req.headers as any)['accept'] = updated;
        logger.debug('Normalized Accept header for /mcp', { original, updated });
      }
    }
    next();
  });

  // Configure JSON parsing with configurable size limit
  app.use(express.json({
    limit: configuration.maxRequestSize,
    verify: (req, res, buf) => {
      // Additional validation can be added here if needed
      if (buf.length === 0) {
        logger.debug('Empty request body received');
      }
    }
  }));

  // Global OPTIONS handler to satisfy browser preflight requests
  // Responds 204 with permissive headers if CORS middleware is disabled
  // NOTE: In Express 5 (path-to-regexp v6), using '*' as a path throws
  // "Missing parameter name". Use a safe regex to match any path.
  app.options(/.*/, (req, res) => {
    // If CORS is enabled, let the cors middleware handle it by setting headers.
    if (configuration.enableCors) {
      res.sendStatus(204);
      return;
    }
    // Minimal headers for browser preflight compatibility
    const origin = (req.headers.origin as string) || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, mcp-session-id, Mcp-Session-Id');
    res.setHeader('Access-Control-Max-Age', '600');
    res.sendStatus(204);
  });

  const transports = {
    streamable: {} as Record<string, StreamableHTTPServerTransport>,
    sse: {} as Record<string, SSEServerTransport>,
  };

  // Streamable HTTP endpoint - handles POST requests for client-to-server communication
  app.post('/mcp', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      logger.debug('MCP request received', {
        sessionId,
        hasBody: !!req.body,
        contentType: req.headers['content-type'],
        origin: req.headers.origin
      });
      let transport: StreamableHTTPServerTransport;

      // Do not set or flush headers here. The transport will manage
      // headers and response mode (JSON streaming without SSE framing)
      // based on its configuration.

      if (sessionId && transports.streamable[sessionId]) {
        transport = transports.streamable[sessionId];
      } else if (!sessionId) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => `session_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`,
          onsessioninitialized: (sessionId) => {
            transports.streamable[sessionId] = transport;
          },
          // Use default SSE streaming for responses as required by Streamable HTTP spec
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            delete transports.streamable[transport.sessionId];
          }
        };

        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session ID provided',
          },
          id: null,
        });
        return;
      }

      // Always pass parsed body from express.json(). The transport is designed
      // to accept a pre-parsed body when provided; otherwise the raw stream would
      // have been consumed by express.json() already.
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        });
      }
    }
  });

  const handleSessionRequest = async (req: express.Request, res: express.Response) => {
    // Proxy-aware fallback: if upstream rewrote '/mcp/search' or '/mcp/fetch' to '/mcp',
    // detect it via common headers and serve REST responses instead of SSE
    try {
      const forwardedUri = (
        (req.headers['x-original-uri'] || req.headers['x-rewrite-url'] || req.headers['x-forwarded-uri'] || req.headers['x-forwarded-url']) as string | undefined
      )?.toString();
      const effectivePath = forwardedUri || req.originalUrl || req.url || req.path;
      if (effectivePath && (effectivePath.endsWith('/mcp/search') || effectivePath.includes('/mcp/search'))) {
        const query = (req.query.q || req.query.query || '').toString();
        const limit = Math.min(parseInt((req.query.limit as string) || '10') || 10, 50);
        const { handleSearch } = await import('./tools/search.js');
        if (!query.trim()) {
          const { toolCatalog } = await import('./tools/catalog.js');
          const items = toolCatalog.slice(0, limit).map((item: any) => ({
            id: item.id,
            title: item.title,
            text: `${item.title}\n\n${item.description}\n\nReference: ${item.url}`,
            url: item.url,
            snippet: item.description,
            source_url: item.url,
            metadata: { name: item.name, category: 'tool' }
          }));
          res.json({ results: items });
          return;
        }
        const result = await handleSearch({ query, limit });
        if ('results' in result && Array.isArray((result as any).results)) {
          res.json({
            results: (result as any).results.map((item: any) => ({
              id: item.id,
              title: item.title,
              text: item.text || item.snippet || item.description || '',
              url: item.url || '',
              snippet: item.snippet || item.description || '',
              source_url: item.url || '',
              metadata: { status: item.status, list: item.list, category: item.category }
            }))
          });
        } else {
          res.json({ results: [] });
        }
        return;
      }
      if (effectivePath && (effectivePath.endsWith('/mcp/fetch') || effectivePath.includes('/mcp/fetch'))) {
        const id = req.query.id as string;
        if (!id) {
          res.status(400).json({ error: 'Missing required parameter: id' });
          return;
        }
        const { handleFetch } = await import('./tools/fetch.js');
        const result = await handleFetch({ id });
        if ('id' in result && 'text' in result) {
          res.json({
            id: (result as any).id,
            content: (result as any).text || '',
            metadata: { title: (result as any).title || '', url: (result as any).url || '', ...((result as any).metadata || {}) }
          });
        } else {
          res.status(404).json({ error: 'Document not found' });
        }
        return;
      }
    } catch (e) {
      // Non-fatal: fall through to normal SSE handling
    }
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports.streamable[sessionId]) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: Mcp-Session-Id header is required'
        },
        id: null,
      });
      return;
    }

    const transport = transports.streamable[sessionId];
    await transport.handleRequest(req, res);
  };

  // Streamable HTTP notifications (requires mcp-session-id header)
  // If missing or invalid, return 400 (client must POST initialize first)
  app.get('/mcp', handleSessionRequest);

  // Keep DELETE for potential session termination if used by clients.
  app.delete('/mcp', handleSessionRequest);

  // Legacy SSE endpoints (for backwards compatibility)
  app.get('/sse', async (req, res) => {
    // Ensure CORS headers are present for browser-based SSE clients
    const origin = (req.headers.origin as string) || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    const transport = new SSEServerTransport('/messages', res);
    transports.sse[transport.sessionId] = transport;

    logger.info('New SSE connection established', {
      sessionId: transport.sessionId,
      origin: req.headers.origin,
      userAgent: req.headers['user-agent']
    });

    res.on('close', () => {
      delete transports.sse[transport.sessionId];
    });

    await server.connect(transport);
  });

  app.post('/messages', async (req, res) => {
    // Ensure CORS headers for POST, especially when CORS middleware is disabled
    const origin = (req.headers.origin as string) || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    const sessionId = req.query.sessionId as string;
    const transport = transports.sse[sessionId];
    if (transport) {
      await transport.handlePostMessage(req, res, req.body);
    } else {
      res.status(400).send('No transport found for sessionId');
    }
  });

  // ChatGPT Custom Connector REST API endpoints for retrievable indexing
  // These are separate from MCP tool calls and return direct JSON responses
  app.get('/search', async (req, res) => {
    try {
      const query = (req.query.q || req.query.query || '').toString();
      const rawLimit = (req.query.limit as string) || (req.query.top_k as string) || (req.query.k as string) || (req.query.n as string) || '10';
      const limit = Math.min(parseInt(rawLimit) || 10, 50);
      logger.info('REST search GET', { query, limit });
      
      // Import search handler dynamically to avoid circular dependencies
      const { handleSearch } = await import('./tools/search.js');
      // If query is empty, synthesize results from tool catalog so index is never empty
      if (!query.trim()) {
        const { toolCatalog } = await import('./tools/catalog.js');
        const items = toolCatalog.slice(0, limit).map((item: any) => ({
          id: item.id,
          title: item.title,
          text: `${item.title}\n\n${item.description}\n\nReference: ${item.url}`,
          url: item.url,
          // Back-compat fields some clients look for
          snippet: item.description,
          source_url: item.url,
          metadata: { name: item.name, category: 'tool' }
        }));
        res.json({ results: items });
        return;
      }
      const result = await handleSearch({ query, limit });
      
      // Normalize/augment items; avoid empty results when possible
      let items: any[] = Array.isArray((result as any).results) ? (result as any).results : [];
      if (items.length === 0) {
        try {
          const { toolCatalog } = await import('./tools/catalog.js');
          items = toolCatalog.slice(0, limit).map((item: any) => ({
            id: item.id,
            title: item.title,
            text: `${item.title}\n\n${item.description}\n\nReference: ${item.url}`,
            url: item.url,
            snippet: item.description,
            source_url: item.url,
            metadata: { name: item.name, category: 'tool' }
          }));
        } catch {}
      }
      
      if (items.length > 0) {
        const chatgptResponse = {
          results: items.map((item: any) => ({
            id: item.id,
            title: item.title,
            // Provide both text and snippet for maximum compatibility
            text: item.text || item.snippet || item.description || '',
            url: item.url || '',
            snippet: item.snippet || item.description || '',
            source_url: item.url || '',
            metadata: {
              status: item.status,
              list: item.list,
              category: item.category
            }
          }))
        };
        res.json(chatgptResponse);
      } else {
        // Error case - return empty results
        res.json({ results: [] });
      }
    } catch (error: any) {
      logger.error('REST search endpoint error', { error: error?.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/search', async (req, res) => {
    try {
      const { query = '', limit, top_k, k, n } = req.body || {};
      const rawLimit = (limit ?? top_k ?? k ?? n ?? 10);
      const { handleSearch } = await import('./tools/search.js');
      const q = query.toString();
      const lim = Math.min(parseInt(String(rawLimit)) || 10, 50);
      logger.info('REST search POST', { query: q, limit: lim });
      if (!q.trim()) {
        const { toolCatalog } = await import('./tools/catalog.js');
        const items = toolCatalog.slice(0, lim).map((item: any) => ({
          id: item.id,
          title: item.title,
          text: `${item.title}\n\n${item.description}\n\nReference: ${item.url}`,
          url: item.url,
          snippet: item.description,
          source_url: item.url,
          metadata: { name: item.name, category: 'tool' }
        }));
        res.json({ results: items });
        return;
      }
      const result = await handleSearch({ query: q, limit: lim });
      
      let items: any[] = Array.isArray((result as any).results) ? (result as any).results : [];
      if (items.length === 0) {
        try {
          const { toolCatalog } = await import('./tools/catalog.js');
          items = toolCatalog.slice(0, lim).map((item: any) => ({
            id: item.id,
            title: item.title,
            text: `${item.title}\n\n${item.description}\n\nReference: ${item.url}`,
            url: item.url,
            snippet: item.description,
            source_url: item.url,
            metadata: { name: item.name, category: 'tool' }
          }));
        } catch {}
      }
      if (items.length > 0) {
        const chatgptResponse = {
          results: items.map((item: any) => ({
            id: item.id,
            title: item.title,
            text: item.text || item.snippet || item.description || '',
            url: item.url || '',
            snippet: item.snippet || item.description || '',
            source_url: item.url || '',
            metadata: {
              status: item.status,
              list: item.list,
              category: item.category
            }
          }))
        };
        res.json(chatgptResponse);
      } else {
        res.json({ results: [] });
      }
    } catch (error: any) {
      logger.error('REST search endpoint error', { error: error?.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/fetch', async (req, res) => {
    try {
      const id = req.query.id as string;
      if (!id) {
        res.status(400).json({ error: 'Missing required parameter: id' });
        return;
      }
      
      const { handleFetch } = await import('./tools/fetch.js');
      const result = await handleFetch({ id });
      
      // Check if result has the expected structure (success case)
      if ('id' in result && 'text' in result) {
        const chatgptResponse = {
          id: result.id,
          content: result.text || '',
          metadata: {
            title: result.title || '',
            url: result.url || '',
            ...(result.metadata || {})
          }
        };
        res.json(chatgptResponse);
      } else {
        res.status(404).json({ error: 'Document not found' });
      }
    } catch (error: any) {
      logger.error('REST fetch endpoint error', { error: error?.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/fetch', async (req, res) => {
    try {
      const { id } = req.body || {};
      if (!id) {
        res.status(400).json({ error: 'Missing required parameter: id' });
        return;
      }
      
      const { handleFetch } = await import('./tools/fetch.js');
      const result = await handleFetch({ id });
      
      if ('id' in result && 'text' in result) {
        const chatgptResponse = {
          id: result.id,
          content: result.text || '',
          metadata: {
            title: result.title || '',
            url: result.url || '',
            ...(result.metadata || {})
          }
        };
        res.json(chatgptResponse);
      } else {
        res.status(404).json({ error: 'Document not found' });
      }
    } catch (error: any) {
      logger.error('REST fetch endpoint error', { error: error?.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // --- Aliases under /mcp for ChatGPT connectors using base /mcp ---
  // Search aliases
  app.get('/mcp/search', async (req, res) => {
    try {
      const query = (req.query.q || req.query.query || '').toString();
      const rawLimit = (req.query.limit as string) || (req.query.top_k as string) || (req.query.k as string) || (req.query.n as string) || '10';
      const limit = Math.min(parseInt(rawLimit) || 10, 50);
      logger.info('REST /mcp/search GET', { query, limit });
      const { handleSearch } = await import('./tools/search.js');
      if (!query.trim()) {
        const { toolCatalog } = await import('./tools/catalog.js');
        const items = toolCatalog.slice(0, limit).map((item: any) => ({
          id: item.id,
          title: item.title,
          text: `${item.title}\n\n${item.description}\n\nReference: ${item.url}`,
          url: item.url,
          snippet: item.description,
          source_url: item.url,
          metadata: { name: item.name, category: 'tool' }
        }));
        res.json({ results: items });
        return;
      }
      const result = await handleSearch({ query, limit });
      let items: any[] = Array.isArray((result as any).results) ? (result as any).results : [];
      if (items.length === 0) {
        try {
          const { toolCatalog } = await import('./tools/catalog.js');
          items = toolCatalog.slice(0, limit).map((item: any) => ({
            id: item.id,
            title: item.title,
            text: `${item.title}\n\n${item.description}\n\nReference: ${item.url}`,
            url: item.url,
            snippet: item.description,
            source_url: item.url,
            metadata: { name: item.name, category: 'tool' }
          }));
        } catch {}
      }
      if (items.length > 0) {
        res.json({
          results: items.map((item: any) => ({
            id: item.id,
            title: item.title,
            text: item.text || item.snippet || item.description || '',
            url: item.url || '',
            snippet: item.snippet || item.description || '',
            source_url: item.url || '',
            metadata: { status: item.status, list: item.list, category: item.category }
          }))
        });
      } else {
        res.json({ results: [] });
      }
    } catch (error: any) {
      logger.error('REST /mcp/search endpoint error', { error: error?.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/mcp/search', async (req, res) => {
    try {
      const { query = '', limit, top_k, k, n } = req.body || {};
      const rawLimit = (limit ?? top_k ?? k ?? n ?? 10);
      const q = query.toString();
      const lim = Math.min(parseInt(String(rawLimit)) || 10, 50);
      logger.info('REST /mcp/search POST', { query: q, limit: lim });
      const { handleSearch } = await import('./tools/search.js');
      if (!q.trim()) {
        const { toolCatalog } = await import('./tools/catalog.js');
        const items = toolCatalog.slice(0, lim).map((item: any) => ({
          id: item.id,
          title: item.title,
          text: `${item.title}\n\n${item.description}\n\nReference: ${item.url}`,
          url: item.url,
          snippet: item.description,
          source_url: item.url,
          metadata: { name: item.name, category: 'tool' }
        }));
        res.json({ results: items });
        return;
      }
      const result = await handleSearch({ query: q, limit: lim });
      if ('results' in result && Array.isArray(result.results)) {
        res.json({
          results: result.results.map((item: any) => ({
            id: item.id,
            title: item.title,
            text: item.text || item.snippet || item.description || '',
            url: item.url || '',
            snippet: item.snippet || item.description || '',
            source_url: item.url || '',
            metadata: { status: item.status, list: item.list, category: item.category }
          }))
        });
      } else {
        res.json({ results: [] });
      }
    } catch (error: any) {
      logger.error('REST /mcp/search endpoint error', { error: error?.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Fetch aliases
  app.get('/mcp/fetch', async (req, res) => {
    try {
      const id = req.query.id as string;
      if (!id) {
        res.status(400).json({ error: 'Missing required parameter: id' });
        return;
      }
      const { handleFetch } = await import('./tools/fetch.js');
      const result = await handleFetch({ id });
      if ('id' in result && 'text' in result) {
        res.json({
          id: result.id,
          content: result.text || '',
          metadata: { title: result.title || '', url: result.url || '', ...(result.metadata || {}) }
        });
      } else {
        res.status(404).json({ error: 'Document not found' });
      }
    } catch (error: any) {
      logger.error('REST /mcp/fetch endpoint error', { error: error?.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/mcp/fetch', async (req, res) => {
    try {
      const { id } = req.body || {};
      if (!id) {
        res.status(400).json({ error: 'Missing required parameter: id' });
        return;
      }
      const { handleFetch } = await import('./tools/fetch.js');
      const result = await handleFetch({ id });
      if ('id' in result && 'text' in result) {
        res.json({
          id: result.id,
          content: result.text || '',
          metadata: { title: result.title || '', url: result.url || '', ...(result.metadata || {}) }
        });
      } else {
        res.status(404).json({ error: 'Document not found' });
      }
    } catch (error: any) {
      logger.error('REST /mcp/fetch endpoint error', { error: error?.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: '0.8.5',
      security: {
        featuresEnabled: configuration.enableSecurityFeatures,
        originValidation: configuration.enableOriginValidation,
        rateLimit: configuration.enableRateLimit,
        cors: configuration.enableCors
      }
    });
  });

  // OpenAPI schema describing REST retrieval endpoints for ChatGPT indexing
  const openapi = {
    openapi: '3.0.3',
    info: {
      title: 'ClickUp MCP Retrieval API',
      version: '1.0.0',
      description: 'Search and fetch endpoints for ChatGPT Custom Connector retrievable indexing.'
    },
    servers: [
      { url: 'https://clickup.nocodehome.co.uk' }
    ],
    paths: {
      '/search': {
        get: {
          summary: 'Search documents',
          parameters: [
            { name: 'query', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'q', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 10 } }
          ],
          responses: {
            '200': {
              description: 'Search results',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/SearchResponse' } } }
            }
          }
        },
        post: {
          summary: 'Search documents',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SearchRequest' } } }
          },
          responses: {
            '200': {
              description: 'Search results',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/SearchResponse' } } }
            }
          }
        }
      },
      '/fetch': {
        get: {
          summary: 'Fetch a single document by ID',
          parameters: [ { name: 'id', in: 'query', required: true, schema: { type: 'string' } } ],
          responses: {
            '200': {
              description: 'Document',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/FetchResponse' } } }
            }
          }
        },
        post: {
          summary: 'Fetch a single document by ID',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/FetchRequest' } } }
          },
          responses: {
            '200': {
              description: 'Document',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/FetchResponse' } } }
            }
          }
        }
      },
      '/mcp/search': { $ref: '#/paths/~1search' },
      '/mcp/fetch': { $ref: '#/paths/~1fetch' }
    },
    components: {
      schemas: {
        SearchRequest: {
          type: 'object',
          properties: { query: { type: 'string' }, limit: { type: 'integer', default: 10 } }
        },
        SearchResultItem: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            text: { type: 'string' },
            snippet: { type: 'string' },
            url: { type: 'string' },
            source_url: { type: 'string' },
            metadata: { type: 'object', additionalProperties: true }
          },
          required: ['id', 'title']
        },
        SearchResponse: { type: 'object', properties: { results: { type: 'array', items: { $ref: '#/components/schemas/SearchResultItem' } } } },
        FetchRequest: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        FetchResponse: { type: 'object', properties: { id: { type: 'string' }, content: { type: 'string' }, metadata: { type: 'object', additionalProperties: true } }, required: ['id', 'content'] }
      }
    }
  } as const;

  app.get('/openapi.json', (_req, res) => {
    res.json(openapi);
  });
  app.get('/mcp/openapi.json', (_req, res) => {
    res.json(openapi);
  });

  // ===== DEDICATED CHATGPT DEEP RESEARCH CONNECTOR ENDPOINTS =====
  // ChatGPT Custom Connectors expect plain REST, NOT MCP protocol
  // These endpoints are completely separate from MCP handlers
  app.get('/chatgpt/health', (_req, res) => {
    logger.info('ChatGPT health check');
    res.json({ ok: true, service: 'clickup-mcp', timestamp: new Date().toISOString() });
  });
  
  app.get('/chatgpt/search', async (req, res) => {
    try {
      const query = (req.query.query || req.query.q || '').toString();
      const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
      
      logger.info('ChatGPT search request', { query, limit });
      
      const { handleSearch } = await import('./tools/search.js');
      
      // Always return results, even for empty query
      if (!query.trim()) {
        const { toolCatalog } = await import('./tools/catalog.js');
        const results = toolCatalog.slice(0, limit).map((item: any) => ({
          id: item.id,
          title: item.title,
          text: `${item.title}\n\n${item.description}\n\nReference: ${item.url}`,
          snippet: item.description,
          url: item.url,
          metadata: { 
            name: item.name, 
            category: 'tool',
            source: 'tool_catalog'
          }
        }));
        
        logger.info('ChatGPT search response (empty query)', { count: results.length });
        res.json({ results });
        return;
      }
      
      const searchResult = await handleSearch({ query, limit });
      
      if ('results' in searchResult && Array.isArray(searchResult.results)) {
        const results = searchResult.results.map((item: any) => ({
          id: item.id || '',
          title: item.title || '',
          text: item.text || item.snippet || item.description || '',
          snippet: item.snippet || item.description || '',
          url: item.url || '',
          metadata: {
            status: item.status,
            list: item.list,
            category: item.category || 'task',
            source: 'clickup'
          }
        }));
        
        logger.info('ChatGPT search response', { query, count: results.length });
        res.json({ results });
      } else {
        logger.warn('ChatGPT search returned no results', { query });
        res.json({ results: [] });
      }
    } catch (error: any) {
      logger.error('ChatGPT search error', { error: error?.message });
      res.status(500).json({ 
        error: 'Search failed',
        message: error?.message || 'Internal server error'
      });
    }
  });
  
  app.post('/chatgpt/search', async (req, res) => {
    try {
      const { query = '', limit = 10 } = req.body || {};
      const q = query.toString();
      const lim = Math.min(limit, 50);
      
      logger.info('ChatGPT search POST request', { query: q, limit: lim });
      
      const { handleSearch } = await import('./tools/search.js');
      
      if (!q.trim()) {
        const { toolCatalog } = await import('./tools/catalog.js');
        const results = toolCatalog.slice(0, lim).map((item: any) => ({
          id: item.id,
          title: item.title,
          text: `${item.title}\n\n${item.description}\n\nReference: ${item.url}`,
          snippet: item.description,
          url: item.url,
          metadata: { 
            name: item.name, 
            category: 'tool',
            source: 'tool_catalog'
          }
        }));
        
        logger.info('ChatGPT search POST response (empty query)', { count: results.length });
        res.json({ results });
        return;
      }
      
      const searchResult = await handleSearch({ query: q, limit: lim });
      
      if ('results' in searchResult && Array.isArray(searchResult.results)) {
        const results = searchResult.results.map((item: any) => ({
          id: item.id || '',
          title: item.title || '',
          text: item.text || item.snippet || item.description || '',
          snippet: item.snippet || item.description || '',
          url: item.url || '',
          metadata: {
            status: item.status,
            list: item.list,
            category: item.category || 'task',
            source: 'clickup'
          }
        }));
        
        logger.info('ChatGPT search POST response', { query: q, count: results.length });
        res.json({ results });
      } else {
        logger.warn('ChatGPT search POST returned no results', { query: q });
        res.json({ results: [] });
      }
    } catch (error: any) {
      logger.error('ChatGPT search POST error', { error: error?.message });
      res.status(500).json({ 
        error: 'Search failed',
        message: error?.message || 'Internal server error'
      });
    }
  });
  
  app.get('/chatgpt/fetch', async (req, res) => {
    try {
      const id = (req.query.id as string) || '';
      
      if (!id) {
        res.status(400).json({ 
          error: 'Bad Request',
          message: 'Missing required parameter: id' 
        });
        return;
      }
      
      logger.info('ChatGPT fetch request', { id });
      
      const { handleFetch } = await import('./tools/fetch.js');
      const result = await handleFetch({ id });
      
      if ('id' in result && 'text' in result) {
        const response = {
          id: result.id,
          content: result.text || '',
          metadata: {
            title: result.title || '',
            url: result.url || '',
            category: result.metadata?.category || 'document',
            source: id.startsWith('tool:') ? 'tool_catalog' : 'clickup'
          }
        };
        
        logger.info('ChatGPT fetch response', { id, hasContent: !!response.content });
        res.json(response);
      } else {
        logger.warn('ChatGPT fetch - document not found', { id });
        res.status(404).json({ 
          error: 'Not Found',
          message: `Document with id '${id}' not found` 
        });
      }
    } catch (error: any) {
      logger.error('ChatGPT fetch error', { error: error?.message });
      res.status(500).json({ 
        error: 'Fetch failed',
        message: error?.message || 'Internal server error'
      });
    }
  });
  
  app.post('/chatgpt/fetch', async (req, res) => {
    try {
      const { id = '' } = req.body || {};
      
      if (!id) {
        res.status(400).json({ 
          error: 'Bad Request',
          message: 'Missing required parameter: id' 
        });
        return;
      }
      
      logger.info('ChatGPT fetch POST request', { id });
      
      const { handleFetch } = await import('./tools/fetch.js');
      const result = await handleFetch({ id });
      
      if ('id' in result && 'text' in result) {
        const response = {
          id: result.id,
          content: result.text || '',
          metadata: {
            title: result.title || '',
            url: result.url || '',
            category: result.metadata?.category || 'document',
            source: id.startsWith('tool:') ? 'tool_catalog' : 'clickup'
          }
        };
        
        logger.info('ChatGPT fetch POST response', { id, hasContent: !!response.content });
        res.json(response);
      } else {
        logger.warn('ChatGPT fetch POST - document not found', { id });
        res.status(404).json({ 
          error: 'Not Found',
          message: `Document with id '${id}' not found` 
        });
      }
    } catch (error: any) {
      logger.error('ChatGPT fetch POST error', { error: error?.message });
      res.status(500).json({ 
        error: 'Fetch failed',
        message: error?.message || 'Internal server error'
      });
    }
  });
  
  // Health check for ChatGPT connector
  app.get('/chatgpt/health', (_req, res) => {
    res.json({
      status: 'healthy',
      service: 'ChatGPT Deep Research Connector',
      version: '1.0.0',
      endpoints: [
        '/chatgpt/search',
        '/chatgpt/fetch'
      ],
      timestamp: new Date().toISOString()
    });
  });

  // Server creation and startup
  const PORT = Number(configuration.port ?? '3231');
  const HTTPS_PORT = Number(configuration.httpsPort ?? '3443');

  // Function to create and start HTTP server
  function startHttpServer() {
    const httpServer = http.createServer(app);
    httpServer.listen(PORT, '0.0.0.0', () => {
      logger.info('ClickUp MCP Server (HTTP) started', {
        port: PORT,
        protocol: 'http',
        endpoints: {
          streamableHttp: `http://127.0.0.1:${PORT}/mcp`,
          legacySSE: `http://127.0.0.1:${PORT}/sse`,
          health: `http://127.0.0.1:${PORT}/health`
        },
        security: {
          featuresEnabled: configuration.enableSecurityFeatures,
          originValidation: configuration.enableOriginValidation,
          rateLimit: configuration.enableRateLimit,
          cors: configuration.enableCors,
          httpsEnabled: configuration.enableHttps
        }
      });

      console.log(`✅ ClickUp MCP Server started on http://127.0.0.1:${PORT}`);
      console.log(`📡 Streamable HTTP endpoint: http://127.0.0.1:${PORT}/mcp`);
      console.log(`🔄 Legacy SSE endpoint: http://127.0.0.1:${PORT}/sse`);
      console.log(`❤️  Health check: http://127.0.0.1:${PORT}/health`);

      if (configuration.enableHttps) {
        console.log(`⚠️  HTTP server running alongside HTTPS - consider disabling HTTP in production`);
      }
    });
    return httpServer;
  }

  // Function to create and start HTTPS server
  function startHttpsServer() {
    if (!configuration.sslKeyPath || !configuration.sslCertPath) {
      logger.error('HTTPS enabled but SSL certificate paths not provided', {
        sslKeyPath: configuration.sslKeyPath,
        sslCertPath: configuration.sslCertPath
      });
      console.log(`❌ HTTPS enabled but SSL_KEY_PATH and SSL_CERT_PATH not provided`);
      console.log(`   Set SSL_KEY_PATH and SSL_CERT_PATH environment variables`);
      return null;
    }

    try {
      // Check if certificate files exist
      if (!fs.existsSync(configuration.sslKeyPath)) {
        throw new Error(`SSL key file not found: ${configuration.sslKeyPath}`);
      }
      if (!fs.existsSync(configuration.sslCertPath)) {
        throw new Error(`SSL certificate file not found: ${configuration.sslCertPath}`);
      }

      const httpsOptions: https.ServerOptions = {
        key: fs.readFileSync(configuration.sslKeyPath),
        cert: fs.readFileSync(configuration.sslCertPath)
      };

      // Add CA certificate if provided
      if (configuration.sslCaPath && fs.existsSync(configuration.sslCaPath)) {
        httpsOptions.ca = fs.readFileSync(configuration.sslCaPath);
      }

      const httpsServer = https.createServer(httpsOptions, app);
      httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
        logger.info('ClickUp MCP Server (HTTPS) started', {
          port: HTTPS_PORT,
          protocol: 'https',
          endpoints: {
            streamableHttp: `https://127.0.0.1:${HTTPS_PORT}/mcp`,
            legacySSE: `https://127.0.0.1:${HTTPS_PORT}/sse`,
            health: `https://127.0.0.1:${HTTPS_PORT}/health`
          },
          security: {
            featuresEnabled: configuration.enableSecurityFeatures,
            originValidation: configuration.enableOriginValidation,
            rateLimit: configuration.enableRateLimit,
            cors: configuration.enableCors,
            httpsEnabled: true
          }
        });

        console.log(`🔒 ClickUp MCP Server (HTTPS) started on https://127.0.0.1:${HTTPS_PORT}`);
        console.log(`📡 Streamable HTTPS endpoint: https://127.0.0.1:${HTTPS_PORT}/mcp`);
        console.log(`🔄 Legacy SSE HTTPS endpoint: https://127.0.0.1:${HTTPS_PORT}/sse`);
        console.log(`❤️  Health check HTTPS: https://127.0.0.1:${HTTPS_PORT}/health`);
      });
      return httpsServer;
    } catch (error) {
      logger.error('Failed to start HTTPS server', {
        error: 'An error occurred while starting HTTPS server.',
        sslKeyPath: 'REDACTED',
        sslCertPath: 'REDACTED'
      });
      console.log(`❌ Failed to start HTTPS server. Please check the server configuration and logs for details.`);
      return null;
    }
  }

  // Start servers based on configuration
  const servers: (http.Server | https.Server)[] = [];

  // Always start HTTP server (for backwards compatibility)
  servers.push(startHttpServer());

  // Start HTTPS server if enabled
  if (configuration.enableHttps) {
    const httpsServer = startHttpsServer();
    if (httpsServer) {
      servers.push(httpsServer);
    }
  }

  // Security status logging
  if (configuration.enableSecurityFeatures) {
    console.log(`🔒 Security features enabled`);
  } else {
    console.log(`⚠️  Security features disabled (set ENABLE_SECURITY_FEATURES=true to enable)`);
  }

  if (!configuration.enableHttps) {
    console.log(`⚠️  HTTPS disabled (set ENABLE_HTTPS=true with SSL certificates to enable)`);
  }

  return servers;
}
