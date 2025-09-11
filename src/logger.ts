/**
 * SPDX-FileCopyrightText: © 2025 Talib Kareem <taazkareem@icloud.com>
 * SPDX-License-Identifier: MIT
 *
 * Logger module for MCP Server
 * 
 * This module provides logging functionality for the server,
 * writing logs to only the log file to avoid interfering with JSON-RPC.
 */

import { createWriteStream, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config, { LogLevel } from './config.js';

// Get the directory name of the current module
const __dirname = dirname(fileURLToPath(import.meta.url));

// Current process ID for logging
const pid = process.pid;

// Prefer a writable path inside containers; fall back to module dir if provided via env
const LOG_FILE_DIR = process.env.LOG_FILE_DIR || '/tmp/clickup-mcp';
const LOG_FILE_NAME = process.env.LOG_FILE_NAME || 'server.log';
const LOG_PATH = join(LOG_FILE_DIR, LOG_FILE_NAME);

// Create directory if needed and set up a safe writer that falls back to stderr
let logStream: ReturnType<typeof createWriteStream> | null = null;
let fallbackToStderr = false;
try {
  // Ensure directory exists (no-op if already exists)
  mkdirSync(LOG_FILE_DIR, { recursive: true });
  logStream = createWriteStream(LOG_PATH, { flags: 'a' });
  // If any stream error occurs, switch to stderr to avoid crashing
  logStream.on('error', () => {
    fallbackToStderr = true;
  });
} catch (_e) {
  fallbackToStderr = true;
}

function writeLog(line: string) {
  try {
    if (!fallbackToStderr && logStream) {
      logStream.write(line + '\n');
      return;
    }
  } catch (_e) {
    // Fall through to stderr
  }
  try {
    // Last-resort logging that will not crash JSON-RPC stdio if used incorrectly
    // but acceptable for HTTP/SSE mode; used only when file logging fails
    process.stderr.write(line + '\n');
  } catch (_e) {
    // Swallow to avoid any crash due to logging
  }
}

// Write init message to the selected sink
writeLog(`Logging initialized to ${fallbackToStderr ? 'stderr' : LOG_PATH}`);

// Use the configured log level from config.ts
const configuredLevel = config.logLevel;

// Re-export LogLevel enum
export { LogLevel };

/**
 * Check if a log level is enabled based on the configured level
 * @param level The log level to check
 * @returns True if the level should be logged
 */
function isLevelEnabled(level: LogLevel): boolean {
  return level >= configuredLevel;
}

/**
 * Log function that writes only to file to avoid interfering with JSON-RPC
 * @param level Log level (trace, debug, info, warn, error)
 * @param message Message to log
 * @param data Optional data to include in log
 */
function log(level: 'trace' | 'debug' | 'info' | 'warn' | 'error', message: string, data?: any) {
  const levelEnum = level === 'trace' ? LogLevel.TRACE 
    : level === 'debug' ? LogLevel.DEBUG
    : level === 'info' ? LogLevel.INFO
    : level === 'warn' ? LogLevel.WARN 
    : LogLevel.ERROR;
  
  // Skip if level is below configured level
  if (!isLevelEnabled(levelEnum)) {
    return;
  }
  
  const timestamp = new Date().toISOString();
  
  // Format the log message differently based on the level and data
  let logMessage = `[${timestamp}] [PID:${pid}] ${level.toUpperCase()}: ${message}`;
  
  // Format data differently based on content and log level
  if (data) {
    // For debugging and trace levels, try to make the data more readable
    if (level === 'debug' || level === 'trace') {
      // If data is a simple object with few properties, format it inline
      if (typeof data === 'object' && data !== null && !Array.isArray(data) && 
          Object.keys(data).length <= 4 && Object.keys(data).every(k => 
            typeof data[k] !== 'object' || data[k] === null)) {
        const dataStr = Object.entries(data)
          .map(([k, v]) => `${k}=${v === undefined ? 'undefined' : 
            (v === null ? 'null' : 
              (typeof v === 'string' ? `"${v}"` : v))}`)
          .join(' ');
        
        logMessage += ` (${dataStr})`;
      } else {
        // For more complex data, keep the JSON format but on new lines
        logMessage += '\n' + JSON.stringify(data, null, 2);
      }
    } else {
      // For other levels, keep the original JSON format
      logMessage += '\n' + JSON.stringify(data, null, 2);
    }
  }

  // Always use the safe writer
  writeLog(logMessage);
}

/**
 * Shorthand for info level logs
 * @param message Message to log
 * @param data Optional data to include in log
 */
export function info(message: string, data?: any) {
  log('info', message, data);
}

/**
 * Shorthand for error level logs
 * @param message Message to log
 * @param data Optional data to include in log
 */
export function error(message: string, data?: any) {
  log('error', message, data);
}

/**
 * Logger class for creating context-specific loggers
 */
export class Logger {
  private context: string;

  /**
   * Create a new logger with context
   * @param context The context to prepend to log messages
   */
  constructor(context: string) {
    this.context = context;
  }

  /**
   * Check if a log level is enabled for this logger
   * @param level The level to check
   * @returns True if logging at this level is enabled
   */
  isLevelEnabled(level: LogLevel): boolean {
    return isLevelEnabled(level);
  }

  /**
   * Log at trace level
   * @param message Message to log
   * @param data Optional data to include in log
   */
  trace(message: string, data?: any) {
    log('trace', `[${this.context}] ${message}`, data);
  }

  /**
   * Log at debug level
   * @param message Message to log
   * @param data Optional data to include in log
   */
  debug(message: string, data?: any) {
    log('debug', `[${this.context}] ${message}`, data);
  }

  /**
   * Log at info level
   * @param message Message to log
   * @param data Optional data to include in log
   */
  info(message: string, data?: any) {
    log('info', `[${this.context}] ${message}`, data);
  }

  /**
   * Log at warn level
   * @param message Message to log
   * @param data Optional data to include in log
   */
  warn(message: string, data?: any) {
    log('warn', `[${this.context}] ${message}`, data);
  }

  /**
   * Log at error level
   * @param message Message to log
   * @param data Optional data to include in log
   */
  error(message: string, data?: any) {
    log('error', `[${this.context}] ${message}`, data);
  }
}

// Handle SIGTERM for clean shutdown
process.on('SIGTERM', () => {
  log('info', 'Received SIGTERM signal, shutting down...');
  if (logStream && !fallbackToStderr) {
    logStream.end(() => {
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
});