// status-text.ts — the bar's words for decisions not yet on the casebook
// remote (pure, so node --test can load it).

export interface PushState {
  /** Local commits the remote doesn't have yet. */
  queued: number;
  /** The last push couldn't reach the remote. */
  offline: boolean;
  /** Why the last push failed, when not the network ('' none). */
  error: string;
}

/**
 * pushStatus is the bar's status while decisions wait for the casebook
 * remote: red only when a push failed (refused, or the network); decisions
 * merely waiting for the background push are "saving N". null: nothing
 * waits.
 */
export function pushStatus(
  s: PushState,
): { text: string; tone: 'muted' | 'danger' } | null {
  if (s.queued <= 0) return null;
  if (s.error)
    return { text: `push failed \u00b7 ${s.queued} queued`, tone: 'danger' };
  if (s.offline)
    return { text: `offline \u00b7 ${s.queued} queued`, tone: 'danger' };
  return { text: `saving ${s.queued}`, tone: 'muted' };
}
