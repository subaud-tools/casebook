// dock-state.ts — whether the agent pane is open or a thin strip, and what
// a message's pill says.
//
// Pure, with no browser or kit imports, so node --test can load it.

import type { MessageState } from '/_kit/kit.js';
import type { Delivery, MessageView, ThreadState } from './wire.d.ts';
import { pluralize } from './decide-math.ts';

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

/**
 * pillState is the kit pill a message row shows: its state when it is one
 * of msgstate's (a message Court sent), null for a draft (still in the batch
 * tray), the agent's reply and a worked row.
 */
export function pillState(state: ThreadState): MessageState | null {
  switch (state) {
    case 'sent':
    case 'with_agent':
    case 'working':
    case 'answered':
    case 'declined':
    case 'failed':
    case 'no_reply':
      return state;
    default:
      return null;
  }
}

/** The line under a sent message while the agent is mid-turn (diazo's words). */
export const MID_TURN =
  'the agent is mid-turn; it reads this when the turn ends';
/** The line under a sent message no session has (diazo's words). */
export const NO_SESSION = 'no session has it';

/**
 * messageLine is the line under a message's pill: the agent's working line;
 * for a sent message, NO_SESSION when its thread's session is not here
 * (here false), else MID_TURN when its delivery is held or it waits behind
 * the session's delivery in flight; an answered message's attached items,
 * counted; otherwise none.
 */
export function messageLine(
  msg: Pick<MessageView, 'state' | 'line' | 'delivery_id'> & {
    attached?: MessageView['attached'];
  },
  here: boolean,
  inflight: Pick<Delivery, 'id' | 'held'> | null,
): string {
  switch (msg.state) {
    case 'working':
      return msg.line ?? '';
    case 'sent':
      if (!here) return NO_SESSION;
      if (!inflight) return '';
      if (msg.delivery_id === inflight.id) return inflight.held ? MID_TURN : '';
      return msg.delivery_id ? '' : MID_TURN;
    case 'answered': {
      const n = msg.attached?.keys?.length ?? 0;
      return n > 0 ? pluralize(n, 'item') : '';
    }
    default:
      return '';
  }
}
