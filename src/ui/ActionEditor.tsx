import { mailActionKeys } from "./labels.ts";
import { useI18n } from "./i18n.tsx";
import { actionField, isBinding } from "../graph/actions.ts";
import { outputSchema } from "../graph/compile.ts";
import type { JsonSchema } from "../graph/schema.ts";
import type {
  ActionBinding,
  GraphNode,
  JsonValue,
  MailAction,
  MailGraph,
} from "../graph/types.ts";
import { TagsInput } from "./TagsInput.tsx";

function outputPaths(node: GraphNode, prefix: string): string[] {
  const schema = outputSchema(node);
  if (schema?.type !== "object") return [];
  const walk = (schema: JsonSchema | undefined, path: string): string[] =>
    schema?.type === "object"
      ? Object.entries(schema.properties ?? {}).flatMap(([key, child]) =>
        walk(
          child,
          `${path}${
            node.kind === "ai" && node.resultFormat &&
              (path === `${prefix}.data` || path === `${prefix}.error`)
              ? "?."
              : "."
          }${key}`,
        )
      )
      : [path];
  return walk(schema, prefix);
}

export const newAction = (type: MailAction["type"]): MailAction => {
  switch (type) {
    case "tag":
      return { type, tags: [] };
    case "set_retention":
      return { type, days: 7 };
    case "forward":
      return { type, to: "" };
    case "reply":
      return { type, text: "" };
    case "deny":
      return { type, reason: "Message rejected by policy" };
    default:
      return { type };
  }
};
export function ActionEditor(
  { actions, change, graph, nodeId, allowEmpty = false }: {
    actions: MailAction[];
    change: (actions: MailAction[]) => void;
    graph: MailGraph;
    nodeId: string;
    allowEmpty?: boolean;
  },
) {
  const { t } = useI18n();
  const ancestors = new Set<string>();
  const visit = (id: string) =>
    graph.edges.filter((e) => e.to === id).forEach((e) => {
      if (ancestors.has(e.from)) return;
      ancestors.add(e.from);
      visit(e.from);
    });
  visit(nodeId);
  const paths = [
    "email.from",
    "email.to",
    "email.subject",
    ...graph.nodes.filter((n) => ancestors.has(n.id)).flatMap((n) =>
      outputPaths(n, `nodes.${n.id}`)
    ),
  ];
  const parents = graph.edges.filter((e) => e.to === nodeId).map((e) => e.from);
  for (const node of graph.nodes.filter((n) => parents.includes(n.id))) {
    paths.push(
      ...outputPaths(node, "current.parent"),
    );
  }
  const edit = (index: number, action: MailAction) =>
    change(actions.map((a, i) => i === index ? action : a));
  const move = (index: number, delta: number) => {
    const next = [...actions];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    change(next);
  };
  return (
    <>
      <ol class="action-chain">
        {actions.map((action, index) => {
          const field = actionField(action);
          const value = field
            ? (action as unknown as Record<string, JsonValue | ActionBinding>)[
              field
            ]
            : null;
          const binding = isBinding(value) ? value : undefined;
          const set = (value: unknown) =>
            edit(index, { ...action, [field!]: value } as MailAction);
          const input = (value: unknown, update: (value: JsonValue) => void) =>
            action.type === "reply"
              ? (
                <textarea
                  rows={5}
                  maxLength={12000}
                  value={typeof value === "string" ? value : ""}
                  onInput={(e) => update(e.currentTarget.value)}
                />
              )
              : action.type === "tag"
              ? (
                <TagsInput
                  value={Array.isArray(value) ? value as string[] : []}
                  onChange={update}
                />
              )
              : (
                <input
                  type={action.type === "set_retention" ||
                      action.type === "keep"
                    ? "number"
                    : action.type === "forward"
                    ? "email"
                    : "text"}
                  min={1}
                  max={3650}
                  value={typeof value === "string" || typeof value === "number"
                    ? value
                    : ""}
                  onInput={(e) =>
                    update(
                      action.type === "set_retention" || action.type === "keep"
                        ? Number(e.currentTarget.value)
                        : e.currentTarget.value,
                    )}
                />
              );
          return (
            <li key={index}>
              <label>
                {t("actions.number")}
                {index + 1}
                <select
                  value={action.type}
                  onChange={(e) =>
                    edit(
                      index,
                      newAction(e.currentTarget.value as MailAction["type"]),
                    )}
                >
                  {Object.entries(mailActionKeys).filter(([type]) =>
                    type !== "set_retention" || action.type === "set_retention"
                  ).map(([type, label]) => (
                    <option value={type}>{t(label)}</option>
                  ))}
                </select>
              </label>
              {field && (
                <>
                  <label>
                    {action.type === "keep"
                      ? t("actions.retention")
                      : t("actions.valueSource")}
                    <select
                      value={action.type === "keep" && value === undefined
                        ? "default"
                        : binding
                        ? "reference"
                        : "literal"}
                      onChange={(e) => {
                        if (e.currentTarget.value === "default") {
                          edit(index, { type: "keep" });
                          return;
                        }
                        set(
                          e.currentTarget.value === "reference"
                            ? { ref: paths[0] ?? "email.subject" }
                            : action.type === "keep"
                            ? 7
                            : (newAction(action.type) as unknown as Record<
                              string,
                              unknown
                            >)[field],
                        );
                      }}
                    >
                      {action.type === "keep" && (
                        <option value="default">
                          {t("actions.useDefault")}
                        </option>
                      )}
                      <option value="literal">{t("actions.fixedValue")}</option>
                      <option value="reference">
                        {t("actions.upstreamOutput")}
                      </option>
                    </select>
                  </label>
                  {binding
                    ? (
                      <>
                        <label>
                          {t("actions.outputField")}
                          <input
                            list={`action-paths-${nodeId}-${index}`}
                            value={binding.ref}
                            onInput={(e) =>
                              set({ ...binding, ref: e.currentTarget.value })}
                          />
                        </label>
                        <datalist id={`action-paths-${nodeId}-${index}`}>
                          {[...new Set(paths)].map((path) => (
                            <option value={path} />
                          ))}
                        </datalist>
                        <label class="checkbox-label">
                          <input
                            type="checkbox"
                            checked={binding.ref.includes("?.")}
                            onChange={(e) => {
                              const parts = binding.ref.replaceAll("?.", ".")
                                .split(".");
                              set({
                                ...binding,
                                ref: e.currentTarget.checked
                                  ? parts.map((part, i) =>
                                    i === Math.min(2, parts.length - 1)
                                      ? `?.${part}`
                                      : `${i ? "." : ""}${part}`
                                  ).join("")
                                  : parts.join("."),
                              });
                            }}
                          />
                          {t("actions.allowMissingValue")}
                        </label>
                        {binding.ref.includes("?.") && (
                          <label>
                            {t("actions.fallbackValue")}
                            {input(
                              binding.fallback,
                              (fallback) => set({ ...binding, fallback }),
                            )}
                          </label>
                        )}
                      </>
                    )
                    : action.type === "keep" && value === undefined
                    ? null
                    : (
                      <label>
                        {action.type === "tag"
                          ? t("actions.tagsCommaSeparated")
                          : action.type === "set_retention" ||
                              action.type === "keep"
                          ? t("actions.retentionDays")
                          : action.type === "forward"
                          ? t("actions.forwardTo")
                          : action.type === "reply"
                          ? t("actions.replyBody")
                          : t("actions.rejectionReason")}
                        {input(value, set)}
                      </label>
                    )}
                </>
              )}
              {action.type === "reply" && (
                <small class="muted">
                  {t("actions.replyToTheOriginalSenderUsingThe")}
                </small>
              )}
              <div class="graph-actions">
                <button
                  type="button"
                  class="text-button"
                  disabled={index === 0}
                  aria-label={t("actions.moveActionUp", { index: index + 1 })}
                  onClick={() => move(index, -1)}
                >
                  {t("actions.moveUp")}
                </button>
                <button
                  type="button"
                  class="text-button"
                  disabled={index === actions.length - 1}
                  aria-label={t("actions.moveActionDown", { index: index + 1 })}
                  onClick={() => move(index, 1)}
                >
                  {t("actions.moveDown")}
                </button>
                <button
                  type="button"
                  class="text-button"
                  disabled={!allowEmpty && actions.length === 1}
                  onClick={() => change(actions.filter((_, i) => i !== index))}
                >
                  {t("actions.removeAction")}
                </button>
              </div>
            </li>
          );
        })}
      </ol>
      <button
        type="button"
        class="text-button"
        disabled={actions.length >= 16 || actions.at(-1)?.type === "deny"}
        onClick={() => change([...actions, newAction("tag")])}
      >
        {t("actions.addAction")}
      </button>
    </>
  );
}
