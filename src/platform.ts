// WKWebView reports MacIntel on Apple Silicon too; this selects UI conventions,
// not the CPU architecture used by the release build.
export const isMacOS = /Mac/i.test(navigator.platform);
export const primaryModifier = (
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey">,
) => (isMacOS ? event.metaKey : event.ctrlKey);
