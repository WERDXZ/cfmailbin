import { localCodeFragment } from "./local-code-template.ts";
import { evaluatePolicies } from "./policies.ts";
import { collectCodes, extractTokens } from "./text-operations.ts";
import type { GraphNode, JsonValue } from "./types.ts";

/** Compatibility for old graphs/messages, using the same editable template definition. */
export function findVerificationCodes(text: string, subject = ""): string[] {
  const [extract, filter, output] = localCodeFragment().nodes as [
    Extract<GraphNode, { kind: "tokens" }>,
    Extract<GraphNode, { kind: "filter" }>,
    Extract<GraphNode, { kind: "output" }>,
  ];
  const email: Record<string, JsonValue> = { subject, body: text, text };
  const source = extract.sources.map((p) => email[p.split(".")[1]]).join("\n");
  const { items } = extractTokens(
    source,
    extract.formats,
    extract.contextBefore,
    extract.contextAfter,
    extract.normalizeContext,
  );
  const selected = items.filter((item) =>
    evaluatePolicies(filter.policies, (path) => {
      const [scope, field] = path.split(".");
      return scope === "email"
        ? email[field]
        : item[field as keyof typeof item];
    }).matched
  );
  return collectCodes(selected as unknown as JsonValue, source, output.limit);
}
