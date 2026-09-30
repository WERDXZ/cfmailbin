import PostalMime from "postal-mime";
import { Parser } from "htmlparser2";
import type { MessageContent } from "../domain/models.ts";
import { emailHtmlPreview } from "./html-preview.ts";

const MAX_MIME_BYTES = 1024 * 1024;
const MAX_TEXT_LENGTH = 50_000;
const marker = String
  .raw`(?:验证码|校验码|动态码|安全码|一次性密码|(?:verification|security|confirmation|authentication|login|sign[ -]?in|access|reset|launch|email|account)[ -]*(?:code|pin)|one[ -]time (?:password|code)|otp|passcode)`;
const markerPattern = new RegExp(marker, "i");

export function findVerificationCodes(text: string, subject = ""): string[] {
  const result: string[] = [];
  const subjectHasContext = markerPattern.test(subject);
  const prefix = new RegExp(
    `${marker}${subjectHasContext ? "|\\bcode" : ""}`,
    "gi",
  );
  const candidates =
    /(?<![a-zA-Z0-9])(?:\d{3}[ -]\d{3}|\d{4,8}|[a-zA-Z0-9]{6,10})(?![a-zA-Z0-9])/g;
  for (const match of `${subject}\n${text}`.matchAll(candidates)) {
    const code = match[0].replace(/[ -]/g, "");
    if (
      !/^\d{4,8}$/.test(code) &&
      !/^(?=.*[a-z])(?=.*\d)[a-z0-9]{6,10}$/i.test(code)
    ) continue;
    const input = match.input!;
    const before = input.slice(Math.max(0, match.index - 80), match.index);
    const after = input.slice(
      match.index + match[0].length,
      match.index + match[0].length + 70,
    );
    const markers = Array.from(before.matchAll(prefix));
    const last = markers.at(-1);
    const bridge = last ? before.slice(last.index! + last[0].length) : "";
    const followsMarker = !!last &&
      /^[\s:：=,，"'「」【】()（）-]*(?:(?:is|为|是)[\s:：]*)?$/i.test(bridge);
    const precedesMarker = new RegExp(
      `^[\\s:：,，]*is (?:your |the )?${marker}`,
      "i",
    ).test(after);
    const standalone = subjectHasContext && /(?:^|\n)\s*$/.test(before) &&
      /^\s*(?:\n|$)/.test(after);
    if (
      (followsMarker || precedesMarker || standalone) && !result.includes(code)
    ) {
      result.push(code);
      if (result.length === 3) break;
    }
  }
  return result;
}

function safeUrl(value: string): string | undefined {
  if (value.length > 4096) return;
  try {
    const url = new URL(value);
    if (
      ["https:", "http:"].includes(url.protocol) && !url.username &&
      !url.password
    ) return url.href;
  } catch { /* Relative and malformed links are not actionable. */ }
}

function htmlText(
  html: string,
): { text: string; links: MessageContent["links"] } {
  const chunks: string[] = [];
  const links: MessageContent["links"] = [];
  const ignored = new Set(["script", "style", "head", "svg", "template"]);
  const blocks = new Set([
    "p",
    "div",
    "br",
    "hr",
    "tr",
    "li",
    "h1",
    "h2",
    "h3",
    "table",
    "section",
  ]);
  let ignoredDepth = 0;
  let anchor: { url: string; label: string } | undefined;
  const parser = new Parser({
    onopentag(name, attrs) {
      if (ignored.has(name)) ignoredDepth++;
      if (ignoredDepth) return;
      if (blocks.has(name)) chunks.push("\n");
      if (name === "a") {
        const url = safeUrl(attrs.href ?? "");
        anchor = url ? { url, label: "" } : undefined;
      }
    },
    ontext(value) {
      if (ignoredDepth) return;
      chunks.push(value);
      if (anchor) anchor.label += value;
    },
    onclosetag(name) {
      if (ignored.has(name)) {
        ignoredDepth = Math.max(0, ignoredDepth - 1);
        return;
      }
      if (ignoredDepth) return;
      if (name === "a" && anchor) {
        if (
          links.length < 20 && !links.some((link) => link.url === anchor!.url)
        ) {
          links.push({
            url: anchor.url,
            label: anchor.label.trim().slice(0, 160) ||
              new URL(anchor.url).hostname,
          });
        }
        anchor = undefined;
      }
      if (blocks.has(name)) chunks.push("\n");
    },
  }, { decodeEntities: true });
  parser.end(html);
  return { text: chunks.join(""), links };
}

function unavailable(warning: MessageContent["warning"]): MessageContent {
  return {
    subject: "",
    text: "",
    codes: [],
    links: [],
    truncated: false,
    warning,
  };
}

export async function parseMessageContent(
  raw: Uint8Array,
): Promise<MessageContent> {
  if (raw.byteLength > MAX_MIME_BYTES) return unavailable("too_large");
  try {
    const email = await PostalMime.parse(raw, {
      maxNestingDepth: 32,
      maxHeadersSize: 64 * 1024,
      forceRfc822Attachments: true,
      maxRfc822NestingDepth: 0,
    });
    const html = htmlText(email.html ?? "");
    const fullText = (email.text?.trim() || html.text).replace(/\r\n?/g, "\n")
      .replace(/[\t \u00a0]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    const text = fullText.slice(0, MAX_TEXT_LENGTH);
    const links = html.links;
    for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
      const url = safeUrl(match[0].replace(/[.,;!)]+$/, ""));
      if (url && links.length < 20 && !links.some((link) => link.url === url)) {
        links.push({ url, label: new URL(url).hostname });
      }
    }
    return {
      subject: email.subject ?? "",
      text,
      html: emailHtmlPreview(email.html ?? ""),
      links,
      codes: findVerificationCodes(text, email.subject),
      truncated: fullText.length > MAX_TEXT_LENGTH,
    };
  } catch {
    return unavailable("parse_failed");
  }
}

/** Read a bounded amount from R2; large messages remain downloadable as MIME. */
export async function readMessageContent(
  stream: ReadableStream<Uint8Array>,
): Promise<MessageContent> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_MIME_BYTES) {
        await reader.cancel();
        return unavailable("too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const raw = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return await parseMessageContent(raw);
}
