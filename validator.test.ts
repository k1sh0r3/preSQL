/* PreSQL engine tests — ported 1:1 from the SQL Sentinel web app's
 * tests/test_validator.js (30/30 green there). Same expectations, untouched.
 * Run: npm test  (tsc && node --test dist/tests/) */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validator } from '../src/engine.js';

const DEMO_DDL = `
CREATE TABLE customers (id INT PRIMARY KEY, name VARCHAR(100), email VARCHAR(255), phone VARCHAR(20), country VARCHAR(50), created_at TIMESTAMP);
CREATE TABLE orders (id INT PRIMARY KEY, customer_id INT, total DECIMAL(10,2), status VARCHAR(20), ordered_at TIMESTAMP);
CREATE TABLE products (id INT PRIMARY KEY, name VARCHAR(100), price DECIMAL(10,2), category VARCHAR(50));
CREATE TABLE refunds (id INT PRIMARY KEY, order_id INT, refund_amount DECIMAL(10,2), reason TEXT, created_at TIMESTAMP);
`;
const schema = validator.parseSchema(DEMO_DDL, 'postgresql');

function codes(report: { issues: Array<{ code: string }> }): string[] {
  return report.issues.map((i) => i.code);
}
function hasCode(report: { issues: Array<{ code: string }> }, code: string): boolean {
  return codes(report).includes(code);
}
function errorsOf(report: { issues: Array<{ code: string; severity: string }> }) {
  return report.issues.filter((i) => i.severity === 'error');
}

describe('parseSchema', () => {
  it('schema parses 4 tables', () => {
    assert.deepStrictEqual(Object.keys(schema.tables).sort(), ['customers', 'orders', 'products', 'refunds']);
  });
  it('schema column types captured', () => {
    assert.strictEqual(schema.tables.customers.columns.email.type, 'VARCHAR');
    assert.strictEqual(schema.tables.orders.columns.total.category, 'number');
    assert.strictEqual(schema.tables.customers.columns.created_at.category, 'datetime');
  });
  it('schema flags PII columns', () => {
    const pii = schema.tables.customers.pii;
    assert(pii.includes('email'), 'email should be PII, got ' + pii);
    assert(pii.includes('phone'), 'phone should be PII, got ' + pii);
    assert(!pii.includes('id'), 'id should not be PII');
    assert(!schema.tables.orders.pii.includes('total'), 'total should not be PII');
  });
  it('schema falls back across dialects (bigquery types)', () => {
    const s = validator.parseSchema('CREATE TABLE t (id INT64, name STRING, ts TIMESTAMP);', 'bigquery');
    assert(s.tables.t, 'expected table t, errors: ' + s.errors.join('|'));
    assert.strictEqual(s.tables.t.columns.id.category, 'number');
    assert.strictEqual(s.tables.t.columns.name.category, 'string');
  });
  it('schema records unparsable chunks honestly', () => {
    const s = validator.parseSchema('CREATE TABLE ok (id INT); THIS IS NOT SQL;', 'postgresql');
    assert(s.tables.ok, 'ok table should parse');
    assert(s.errors.length >= 1, 'expected at least one schema error, got none');
  });
});

describe('unknown column/table + did-you-mean', () => {
  it('unknown column errors with did-you-mean', () => {
    const r = validator.validate('SELECT refund_amt FROM refunds;', schema, 'postgresql');
    assert(!r.ok, 'expected ok:false');
    assert(hasCode(r, 'UNKNOWN_COLUMN'), 'expected UNKNOWN_COLUMN, got ' + codes(r));
    const iss = r.issues.find((i) => i.code === 'UNKNOWN_COLUMN');
    assert(iss && /refund_amount/.test(iss.message), 'expected suggestion of refund_amount, got: ' + (iss && iss.message));
  });
  it('unknown table errors with did-you-mean', () => {
    const r = validator.validate('SELECT * FROM customer LIMIT 1;', schema, 'postgresql');
    assert(hasCode(r, 'UNKNOWN_TABLE'), 'expected UNKNOWN_TABLE, got ' + codes(r));
    const iss = r.issues.find((i) => i.code === 'UNKNOWN_TABLE');
    assert(iss && /customers/.test(iss.message));
  });
  it('valid query passes clean', () => {
    const r = validator.validate(
      "SELECT c.name, SUM(o.total) AS revenue FROM customers c JOIN orders o ON c.id = o.customer_id " +
        "WHERE c.country = 'US' GROUP BY c.name ORDER BY revenue DESC LIMIT 10;",
      schema,
      'postgresql',
    );
    assert.strictEqual(errorsOf(r).length, 0, 'expected no errors, got: ' + JSON.stringify(r.issues, null, 1));
    assert(r.ok, 'expected ok:true');
    assert.strictEqual(validator.verdict(r), 'safe');
  });
});

describe('destructive ops', () => {
  it('DELETE without WHERE is an error', () => {
    const r = validator.validate('DELETE FROM orders;', schema, 'postgresql');
    assert(!r.ok);
    assert(hasCode(r, 'DESTRUCTIVE_NO_WHERE'));
    assert.strictEqual(validator.verdict(r), 'blocked');
  });
  it('DELETE with WHERE warns but passes', () => {
    const r = validator.validate('DELETE FROM orders WHERE id = 1;', schema, 'postgresql');
    assert(r.ok, 'expected ok:true, got ' + JSON.stringify(r.issues));
    assert(hasCode(r, 'DESTRUCTIVE_WHERE'));
    assert.strictEqual(validator.verdict(r), 'review');
  });
  it('UPDATE without WHERE is an error', () => {
    const r = validator.validate("UPDATE customers SET country = 'US';", schema, 'postgresql');
    assert(!r.ok);
    assert(hasCode(r, 'DESTRUCTIVE_NO_WHERE'));
  });
  it('DROP TABLE is an error', () => {
    const r = validator.validate('DROP TABLE customers;', schema, 'postgresql');
    assert(!r.ok);
    assert(hasCode(r, 'DESTRUCTIVE_UNBOUNDED'));
  });
  it('TRUNCATE is an error', () => {
    const r = validator.validate('TRUNCATE TABLE orders;', schema, 'postgresql');
    assert(!r.ok);
    assert(hasCode(r, 'DESTRUCTIVE_UNBOUNDED'));
  });
});

describe('joins', () => {
  it('implicit comma cross join warns', () => {
    const r = validator.validate('SELECT * FROM customers, orders LIMIT 5;', schema, 'postgresql');
    assert(hasCode(r, 'IMPLICIT_CROSS_JOIN'), 'got ' + codes(r));
  });
  it('JOIN without ON warns', () => {
    const r = validator.validate('SELECT * FROM customers CROSS JOIN orders LIMIT 5;', schema, 'postgresql');
    assert(hasCode(r, 'CROSS_JOIN') || hasCode(r, 'IMPLICIT_CROSS_JOIN'), 'got ' + codes(r));
  });
});

describe('types', () => {
  it('number vs string comparison warns', () => {
    const r = validator.validate("SELECT id FROM customers WHERE id = 'abc' LIMIT 5;", schema, 'postgresql');
    assert(hasCode(r, 'TYPE_MISMATCH'), 'got ' + codes(r));
  });
  it('date literal vs datetime column does not warn', () => {
    const r = validator.validate("SELECT id FROM customers WHERE created_at > '2024-01-01' LIMIT 5;", schema, 'postgresql');
    assert(!hasCode(r, 'TYPE_MISMATCH'), 'unexpected TYPE_MISMATCH in ' + codes(r));
  });
});

describe('misc checks', () => {
  it('SELECT * is info, not error', () => {
    const r = validator.validate('SELECT * FROM customers LIMIT 5;', schema, 'postgresql');
    assert(r.ok);
    assert(hasCode(r, 'SELECT_STAR'));
    const iss = r.issues.find((i) => i.code === 'SELECT_STAR');
    assert(iss && iss.severity === 'info');
  });
  it('missing LIMIT warns', () => {
    const r = validator.validate('SELECT name FROM customers;', schema, 'postgresql');
    assert(hasCode(r, 'MISSING_LIMIT'), 'got ' + codes(r));
  });
  it('PII access warns', () => {
    const r = validator.validate('SELECT email FROM customers LIMIT 5;', schema, 'postgresql');
    assert(hasCode(r, 'PII_ACCESS'), 'got ' + codes(r));
    const iss = r.issues.find((i) => i.code === 'PII_ACCESS');
    assert(iss && /email/.test(iss.message));
  });
  it('ambiguous column warns', () => {
    const r = validator.validate('SELECT id FROM customers c JOIN orders o ON c.id = o.customer_id LIMIT 5;', schema, 'postgresql');
    assert(hasCode(r, 'AMBIGUOUS_COLUMN'), 'got ' + codes(r));
  });
  it('parse error is honest', () => {
    const r = validator.validate('SELECT FROM WHERE;', schema, 'postgresql');
    assert(!r.ok);
    assert(hasCode(r, 'PARSE_ERROR'));
  });
  it('no schema skips name checks honestly', () => {
    const r = validator.validate('SELECT whatever FROM nope LIMIT 1;', { tables: {} } as any, 'postgresql');
    assert(hasCode(r, 'SCHEMA_MISSING'));
    assert(r.ok, 'should not error without schema, got ' + JSON.stringify(r.issues));
  });
});

describe('explain', () => {
  it('explanation covers clauses', () => {
    const words = validator.explain(
      "SELECT c.name, SUM(o.total) AS revenue FROM customers c JOIN orders o ON c.id = o.customer_id " +
        "WHERE c.country = 'US' GROUP BY c.name ORDER BY revenue DESC LIMIT 10;",
      schema,
      'postgresql',
    );
    for (const needle of ['customers', 'orders', "'US'", '10', 'Groups rows by']) {
      assert(words.includes(needle), 'explanation missing "' + needle + '": ' + words);
    }
  });
  it('explanation of DELETE without WHERE is blunt', () => {
    const words = validator.explain('DELETE FROM orders;', schema, 'postgresql');
    assert(/EVERY row/.test(words), 'got: ' + words);
  });
  it('explanation never throws on garbage', () => {
    const words = validator.explain('SELECT FROM WHERE;', schema, 'postgresql');
    assert(typeof words === 'string' && words.length > 0);
  });
});

describe('CTEs, subqueries, INSERT', () => {
  it('CTE name resolves, no false unknown-table', () => {
    const r = validator.validate('WITH x AS (SELECT id FROM customers) SELECT id FROM x LIMIT 5;', schema, 'postgresql');
    assert(!hasCode(r, 'UNKNOWN_TABLE'), 'unexpected UNKNOWN_TABLE in ' + codes(r));
  });
  it('subquery columns are not falsely flagged', () => {
    const r = validator.validate('SELECT id FROM (SELECT id FROM customers) AS sub LIMIT 5;', schema, 'postgresql');
    assert(!hasCode(r, 'UNKNOWN_COLUMN'), 'unexpected UNKNOWN_COLUMN in ' + codes(r));
  });
  it('INSERT checks column list', () => {
    const r = validator.validate("INSERT INTO customers (id, nope) VALUES (1, 'x');", schema, 'postgresql');
    assert(hasCode(r, 'UNKNOWN_COLUMN'), 'expected UNKNOWN_COLUMN, got ' + codes(r));
    assert(!r.ok);
  });
  it('valid INSERT passes', () => {
    const r = validator.validate("INSERT INTO customers (id, name) VALUES (1, 'x');", schema, 'postgresql');
    assert(r.ok, 'expected ok:true, got ' + JSON.stringify(r.issues));
  });
});
