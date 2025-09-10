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
    const sessionId = req.query.sessionId as string;
    const transport = transports.sse[sessionId];
    if (transport) {
      await transport.handlePostMessage(req, res, req.body);
    } else {
      res.status(400).send('No transport found for sessionId');
    }
  });

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: '0.8.3',
      security: {
        featuresEnabled: configuration.enableSecurityFeatures,
        originValidation: configuration.enableOriginValidation,
        rateLimit: configuration.enableRateLimit,
        cors: configuration.enableCors
      }
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
