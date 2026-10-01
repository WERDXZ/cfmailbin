import { useI18n } from "./i18n.tsx";
import type { GraphCondition } from "../graph/types.ts";
import { BooleanTreeEditor } from "./BooleanTreeEditor.tsx";

type Leaf = Extract<GraphCondition, { path: string }>;
const leaf = (): Leaf => ({
  path: "email.subject",
  operator: "contains",
  value: "",
});

export function GraphConditionEditor({ condition, change }: {
  condition: GraphCondition;
  change: (condition: GraphCondition) => void;
}) {
  const { t } = useI18n();
  return (
    <BooleanTreeEditor<Leaf>
      tree={condition}
      change={change}
      createLeaf={leaf}
      maxDepth={5}
      maxNodes={32}
      maxChildren={16}
      renderLeaf={(node, update) => (
        <div class="graph-condition-fields">
          <label>
            {t("graph.inputField")}
            <input
              value={node.path}
              placeholder={t("graph.emailSubjectOrNodesNodeidField")}
              onInput={(e) => update({ ...node, path: e.currentTarget.value })}
            />
          </label>
          <label>
            {t("graph.operator")}
            <select
              value={node.operator}
              onChange={(e) =>
                update({
                  ...node,
                  operator: e.currentTarget.value as typeof node.operator,
                  value: e.currentTarget.value.endsWith("Any")
                    ? Array.isArray(node.value)
                      ? node.value
                      : [String(node.value ?? "")]
                    : Array.isArray(node.value)
                    ? node.value[0] ?? ""
                    : node.value,
                })}
            >
              <option value="contains">
                {t("graph.containsCaseInsensitive")}
              </option>
              <option value="equals">{t("graph.equals")}</option>
              <option value="exists">{t("graph.hasAValue")}</option>
              <option value="containsAny">
                {t("graph.containsAnyKeyword")}
              </option>
              <option value="startsWithAny">
                {t("graph.startsWithAnyKeyword")}
              </option>
              <option value="endsWithAny">
                {t("graph.endsWithAnyKeyword")}
              </option>
            </select>
          </label>
          {node.operator.endsWith("Any") && (
            <label>
              {t("graph.keywordsOnePerLineCaseInsensitive")}
              <textarea
                rows={5}
                value={Array.isArray(node.value) ? node.value.join("\n") : ""}
                onInput={(e) =>
                  update({
                    ...node,
                    value: e.currentTarget.value.split("\n"),
                  })}
              />
            </label>
          )}
          {node.operator !== "exists" && !node.operator.endsWith("Any") && (
            <>
              <label>
                {t("graph.valueType")}
                <select
                  value={node.value === null ? "null" : typeof node.value}
                  onChange={(e) =>
                    update({
                      ...node,
                      value: e.currentTarget.value === "boolean"
                        ? true
                        : e.currentTarget.value === "number"
                        ? 0
                        : e.currentTarget.value === "null"
                        ? null
                        : "",
                    })}
                >
                  <option value="string">{t("graph.string")}</option>
                  <option value="boolean">{t("graph.boolean")}</option>
                  <option value="number">{t("graph.number")}</option>
                  <option value="null">null</option>
                </select>
              </label>
              {typeof node.value === "boolean"
                ? (
                  <label>
                    {t("graph.comparisonValue")}
                    <select
                      value={String(node.value)}
                      onChange={(e) =>
                        update({
                          ...node,
                          value: e.currentTarget.value === "true",
                        })}
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  </label>
                )
                : node.value !== null && (
                  <label>
                    {t("graph.comparisonValue")}
                    <input
                      type={typeof node.value === "number" ? "number" : "text"}
                      value={String(node.value)}
                      maxLength={1000}
                      onInput={(e) =>
                        update({
                          ...node,
                          value: typeof node.value === "number"
                            ? Number(e.currentTarget.value)
                            : e.currentTarget.value,
                        })}
                    />
                  </label>
                )}
            </>
          )}
        </div>
      )}
    />
  );
}
