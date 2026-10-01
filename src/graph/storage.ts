import { parseGraph } from "./compile.ts";
import type { GraphStore, MailGraph } from "./types.ts";
import { SettingsError } from "../settings.ts";
import { parseLibrary } from "./library.ts";
import { parsePolicyLibrary } from "./policies.ts";
import type { NodePreset, PolicyDefinition } from "./types.ts";

export function createGraphStore(
  kv?: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<void>;
  },
): GraphStore {
  let memory: MailGraph | null = null;
  let legacy: MailGraph | null = null;
  let library: NodePreset[] = [];
  let policies: PolicyDefinition[] = [];
  return {
    kind: kv ? "kv" : "memory",
    async getPolicies() {
      if (!kv) return structuredClone(policies);
      try {
        const value = await kv.get("policies:v1");
        return value === null ? [] : parsePolicyLibrary(JSON.parse(value));
      } catch {
        throw new SettingsError(
          503,
          "暂时无法读取 Policy 库",
          "errors.policyLibraryReadUnavailable",
        );
      }
    },
    async putPolicies(input) {
      const valid = parsePolicyLibrary(input);
      if (!kv) {
        policies = structuredClone(valid);
        return;
      }
      try {
        await kv.put("policies:v1", JSON.stringify(valid));
      } catch {
        throw new SettingsError(
          503,
          "暂时无法保存 Policy 库",
          "errors.policyLibrarySaveUnavailable",
        );
      }
    },
    async getLibrary() {
      if (!kv) return structuredClone(library);
      try {
        const value = await kv.get("nodes:v1");
        return value === null ? [] : parseLibrary(JSON.parse(value));
      } catch {
        throw new SettingsError(
          503,
          "暂时无法读取节点库",
          "errors.nodeLibraryReadUnavailable",
        );
      }
    },
    async putLibrary(presets) {
      const valid = parseLibrary(presets);
      if (!kv) {
        library = valid;
        return;
      }
      try {
        await kv.put("nodes:v1", JSON.stringify(valid));
      } catch {
        throw new SettingsError(
          503,
          "暂时无法保存节点库",
          "errors.nodeLibrarySaveUnavailable",
        );
      }
    },
    async get() {
      if (!kv) return memory && structuredClone(memory);
      try {
        const value = await kv.get("graph:v1");
        return value === null ? null : parseGraph(JSON.parse(value));
      } catch {
        throw new SettingsError(
          503,
          "暂时无法读取 Graph 配置",
          "errors.workflowReadUnavailable",
        );
      }
    },
    async getLegacy() {
      if (!kv) return structuredClone(memory?.version === 1 ? memory : legacy);
      try {
        const current = await kv.get("graph:v1");
        if (current) {
          const graph = parseGraph(JSON.parse(current));
          if (graph.version === 1) return graph;
        }
        const backup = await kv.get("graph:legacy:v1");
        return backup ? parseGraph(JSON.parse(backup)) : null;
      } catch {
        throw new SettingsError(
          503,
          "暂时无法读取旧流程配置",
          "errors.legacyWorkflowReadUnavailable",
        );
      }
    },
    async put(graph) {
      const valid = parseGraph(graph);
      if (!kv) {
        if (valid.version === 2 && memory?.version === 1) {
          legacy = structuredClone(memory);
        }
        memory = structuredClone(valid);
        return;
      }
      try {
        if (valid.version === 2) {
          const previous = await kv.get("graph:v1");
          if (previous && parseGraph(JSON.parse(previous)).version === 1) {
            await kv.put("graph:legacy:v1", previous);
          }
        }
        await kv.put("graph:v1", JSON.stringify(valid));
      } catch {
        throw new SettingsError(
          503,
          "暂时无法保存 Graph，请稍后重试",
          "errors.workflowSaveUnavailable",
        );
      }
    },
  };
}
