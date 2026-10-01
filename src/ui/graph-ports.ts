import {
  type TranslationKey,
  type Translator,
  translator,
} from "./translate.ts";
import type { GraphEdge, GraphNode } from "../graph/types.ts";

export function portLabel(
  node: GraphNode,
  port: GraphEdge["port"],
  t: Translator = translator("en"),
): string {
  if (port.startsWith("case:") && node.kind === "match") {
    return node.cases.find((item) => `case:${item.id}` === port)?.label || port;
  }
  const labels: Partial<Record<GraphEdge["port"], TranslationKey>> = {
    next: "graph.next",
    yes: "graph.true",
    no: "graph.false",
    unknown: "graph.unknown",
    default: "graph.defaultUnknown",
    success: "graph.passed",
    failed: "graph.notPassed",
  };
  const key = labels[port];
  return key ? t(key) : port;
}
