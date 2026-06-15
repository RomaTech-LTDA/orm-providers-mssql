declare module 'mssql' {
  export class ConnectionPool {
    constructor(config: any);
    connect(): Promise<ConnectionPool>;
    close(): Promise<void>;
    request(): {
      input(name: string, value: any): any;
      query(sql: string): Promise<{ recordset: any[] }>;
    };
  }
}
