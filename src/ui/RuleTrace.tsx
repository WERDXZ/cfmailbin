import { useI18n } from "./i18n.tsx";
import type {
  ConditionTrace as Trace,
  RuleActions,
  RuleTrace as Match,
} from "./types.ts";
import type { Translator } from "./translate.ts";
import { deliveryActionKeys } from "./labels.ts";

export function actionSummary(
  actions: RuleActions,
  t: Translator,
): string {
  return [
    actions.delivery
      ? t(deliveryActionKeys[actions.delivery]) +
        (actions.forwardTo ? ` → ${actions.forwardTo}` : "")
      : "",
    actions.tags?.length
      ? t("rules.tags", { tags: actions.tags.join(", ") })
      : "",
    actions.retentionDays
      ? t("rules.retention", { count: actions.retentionDays })
      : "",
  ].filter(Boolean).join(" · ");
}
export function ConditionTrace({ trace }: { trace: Trace }) {
  const { t } = useI18n();
  return (
    <li class="condition-trace">
      <span>
        {trace.result === null
          ? t("rules.indeterminate")
          : trace.result
          ? t("rules.matches")
          : t("rules.doesNotMatch")}
      </span>{" "}
      {trace.label}
      {trace.children && (
        <ul>
          {trace.children.map((child, index) => (
            <ConditionTrace key={index} trace={child} />
          ))}
        </ul>
      )}
    </li>
  );
}
export function RuleTrace({ traces }: { traces: Match[] }) {
  const { t } = useI18n();
  return (
    <div class="rule-traces">
      {traces.map((trace) => (
        <details key={trace.ruleId}>
          <summary>
            {trace.name} · {trace.condition.result === null
              ? t("rules.indeterminateNotExecuted")
              : trace.condition.result
              ? t("rules.matched")
              : t("rules.notMatched")}
            {trace.stopped ? t("rules.stopFollowingRules") : ""}
          </summary>
          <p class="muted">{actionSummary(trace.actions, t)}</p>
          <ul>
            <ConditionTrace trace={trace.condition} />
          </ul>
        </details>
      ))}
    </div>
  );
}
