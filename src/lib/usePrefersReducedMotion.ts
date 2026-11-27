import { useEffect, useState } from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function readReducedMotionPreference(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  try {
    return window.matchMedia(REDUCED_MOTION_QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * Reactively tracks the OS "prefers-reduced-motion: reduce" setting.
 */
export function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState<boolean>(
    readReducedMotionPreference,
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    let mql: MediaQueryList;
    try {
      mql = window.matchMedia(REDUCED_MOTION_QUERY);
    } catch {
      return;
    }

    setPrefersReducedMotion(mql.matches);

    const handleChange = (event: MediaQueryListEvent) => {
      setPrefersReducedMotion(event.matches);
    };

    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", handleChange);
      return () => {
        mql.removeEventListener("change", handleChange);
      };
    }

    // Legacy WebKit/Chromium fallback
    mql.addListener(handleChange);
    return () => {
      mql.removeListener(handleChange);
    };
  }, []);

  return prefersReducedMotion;
}
