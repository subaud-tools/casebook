package cli

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/subaud-tools/casebook/internal/casebook/apptest"
	"github.com/subaud-tools/casebook/internal/casebook/channel"
	"github.com/subaud-tools/casebook/internal/casebook/serve"
)

// Inside pi's claude-bridge the hosting pi session's channel delivers the
// user's messages, so `casebook watch` prints one stop line and returns at
// once: the mod then never restarts it.
func TestWatchStopsInABridgeChild(t *testing.T) {
	apptest.New(t)
	t.Setenv("AGENT_SESSION_CHILD", "1")
	t.Setenv("AGENT_SESSION_ID", "x")
	var out bytes.Buffer
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	done := make(chan error, 1)
	go func() { done <- watch(ctx, &out, io.Discard) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("watch = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("casebook watch started its loop in a bridge child")
	}
	lines := strings.Split(strings.TrimRight(out.String(), "\n"), "\n")
	var stop struct {
		Stop string `json:"stop"`
	}
	if len(lines) != 1 || json.Unmarshal([]byte(lines[0]), &stop) != nil || stop.Stop == "" {
		t.Fatalf("want exactly one stop line, got %q", out.String())
	}
}

// Outside the bridge `casebook watch` prints each delivery with `text`, the
// whole prompt the plugin's mod submits as the turn.
func TestWatchLineCarriesText(t *testing.T) {
	r := apptest.New(t)
	t.Setenv("AGENT_SESSION_CHILD", "")
	t.Setenv("AGENT_SESSION_ID", "")
	t.Setenv("CLAUDE_CODE_SESSION_ID", "s1")
	started := make(chan struct{})
	sctx, scancel := context.WithCancel(context.Background())
	errc := make(chan error, 1)
	go func() {
		errc <- serve.Run(sctx, r.App, serve.Options{Version: "test", Started: func(s *serve.Server, _ serve.Advert) { s.Wait = 3 * time.Second; close(started) }})
	}()
	select {
	case <-started:
	case err := <-errc:
		t.Fatalf("serve: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("serve did not start")
	}
	t.Cleanup(func() { scancel(); <-errc })

	pr, pw := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = watch(ctx, pw, io.Discard); close(done) }()
	t.Cleanup(func() { cancel(); <-done })

	// The page sends a message once the session is present.
	c := channel.NewClient()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var ss struct {
			Sessions []struct{ ID string } `json:"sessions"`
		}
		_, _ = c.Do(context.Background(), http.MethodGet, "/api/sessions", nil, &ss)
		if len(ss.Sessions) == 1 && ss.Sessions[0].ID == "s1" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no presence")
		}
		time.Sleep(50 * time.Millisecond)
	}
	var th struct {
		ID int64 `json:"id"`
	}
	_, _ = c.Do(context.Background(), http.MethodPost, "/api/threads", map[string]any{"session": "s1", "name": "triage"}, &th)
	_, _ = c.Do(context.Background(), http.MethodPost, "/api/messages", map[string]any{"thread": th.ID, "body": "please look"}, nil)

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
		Text string `json:"text"`
	}
	if err := json.Unmarshal([]byte(line), &ev); err != nil {
		t.Fatalf("not one JSON line: %q (%v)", line, err)
	}
	if !strings.HasPrefix(ev.Text, "casebook event") {
		t.Fatalf("text = %q, want it to start with \"casebook event\"", ev.Text)
	}
}
