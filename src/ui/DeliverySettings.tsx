import { formatDate, relativeDate } from "./common.tsx";
import type { DeliveryStatus, SessionResponse } from "./types.ts";

export function deliveryLabel(
  mode: SessionResponse["mode"],
  delivery?: DeliveryStatus,
): string {
  if (mode === "development") return "本地开发 · 不接收 Cloudflare 邮件";
  if (!delivery) return "正在检查收件记录…";
  return delivery.lastReceived
    ? `最近收件 ${relativeDate(delivery.lastReceived.createdAt)}`
    : "尚未验证收件";
}

export function DeliverySettings({ delivery, mode, error }: {
  delivery?: DeliveryStatus;
  mode: SessionResponse["mode"];
  error: string;
}) {
  const received = delivery?.lastReceived;
  const rejected = delivery?.lastRejected;
  return (
    <section class="delivery-settings" aria-label="收件接入">
      <h2>收件状态</h2>
      <dl class="message-meta">
        <div>
          <dt>状态</dt>
          <dd>{error || deliveryLabel(mode, delivery)}</dd>
        </div>
        {received && (
          <div>
            <dt>最近收到</dt>
            <dd>{received.aliasAddress} · {formatDate(received.createdAt)}</dd>
          </div>
        )}
        {rejected && (
          <div>
            <dt>最近拒收</dt>
            <dd>
              {rejected.aliasAddress} · {formatDate(rejected.createdAt)} ·{" "}
              {rejected.eventType === "rejected_unknown"
                ? "地址未登记"
                : rejected.eventType === "rejected_disabled"
                ? "地址已停用"
                : "收件规则拦截"}
            </dd>
          </div>
        )}
      </dl>
      <p class="muted">
        这里显示应用实际收到的邮件记录；尚未读取 Cloudflare 的路由配置。
      </p>
    </section>
  );
}
