import { assertEquals, assertThrows } from "@std/assert";
import { compileGraph, parseGraph } from "../src/graph/compile.ts";
import { validateOutput, validateSchema } from "../src/graph/schema.ts";
import { graphTemplate } from "../src/graph/templates.ts";

Deno.test("graph rejects cycles and outputs unavailable on one branch", () => {
  const graph = graphTemplate("classification");
  graph.edges.push({ from: "done", to: "start", port: "next" });
  assertThrows(() => compileGraph(graph));
  const branch = graphTemplate("classification");
  branch.edges = branch.edges.filter((edge) => edge.from !== "start");
  branch.edges.push({ from: "start", to: "match", port: "next" });
  assertThrows(() => compileGraph(branch), Error, "不可用");
});

Deno.test("optimizer batches only explicit independent adjacent AI tasks", () => {
  const graph = graphTemplate("classification");
  const first = graph.nodes.find((node) => node.kind === "ai")!;
  if (first.kind !== "ai") throw new Error("fixture");
  const second = { ...structuredClone(first), id: "summary", label: "摘要" };
  graph.nodes.push(second);
  graph.edges.find((edge) => edge.from === first.id)!.to = second.id;
  graph.edges.push({ from: second.id, to: "match", port: "next" });
  assertEquals(compileGraph(graph).batches, []);
  first.batchGroup = second.batchGroup = "mail";
  assertEquals(compileGraph(graph).batches, [[first.id, second.id]]);
  second.inputs = { previous: `nodes.${first.id}.data?.category` };
  assertEquals(compileGraph(graph).batches, []);
});

Deno.test("graph rejects executable/prototype paths and unsupported schema keywords", () => {
  const graph = graphTemplate("classification");
  const ai = graph.nodes.find((node) => node.kind === "ai")!;
  if (ai.kind !== "ai") throw new Error("fixture");
  ai.inputs = { attack: "email.__proto__.secret" };
  assertThrows(() => parseGraph(graph));
  assertThrows(() => validateSchema({ type: "string", pattern: "(a+)+$" }));
  assertThrows(() => validateSchema({ $ref: "https://example.com/schema" }));
});

Deno.test("structured output validation enforces nested types and bounds", () => {
  const schema = validateSchema({
    type: "object",
    additionalProperties: false,
    required: ["codes"],
    properties: {
      codes: {
        type: "array",
        maxItems: 2,
        items: { type: "string", maxLength: 8 },
      },
    },
  });
  validateOutput({ codes: ["001234"] }, schema);
  assertThrows(() => validateOutput({ codes: [1234] }, schema));
  assertThrows(() => validateOutput({ codes: [], injected: true }, schema));
  assertThrows(() => validateOutput({ codes: ["123456789"] }, schema));
});
