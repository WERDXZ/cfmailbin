import { handleRequest } from "./app.ts";
import { readConfig } from "./config.ts";
import { createMemoryBlobStore, createMemoryStore } from "./storage/memory.ts";

const config = readConfig();
const store = createMemoryStore({
  tokens: [Deno.env.get("CFMAILBIN_DEV_TOKEN") ?? "dev-token"],
});
const blobStore = createMemoryBlobStore();

if (import.meta.main) {
  Deno.serve((request) => handleRequest(request, { blobStore, config, store }));
}
