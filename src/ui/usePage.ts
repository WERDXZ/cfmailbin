import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { confirmNavigation } from "./useUnsavedChanges.ts";

const historyKey = "cfmailbinIndex";

export function usePage() {
  const [path, setPath] = useState(location.pathname);
  const current = useRef({
    index: Number(history.state?.[historyKey]) || 0,
    href: location.href,
    state: history.state,
  });
  const restoring = useRef(false);
  useEffect(() => {
    history.replaceState(
      { ...history.state, [historyKey]: current.current.index },
      "",
    );
    current.current.state = history.state;
    const update = (event: PopStateEvent) => {
      if (restoring.current) {
        restoring.current = false;
        return;
      }
      const index = event.state?.[historyKey];
      if (!confirmNavigation()) {
        if (typeof index === "number" && index !== current.current.index) {
          // popstate cannot be canceled. Restore the history entry without
          // unmounting the editor, then ignore that restoration event.
          restoring.current = true;
          history.go(current.current.index - index);
        } else {
          history.replaceState(current.current.state, "", current.current.href);
        }
        return;
      }
      current.current = {
        index: typeof index === "number" ? index : current.current.index - 1,
        href: location.href,
        state: history.state,
      };
      setPath(location.pathname);
    };
    addEventListener("popstate", update);
    return () => removeEventListener("popstate", update);
  }, []);
  const navigate = useCallback((next: string) => {
    if (restoring.current) return false;
    if (location.pathname !== next) {
      if (!confirmNavigation()) return false;
      const index = current.current.index + 1;
      history.pushState({ [historyKey]: index }, "", next);
      current.current = { index, href: location.href, state: history.state };
    }
    setPath(next);
    return true;
  }, []);
  return { path, navigate };
}
