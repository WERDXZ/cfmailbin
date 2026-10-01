import type { IncomingMessage, MessageContent } from "../domain/models.ts";

/** Preserve unknown on incomplete parsing; a found code is still positive evidence. */
export function withContent(
  message: IncomingMessage,
  content?: MessageContent,
): IncomingMessage {
  const complete = !!content && !content.warning && !content.truncated;
  return {
    ...message,
    body: content && !content.warning ? content.text : undefined,
    hasCode: content?.codes.length ? true : complete ? false : message.hasCode,
    contentComplete: complete,
  };
}
