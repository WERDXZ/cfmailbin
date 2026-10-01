import type { JsonSchema } from "./schema.ts";
import type { RuleActions, RuleDecision } from "../domain/models.ts";
import type { MessageAnalysis } from "../domain/analysis.ts";
import type { ErrorParams } from "../domain/errors.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | {
  [key: string]: JsonValue;
};
interface NodeBase {
  id: string;
  label: string;
  x: number;
  y: number;
  preset?: { id: string; revision: string };
}
export type GraphCondition =
  | { all: GraphCondition[] }
  | { any: GraphCondition[] }
  | { not: GraphCondition }
  | {
    path: string;
    operator:
      | "equals"
      | "contains"
      | "exists"
      | "containsAny"
      | "startsWithAny"
      | "endsWithAny"
      | "textEquals"
      | "startsWith"
      | "endsWith"
      | "glob";
    value: JsonValue;
  };
export interface AiNode extends NodeBase {
  kind: "ai";
  prompt: string;
  inputs: Record<string, string>;
  schema: JsonSchema;
  batchGroup: string;
  /** New nodes return { success, data, error }; absent preserves saved legacy semantics. */
  resultFormat?: "envelope";
  /** Legacy snapshot options. New workflows use IF and output nodes. */
  onlyWhenMissingCodes?: boolean;
  optional?: boolean;
  outputMode?: "verification";
}
export type ActionBinding = { ref: string; fallback?: JsonValue };
export type MailAction =
  | { type: "keep"; retentionDays?: number | ActionBinding }
  | { type: "trash" }
  | { type: "tag"; tags: string[] | ActionBinding }
  | { type: "set_retention"; days: number | ActionBinding }
  | { type: "forward"; to: string | ActionBinding }
  | { type: "reply"; text: string | ActionBinding }
  | { type: "deny"; reason: string | ActionBinding };
export interface ActionResult {
  nodeId: string;
  type: MailAction["type"];
  status: "complete" | "simulated";
  value?: JsonValue;
}
export type GraphNode =
  & NodeBase
  & (
    | { kind: "entry" }
    | { kind: "extract" | "rules" }
    | { kind: "finish"; actions?: MailAction[] }
    | { kind: "evaluate"; policies: PolicyExpression }
    | {
      kind: "match";
      input: string;
      cases: {
        id: string;
        label: string;
        value: string | number | boolean | null;
      }[];
    }
    | {
      kind: "tokens";
      sources: string[];
      formats: TokenFormat[];
      contextBefore: number;
      contextAfter: number;
      normalizeContext: boolean;
    }
    | { kind: "filter"; input: string; policies: PolicyExpression }
    | { kind: "output"; input: string; limit: number }
    | { kind: "policies"; policies: PolicyExpression }
    | { kind: "apply"; input: string }
    | { kind: "action"; actions: MailAction[] }
    | Omit<AiNode, keyof NodeBase>
    | {
      kind: "condition";
      path: string;
      operator: "equals" | "contains" | "exists";
      value: JsonValue;
      condition?: GraphCondition;
      /** v2 IF has an explicit unknown branch. */
      unknown?: true;
    }
    | {
      kind: "delivery";
      action: "keep" | "forward" | "trash";
      forwardTo: string;
      tags: string[];
      retentionDays?: number;
    }
  );
export interface GraphEdge {
  from: string;
  to: string;
  port:
    | "next"
    | "yes"
    | "no"
    | "unknown"
    | "success"
    | "failed"
    | "default"
    | `case:${string}`;
}
export interface MailGraph {
  version: 1 | 2;
  codeExtraction?: "nodes";
  enabled: boolean;
  revision?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
export interface GraphPlan {
  order: string[];
  unreachable: string[];
  batches: string[][];
  notes: string[];
}
export interface GraphStep {
  nodeId: string;
  label: string;
  status: "complete" | "failed" | "skipped";
  durationMs: number;
  output?: JsonValue;
  error?: string;
  errorCode?: string;
  errorParams?: ErrorParams;
  batch?: string[];
}
export interface GraphRun {
  actionResults?: ActionResult[];
  revision?: string;
  status: "running" | "complete" | "failed";
  steps: GraphStep[];
  action?: "keep" | "forward" | "trash" | "block";
  codes?: string[];
  analysis?: MessageAnalysis;
  ruleDecision?: RuleDecision;
  forwardTo?: string;
  tags: string[];
  retentionDays?: number;
  error?: string;
  errorCode?: string;
  errorParams?: ErrorParams;
  trial: boolean;
}
export interface GraphStore {
  kind: "kv" | "memory";
  get(): Promise<MailGraph | null>;
  getLegacy(): Promise<MailGraph | null>;
  put(graph: MailGraph): Promise<void>;
  getLibrary(): Promise<NodePreset[]>;
  putLibrary(presets: NodePreset[]): Promise<void>;
  getPolicies(): Promise<PolicyDefinition[]>;
  putPolicies(policies: PolicyDefinition[]): Promise<void>;
}
export interface NodePreset {
  id: string;
  revision: string;
  node: GraphNode;
  fragment?: GraphFragment;
}
export interface TokenFormat {
  characters: "digits" | "mixed";
  min: number;
  max: number;
  groupDigits?: boolean;
}
export interface GraphFragment {
  nodes: GraphNode[];
  edges: GraphEdge[];
  entry: string;
  exit: string;
}
export interface PolicyDefinition {
  version?: 2;
  id: string;
  revision: string;
  name: string;
  condition: GraphCondition;
  /** Historical snapshots only; new policies configure just their condition. */
  success?: { actions: RuleActions[]; branches: string[] };
  failed?: { reasons: string[]; branches: string[] };
}
export type PolicyExpression =
  | { policy: PolicyDefinition }
  | { all: PolicyExpression[] }
  | { any: PolicyExpression[] }
  | { not: PolicyExpression };
export interface PolicyResult {
  /** null means the input was incomplete or unavailable, not a negative match. */
  success: boolean | null;
  status: "success" | "failed" | "unknown";
  /** Compatibility for saved workflows referencing the old field. */
  matched: boolean;
  indeterminate?: boolean;
  actions: RuleActions[];
  branches: string[];
  reasons: string[];
  results: {
    id: string;
    name: string;
    revision: string;
    success: boolean | null;
    matched: boolean;
    indeterminate?: boolean;
    reasons: string[];
    branches: string[];
  }[];
}
export class GraphError extends Error {
  readonly status = 400;

  constructor(
    message: string,
    readonly code?: string,
    readonly params?: ErrorParams,
  ) {
    super(message);
  }
}
export class GraphAiLimitError extends GraphError {
  constructor() {
    super("已达到每日 AI 调用上限", "common.dailyAiCallLimitReached");
  }
}
