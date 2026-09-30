import { Parser } from "htmlparser2";

function escape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Reduced, inert markup; only ever render inside an empty-sandbox iframe. */
export function emailHtmlPreview(html: string): string | undefined {
  if (!html || html.length > 200_000) return;
  const tags = new Set([
    "div",
    "span",
    "p",
    "br",
    "hr",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "td",
    "th",
    "b",
    "strong",
    "i",
    "em",
    "u",
    "s",
    "small",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "li",
    "blockquote",
    "pre",
    "code",
    "a",
    "style",
  ]);
  const blocked = new Set([
    "script",
    "svg",
    "math",
    "template",
    "iframe",
    "object",
    "embed",
    "form",
    "textarea",
    "noscript",
  ]);
  const parts: string[] = [];
  let ignored = 0;
  const parser = new Parser({
    onopentag(name, attrs) {
      if (blocked.has(name)) ignored++;
      if (ignored) return;
      if (name === "img") {
        if (attrs.alt) parts.push(`<span>${escape(attrs.alt)}</span>`);
        return;
      }
      if (!tags.has(name)) return;
      const attributes: string[] = [];
      for (
        const key of [
          "style",
          "class",
          "title",
          "align",
          "dir",
          "width",
          "height",
          "colspan",
          "rowspan",
          "cellpadding",
          "cellspacing",
          "border",
          "bgcolor",
        ]
      ) {
        if (attrs[key]) attributes.push(`${key}="${escape(attrs[key])}"`);
      }
      parts.push(
        `<${name}${attributes.length ? " " + attributes.join(" ") : ""}>`,
      );
    },
    ontext(text) {
      if (!ignored) parts.push(escape(text));
    },
    onclosetag(name) {
      if (blocked.has(name)) {
        ignored = Math.max(0, ignored - 1);
        return;
      }
      if (!ignored && tags.has(name) && !["br", "hr"].includes(name)) {
        parts.push(`</${name}>`);
      }
    },
  }, { decodeEntities: true });
  parser.end(html);
  // No links, remote resources, forms, scripts, same-origin access or parent navigation.
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><style>body{margin:16px;color:#171717;background:#fff;font:14px/1.6 system-ui,sans-serif;overflow-wrap:anywhere}table{max-width:100%}pre{white-space:pre-wrap}a{color:#0958d9}</style></head><body>${
    parts.join("")
  }</body></html>`;
}
