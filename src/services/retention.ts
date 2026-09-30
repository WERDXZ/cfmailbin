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

  await Promise.all(expired.messages.map((message) =>
    store.createAuditEvent({
      aliasAddress: message.aliasAddress,
      eventType: "expired_deleted",
      messageId: message.id,
      sender: message.from,
      status: message.status,
      subjectPreview: message.subject,
    })
  ));

  return { deletedCount: expired.count };
}

export async function deleteMessages(
  store: AppStore,
  blobStore: BlobStore,
  ids: string[],
): Promise<{ deleted: number; missing: string[]; rawDeleted: number }> {
  const result = await store.deleteMessages(ids);

  if (result.rawKeys.length > 0) {
    await blobStore.deleteMany(result.rawKeys);
  }

  await Promise.all(result.deleted.map((message) =>
    store.createAuditEvent({
      aliasAddress: message.aliasAddress,
      eventType: "manual_deleted",
      messageId: message.id,
      sender: message.from,
      status: message.status,
      subjectPreview: message.subject,
    })
  ));

  return {
    deleted: result.deleted.length,
    missing: result.missing,
    rawDeleted: result.rawKeys.length,
  };
}
