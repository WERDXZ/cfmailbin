import { useLayoutEffect } from "preact/hooks";

const guards = new Map<symbol, { message: string; discard?: () => void }>();

function beforeUnload(event: BeforeUnloadEvent) {
  event.preventDefault();
}

export function confirmNavigation(): boolean {
  if (!guards.size) return true;
  const pending = [...guards.values()];
  if (
    !confirm([...new Set(pending.map((guard) => guard.message))].join("\n"))
  ) {
    return false;
  }
  for (const guard of pending) guard.discard?.();
  return true;
}

/** Share the same guard for browser history, app navigation and page unload. */
export function useUnsavedChanges(
  dirty: boolean,
  message: string,
  discard?: () => void,
) {
  useLayoutEffect(() => {
    if (!dirty) return;
    const id = Symbol();
    guards.set(id, { message, discard });
    addEventListener("beforeunload", beforeUnload);
    return () => {
      guards.delete(id);
      if (!guards.size) removeEventListener("beforeunload", beforeUnload);
    };
  }, [dirty, message, discard]);
}
