import { useI18n } from "./i18n.tsx";
import { MatchEditor } from "./MatchEditor.tsx";
import { portLabel } from "./graph-ports.ts";
import { ActionEditor } from "./ActionEditor.tsx";
import { TagsInput } from "./TagsInput.tsx";
import { ports } from "../graph/compile.ts";
import { PolicyExpressionEditor } from "./PolicyExpressionEditor.tsx";
import type { GraphEdge, GraphNode, MailGraph } from "../graph/types.ts";
import { graphNodeLabels } from "./GraphCanvas.tsx";
import { GraphConditionEditor } from "./GraphConditionEditor.tsx";

export function GraphInspector(
  {
    node,
    graph,
    update,
    connect,
    remove,
    buffers,
    jsonField,
    libraryMode = false,
  }: {
    libraryMode?: boolean;
    node: GraphNode;
    graph: MailGraph;
    update: (node: GraphNode) => void;
    connect: (port: GraphEdge["port"], to: string) => void;
    remove: () => void;
    buffers: Record<string, string>;
    jsonField: (
      field: "schema" | "inputs" | "value" | "formats",
      value: string,
    ) => void;
  },
) {
  const { t } = useI18n();
  const buffer = (
    field: "schema" | "inputs" | "value" | "formats",
    value: unknown,
  ) => buffers[`${node.id}.${field}`] ?? JSON.stringify(value, null, 2);
  return (
    <aside class="graph-inspector" aria-label={t("graph.nodeEditor")}>
      <div class="graph-inspector-heading">
        <h3>{t(graphNodeLabels[node.kind])}{t("graph.node")}</h3>
        <code>{node.id}</code>
      </div>
      <label>
        {t("graph.name")}
        <input
          value={node.label}
          maxLength={80}
          onInput={(e) => update({ ...node, label: e.currentTarget.value })}
        />
      </label>
      {(node.kind === "action" || node.kind === "finish") && (
        <ActionEditor
          actions={node.actions ?? []}
          change={(actions) => update({ ...node, actions })}
          allowEmpty={node.kind === "finish"}
          graph={graph}
          nodeId={node.id}
        />
      )}
      {(node.kind === "policies" || node.kind === "evaluate" ||
        node.kind === "filter") && (
        <>
          {node.kind === "filter" && (
            <label>
              {t("graph.candidateArray")}
              <input
                value={node.input}
                onInput={(e) =>
                  update({ ...node, input: e.currentTarget.value })}
              />
            </label>
          )}
          <PolicyExpressionEditor
            key={node.id}
            expression={node.policies}
            change={(policies) => update({ ...node, policies })}
            allowItem={node.kind === "filter"}
          />
          <small class="muted">
            {node.kind === "policies"
              ? t(
                "graph.evaluateAllPoliciesBeforeBranchingAFailed",
              )
              : t(
                "graph.returnsSuccessTrueFalseOrNullWhen",
              )}
          </small>
        </>
      )}
      {node.kind === "tokens" && (
        <>
          <label>
            {t("graph.inputFieldsOnePerLine")}
            <textarea
              rows={2}
              value={node.sources.join("\n")}
              onInput={(e) =>
                update({ ...node, sources: e.currentTarget.value.split("\n") })}
            />
          </label>
          <label>
            {t("graph.candidateFormatsJson")}
            <textarea
              rows={8}
              class="code-input"
              value={buffer("formats", node.formats)}
              onInput={(e) => jsonField("formats", e.currentTarget.value)}
            />
          </label>
          <small class="muted">
            {t(
              "graph.charactersDigitsOrMixedMinMaxSet",
            )}
          </small>
          <label>
            {t("graph.contextCharactersBefore")}
            <input
              type="number"
              min={1}
              max={200}
              value={node.contextBefore}
              onInput={(e) =>
                update({
                  ...node,
                  contextBefore: Number(e.currentTarget.value),
                })}
            />
          </label>
          <label>
            {t("graph.contextCharactersAfter")}
            <input
              type="number"
              min={1}
              max={200}
              value={node.contextAfter}
              onInput={(e) =>
                update({
                  ...node,
                  contextAfter: Number(e.currentTarget.value),
                })}
            />
          </label>
          <label class="graph-toggle">
            <input
              type="checkbox"
              checked={node.normalizeContext}
              onChange={(e) =>
                update({ ...node, normalizeContext: e.currentTarget.checked })}
            />
            {t("graph.normalizeContextWhitespaceAndSeparators")}
          </label>
        </>
      )}
      {(node.kind === "output" || node.kind === "apply") && (
        <label>
          {node.kind === "output"
            ? t("graph.candidateArray")
            : t("graph.actionSource")}
          <input
            value={node.input}
            placeholder={node.kind === "apply"
              ? "nodes.policies1.actions"
              : "nodes.filter1.items"}
            onInput={(e) => update({ ...node, input: e.currentTarget.value })}
          />
        </label>
      )}
      {node.kind === "output" && (
        <label>
          {t("graph.maximumOutputCount")}
          <input
            type="number"
            min={1}
            max={3}
            value={node.limit}
            onInput={(e) =>
              update({ ...node, limit: Number(e.currentTarget.value) })}
          />
        </label>
      )}
      {node.kind === "apply" && (
        <p class="muted">
          {t(
            "graph.runActionsFromTheUpstreamGroupThen",
          )}
        </p>
      )}
      {node.kind === "extract" && (
        <p class="muted">
          {t(
            "graph.extractCandidatesNearVerificationHintsInThe",
          )}
        </p>
      )}
      {node.kind === "rules" && (
        <p class="muted">
          {t(
            "graph.runLegacyReceivingRulesFallingBackTo",
          )}
        </p>
      )}
      {node.kind === "finish" && (
        <p class="muted">
          {t(
            "graph.runActionsThenFinishActionsAreOptional",
          )}
        </p>
      )}
      {node.kind === "ai" && (
        <>
          <label>
            System prompt<textarea
              rows={6}
              maxLength={6000}
              value={node.prompt}
              onInput={(e) =>
                update({ ...node, prompt: e.currentTarget.value })}
            />
          </label>
          <label>
            {t("graph.inputMappingJson")}
            <textarea
              class="code-input"
              rows={4}
              value={buffer("inputs", node.inputs)}
              onInput={(e) => jsonField("inputs", e.currentTarget.value)}
            />
          </label>
          <small class="muted">
            {t(
              "graph.pathsEmailSubjectEmailTextEmailCodes",
            )}
          </small>
          <label>
            {t("graph.outputJsonSchema")}
            <textarea
              class="code-input"
              rows={10}
              value={buffer("schema", node.schema)}
              onInput={(e) => jsonField("schema", e.currentTarget.value)}
            />
          </label>
          <small class="muted">
            {t(
              "graph.supportsObjectArrayScalarTypesEnumMaxlength",
            )}
          </small>
          <small class="muted">
            {node.resultFormat
              ? t(
                "graph.returnsSuccessDataAndErrorIfCan",
              )
              : t(
                "graph.legacyAiOutputFormatIsPreservedNew",
              )}
          </small>
          {!node.resultFormat &&
            (node.onlyWhenMissingCodes || node.optional || node.outputMode) && (
            <details>
              <summary>{t("graph.legacyExecutionSettings")}</summary>
              <ul class="muted">
                {node.onlyWhenMissingCodes && (
                  <li>{t("graph.callOnlyWhenNoVerificationCodeHas")}</li>
                )}
                {node.optional && (
                  <li>{t("graph.skipWhenAiIsOffContinueOn")}</li>
                )}
                {node.outputMode && (
                  <li>{t("graph.writeVerificationCodesAfterValidation")}</li>
                )}
              </ul>
              <small class="muted">
                {t("graph.existingBehaviorIsPreservedNewWorkflowsUse")}
              </small>
            </details>
          )}
          <details>
            <summary>{t("graph.executionOptimization")}</summary>
            <label>
              {t("graph.aiBatchGroup")}
              <input
                value={node.batchGroup}
                maxLength={40}
                placeholder={t("graph.leaveBlankForSeparateRequests")}
                onInput={(e) =>
                  update({ ...node, batchGroup: e.currentTarget.value })}
              />
            </label>
            <small class="muted">
              {t(
                "graph.adjacentIndependentTasksInTheSameGroup",
              )}
            </small>
          </details>
        </>
      )}
      {node.kind === "match" && <MatchEditor node={node} update={update} />}
      {node.kind === "condition" && (
        <GraphConditionEditor
          condition={node.condition ??
            { path: node.path, operator: node.operator, value: node.value }}
          change={(condition) => update({ ...node, condition })}
        />
      )}
      {node.kind === "delivery" && (
        <>
          <label>
            {t("graph.mailHandling")}
            <select
              value={node.action}
              onChange={(e) =>
                update({
                  ...node,
                  action: e.currentTarget.value as typeof node.action,
                })}
            >
              <option value="keep">{t("graph.keep")}</option>
              <option value="forward">
                {t("graph.forwardOriginalAndKeep")}
              </option>
              <option value="trash">{t("graph.moveToTrash")}</option>
            </select>
          </label>
          {node.action === "forward" && (
            <label>
              {t("actions.forwardTo")}
              <input
                type="email"
                value={node.forwardTo}
                onInput={(e) =>
                  update({ ...node, forwardTo: e.currentTarget.value })}
              />
              <small class="muted">
                {t("graph.useADestinationAlreadyVerifiedInCloudflare")}
              </small>
            </label>
          )}
          <label>
            {t("actions.tagsCommaSeparated")}
            <TagsInput
              value={node.tags}
              onChange={(tags) => update({ ...node, tags })}
            />
          </label>
          <label>
            {t("actions.retentionDays")}
            <input
              type="number"
              min={1}
              max={3650}
              value={node.retentionDays ?? ""}
              placeholder={t("graph.useAddressDefault")}
              onInput={(e) =>
                update({
                  ...node,
                  retentionDays: e.currentTarget.value
                    ? Number(e.currentTarget.value)
                    : undefined,
                })}
            />
          </label>
        </>
      )}
      {!libraryMode && ports(node).map((port) => (
        <label key={port}>
          {portLabel(node, port, t)} →
          <select
            aria-label={t("graph.nextStepFor", {
              name: portLabel(node, port, t),
            })}
            value={graph.edges.find((e) =>
              e.from === node.id && e.port === port
            )?.to ?? ""}
            onChange={(e) => connect(port, e.currentTarget.value)}
          >
            <option value="">{t("graph.selectNode")}</option>
            {graph.nodes.filter((n) => n.id !== node.id && n.kind !== "entry")
              .map((n) => (
                <option value={n.id} key={n.id}>{n.label} · {n.id}</option>
              ))}
          </select>
        </label>
      ))}
      {!libraryMode && node.kind !== "entry" && (
        <button type="button" class="text-button" onClick={remove}>
          {t("graph.deleteNode")}
        </button>
      )}
    </aside>
  );
}
