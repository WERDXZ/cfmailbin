import { type DisplayMessage, localizedMessage } from "./messages.ts";
import { useEffect, useState } from "preact/hooks";
import { api, ApiError } from "./api.ts";
import type { InboxResponse, MessageFilters } from "./types.ts";

/** SSE invalidates snapshots; reconnect always resyncs. Poll only as fallback. */
export function useInbox(
  filters: MessageFilters,
  active: boolean,
  revision: number,
  onError: (error: unknown) => void,
) {
  const key = JSON.stringify(filters);
  const [state, setState] = useState({
    key: "",
    data: null as InboxResponse | null,
    checkedAt: 0,
    error: "" as DisplayMessage,
    loading: true,
  });
  const [visible, setVisible] = useState(!document.hidden);
  const [connection, setConnection] = useState<
    "connecting" | "live" | "retrying"
  >("connecting");
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let failures = 0;
    let pending = false;
    async function refresh() {
      if (disposed || document.hidden) return;
      if (controller) {
        pending = true;
        return;
      }
      const current = new AbortController();
      controller = current;
      setState((old) => ({ ...old, loading: true }));
      try {
        const data = await api.getInbox(filters, current.signal);
        if (!disposed && !current.signal.aborted) {
          setState({
            key,
            data,
            checkedAt: Date.now(),
            error: "",
            loading: false,
          });
        }
      } catch (error) {
        if (!disposed && !current.signal.aborted) {
          setState((old) => ({
            ...old,
            error: localizedMessage("common.connectionFailedRetrying"),
            loading: false,
          }));
          if (error instanceof ApiError && [401, 403].includes(error.status)) {
            onError(error);
          }
        }
      } finally {
        controller = undefined;
        if (pending) {
          pending = false;
          void refresh();
        }
      }
    }
    function pollFallback() {
      clearTimeout(fallback);
      if (disposed || document.hidden) return;
      void refresh();
      fallback = setTimeout(pollFallback, 30_000);
    }
    function connect() {
      if (disposed || document.hidden) return;
      if (!fallback) fallback = setTimeout(pollFallback, 30_000);
      source?.close();
      if (typeof EventSource === "undefined") {
        setConnection("retrying");
        pollFallback();
        return;
      }
      const current = new EventSource("/api/events");
      source = current;
      current.addEventListener("ready", () => {
        if (disposed || source !== current) return;
        failures = 0;
        clearTimeout(fallback);
        fallback = undefined;
        setConnection("live");
        void refresh();
      });
      current.addEventListener("change", () => {
        if (source === current) void refresh();
      });
      current.onerror = () => {
        if (disposed || source !== current) return;
        current.close();
        source = undefined;
        setConnection("retrying");
        if (!fallback) pollFallback();
        retry = setTimeout(connect, Math.min(1000 * 2 ** failures++, 30_000));
      };
    }
    function pause() {
      source?.close();
      source = undefined;
      clearTimeout(retry);
      clearTimeout(fallback);
      fallback = undefined;
      controller?.abort();
      pending = false;
    }
    function visibility() {
      setVisible(!document.hidden);
      pause();
      if (!document.hidden) {
        setConnection("connecting");
        connect();
        void refresh();
      }
    }
    function focus() {
      if (!document.hidden) void refresh();
    }
    document.addEventListener("visibilitychange", visibility);
    globalThis.addEventListener("focus", focus);
    setConnection("connecting");
    connect();
    void refresh();
    return () => {
      disposed = true;
      pause();
      document.removeEventListener("visibilitychange", visibility);
      globalThis.removeEventListener("focus", focus);
    };
  }, [key, active, revision, onError]);
  return {
    ...state,
    items: active && state.key === key ? state.data?.messages ?? [] : [],
    loading: state.loading || (state.key !== key && !state.error),
    visible,
    connection,
  };
}
