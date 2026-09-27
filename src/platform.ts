const isMac = navigator.userAgent.includes("Mac");

/** ⌘ on macOS, Ctrl elsewhere. */
export const hasModKey = (e: KeyboardEvent | MouseEvent) => (isMac ? e.metaKey : e.ctrlKey);
