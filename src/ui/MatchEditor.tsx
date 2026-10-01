import { useI18n } from "./i18n.tsx";
import type { GraphNode } from "../graph/types.ts";

type MatchNode = Extract<GraphNode, { kind: "match" }>;
export function MatchEditor({ node, update }: {
  node: MatchNode;
  update: (node: MatchNode) => void;
}) {
  const { t } = useI18n();
  const changeCase = (index: number, value: MatchNode["cases"][number]) =>
    update({
      ...node,
      cases: node.cases.map((item, i) => i === index ? value : item),
    });
  return (
    <>
      <label>
        {t("conditions.matchField")}
        <input
          value={node.input}
          placeholder="nodes.check.status"
          onInput={(event) =>
            update({ ...node, input: event.currentTarget.value })}
        />
      </label>
      <ol class="match-cases">
        {node.cases.map((item, index) => {
          const type = item.value === null ? "null" : typeof item.value;
          return (
            <li key={item.id}>
              <fieldset>
                <legend>{t("conditions.branch")}{index + 1}</legend>
                <label>
                  {t("conditions.branchName")}
                  <input
                    value={item.label}
                    maxLength={80}
                    onInput={(event) =>
                      changeCase(index, {
                        ...item,
                        label: event.currentTarget.value,
                      })}
                  />
                </label>
                <label>
                  {t("graph.valueType")}
                  <select
                    aria-label={t("graph.valueType")}
                    value={type}
                    onChange={(event) => {
                      const value = {
                        string: "",
                        number: 0,
                        boolean: true,
                        null: null,
                      }[event.currentTarget.value];
                      if (value !== undefined) {
                        changeCase(index, { ...item, value });
                      }
                    }}
                  >
                    <option value="string">{t("conditions.text")}</option>
                    <option value="number">{t("graph.number")}</option>
                    <option value="boolean">{t("graph.boolean")}</option>
                    <option value="null">null</option>
                  </select>
                </label>
                {typeof item.value === "boolean"
                  ? (
                    <label>
                      {t("graph.equals")}
                      <select
                        aria-label={t("graph.equals")}
                        value={String(item.value)}
                        onChange={(event) =>
                          changeCase(index, {
                            ...item,
                            value: event.currentTarget.value === "true",
                          })}
                      >
                        <option value="true">true</option>
                        <option value="false">false</option>
                      </select>
                    </label>
                  )
                  : item.value !== null && (
                    <label>
                      {t("graph.equals")}
                      <input
                        type={type === "number" ? "number" : "text"}
                        step="any"
                        value={item.value}
                        onInput={(event) =>
                          changeCase(index, {
                            ...item,
                            value: type === "number"
                              ? Number(event.currentTarget.value)
                              : event.currentTarget.value,
                          })}
                      />
                    </label>
                  )}
                <button
                  type="button"
                  class="text-button"
                  disabled={node.cases.length <= 1}
                  onClick={() =>
                    update({
                      ...node,
                      cases: node.cases.filter((_, i) => i !== index),
                    })}
                >
                  {t("conditions.removeBranch")}
                </button>
              </fieldset>
            </li>
          );
        })}
      </ol>
      <button
        type="button"
        class="text-button"
        disabled={node.cases.length >= 8}
        onClick={() => {
          let index = 1;
          while (node.cases.some((item) => item.id === `case${index}`)) index++;
          update({
            ...node,
            cases: [...node.cases, {
              id: `case${index}`,
              label: t("conditions.branchNumber", { index: index }),
              value: `case${index}`,
            }],
          });
        }}
      >
        {t("conditions.addBranch")}
      </button>
      <small class="muted">
        {t("conditions.matchByExactTypeAndValueUnmatched")}
      </small>
    </>
  );
}
