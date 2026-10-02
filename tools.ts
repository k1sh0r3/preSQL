/* PreSQL tool handlers — pure functions over the validator engine.
 * Each handler takes a parsed Schema + validated args and returns a
 * plain-JSON-serializable result. No MCP types here: server.ts owns the
 * protocol layer, which keeps these trivially unit-testable. */
import { validator, Schema, Issue } from './engine.js';
import { normalizeDialect, Dialect } from './schema.js';

export interface ToolArgs {
  sql?: unknown;
  dialect?: unknown;
}

export interface ValidateOutput {
  verdict: 'safe' | 'review' | 'blocked' | 'unknown';
  issues: Array<{ code: string; severity: string; message: string; suggestion: string | null }>;
  explanation: string;
}

export interface ExplainOutput {
  explanation: string;
}

export type Decision = 'allow' | 'review' | 'block';

export interface GuardOutput {
  decision: Decision;
  reason: string;
  verdict: 'safe' | 'review' | 'blocked' | 'unknown';
}

function cleanIssue(i: Issue) {
  return { code: i.code, severity: i.severity, message: i.message, suggestion: i.suggestion };
}

function requireSql(args: ToolArgs): string {
  if (typeof args.sql !== 'string' || args.sql.trim() === '') {
    throw new Error('Invalid arguments: "sql" is required and must be a non-empty string.');
  }
  return args.sql;
}

function dialectOf(args: ToolArgs): Dialect {
  return normalizeDialect(args.dialect);
}

export function handleValidateSql(schema: Schema, args: ToolArgs): ValidateOutput {
  const sql = requireSql(args);
  const dialect = dialectOf(args);
  const report = validator.validate(sql, schema, dialect);
  return {
    verdict: validator.verdict(report),
    issues: report.issues.map(cleanIssue),
    explanation: validator.explain(sql, schema, dialect),
  };
}

export function handleExplainSql(schema: Schema, args: ToolArgs): ExplainOutput {
  const sql = requireSql(args);
  const dialect = dialectOf(args);
  return { explanation: validator.explain(sql, schema, dialect) };
}

export function handleGuardQuery(schema: Schema, args: ToolArgs): GuardOutput {
  const sql = requireSql(args);
  const dialect = dialectOf(args);
  const report = validator.validate(sql, schema, dialect);
  const verdict = validator.verdict(report);
  const decision: Decision = verdict === 'blocked' ? 'block' : verdict === 'review' ? 'review' : 'allow';
  let reason: string;
  if (decision === 'allow') {
    reason = 'No blocking issues found.';
  } else {
    const relevant = report.issues.filter((i) =>
      i.severity === 'error' || (decision === 'review' && i.severity === 'warning'),
    );
    reason = relevant.length
      ? relevant.map((i) => i.message).join(' ')
      : 'See verdict for details.';
  }
  return { decision, reason, verdict };
}
