import { graphNodeLabels } from "./GraphCanvas.tsx";
import { localizedPreset, presetLabel } from "./templates.ts";
import { useI18n } from "./i18n.tsx";
import type { GraphFragment, GraphNode, NodePreset } from "../graph/types.ts";
import { usePreset } from "../graph/library.ts";
import { isLegacyPreset } from "./node-compatibility.ts";
import { TemplatePicker } from "./TemplatePicker.tsx";

export interface NodeDraft {
  node: GraphNode;
  fragment?: GraphFragment;
}

// These are editable drafts, deliberately incomplete until the user configures them.
const base = { id: "node", x: 0, y: 0 };
const blankNodes: GraphNode[] = [
  {
    ...base,
    kind: "ai",
    resultFormat: "envelope",
    label: "",
    prompt: "",
    inputs: {},
    batchGroup: "",
    schema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  { ...base, kind: "evaluate", label: "", policies: { all: [] } },
  {
    ...base,
    kind: "condition",
    label: "",
    unknown: true,
    path: "",
    operator: "equals",
    value: true,
  },
  { ...base, kind: "match", label: "", input: "", cases: [] },
  { ...base, kind: "action", label: "", actions: [] },
  { ...base, kind: "finish", label: "" },
  {
    ...base,
    kind: "tokens",
    label: "",
    sources: [],
    formats: [],
    contextBefore: 80,
    contextAfter: 70,
    normalizeContext: true,
  },
  {
    ...base,
    kind: "filter",
    label: "",
    input: "",
    policies: { all: [] },
  },
  { ...base, kind: "output", label: "", input: "", limit: 3 },
];
/** Both editors share node types, templates, and saved snapshot selection. */
export function NodePicker({ label, presets, disabled, create }: {
  label: string;
  presets: NodePreset[];
  disabled?: boolean;
  create: (draft: NodeDraft) => void | boolean;
}) {
  const { t } = useI18n();
  const usable = presets.filter((preset) => !isLegacyPreset(preset));
  return (
    <TemplatePicker
      label={label}
      actionLabel={label === t("graph.addNode")
        ? t("graph.addNode")
        : t("nodes.createNode")}
      blank={{ id: "", label: t("audit.node") }}
      types={blankNodes.map((node) => ({
        id: node.kind,
        label: t(graphNodeLabels[node.kind]),
      }))}
      options={usable.map((preset) => ({
        id: preset.id,
        label: presetLabel(preset, t),
        type: preset.fragment ? undefined : preset.node.kind,
        group: preset.fragment
          ? t("nodes.compositeTemplate")
          : preset.id.startsWith("builtin_")
          ? t("nodes.template")
          : t("nodes.saved"),
        composition: !!preset.fragment,
        description: preset.fragment
          ? t("nodes.expandNodeCount", { count: preset.fragment.nodes.length })
          : undefined,
      }))}
      disabled={disabled}
      create={(id, type) => {
        if (!id) {
          const node = blankNodes.find((node) => node.kind === type);
          return node
            ? create({
              node: {
                ...structuredClone(node),
                label: t(graphNodeLabels[node.kind]),
              },
            })
            : false;
        }
        const source = usable.find((preset) => preset.id === id);
        if (!source) return false;
        const preset = localizedPreset(source, t);
        return create(
          preset.fragment
            ? structuredClone({ node: preset.node, fragment: preset.fragment })
            : { node: usePreset(preset, preset.node) },
        );
      }}
    />
  );
}
