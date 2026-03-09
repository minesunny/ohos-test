declare module "node:sqlite" {
  export type RunResult = {
    changes: number;
    lastInsertRowid: number | bigint;
  };

  export class StatementSync {
    run(...params: unknown[]): RunResult;
    get<T = Record<string, unknown>>(...params: unknown[]): T | undefined;
    all<T = Record<string, unknown>>(...params: unknown[]): T[];
  }

  export type DatabaseSyncOptions = {
    open?: boolean;
    readOnly?: boolean;
    enableForeignKeyConstraints?: boolean;
  };

  export class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
