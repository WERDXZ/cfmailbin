import worker from "./worker.ts";
export { InboxEventsObject } from "./InboxEventsObject.ts";

// Validate the portable handlers against Wrangler's actual generated bindings.
export default worker satisfies ExportedHandler<Cloudflare.Env>;
