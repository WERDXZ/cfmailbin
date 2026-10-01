import { handleRequest } from "./app.ts";
import { readConfig } from "./config.ts";
import { createMemoryBlobStore, createMemoryStore } from "./storage/memory.ts";
import { configWithSettings, createMemorySettingsStore } from "./settings.ts";
import { InboxEvents } from "./realtime.ts";
import { createGraphStore } from "./graph/storage.ts";

const config = readConfig(Deno.env.toObject());
const store = createMemoryStore();
const blobStore = createMemoryBlobStore();
const settings = createMemorySettingsStore();
const graph = createGraphStore();
const events = new InboxEvents();
const env = Deno.env.toObject();

if (import.meta.main) {
  Deno.serve({ hostname: "127.0.0.1", port: 8000 }, (request) => {
    if (!["localhost", "127.0.0.1"].includes(new URL(request.url).hostname)) {
      return new Response("Invalid development host", { status: 403 });
    }
    return handleRequest(request, {
      blobStore,
      config,
      store,
      settings,
      graph,
      events,
      loadConfig: async () => configWithSettings(env, await settings.get()),
      developmentSession: {
        email: config.ownerEmail ?? "developer@localhost",
        mode: "development",
      },
    });
  });
}
