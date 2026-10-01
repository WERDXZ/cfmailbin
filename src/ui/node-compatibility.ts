import type {
  GraphNode,
  NodePreset,
  PolicyExpression,
} from "../graph/types.ts";

export function hasPolicyActions(expression: PolicyExpression): boolean {
  if ("policy" in expression) {
    return !!expression.policy.success?.actions.length;
  }
  if ("not" in expression) return hasPolicyActions(expression.not);
  return ("all" in expression ? expression.all : expression.any).some(
    hasPolicyActions,
  );
}

export function isLegacyNode(node: GraphNode): boolean {
  if (
    ["policies", "rules", "apply", "extract", "delivery"].includes(node.kind)
  ) return true;
  return (node.kind === "evaluate" || node.kind === "filter") &&
    hasPolicyActions(node.policies);
}

export function isLegacyPreset(preset: NodePreset): boolean {
  return preset.fragment
    ? preset.fragment.nodes.some((node) =>
      isLegacyNode(node) || node.kind === "condition" && !node.unknown
    )
    : isLegacyNode(preset.node);
}
