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
                    port: 1433,
                    options: {
                        trustServerCertificate: true
                    }
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
        trustServerCertificate: true,  // for development / self-signed certs
        encrypt: true                  // required for Azure SQL
    }
})
```

### Connection string

```ts
new MsSqlProvider('Server=localhost;Database=MyDb;User Id=sa;Password=...;Encrypt=true')
```

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
- Scaffold (introspect tables and columns via `INFORMATION_SCHEMA`)
- Parameterised queries (SQL injection safe)

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
