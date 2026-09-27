export const isMac = navigator.userAgent.includes("Mac");
const isWindows = navigator.userAgent.includes("Windows");

/** ⌘ on macOS, Ctrl elsewhere. */
export const hasModKey = (e: KeyboardEvent | MouseEvent) => (isMac ? e.metaKey : e.ctrlKey);

export const revealLabel = isMac ? "Reveal in Finder" : isWindows ? "Show in Explorer" : "Show in File Manager";
