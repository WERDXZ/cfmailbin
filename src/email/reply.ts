import type { ForwardableEmailMessage } from "../platform/cloudflare.ts";
import { GraphError } from "../graph/types.ts";

/** The native builder encodes MIME; addresses never come from workflow/model output. */
export async function replyToIncoming(
  message: ForwardableEmailMessage,
  text: string,
) {
  if (!message.reply) {
    throw new GraphError("当前环境不能回复邮件", "errors.replyUnavailable");
  }
  const automated = message.headers.get("auto-submitted")?.trim().toLowerCase();
  if (!message.from || automated && automated !== "no") {
    throw new GraphError(
      "不回复退信或自动回复邮件，避免回复循环",
      "errors.automatedReplyBlocked",
    );
  }
  const subject = Array.from(message.headers.get("subject") ?? "").map((c) =>
    c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c
  ).join("").slice(0, 500);
  try {
    await message.reply({
      from: message.to,
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      text,
      // reply(builder) adds In-Reply-To / References from the native event.
      headers: { "Auto-Submitted": "auto-replied" },
    });
  } catch {
    throw new GraphError(
      "回复未确认，请检查 Cloudflare 投递记录和来信 DMARC；原邮件已保留，不会自动重试",
      "errors.replyUnconfirmedDmarc",
    );
  }
}
