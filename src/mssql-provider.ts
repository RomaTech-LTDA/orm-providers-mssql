/**
 * @module mssql-provider
 *
 * Microsoft SQL Server implementation of {@link IDbProvider}.
 *
 * Uses the [`mssql`](https://www.npmjs.com/package/mssql) package (ConnectionPool)
 * to manage connections and execute queries.
 *
 * SQL Dialect:
 * - Identifiers quoted with square brackets: `[columnName]`
 * - Positional parameters: `@param0`, `@param1`, ...
 * - Table existence checked via `OBJECT_ID()`
 */

import { ConnectionPool, MsSqlRequest, MsSqlTransaction } from 'mssql';
import {
  buildDeleteSql,
  buildFindSql,
  buildInsertSql,
  buildSelectAllSql,
  buildSelectSql,
  buildUpdateSql,
  ITransactionalProvider,
  QueryObject,
  SqlDialect,
  TableColumnInfo
} from '@romatech/orm';
import { applyQueryToDriverRows, DriverColumns, toDate, toNumber, ValueConverter } from './driver-rows';

/**
 * Configuration object for a Microsoft SQL Server connection.
 *
 * Can be either a connection string (ADO.NET / mssql format) or a structured
 * config object.  Using the object form is recommended for production because
 * it keeps credentials out of string interpolation.
 *
 * @example
 * // Connection string form
 * const config: MsSqlConfig = 'Server=localhost,1433;Database=mydb;User Id=sa;Password=secret;';
 *
 * @example
 * // Object form
 * const config: MsSqlConfig = {
 *   user: 'sa',
 *   password: 'secret',
 *   server: 'localhost',
 *   database: 'mydb',
 *   port: 1433,
 *   options: { encrypt: true }
 * };
 */
/**
 * Connection configuration for SQL Server.
 * Either a connection string or a structured config object.
 */
export type MsSqlConfig = string | {
  /** SQL Server login name. */
  user: string;
  /** SQL Server login password. */
  password: string;
  /** Hostname or IP address of the SQL Server instance. */
  server: string;
  /** Target database name. */
  database: string;
  /** TCP port (default: 1433). */
  port?: number;
  /**
   * Extra driver-level options forwarded verbatim to the `mssql` connection
   * pool (e.g. `encrypt`, `trustServerCertificate`).
   */
  options?: MsSqlDriverOptions;
};

/** Driver options forwarded to `mssql`/`tedious` (any other key is passed through). */
export interface MsSqlDriverOptions {
  /** Encrypt the connection (driver default: `true`). */
  encrypt?: boolean;
  /**
   * Accept the server certificate without validating it. **Insecure** (it
   * allows man-in-the-middle attacks); only set it to `true` for local
   * development against a self-signed certificate. Defaults to `false`
   * since 3.0.0 (2.x silently defaulted to `true`).
   */
  trustServerCertificate?: boolean;
  [option: string]: unknown;
}

/** Exactly `BEGIN`/`COMMIT`/`ROLLBACK` [`TRAN`|`TRANSACTION`] with an optional `;`. */
const TRANSACTION_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK)(?:\s+TRAN(?:SACTION)?)?\s*;?\s*$/i;

/** Raw statements that cannot change the schema (they keep the key cache). */
const READ_ONLY_STATEMENT = /^\s*(SELECT|WITH)\b/i;

/**
 * SQL dialect definition for Microsoft SQL Server.
 *
 * - **Identifier quoting**: wraps identifiers in square brackets (`[name]`)
 *   and escapes any embedded `]` characters by doubling them (`]]`), following
 *   the T-SQL quoting convention.
 * - **Parameter style**: uses named parameters in the form `@param0`,
 *   `@param1`, … which map to `mssql` request inputs registered via
 *   `request.input('param0', value)`.
 */
/** SQL Server dialect: square-bracket quoting and @paramN placeholders. */
const dialect: SqlDialect = {
  quoteIdentifier: identifier => `[${identifier.replace(/]/g, ']]')}]`,
  parameter: index => `@param${index}`
};

/**
 * RomaTech ORM database provider for **Microsoft SQL Server** (SQL Server 2017+
 * and Azure SQL).
 *
 * Internally wraps the `mssql` connection pool so multiple concurrent queries
 * share a single pool instance.  All DDL and DML operations are executed
 * through parameterized queries to prevent SQL injection.
 *
 * Implements {@link IDbProvider} — the common interface shared by all
 * RomaTech ORM providers.
 *
 * @example
 * import { MsSqlProvider } from '@romatech/orm-providers-mssql';
 * import { DbContext, entity, primaryKey } from '@romatech/orm';
 *
 * \@entity('users')
 * class User {
 *   \@primaryKey()
 *   id!: number;
 *   name!: string;
 * }
 *
 * const provider = new MsSqlProvider({
 *   user: 'sa',
 *   password: 'secret',
 *   server: 'localhost',
 *   database: 'mydb'
 * });
 *
 * const ctx = new DbContext(provider);
 * await ctx.connect();
 * const users = ctx.set(User);
 * await users.addAsync(new User());
 * await ctx.disconnect();
 */
/**
 * SQL Server provider for RomaTech ORM.
 *
 * Manages a `ConnectionPool` from the `mssql` package and translates all
 * ORM operations into T-SQL statements.
 *
 * @example
 * ```ts
 * const provider = new MsSqlProvider({
 *     server: 'localhost',
 *     database: 'MyDb',
 *     user: 'sa',
 *     password: 'password123',
 *     // Local development with a self-signed certificate only:
 *     options: { trustServerCertificate: true }
 * });
 * ```
 */
export class MsSqlProvider implements ITransactionalProvider {
  /** This provider implements {@link ITransactionalProvider}. */
  readonly supportsTransactions = true;

  /** The `mssql` connection pool used for all database operations. */
  private pool!: ConnectionPool;

  /**
   * The open transaction, if any. While it is set every statement of this
   * provider runs on the transaction's dedicated connection.
   */
  private transaction?: MsSqlTransaction;

  /** Set when SQL Server aborted the open transaction (e.g. XACT_ABORT). */
  private transactionAborted = false;

  /** Serializes statements on the transaction connection (one request at a time). */
  private transactionQueue: Promise<unknown> = Promise.resolve();

  /** Primary-key columns per table, so DML does not introspect on every call. */
  private readonly primaryKeyCache = new Map<string, Promise<string[]>>();

  /**
   * Creates a new `MsSqlProvider` instance.
   *
   * The actual TCP connection is not established here — call {@link connect}
   * before performing any database operations.
   *
   * @param config - Either an mssql connection string or a structured
   *   {@link MsSqlConfig} object.
   */
  constructor(private config: MsSqlConfig) {}

  /**
   * Opens the connection pool to SQL Server.
   *
   * When `connectionString` is provided it takes precedence over the config
   * supplied to the constructor.  This allows the ORM framework to inject a
   * runtime connection string (e.g., from environment variables) without
   * constructing a new provider.
   *
   * The server certificate is validated (`trustServerCertificate: false`)
   * unless `config.options.trustServerCertificate` is explicitly `true`
   * (or the connection string says `TrustServerCertificate=true`). Only do
   * that for local development with a self-signed certificate.
   *
   * @param connectionString - Optional override connection string.
   * @returns A promise that resolves when the pool is ready to accept queries.
   * @throws {Error} If the server is unreachable or credentials are invalid.
   *
   * @example
   * await provider.connect(); // uses constructor config
   * await provider.connect('Server=prod-sql;Database=app;...'); // override
   */
  async connect(connectionString = ''): Promise<void> {
    const config = connectionString || (typeof this.config === 'string'
      ? this.config
      : {
          ...this.config,
          options: {
            // Secure default: validate the server certificate. Opt out explicitly
            // with options.trustServerCertificate = true (local dev only).
            trustServerCertificate: false,
            ...(this.config.options || {})
          }
        });
    this.pool = await new ConnectionPool(config as any).connect();
  }

  /**
   * Closes the connection pool and releases all underlying TCP sockets.
   *
   * Call this method when the application shuts down or when the context is
   * no longer needed to avoid connection leaks.
   *
   * @returns A promise that resolves once all connections are closed.
   *
   * @example
   * await provider.disconnect();
   */
  async disconnect(): Promise<void> {
    if (this.transaction) {
      // Never leave an open transaction holding locks on a pooled connection.
      await this.rollbackTransaction().catch(() => undefined);
    }
    if (this.pool) {
      await this.pool.close();
    }
  }

  /**
   * Starts a transaction on a dedicated pooled connection. Until
   * {@link commitTransaction} or {@link rollbackTransaction}, every operation
   * of this provider (CRUD, queries, DDL) runs on that connection, one
   * statement at a time.
   *
   * The transaction is scoped to the provider instance: use one provider
   * (one `DbContext`) per unit of work when requests run concurrently.
   *
   * @throws {Error} If a transaction is already active (no nesting).
   */
  async beginTransaction(): Promise<void> {
    if (this.transaction) {
      throw new Error('A transaction is already active on this provider; nested transactions are not supported.');
    }
    if (!this.pool) {
      throw new Error('The provider is not connected; call connect() first.');
    }
    const transaction = this.pool.transaction();
    transaction.on('rollback', aborted => {
      if (aborted && this.transaction === transaction) {
        this.transactionAborted = true;
      }
    });
    await transaction.begin();
    this.transaction = transaction;
    this.transactionAborted = false;
    this.transactionQueue = Promise.resolve();
  }

  /**
   * Commits the active transaction and returns its connection to the pool.
   *
   * @throws {Error} If no transaction is active, or SQL Server already
   *   aborted it (nothing was committed; the provider is reset either way).
   */
  async commitTransaction(): Promise<void> {
    const transaction = this.transaction;
    if (!transaction) {
      throw new Error('No active transaction to commit.');
    }
    try {
      await this.transactionQueue;
      if (this.transactionAborted) {
        throw new Error('The transaction was aborted by SQL Server and has been rolled back; nothing was committed.');
      }
      await transaction.commit();
    } finally {
      this.endTransaction();
    }
  }

  /**
   * Rolls back the active transaction and returns its connection to the
   * pool. A no-op when no transaction is active (e.g. after a failed commit),
   * so it is always safe to call from a `catch` block.
   */
  async rollbackTransaction(): Promise<void> {
    const transaction = this.transaction;
    if (!transaction) {
      return;
    }
    try {
      await this.transactionQueue;
      if (!this.transactionAborted) {
        await transaction.rollback();
      }
    } catch (error: any) {
      // EABORT: SQL Server already rolled the transaction back.
      if (error?.code !== 'EABORT') {
        throw error;
      }
    } finally {
      this.endTransaction();
    }
  }

  /**
   * Forgets the cached primary-key metadata (of one table, or of all).
   * The provider already does this after its own DDL and after raw
   * non-SELECT statements; call it when the schema is changed by another
   * process while this provider is connected.
   */
  clearMetadataCache(tableName?: string): void {
    if (tableName === undefined) {
      this.primaryKeyCache.clear();
    } else {
      this.primaryKeyCache.delete(tableName);
    }
  }

  /**
   * Inserts a single entity into the specified table.
   *
   * Delegates to {@link buildInsertSql} to generate a parameterized
   * `INSERT INTO [tableName] ([col1], [col2], …) VALUES (@param0, @param1, …)`
   * statement.  Properties with `undefined` values are excluded so that
   * database defaults (e.g. `NEWID()`, `GETDATE()`) are respected.
   *
   * @param entity - Plain object whose own enumerable properties map to
   *   table columns.
   * @param tableName - Target table name (will be bracket-quoted).
   * @returns A promise that resolves when the row has been inserted.
   * @throws {Error} On constraint violations (duplicate key, NOT NULL, etc.).
   *
   * @example
   * await provider.add({ id: 1, name: 'Alice' }, 'users');
   */
  async add<T extends object>(entity: T, tableName: string): Promise<void> {
    const command = buildInsertSql(tableName, entity, dialect);
    await this.send(command.sql, command.params);
  }

  /**
   * Inserts multiple entities into the specified table sequentially.
   *
   * Each entity is inserted with a separate `add` call.  For bulk loads,
   * consider using `executeNonQuery` with a bulk-insert approach instead.
   *
   * @param entities - Array of entities to insert.
   * @param tableName - Target table name.
   * @returns A promise that resolves when all rows have been inserted.
   * @throws {Error} If any individual insert fails; previously inserted rows
   *   in the same call are not rolled back automatically.
   *
   * @example
   * await provider.addRange(
   *   [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
   *   'users'
   * );
   */
  async addRange<T extends object>(entities: T[], tableName: string): Promise<void> {
    for (const entity of entities) {
      await this.add(entity, tableName);
    }
  }

  /**
   * Updates an existing row identified by its primary key.
   *
   * Queries the table's column metadata to determine the primary key column,
   * then generates `UPDATE [tableName] SET [col1] = @param0, … WHERE [pk] = @paramN`.
   * If the entity contains only the primary key field (no other columns to
   * update), the operation is skipped.
   *
   * @param entity - Object whose primary-key property identifies the row and
   *   whose remaining properties supply the new values.
   * @param tableName - Target table name.
   * @returns A promise that resolves when the row has been updated.
   * @throws {Error} If no matching row exists or a constraint is violated.
   *
   * @example
   * await provider.update({ id: 1, name: 'Alicia' }, 'users');
   */
  async update<T extends object>(entity: T, tableName: string): Promise<void> {
    const primaryKey = await this.getPrimaryKeyColumn(tableName);
    // Guard: skip the round-trip if there are no columns to update besides the PK
    // (undefined values are not written, so they do not count).
    if (!Object.entries(entity).some(([key, value]) => key !== primaryKey && value !== undefined)) {
      return;
    }
    const command = buildUpdateSql(tableName, entity, primaryKey, dialect);
    await this.send(command.sql, command.params);
  }

  /**
   * Deletes a single row identified by the entity's primary key.
   *
   * Generates `DELETE FROM [tableName] WHERE [pk] = @param0`.
   *
   * @param entity - Object whose primary-key property identifies the row.
   * @param tableName - Target table name.
   * @returns A promise that resolves when the row has been deleted.
   * @throws {Error} On constraint violations (e.g. foreign-key references).
   *
   * @example
   * await provider.remove({ id: 1 }, 'users');
   */
  async remove<T extends object>(entity: T, tableName: string): Promise<void> {
    const command = buildDeleteSql(tableName, entity, await this.getPrimaryKeyColumn(tableName), dialect);
    await this.send(command.sql, command.params);
  }

  /**
   * Deletes multiple rows identified by each entity's primary key.
   *
   * @param entities - Array of entities to delete.
   * @param tableName - Target table name.
   * @returns A promise that resolves when all rows have been deleted.
   * @throws {Error} If any individual delete fails.
   *
   * @example
   * await provider.removeRange([{ id: 1 }, { id: 2 }], 'users');
   */
  async removeRange<T extends object>(entities: T[], tableName: string): Promise<void> {
    for (const entity of entities) {
      await this.remove(entity, tableName);
    }
  }

  /**
   * Retrieves a single row by its primary key.
   *
   * Generates `SELECT * FROM [tableName] WHERE [pk] = @param0` and returns the
   * first result, or `undefined` when no matching row is found.
   *
   * @param entity - Object whose primary-key property is used as the lookup
   *   value.
   * @param tableName - Target table name.
   * @returns The matching row cast to `T`, or `undefined` if not found.
   * @throws {Error} On connection or query errors.
   *
   * @example
   * const user = await provider.find({ id: 42 }, 'users');
   * if (user) console.log(user.name);
   */
  async find<T extends object>(entity: T, tableName: string): Promise<T | undefined> {
    const command = buildFindSql(tableName, entity, await this.getPrimaryKeyColumn(tableName), dialect);
    const rows = await this.send<T>(command.sql, command.params);
    return rows[0];
  }

  /**
   * Returns all rows from the specified table.
   *
   * Generates `SELECT * FROM [tableName]`.  For large tables, prefer
   * {@link executeQuery} with a filtered {@link QueryObject}.
   *
   * @param tableName - Source table name.
   * @returns An array of all rows cast to `T`.
   * @throws {Error} On connection or query errors.
   *
   * @example
   * const users = await provider.getAll<User>('users');
   */
  async getAll<T>(tableName: string): Promise<T[]> {
    return this.send<T>(buildSelectAllSql(tableName, dialect));
  }

  /**
   * No-op for this provider.
   *
   * SQL Server operations are auto-committed per statement.  Unit-of-work
   * transaction semantics can be added in future provider versions.
   *
   * @returns A resolved promise.
   */
  async saveChanges(): Promise<void> {
    return;
  }

  /**
   * Records a migration entry in the `[__roma_migrations]` history table.
   *
   * Creates the migration history table if it does not yet exist, then inserts
   * a row with the migration name and its SQL script.
   *
   * @param migrationName - Unique identifier for the migration (e.g.
   *   `"20240101_AddUsersTable"`).
   * @param migrationScript - The full DDL/DML script that this migration
   *   applies.
   * @returns A promise that resolves once the record has been persisted.
   * @throws {Error} On duplicate migration name (PRIMARY KEY violation).
   *
   * @example
   * await provider.addMigration('20240101_Init', 'CREATE TABLE users (...)');
   */
  async addMigration(migrationName: string, migrationScript: string): Promise<void> {
    await this.ensureMigrationHistoryTable();
    await this.send(
      'INSERT INTO [__roma_migrations] ([migrationName], [migrationScript]) VALUES (@param0, @param1)',
      [migrationName, migrationScript]
    );
  }

  /**
   * Removes a migration entry from the `[__roma_migrations]` history table.
   *
   * Used during a downgrade operation to erase the record of an applied
   * migration.
   *
   * @param migrationName - The name of the migration to remove.
   * @returns A promise that resolves once the record has been deleted.
   *
   * @example
   * await provider.removeMigration('20240101_Init');
   */
  async removeMigration(migrationName: string): Promise<void> {
    await this.ensureMigrationHistoryTable();
    await this.send('DELETE FROM [__roma_migrations] WHERE [migrationName] = @param0', [migrationName]);
  }

  /**
   * No-op for this provider.
   *
   * Migration scripts are applied individually via the CLI's `update-database`
   * command rather than as a batch here.
   *
   * @returns A resolved promise.
   */
  async applyMigrations(): Promise<void> {
    return;
  }

  /**
   * Returns the list of migration names recorded in the history table.
   *
   * Delegates to {@link getMigrationHistory}.
   *
   * @returns An array of migration name strings in ascending alphabetical order.
   *
   * @example
   * const applied = await provider.getMigrations();
   * console.log(applied); // ['20240101_Init', '20240201_AddIndex']
   */
  async getMigrations(): Promise<string[]> {
    return this.getMigrationHistory();
  }

  /**
   * Queries the `[__roma_migrations]` table for all previously applied
   * migration names.
   *
   * Creates the history table first if it does not exist, making this method
   * safe to call on a fresh database.
   *
   * @returns An array of migration name strings ordered alphabetically.
   * @throws {Error} On connection or query errors.
   *
   * @example
   * const history = await provider.getMigrationHistory();
   */
  async getMigrationHistory(): Promise<string[]> {
    await this.ensureMigrationHistoryTable();
    const rows = await this.send<{ migrationName: string }>(
      'SELECT [migrationName] FROM [__roma_migrations] ORDER BY [migrationName]'
    );
    return rows.map(row => row.migrationName);
  }

  /**
   * No-op for this provider — handled by the CLI.
   * @returns A resolved promise.
   */
  async updateDatabase(_targetMigration?: string): Promise<void> {
    return;
  }

  /**
   * No-op for this provider — handled by the CLI.
   * @returns A resolved promise.
   */
  async downgradeDatabase(_targetMigration?: string): Promise<void> {
    return;
  }

  /**
   * Creates a table in SQL Server if it does not already exist.
   *
   * Uses T-SQL's `IF OBJECT_ID(N'...', N'U') IS NULL CREATE TABLE …` pattern
   * instead of `CREATE TABLE IF NOT EXISTS` (which is not valid T-SQL) to
   * make the operation idempotent.
   *
   * @param input.tableName - Name of the table to create.
   * @param input.columns - Column definitions.  Each column's `tsType` is
   *   mapped to a SQL Server type via {@link mapColumnType}.
   * @param input.primaryKey - Optional explicit primary-key column name.
   *   Falls back to the first column with `primaryKey: true` in the array.
   * @returns A promise that resolves once the table exists.
   * @throws {Error} On SQL Server errors unrelated to the table already
   *   existing.
   *
   * @example
   * await provider.createTable({
   *   tableName: 'users',
   *   columns: [
   *     { name: 'id', tsType: 'number', primaryKey: true },
   *     { name: 'name', tsType: 'string' }
   *   ]
   * });
   */
  async createTable(input: { tableName: string; columns: TableColumnInfo[]; primaryKey?: string }): Promise<void> {
    const primaryKey = input.primaryKey || input.columns.find(column => column.primaryKey)?.name;
    const columns = input.columns
      .map(column => `${dialect.quoteIdentifier(column.name)} ${this.mapColumnType(column)}${column.primaryKey ? ' NOT NULL' : ''}`)
      .join(', ');
    const primaryKeySql = primaryKey ? `, PRIMARY KEY (${dialect.quoteIdentifier(primaryKey)})` : '';
    // T-SQL does not support CREATE TABLE IF NOT EXISTS — use OBJECT_ID guard instead.
    // The bracket-quoted name is passed as a parameter so OBJECT_ID resolves
    // exactly the table CREATE TABLE targets (e.g. a name containing a dot).
    await this.send(`
      IF OBJECT_ID(@param0, N'U') IS NULL
      CREATE TABLE ${dialect.quoteIdentifier(input.tableName)} (${columns}${primaryKeySql})
    `, [dialect.quoteIdentifier(input.tableName)]);
    this.clearMetadataCache(input.tableName);
  }

  /**
   * Drops a table from the database if it exists.
   *
   * Uses `IF OBJECT_ID(N'...', N'U') IS NOT NULL DROP TABLE …` to make the
   * operation idempotent.
   *
   * @param tableName - Name of the table to drop.
   * @returns A promise that resolves once the table is gone (or was never there).
   * @throws {Error} On SQL Server errors unrelated to the table not existing.
   *
   * @example
   * await provider.dropTable('users');
   */
  async dropTable(tableName: string): Promise<void> {
    // The bracket-quoted name is passed as a parameter (see createTable).
    await this.send(`
      IF OBJECT_ID(@param0, N'U') IS NOT NULL
      DROP TABLE ${dialect.quoteIdentifier(tableName)}
    `, [dialect.quoteIdentifier(tableName)]);
    this.clearMetadataCache(tableName);
  }

  /**
   * Adds a new column to an existing table.
   *
   * Generates `ALTER TABLE [tableName] ADD [columnName] <SQL type>`.
   *
   * @param tableName - Name of the table to alter.
   * @param column - Column definition including name and TypeScript type.
   * @returns A promise that resolves once the column has been added.
   * @throws {Error} If the column already exists or types are invalid.
   *
   * @example
   * await provider.addColumn('users', { name: 'email', tsType: 'string' });
   */
  async addColumn(tableName: string, column: TableColumnInfo): Promise<void> {
    await this.send(
      `ALTER TABLE ${dialect.quoteIdentifier(tableName)} ADD ${dialect.quoteIdentifier(column.name)} ${this.mapColumnType(column)}`
    );
    this.clearMetadataCache(tableName);
  }

  /**
   * Removes a column from an existing table.
   *
   * Generates `ALTER TABLE [tableName] DROP COLUMN [columnName]`.
   *
   * @param tableName - Name of the table to alter.
   * @param columnName - Name of the column to drop.
   * @returns A promise that resolves once the column has been removed.
   * @throws {Error} If the column is referenced by a constraint or index.
   *
   * @example
   * await provider.removeColumn('users', 'email');
   */
  async removeColumn(tableName: string, columnName: string): Promise<void> {
    await this.send(
      `ALTER TABLE ${dialect.quoteIdentifier(tableName)} DROP COLUMN ${dialect.quoteIdentifier(columnName)}`
    );
    this.clearMetadataCache(tableName);
  }

  /**
   * No-op for this provider — scaffold is handled by the CLI command.
   * @returns A resolved promise.
   */
  async scaffold(_connectionString: string): Promise<void> {
    return;
  }

  /**
   * Returns the names of all user tables in the current database.
   *
   * Queries `INFORMATION_SCHEMA.TABLES` filtering by `TABLE_TYPE = 'BASE TABLE'`
   * to exclude views and system tables.
   *
   * @returns An array of table name strings.
   * @throws {Error} On connection or query errors.
   *
   * @example
   * const tables = await provider.getTables();
   * console.log(tables); // ['users', 'orders', '__roma_migrations']
   */
  async getTables(): Promise<string[]> {
    const rows = await this.send<{ TABLE_NAME: string }>(`
      SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'
    `);
    return rows.map(row => row.TABLE_NAME);
  }

  /**
   * Returns column metadata for a given table, including primary-key detection.
   *
   * Resolves the table with `OBJECT_ID()` (the same name resolution as the
   * provider's unqualified DML: the user's default schema, then `dbo`) and
   * reads `sys.columns` plus the primary-key index columns, so a table with
   * the same name in another schema cannot leak its columns or key.
   *
   * @param table - Name of the table to inspect.
   * @returns An array of {@link TableColumnInfo} objects with name, tsType,
   *   and primaryKey flag.
   * @throws {Error} On connection or query errors.
   *
   * @example
   * const cols = await provider.getColumnsForTable('users');
   * // [{ name: 'id', tsType: 'number', primaryKey: true }, ...]
   */
  async getColumnsForTable(table: string): Promise<TableColumnInfo[]> {
    const rows = await this.send<{ name: string; type: string; primaryKey: number }>(
      `
        SELECT c.name AS name, TYPE_NAME(c.system_type_id) AS type,
          CASE WHEN EXISTS (
            SELECT 1
            FROM sys.indexes i
            JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
            WHERE i.is_primary_key = 1 AND i.object_id = c.object_id AND ic.column_id = c.column_id
          ) THEN 1 ELSE 0 END AS primaryKey
        FROM sys.columns c
        WHERE c.object_id = OBJECT_ID(@param0)
        ORDER BY c.column_id
      `,
      [dialect.quoteIdentifier(table)]
    );

    return rows.map(column => ({
      name: column.name,
      // SQL Server returns primaryKey as integer 1/0; normalize to boolean.
      primaryKey: column.primaryKey === 1,
      tsType: this.mapDbTypeToTsType(column.type)
    }));
  }

  /**
   * Executes a SQL query or a structured {@link QueryObject} and returns the
   * result rows.
   *
   * **Overload 1 — raw SQL:**
   * ```ts
   * const rows = await provider.executeQuery<User>('SELECT * FROM [users] WHERE [id] = @param0', [42]);
   * ```
   *
   * **Overload 2 — QueryObject:**
   * ```ts
   * const rows = await provider.executeQuery('users', query);
   * ```
   * When a `QueryObject` is supplied the provider first attempts to push
   * `WHERE` and `ORDER BY` clauses to the server (via {@link buildSelectSql}).
   * The JS predicates, ordering, paging and projection are then re-applied
   * on copies of the rows in which `bigint` values (returned as strings by
   * the driver) are converted to numbers, so `where(x => x.id === 5)` keeps
   * the row; the original rows are returned. A predicate SQL Server already
   * applied that compares a date/time column with a string literal is not
   * re-run (JS cannot compare a `Date` with a string).
   *
   * Raw `BEGIN`/`COMMIT`/`ROLLBACK` [`TRAN`|`TRANSACTION`] statements are
   * routed to {@link beginTransaction}/{@link commitTransaction}/
   * {@link rollbackTransaction} (a raw `BEGIN TRAN` on a pooled connection
   * would leave the following statements outside the transaction).
   *
   * @param query - Either a raw SQL string or a table name when using
   *   `QueryObject`.
   * @param params - Parameter array for raw SQL, or a `QueryObject` for the
   *   second overload.
   * @returns A promise resolving to an array of result rows.
   * @throws {Error} On SQL syntax errors or connection failures.
   */
  async executeQuery<T = any>(query: string, params?: any[]): Promise<T[]>;
  async executeQuery<T, TResult = T>(entityName: string, query: QueryObject<T, TResult>): Promise<TResult[]>;
  async executeQuery<T, TResult = T>(
    queryOrEntityName: string,
    paramsOrQuery: any[] | QueryObject<T, TResult> = []
  ): Promise<T[] | TResult[]> {
    if (!Array.isArray(paramsOrQuery)) {
      // QueryObject path: build server-side SQL, then apply any remaining
      // client-side predicates (e.g. JS closures that can't be serialized).
      const command = buildSelectSql(queryOrEntityName, paramsOrQuery, dialect);
      const rows = await this.send<T>(command.sql, command.params);
      return applyQueryToDriverRows(rows, paramsOrQuery, driverColumns(rows));
    }

    if (paramsOrQuery.length === 0 && await this.routeTransactionControl(queryOrEntityName)) {
      return [];
    }
    if (!READ_ONLY_STATEMENT.test(queryOrEntityName)) {
      // The statement may change the schema (keys included).
      this.clearMetadataCache();
    }
    return this.send<T>(queryOrEntityName, paramsOrQuery);
  }

  /**
   * Executes a non-query SQL statement (INSERT / UPDATE / DELETE / DDL).
   *
   * Parameters are bound as `@param0`, `@param1`, … matching the naming
   * convention used by {@link dialect}.
   *
   * @param sql - Parameterized SQL statement.
   * @param params - Positional parameter values.
   * @returns A promise that resolves when the statement completes.
   * @throws {Error} On SQL errors or connection failures.
   *
   * @example
   * await provider.executeNonQuery(
   *   'UPDATE [users] SET [name] = @param0 WHERE [id] = @param1',
   *   ['Alice', 1]
   * );
   */
  async executeNonQuery(sql: string, params: any[] = []): Promise<void> {
    if (params.length === 0 && await this.routeTransactionControl(sql)) {
      return;
    }
    // The statement may change the schema (keys included).
    this.clearMetadataCache();
    await this.send(sql, params);
  }

  /**
   * Sends one statement with `@paramN` inputs: on the transaction connection
   * when a transaction is active (serialized, since a connection runs one
   * request at a time), otherwise on any pooled connection.
   */
  private send<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    const transaction = this.transaction;
    if (!transaction) {
      return runRequest<T>(this.pool.request(), sql, params);
    }
    const next = this.transactionQueue.then(() => {
      if (this.transactionAborted) {
        throw new Error('The transaction was aborted by SQL Server; roll it back before sending more statements.');
      }
      return runRequest<T>(transaction.request(), sql, params);
    });
    this.transactionQueue = next.catch(() => undefined);
    return next;
  }

  /**
   * Handles a raw transaction-control statement. Returns `false` when `sql`
   * is not one, so the caller sends it as usual.
   */
  private async routeTransactionControl(sql: string): Promise<boolean> {
    const match = TRANSACTION_CONTROL.exec(sql);
    if (!match) {
      return false;
    }
    const verb = match[1].toUpperCase();
    if (verb === 'BEGIN') {
      await this.beginTransaction();
    } else if (verb === 'COMMIT') {
      await this.commitTransaction();
    } else {
      await this.rollbackTransaction();
    }
    return true;
  }

  /** Resets the transaction state; the next statement uses the pool again. */
  private endTransaction(): void {
    this.transaction = undefined;
    this.transactionAborted = false;
    this.transactionQueue = Promise.resolve();
    // DDL is transactional in SQL Server: a rollback can undo key changes.
    this.clearMetadataCache();
  }

  /**
   * Creates the `[__roma_migrations]` history table if it does not exist.
   *
   * Uses a T-SQL `IF OBJECT_ID … IS NULL` guard for idempotency.  The table
   * schema matches the other providers: `migrationName` (PK), `migrationScript`,
   * and an `appliedAt` timestamp defaulting to `SYSUTCDATETIME()`.
   */
  private async ensureMigrationHistoryTable(): Promise<void> {
    await this.send(`
      IF OBJECT_ID(N'__roma_migrations', N'U') IS NULL
      CREATE TABLE [__roma_migrations] (
        [migrationName] NVARCHAR(255) NOT NULL PRIMARY KEY,
        [migrationScript] NVARCHAR(MAX) NOT NULL,
        [appliedAt] DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
      )
    `);
  }

  /**
   * Resolves the primary-key column name for a given table.
   *
   * Falls back to `'id'` when no primary key is found (e.g. a heap table).
   * Composite keys are rejected: matching rows by only one of their key
   * columns would update or delete every row sharing that value.
   *
   * The key columns are cached per table (see {@link clearMetadataCache}),
   * so `update`/`remove`/`find` cost one round trip instead of two.
   *
   * @param tableName - Table to inspect.
   * @returns The primary-key column name or `'id'`.
   * @throws {Error} If the table has a composite primary key.
   */
  private async getPrimaryKeyColumn(tableName: string): Promise<string> {
    let cached = this.primaryKeyCache.get(tableName);
    if (!cached) {
      const lookup = this.getColumnsForTable(tableName)
        .then(columns => columns.filter(column => column.primaryKey).map(column => column.name));
      cached = lookup;
      this.primaryKeyCache.set(tableName, lookup);
      // A failed lookup is not cached.
      lookup.catch(() => {
        if (this.primaryKeyCache.get(tableName) === lookup) {
          this.primaryKeyCache.delete(tableName);
        }
      });
    }
    const keys = await cached;
    if (keys.length > 1) {
      throw new Error(`Table '${tableName}' has a composite primary key (${keys.join(', ')}); update/remove/find by entity support a single-column key only.`);
    }
    return keys[0] || 'id';
  }

  /**
   * Maps a {@link TableColumnInfo} TypeScript type to a SQL Server column type.
   *
   * | tsType      | Primary key | SQL type        |
   * |-------------|-------------|-----------------|
   * | `number`    | yes         | `INT`           |
   * | `number`    | no          | `FLOAT`         |
   * | `boolean`   | —           | `BIT`           |
   * | `Date`      | —           | `DATETIME2`     |
   * | *(anything else)* | —     | `NVARCHAR(MAX)` |
   *
   * @param column - Column definition including `tsType` and `primaryKey` flag.
   * @returns The SQL Server column type string.
   */
  private mapColumnType(column: TableColumnInfo): string {
    const type = column.tsType.toLowerCase();
    // Numeric primary keys are stored as INT; non-PK numerics as FLOAT.
    if (type.includes('number')) return column.primaryKey ? 'INT' : 'FLOAT';
    if (type.includes('boolean')) return 'BIT';
    if (type.includes('date')) return 'DATETIME2';
    // Default: unicode variable-length text.
    return 'NVARCHAR(MAX)';
  }

  /**
   * Maps a SQL Server data type name to the corresponding TypeScript type
   * string used in scaffolded entity classes.
   *
   * | SQL Server type pattern           | TypeScript type |
   * |-----------------------------------|-----------------|
   * | `int`, `decimal`, `numeric`, `float`, `real`, `money` | `number` |
   * | `bit`                             | `boolean`       |
   * | `date`, `time` (any variant)      | `Date`          |
   * | *(anything else)*                 | `string`        |
   *
   * @param type - Raw `DATA_TYPE` string returned by `INFORMATION_SCHEMA`.
   * @returns A TypeScript type name string.
   */
  private mapDbTypeToTsType(type: string): string {
    const normalized = type.toLowerCase();
    if (/(int|decimal|numeric|float|real|money)/.test(normalized)) return 'number';
    if (/(bit)/.test(normalized)) return 'boolean';
    if (/(date|time)/.test(normalized)) return 'Date';
    return 'string';
  }
}

/** Binds `params` as `@param0`, `@param1`, … and runs `sql` on `request`. */
async function runRequest<T>(request: MsSqlRequest, sql: string, params: any[]): Promise<T[]> {
  params.forEach((param, index) => request.input(`param${index}`, param));
  const result = await request.query(sql);
  return (result.recordset || []) as T[];
}

/** Column metadata of an `mssql` recordset (`recordset.columns`). */
type MsSqlColumns = Record<string, { type?: { declaration?: string } }>;

/** SQL Server date/time types (as reported in the recordset metadata). */
const MSSQL_TEMPORAL = new Set(['date', 'datetime', 'datetime2', 'smalldatetime', 'datetimeoffset']);

/**
 * Converters for the columns of an `mssql` recordset: `bigint` (a string in
 * the driver, '5') to numbers; date/time columns are temporal.
 */
function driverColumns(rows: unknown): DriverColumns {
  const columns = (rows as { columns?: MsSqlColumns }).columns || {};
  const converters: Record<string, ValueConverter> = {};
  const temporal = new Set<string>();
  for (const name of Object.keys(columns)) {
    const declaration = columns[name]?.type?.declaration;
    if (declaration === 'bigint') {
      converters[name] = toNumber;
    } else if (declaration && MSSQL_TEMPORAL.has(declaration)) {
      converters[name] = toDate;
      temporal.add(name);
    }
  }
  return { converters, temporal };
}
