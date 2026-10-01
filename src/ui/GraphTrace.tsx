import { formatMessage } from "./messages.ts";
import { useI18n } from "./i18n.tsx";
import { mailActionKeys } from "./labels.ts";
import type { GraphRun, JsonValue } from "../graph/types.ts";
import { RuleTrace } from "./RuleTrace.tsx";

export function GraphTrace({ run }: { run: GraphRun }) {
  const { t } = useI18n();
  return (
    <div class="graph-trace">
      <p class={run.status === "failed" ? "inline-error" : "muted"}>
        {run.trial ? t("graph.trial") : ""}
        {run.status === "failed"
          ? t("graph.incomplete", {
            reason: formatMessage({
              message: run.error ?? "",
              code: run.errorCode,
              params: run.errorParams,
            }, t),
          })
          : run.status === "running"
          ? t("graph.processingStatus")
          : t("graph.executionComplete")}
        {run.status === "complete" &&
            run.steps.some((step) => step.status === "failed")
          ? t("graph.someNodesFailedExecutionContinuedAlongThe")
          : ""}
        {run.trial && run.action === "forward"
          ? t("graph.wouldForwardToNotSent", { address: run.forwardTo ?? "" })
          : ""}
      </p>
      <ol>
        {run.steps.map((step, i) => (
          <li key={`${step.nodeId}-${i}`}>
            <details>
              <summary>
                <span>
                  {step.status === "failed"
                    ? "×"
                    : step.status === "skipped"
                    ? "−"
                    : "✓"} {step.label}
                  {step.status === "skipped" ? t("graph.skipped") : ""}
                </span>
                <span class="muted">
                  {step.batch ? t("graph.batched") : ""}
                  {(step.durationMs / 1000).toFixed(1)}s
                </span>
              </summary>
              {step.error && (
                <p class="inline-error">
                  {formatMessage({
                    message: step.error,
                    code: step.errorCode,
                    params: step.errorParams,
                  }, t)}
                </p>
              )}
              <PolicyResults output={step.output} />
              {step.output !== undefined && (
                <pre>{JSON.stringify(step.output, null, 2)}</pre>
              )}
            </details>
          </li>
        ))}
      </ol>
      {!!run.actionResults?.length && (
        <details open={run.status === "failed"}>
          <summary>{t("graph.executedActions")}</summary>
          <ol>
            {run.actionResults.map((action, i) => (
              <li key={i}>
                {action.status === "simulated"
                  ? t("graph.trialRun")
                  : t("graph.completed")} · {t(mailActionKeys[action.type])}
                {action.value !== undefined
                  ? `：${
                    Array.isArray(action.value)
                      ? action.value.join("、")
                      : action.type === "keep" ||
                          action.type === "set_retention"
                      ? t("common.dayCount", { count: Number(action.value) })
                      : action.value
                  }`
                  : ""}
              </li>
            ))}
          </ol>
        </details>
      )}
      {run.ruleDecision && (
        <details>
          <summary>{t("graph.receivingRuleMatches")}</summary>
          <RuleTrace traces={run.ruleDecision.trace} />
        </details>
      )}
      {run.revision && (
        <small class="muted">
          {t("graph.configurationVersion")}
          {run.revision.slice(0, 8)}
        </small>
      )}
    </div>
  );
}

function PolicyResults({ output }: { output?: JsonValue }) {
  const { t } = useI18n();
  if (
    !output || typeof output !== "object" || Array.isArray(output) ||
    !Array.isArray(output.results)
  ) return null;
  return (
    <div class="policy-results">
      <p>
        {output.indeterminate
          ? t("graph.indeterminateSuccessNull")
          : (output.success ?? output.matched)
          ? t("graph.groupPassedSuccessTrue")
          : t("graph.groupDidNotPassSuccessFalse")}
      </p>
      <ul>
        {output.results.map((value, index) => {
          if (
            !value || typeof value !== "object" || Array.isArray(value) ||
            typeof value.name !== "string"
          ) return null;
          return (
            <li key={index}>
              <strong>
                {value.indeterminate
                  ? "?"
                  : (value.success ?? value.matched)
                  ? "✓"
                  : "×"} {value.name}
              </strong>
              {Array.isArray(value.reasons) && value.reasons.length > 0 && (
                <span class="muted">
                  · {value.reasons.filter((r) => typeof r === "string").join(
                    "；",
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
