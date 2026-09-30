/** Registration addresses are ordinary mailboxes, never plus-tag aliases. */
export function generateAliasAddress(label: string, domain: string): string {
  const normalized = domain.trim().toLowerCase();
  const labels = normalized.split(".");
  if (
    normalized.length > 190 || labels.length < 2 ||
    labels.some((part) =>
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)
    ) ||
    !/^[a-z]{2,63}$/.test(labels.at(-1)!)
  ) {
    throw new Error(
      "请填写已接入 Email Routing 的邮箱域名，例如 mail.example.com",
    );
  }
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "") || "account";
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${slug}-${suffix}@${normalized}`;
}
