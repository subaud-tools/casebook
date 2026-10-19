// obs.ts — how old the observations are, at the foot of every list: what a
// plan would be built from. "observations fresh", "observations 34m old"
// once older than one sync interval (serve refuses a plan then), or
// "syncing observations…". The age moves on its own, a second at a time.

import type { SummaryView, SyncEvent } from './wire.d.ts';
import type { Ctx } from './app.ts';
import type { ObsState } from './list-pane.ts';
import { observations } from './apply-text.ts';

export function makeObs(
  ctx: Ctx,
  set: (text: string, state: ObsState) => void,
): { load(): Promise<void>; onLive(type: string, data: unknown): void } {
  let builtAt = 0;
  let intervalMs = 0;
  let syncing = false;
  function paint(): void {
    const o = builtAt
      ? observations(builtAt, intervalMs, Date.now())
      : { text: '', stale: false };
    set(
      syncing ? 'syncing observations\u2026' : o.text,
      syncing ? 'syncing' : o.stale ? 'stale' : 'fresh',
    );
  }
  async function load(): Promise<void> {
    try {
      const s = await ctx.api.get<SummaryView>('/summary');
      builtAt = Date.parse(s.built_at) || 0;
      intervalMs = s.sync_interval_ms;
      syncing = s.syncing;
      paint();
    } catch {
      // non-fatal: the line stays as it was
    }
  }
  setInterval(paint, 1000);
  return {
    load,
    onLive(type: string, data: unknown) {
      if (type === 'index' || type === 'gap') void load();
      else if (type === 'sync') {
        syncing = ((data ?? {}) as SyncEvent).state === 'running';
        if (!syncing) void load();
        paint();
      }
    },
  };
}
