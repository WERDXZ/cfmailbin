import {
  type DisplayMessage,
  formatMessage,
  localizedMessage,
} from "./messages.ts";
import { useI18n } from "./i18n.tsx";
import { useEffect, useMemo, useState } from "preact/hooks";
import "./graph.css";
import { insertFragment } from "../graph/fragments.ts";
import { compileGraph, parseGraph, ports } from "../graph/compile.ts";
import { localizedGraphTemplate, localizedPreset } from "./templates.ts";
import { builtInPresets, usePreset } from "../graph/library.ts";
import type { NodePreset } from "../graph/types.ts";
import type { GraphNode, GraphRun, MailGraph } from "../graph/types.ts";
import { api, type GraphResponse } from "./api.ts";
import { GraphCanvas } from "./GraphCanvas.tsx";
import { GraphInspector } from "./GraphInspector.tsx";
import { GraphTrace } from "./GraphTrace.tsx";
import type { MessageRecord } from "./types.ts";
import { useUnsavedChanges } from "./useUnsavedChanges.ts";
import { TemplatePicker } from "./TemplatePicker.tsx";
import { type NodeDraft, NodePicker } from "./NodePicker.tsx";

export function GraphEditor() {
  const { t } = useI18n();
  const [presets, setPresets] = useState<NodePreset[]>(builtInPresets);
  const [draft, setDraft] = useState<MailGraph | null>(null);
  const [saved, setSaved] = useState<GraphResponse | null>(null);
  const [selected, setSelected] = useState("start");
  const [buffers, setBuffers] = useState<Record<string, string>>({});
  const [bufferErrors, setBufferErrors] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<DisplayMessage>("");
  const [notice, setNotice] = useState<DisplayMessage>("");
  const [migrationWarnings, setMigrationWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [trial, setTrial] = useState<GraphRun | null>(null);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [messageId, setMessageId] = useState("");
  const [subject, setSubject] = useState("Test verification code");
  const [text, setText] = useState("Your verification code is 123456.");
  const dirty = !!draft &&
    (JSON.stringify(draft) !== JSON.stringify(saved?.graph) ||
      Object.keys(bufferErrors).length > 0);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api.getGraph(controller.signal).then((value) => {
      if (!controller.signal.aborted) {
        setSaved(value);
        setDraft(value.graph);
        setSelected(value.graph?.nodes[0].id ?? "start");
      }
    }).catch((e) => {
      if (!controller.signal.aborted) setError(e);
    });
    api.getNodeLibrary(controller.signal).then((value) => {
      if (!controller.signal.aborted) {
        const choices = [...value.presets, ...value.templates];
        setPresets(choices);
      }
    }).catch((e) => {
      if (!controller.signal.aborted) setError(e);
    });
    api.listMessages({}, controller.signal).then((value) => {
      if (!controller.signal.aborted) setMessages(value);
    }).catch(() => {});
    return () => controller.abort();
  }, [attempt]);
  useUnsavedChanges(dirty, t("graph.thisWorkflowHasUnsavedChangesDiscardThem"));
  const validation = useMemo(() => {
    if (!draft) return { error: "", plan: null };
    if (Object.keys(bufferErrors).length) {
      return {
        error: localizedMessage("errors.invalidJsonInTheInputMappingSchema"),
        plan: null,
      };
    }
    try {
      return { error: "", plan: compileGraph(parseGraph(draft)) };
    } catch (e) {
      return { error: e as Error, plan: null };
    }
  }, [draft, bufferErrors]);
  function change(next: MailGraph) {
    setDraft(next);
    setNotice("");
    setTrial(null);
  }
  function update(node: GraphNode) {
    if (!draft) return;
    change({
      ...draft,
      nodes: draft.nodes.map((n) => n.id === node.id ? node : n),
      edges: draft.edges.filter((e) =>
        e.from !== node.id || ports(node).includes(e.port)
      ),
    });
  }
  function template(kind: "blank" | "classification" | "verification") {
    if (dirty && !confirm(t("graph.replaceTheCurrentUnsavedWorkflow"))) {
      return false;
    }
    change(localizedGraphTemplate(kind, t));
    setMigrationWarnings([]);
    setSelected("start");
    setBuffers({});
    setBufferErrors({});
  }
  async function migrate(source: "rules" | "graph") {
    if (dirty && !confirm(t("graph.replaceTheCurrentUnsavedWorkflow"))) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.migrateGraph(source);
      change({ ...result.graph, enabled: false });
      setSelected(result.graph.nodes[0].id);
      setBuffers({});
      setBufferErrors({});
      setMigrationWarnings(result.warnings);
      setNotice(
        localizedMessage("graph.migrationDraftLoadedButNotSavedOr"),
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught
          : localizedMessage("graph.migrationFailed"),
      );
    } finally {
      setBusy(false);
    }
  }
  function add(choice: NodeDraft) {
    if (!draft || draft.nodes.length >= 32) return false;
    if (choice.fragment) {
      try {
        const next = insertFragment(draft, choice.fragment, selected);
        change(next);
        setSelected(
          next.nodes.find((n) => !draft.nodes.some((old) => old.id === n.id))!
            .id,
        );
      } catch (e) {
        setError(e as Error);
      }
      return;
    }
    const kind = choice.node.kind;
    let index = 1;
    while (draft.nodes.some((n) => n.id === `${kind}${index}`)) index++;
    const anchor = draft.nodes.find((n) => n.id === selected) ?? draft.nodes[0];
    const outgoing = draft.edges.find((edge) =>
      edge.from === anchor.id && edge.port === "next"
    );
    const node: GraphNode = {
      ...choice.node,
      id: `${kind}${index}`,
      x: Math.min(4600, anchor.x + (outgoing ? 0 : 280)),
      y: Math.min(4800, anchor.y + 180),
    };
    if (node.kind === "condition") node.unknown = true;
    let edges = [...draft.edges];
    if (outgoing) {
      edges = edges.map((e) => e === outgoing ? { ...e, to: node.id } : e);
      for (const port of ports(node)) {
        edges.push({ from: node.id, to: outgoing.to, port });
      }
    }
    const downstream = new Set<string>();
    const pending = outgoing ? [outgoing.to] : [];
    while (pending.length) {
      const id = pending.pop()!;
      if (downstream.has(id)) continue;
      downstream.add(id);
      pending.push(
        ...draft.edges.filter((edge) => edge.from === id).map((edge) =>
          edge.to
        ),
      );
    }
    change({
      ...draft,
      nodes: [
        ...draft.nodes.map((existing) =>
          downstream.has(existing.id)
            ? { ...existing, y: Math.min(5000, existing.y + 180) }
            : existing
        ),
        node,
      ],
      edges,
    });
    setSelected(node.id);
  }
  function layout() {
    if (!draft || !validation.plan) return;
    const levels = new Map<string, number>();
    for (const id of validation.plan.order) {
      levels.set(
        id,
        Math.max(
          0,
          ...draft.edges.filter((e) => e.to === id).map((e) =>
            (levels.get(e.from) ?? -1) + 1
          ),
        ),
      );
    }
    const offsets = new Map<number, number>();
    change({
      ...draft,
      nodes: draft.nodes.map((n) => {
        const level = levels.get(n.id) ?? 0;
        const offset = offsets.get(level) ?? 0;
        offsets.set(level, offset + 1);
        return {
          ...n,
          x: 40 + offset * 270,
          y: Math.min(4800, 40 + level * 170),
        };
      }),
    });
  }
  async function save() {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      const value = await api.saveGraph(draft);
      setSaved(value);
      setDraft(value.graph);
      setNotice(
        value.storage === "kv"
          ? localizedMessage("graph.savedAppliesToNewMailWithinAbout")
          : localizedMessage("graph.savedInLocalMemoryResetsWhenThe"),
      );
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  async function preview() {
    if (!draft) return;
    setBusy(true);
    setError("");
    setTrial(null);
    try {
      setTrial(
        await api.previewGraph(
          draft,
          messageId ? { messageId } : { sample: { subject, text } },
        ),
      );
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  const migrationControls = (saved?.legacy.graph || saved?.legacy.rules)
    ? (
      <div class="graph-migration">
        <p class="muted">
          {t("graph.legacyConfigurationIsOnlyAMigrationSource")}
        </p>
        <div class="graph-actions">
          {saved.legacy.rules > 0 && (
            <button
              type="button"
              class="button"
              onClick={() => migrate("rules")}
            >
              {t("graph.importLegacyReceivingRules", {
                count: saved.legacy.rules,
              })}
            </button>
          )}
          {saved.legacy.graph && (
            <button
              type="button"
              class="button"
              onClick={() => migrate("graph")}
            >
              {t("graph.importLegacyWorkflow")}
            </button>
          )}
        </div>
      </div>
    )
    : null;
  const templatePicker = (
    <TemplatePicker
      label={t("graph.newWorkflow")}
      actionLabel={t("graph.createWorkflow")}
      blank={{
        id: "blank",
        label: t("graph.blankWorkflow"),
        description: t("graph.startWithEntryAndFinishNodesThen"),
      }}
      options={[
        {
          id: "verification",
          label: t("graph.verificationMail"),
          description: t("graph.extractCodesKeepMailAndUseAi"),
        },
        {
          id: "classification",
          label: t("graph.aiClassification"),
          description: t("graph.routeMailUsingAiClassificationResults"),
        },
      ]}
      create={(kind) =>
        template(kind as "blank" | "verification" | "classification")}
    />
  );
  if (!draft) {
    return (
      <section class="graph-editor">
        <h2>{t("graph.receivingWorkflow")}</h2>
        {error && (
          <p class="inline-error" role="alert">
            {formatMessage(error, t)}{" "}
            <button
              type="button"
              class="text-button"
              onClick={() => setAttempt(attempt + 1)}
            >
              {t("common.retry")}
            </button>
          </p>
        )}
        {saved
          ? (
            <>
              <p class="muted">
                {t("graph.noReceivingWorkflowYetIncomingMailIs")}
              </p>
              <fieldset disabled={busy}>
                {templatePicker}
                {migrationControls}
              </fieldset>
            </>
          )
          : !error && <p role="status">{t("graph.loadingWorkflow")}</p>}
      </section>
    );
  }
  const node = draft.nodes.find((n) => n.id === selected) ?? draft.nodes[0];
  const plan = validation.plan;
  const source = presets.find((p) => p.id === node.preset?.id);
  async function savePreset() {
    setBusy(true);
    setError("");
    try {
      const preset = await api.saveNodePreset(
        `node_${crypto.randomUUID()}`,
        node,
      );
      setPresets([...presets, preset]);
      update(usePreset(preset, node));
      setNotice(localizedMessage("graph.savedToTheNodeLibrarySaveThe"));
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section class="graph-editor">
      {saved?.storage === "unavailable" && (
        <p class="inline-error">
          {t("graph.workflowStorageIsNotConnectedOnlyTrial")}
        </p>
      )}
      <div class="settings-section-heading">
        <h2>{t("graph.receivingWorkflow")}</h2>
        <p class="muted">
          {t(
            "graph.policiesReturnResultsIfMatchSelectsBranches",
          )}
        </p>
      </div>
      {error && (
        <p class="notice notice--error" role="alert">
          {formatMessage(error, t)}
        </p>
      )}
      {notice && <p class="notice" role="status">{formatMessage(notice, t)}</p>}
      <fieldset disabled={busy}>
        {migrationControls}
        {migrationWarnings.length > 0 && (
          <div class="notice" role="status">
            <p>{t("graph.migrationNotes")}</p>
            <ul>
              {migrationWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        )}
        <div class="graph-toolbar">
          <label class="graph-toggle">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) =>
                change({ ...draft, enabled: e.currentTarget.checked })}
            />
            {t("graph.useThisWorkflow")}
          </label>
          <div class="graph-actions">
            {templatePicker}
            <button
              type="button"
              class="button button--primary"
              disabled={!dirty || !!validation.error ||
                saved?.storage === "unavailable"}
              onClick={save}
            >
              {busy ? t("graph.processing") : t("graph.saveWorkflow")}
            </button>
          </div>
        </div>
        <div class="graph-toolbar">
          <div class="graph-actions">
            <NodePicker
              label={t("graph.addNode")}
              presets={presets}
              create={add}
              disabled={draft.nodes.length >= 32}
            />
          </div>
          <button
            type="button"
            class="text-button"
            disabled={!plan}
            onClick={layout}
          >
            {t("graph.autoArrange")}
          </button>
        </div>
        <p class="muted" role="status">
          {saved?.graph?.enabled && saved.graph.version === 2
            ? t("graph.theSavedWorkflowIsEnabledDraftChanges")
            : t("graph.incomingMailIsRejectedByDefaultReview")}
        </p>
        {validation.error && (
          <p class="inline-error" role="status">
            {formatMessage(validation.error ?? "", t)}
          </p>
        )}
        <div class="graph-layout">
          <GraphCanvas
            graph={draft}
            selected={node.id}
            select={setSelected}
            move={(id, x, y) => {
              const moving = draft.nodes.find((n) => n.id === id)!;
              update({ ...moving, x, y });
            }}
            disabled={busy}
          />
          <div class="graph-node-panel">
            {node.kind !== "entry" && (
              <div class="graph-preset-actions">
                <button
                  type="button"
                  class="text-button"
                  disabled={!!validation.error}
                  onClick={savePreset}
                >
                  {t("graph.saveToNodeLibrary")}
                </button>
                {source && (
                  <small class="muted">
                    {t("graph.from")}
                    {source.node.label} · {node.preset?.revision.slice(0, 8)}
                  </small>
                )}
                {source && !source.fragment &&
                  source.revision !== node.preset?.revision && (
                  <button
                    type="button"
                    class="text-button"
                    onClick={() => {
                      update(usePreset(localizedPreset(source, t), node));
                      setBuffers({});
                      setBufferErrors({});
                    }}
                  >
                    {t("graph.applyUpdatedLibraryVersion")}
                  </button>
                )}
              </div>
            )}
            <GraphInspector
              node={node}
              graph={draft}
              update={update}
              buffers={buffers}
              jsonField={(field, value) => {
                const key = `${node.id}.${field}`;
                setBuffers((old) => ({ ...old, [key]: value }));
                try {
                  const parsed = JSON.parse(value);
                  update({ ...node, [field]: parsed } as GraphNode);
                  setBufferErrors((old) => {
                    const next = { ...old };
                    delete next[key];
                    return next;
                  });
                } catch {
                  setBufferErrors((old) => ({ ...old, [key]: true }));
                }
              }}
              connect={(port, to) =>
                change({
                  ...draft,
                  edges: [
                    ...draft.edges.filter((e) =>
                      !(e.from === node.id && e.port === port)
                    ),
                    ...(to ? [{ from: node.id, to, port }] : []),
                  ],
                })}
              remove={() => {
                const next = draft.edges.find((e) =>
                  e.from === node.id && e.port === "next"
                )?.to;
                change({
                  ...draft,
                  nodes: draft.nodes.filter((n) => n.id !== node.id),
                  edges: draft.edges.filter((e) =>
                    e.from !== node.id && (e.to !== node.id || next)
                  ).map((e) => e.to === node.id ? { ...e, to: next! } : e),
                });
                setBufferErrors((old) =>
                  Object.fromEntries(
                    Object.entries(old).filter(([key]) =>
                      !key.startsWith(`${node.id}.`)
                    ),
                  )
                );
                setSelected("start");
              }}
            />
          </div>
        </div>
        <details class="graph-plan" open>
          <summary>{t("graph.executionPlanOptimizer")}</summary>
          {plan
            ? (
              <>
                <p class="muted">
                  {t(
                    "graph.optimizerSummary",
                    {
                      nodeCount: plan.order.length,
                      savedRequests: plan.batches.reduce(
                        (sum, batch) => sum + batch.length - 1,
                        0,
                      ),
                    },
                  )}
                </p>
                <div class="graph-plan-steps">
                  {plan.order.filter((id) =>
                    !plan.batches.some((batch) => batch.slice(1).includes(id))
                  ).map((id) => (
                    <span key={id}>
                      {(plan.batches.find((batch) => batch[0] === id) ?? [id])
                        .map((member) =>
                          draft.nodes.find((n) => n.id === member)?.label
                        ).join(" ＋ ")}
                    </span>
                  ))}
                </div>
                {plan.unreachable.length > 0 && (
                  <p class="muted">
                    {t("graph.skipUnreachableNodes")}
                    {plan.unreachable.join(", ")}
                  </p>
                )}
                {plan.notes.map((note) => <p class="muted" key={note}>{note}
                </p>)}
              </>
            )
            : (
              <p class="muted">
                {t("graph.fixTheConfigurationToViewTheExecution")}
              </p>
            )}
        </details>
        <details class="graph-trial">
          <summary>{t("graph.trialRun")}</summary>
          <label>
            {t("graph.inputEmail")}
            <select
              value={messageId}
              onChange={(e) => setMessageId(e.currentTarget.value)}
            >
              <option value="">{t("graph.enterTestContent")}</option>
              {messages.map((message) => (
                <option value={message.id} key={message.id}>
                  {message.subject || t("inbox.noSubject")} ·{" "}
                  {message.aliasAddress}
                </option>
              ))}
            </select>
          </label>
          {!messageId && (
            <>
              <label>
                {t("graph.testSubject")}
                <input
                  value={subject}
                  maxLength={500}
                  onInput={(e) => setSubject(e.currentTarget.value)}
                />
              </label>
              <label>
                {t("graph.testBody")}
                <textarea
                  rows={4}
                  value={text}
                  maxLength={12000}
                  onInput={(e) => setText(e.currentTarget.value)}
                />
              </label>
            </>
          )}
          <p class="muted">
            {t("graph.aiNodesUseTheSharedQuotaForward")}
          </p>
          <button
            type="button"
            class="button"
            disabled={!!validation.error}
            onClick={preview}
          >
            {busy ? t("graph.runningTrial") : t("graph.runDraft")}
          </button>
        </details>
      </fieldset>
      {trial && <GraphTrace run={trial} />}
      {dirty && <p class="muted" role="status">{t("graph.unsavedChanges")}</p>}
    </section>
  );
}
