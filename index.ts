#!/usr/bin/env node
/* PreSQL — a seatbelt for AI-generated SQL.
 * MCP server over stdio. Usage:
 *   presql [--schema path/to/schema.sql] [--dialect postgres|mysql|sqlite]
 * Env: SQL_GUARD_SCHEMA (schema file path), SQL_GUARD_DDL (inline DDL),
 *      SQL_GUARD_DIALECT (default dialect). */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createPresqlServer } from './server.js';
import { resolveSchemaDDL, resolveStartupDialect, getSchema } from './schema.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`PreSQL — validate AI-generated SQL before it runs.

Usage: presql [--schema <file>] [--dialect <postgres|mysql|sqlite>]

Schema resolution order:
  1. --schema <file>
  2. SQL_GUARD_SCHEMA env var (file path)
  3. SQL_GUARD_DDL env var (inline DDL)
  4. built-in demo schema (zero-config fallback)

Tools: validate_sql, explain_sql, guard_query`);
    process.exit(0);
  }

  const { ddl, source } = resolveSchemaDDL(argv, process.env);
  const defaultDialect = resolveStartupDialect(argv, process.env);
  // Parse once at startup so a broken schema fails fast with a clear error.
  const schema = getSchema(ddl, defaultDialect);
  if (schema.errors.length > 0) {
    console.error(
      `presql: warning: ${schema.errors.length} schema chunk(s) did not parse (${source}); ` +
        'name checks for those chunks are skipped.',
    );
  }
  console.error(`presql: schema loaded from ${source} (${Object.keys(schema.tables).length} tables)`);

  const server = createPresqlServer({ ddl, schemaSource: source, defaultDialect });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('presql: fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
