/* PreSQL MCP server — protocol layer.
 * Uses the low-level Server API with hand-written JSON schemas so the only
 * runtime dependency is @modelcontextprotocol/sdk (no zod, no extras).
 * Pure stdio: zero network at runtime. */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createRequire } from 'node:module';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { getSchema, Schema, normalizeDialect } from './schema.js';
import { handleValidateSql, handleExplainSql, handleGuardQuery, ToolArgs } from './tools.js';

export const SERVER_NAME = 'presql';

export function getVersion(): string {
  try {
    const nodeRequire = createRequire(__dirname);
    const pkg = nodeRequire('../package.json') as { version?: string };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const SQL_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    sql: {
      type: 'string',
      description: 'The SQL statement to check.',
    },
    dialect: {
      type: 'string',
      enum: ['postgres', 'postgresql', 'mysql', 'sqlite'],
      default: 'postgres',
      description: 'SQL dialect used to parse the statement.',
    },
  },
  required: ['sql'],
  additionalProperties: false,
};

export interface ServerOptions {
  ddl: string;
  schemaSource: string;
  defaultDialect: 'postgresql' | 'mysql' | 'sqlite';
}

function textResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

export function createPresqlServer(opts: ServerOptions): Server {
  const server = new Server(
    { name: SERVER_NAME, version: getVersion() },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'validate_sql',
        description:
          'Validate a SQL statement against the configured schema. Returns a verdict ' +
          '(safe/review/blocked), a list of issues with codes, severities, messages and ' +
          'fix suggestions, plus a plain-English explanation. Call this before ' +
          'executing AI-generated SQL.',
        inputSchema: SQL_INPUT_SCHEMA,
      },
      {
        name: 'explain_sql',
        description:
          'Explain a SQL statement in plain English. No verdict, no judgment — ' +
          'for understanding what a query does before deciding whether to run it.',
        inputSchema: SQL_INPUT_SCHEMA,
      },
      {
        name: 'guard_query',
        description:
          'Pre-execution safety hook for AI-generated SQL. Returns a go/no-go ' +
          'decision (allow/review/block) with a human-readable reason and the ' +
          'underlying verdict. Designed to be called before handing SQL to a ' +
          'database MCP server or executing it.',
        inputSchema: SQL_INPUT_SCHEMA,
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs || {}) as ToolArgs;

    try {
      const dialect = typeof args.dialect === 'string' ? args.dialect : opts.defaultDialect;
      const schema: Schema = getSchema(opts.ddl, normalizeDialect(dialect));

      switch (name) {
        case 'validate_sql':
          return textResult(handleValidateSql(schema, args));
        case 'explain_sql':
          return textResult(handleExplainSql(schema, args));
        case 'guard_query':
          return textResult(handleGuardQuery(schema, args));
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (err) {
      if (err instanceof McpError) throw err;
      // Input validation and engine errors surface as MCP InvalidParams,
      // so clients see a structured error instead of a crashed server.
      throw new McpError(
        ErrorCode.InvalidParams,
        err instanceof Error ? err.message : String(err),
      );
    }
  });

  return server;
}
