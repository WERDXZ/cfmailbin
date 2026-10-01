export const eventStreamHeaders = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store, no-transform",
  "x-content-type-options": "nosniff",
};

export interface Realtime {
  subscribe(): Promise<ReadableStream<Uint8Array>> | ReadableStream<Uint8Array>;
  publish(): Promise<void> | void;
}

/** Ephemeral invalidations only. D1 remains authoritative, including on reconnect. */
export class InboxEvents implements Realtime {
  private listeners = new Set<() => void>();

  constructor(private options = { lifetimeMs: 55_000, heartbeatMs: 15_000 }) {}

  subscribe(): ReadableStream<Uint8Array> {
    if (this.listeners.size >= 32) {
      throw new Error("Too many inbox subscriptions");
    }
    const encoder = new TextEncoder();
    let cleanup = () => {};
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        let closed = false;
        const send = (value: string) => {
          if (!closed && (controller.desiredSize ?? 0) > 0) {
            controller.enqueue(encoder.encode(value));
          }
        };
        const notify = () => send("event: change\ndata: {}\n\n");
        const heartbeat = setInterval(
          () => send(": heartbeat\n\n"),
          this.options.heartbeatMs,
        );
        const expiry = setTimeout(() => {
          cleanup();
          controller.close();
        }, this.options.lifetimeMs);
        cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          clearTimeout(expiry);
          this.listeners.delete(notify);
        };
        this.listeners.add(notify);
        send("retry: 1000\nevent: ready\ndata: {}\n\n");
      },
      cancel: () => cleanup(),
    });
  }

  publish(): void {
    for (const notify of this.listeners) notify();
  }
}

export async function notifyInbox(events?: Realtime): Promise<void> {
  try {
    await events?.publish();
  } catch {
    console.error("Inbox update notification failed");
  }
}
