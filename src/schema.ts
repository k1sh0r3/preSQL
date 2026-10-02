/* PreSQL schema loading.
 * Priority: --schema <file> > SQL_GUARD_SCHEMA (file path) >
 *            SQL_GUARD_DDL (inline DDL) > packaged demo/schema.sql >
 *            embedded demo DDL (zero-config fallback). */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { validator, Schema } from './engine.js';
export type { Schema } from './engine.js';

/* Canonical dialect names are the ones node-sql-parser expects:
 * 'postgresql' (NOT 'postgres'), 'mysql', 'sqlite'. Aliases are accepted
 * in tool input but always normalized to the canonical form — 'postgres'
 * parses DELETE statements incorrectly in the vendored parser. */
export type Dialect = 'postgresql' | 'mysql' | 'sqlite';

export function normalizeDialect(d: unknown): Dialect {
  const v = String(d == null ? '' : d).toLowerCase();
  if (v === 'postgres' || v === 'postgresql') return 'postgresql';
  if (v === 'mysql') return 'mysql';
  if (v === 'sqlite') return 'sqlite';
  return 'postgresql';
}

/* Embedded copy of demo/schema.sql — guarantees `npx @k1sh0r3/presql`
 * works with zero config no matter where the package is installed. */
export const EMBEDDED_DEMO_DDL = `-- PreSQL demo schema: a tiny e-commerce warehouse.
CREATE TABLE customers (
  id INT PRIMARY KEY,
  name VARCHAR(100),
  email VARCHAR(255),
  phone VARCHAR(20),
  country VARCHAR(50),
  created_at TIMESTAMP
);
CREATE TABLE orders (
  id INT PRIMARY KEY,
  customer_id INT,
  total DECIMAL(10,2),
  status VARCHAR(20),
  ordered_at TIMESTAMP
);
CREATE TABLE products (
  id INT PRIMARY KEY,
  name VARCHAR(100),
  price DECIMAL(10,2),
  category VARCHAR(50)
);
CREATE TABLE refunds (
  id INT PRIMARY KEY,
  order_id INT,
  refund_amount DECIMAL(10,2),
  reason TEXT,
  created_at TIMESTAMP
);
`;

export interface SchemaSource {
  ddl: string;
  source: string;
}

function readFileSafe(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export function resolveSchemaDDL(argv: string[], env: NodeJS.ProcessEnv): SchemaSource {
  const flagIdx = argv.indexOf('--schema');
  if (flagIdx !== -1 && argv[flagIdx + 1]) {
    const p = path.resolve(argv[flagIdx + 1]);
    const ddl = readFileSafe(p);
    if (ddl == null) throw new Error(`--schema file not found: ${p}`);
    return { ddl, source: `flag:${p}` };
  }
  if (env.SQL_GUARD_SCHEMA) {
    const p = path.resolve(env.SQL_GUARD_SCHEMA);
    const ddl = readFileSafe(p);
    if (ddl == null) throw new Error(`SQL_GUARD_SCHEMA file not found: ${p}`);
    return { ddl, source: `env:SQL_GUARD_SCHEMA:${p}` };
  }
  if (env.SQL_GUARD_DDL) {
    return { ddl: env.SQL_GUARD_DDL, source: 'env:SQL_GUARD_DDL' };
  }
  const candidates = [
    path.join(__dirname, '..', 'demo', 'schema.sql'),
    path.join(process.cwd(), 'demo', 'schema.sql'),
  ];
  for (const c of candidates) {
    const ddl = readFileSafe(c);
    if (ddl != null) return { ddl, source: `demo:${c}` };
  }
  return { ddl: EMBEDDED_DEMO_DDL, source: 'embedded-demo' };
}

export function resolveStartupDialect(argv: string[], env: NodeJS.ProcessEnv): Dialect {
  const flagIdx = argv.indexOf('--dialect');
  if (flagIdx !== -1 && argv[flagIdx + 1]) return normalizeDialect(argv[flagIdx + 1]);
  if (env.SQL_GUARD_DIALECT) return normalizeDialect(env.SQL_GUARD_DIALECT);
  return 'postgresql';
}

/* Schema cache: parse the DDL once per dialect, reuse across tool calls. */
const schemaCache = new Map<string, Schema>();

export function getSchema(ddl: string, dialect: Dialect): Schema {
  const key = `${dialect}:${ddl.length}:${hashStr(ddl)}`;
  let s = schemaCache.get(key);
  if (!s) {
    s = validator.parseSchema(ddl, dialect);
    schemaCache.set(key, s);
  }
  return s;
}

function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}
