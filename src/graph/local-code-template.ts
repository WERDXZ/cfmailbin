import type { GraphFragment } from "./types.ts";
import { codePolicies as p } from "./code-policies.ts";

/** A template expands into ordinary nodes; its predicates are library policies. */
export function localCodeFragment(): GraphFragment {
  const base = { x: 100, y: 0 };
  return {
    entry: "candidates",
    exit: "result",
    nodes: [
      {
        ...base,
        id: "candidates",
        label: "提取候选码",
        kind: "tokens",
        sources: ["email.subject", "email.body"],
        formats: [{ characters: "digits", min: 4, max: 8, groupDigits: true }, {
          characters: "mixed",
          min: 6,
          max: 10,
        }],
        contextBefore: 80,
        contextAfter: 70,
        normalizeContext: true,
      },
      {
        ...base,
        y: 170,
        id: "context",
        label: "组合 Policy 筛选候选码",
        kind: "filter",
        input: "nodes.candidates.items",
        policies: {
          any: [
            { policy: p.before },
            { policy: p.after },
            {
              all: [{ policy: p.subject }, {
                any: [{ policy: p.standalone }, { policy: p.short }],
              }],
            },
          ],
        },
      },
      {
        ...base,
        y: 340,
        id: "result",
        label: "写入验证码",
        kind: "output",
        input: "nodes.context.items",
        limit: 3,
      },
    ],
    edges: [{ from: "candidates", to: "context", port: "next" }, {
      from: "context",
      to: "result",
      port: "next",
    }],
  };
}
