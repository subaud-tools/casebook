// agent.mjs — a fake agent that calls /api/agent/* with X-Local-Token.
// Used by the probe to play the agent: presence, recommendations, job steps.

/**
 * Create an agent client authenticated with X-Local-Token.
 * @param {string} base  — the serve base URL, e.g. http://127.0.0.1:PORT
 * @param {string} token — the X-Local-Token value from the advert
 */
export function createAgent(base, token) {
  async function call(method, path, body) {
    const resp = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Local-Token': token,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`${method} ${path}: ${resp.status} ${text}`);
    }
    const text = await resp.text();
    return text ? JSON.parse(text) : null;
  }

  return {
    /**
     * POST /api/agent/presence
     * @param {string} [harness] — 'pi' (default) or 'claude'
     */
    async presence(session, label, cwd, harness) {
      return call('POST', '/api/agent/presence', {
        id: session,
        harness: harness ?? 'pi',
        label,
        cwd,
        pid: process.pid,
      });
    },

    /**
     * POST /api/agent/propose — create proposals for items.
     * @param {string} session — the session id
     * @param {string[]} keys — item keys to propose on
     * @param {string} disposition — the proposed disposition
     * @param {string} [note] — optional note
     * @param {string} [until] — optional until value
     */
    async propose(session, keys, disposition, note, until) {
      return call('POST', '/api/agent/propose', {
        session,
        keys,
        disposition,
        ...(note ? { note } : {}),
        ...(until ? { until } : {}),
      });
    },

    /**
     * api calls any page route with the token, for a scenario's fixture and
     * for reading serve's state back (e.g. api('GET', '/api/rule?id=x')).
     */
    async api(method, path, body) {
      return call(method, path, body);
    },
  };
}
