// Package channel is `casebook channel`: the MCP server each agent session
// starts (Claude Code through the casebook plugin, pi through
// channels.tools). It gives the agent casebook's tools and, under pi,
// registers the session's presence with casebook serve, holds a long-poll
// open for the session's deliveries and injects each one into the session as
// a notifications/claude/channel event (casebook workbench spec §2.2, §6).
// Under Claude Code `casebook watch` runs that loop instead and prints each
// delivery as a JSON line for the plugin's mod. The channel, its loop and the
// client are tools-common pageserve's; casebook's are its Spec.
package channel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/subaud-tools/casebook/internal/casebook/deliver"
	"github.com/subaud-tools/casebook/internal/casebook/serve"
	"github.com/subaud-tools/tools-common/channelmcp"
	"github.com/subaud-tools/tools-common/pageserve"
)

// Instructions are the standing rules the agent gets with the channel
// (casebook workbench spec §6.3).
const Instructions = `casebook is the user's record of what should happen to every repo, pull request, issue, branch and worktree. Its page (casebook serve) and this channel let you work on it with them.

Messages from the user arrive as events from casebook: <channel source="casebook" delivery="…" messages="…"> in pi, or a turn whose first line is casebook event delivery=… messages=… in Claude Code. Several may arrive together; they were queued while you were busy.
- Read every message in a delivery before acting on any. Later messages may refine or cancel earlier ones; when they conflict, follow the latest and say so.
- Messages were written before your last turn's results: if one is already answered by what you did, say so rather than redoing it.
- Answer the page only through casebook tools, never only in your own session: settle EVERY message with casebook_reply (answered with your reply text; declined or failed with why).
- On a message that takes more than a moment, your first move is casebook_reply with state working, the message's id and one line on what you are doing.
- On anything that takes more than a few seconds, keep casebook_progress updated ("checking CI on #671", n of total).
- You never decide. Propose with casebook_propose; the user accepts, changes or rejects on the page.
- Attach what you find to items with casebook_evidence.
- casebook_status tells you the attention counts and what the user did with your proposals since you last looked. What the user was looking at comes attached to each message; there is no live view of their page.
- Open the page (casebook_open) only when the user asks or when handing them something to review; never repeatedly.
- Item keys look like repo:owner/name, pr:owner/name#N, issue:owner/name#N, branch:owner/name@branch, worktree:machine:/abs/path.`

// Spec is casebook's channel for pageserve: its tools, the presence body
// casebook serve takes, how a wait's answer becomes an event, and the restart
// notice.
func Spec(version string) pageserve.Spec {
	return pageserve.Spec{
		Tool: "casebook", Version: version, Instructions: Instructions, Tools: Tools(), Call: call,
		Wake: wake, Answers: "the user's messages", PresenceBody: presenceBody, OnServe: onServe,
	}
}

// Channel, Identity and Client are pageserve's: the channel loop, presence,
// reports and the client that finds (or, for a tool call, starts) serve.
type (
	Channel     = pageserve.Channel
	Identity    = pageserve.Identity
	Client      = pageserve.Client
	StatusError = pageserve.StatusError
)

// ErrNoServe means casebook serve isn't running (and the client doesn't
// start it).
var ErrNoServe = pageserve.ErrNoServe

// FromEnv resolves the session by the family rule (tools-common harness).
func FromEnv() Identity { return pageserve.FromEnv() }

// New builds a channel for id.
func New(id Identity, c *Client, version string) *Channel { return pageserve.New(Spec(version), id, c) }

// ForSession is the channel `casebook channel` runs: this session, and
// serve-only when the session is Claude Code's (the plugin's `casebook watch`
// takes the deliveries).
func ForSession(c *Client, version string) *Channel { return pageserve.ForSession(Spec(version), c) }

// q encodes pairs (key, value, ...) as a URL query, leaving out empty values.
func q(pairs ...string) string { return pageserve.Query(pairs...) }

// NewClient returns a client that finds serve through its entry and never
// starts it.
func NewClient() *Client { return pageserve.NewClient(serve.Live(), nil) }

// presenceBody is the body of POST /api/agent/presence. pid is the HARNESS
// process's (the channel's parent: pi's channels.tools and Claude Code spawn
// the channel directly), not the channel's own: pi-subagents runs worker
// sessions inside their parent's pi process, each with its own channel, so a
// shared harness pid is how serve tells a worker from a fork (which runs in
// a pi process of its own). pi-casebook reports the same pid (pi's
// process.pid).
func presenceBody(id Identity) any {
	return map[string]any{"id": id.Session, "harness": id.Harness, "label": id.Label, "cwd": id.CWD, "pid": id.PID}
}

// wake reads one answer of GET /api/agent/wait: a delivery becomes one
// channel event; a wait that timed out (no delivery) pushes nothing.
func wake(body json.RawMessage) (string, map[string]string, bool) {
	var got struct {
		Delivery deliver.Delivery `json:"delivery"`
		Text     string           `json:"text"`
		Report   string           `json:"report"`
	}
	if err := json.Unmarshal(body, &got); err != nil || got.Delivery.ID == 0 {
		return "", nil, false
	}
	var ids []string
	for _, m := range got.Delivery.Messages {
		ids = append(ids, strconv.FormatInt(m.ID, 10))
	}
	meta := map[string]string{"source": "casebook", "delivery": strconv.FormatInt(got.Delivery.ID, 10), "messages": strings.Join(ids, ",")}
	if got.Report != "" {
		meta[channelmcp.MetaReport] = got.Report
	}
	return got.Text, meta, true
}

// onServe runs when the serve the wait loop reaches is a new process: it
// tells the agent only if that restart interrupted messages in flight to
// this session (serve says so); otherwise, or when serve can't say, it stays
// silent.
func onServe(ctx context.Context, ch *Channel, e pageserve.Entry) {
	v, ok := interrupted(ctx, ch, ch.Client.Passive(), e.StartedAt)
	if !ok {
		return
	}
	if text := restarted(v); text != "" {
		if err := ch.Push.Notify(text, map[string]string{"source": "casebook", "event": "restarted"}); err != nil {
			_, _ = fmt.Fprintf(ch.Log, "casebook channel: notify: %v\n", err)
		}
	}
}

// restarted is the channel event when serve came back as a new process and
// its start interrupted messages in flight to this session; "" when it
// interrupted none (then the restart is none of this session's business).
// It speaks only of the session's own work: whether Court's page reopened
// is about Court's browser, not the agent's.
func restarted(v serve.InterruptedView) string {
	n := len(v.Messages)
	if n == 0 {
		return ""
	}
	ids := make([]string, n)
	for i, id := range v.Messages {
		ids[i] = strconv.FormatInt(id, 10)
	}
	what := "1 message"
	if n > 1 {
		what = strconv.Itoa(n) + " messages"
	}
	return fmt.Sprintf("casebook serve restarted while %s to you %s in flight (%s); nothing was lost. "+
		"%s again in the next delivery: settle %s there with casebook_reply.",
		what, plural(n, "was", "were"), strings.Join(ids, ", "), plural(n, "It comes", "They come"), plural(n, "it", "them"))
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

// interrupted asks serve whether its start interrupted a delivery of this
// session, for the restart to the serve started at startedAt. Anything but a
// clear answer about that serve (an older serve without the endpoint, an
// error, an answer about another serve) is no answer: ok false, and the
// channel says nothing.
func interrupted(ctx context.Context, ch *Channel, c *Client, startedAt time.Time) (serve.InterruptedView, bool) {
	var v serve.InterruptedView
	if _, err := c.Do(ctx, http.MethodGet, "/api/agent/interrupted?"+q("session", ch.ID.Session), nil, &v); err != nil {
		return v, false
	}
	if !v.StartedAt.Equal(startedAt) {
		return v, false
	}
	return v, true
}

// callSessionBound executes a session-bound API call fn. If serve responds with
// a 404 whose JSON body carries "code":"unknown_session" (meaning serve started
// fresh and the wake loop hasn't registered presence yet, or serve restarted
// and forgot the session), callSessionBound registers presence using ch.Client
// (which may start serve) and retries fn once.
//
// Any other error — including a 404 for a missing message or item — is returned
// immediately without a retry, so a wrong message id does not cause a spurious
// presence registration.
func callSessionBound(ctx context.Context, ch *Channel, fn func() (string, error)) (string, error) {
	result, err := fn()
	if err == nil {
		return result, nil
	}
	var se *StatusError
	if !errors.As(err, &se) || se.Code != http.StatusNotFound || se.ErrCode != "unknown_session" {
		return result, err
	}
	// 404 with code="unknown_session": serve doesn't know our session.
	// Register presence (ch.Client may start serve) then retry once.
	if presErr := ch.Announce(ctx, ch.Client); presErr != nil {
		return "", err // return the original 404 error, not the presence error
	}
	return fn()
}
