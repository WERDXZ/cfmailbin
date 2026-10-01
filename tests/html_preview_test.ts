import { assertEquals, assertStringIncludes } from "@std/assert";
import { emailHtmlPreview } from "../src/email/html-preview.ts";
import {
  findVerificationCodes,
  parseMessageContent,
} from "../src/email/content.ts";

Deno.test("HTML preview keeps formatting but removes active elements, navigation and images", () => {
  const result = emailHtmlPreview(
    `<meta http-equiv="refresh" content="0;url=https://tracker.test"><base href="https://tracker.test">
    <script>parent.document.cookie</script><svg onload="steal()"><foreignObject><script>steal()</script></foreignObject></svg>
    <form action="/api/settings"><input name="aiEnabled" value="true"></form>
    <iframe src="https://tracker.test"></iframe><img src="https://tracker.test/pixel" onerror="steal()" alt="Logo">
    <table><tr><td style="color:blue" onclick="steal()">Code <b>001234</b></td></tr></table>
    <a href="javascript:steal()" target="_top">Verify</a>`,
  )!;
  assertStringIncludes(result, "<b>001234</b>");
  assertStringIncludes(result, "default-src 'none'");
  for (
    const forbidden of [
      "steal",
      "document.cookie",
      "<form",
      "<input",
      "<iframe",
      "<svg",
      "<img",
      "href=",
      "onclick=",
      "tracker.test",
    ]
  ) {
    assertEquals(result.includes(forbidden), false, forbidden);
  }
  assertEquals(emailHtmlPreview("x".repeat(200_001)), undefined);
});

Deno.test("MIME content offers an isolated HTML preview alongside text and safe extracted links", async () => {
  const content = await parseMessageContent(
    new TextEncoder().encode(
      'Subject: Code\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Your verification code is <b>001234</b></p><a href="https://example.com/verify">Activate</a>',
    ),
  );
  assertStringIncludes(content.html!, "<b>001234</b>");
  assertEquals(content.codes, []);
  assertEquals(findVerificationCodes(content.text, content.subject), [
    "001234",
  ]);
  assertEquals(content.links[0].url, "https://example.com/verify");
});
