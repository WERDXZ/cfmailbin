import type {
  ConditionTrace as Trace,
  RuleActions,
  RuleTrace as Match,
} from "./types.ts";
import { actionLabels } from "../domain/rules.ts";

export function actionSummary(actions: RuleActions): string {
  return [
    actions.delivery
      ? actionLabels[actions.delivery] +
        (actions.forwardTo ? ` → ${actions.forwardTo}` : "")
      : "",
    actions.tags?.length ? `标签：${actions.tags.join("、")}` : "",
    actions.retentionDays ? `保留 ${actions.retentionDays} 天` : "",
  ].filter(Boolean).join(" · ");
}
export function ConditionTrace({ trace }: { trace: Trace }) {
  return (
    <li class="condition-trace">
      <span>
        {trace.result === null ? "无法判断" : trace.result ? "符合" : "不符合"}
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
  return (
    <div class="rule-traces">
      {traces.map((trace) => (
        <details key={trace.ruleId}>
          <summary>
            {trace.name} · {trace.condition.result === null
              ? "无法判断，未执行"
              : trace.condition.result
              ? "命中"
              : "未命中"}
            {trace.stopped ? " · 停止后续规则" : ""}
          </summary>
          <p class="muted">{actionSummary(trace.actions)}</p>
          <ul>
            <ConditionTrace trace={trace.condition} />
          </ul>
        </details>
      ))}
    </div>
  );
}
