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

import { ConnectionPool } from 'mssql';
import {
  applyClientSideQuery,
  buildDeleteSql,
  buildFindSql,
  buildInsertSql,
  buildSelectAllSql,
  buildSelectSql,
  buildUpdateSql,
  IDbProvider,
  QueryObject,
  SqlDialect,
  TableColumnInfo
} from '@romatech/orm';

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
type MsSqlConfig = string | {
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
  options?: Record<string, unknown>;
};

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
 *     options: { trustServerCertificate: true }
 * });
 * ```
 */
export class MsSqlProvider implements IDbProvider {
  /** The `mssql` connection pool used for all database operations. */
  private pool!: ConnectionPool;

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
   * `trustServerCertificate` is set to `true` by default so that local
   * development environments with self-signed certificates work out of the box.
   * Override via `config.options.trustServerCertificate = false` for production.
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
            // Default: trust self-signed certs so local dev works without TLS setup.
            trustServerCertificate: true,
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
    if (this.pool) {
      await this.pool.close();
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
    await this.executeNonQuery(command.sql, command.params);
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
    // Guard: skip the round-trip if there are no columns to update besides the PK.
    if (!Object.keys(entity).some(key => key !== primaryKey)) {
      return;
    }
    const command = buildUpdateSql(tableName, entity, primaryKey, dialect);
    await this.executeNonQuery(command.sql, command.params);
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
    await this.executeNonQuery(command.sql, command.params);
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
    const rows = await this.executeQuery<T>(command.sql, command.params);
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
    return this.executeQuery<T>(buildSelectAllSql(tableName, dialect));
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
    await this.executeNonQuery(
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
    await this.executeNonQuery('DELETE FROM [__roma_migrations] WHERE [migrationName] = @param0', [migrationName]);
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
    const rows = await this.executeQuery<{ migrationName: string }>(
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
    await this.executeNonQuery(`
      IF OBJECT_ID(N'${input.tableName.replace(/'/g, "''")}', N'U') IS NULL
      CREATE TABLE ${dialect.quoteIdentifier(input.tableName)} (${columns}${primaryKeySql})
    `);
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
    // Single-quote escape the table name used in the OBJECT_ID string literal.
    await this.executeNonQuery(`
      IF OBJECT_ID(N'${tableName.replace(/'/g, "''")}', N'U') IS NOT NULL
      DROP TABLE ${dialect.quoteIdentifier(tableName)}
    `);
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
    await this.executeNonQuery(
      `ALTER TABLE ${dialect.quoteIdentifier(tableName)} ADD ${dialect.quoteIdentifier(column.name)} ${this.mapColumnType(column)}`
    );
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
    await this.executeNonQuery(
      `ALTER TABLE ${dialect.quoteIdentifier(tableName)} DROP COLUMN ${dialect.quoteIdentifier(columnName)}`
    );
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
    const rows = await this.executeQuery<{ TABLE_NAME: string }>(`
      SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'
    `);
    return rows.map(row => row.TABLE_NAME);
  }

  /**
   * Returns column metadata for a given table, including primary-key detection.
   *
   * Queries `INFORMATION_SCHEMA.COLUMNS` joined against
   * `INFORMATION_SCHEMA.KEY_COLUMN_USAGE` to identify the primary-key column
   * using `OBJECTPROPERTY(..., 'IsPrimaryKey')`.
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
    const rows = await this.executeQuery<{ name: string; type: string; primaryKey: number }>(
      `
        SELECT COLUMN_NAME as name, DATA_TYPE as type,
          CASE WHEN COLUMN_NAME IN (
            SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
            WHERE OBJECTPROPERTY(OBJECT_ID(CONSTRAINT_SCHEMA + '.' + QUOTENAME(CONSTRAINT_NAME)), 'IsPrimaryKey') = 1
              AND TABLE_NAME = @param0
          ) THEN 1 ELSE 0 END AS primaryKey
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = @param0
      `,
      [table]
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
   * Predicates that cannot be serialized to SQL are applied client-side by
   * {@link applyClientSideQuery}.
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
      const rows = await this.executeQuery<T>(command.sql, command.params);
      return applyClientSideQuery(rows, paramsOrQuery);
    }

    // Raw SQL path: bind each element of the params array as @param0, @param1, …
    const request = this.pool.request();
    paramsOrQuery.forEach((param, index) => request.input(`param${index}`, param));
    const result = await request.query(queryOrEntityName);
    return result.recordset as T[];
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
    const request = this.pool.request();
    params.forEach((param, index) => request.input(`param${index}`, param));
    await request.query(sql);
  }

  /**
   * Creates the `[__roma_migrations]` history table if it does not exist.
   *
   * Uses a T-SQL `IF OBJECT_ID … IS NULL` guard for idempotency.  The table
   * schema matches the other providers: `migrationName` (PK), `migrationScript`,
   * and an `appliedAt` timestamp defaulting to `SYSUTCDATETIME()`.
   */
  private async ensureMigrationHistoryTable(): Promise<void> {
    await this.executeNonQuery(`
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
   * Falls back to `'id'` when no primary key is found (e.g. the table has a
   * composite key or is a view).
   *
   * @param tableName - Table to inspect.
   * @returns The primary-key column name or `'id'`.
   */
  private async getPrimaryKeyColumn(tableName: string): Promise<string> {
    const primaryKey = (await this.getColumnsForTable(tableName)).find(column => column.primaryKey)?.name;
    return primaryKey || 'id';
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
