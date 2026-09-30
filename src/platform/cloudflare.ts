export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface D1PreparedStatement {
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

export interface R2ObjectBody {
  body: ReadableStream<Uint8Array> | null;
  httpMetadata?: {
    contentType?: string;
  };
}

export interface R2Bucket {
  delete(keys: string | string[]): Promise<void>;
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: Uint8Array,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
}

export interface ForwardableEmailMessage {
  forward(destination: string): Promise<unknown>;
  from: string;
  headers: Headers;
  raw: ReadableStream<Uint8Array>;
  rawSize?: number;
  setReject(reason: string): void;
  to: string;
}

export interface ScheduledController {
  cron: string;
  scheduledTime: number;
}
