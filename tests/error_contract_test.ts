import { assertEquals } from "@std/assert";
import { handleRequest } from "../src/app.ts";
import { readConfig } from "../src/config.ts";
import { pathParts } from "../src/graph/paths.ts";
import { runGraph } from "../src/graph/run.ts";
import { GraphError, type MailGraph } from "../src/graph/types.ts";
import { createGraphStore } from "../src/graph/storage.ts";
import {
  createMemoryBlobStore,
  createMemoryStore,
} from "../src/storage/memory.ts";
import { parseSettings, settingsFromConfig } from "../src/settings.ts";

function backend() {
  return {
    config: readConfig(),
    store: createMemoryStore(),
    blobStore: createMemoryBlobStore(),
    graph: createGraphStore(),
    developmentSession: {
      mode: "development" as const,
      email: "owner@example.com",
    },
  };
}

Deno.test("API errors add stable codes without changing fallback messages", async () => {
  const response = await handleRequest(
    new Request("http://localhost/api/aliases", {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "x-cfmailbin-request": "1",
      },
      body: "{",
    }),
    backend(),
  );

  assertEquals(response.status, 400);
  assertEquals(await response.json(), {
    error: "Invalid JSON body",
    code: "errors.invalidJsonBody",
  });
});

Deno.test("uncoded API failures keep the legacy message-only fallback", async () => {
  const failing = backend();
  failing.store.listAliases = () => Promise.reject(new Error("storage failed"));
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await handleRequest(
      new Request("http://localhost/api/aliases"),
      failing,
    );

    assertEquals(response.status, 500);
    assertEquals(await response.json(), { error: "Internal Server Error" });
  } finally {
    console.error = originalError;
  }
});

Deno.test("Graph validation codes pass through API error responses", async () => {
  const response = await handleRequest(
    new Request("http://localhost/api/graph", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
        "x-cfmailbin-request": "1",
      },
      body: JSON.stringify({
        version: 2,
        enabled: true,
        codeExtraction: "nodes",
        nodes: [],
        edges: [],
      }),
    }),
    backend(),
  );

  assertEquals(response.status, 400);
  assertEquals(await response.json(), {
    error: "Graph 需要 2–32 个节点",
    code: "errors.graphNodeCount",
    params: { min: 2, max: 32 },
  });
});

Deno.test("dynamic validation errors expose interpolation params", () => {
  const defaults = settingsFromConfig(readConfig());
  try {
    parseSettings({ ...defaults, emailDomain: 42 });
    throw new Error("expected settings validation to fail");
  } catch (error) {
    assertEquals(
      error instanceof Error && error.message,
      "emailDomain 格式无效",
    );
    assertEquals(
      Reflect.get(error as object, "code"),
      "errors.invalidSettingFormat",
    );
    assertEquals(Reflect.get(error as object, "params"), {
      field: "emailDomain",
    });
  }

  try {
    pathParts("invalid.path");
    throw new Error("expected path validation to fail");
  } catch (error) {
    assertEquals(
      error instanceof Error && error.message,
      "输入路径无效：invalid.path",
    );
    assertEquals(
      Reflect.get(error as object, "code"),
      "errors.invalidInputPathWithValue",
    );
    assertEquals(Reflect.get(error as object, "params"), {
      path: "invalid.path",
    });
  }
});

Deno.test("graph runs preserve messages and add optional structured failure metadata", async () => {
  const graph: MailGraph = {
    version: 2,
    enabled: true,
    codeExtraction: "nodes",
    nodes: [
      { id: "start", label: "Start", kind: "entry", x: 0, y: 0 },
      {
        id: "keep",
        label: "Keep",
        kind: "action",
        x: 0,
        y: 100,
        actions: [{ type: "keep" }],
      },
      { id: "done", label: "Done", kind: "finish", x: 0, y: 200 },
    ],
    edges: [{ from: "start", to: "keep", port: "next" }, {
      from: "keep",
      to: "done",
      port: "next",
    }],
  };
  const run = await runGraph(graph, {}, {
    ai: () => Promise.resolve({}),
    checkpoint(current) {
      if (current.steps.at(-1)?.nodeId === "start") {
        throw new GraphError(
          "测试失败",
          "errors.testFailure",
          { nodeId: "start" },
        );
      }
      return Promise.resolve();
    },
  });

  assertEquals(run.status, "failed");
  assertEquals(run.error, "测试失败");
  assertEquals(run.errorCode, "errors.testFailure");
  assertEquals(run.errorParams, { nodeId: "start" });
  assertEquals(run.steps[1], {
    nodeId: "start",
    label: "Start",
    status: "failed",
    durationMs: run.steps[1].durationMs,
    error: "测试失败",
    errorCode: "errors.testFailure",
    errorParams: { nodeId: "start" },
  });

  const historical = {
    status: "failed",
    steps: [{
      nodeId: "old",
      label: "Old",
      status: "failed",
      durationMs: 0,
      error: "旧错误",
    }],
    tags: [],
    trial: false,
    error: "旧错误",
  };
  assertEquals(JSON.parse(JSON.stringify(historical)), historical);
});
