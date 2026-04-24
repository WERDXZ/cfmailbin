import type { AppStore, BlobStore } from "../storage/types.ts";

export function computeExpiresAt(
  receivedAt: string | Date,
  retentionDays: number,
): string {
  const expiresAt = new Date(receivedAt);
  expiresAt.setUTCDate(expiresAt.getUTCDate() + Math.max(1, retentionDays));
  return expiresAt.toISOString();
}

export async function purgeExpiredMessages(
  store: AppStore,
  blobStore: BlobStore,
  before = new Date().toISOString(),
): Promise<{ deletedCount: number }> {
  const expired = await store.deleteExpiredMessages(before);

  if (expired.rawKeys.length > 0) {
    await blobStore.deleteMany(expired.rawKeys);
  }

  return { deletedCount: expired.count };
}
