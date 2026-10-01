export type ErrorParams = Record<string, string | number>;

export interface CodedError {
  readonly code?: string;
  readonly params?: ErrorParams;
}
