import { GraphError, type JsonValue, type TokenFormat } from "./types.ts";

export interface TextToken {
  value: string;
  raw: string;
  before: string;
  after: string;
  standalone: boolean;
}
const normalize = (text: string) =>
  text.replace(/[\s:：=,，"'「」【】()（）-]+/g, " ").trim();

/** Patterns are assembled only from validated bounds and fixed character sets. */
export function extractTokens(
  text: string,
  formats: TokenFormat[],
  before: number,
  after: number,
  normalizeContext: boolean,
): { items: TextToken[]; truncated: boolean } {
  const patterns = formats.flatMap((format) => [
    ...(format.characters === "digits" && format.groupDigits
      ? ["\\d{3}[ -]\\d{3}"]
      : []),
    `${
      format.characters === "digits" ? "\\d" : "[a-zA-Z0-9]"
    }{${format.min},${format.max}}`,
  ]);
  const regex = new RegExp(
    `(?<![a-zA-Z0-9])(?:${patterns.join("|")})(?![a-zA-Z0-9])`,
    "g",
  );
  const items: TextToken[] = [];
  for (const match of text.matchAll(regex)) {
    const raw = match[0], value = raw.replace(/[ -]/g, "");
    if (
      !formats.some((format) =>
        value.length >= format.min && value.length <= format.max &&
        (format.characters === "digits"
          ? /^\d+$/.test(value)
          : /[a-z]/i.test(value) && /\d/.test(value))
      )
    ) continue;
    if (items.length === 200) return { items, truncated: true };
    const leading = text.slice(Math.max(0, match.index - before), match.index);
    const trailing = text.slice(
      match.index + raw.length,
      match.index + raw.length + after,
    );
    const nextLine = text.indexOf("\n", match.index + raw.length);
    items.push({
      value,
      raw,
      before: normalizeContext ? normalize(leading) : leading,
      after: normalizeContext ? normalize(trailing) : trailing,
      standalone:
        !text.slice(text.lastIndexOf("\n", match.index - 1) + 1, match.index)
          .trim() &&
        !text.slice(
          match.index + raw.length,
          nextLine < 0 ? text.length : nextLine,
        ).trim(),
    });
  }
  return { items, truncated: false };
}

export function collectCodes(
  input: JsonValue,
  source: string,
  limit: number,
): string[] {
  if (!Array.isArray(input) || input.length > 200) {
    throw new GraphError(
      "验证码输出需要候选项数组",
      "errors.codeCandidateArrayRequired",
    );
  }
  const codes: string[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new GraphError(
        "候选验证码与邮件原文不符",
        "errors.codeCandidateSourceMismatch",
      );
    }
    // Token nodes supply raw/value; AI templates supply value with exact context.
    const raw = item.raw ?? item.value;
    if (
      typeof raw !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9 -]{2,30}[a-zA-Z0-9]$/.test(raw) ||
      typeof item.value !== "string" ||
      item.raw !== undefined && item.value !== raw.replace(/[ -]/g, "")
    ) {
      throw new GraphError(
        "候选验证码与邮件原文不符",
        "errors.codeCandidateSourceMismatch",
      );
    }
    const value = raw.replace(/[ -]/g, "");
    const pattern = new RegExp(`(?<![a-zA-Z0-9])${raw}(?![a-zA-Z0-9])`);
    if (
      value.length < 4 || value.length > 12 || !pattern.test(source) ||
      (item.raw === undefined || item.context !== undefined) &&
        (typeof item.context !== "string" || item.context.length > 200 ||
          !source.includes(item.context) || !pattern.test(item.context))
    ) {
      throw new GraphError(
        "候选验证码与邮件原文不符",
        "errors.codeCandidateSourceMismatch",
      );
    }
    if (!codes.includes(value)) codes.push(value);
    if (codes.length === limit) break;
  }
  return codes;
}
