# PreSQL — a seatbelt for AI-generated SQL

An MCP server that validates SQL **before it runs**. Give it your schema; it gives your agents three tools:

| Tool | What it does |
|---|---|
| `validate_sql` | Validates a statement against your schema → `safe` / `review` / `blocked` verdict, issue codes, fix suggestions, plain-English explanation |
| `explain_sql` | Explains what a statement does in plain English (no verdict — for understanding before deciding) |
| `guard_query` | Pre-execution go/no-go hook → `allow` / `review` / `block` with a human-readable reason |

Database MCP servers give agents *access*. PreSQL checks the SQL *before it goes in*. It composes with any of them — point your agent at both.

Zero network at runtime. Zero config to try. MIT licensed.

## Quickstart

```bash
npx -y @k1sh0r3/presql
```

That runs with a built-in demo e-commerce schema. To use your own:

```bash
npx -y @k1sh0r3/presql --schema ./schema.sql
# or
SQL_GUARD_SCHEMA=./schema.sql npx -y @k1sh0r3/presql
# or inline DDL:
SQL_GUARD_DDL="CREATE TABLE users (id INT, email VARCHAR(255));" npx -y @k1sh0r3/presql
```

Schema resolution order: `--schema` flag → `SQL_GUARD_SCHEMA` env → `SQL_GUARD_DDL` env → `demo/schema.sql` → built-in demo schema.

## Connect your agent

Claude Desktop (`claude_desktop_config.json`) or Cursor:

```json
{
  "mcpServers": {
    "presql": {
      "command": "npx",
      "args": ["-y", "@k1sh0r3/presql", "--schema", "/path/to/schema.sql"]
    }
  }
}
```

Then: *"Before running any SQL against the database, check it with presql's guard_query."*

## What it catches

Schema-aware validation powered by the [SQL Sentinel](https://k1sh0r3.github.io/SQLSentinel/) engine (13 check codes):

- `DESTRUCTIVE_NO_WHERE` — `DELETE`/`UPDATE` without `WHERE` → **blocked**
- `DESTRUCTIVE_UNBOUNDED` — `DROP`, `TRUNCATE` → **blocked**
- `UNKNOWN_TABLE` / `UNKNOWN_COLUMN` — with Levenshtein did-you-mean suggestions
- `TYPE_MISMATCH`, `AMBIGUOUS_COLUMN`, `IMPLICIT_CROSS_JOIN`, `CROSS_JOIN`
- `PII_ACCESS` — flags selects over PII-ish columns (name-heuristic)
- `SELECT_STAR`, `MISSING_LIMIT` — hygiene nudges
- `PARSE_ERROR`, `SCHEMA_MISSING`, `MULTI_STATEMENT` — honest meta-checks

Example:

```
> validate_sql("DELETE FROM orders;")
{
  "verdict": "blocked",
  "issues": [{
    "code": "DESTRUCTIVE_NO_WHERE",
    "severity": "error",
    "message": "DELETE without WHERE affects every row in the table.",
    "suggestion": "Add a WHERE clause — or run a SELECT with the same filter first to preview the blast radius."
  }],
  "explanation": "Deletes EVERY row from orders."
}
```

## Honest limits

- **Static analysis only.** It can't know row counts or see your data.
- **CTE/subquery output columns** are skipped, not faked — where certainty is impossible, it says so.
- **PII detection is name-heuristic only** (column named `email` ≈ PII). Not a compliance tool on its own.
- **One statement per call.** Multi-statement input validates the first statement and warns (`MULTI_STATEMENT`).
- **AST-evasion hardening** (quoted/unicode-escaped identifier tricks, cf. AWS's pglast guard) is a v1.1 target — not claimed as solved.
- English error messages; `postgres` / `mysql` / `sqlite` parse dialects.

## Development

```bash
npm install
npm run build   # tsc → dist/
npm test        # build + node --test (41 tests: 30 engine + 11 MCP protocol)
npm start       # run the server over stdio
```

The validator (`src/vendor/validator.js`) and SQL parser (`src/vendor/node-sql-parser.umd.js`) are copied verbatim from SQL Sentinel — the engine is shared, not forked.

## License

MIT — see [LICENSE](LICENSE).
