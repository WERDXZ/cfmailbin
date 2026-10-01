import { presetLabel } from "./templates.ts";
import {
  type DisplayMessage,
  formatMessage,
  localizedMessage,
} from "./messages.ts";
import { useI18n } from "./i18n.tsx";
import { useEffect, useState } from "preact/hooks";
import { parseFragment } from "../graph/fragments.ts";
import type { GraphFragment, GraphNode, NodePreset } from "../graph/types.ts";
import { parseNode } from "../graph/compile.ts";
import { api } from "./api.ts";
import { GraphInspector } from "./GraphInspector.tsx";
import { graphNodeLabels } from "./GraphCanvas.tsx";
import { useUnsavedChanges } from "./useUnsavedChanges.ts";
import "./graph.css";
import { NodePicker } from "./NodePicker.tsx";
import { isLegacyPreset } from "./node-compatibility.ts";

export function NodeLibrary() {
  const { t } = useI18n();
  const [presets, setPresets] = useState<NodePreset[]>([]);
  const [templates, setTemplates] = useState<NodePreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<NodePreset | null>(null);
  const [node, setNode] = useState<GraphNode | null>(null);
  const [fragment, setFragment] = useState<GraphFragment | undefined>();
  const [stepId, setStepId] = useState("");
  const [buffers, setBuffers] = useState<Record<string, string>>({});
  const [invalidJson, setInvalidJson] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<DisplayMessage>("");
  const [notice, setNotice] = useState<DisplayMessage>("");
  const [busy, setBusy] = useState(false);
  const [available, setAvailable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const legacy = !!selected && isLegacyPreset(selected);
  const dirty = creating ||
    JSON.stringify(node) !== JSON.stringify(selected?.node ?? null) ||
    JSON.stringify(fragment) !== JSON.stringify(selected?.fragment) ||
    Object.values(invalidJson).some(Boolean);
  function select(preset?: NodePreset) {
    setCreating(false);
    setSelected(preset ?? null);
    setNode(preset ? structuredClone(preset.node) : null);
    setFragment(preset?.fragment && structuredClone(preset.fragment));
    setStepId(preset?.fragment?.entry ?? "");
    setBuffers({});
    setInvalidJson({});
    setNotice("");
  }
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setLoading(true);
    api.getNodeLibrary(controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      setPresets(value.presets);
      setTemplates(value.templates);
      setAvailable(value.storage !== "unavailable");
      select(value.presets[0]);
    }).catch((e) => {
      if (!controller.signal.aborted) setError(e);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [attempt]);
  useUnsavedChanges(dirty, t("nodes.thisNodeHasUnsavedChangesDiscardThem"));
  let validation: DisplayMessage = "";
  try {
    if (node) parseNode(node);
    if (fragment) parseFragment(fragment);
  } catch (e) {
    validation = e as Error;
  }
  if (Object.values(invalidJson).some(Boolean)) {
    validation = localizedMessage("errors.enterValidJson");
  }
  async function save(copy = false) {
    if (!selected || !node || legacy) return;
    setBusy(true);
    setError("");
    try {
      const isNew = copy || creating;
      const preset = await api.saveNodePreset(
        isNew ? `node_${crypto.randomUUID()}` : selected.id,
        node,
        isNew ? undefined : selected.revision,
        fragment,
      );
      setPresets([...presets.filter((p) => p.id !== preset.id), preset]);
      select(preset);
      setNotice(
        localizedMessage("nodes.savedToTheNodeLibraryExistingWorkflows"),
      );
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (
      !selected || !confirm(t("nodes.deleteThisPresetWorkflowsThatUseIt"))
    ) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.deleteNodePreset(selected.id);
      const next = presets.filter((p) => p.id !== selected.id);
      setPresets(next);
      select(next[0]);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  const editing = fragment?.nodes.find((n) => n.id === stepId) ?? node;
  function update(next: GraphNode) {
    if (fragment) {
      setFragment({
        ...fragment,
        nodes: fragment.nodes.map((n) => n.id === next.id ? next : n),
      });
    } else setNode(next);
  }
  return (
    <section class="graph-editor node-library">
      <div class="settings-section-heading">
        <h2>{t("nodes.nodeLibrary")}</h2>
        <p class="muted">
          {t("nodes.saveConditionsPromptsAndActionSettingsTo")}
        </p>
      </div>
      {error && (
        <p class="notice notice--error" role="alert">
          {formatMessage(error, t)} {!presets.length && (
            <button
              type="button"
              class="text-button"
              onClick={() => setAttempt(attempt + 1)}
            >
              {t("common.retry")}
            </button>
          )}
        </p>
      )}
      {notice && <p class="notice" role="status">{formatMessage(notice, t)}</p>}
      {loading && !error && <p role="status">{t("nodes.loadingNodeLibrary")}
      </p>}
      {!loading && !presets.length && !error && (
        <p class="muted">{t("nodes.noSavedNodesYet")}</p>
      )}
      <fieldset disabled={busy || loading}>
        <NodePicker
          label={t("nodes.newNode")}
          presets={templates}
          create={(choice) => {
            if (dirty && !confirm(t("nodes.discardUnsavedChangesToThisNode"))) {
              return false;
            }
            select({
              ...choice,
              id: `node_${crypto.randomUUID()}`,
              revision: "",
            });
            setCreating(true);
          }}
        />
        <div class="node-library-layout">
          <nav aria-label={t("nodes.nodeLibraryPresets")}>
            {presets.map((preset) => (
              <button
                type="button"
                class={`node-library-item ${
                  selected?.id === preset.id ? "is-selected" : ""
                }`}
                key={preset.id}
                onClick={() => {
                  if (
                    !dirty ||
                    confirm(t("nodes.discardUnsavedChangesToThisNode"))
                  ) {
                    select(
                      preset,
                    );
                  }
                }}
              >
                <span>
                  {presetLabel(preset, t)}
                </span>
                <small>
                  {preset.fragment
                    ? t("nodes.templateNodeCount", {
                      count: preset.fragment.nodes.length,
                    })
                    : t(graphNodeLabels[preset.node.kind])}
                  {isLegacyPreset(preset)
                    ? t("nodes.legacy")
                    : preset.id.startsWith("builtin_")
                    ? t("nodes.builtIn")
                    : ""}
                </small>
              </button>
            ))}
          </nav>
          {node && selected && editing && (
            <form
              class="node-library-detail"
              onSubmit={(event) => {
                event.preventDefault();
                if (!validation && available && !busy) void save();
              }}
            >
              {legacy && (
                <p class="notice">
                  {t(
                    "nodes.thisLegacyNodeIsReadOnlyImport",
                  )}
                </p>
              )}
              <fieldset disabled={legacy}>
                {fragment && (
                  <>
                    <label>
                      {t("nodes.templateName")}
                      <input
                        value={node.label}
                        maxLength={80}
                        onInput={(e) =>
                          setNode({ ...node, label: e.currentTarget.value })}
                      />
                    </label>
                    <p class="muted">
                      {t("nodes.expandsIntoTheseNodesWhenAddedTo")}
                    </p>
                    <label>
                      {t("nodes.templateNodes")}
                      <select
                        value={stepId}
                        onChange={(e) => setStepId(e.currentTarget.value)}
                      >
                        {fragment.nodes.map((n, i) => (
                          <option key={n.id} value={n.id}>
                            {i + 1}. {n.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
                <GraphInspector
                  key={editing.id}
                  node={editing}
                  graph={{
                    version: 2,
                    enabled: false,
                    nodes: fragment?.nodes ?? [node],
                    edges: fragment?.edges ?? [],
                  }}
                  update={update}
                  connect={() => {}}
                  remove={() => {}}
                  libraryMode
                  buffers={buffers}
                  jsonField={(field, value) => {
                    const key = `${editing.id}.${field}`;
                    setBuffers((old) => ({ ...old, [key]: value }));
                    try {
                      update(
                        { ...editing, [field]: JSON.parse(value) } as GraphNode,
                      );
                      setInvalidJson((old) => ({ ...old, [key]: false }));
                    } catch {
                      setInvalidJson((old) => ({ ...old, [key]: true }));
                    }
                  }}
                />
              </fieldset>
              {validation && (
                <p class="inline-error" role="status">
                  {formatMessage(validation, t)}
                </p>
              )}
              {!available && (
                <p class="inline-error">
                  {t("nodes.nodeLibraryStorageIsNotConnected")}
                </p>
              )}
              <div class="graph-actions">
                <button
                  type="submit"
                  class="button button--primary"
                  disabled={legacy || !!validation || !available ||
                    !dirty}
                >
                  {creating ? t("nodes.saveNode") : t("nodes.saveNewVersion")}
                </button>
                {!creating && (
                  <>
                    <button
                      type="button"
                      class="text-button"
                      disabled={legacy || !!validation || !available}
                      onClick={() => save(true)}
                    >
                      {t("nodes.saveAsNewNode")}
                    </button>
                    <button
                      type="button"
                      class="text-button"
                      disabled={!available}
                      onClick={remove}
                    >
                      {t("nodes.deletePreset")}
                    </button>
                  </>
                )}
              </div>
            </form>
          )}
        </div>
      </fieldset>
    </section>
  );
}
