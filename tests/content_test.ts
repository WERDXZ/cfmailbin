import { assertEquals, assertMatch } from "@std/assert";
import { generateAliasAddress } from "../src/domain/aliases.ts";
import {
  findVerificationCodes,
  parseMessageContent,
  readMessageContent,
} from "../src/email/content.ts";

Deno.test("registration aliases have a site label, random suffix and no plus tag", () => {
  const one = generateAliasAddress("GitHub", "MAIL.Example.com");
  assertMatch(one, /^github-[a-f0-9]{12}@mail\.example\.com$/);
  assertEquals(
    one === generateAliasAddress("GitHub", "mail.example.com"),
    false,
  );
  assertMatch(
    generateAliasAddress("中文网站", "mail.example.com"),
    /^account-/,
  );
  for (
    const domain of [
      "",
      "https://example.com",
      "a@b.com",
      "x.com/path",
      "x.com:80",
      "-x.com",
      "x..com",
      "localhost",
    ]
  ) {
    let rejected = false;
    try {
      generateAliasAddress("site", domain);
    } catch {
      rejected = true;
    }
    assertEquals(rejected, true, domain);
  }
});

Deno.test("verification codes need context, preserve zeros and exclude ordinary IDs", () => {
  assertEquals(findVerificationCodes("Your GitHub launch code is: a8b2c9."), [
    "a8b2c9",
  ]);
  assertEquals(findVerificationCodes("您的验证码是：004218，十分钟内有效。"), [
    "004218",
  ]);
  assertEquals(findVerificationCodes("Your verification code is A8B2C9."), [
    "A8B2C9",
  ]);
  assertEquals(findVerificationCodes("123456 is your login code."), ["123456"]);
  assertEquals(
    findVerificationCodes("Your code is 009 821", "Verification code"),
    ["009821"],
  );
  assertEquals(
    findVerificationCodes(
      "\n042109\nExpires in 10 minutes.",
      "Your verification code",
    ),
    ["042109"],
  );
  assertEquals(
    findVerificationCodes(
      "Order 123456 shipped on 2026-09-29. Phone: 1234567890.",
    ),
    [],
  );
  assertEquals(
    findVerificationCodes(
      "Your verification code is 001234. Order ID: 987654.",
    ),
    ["001234"],
  );
  assertEquals(
    findVerificationCodes("Verification is required. Order ID: 987654."),
    [],
  );
});

Deno.test("quoted-printable mail keeps verification links and split digits", async () => {
  const content = await parseMessageContent(
    new TextEncoder().encode(
      "Subject: Email verification code\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nYour code is 001 234.\r\nhttps://example.com/verify?token=3Da1b2",
    ),
  );
  assertEquals(content.codes, ["001234"]);
  assertEquals(content.links[0].url, "https://example.com/verify?token=a1b2");
});

Deno.test("MIME decodes base64 body and encoded subjects", async () => {
  const content = await parseMessageContent(new TextEncoder().encode([
    "Subject: =?UTF-8?B?VmVyaWZpY2F0aW9uIGNvZGU=?=",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    btoa("Your verification code is 004218."),
  ].join("\r\n")));
  assertEquals(content.subject, "Verification code");
  assertEquals(content.codes, ["004218"]);
  assertEquals(content.text, "Your verification code is 004218.");
});

Deno.test("HTML-only mail exposes text and explicit safe links without scripts or images", async () => {
  const content = await parseMessageContent(new TextEncoder().encode(
    'Subject: Verify\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<style>code 123456</style><script>verification code 999999</script><p>验证码：<b>012345</b>&nbsp;</p><a href="https://accounts.example.com/verify?a=1&amp;b=2">激活账号</a><a href="javascript:alert(1)">bad</a><img src="https://tracker.example.com/pixel"><a href="https://user:pass@example.com">credentials</a>',
  ));
  assertEquals(content.codes, ["012345"]);
  assertEquals(content.text.includes("999999"), false);
  assertEquals(content.links, [{
    url: "https://accounts.example.com/verify?a=1&b=2",
    label: "激活账号",
  }]);
  assertEquals(content.text.includes("<"), false);
});

Deno.test("attachment codes are not promoted into message content", async () => {
  const raw = [
    "Subject: Receipt",
    'Content-Type: multipart/mixed; boundary="test"',
    "",
    "--test",
    "Content-Type: text/plain",
    "",
    "Order 123456",
    "--test",
    "Content-Type: text/plain",
    'Content-Disposition: attachment; filename="secret.txt"',
    "",
    "Your verification code is 654321",
    "--test--",
  ].join("\r\n");
  const content = await parseMessageContent(new TextEncoder().encode(raw));
  assertEquals(content.codes, []);
  assertEquals(content.text.includes("654321"), false);
});

Deno.test("oversized MIME streams are cancelled and offer a raw-download fallback", async () => {
  let cancelled = false;
  const content = await readMessageContent(
    new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024 + 1));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  assertEquals(content.warning, "too_large");
  assertEquals(content.codes, []);
  assertEquals(cancelled, true);
});
