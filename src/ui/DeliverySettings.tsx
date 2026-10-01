import { type DisplayMessage, formatMessage } from "./messages.ts";
import { useI18n } from "./i18n.tsx";
import { type Locale, sourceLocale } from "../domain/locale.ts";
import { translator } from "./translate.ts";
import { formatDate, relativeDate } from "./common.tsx";
import type { DeliveryStatus, SessionResponse } from "./types.ts";

export function deliveryLabel(
  mode: SessionResponse["mode"],
  delivery?: DeliveryStatus,
  locale: Locale = sourceLocale,
): string {
  const t = translator(locale);
  if (mode === "development") {
    return t("receiving.localDevelopmentNoCloudflareEmailIntake");
  }
  if (!delivery) return t("receiving.checkingMailReceipts");
  return delivery.lastReceived
    ? t("receiving.lastReceivedAt", {
      time: relativeDate(delivery.lastReceived.createdAt, locale),
    })
    : t("receiving.noConfirmedMailReceipt");
}

export function DeliverySettings({ delivery, mode, error }: {
  delivery?: DeliveryStatus;
  mode: SessionResponse["mode"];
  error: DisplayMessage;
}) {
  const { t, locale } = useI18n();
  const received = delivery?.lastReceived;
  const rejected = delivery?.lastRejected;
  return (
    <section
      class="delivery-settings"
      aria-label={t("receiving.receivingSetup")}
    >
      <h2>{t("receiving.receivingStatus")}</h2>
      <dl class="message-meta">
        <div>
          <dt>{t("receiving.status")}</dt>
          <dd>
            {formatMessage(error, t) || deliveryLabel(mode, delivery, locale)}
          </dd>
        </div>
        {received && (
          <div>
            <dt>{t("receiving.lastReceived")}</dt>
            <dd>
              {received.aliasAddress} · {formatDate(received.createdAt, locale)}
            </dd>
          </div>
        )}
        {rejected && (
          <div>
            <dt>{t("receiving.lastRejected")}</dt>
            <dd>
              {rejected.aliasAddress} · {formatDate(rejected.createdAt, locale)}
              {" "}
              · {rejected.eventType === "rejected_unknown"
                ? t("receiving.addressNotRegistered")
                : rejected.eventType === "rejected_disabled"
                ? t("receiving.addressDisabled")
                : t("receiving.rejectedByWorkflow")}
            </dd>
          </div>
        )}
      </dl>
      <p class="muted">
        {t("receiving.theseAreMailReceiptsRecordedByThis")}
      </p>
    </section>
  );
}
