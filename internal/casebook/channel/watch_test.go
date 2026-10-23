package channel

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/subaud-tools/casebook/internal/casebook/apptest"
	"github.com/subaud-tools/tools-common/channelmcp"
)

// sessions lists the session ids serve knows.
func sessions(t *testing.T, c *Client) []string {
	t.Helper()
	var ss struct {
		Sessions []struct{ ID string } `json:"sessions"`
	}
	_, _ = c.Do(context.Background(), http.MethodGet, "/api/sessions", nil, &ss)
	var ids []string
	for _, s := range ss.Sessions {
		ids = append(ids, s.ID)
	}
	return ids
}

// sendMessage waits for session's presence, then sends body to it from the
// page and returns the message id.
func sendMessage(t *testing.T, c *Client, session, body string) int64 {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for strings.Join(sessions(t, c), ",") != session {
		if time.Now().After(deadline) {
			t.Fatal("no presence")
		}
		time.Sleep(50 * time.Millisecond)
	}
	ctx := context.Background()
	var th struct {
		ID int64 `json:"id"`
	}
	_, _ = c.Do(ctx, http.MethodPost, "/api/threads", map[string]any{"session": session, "name": "triage"}, &th)
	var msg struct {
		ID int64 `json:"id"`
	}
	_, _ = c.Do(ctx, http.MethodPost, "/api/messages", map[string]any{"thread": th.ID, "body": body}, &msg)
	return msg.ID
}

// `casebook watch` is the channel's presence and wait loop with a JSON line on
// stdout for each delivery, which is what the Claude Code plugin's mod reads.
// A message from the page arrives as one line, {"content": ..., "meta":
// {...}}, with the same meta the channel sends.
func TestWatchPrintsAMessageAsOneLine(t *testing.T) {
	r := apptest.New(t)
	c := runServe(t, r)
	id := Identity{Session: "s1", Harness: "claude", Label: "claude · w", CWD: "/w"}

	// The tools, as `casebook channel` serves them under Claude Code.
	tools := New(id, c, "test")
	tools.ServeOnly = true
	m := start(t, tools)

	// The events, as `casebook watch` takes them.
	pr, pw := io.Pipe()
	watch := New(id, NewClient(), "test")
	watch.Retry, watch.Poll = 100*time.Millisecond, 2*time.Second
	watch.Push = channelmcp.NewLines(pw)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = watch.Watch(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })

	sendMessage(t, c, "s1", "please look at pr:schuettc/hail#3")

	lines := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(pr)
		sc.Buffer(make([]byte, 1<<20), 1<<24)
		if sc.Scan() {
			lines <- sc.Text()
		}
	}()
	var line string
	select {
	case line = <-lines:
	case <-time.After(10 * time.Second):
		t.Fatal("no line printed for the message")
	}
	var ev struct {
		Content string            `json:"content"`
		Meta    map[string]string `json:"meta"`
	}
	if err := json.Unmarshal([]byte(line), &ev); err != nil {
		t.Fatalf("not one JSON line: %q (%v)", line, err)
	}
	if ev.Meta["source"] != "casebook" || ev.Meta["delivery"] == "" || ev.Meta["messages"] == "" {
		t.Fatalf("meta = %v", ev.Meta)
	}
	if !strings.Contains(ev.Content, "please look at pr:schuettc/hail#3") {
		t.Fatalf("content = %q", ev.Content)
	}
	if n := m.nextTimeout(300 * time.Millisecond); n != nil {
		t.Fatalf("the serve-only channel pushed too: %v", n)
	}
}

// Under Claude Code the plugin's mod runs `casebook watch`, so `casebook
// channel` must not take deliveries too: it serves the tools and never waits.
// Under pi it waits and pushes as it always has.
func TestChannelWaitsOnlyOutsideClaudeCode(t *testing.T) {
	cases := []struct {
		name       string
		claude, pi string
		waits      bool
	}{
		{"pi", "", "s1", true},
		{"claude code", "s1", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := apptest.New(t)
			c := runServe(t, r)
			t.Setenv("CLAUDE_CODE_SESSION_ID", tc.claude)
			t.Setenv("AGENT_SESSION_ID", tc.pi)
			t.Setenv("AGENT_SESSION_CHILD", "")

			ch := ForSession(c, "test")
			ch.Retry, ch.Poll = 100*time.Millisecond, 2*time.Second
			m := start(t, ch)

			if tc.waits {
				sendMessage(t, c, "s1", "hello")
				if ev := m.next(10 * time.Second); ev["method"] != "notifications/claude/channel" {
					t.Fatalf("event %v", ev)
				}
				return
			}
			time.Sleep(500 * time.Millisecond)
			if ids := sessions(t, c); len(ids) != 0 {
				t.Fatalf("the channel's loop ran under Claude Code (presence %v); only watch may", ids)
			}
			if out, _ := m.tool("casebook_status", map[string]any{}); !strings.Contains(out, "casebook watch") {
				t.Fatalf("status does not say messages go through casebook watch:\n%s", out)
			}
		})
	}
}
