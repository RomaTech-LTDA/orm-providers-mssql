# Changelog

All notable changes to @romatech/orm-providers-mssql will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [3.0.0] - 2026-11-11

### Breaking
- **The SQL Server certificate is validated by default** (`trustServerCertificate: false`). 2.x silently set `trustServerCertificate: true` for object configs, which disables certificate validation (man-in-the-middle, CWE-295). Servers with an untrusted (for example self-signed) certificate now fail to connect; install a trusted certificate, or for local development only set `options: { trustServerCertificate: true }` (or `TrustServerCertificate=true` in a connection string). See the README.
- `update`/`remove`/`find` throw for tables with a composite primary key instead of matching rows by the first key column only (removing one order line deleted every line of the order).

### Security
- TLS certificate validation on by default (see Breaking).
- `createTable`/`dropTable` no longer build the `OBJECT_ID(N'...')` string literal from the table name; the bracket-quoted name is bound as a parameter.

### Added
- Transactions: `MsSqlProvider` implements `ITransactionalProvider` (`supportsTransactions`, `beginTransaction`, `commitTransaction`, `rollbackTransaction`). The transaction runs on one dedicated pooled connection; every statement of the provider goes to it, serialized, until commit/rollback. Raw `BEGIN`/`COMMIT`/`ROLLBACK` [`TRAN`|`TRANSACTION`] (sent by `Transaction` in `@romatech/orm` 2.0.0) are routed to these methods. A transaction aborted by SQL Server cannot be committed (the commit throws); `disconnect()` rolls back an open transaction. In 2.x `DbContext.beginTransaction()` sent a raw `BEGIN`, which is not T-SQL, so transactions never worked.
- `clearMetadataCache(tableName?)` and the exported `MsSqlConfig`/`MsSqlDriverOptions` types.

### Fixed
- Query predicates re-checked in JavaScript see `bigint` columns (strings in the driver) as numbers: `where(x => x.id === 5)` on a `bigint` key returned nothing. A predicate SQL Server already applied that compares a date column with a string literal is no longer re-checked (`Date >= '2024-01-01'` is always false in JS and dropped every row). Predicates written against the driver's own values in 2.0.0 style (for example `x.active === 1` or `x.id === '5'`) keep matching the rows the database returned: when the database already applied the predicate, a row is kept if it holds on either the converted or the original value.
- `getColumnsForTable` resolves the table with `OBJECT_ID()` and reads `sys.columns`; a same-named table in another schema leaked its columns and primary key.
- `createTable`/`dropTable` resolve names containing a dot as one table; they were resolved as `schema.table`, so a second `createTable` failed.
- `update` with only `undefined` values besides the key is a no-op instead of sending invalid SQL (`SET  WHERE`).

### Changed
- The primary key of each table is introspected once and cached (`update`/`remove`/`find` cost one round trip instead of two). The cache is cleared after the provider's DDL, after raw statements other than `SELECT`/`WITH`, after a transaction ends, and by `clearMetadataCache()`.
- CI: `npm ci` (the lockfile had drifted to `@romatech/orm@1.2.0`; re-synced), Node 22 and 24, read-only `permissions`. The publish workflow uses `npm ci` and no longer rewrites the `@romatech/orm` range with `sed` before publishing (it published a package tested against a different core than the lockfile); the GitHub release runs in a separate job with `contents: write`.
- `npm test` (Node test runner): unit tests, plus integration tests against a real SQL Server when `MSSQL_TEST_URL` is set.
- Standardized `index.html` landing page (GitHub Pages).

## [2.0.0]

Published to npm without a changelog entry (see the git history). The versions on npm are 1.0.0, 1.3.0 and 2.0.0; the 1.2.0 entry below was never published under that number.

## [1.2.0] - 2026-06-18

### Added
- Initial release
