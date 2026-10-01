import { GraphError, type JsonValue } from "./types.ts";

type ScalarType = "string" | "number" | "integer" | "boolean" | "null";
export interface JsonSchema {
  type: ScalarType | "object" | "array" | [ScalarType, "null"];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: JsonSchema;
  enum?: (string | number | boolean | null)[];
  maxLength?: number;
  maxItems?: number;
}
export const safeKey = (key: string) =>
  /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key) &&
  !["constructor", "prototype", "__proto__"].includes(key);

export function validateSchema(input: unknown, depth = 0): JsonSchema {
  const fail = () => {
    throw new GraphError(
      "JSON Schema 无效：支持 object、array、基础类型、enum 和长度上限",
      "errors.invalidJsonSchemaSupportsObjectsArraysScalar",
    );
  };
  if (
    depth > 5 || !input || typeof input !== "object" || Array.isArray(input)
  ) return fail();
  const s = input as Record<string, unknown>;
  const types = [
    "string",
    "number",
    "integer",
    "boolean",
    "null",
    "object",
    "array",
  ];
  if (Array.isArray(s.type)) {
    if (
      s.type.length !== 2 || s.type[1] !== "null" ||
      !types.slice(0, 4).includes(s.type[0])
    ) fail();
  } else if (!types.includes(s.type as string)) fail();
  const allowed = ["type", "enum"];
  if (s.type === "object") {
    allowed.push("properties", "required", "additionalProperties");
  }
  if (s.type === "array") allowed.push("items", "maxItems");
  if (s.type === "string" || Array.isArray(s.type) && s.type[0] === "string") {
    allowed.push("maxLength");
  }
  if (Object.keys(s).some((key) => !allowed.includes(key))) fail();
  if (s.type === "object") {
    if (
      !s.properties || typeof s.properties !== "object" ||
      Array.isArray(s.properties) || s.additionalProperties !== false
    ) return fail();
    const keys = Object.keys(s.properties);
    if (
      keys.length > 16 || keys.some((key) => !safeKey(key)) ||
      !Array.isArray(s.required) || s.required.length !== keys.length ||
      new Set(s.required).size !== keys.length || keys.some((key) =>
        !(s.required as unknown[]).includes(key)
      )
    ) fail();
    for (const value of Object.values(s.properties)) {
      validateSchema(value, depth + 1);
    }
  }
  if (s.type === "array") validateSchema(s.items, depth + 1);
  for (const [key, max] of [["maxLength", 12000], ["maxItems", 100]] as const) {
    if (
      s[key] !== undefined &&
      (!Number.isInteger(s[key]) || Number(s[key]) < 0 || Number(s[key]) > max)
    ) fail();
  }
  if (
    s.enum !== undefined &&
    (!Array.isArray(s.enum) || !s.enum.length || s.enum.length > 32 ||
      s.enum.some((v) =>
        v !== null && !["string", "number", "boolean"].includes(typeof v)
      ))
  ) fail();
  return structuredClone(s) as unknown as JsonSchema;
}

export function validateOutput(
  value: unknown,
  schema: JsonSchema,
): asserts value is JsonValue {
  const type = Array.isArray(schema.type)
    ? (value === null ? "null" : schema.type[0])
    : schema.type;
  let valid = type === "null"
    ? value === null
    : type === "array"
    ? Array.isArray(value)
    : type === "object"
    ? !!value && typeof value === "object" && !Array.isArray(value)
    : type === "integer"
    ? Number.isInteger(value)
    : type === "number"
    ? typeof value === "number" && Number.isFinite(value)
    : type === "boolean"
    ? typeof value === "boolean"
    : typeof value === "string";
  if (schema.enum && !schema.enum.includes(value as string)) valid = false;
  if (typeof value === "string" && value.length > (schema.maxLength ?? 12000)) {
    valid = false;
  }
  if (!valid) {
    throw new GraphError(
      "AI 输出不符合 JSON Schema",
      "common.aiOutputDoesNotMatchTheJson",
    );
  }
  if (type === "object") {
    const object = value as Record<string, unknown>;
    const properties = schema.properties!;
    if (
      Object.keys(object).some((key) => !Object.hasOwn(properties, key)) ||
      schema.required!.some((key) => !Object.hasOwn(object, key))
    ) {
      throw new GraphError(
        "AI 输出字段不符合 JSON Schema",
        "common.aiOutputFieldsDoNotMatchThe",
      );
    }
    for (const [key, child] of Object.entries(properties)) {
      validateOutput(object[key], child);
    }
  }
  if (type === "array") {
    const list = value as unknown[];
    if (list.length > (schema.maxItems ?? 100)) {
      throw new GraphError(
        "AI 输出数组过长",
        "common.aiOutputArrayIsTooLong",
      );
    }
    for (const child of list) validateOutput(child, schema.items!);
  }
}
