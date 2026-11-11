# @romatech/orm-providers-mssql

[![npm](https://img.shields.io/npm/v/@romatech%2Form-providers-mssql)](https://www.npmjs.com/package/@romatech/orm-providers-mssql)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/RomaTech-LTDA/orm-providers-mssql/blob/main/LICENSE)

<p align="center">
  <img src="logo.png" width="120" alt="RomaTech ORM – SQL Server Provider" />
</p>

Microsoft SQL Server provider for [@romatech/orm](https://www.npmjs.com/package/@romatech/orm).

---

## Installation

```bash
npm install @romatech/orm @romatech/orm-providers-mssql reflect-metadata
```

---

## Quick Start

```ts
import 'reflect-metadata';
import { DbContext, DbContextOptions } from '@romatech/orm';
import { MsSqlProvider } from '@romatech/orm-providers-mssql';

class AppDbContext extends DbContext {
    users = this.set(User);

    constructor() {
        super(
            new DbContextOptions().useProvider(
                new MsSqlProvider({
                    user: 'sa',
                    password: 'yourPassword',
                    server: 'localhost',
                    database: 'MyDb',
                    port: 1433
                })
            )
        );
    }
}
```

---

## Configuration Options

### Object-style (recommended)

```ts
new MsSqlProvider({
    user: 'sa',
    password: 'yourPassword',
    server: 'localhost',
    database: 'MyDb',
    port: 1433,              // optional, defaults to 1433
    options: {
        encrypt: true        // driver default; required for Azure SQL
    }
})
```

### TLS certificate validation (breaking change in 3.0.0)

Since 3.0.0 the server certificate **is validated** by default
(`trustServerCertificate: false`). Version 2.x silently set
`trustServerCertificate: true`, which accepts any certificate and exposes the
connection (credentials included) to man-in-the-middle attacks.

If your server uses a certificate your machine does not trust (typically a
local SQL Server or a container with its self-signed certificate), the
connection now fails with a certificate error. Fix it by installing a trusted
certificate on the server or the server's CA on the client. For **local
development only** you can opt out explicitly:

```ts
new MsSqlProvider({
    user: 'sa',
    password: process.env.DB_PASSWORD,
    server: 'localhost',
    database: 'MyDb',
    options: { trustServerCertificate: true } // local development only — insecure
})
// or, in a connection string: ...;TrustServerCertificate=true
```

### Connection string

```ts
new MsSqlProvider('Server=localhost;Database=MyDb;User Id=sa;Password=...;Encrypt=true')
```

A connection string is passed to the driver as is: the certificate is
validated unless it contains `TrustServerCertificate=true`.

---

## Transactions

`MsSqlProvider` implements `ITransactionalProvider` (since 3.0.0):

```ts
const tx = await db.beginTransaction();
try {
    db.users.add(user);
    await db.saveChanges();
    await tx.commit();
} catch (err) {
    await tx.rollback();
    throw err;
}
```

- The transaction runs on one dedicated pooled connection; every statement of
  the provider (CRUD, queries, DDL) goes to that connection, one at a time,
  until `commit()`/`rollback()`.
- The transaction belongs to the provider instance: use one `DbContext` (one
  provider) per unit of work when requests run concurrently.
- Nested transactions are rejected. `rollback()` is a no-op when the
  transaction has already ended.
- If SQL Server aborts the transaction (for example with `XACT_ABORT ON`),
  `commit()` throws and nothing is committed.
- `disconnect()` rolls back an open transaction.

In 2.x, `beginTransaction()` sent a raw `BEGIN`, which is not valid T-SQL and
would not have pinned a pooled connection: transactions did not work.

---

## SQL Dialect

| Feature | Syntax |
|---------|--------|
| Identifier quoting | `[columnName]` |
| Parameters | `@param0`, `@param1`, ... |
| IF NOT EXISTS | `IF OBJECT_ID(N'...', N'U') IS NULL` |

---

## Supported Features

- Full CRUD (add, addRange, update, remove, removeRange, find, getAll)
- Server-side WHERE clause generation from predicates
- Server-side ORDER BY generation
- Migration history table (`__roma_migrations`)
- Schema management (createTable, dropTable, addColumn, removeColumn)
- Scaffold (introspect tables via `INFORMATION_SCHEMA` and columns via `sys.columns`)
- Parameterised queries (SQL injection safe)
- Transactions (`ITransactionalProvider`, see above)

### Notes

- `update`, `remove` and `find` locate the row by the table's single-column
  primary key (or `id` when the table has none). Tables with a **composite**
  primary key are rejected with an error, instead of matching every row that
  shares the first key column.
- The primary key of each table is introspected once and cached. The cache is
  cleared after the provider's own DDL and after raw statements that are not
  `SELECT`/`WITH`; call `provider.clearMetadataCache()` if another process
  changes the schema while the provider is connected.
- Query predicates are evaluated by SQL Server and then re-checked in
  JavaScript. `bigint` columns (strings in the driver) are compared as numbers,
  and a comparison of a date column with a string literal
  (`x => x.createdAt >= '2024-01-01'`) is left to SQL Server.

---

## Type Mappings

| TypeScript Type | SQL Server Type |
|-----------------|-----------------|
| `number` (PK) | `INT` |
| `number` | `FLOAT` |
| `boolean` | `BIT` |
| `Date` | `DATETIME2` |
| `string` | `NVARCHAR(MAX)` |

---

## Requirements

- Node.js >= 18
- SQL Server 2016 or later (or Azure SQL Database)
- The [`mssql`](https://www.npmjs.com/package/mssql) npm package (installed automatically)

---

## License

MIT © RomaTech / Leandro Romanelli
