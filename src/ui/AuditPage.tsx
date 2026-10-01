import {
  type DisplayMessage,
  formatMessage,
  localizedMessage,
} from "./messages.ts";
import { useI18n } from "./i18n.tsx";
import type { Translator } from "./translate.ts";
import { Fragment } from "preact";
import { useEffect, useState } from "preact/hooks";
import { auditEventKeys } from "./labels.ts";
import type { AuditEvent, AuditPage as Page } from "./types.ts";
import { api, ApiError } from "./api.ts";

type Filters = {
  q?: string;
  type?: string;
  since?: string;
  messageId?: string;
  correlationId?: string;
};

export function AuditPage({ onError }: { onError: (error: unknown) => void }) {
  const { t, locale } = useI18n();
  const timeFormat = new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState("");
  const [request, setRequest] = useState<
    { filters: Filters; cursor?: string; revision: number }
  >({ filters: {}, revision: 0 });
  const [page, setPage] = useState<Page | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<DisplayMessage>("");
  const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError("");
    if (!request.cursor) {
      setPage(null);
      setExpanded(null);
    }
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(request.filters)) {
      if (value) params.set(key, value);
    }
    if (request.cursor) params.set("cursor", request.cursor);
    api.getAuditPage(params, controller.signal).then((next) => {
      if (!controller.signal.aborted) {
        setPage((old) => ({
          ...next,
          events: request.cursor
            ? [...old?.events ?? [], ...next.events]
            : next.events,
        }));
      }
    }).catch((caught) => {
      if (controller.signal.aborted) return;
      if (caught instanceof ApiError && [401, 403].includes(caught.status)) {
        onError(caught);
      } else {
        setError(
          caught instanceof Error
            ? caught
            : localizedMessage("errors.unableToLoadAuditLog"),
        );
      }
    }).finally(() => {
      if (!controller.signal.aborted) setBusy(false);
    });
    return () => controller.abort();
  }, [request, onError]);
  function filter(filters: Filters) {
    setRequest((old) => ({ filters, revision: old.revision + 1 }));
  }
  function related(event: AuditEvent, key: "messageId" | "correlationId") {
    setSearch("");
    setPeriod("");
    filter({ [key]: event[key] });
  }
  const filters = request.filters;
  return (
    <section class="audit-page" aria-labelledby="audit-heading">
      <header class="inbox-heading">
        <div>
          <h1 id="audit-heading">{t("inbox.auditLog")}</h1>
        </div>
        <button
          type="button"
          class="text-button"
          disabled={busy}
          onClick={() => filter(filters)}
        >
          {t("common.refresh")}
        </button>
      </header>
      <form
        class="audit-filters"
        onSubmit={(event) => {
          event.preventDefault();
          filter({ ...filters, q: search.trim() || undefined });
        }}
      >
        <label class="audit-search">
          <span class="sr-only">{t("audit.searchAuditLog")}</span>
          <input
            type="search"
            maxLength={200}
            placeholder={t("audit.searchAddressesSubjectsReasonsOrActors")}
            value={search}
            onInput={(event) => setSearch(event.currentTarget.value)}
          />
        </label>
        <label>
          <span class="sr-only">{t("audit.eventType")}</span>
          <select
            value={filters.type ?? ""}
            onChange={(event) =>
              filter({
                ...filters,
                type: event.currentTarget.value || undefined,
              })}
          >
            <option value="">{t("audit.allEvents")}</option>
            {Object.entries(auditEventKeys).map(([value, label]) => (
              <option key={value} value={value}>{t(label)}</option>
            ))}
          </select>
        </label>
        <label>
          <span class="sr-only">{t("audit.timeRange")}</span>
          <select
            value={period}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setPeriod(value);
              filter({
                ...filters,
                since: value
                  ? new Date(Date.now() - Number(value) * 86400000)
                    .toISOString()
                  : undefined,
              });
            }}
          >
            <option value="">{t("audit.allTime")}</option>
            <option value="1">{t("audit.last24Hours")}</option>
            <option value="7">{t("audit.last7Days")}</option>
            <option value="30">{t("audit.last30Days")}</option>
          </select>
        </label>
        <button type="submit" class="button">{t("audit.search")}</button>
      </form>
      {(filters.messageId || filters.correlationId) && (
        <p class="audit-scope">
          {filters.messageId ? t("audit.email") : t("audit.receipt")}{" "}
          <code>{filters.messageId ?? filters.correlationId}</code>
          <button
            type="button"
            class="text-button"
            onClick={() =>
              filter({
                ...filters,
                messageId: undefined,
                correlationId: undefined,
              })}
          >
            {t("audit.clearRelatedFilter")}
          </button>
        </p>
      )}
      {error && (
        <p class="inline-error" role="alert">
          {formatMessage(error, t)}{" "}
          <button
            type="button"
            class="text-button"
            disabled={busy}
            onClick={() =>
              setRequest((old) => ({ ...old, revision: old.revision + 1 }))}
          >
            {t("common.retry")}
          </button>
        </p>
      )}
      <div class="audit-table-scroll" aria-busy={busy}>
        <table class="audit-table">
          <caption class="sr-only">
            {t("audit.mailProcessingAndConfigurationChangesNewestFirst")}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("audit.time")}</th>
              <th scope="col">{t("audit.event")}</th>
              <th scope="col">{t("audit.targetActor")}</th>
              <th scope="col">{t("audit.summary")}</th>
              <th scope="col">
                <span class="sr-only">{t("audit.details")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {page?.events.map((event) => (
              <Fragment key={event.id}>
                <tr>
                  <td>
                    <time
                      dateTime={event.createdAt}
                      title={new Date(event.createdAt).toLocaleString(locale)}
                    >
                      {timeFormat.format(new Date(event.createdAt))}
                    </time>
                  </td>
                  <td
                    class={event.eventType === "workflow_failed" ||
                        event.eventType === "workflow_degraded"
                      ? "inline-error"
                      : ""}
                  >
                    {t(auditEventKeys[event.eventType])}
                  </td>
                  <td class="audit-target">
                    {event.aliasAddress || event.actor || t("audit.system")}
                    {event.sender && <small>{event.sender}</small>}
                  </td>
                  <td class="audit-summary">
                    {auditReason(event, t) || event.subjectPreview || "—"}
                    {event.reason && event.subjectPreview && (
                      <small>{event.subjectPreview}</small>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      class="text-button"
                      aria-expanded={expanded === event.id}
                      aria-controls={`audit-${event.id}`}
                      onClick={() =>
                        setExpanded(expanded === event.id ? null : event.id)}
                    >
                      {expanded === event.id
                        ? t("audit.collapse")
                        : t("audit.details")}
                      <span class="sr-only">
                        · {t(
                          auditEventKeys[event.eventType],
                        )} {event.subjectPreview}
                      </span>
                    </button>
                  </td>
                </tr>
                {expanded === event.id && (
                  <tr id={`audit-${event.id}`}>
                    <td colSpan={5} class="audit-detail-cell">
                      <AuditDetail event={event} related={related} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {!page && busy && (
        <p class="audit-empty" role="status">{t("audit.loadingRecords")}</p>
      )}
      {page && !page.events.length && (
        <p class="audit-empty">
          {Object.values(filters).some(Boolean)
            ? t("audit.noMatchingRecords")
            : t("audit.noRecordsYetReceivingMailRunningA")}
        </p>
      )}
      {!!page?.events.length && (
        <footer class="audit-footer">
          <span class="muted" role="status">
            {t("audit.shownCount", { count: page.events.length })}
            {busy ? t("audit.loading") : ""}
          </span>
          {page.nextCursor && (
            <button
              type="button"
              class="button"
              disabled={busy}
              onClick={() =>
                setRequest((old) => ({ ...old, cursor: page.nextCursor! }))}
            >
              {t("audit.loadEarlierRecords")}
            </button>
          )}
        </footer>
      )}
      <p class="audit-note muted">
        {t("audit.auditRecordsRemainAfterMailCleanupWorkflow")}
      </p>
    </section>
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function messageParams(value: unknown): Record<string, string | number> {
  return Object.fromEntries(
    Object.entries(record(value)).filter(
      (entry): entry is [string, string | number] =>
        typeof entry[1] === "string" || typeof entry[1] === "number",
    ),
  );
}
function auditReason(event: AuditEvent, t: Translator): string {
  const workflow = record(event.metadata?.workflow);
  return formatMessage({
    message: event.reason ?? "",
    code:
      workflow.error === event.reason && typeof workflow.errorCode === "string"
        ? workflow.errorCode
        : undefined,
    params: messageParams(workflow.errorParams),
  }, t);
}
function AuditDetail(
  { event, related }: {
    event: AuditEvent;
    related: (event: AuditEvent, key: "messageId" | "correlationId") => void;
  },
) {
  const { t, locale } = useI18n();
  const workflow = record(event.metadata?.workflow);
  const steps = Array.isArray(workflow.steps) ? workflow.steps.map(record) : [];
  return (
    <div class="audit-detail">
      <dl>
        <dt>{t("audit.time")}</dt>
        <dd>{new Date(event.createdAt).toLocaleString(locale)}</dd>
        <dt>{t("audit.actor")}</dt>
        <dd>{event.actor || t("audit.system")}</dd>
        {event.subjectPreview && (
          <>
            <dt>{t("audit.subject")}</dt>
            <dd>{event.subjectPreview}</dd>
          </>
        )}
        {event.reason && (
          <>
            <dt>{t("audit.reason")}</dt>
            <dd>{auditReason(event, t)}</dd>
          </>
        )}
        {typeof event.metadata?.forwardedTo === "string" && (
          <>
            <dt>{t("actions.forwardTo")}</dt>
            <dd>{event.metadata.forwardedTo}</dd>
          </>
        )}
        {typeof workflow.revision === "string" && (
          <>
            <dt>{t("audit.workflowVersion")}</dt>
            <dd>
              <code>{workflow.revision}</code>
            </dd>
          </>
        )}
        {event.messageId && (
          <>
            <dt>{t("audit.messageId")}</dt>
            <dd>
              <code>{event.messageId}</code>{" "}
              <button
                type="button"
                class="text-button"
                onClick={() => related(event, "messageId")}
              >
                {t("audit.allRecordsForThisEmail")}
              </button>
            </dd>
          </>
        )}
        {event.correlationId && (
          <>
            <dt>{t("audit.receiptId")}</dt>
            <dd>
              <code>{event.correlationId}</code>{" "}
              <button
                type="button"
                class="text-button"
                onClick={() => related(event, "correlationId")}
              >
                {t("audit.recordsForThisReceipt")}
              </button>
            </dd>
          </>
        )}
      </dl>
      {!!steps.length && (
        <ol class="audit-steps">
          {steps.map((step, i) => (
            <li key={i}>
              <span class={step.status === "failed" ? "inline-error" : "muted"}>
                {step.status === "failed"
                  ? t("audit.failed")
                  : step.status === "skipped"
                  ? t("audit.skipped")
                  : t("audit.complete")}
              </span>
              <div>
                <strong>
                  {typeof step.label === "string"
                    ? step.label
                    : t("audit.node")}
                </strong>
                {typeof step.branch === "string" && (
                  <span>→ {step.branch}</span>
                )}
                {typeof step.matched === "boolean" && (
                  <span>
                    · {step.indeterminate
                      ? t("audit.indeterminate")
                      : step.matched
                      ? t("audit.policyPassed")
                      : t("audit.policyDidNotPass")}
                  </span>
                )}
                {Array.isArray(step.batch) && (
                  <span class="muted">{t("audit.batched")}</span>
                )}
                {typeof (step.error ?? step.reason) === "string" && (
                  <p class="muted">
                    {formatMessage({
                      message: String(step.error ?? step.reason),
                      code: typeof step.errorCode === "string"
                        ? step.errorCode
                        : undefined,
                      params: messageParams(step.errorParams),
                    }, t)}
                  </p>
                )}
              </div>
              <span class="muted">
                {typeof step.durationMs === "number"
                  ? `${step.durationMs} ms`
                  : ""}
              </span>
            </li>
          ))}
        </ol>
      )}
      {event.metadata && (
        <details>
          <summary>{t("audit.metadata")}</summary>
          <pre>{JSON.stringify(event.metadata, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}
