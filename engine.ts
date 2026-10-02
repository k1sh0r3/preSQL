/* PreSQL engine loader — binds the vendored UMD validator + SQL parser.
 * validator.js and node-sql-parser.umd.js are copied VERBATIM from the
 * SQL Sentinel web app; this file only wires them together with types. */
import { createRequire } from 'node:module';
import * as path from 'node:path';

export interface Issue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  suggestion: string | null;
}

export interface Report {
  ok: boolean;
  dialect: string | null;
  parsedDialect: string | null;
  statementType: string | null;
  issues: Issue[];
}

export interface SchemaColumn { type: string; category: string }
export interface SchemaTable { name: string; columns: Record<string, SchemaColumn>; pii: string[] }
export interface Schema { tables: Record<string, SchemaTable>; errors: string[] }

export interface Validator {
  parseSchema(ddl: string, dialect: string): Schema;
  validate(sql: string, schema: Schema, dialect: string): Report;
  explain(sql: string, schema: Schema, dialect: string): string;
  verdict(report: Report): 'safe' | 'review' | 'blocked' | 'unknown';
}

const nodeRequire = createRequire(path.join(__dirname, 'engine.js'));

const { Parser } = nodeRequire('./vendor/node-sql-parser.umd.js') as {
  Parser: new () => unknown;
};
const SqlSentinel = nodeRequire('./vendor/validator.js') as {
  createValidator(parser: unknown): Validator;
};

export const validator: Validator = SqlSentinel.createValidator(Parser);
export type ParserClass = new () => unknown;
export const ParserCtor: ParserClass = Parser;
