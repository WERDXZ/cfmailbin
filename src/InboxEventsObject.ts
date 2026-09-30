import { DurableObject } from "cloudflare:workers";
import { InboxEvents } from "./realtime.ts";

/** One broadcaster per inbox owner; streams carry no mail or credentials. */
export class InboxEventsObject extends DurableObject {
  private events = new InboxEvents();

  subscribe(): ReadableStream<Uint8Array> {
    return this.events.subscribe();
  }
  publish(): void {
    this.events.publish();
  }
}
