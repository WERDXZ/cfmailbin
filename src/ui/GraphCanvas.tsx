import type { TranslationKey } from "./translate.ts";
import { useI18n } from "./i18n.tsx";
import { useRef, useState } from "preact/hooks";
import { ports } from "../graph/compile.ts";
import { portLabel } from "./graph-ports.ts";
import type { GraphNode, MailGraph } from "../graph/types.ts";

export const graphNodeLabels: Record<GraphNode["kind"], TranslationKey> = {
  action: "graph.actions",
  policies: "conditions.policyGroup",
  evaluate: "graph.policyEvaluation",
  tokens: "graph.candidateExtraction",
  filter: "graph.policyFilter",
  output: "graph.verificationCodeOutput",
  apply: "graph.runActions",
  entry: "graph.entry",
  extract: "graph.localExtraction",
  rules: "graph.receivingRules",
  finish: "graph.finish",
  ai: "graph.kind.ai",
  condition: "graph.kind.condition",
  match: "graph.kind.match",
  delivery: "graph.disposition",
};
export function GraphCanvas({ graph, selected, select, move, disabled }: {
  graph: MailGraph;
  selected: string;
  select: (id: string) => void;
  move: (id: string, x: number, y: number) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const [zoom, setZoom] = useState(1);
  const drag = useRef<
    { id: string; x: number; y: number; startX: number; startY: number } | null
  >(null);
  const width = Math.max(700, ...graph.nodes.map((n) => n.x + 280));
  const height = Math.max(500, ...graph.nodes.map((n) => n.y + 160));
  function description(n: GraphNode) {
    return n.kind === "action"
      ? t("graph.actionCount", { count: n.actions.length })
      : n.kind === "policies"
      ? "AND / OR / NOT → success / failed"
      : n.kind === "evaluate"
      ? t("graph.evaluateAPolicyGroup")
      : n.kind === "tokens"
      ? t("graph.extractCandidatesAndContextByFormat")
      : n.kind === "filter"
      ? t("graph.evaluateMultipleIndependentPolicies")
      : n.kind === "output"
      ? t("graph.keepVerificationCodesThatAppearInThe")
      : n.kind === "apply"
      ? t("graph.runActionsFromPassedPolicies")
      : n.kind === "ai"
      ? n.batchGroup
        ? t("graph.batchGroup", { group: n.batchGroup })
        : t("graph.structuredOutput")
      : n.kind === "condition"
      ? n.condition ? t("graph.conditionGroupAndOrNot") : n.path
      : n.kind === "match"
      ? t("graph.matchBranchesDefaultUnknown", { count: n.cases.length })
      : n.kind === "delivery"
      ? {
        keep: t("graph.keepEmail"),
        forward: t("graph.forwardOriginalAndKeep"),
        trash: t("graph.moveToTrash"),
      }[n.action]
      : n.kind === "extract"
      ? t("graph.verificationCodesNoAiCalls")
      : n.kind === "rules"
      ? t("graph.processMailWithExistingRules")
      : n.kind === "finish"
      ? n.actions?.length
        ? t("graph.finishActionCount", { count: n.actions.length })
        : t("graph.rejectIfNoActionAcceptsTheEmail")
      : t("graph.newIncomingEmail");
  }
  return (
    <div class="graph-workspace">
      <div class="graph-canvas-tools">
        <span class="muted">{t("graph.canvasHint")}</span>
        <label>
          {t("graph.zoom")}
          <select
            aria-label={t("graph.canvasZoom")}
            value={zoom}
            onChange={(e) => setZoom(Number(e.currentTarget.value))}
          >
            <option value={0.5}>50%</option>
            <option value={0.75}>75%</option>
            <option value={1}>100%</option>
          </select>
        </label>
      </div>
      <div
        class="graph-viewport"
        aria-label={t("graph.mailWorkflowGraph")}
        tabIndex={0}
      >
        <div style={{ width: width * zoom, height: height * zoom }}>
          <div
            class="graph-stage"
            style={{ width, height, transform: `scale(${zoom})` }}
          >
            <svg
              width={width}
              height={height}
              class="graph-edges"
              aria-hidden="true"
            >
              <defs>
                <marker
                  id="graph-arrow"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                </marker>
              </defs>
              {graph.edges.map((edge) => {
                const from = graph.nodes.find((n) => n.id === edge.from),
                  to = graph.nodes.find((n) => n.id === edge.to);
                if (!from || !to) return null;
                const outgoing = ports(from);
                const x = from.x +
                    220 * (outgoing.indexOf(edge.port) + 1) /
                      (outgoing.length + 1),
                  y = from.y + 104;
                const tx = to.x + 110, ty = to.y;
                return (
                  <g
                    key={`${edge.from}-${edge.port}`}
                    class={selected === edge.from || selected === edge.to
                      ? "is-selected"
                      : ""}
                  >
                    <path
                      d={`M ${x} ${y} C ${x} ${y + 55}, ${tx} ${
                        ty - 55
                      }, ${tx} ${ty}`}
                      marker-end="url(#graph-arrow)"
                    />
                    {edge.port !== "next" && (
                      <text x={x + 8} y={y + 25}>
                        {portLabel(from, edge.port, t)}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
            {graph.nodes.map((node) => (
              <button
                key={node.id}
                type="button"
                disabled={disabled}
                class={`graph-node ${
                  selected === node.id ? "is-selected" : ""
                }`}
                style={{ left: node.x, top: node.y }}
                aria-label={`${t(graphNodeLabels[node.kind])}：${node.label}`}
                aria-pressed={selected === node.id}
                onClick={() => select(node.id)}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  select(node.id);
                  drag.current = {
                    id: node.id,
                    x: node.x,
                    y: node.y,
                    startX: e.clientX,
                    startY: e.clientY,
                  };
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  const d = drag.current;
                  if (d?.id === node.id) {
                    move(
                      node.id,
                      Math.max(
                        0,
                        Math.min(
                          5000,
                          Math.round(d.x + (e.clientX - d.startX) / zoom),
                        ),
                      ),
                      Math.max(
                        0,
                        Math.min(
                          5000,
                          Math.round(d.y + (e.clientY - d.startY) / zoom),
                        ),
                      ),
                    );
                  }
                }}
                onPointerUp={() => {
                  drag.current = null;
                }}
                onPointerCancel={() => {
                  drag.current = null;
                }}
                onKeyDown={(e) => {
                  const delta = {
                    ArrowLeft: [-20, 0],
                    ArrowRight: [20, 0],
                    ArrowUp: [0, -20],
                    ArrowDown: [0, 20],
                  }[e.key];
                  if (delta) {
                    e.preventDefault();
                    move(
                      node.id,
                      Math.max(0, Math.min(5000, node.x + delta[0])),
                      Math.max(0, Math.min(5000, node.y + delta[1])),
                    );
                  }
                }}
              >
                <span class="graph-node-kind">
                  {t(graphNodeLabels[node.kind])}
                </span>
                <strong>{node.label || node.id}</strong>
                <span class="graph-node-description">{description(node)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
