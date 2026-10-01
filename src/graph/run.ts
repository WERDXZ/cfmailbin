import {
  AnalysisError,
  validateVerificationResult,
} from "../email/analysis.ts";
import { findVerificationCodes } from "./local-extraction.ts";
import { executeActions, ruleActions } from "./actions.ts";
import { evaluatePolicies } from "./policies.ts";
import { parseActions } from "../domain/rule-validation.ts";
import { conditionVerdict } from "./conditions.ts";
import type { RuleActions, RuleDecision } from "../domain/models.ts";
import type { AnalysisProvider } from "../domain/analysis.ts";
import { analysisFailureCodes, analysisModels } from "../domain/analysis.ts";
import { analysisFailureLabels } from "../domain/analysis.ts";
import { compileGraph, parseGraph, pathParts } from "./compile.ts";
import { validateOutput } from "./schema.ts";
import { collectCodes, extractTokens } from "./text-operations.ts";
import { aiResults } from "./ai-result.ts";
import {
  type AiNode,
  GraphAiLimitError,
  type GraphEdge,
  GraphError,
  type GraphRun,
  type JsonValue,
  type MailGraph,
} from "./types.ts";

export interface AiTask {
  node: AiNode;
  input: Record<string, JsonValue>;
}
export interface GraphRuntime {
  aiEnabled?: boolean;
  aiTimeoutMs?: number;
  provider?: AnalysisProvider;
  rules?: (codes: string[]) => Promise<RuleDecision>;
  reject?: (reason: string) => void;
  ai: (
    tasks: AiTask[],
    timeoutMs: number,
  ) => Promise<Record<string, JsonValue>>;
  forward?: (destination: string) => Promise<unknown>;
  reply?: (text: string) => Promise<unknown>;
  checkpoint?: (run: GraphRun, beforeEffect?: boolean) => Promise<void>;
  trial?: boolean;
}

export async function runGraph(
  draft: MailGraph,
  email: Record<string, JsonValue>,
  runtime: GraphRuntime,
): Promise<GraphRun> {
  const graph = parseGraph(draft), plan = compileGraph(graph);
  email = structuredClone(email);
  email.body ??= email.text ?? "";
  email.fromDomain =
    String(email.from ?? "").split("@").at(-1)?.toLowerCase() ?? "";
  const localCodes = graph.codeExtraction !== "nodes" ||
      graph.nodes.some((n) => n.kind === "extract")
    ? findVerificationCodes(
      String(email.body ?? email.text ?? ""),
      String(email.subject ?? ""),
    )
    : [];
  email.codes = graph.codeExtraction === "nodes" ? [] : localCodes;
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const outputs: Record<string, JsonValue> = {};
  const incompleteOutputs = new Map<string, "unavailable" | "truncated">();
  const run: GraphRun = {
    revision: graph.revision,
    status: "running",
    steps: [],
    tags: [],
    trial: runtime.trial ?? false,
    codes: Array.isArray(email.codes)
      ? email.codes.filter((v): v is string => typeof v === "string")
      : [],
  };
  const started = Date.now();
  let previous: string | undefined;
  function read(path: string): JsonValue {
    let current: JsonValue = {
      email,
      nodes: outputs,
      current: { parent: previous ? outputs[previous] ?? null : null },
    };
    for (const part of pathParts(path)) {
      if (
        !current || typeof current !== "object" || Array.isArray(current) ||
        !Object.hasOwn(current, part)
      ) {
        if (path.includes("?.")) return null;
        throw new GraphError(
          "所引用的输入尚不可用",
          "common.theReferencedInputIsNotAvailableYet",
        );
      }
      current = current[part];
    }
    return structuredClone(current);
  }
  function completeness(path: string): "unavailable" | "truncated" | undefined {
    path = pathParts(path).join(".");
    if (path.startsWith("current.parent.")) {
      path = `nodes.${previous}.${pathParts(path).slice(2).join(".")}`;
    }
    // Optional references distinguish missing data from an explicit null output.
    // This matters at joins whose executed parent has a different output schema.
    let value: JsonValue = { email, nodes: outputs };
    for (const part of pathParts(path)) {
      if (
        !value || typeof value !== "object" || Array.isArray(value) ||
        !Object.hasOwn(value, part)
      ) return "unavailable";
      value = value[part];
    }
    if (path.startsWith("nodes.")) {
      const parts = pathParts(path);
      if (!Object.hasOwn(outputs, parts[1])) return "unavailable";
      const source = outputs[parts[1]], kind = nodes.get(parts[1])?.kind;
      if (
        ["evaluate", "policies"].includes(kind ?? "") &&
        ["matched", "success"].includes(parts[2]) &&
        source && typeof source === "object" && !Array.isArray(source) &&
        source.indeterminate === true
      ) return "unavailable";
      return parts[2] === "items" ? incompleteOutputs.get(parts[1]) : undefined;
    }
    if (!["email.subject", "email.text", "email.body"].includes(path)) {
      return undefined;
    }
    if (email.unavailable === true) return "unavailable";
    const truncated = email[`${path.split(".")[1]}Truncated`] ??
      email.truncated;
    return truncated === true ? "truncated" : undefined;
  }
  async function actions(chain: import("./types.ts").MailAction[]) {
    if (chain.length) {
      await executeActions(chain, { run, nodeId: id, read, ...runtime });
    }
  }
  let id = graph.nodes.find((n) => n.kind === "entry")!.id;
  while (id) {
    const node = nodes.get(id)!;
    const begin = Date.now();
    let port: GraphEdge["port"] = "next";
    let output: JsonValue | undefined;
    try {
      if (node.kind === "ai") {
        if (
          node.onlyWhenMissingCodes &&
            (run.codes!.length || email.unavailable === true ||
              !(email.subject || email.text)) ||
          node.optional && runtime.aiEnabled === false
        ) {
          run.steps.push({
            nodeId: id,
            label: node.label,
            status: "skipped",
            durationMs: 0,
            output: {
              reason: node.optional && runtime.aiEnabled === false
                ? "AI 未启用或网关未配置"
                : run.codes!.length
                ? "已经提取到验证码"
                : "没有可分析的邮件内容",
            },
          });
          // Downstream optional references receive null for a skipped output.
          previous = id;
          id = graph.edges.find((edge) =>
            edge.from === id && edge.port === "next"
          )!.to;
          continue;
        }
        const remaining = (runtime.aiTimeoutMs ?? 25_000) -
          (Date.now() - started);
        if (remaining <= 0 && !node.resultFormat) {
          throw new AnalysisError("timeout");
        }
        const batch = plan.batches.find((group) => group[0] === id) ?? [id];
        const tasks = batch.map((member) => {
          const ai = nodes.get(member) as AiNode;
          return {
            node: ai,
            input: ai.resultFormat && runtime.aiEnabled === false
              ? {}
              : Object.fromEntries(
                Object.entries(ai.inputs).map((
                  [key, path],
                ) => [key, read(path)]),
              ),
          };
        });
        if (node.resultFormat) {
          for (const result of await aiResults(tasks, runtime, remaining)) {
            outputs[result.nodeId] = result.output;
            run.steps.push({
              ...result,
              label: nodes.get(result.nodeId)!.label,
              durationMs: Date.now() - begin,
              batch: batch.length > 1 ? batch : undefined,
            });
          }
        } else {
          const result = await runtime.ai(tasks, remaining);
          for (const task of tasks) {
            validateOutput(result[task.node.id], task.node.schema);
            if (task.node.outputMode === "verification") {
              const extraction = validateVerificationResult(
                result[task.node.id],
                `${email.subject}\n${email.text}`,
                email.truncated === true,
              );
              run.codes = [...new Set([...run.codes!, ...extraction.codes])];
              email.codes = run.codes;
              if (runtime.provider) {
                run.analysis = {
                  provider: runtime.provider,
                  model: analysisModels[runtime.provider],
                  status: "complete",
                  category: extraction.category,
                  codeStatus: extraction.codeStatus,
                  durationMs: Date.now() - begin,
                };
              }
            }
          }
          for (const task of tasks) {
            outputs[task.node.id] = result[task.node.id];
            run.steps.push({
              nodeId: task.node.id,
              label: task.node.label,
              status: "complete",
              durationMs: Date.now() - begin,
              output: result[task.node.id],
              batch: batch.length > 1 ? batch : undefined,
            });
          }
        }
        id = batch.at(-1)!;
      } else {
        if (node.kind === "action") {
          await actions(node.actions);
          output = {
            action: run.action ?? null,
            tags: run.tags,
            retentionDays: run.retentionDays ?? null,
            forwardTo: run.forwardTo ?? null,
          };
          outputs[id] = output;
        }
        if (node.kind === "evaluate") {
          output = evaluatePolicies(
            node.policies,
            read,
            completeness,
          ) as unknown as JsonValue;
          outputs[id] = output;
        }
        if (node.kind === "tokens") {
          const input = node.sources.map((path) => {
            const value = read(path);
            if (typeof value !== "string") {
              throw new GraphError(
                "候选提取的输入必须是文字",
                "errors.tokenExtractionInputMustBeText",
              );
            }
            return value;
          }).join("\n");
          if (input.length > 60000) {
            throw new GraphError(
              "候选提取输入最多 60,000 字符",
              "errors.tokenExtractionInputTooLong",
              { max: 60000 },
            );
          }
          const extracted = extractTokens(
            input,
            node.formats,
            node.contextBefore,
            node.contextAfter,
            node.normalizeContext,
          );
          const states = node.sources.map(completeness);
          const state = states.includes("unavailable")
            ? "unavailable"
            : states.includes("truncated") || extracted.truncated
            ? "truncated"
            : undefined;
          if (state) incompleteOutputs.set(id, state);
          output = {
            ...extracted,
            truncated: extracted.truncated || !!state,
          } as unknown as JsonValue;
          outputs[id] = output;
        }
        if (node.kind === "filter") {
          const input = read(node.input);
          if (!Array.isArray(input) || input.length > 200) {
            throw new GraphError(
              "筛选输入需要最多 200 项的数组",
              "errors.filterInputArrayRequired",
              { max: 200 },
            );
          }
          const inputCompleteness = completeness(node.input);
          if (inputCompleteness) incompleteOutputs.set(id, inputCompleteness);
          const decisions: JsonValue[] = [];
          const items = input.filter((item) => {
            const readItem = (path: string) => {
              if (!path.startsWith("item.")) return read(path);
              const key = pathParts(path, true)[1];
              if (
                !item || typeof item !== "object" || Array.isArray(item) ||
                !Object.hasOwn(item, key)
              ) {
                throw new GraphError(
                  "候选项缺少筛选字段",
                  "errors.candidateFilterFieldMissing",
                );
              }
              return item[key];
            };
            const result = evaluatePolicies(
              node.policies,
              readItem,
              (path) =>
                path.startsWith("item.")
                  ? inputCompleteness
                  : completeness(path),
            );
            // Filtering is pure; action plans can only be applied from a policy node.
            if (decisions.length < 10) {
              decisions.push(
                {
                  item,
                  matched: result.matched,
                  reasons: result.reasons,
                  results: result.results,
                } as unknown as JsonValue,
              );
            }
            return result.matched;
          });
          output = {
            items,
            truncated: !!inputCompleteness,
            decisions,
            checked: input.length,
          };
          outputs[id] = output;
        }
        if (node.kind === "policies") {
          const result = evaluatePolicies(node.policies, read, completeness);
          output = result as unknown as JsonValue;
          outputs[id] = output;
          port = result.matched ? "success" : "failed";
        }
        if (node.kind === "apply") {
          const input = read(node.input);
          if (!Array.isArray(input) || input.length > 192) {
            throw new GraphError(
              "Policy 动作输出无效",
              "errors.invalidPolicyActionOutput",
            );
          }
          const plannedActions = input.map(parseActions);
          const delivery = plannedActions.filter((a) => a.delivery);
          const targets = new Set(
            delivery.map((a) => `${a.delivery}:${a.forwardTo ?? ""}`),
          );
          if (targets.size > 1) {
            throw new GraphError(
              "Policy 动作冲突：请让同一路径只产生一种邮件处理方式和一个转发目标",
              "errors.conflictingPolicyActions",
            );
          }
          const tags = [
            ...new Set(plannedActions.flatMap((a) => a.tags ?? [])),
          ];
          if (tags.length > 10) {
            throw new GraphError(
              "Policy 合并后最多 10 个标签",
              "errors.mergedPolicyTagLimit",
              { max: 10 },
            );
          }
          const retention = plannedActions.flatMap((a) =>
            a.retentionDays === undefined ? [] : [a.retentionDays]
          );
          const action: RuleActions = delivery[0] ?? { delivery: "keep" };
          await actions(ruleActions({
            ...action,
            tags,
            ...(retention.length
              ? { retentionDays: Math.min(...retention) }
              : {}),
          }));
          run.status = "complete";
          output = {
            action: run.action!,
            tags: run.tags,
            forwardTo: run.forwardTo ?? null,
            retentionDays: run.retentionDays ?? null,
          };
        }
        if (node.kind === "output") {
          const codes = collectCodes(
            read(node.input),
            `${email.subject}\n${email.body ?? email.text}`,
            node.limit,
          );
          run.codes = [...new Set([...run.codes!, ...codes])].slice(0, 3);
          email.codes = run.codes;
          output = { codes, hasCode: codes.length > 0 };
          outputs[id] = output;
        }
        if (node.kind === "extract") {
          const codes = Array.isArray(localCodes)
            ? localCodes.filter((value): value is string =>
              typeof value === "string"
            )
            : [];
          run.codes = [...new Set([...run.codes!, ...codes])];
          email.codes = run.codes;
          output = { codes, hasCode: codes.length > 0 };
          outputs[id] = output;
        }
        if (node.kind === "rules") {
          if (!runtime.rules) {
            throw new GraphError(
              "当前环境无法读取收件规则",
              "errors.rulesUnavailable",
            );
          }
          const decision = await runtime.rules(run.codes!);
          run.ruleDecision = decision;
          await actions(ruleActions({
            delivery: decision.action,
            forwardTo: decision.forwardTo,
            tags: decision.tags,
            retentionDays: decision.retentionDays,
          }));
          output = {
            action: decision.action,
            forwardTo: decision.forwardTo ?? null,
            tags: decision.tags,
            retentionDays: decision.retentionDays,
          };
          outputs[id] = output;
          if (decision.action === "block") run.status = "complete";
        }
        if (node.kind === "finish") {
          await actions(node.actions ?? []);
          if (graph.version === 2 && !run.action) {
            await actions([{
              type: "deny",
              reason: "No accepting action in workflow",
            }]);
          }
          run.status = "complete";
          run.action ??= "keep";
          output = {
            action: run.action,
            tags: run.tags,
            forwardTo: run.forwardTo ?? null,
            retentionDays: run.retentionDays ?? null,
          };
        }
        if (node.kind === "match") {
          const incomplete = completeness(node.input);
          const value = incomplete ? null : read(node.input);
          const selected = incomplete
            ? undefined
            : node.cases.find((c) => c.value === value);
          port = selected ? `case:${selected.id}` : "default";
          output = {
            value,
            selected: selected?.id ?? null,
            incomplete: !!incomplete,
          };
        }
        if (node.kind === "condition") {
          const matches = conditionVerdict(
            node.condition ??
              { path: node.path, operator: node.operator, value: node.value },
            read,
            completeness,
          );
          if (matches === null && !node.unknown) {
            throw new GraphError(
              "邮件内容不完整，无法确定条件结果",
              "errors.incompleteMailCondition",
            );
          }
          port = matches === null ? "unknown" : matches ? "yes" : "no";
          output = matches;
        }
        if (node.kind === "delivery") {
          await actions(
            ruleActions({
              delivery: node.action,
              forwardTo: node.forwardTo,
              tags: node.tags,
              retentionDays: node.retentionDays,
            }),
          );
          run.status = "complete";
          output = {
            action: node.action,
            ...(run.forwardTo ? { forwardTo: run.forwardTo } : {}),
          };
        }
        run.steps.push({
          nodeId: id,
          label: node.label,
          status: "complete",
          durationMs: Date.now() - begin,
          output,
        });
      }
      await runtime.checkpoint?.(structuredClone(run));
    } catch (error) {
      if (node.kind === "ai" && error instanceof AnalysisError && !run.trial) {
        console.warn("Graph AI failed", {
          nodeId: id,
          provider: runtime.provider,
          reason: error.reason,
          httpStatus: error.httpStatus,
          phase: error.phase,
          durationMs: error.durationMs,
        });
      }
      const reason = error instanceof AnalysisError
        ? `${analysisFailureLabels[error.reason]}${
          error.httpStatus ? ` · HTTP ${error.httpStatus}` : ""
        }`
        : error instanceof GraphError
        ? error.message
        : "节点执行失败";
      const errorCode = error instanceof AnalysisError
        ? analysisFailureCodes[error.reason]
        : error instanceof GraphError
        ? error.code
        : "errors.nodeExecutionFailed";
      const errorParams = error instanceof AnalysisError
        ? error.httpStatus ? { httpStatus: error.httpStatus } : undefined
        : error instanceof GraphError
        ? error.params
        : undefined;
      run.steps.push({
        nodeId: id,
        label: node.label,
        status: error instanceof GraphAiLimitError && node.kind === "ai" &&
            node.optional
          ? "skipped"
          : "failed",
        durationMs: Date.now() - begin,
        error: reason,
        ...(errorCode ? { errorCode } : {}),
        ...(errorParams ? { errorParams } : {}),
      });
      if (node.kind === "ai" && node.optional) {
        if (node.outputMode === "verification" && runtime.provider) {
          run.analysis = {
            provider: runtime.provider,
            model: analysisModels[runtime.provider],
            status: error instanceof GraphAiLimitError ? "skipped" : "failed",
            reason: error instanceof GraphAiLimitError
              ? "daily_limit"
              : error instanceof AnalysisError
              ? error.reason
              : "unavailable",
            ...(error instanceof AnalysisError
              ? {
                httpStatus: error.httpStatus,
                phase: error.phase,
                durationMs: error.durationMs,
              }
              : {}),
          };
        }
        previous = id;
        id = graph.edges.find((edge) =>
          edge.from === id && edge.port === "next"
        )!.to;
        continue;
      }
      run.status = "failed";
      run.error = reason;
      if (errorCode) run.errorCode = errorCode;
      if (errorParams) run.errorParams = errorParams;
      return run;
    }
    if (run.status === "complete") return run;
    previous = id;
    id = graph.edges.find((edge) => edge.from === id && edge.port === port)!.to;
  }
  return run;
}
