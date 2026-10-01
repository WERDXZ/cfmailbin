import { insertFragment } from "../src/graph/fragments.ts";
import { localCodeFragment } from "../src/graph/local-code-template.ts";
import {
  verificationInstructions,
  verificationSchema,
} from "../src/email/analysis.ts";
import { validateSchema } from "../src/graph/schema.ts";
import type { GraphNode, MailAction, MailGraph } from "../src/graph/types.ts";

/** Frozen v2 legacy AI snapshot, retained to verify backwards-compatible intake. */
export function receiptPolicy(
  actions: MailAction[] = [{ type: "keep" }],
): MailGraph {
  const graph = legacyReceiptPolicy();
  graph.version = 2;
  graph.enabled = true;
  const index = graph.nodes.findIndex((node) => node.kind === "rules");
  graph.nodes[index] = { ...graph.nodes[index], kind: "action", actions };
  return graph;
}

export function actionPolicy(
  actions: MailAction[] = [{ type: "keep" }],
): MailGraph {
  return {
    version: 2,
    enabled: true,
    codeExtraction: "nodes",
    nodes: [
      { id: "start", kind: "entry", label: "start", x: 0, y: 0 },
      {
        id: "actions",
        kind: "action",
        label: "actions",
        x: 0,
        y: 100,
        actions,
      },
      ...(!actions.some((a) => a.type === "deny")
        ? [{ id: "done", kind: "finish" as const, label: "done", x: 0, y: 200 }]
        : []),
    ],
    edges: [
      { from: "start", to: "actions", port: "next" },
      ...(!actions.some((a) => a.type === "deny")
        ? [{ from: "actions", to: "done", port: "next" as const }]
        : []),
    ],
  };
}

/** Frozen legacy receipt layout, solely for testing v1 historical readers. */
export function legacyReceiptPolicy(): MailGraph {
  const ai: GraphNode = {
    id: "enrich",
    x: 100,
    y: 540,
    kind: "ai",
    label: "Legacy AI",
    prompt: verificationInstructions,
    schema: validateSchema(verificationSchema),
    inputs: {
      subject: "email.subject",
      text: "email.text",
      truncated: "email.truncated",
    },
    batchGroup: "",
    onlyWhenMissingCodes: true,
    optional: true,
    outputMode: "verification",
  };
  const nodes: GraphNode[] = [
    { id: "start", label: "收到邮件", kind: "entry", x: 100, y: 30 },
    { id: "local", label: "本地提取验证码", kind: "extract", x: 100, y: 200 },
    { id: "rules", label: "旧规则", kind: "rules", x: 100, y: 370 },
    ai,
    { id: "done", label: "done", kind: "finish", x: 100, y: 710 },
  ];
  return insertFragment(
    {
      version: 1,
      codeExtraction: "nodes",
      enabled: true,
      revision: "legacy_fixture",
      nodes,
      edges: nodes.slice(1).map((node, i) => ({
        from: nodes[i].id,
        to: node.id,
        port: "next",
      })),
    },
    localCodeFragment(),
    "local",
    true,
  );
}
