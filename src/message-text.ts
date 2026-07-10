/** Extract user-visible text/captions through common WhatsApp wrappers. */
export function extractMessageText(message: any, depth = 0): string | undefined {
  if (!message || depth > 4) return undefined;
  const direct =
    message.conversation ??
    message.extendedTextMessage?.text ??
    message.imageMessage?.caption ??
    message.videoMessage?.caption ??
    message.documentMessage?.caption;
  if (typeof direct === "string") return direct;

  const wrapped =
    message.documentWithCaptionMessage?.message ??
    message.ephemeralMessage?.message ??
    message.viewOnceMessage?.message ??
    message.viewOnceMessageV2?.message ??
    message.viewOnceMessageV2Extension?.message;
  return wrapped ? extractMessageText(wrapped, depth + 1) : undefined;
}
