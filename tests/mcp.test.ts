/* PreSQL MCP protocol tests — real Client <-> Server handshake over an
 * in-process transport pair. No mocks: this exercises the actual JSON-RPC
 * plumbing, tool schemas, dispatch, and error mapping.
 * Run: npm test */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPresqlServer } from '../src/server.js';
import { EMBEDDED_DEMO_DDL } from '../src/schema.js';

function textOf(result: unknown): string {
  const r = result as { content: Array<{ type: string; text: string }> };
  assert(Array.isArray(r.content) && r.content.length > 0, 'expected text content');
  assert.strictEqual(r.content[0].type, 'text');
  return r.content[0].text;
}
function jsonOf(result: unknown): any {
  return JSON.parse(textOf(result));
}

describe('presql MCP protocol', () => {
  let client: Client;

  before(async () => {
    const server = createPresqlServer({
      ddl: EMBEDDED_DEMO_DDL,
      schemaSource: 'test',
      defaultDialect: 'postgresql',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'presql-test-client', version: '0.0.0' }, { capabilities: {} });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  it('list_tools returns exactly the 3 tools with correct JSON schemas', async () => {
    const res = await client.listTools();
    const names = res.tools.map((t) => t.name).sort();
    assert.deepStrictEqual(names, ['explain_sql', 'guard_query', 'validate_sql']);
    for (const tool of res.tools) {
      const schema = tool.inputSchema as any;
      assert.strictEqual(schema.type, 'object', `${tool.name}: inputSchema.type`);
      assert(schema.required.includes('sql'), `${tool.name}: sql must be required`);
      assert(schema.properties.sql, `${tool.name}: missing sql property`);
      assert(schema.properties.dialect, `${tool.name}: missing dialect property`);
      assert(tool.description && tool.description.length > 20, `${tool.name}: description too thin`);
    }
  });

  it('validate_sql: safe SELECT returns verdict safe', async () => {
    const out = jsonOf(
      await client.callTool({
        name: 'validate_sql',
        arguments: { sql: 'SELECT name FROM customers WHERE country = \'US\' LIMIT 10;' },
      }),
    );
    assert.strictEqual(out.verdict, 'safe');
    assert(Array.isArray(out.issues));
    assert(typeof out.explanation === 'string' && out.explanation.length > 0);
  });

  it('validate_sql: DELETE without WHERE is blocked with DESTRUCTIVE_NO_WHERE', async () => {
    const out = jsonOf(
      await client.callTool({ name: 'validate_sql', arguments: { sql: 'DELETE FROM orders;' } }),
    );
    assert.strictEqual(out.verdict, 'blocked');
    assert(out.issues.some((i: any) => i.code === 'DESTRUCTIVE_NO_WHERE'));
    assert(/EVERY row/.test(out.explanation));
  });

  it('validate_sql: typo column yields did-you-mean suggestion', async () => {
    const out = jsonOf(
      await client.callTool({
        name: 'validate_sql',
        arguments: { sql: 'SELECT refund_amt FROM refunds;' },
      }),
    );
    const iss = out.issues.find((i: any) => i.code === 'UNKNOWN_COLUMN');
    assert(iss, 'expected UNKNOWN_COLUMN, got ' + JSON.stringify(out.issues));
    assert(/refund_amount/.test(iss.message), 'expected did-you-mean refund_amount: ' + iss.message);
  });

  it('validate_sql: multi-statement input warns honestly', async () => {
    const out = jsonOf(
      await client.callTool({
        name: 'validate_sql',
        arguments: { sql: 'SELECT 1; DELETE FROM orders;' },
      }),
    );
    assert(out.issues.some((i: any) => i.code === 'MULTI_STATEMENT'));
  });

  it('explain_sql: JOIN query returns a plain-English explanation', async () => {
    const out = jsonOf(
      await client.callTool({
        name: 'explain_sql',
        arguments: {
          sql: 'SELECT u.name, COUNT(o.id) FROM customers u JOIN orders o ON o.customer_id = u.id GROUP BY u.name;',
        },
      }),
    );
    assert(typeof out.explanation === 'string' && out.explanation.length > 20);
    assert(/customer|order/i.test(out.explanation), 'explanation should name the tables: ' + out.explanation);
    assert(!('verdict' in out), 'explain_sql must not pass judgment');
  });

  it('guard_query: safe query → allow; UPDATE without WHERE → block', async () => {
    const okRes = jsonOf(
      await client.callTool({
        name: 'guard_query',
        arguments: { sql: "SELECT id FROM orders WHERE status = 'shipped' LIMIT 5;" },
      }),
    );
    assert.strictEqual(okRes.decision, 'allow');
    assert.strictEqual(okRes.verdict, 'safe');

    const badRes = jsonOf(
      await client.callTool({
        name: 'guard_query',
        arguments: { sql: "UPDATE orders SET status = 'shipped';" },
      }),
    );
    assert.strictEqual(badRes.decision, 'block');
    assert.strictEqual(badRes.verdict, 'blocked');
    assert(typeof badRes.reason === 'string' && badRes.reason.length > 0);
  });

  it('guard_query: risky-but-valid query → review', async () => {
    const out = jsonOf(
      await client.callTool({
        name: 'guard_query',
        arguments: { sql: 'DELETE FROM orders WHERE id = 1;' },
      }),
    );
    assert.strictEqual(out.decision, 'review');
    assert.strictEqual(out.verdict, 'review');
  });

  it('unknown tool → proper MCP error', async () => {
    await assert.rejects(
      client.callTool({ name: 'drop_database', arguments: {} }),
      (err: any) => {
        assert(err && typeof err.code === 'number', 'expected MCP error with numeric code');
        assert.strictEqual(err.code, -32601); // MethodNotFound
        return true;
      },
    );
  });

  it('missing sql argument → proper MCP error', async () => {
    await assert.rejects(
      client.callTool({ name: 'validate_sql', arguments: {} }),
      (err: any) => {
        assert(err && typeof err.code === 'number', 'expected MCP error with numeric code');
        assert.strictEqual(err.code, -32602); // InvalidParams
        return true;
      },
    );
  });

  it('garbage SQL → honest PARSE_ERROR, not a crash', async () => {
    const out = jsonOf(
      await client.callTool({ name: 'validate_sql', arguments: { sql: 'SELECT FROM WHERE;' } }),
    );
    assert.strictEqual(out.verdict, 'blocked');
    assert(out.issues.some((i: any) => i.code === 'PARSE_ERROR'));
  });
});
