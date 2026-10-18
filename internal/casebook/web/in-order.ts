// in-order.ts — send a value to serve one at a time, the latest last.

/**
 * latestInOrder wraps send so calls reach serve in the order they were made:
 * a value waits for the one in flight, and of the values made meanwhile only
 * the latest is sent (it is what serve should end with). A failed send is
 * logged and doesn't stop the next.
 */
export function latestInOrder<T>(
  send: (v: T) => Promise<unknown>,
): (v: T) => void {
  let busy = false;
  let next: { v: T } | null = null;
  const run = async (v: T): Promise<void> => {
    busy = true;
    try {
      await send(v);
    } catch (err) {
      console.error('[in-order]', err);
    }
    busy = false;
    if (next) {
      const n = next;
      next = null;
      void run(n.v);
    }
  };
  return (v: T) => {
    if (busy) next = { v };
    else void run(v);
  };
}
