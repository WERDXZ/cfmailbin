import { type DisplayMessage, formatMessage } from "./messages.ts";
import { useI18n } from "./i18n.tsx";
import { useEffect, useState } from "preact/hooks";
import type { PolicyDefinition, PolicyExpression } from "../graph/types.ts";
import { policyPaths } from "../graph/policies.ts";
import { api } from "./api.ts";
import { BooleanTreeEditor } from "./BooleanTreeEditor.tsx";

export function PolicyExpressionEditor(
  props: {
    expression: PolicyExpression;
    change: (value: PolicyExpression) => void;
    allowItem?: boolean;
  },
) {
  const { t } = useI18n();
  const [library, setLibrary] = useState<PolicyDefinition[]>([]);
  const [error, setError] = useState<DisplayMessage>("");
  useEffect(() => {
    const controller = new AbortController();
    api.getPolicies(controller.signal).then((value) => {
      if (!controller.signal.aborted) setLibrary(value.policies);
    }).catch((e) => {
      if (!controller.signal.aborted) setError(e);
    });
    return () => controller.abort();
  }, []);
  const choices = library.filter((policy) =>
    !policy.success?.actions.length && (props.allowItem ||
      !policyPaths({ policy }).some((path) => path.startsWith("item.")))
  );
  return (
    <div class="policy-composer">
      {error && <p class="inline-error">{formatMessage(error, t)}</p>}
      {!choices.length && !error && (
        <p class="muted">
          {t("policies.noPoliciesAreAvailableCreateOneIn")}
          <a
            href="/settings/rules"
            target="_blank"
            rel="noopener"
          >
            {t("policies.policyLibrary")}
          </a>
          {t("policies.thenReopenThisNode")}
        </p>
      )}
      <BooleanTreeEditor<{ policy: PolicyDefinition }>
        tree={props.expression}
        change={props.change}
        createLeaf={choices.length
          ? () => ({ policy: structuredClone(choices[0]) })
          : null}
        maxDepth={5}
        maxNodes={24}
        maxChildren={16}
        noun="policy"
        fold={false}
        renderLeaf={(node, update) => (
          <PolicyLeaf node={node} update={update} library={choices} />
        )}
      />
      <small class="muted">
        {t(
          "policies.usesAVersionedSnapshotFromTheLibrary",
        )}
      </small>
    </div>
  );
}

function PolicyLeaf({ node, update, library }: {
  node: { policy: PolicyDefinition };
  update: (node: { policy: PolicyDefinition }) => void;
  library: PolicyDefinition[];
}) {
  const { t } = useI18n();
  return (
    <>
      <label>
        Policy<select
          value={node.policy.id}
          onChange={(e) => {
            const policy = library.find((p) => p.id === e.currentTarget.value);
            if (policy) update({ policy: structuredClone(policy) });
          }}
        >
          {!library.some((p) => p.id === node.policy.id) && (
            <option value={node.policy.id}>
              {node.policy.name}
              {t("policies.currentSnapshot")}
            </option>
          )}
          {library.map((p) => <option key={p.id} value={p.id}>{p.name}
          </option>)}
        </select>
      </label>
      {library.some((p) =>
        p.id === node.policy.id &&
        p.revision !== node.policy.revision
      ) && (
        <button
          type="button"
          class="text-button"
          onClick={() =>
            update({
              policy: structuredClone(
                library.find((p) => p.id === node.policy.id)!,
              ),
            })}
        >
          {t("policies.applyUpdatedPolicyVersion")}
        </button>
      )}
      <details class="policy-snapshot">
        <summary>
          {t("policies.viewCondition")}
          {node.policy.revision.slice(0, 8)}
        </summary>
        <pre>{JSON.stringify(node.policy.condition, null, 2)}</pre>
      </details>
    </>
  );
}
