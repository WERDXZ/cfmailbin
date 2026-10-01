import { en } from "../src/ui/locales/en.ts";
import { zhCN } from "../src/ui/locales/zh-CN.ts";
import { formatMessage, localizedMessage } from "../src/ui/messages.ts";
import {
  localizedGraphTemplate,
  localizedPreset,
  policyTemplateLabel,
  presetLabel,
} from "../src/ui/templates.ts";
import { builtInPresets } from "../src/graph/library.ts";
import { builtInPolicies } from "../src/graph/policies.ts";
import { compileGraph } from "../src/graph/compile.ts";
import { assertEquals } from "@std/assert";
import {
  localeCookie,
  readLocaleCookie,
  resolveLocale,
} from "../src/domain/locale.ts";
import { translator } from "../src/ui/translate.ts";

Deno.test("browser override wins over account; missing language falls back to English", () => {
  assertEquals(resolveLocale(null, undefined), "en");
  assertEquals(resolveLocale(null, "en"), "en");
  assertEquals(resolveLocale("zh-CN", "en"), "zh-CN");
  assertEquals(resolveLocale("en", "zh-CN"), "en");
  assertEquals(resolveLocale("fr", "en"), "en");
  assertEquals(resolveLocale("constructor", "fr"), "en");
});

Deno.test("automatic account language uses the browser locale and falls back to English", () => {
  for (const language of ["zh", "zh-CN", "zh-Hans-CN", "ZH-tw", "zh-HK"]) {
    assertEquals(resolveLocale(null, "auto", language), "zh-CN");
    assertEquals(resolveLocale(null, undefined, language), "zh-CN");
  }
  for (
    const language of ["en-US", "en-GB", "fr-FR", "ja", "", null, undefined]
  ) {
    assertEquals(resolveLocale(null, "auto", language), "en");
  }
  assertEquals(resolveLocale(null, "zh-CN", "en-US"), "zh-CN");
  assertEquals(resolveLocale(null, "en", "zh-CN"), "en");
  assertEquals(resolveLocale("zh-CN", "en", "en-US"), "zh-CN");
  assertEquals(resolveLocale("en", "zh-CN", "zh-CN"), "en");
  assertEquals(resolveLocale("auto", "auto", "zh-CN"), "zh-CN");
});

Deno.test("language cookies are validated, scoped to all routes and can be removed", () => {
  assertEquals(readLocaleCookie("other=en; cfmailbin_locale=en"), "en");
  assertEquals(readLocaleCookie("cfmailbin_locale=zh%2DCN"), "zh-CN");
  assertEquals(readLocaleCookie("cfmailbin_locale=%E0%A4%A"), null);
  assertEquals(readLocaleCookie("cfmailbin_locale=fr"), null);
  assertEquals(readLocaleCookie("CF_Authorization=en"), null);
  assertEquals(
    localeCookie("en", true),
    "cfmailbin_locale=en; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
  );
  assertEquals(
    localeCookie(null, false),
    "cfmailbin_locale=; Path=/; Max-Age=0; SameSite=Lax",
  );
});

Deno.test("i18next resolves semantic keys and interpolates user values literally", () => {
  assertEquals(translator("zh-CN")("settings.language"), "语言");
  assertEquals(translator("en")("settings.language"), "Language");
  assertEquals(translator("en")("common.copy"), "Copy");
  assertEquals(
    translator("en")("inbox.copyAddress", {
      address: "<script>{{other}}</script>",
    }),
    "Copy address <script>{{other}}</script>",
  );
});

Deno.test("i18next selects English plurals and Chinese count forms", () => {
  assertEquals(translator("en")("graph.nodeCount", { count: 1 }), "1 node");
  assertEquals(translator("en")("graph.nodeCount", { count: 2 }), "2 nodes");
  assertEquals(
    translator("zh-CN")("graph.nodeCount", { count: 2 }),
    "2 个节点",
  );
});

Deno.test("catalogs have matching semantic keys and interpolation parameters", () => {
  assertEquals(Object.keys(zhCN).sort(), Object.keys(en).sort());
  const parameters = (text: string) =>
    [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
  for (const key of Object.keys(en) as (keyof typeof en)[]) {
    assertEquals(
      /^[a-z]+\.[a-zA-Z][a-zA-Z0-9.]*(_one|_other)?$/.test(key),
      true,
      key,
    );
    assertEquals(parameters(zhCN[key]), parameters(en[key]), key);
    assertEquals(/\{\d+\}/.test(en[key]), false, key);
  }
});

Deno.test("only explicit message codes are localized; user text and old errors stay literal", () => {
  const t = translator("en");
  assertEquals(formatMessage("复制", t), "复制");
  assertEquals(formatMessage(new Error("复制"), t), "复制");
  assertEquals(
    formatMessage({ message: "Original error", code: "unknown.code" }, t),
    "Original error",
  );
  assertEquals(
    formatMessage({ message: "Original error", code: "constructor" }, t),
    "Original error",
  );
  const notice = localizedMessage("common.copy");
  assertEquals(formatMessage(notice, t), "Copy");
  assertEquals(formatMessage(notice, translator("zh-CN")), "复制");
  assertEquals(
    formatMessage({
      message: "fallback",
      code: "inbox.copyAddress",
      params: { address: "复制 {{common.copy}} <b>", lng: "zh-CN" },
    }, t),
    "Copy address 复制 {{common.copy}} <b>",
  );
});

Deno.test("built-in templates create localized drafts without changing custom snapshots or prompts", () => {
  const t = translator("en");
  for (const preset of builtInPresets) {
    const before = structuredClone(preset);
    const draft = localizedPreset(preset, t);
    assertEquals(
      /[\p{Script=Han}]/u.test(presetLabel(preset, t)),
      false,
      preset.id,
    );
    assertEquals(/[\p{Script=Han}]/u.test(draft.node.label), false, preset.id);
    if (preset.node.kind === "ai" && draft.node.kind === "ai") {
      assertEquals(draft.node.prompt, preset.node.prompt);
    }
    for (const node of draft.fragment?.nodes ?? []) {
      assertEquals(/[\p{Script=Han}]/u.test(node.label), false, node.id);
    }
    assertEquals(preset, before);
    const custom = {
      ...preset,
      id: "my_node",
      node: { ...preset.node, label: "复制" },
    };
    assertEquals(localizedPreset(custom, t), custom);
    assertEquals(presetLabel(custom, t), "复制");
  }
  for (const policy of builtInPolicies) {
    assertEquals(
      /[\p{Script=Han}]/u.test(policyTemplateLabel(policy, t)),
      false,
      policy.id,
    );
  }
  for (const kind of ["blank", "classification", "verification"] as const) {
    const graph = localizedGraphTemplate(kind, t);
    for (const node of graph.nodes) {
      assertEquals(/[\p{Script=Han}]/u.test(node.label), false, node.id);
    }
    compileGraph(graph);
  }
});

Deno.test("custom template IDs cannot collide with object prototype names", () => {
  const t = translator("en");
  for (const id of ["constructor", "toString", "__proto__"]) {
    const preset = {
      ...builtInPresets[0],
      id,
      node: { ...builtInPresets[0].node, label: "复制" },
    };
    assertEquals(localizedPreset(preset, t), preset);
    assertEquals(presetLabel(preset, t), "复制");
    assertEquals(
      policyTemplateLabel({ ...builtInPolicies[0], id, name: "复制" }, t),
      "复制",
    );
  }
});

Deno.test("localized AI errors retain the structured HTTP diagnostic", () => {
  const error = {
    message: "AI 服务异常 · HTTP 503",
    code: "common.aiServiceError",
    params: { httpStatus: 503 },
  };
  assertEquals(
    formatMessage(error, translator("en")),
    "AI service error · HTTP 503",
  );
  assertEquals(
    formatMessage(error, translator("zh-CN")),
    "AI 服务异常 · HTTP 503",
  );
});
