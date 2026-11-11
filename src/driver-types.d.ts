declare module 'mssql' {
  export interface MsSqlRequest {
    input(name: string, value: any): any;
    query(sql: string): Promise<{ recordset: any[] }>;
  }

  export interface MsSqlTransaction {
    begin(): Promise<unknown>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    request(): MsSqlRequest;
    on(event: 'rollback', listener: (aborted: boolean) => void): unknown;
  }

  export class ConnectionPool {
    constructor(config: any);
    connect(): Promise<ConnectionPool>;
    close(): Promise<void>;
    request(): MsSqlRequest;
    transaction(): MsSqlTransaction;
  }
}
