// dock-state.ts — whether the agent pane is open or a thin strip.
//
// Pure, with no browser or kit imports, so node --test can load it.

/**
 * dockOpen is whether the agent pane shows in full: never hidden under a
 * focused composer; else as Court last made it with a click (manual), and
 * with no click, open while there is a conversation (hasMessages), a strip
 * otherwise. A message arriving or the page asking the agent clears or sets
 * manual (dock.ts); this only reads it.
 */
export function dockOpen(
  hasMessages: boolean,
  focused: boolean,
  manual: boolean | null,
): boolean {
  if (focused) return true;
  if (manual !== null) return manual;
  return hasMessages;
}
