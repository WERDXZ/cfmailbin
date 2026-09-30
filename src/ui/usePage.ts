import { useCallback, useEffect, useState } from "preact/hooks";

export function usePage() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const update = () => setPath(location.pathname);
    addEventListener("popstate", update);
    return () => removeEventListener("popstate", update);
  }, []);
  const navigate = useCallback((next: string) => {
    if (location.pathname !== next) history.pushState(null, "", next);
    setPath(next);
  }, []);
  return { path, navigate };
}
