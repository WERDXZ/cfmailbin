import { policyTemplateLabel } from "./templates.ts";
import {
  type DisplayMessage,
  formatMessage,
  localizedMessage,
} from "./messages.ts";
import { useI18n } from "./i18n.tsx";
import { useEffect, useState } from "preact/hooks";
import type { PolicyDefinition } from "../graph/types.ts";
import { parsePolicy, purePolicy } from "../graph/policies.ts";
import { api } from "./api.ts";
import { GraphConditionEditor } from "./GraphConditionEditor.tsx";
import { useUnsavedChanges } from "./useUnsavedChanges.ts";
import "./graph.css";
import { TemplatePicker } from "./TemplatePicker.tsx";

export function PolicyLibrary() {
  const { t } = useI18n();
  const [policies, setPolicies] = useState<PolicyDefinition[]>([]);
  const [templates, setTemplates] = useState<PolicyDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState<PolicyDefinition | null>(null);
  const [draft, setDraft] = useState<PolicyDefinition | null>(null);
  const [error, setError] = useState<DisplayMessage>("");
  const [notice, setNotice] = useState<DisplayMessage>("");
  const [busy, setBusy] = useState(false);
  const [storage, setStorage] = useState("unavailable");
  const [attempt, setAttempt] = useState(0);
  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);
  function select(policy?: PolicyDefinition) {
    setSaved(policy ?? null);
    setDraft(policy ? structuredClone(policy) : null);
    setNotice("");
  }
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setLoading(true);
    api.getPolicies(controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      setPolicies(value.policies);
      setTemplates(value.templates);
      setStorage(value.storage);
      select(value.policies[0]);
    }).catch((e) => {
      if (!controller.signal.aborted) setError(e);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [attempt]);
  useUnsavedChanges(
    dirty,
    t("policies.thisPolicyHasUnsavedChangesDiscardThem"),
  );
  let validation: DisplayMessage = "";
  try {
    if (draft) parsePolicy(draft);
  } catch (e) {
    validation = e as Error;
  }
  async function save(copy = false) {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      const value = await api.savePolicy({
        ...purePolicy(draft),
        ...(copy || draft.id.startsWith("builtin_")
          ? { id: `policy_${crypto.randomUUID()}`, revision: "" }
          : {}),
      });
      setPolicies([...policies.filter((p) => p.id !== value.id), value]);
      select(value);
      setNotice(
        localizedMessage("policies.savedNodeSnapshotsStayUnchangedUntilYou"),
      );
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (
      !draft || !confirm(t("policies.deleteThisPolicyExistingNodesKeepTheir"))
    ) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.deletePolicy(draft.id);
      const next = policies.filter((p) => p.id !== draft.id);
      setPolicies(next);
      select(next[0]);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section class="graph-editor node-library">
      <div class="settings-section-heading">
        <h2>{t("policies.rulesPolicy")}</h2>
        <p class="muted">
          {t(
            "policies.rulesEvaluateConditionsAndReturnResultsCombine",
          )}
        </p>
      </div>
      {error && (
        <p class="notice notice--error" role="alert">
          {formatMessage(error, t)}{" "}
          <button
            type="button"
            class="text-button"
            onClick={() => setAttempt(attempt + 1)}
          >
            {t("policies.reload")}
          </button>
        </p>
      )}
      {notice && <p class="notice" role="status">{formatMessage(notice, t)}</p>}
      {loading && !error && <p role="status">{t("policies.loadingPolicies")}
      </p>}
      {!loading && !policies.length && !error && (
        <p class="muted">{t("policies.noSavedPoliciesYet")}</p>
      )}
      <fieldset disabled={busy || loading}>
        <TemplatePicker
          label={t("policies.newPolicy")}
          actionLabel={t("policies.createPolicy")}
          blank={{
            id: "",
            label: "Policy",
            description: t("policies.defineANameAndConditionThatReturns"),
          }}
          options={templates.map((policy) => ({
            id: policy.id,
            label: policyTemplateLabel(policy, t),
          }))}
          create={(id) => {
            if (
              dirty && !confirm(t("policies.discardChangesToThisPolicy"))
            ) return false;
            const source = templates.find((policy) => policy.id === id);
            setSaved(null);
            setNotice("");
            setDraft({
              ...(source
                ? {
                  ...structuredClone(source),
                  name: policyTemplateLabel(source, t),
                }
                : {
                  name: "",
                  condition: {
                    path: "",
                    operator: "contains" as const,
                    value: "",
                  },
                }),
              version: 2,
              id: `policy_${crypto.randomUUID()}`,
              revision: "",
            });
          }}
        />
        <div class="node-library-layout">
          <nav aria-label={t("policies.libraryNavigation")}>
            {policies.map((policy) => (
              <button
                type="button"
                class={`node-library-item ${
                  draft?.id === policy.id ? "is-selected" : ""
                }`}
                key={policy.id}
                onClick={() => {
                  if (
                    !dirty || confirm(t("policies.discardChangesToThisPolicy"))
                  ) {
                    select(
                      policy,
                    );
                  }
                }}
              >
                <span>{policy.name}</span>
                <small>
                  {policy.id.startsWith("builtin_")
                    ? t("policies.preset")
                    : t("policies.myPolicies")}
                </small>
              </button>
            ))}
          </nav>
          {draft && (
            <form
              key={draft.id}
              class="node-library-detail policy-editor"
              onSubmit={(event) => {
                event.preventDefault();
                if (
                  !validation && storage !== "unavailable" && !busy
                ) void save();
              }}
            >
              <label>
                {t("graph.name")}
                <input
                  value={draft.name}
                  maxLength={80}
                  onInput={(e) =>
                    setDraft({ ...draft, name: e.currentTarget.value })}
                />
              </label>
              <h3>{t("graph.operator")}</h3>
              <GraphConditionEditor
                condition={draft.condition}
                change={(condition) => setDraft({ ...draft, condition })}
              />
              <small class="muted">
                {t(
                  "policies.emailSubjectTextFromToCandidateFilters",
                )}
              </small>
              {saved?.success?.actions.length
                ? (
                  <details class="notice policy-snapshot" open>
                    <summary>{t("policies.legacyRuleContainsActions")}</summary>
                    <p>
                      {t(
                        "policies.afterSavingThisRuleOnlyReturnsIts",
                      )}
                    </p>
                    <pre>{JSON.stringify(saved.success.actions, null, 2)}</pre>
                  </details>
                )
                : null}
              <p class="muted">
                {t(
                  "policies.returnsSuccessTrueFalseOrNullFor",
                )}
              </p>
              {validation && (
                <p class="inline-error" role="status">
                  {formatMessage(validation, t)}
                </p>
              )}
              <div class="graph-actions">
                <button
                  type="submit"
                  class="button button--primary"
                  disabled={!!validation || storage === "unavailable" ||
                    !dirty && draft.version === 2 &&
                      !draft.id.startsWith("builtin_")}
                >
                  {draft.id.startsWith("builtin_")
                    ? t("policies.saveToMyPolicies")
                    : draft.version !== 2
                    ? t("policies.convertAndSaveRule")
                    : t("policies.savePolicy")}
                </button>
                {!draft.id.startsWith("builtin_") && (
                  <>
                    <button
                      type="button"
                      class="text-button"
                      disabled={!!validation || storage === "unavailable"}
                      onClick={() => save(true)}
                    >
                      {t("policies.saveAsNewPolicy")}
                    </button>
                    <button
                      type="button"
                      class="text-button"
                      disabled={!saved || storage === "unavailable"}
                      onClick={remove}
                    >
                      {t("policies.deletePolicy")}
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
