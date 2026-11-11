'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const mssql = require('mssql');
const { QueryBuilder, Transaction, isTransactionalProvider } = require('@romatech/orm');
const { MsSqlProvider } = require('../dist');

/**
 * Provider whose connection pool is replaced by a stub recording SQL, inputs
 * and the connection each statement ran on ('pool' or 'tx<N>').
 */
function stubProvider(columns, options = {}) {
  const statements = [];
  const events = [];
  let transactions = 0;
  let inFlight = 0;
  let overlapped = false;
  const provider = new MsSqlProvider('Server=unused');

  const request = via => {
    const inputs = {};
    return {
      input(name, value) { inputs[name] = value; },
      async query(sql) {
        inFlight += 1;
        if (via !== 'pool' && inFlight > 1) overlapped = true;
        statements.push({ sql, inputs, via });
        await new Promise(resolve => setImmediate(resolve));
        inFlight -= 1;
        if (options.failIntrospection && /sys\.columns/.test(sql)) {
          options.failIntrospection = false;
          throw new Error('introspection failed');
        }
        if (/sys\.columns/.test(sql)) return { recordset: columns };
        return { recordset: options.recordset ?? [] };
      }
    };
  };

  provider.pool = {
    request: () => request('pool'),
    transaction() {
      const id = `tx${++transactions}`;
      const listeners = [];
      return {
        on(event, listener) { if (event === 'rollback') listeners.push(listener); },
        async begin() { events.push(`${id}:begin`); },
        async commit() { events.push(`${id}:commit`); },
        async rollback() { events.push(`${id}:rollback`); },
        request: () => request(id),
        abort() { listeners.forEach(listener => listener(true)); }
      };
    },
    async close() { events.push('pool:close'); }
  };
  return { provider, statements, events, overlapped: () => overlapped };
}

const singleKey = [
  { name: 'id', type: 'int', primaryKey: 1 },
  { name: 'name', type: 'nvarchar', primaryKey: 0 }
];
const compositeKey = [
  { name: 'orderId', type: 'int', primaryKey: 1 },
  { name: 'lineNo', type: 'int', primaryKey: 1 }
];

/** A QueryObject whose only predicate cannot be translated to SQL (client-side). */
function clientSideQuery(predicate, extra = {}) {
  return { includes: [], predicates: [predicate], whereExpressions: [], orderings: [], orderByExpressions: [], ...extra };
}

test('table existence checks bind the quoted name instead of splitting it on dots', async () => {
  const { provider, statements } = stubProvider(singleKey);
  await provider.createTable({ tableName: 'a.b', columns: [{ name: 'id', tsType: 'number', primaryKey: true }] });
  await provider.dropTable("o'brien");
  assert.match(statements[0].sql, /IF OBJECT_ID\(@param0, N'U'\) IS NULL\s+CREATE TABLE \[a\.b\]/);
  assert.deepEqual(statements[0].inputs, { param0: '[a.b]' });
  assert.deepEqual(statements[1].inputs, { param0: "[o'brien]" });
  assert.doesNotMatch(statements[1].sql, /OBJECT_ID\(N'/, 'no string literal is built from the table name');
});

test('column introspection resolves the table with OBJECT_ID (no cross-schema mix)', async () => {
  const { provider, statements } = stubProvider(singleKey);
  await provider.getColumnsForTable('items');
  assert.match(statements[0].sql, /WHERE c\.object_id = OBJECT_ID\(@param0\)/);
  assert.deepEqual(statements[0].inputs, { param0: '[items]' });
});

describe('primary key handling', () => {
  for (const method of ['update', 'remove', 'find']) {
    test(`${method}() refuses a composite primary key`, async () => {
      const { provider, statements } = stubProvider(compositeKey);
      await assert.rejects(() => provider[method]({ orderId: 1, lineNo: 1 }, 'lines'), /composite primary key/);
      assert.ok(statements.every(s => /sys\.columns/.test(s.sql)), 'no DML must be sent');
    });
  }

  test('update() with only undefined values besides the key sends nothing', async () => {
    const { provider, statements } = stubProvider(singleKey);
    await provider.update({ id: 1, name: undefined }, 'items');
    assert.ok(statements.every(s => !s.sql.startsWith('UPDATE')));
  });

  test('the primary key is introspected once per table, not on every operation', async () => {
    const { provider, statements } = stubProvider(singleKey);
    await provider.update({ id: 1, name: 'a' }, 'items');
    await provider.remove({ id: 2 }, 'items');
    await provider.find({ id: 3 }, 'items');
    assert.equal(statements.filter(s => /sys\.columns/.test(s.sql)).length, 1);
  });

  test('schema changes and raw non-SELECT statements invalidate the cached key', async () => {
    const { provider, statements } = stubProvider(singleKey);
    const lookups = () => statements.filter(s => /sys\.columns/.test(s.sql)).length;
    await provider.find({ id: 1 }, 'items');
    await provider.executeQuery('SELECT 1', []);
    await provider.find({ id: 1 }, 'items');
    assert.equal(lookups(), 1, 'a SELECT keeps the cache');
    await provider.executeNonQuery('ALTER TABLE [items] ADD [x] int');
    await provider.find({ id: 1 }, 'items');
    assert.equal(lookups(), 2);
    await provider.addColumn('items', { name: 'y', tsType: 'string' });
    await provider.find({ id: 1 }, 'items');
    assert.equal(lookups(), 3);
    provider.clearMetadataCache('items');
    await provider.find({ id: 1 }, 'items');
    assert.equal(lookups(), 4);
  });

  test('a failed key lookup is not cached', async () => {
    const { provider, statements } = stubProvider(singleKey, { failIntrospection: true });
    await assert.rejects(() => provider.find({ id: 1 }, 'items'), /introspection failed/);
    await provider.find({ id: 1 }, 'items');
    assert.equal(statements.filter(s => /^SELECT \* FROM \[items\] WHERE/.test(s.sql)).length, 1);
  });
});

describe('TLS', () => {
  async function resolvedOptions(options) {
    const original = mssql.ConnectionPool.prototype.connect;
    mssql.ConnectionPool.prototype.connect = async function () { return this; };
    try {
      const provider = new MsSqlProvider({ user: 'u', password: 'p', server: 'h', database: 'd', options });
      await provider.connect();
      return provider.pool.config.options;
    } finally {
      mssql.ConnectionPool.prototype.connect = original;
    }
  }

  test('the server certificate is validated by default', async () => {
    assert.equal((await resolvedOptions(undefined)).trustServerCertificate, false);
    assert.equal((await resolvedOptions({ encrypt: true })).trustServerCertificate, false);
  });

  test('trustServerCertificate: true is honoured when set explicitly', async () => {
    assert.equal((await resolvedOptions({ trustServerCertificate: true })).trustServerCertificate, true);
  });
});

describe('transactions', () => {
  test('the provider is an ITransactionalProvider', () => {
    assert.equal(isTransactionalProvider(new MsSqlProvider('Server=unused')), true);
  });

  test('statements run on the transaction connection until commit', async () => {
    const { provider, statements, events } = stubProvider(singleKey);
    await provider.beginTransaction();
    await provider.add({ id: 1, name: 'a' }, 'items');
    await provider.update({ id: 1, name: 'b' }, 'items');
    await provider.commitTransaction();
    await provider.getAll('items');
    assert.deepEqual(statements.map(s => s.via), ['tx1', 'tx1', 'tx1', 'pool']);
    assert.deepEqual(events, ['tx1:begin', 'tx1:commit']);
  });

  test('statements inside a transaction are serialized on its single connection', async () => {
    const { provider, overlapped } = stubProvider(singleKey);
    await provider.beginTransaction();
    await Promise.all([1, 2, 3].map(id => provider.add({ id, name: 'x' }, 'items')));
    await provider.rollbackTransaction();
    assert.equal(overlapped(), false);
  });

  test('rollback ends the transaction; nested begin is rejected; rollback without one is a no-op', async () => {
    const { provider, statements, events } = stubProvider(singleKey);
    await provider.rollbackTransaction();
    await provider.beginTransaction();
    await assert.rejects(() => provider.beginTransaction(), /already active/);
    await provider.rollbackTransaction();
    await provider.getAll('items');
    assert.deepEqual(events, ['tx1:begin', 'tx1:rollback']);
    assert.equal(statements.at(-1).via, 'pool');
    await assert.rejects(() => provider.commitTransaction(), /No active transaction/);
  });

  test('raw COMMIT/ROLLBACK (what @romatech/orm 2.0.0 Transaction sends) are routed to the transaction', async () => {
    const { provider, statements, events } = stubProvider(singleKey);
    await provider.beginTransaction();
    await new Transaction(provider).commit();
    await provider.executeQuery('BEGIN TRANSACTION', []);
    await provider.executeNonQuery('rollback tran;');
    assert.deepEqual(events, ['tx1:begin', 'tx1:commit', 'tx2:begin', 'tx2:rollback']);
    assert.equal(statements.length, 0, 'no raw control statement reaches a pooled connection');
  });

  test('a transaction aborted by SQL Server cannot be committed', async () => {
    const { provider, events } = stubProvider(singleKey);
    await provider.beginTransaction();
    provider.transaction.abort();
    await assert.rejects(() => provider.add({ id: 1 }, 'items'), /aborted/);
    await assert.rejects(() => provider.commitTransaction(), /aborted/);
    assert.deepEqual(events, ['tx1:begin']);
    await provider.rollbackTransaction(); // no-op, already ended
  });

  test('disconnect() rolls back an open transaction', async () => {
    const { provider, events } = stubProvider(singleKey);
    await provider.beginTransaction();
    await provider.disconnect();
    assert.deepEqual(events, ['tx1:begin', 'tx1:rollback', 'pool:close']);
  });
});

test('client-side predicates see bigint values as numbers; the driver rows are returned', async () => {
  const recordset = [{ id: '5', name: 'a' }, { id: '6', name: 'b' }];
  recordset.columns = { id: { type: { declaration: 'bigint' } }, name: { type: { declaration: 'nvarchar' } } };
  const { provider } = stubProvider(singleKey, { recordset });
  const rows = await provider.executeQuery('items', clientSideQuery(x => x.id === 5));
  assert.deepEqual(rows, [{ id: '5', name: 'a' }]);
  const names = await provider.executeQuery('items', clientSideQuery(x => x.id > 0, { selector: x => x.name, orderBy: (a, b) => b.id - a.id }));
  assert.deepEqual(names, ['b', 'a']);
});

test('predicates written against the driver values (2.0.0 style) still match the rows SQL Server returned', async () => {
  // SQL Server applied [id] = '5'; the re-check must not drop the row.
  const recordset = [{ id: '5', name: 'a' }];
  recordset.columns = { id: { type: { declaration: 'bigint' } }, name: { type: { declaration: 'nvarchar' } } };
  const { provider } = stubProvider(singleKey, { recordset });
  const rows = await new QueryBuilder(class Item {}, provider, 'items').where(x => x.id === '5').toList();
  assert.deepEqual(rows, [{ id: '5', name: 'a' }]);
  // When JavaScript is the only filter, the converted value decides.
  const all = [{ id: '5', name: 'a' }, { id: '6', name: 'b' }];
  all.columns = recordset.columns;
  const { provider: local } = stubProvider(singleKey, { recordset: all });
  assert.deepEqual(await local.executeQuery('items', clientSideQuery(x => x.id !== 5)), [{ id: '6', name: 'b' }]);
});

test('a datetime2 compared with a string literal is left to SQL Server', async () => {
  const recordset = [{ id: 1, born: new Date(2024, 0, 2) }];
  recordset.columns = { id: { type: { declaration: 'int' } }, born: { type: { declaration: 'datetime2' } } };
  const { provider, statements } = stubProvider(singleKey, { recordset });
  const rows = await new QueryBuilder(class Item {}, provider, 'items').where(x => x.born >= '2024-01-01').toList();
  assert.match(statements.at(-1).sql, /WHERE \[born\] >= @param0/);
  assert.deepEqual(rows.map(r => r.id), [1]);
});

// ─── Integration (MSSQL_TEST_URL="Server=host,port;Database=...;User Id=...;Password=...;TrustServerCertificate=true") ─

const url = process.env.MSSQL_TEST_URL;

/** Parses the ADO-style test connection string into the provider's object config. */
function objectConfig(connectionString) {
  const parts = Object.fromEntries(connectionString.split(';').filter(Boolean).map(part => {
    const index = part.indexOf('=');
    return [part.slice(0, index).trim().toLowerCase(), part.slice(index + 1).trim()];
  }));
  const [server, port] = parts.server.split(',');
  return { server, port: port ? Number(port) : undefined, database: parts.database, user: parts['user id'], password: parts.password };
}

describe('integration with a real SQL Server', { skip: !url && 'set MSSQL_TEST_URL to run' }, () => {
  test('composite keys, schema isolation and dotted table names', async () => {
    const provider = new MsSqlProvider(url);
    await provider.connect('');
    const schema = `roma_other_${process.pid}`;
    const cleanup = async () => {
      await provider.executeQuery(`IF OBJECT_ID('[${schema}].[roma_items]') IS NOT NULL DROP TABLE [${schema}].[roma_items]`, []);
      await provider.executeQuery(`IF SCHEMA_ID('${schema}') IS NOT NULL EXEC('DROP SCHEMA [${schema}]')`, []);
      await provider.dropTable('roma_lines');
      await provider.dropTable('roma_items');
      await provider.dropTable('roma.dotted');
    };
    try {
      await cleanup();
      await provider.executeQuery(`EXEC('CREATE SCHEMA [${schema}]')`, []);
      await provider.executeQuery('CREATE TABLE [roma_lines] ([orderId] int NOT NULL, [lineNo] int NOT NULL, PRIMARY KEY ([orderId], [lineNo]))', []);
      await provider.executeQuery('CREATE TABLE [roma_items] ([id] int PRIMARY KEY, [name] nvarchar(20))', []);
      await provider.executeQuery(`CREATE TABLE [${schema}].[roma_items] ([code] nvarchar(20) PRIMARY KEY, [extra] nvarchar(20))`, []);

      const columns = await provider.getColumnsForTable('roma_items');
      assert.deepEqual(columns.map(c => [c.name, c.primaryKey]), [['id', true], ['name', false]]);

      await provider.addRange([{ orderId: 1, lineNo: 1 }, { orderId: 1, lineNo: 2 }], 'roma_lines');
      await assert.rejects(() => provider.remove({ orderId: 1, lineNo: 1 }, 'roma_lines'), /composite primary key/);
      assert.equal((await provider.getAll('roma_lines')).length, 2);

      const dotted = { tableName: 'roma.dotted', columns: [{ name: 'id', tsType: 'number', primaryKey: true }] };
      await provider.createTable(dotted);
      await provider.createTable(dotted); // idempotent
      assert.deepEqual((await provider.getColumnsForTable('roma.dotted')).map(c => c.name), ['id']);
    } finally {
      await cleanup();
      await provider.disconnect();
    }
  });

  test('transactions run on one connection: rollback undoes, commit persists, others see only committed rows', async () => {
    const provider = new MsSqlProvider(url);
    const observer = new MsSqlProvider(url);
    await provider.connect('');
    await observer.connect('');
    try {
      await provider.dropTable('roma_tx');
      await provider.executeQuery('CREATE TABLE [roma_tx] ([id] int PRIMARY KEY, [name] nvarchar(20))', []);

      await provider.beginTransaction();
      await Promise.all([1, 2, 3].map(id => provider.add({ id, name: 'x' }, 'roma_tx')));
      assert.equal((await provider.getAll('roma_tx')).length, 3, 'the transaction sees its own rows');
      await provider.rollbackTransaction();
      assert.equal((await provider.getAll('roma_tx')).length, 0);

      await provider.beginTransaction();
      await provider.add({ id: 10, name: 'a' }, 'roma_tx');
      const uncommitted = await observer.executeQuery('SELECT COUNT(*) AS n FROM [roma_tx] WITH (READPAST)', []);
      assert.equal(uncommitted[0].n, 0, 'another connection does not see the uncommitted row');
      await new Transaction(provider).commit(); // @romatech/orm 2.0.0 sends a raw COMMIT
      assert.equal((await observer.getAll('roma_tx')).length, 1);

      // A statement error that dooms the transaction (XACT_ABORT) cannot be committed.
      await provider.beginTransaction();
      await provider.add({ id: 30, name: 'c' }, 'roma_tx');
      await assert.rejects(() => provider.executeNonQuery(
        'SET XACT_ABORT ON; INSERT INTO [roma_tx] ([id]) VALUES (20); INSERT INTO [roma_tx] ([id]) VALUES (20)'
      ));
      await assert.rejects(() => provider.commitTransaction(), /aborted/);
      assert.deepEqual((await observer.getAll('roma_tx')).map(r => r.id), [10]);
    } finally {
      await provider.rollbackTransaction();
      await provider.dropTable('roma_tx');
      await observer.disconnect();
      await provider.disconnect();
    }
  });

  test('bigint keys match client-side predicates', async () => {
    const provider = new MsSqlProvider(url);
    await provider.connect('');
    try {
      await provider.dropTable('roma_big');
      await provider.executeQuery('CREATE TABLE [roma_big] ([id] bigint IDENTITY PRIMARY KEY, [name] nvarchar(20))', []);
      await provider.add({ name: 'a' }, 'roma_big');
      await provider.add({ name: 'b' }, 'roma_big');
      const rows = await provider.executeQuery('roma_big', clientSideQuery(x => x.id === 2));
      assert.deepEqual(rows.map(r => r.name), ['b']);
      await provider.executeNonQuery('ALTER TABLE [roma_big] ADD [born] datetime2');
      await provider.update({ id: 2, born: new Date(2024, 0, 2) }, 'roma_big');
      const q = new QueryBuilder(class Big {}, provider, 'roma_big');
      assert.deepEqual((await q.where(x => x.born >= '2024-01-01').toList()).map(r => r.name), ['b']);
    } finally {
      await provider.dropTable('roma_big');
      await provider.disconnect();
    }
  });

  test('TLS: a self-signed certificate is rejected unless trustServerCertificate is set explicitly', async () => {
    const config = objectConfig(url);
    const secure = new MsSqlProvider(config);
    await assert.rejects(() => secure.connect(), /certificate/i);
    const local = new MsSqlProvider({ ...config, options: { trustServerCertificate: true } });
    await local.connect();
    assert.equal((await local.executeQuery('SELECT 1 AS one', []))[0].one, 1);
    await local.disconnect();
  });
});
