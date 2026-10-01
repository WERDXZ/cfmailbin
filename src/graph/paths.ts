import { GraphError } from "./types.ts";
import { safeKey } from "./schema.ts";

const emailFields = [
  "subject",
  "text",
  "body",
  "from",
  "fromDomain",
  "to",
  "codes",
  "localCodes",
  "truncated",
  "subjectTruncated",
  "textTruncated",
  "bodyTruncated",
  "unavailable",
];
export function pathParts(path: string, allowItem = false): string[] {
  if (typeof path !== "string" || path.length > 320) {
    throw new GraphError("输入路径无效", "errors.invalidInputPath");
  }
  const parts = path.replaceAll("?.", ".").split(".");
  if (
    parts.some((part) => !safeKey(part)) ||
    !(parts[0] === "email" && parts.length === 2 &&
        emailFields.includes(parts[1]) ||
      parts[0] === "current" && parts[1] === "parent" && parts.length >= 3 &&
        parts.length <= 8 ||
      parts[0] === "nodes" && parts.length >= 3 && parts.length <= 8 ||
      allowItem && parts[0] === "item" && parts.length === 2 &&
        ["value", "raw", "before", "after", "standalone"].includes(parts[1]))
  ) {
    const displayPath = path.slice(0, 120);
    throw new GraphError(
      `输入路径无效：${displayPath}`,
      "errors.invalidInputPathWithValue",
      { path: displayPath },
    );
  }
  return parts;
}
