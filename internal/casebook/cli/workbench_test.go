package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/subaud-tools/casebook/internal/casebook/apptest"
	"github.com/subaud-tools/casebook/internal/casebook/channel"
	"github.com/subaud-tools/casebook/internal/casebook/observe"
	"github.com/subaud-tools/casebook/internal/casebook/serve"
	"github.com/subaud-tools/casebook/internal/casebook/testgit"
	"github.com/subaud-tools/tools-common/pageserve"
)

func wbSetup(t *testing.T) (*apptest.Rig, *[]string) {
	t.Helper()
	r := apptest.New(t)
	newRunner = func() observe.Runner { return apptest.FakeGh{} }
	opened := &[]string{}
	openBrowser = func(url string) error { *opened = append(*opened, url); return nil }
	t.Cleanup(func() {
		newRunner = func() observe.Runner { return observe.ExecRunner{} }
		openBrowser = nil
	})
	return r, opened
}

func run(args ...string) (int, string, string) {
	var out, errw bytes.Buffer
	code := Main(args, strings.NewReader(""), &out, &errw)
	return code, out.String(), errw.String()
}

func runIn(stdin string, args ...string) (int, string) {
	var out, errw bytes.Buffer
	code := Main(args, strings.NewReader(stdin), &out, &errw)
	return code, out.String() + errw.String()
}

func waitRunning(t *testing.T) pageserve.Entry {
	t.Helper()
	for i := 0; i < 200; i++ {
		if a, err := serve.Running(); err == nil {
			return a
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("serve not running")
	return pageserve.Entry{}
}

func TestServeForegroundOpenStop(t *testing.T) {
	_, opened := wbSetup(t)
	done := make(chan int, 1)
	go func() { code, _, _ := run("serve", "--foreground", "--no-open"); done <- code }()
	adv := waitRunning(t)
	// Plain `casebook serve` opens through casebook's opener (the seam tests
	// replace and CASEBOOK_NO_BROWSER silences), never the OS browser.
	if code, out, _ := run("serve"); code != 0 || !strings.Contains(out, "casebook serve is running: "+adv.Base) {
		t.Fatalf("serve while running: %d %q", code, out)
	}
	if len(*opened) != 1 || !strings.HasPrefix((*opened)[0], adv.URL) {
		t.Fatalf("plain serve opened %v through casebook's opener; want the running page", *opened)
	}
	*opened = nil
	if code, _, errw := run("serve", "extra", "--no-open"); code != 2 || !strings.Contains(errw, "serve takes no arguments") {
		t.Fatalf("serve with an argument: %d %q", code, errw)
	}
	if code, out, _ := run("serve", "--stop"); code != 0 || !strings.Contains(out, "stopped") {
		t.Fatalf("stop %d %q", code, out)
	}
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("foreground exit %d", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("foreground serve didn't exit")
	}
	if code, out, _ := run("serve", "--stop"); code != 0 || !strings.Contains(out, "not running") {
		t.Fatalf("stop when stopped %d %q", code, out)
	}
	if len(*opened) != 0 {
		t.Fatalf("a --no-open serve opened %v", *opened)
	}
}

// `casebook serve` run by a session (an agent's shell carries its session in
// AGENT_SESSION_ID, Claude Code's in CLAUDE_CODE_SESSION_ID) opens the page
// attached to that session; from a plain terminal it opens a page that
// belongs to no session.
func TestServeOpensThePageAttachedToTheCallingSession(t *testing.T) {
	wbSetup(t)
	t.Setenv("AGENT_SESSION_CHILD", "")
	for _, c := range []struct{ agent, claude, want string }{
		{"pi-sess-1", "", "&session=pi-sess-1"},
		{"", "cc-sess-2", "&session=cc-sess-2"},
		{"", "", ""},
	} {
		t.Setenv("AGENT_SESSION_ID", c.agent)
		t.Setenv("CLAUDE_CODE_SESSION_ID", c.claude)
		got, note, err := servePage(context.Background(), nil)
		if err != nil || note != "" || got != c.want {
			t.Fatalf("AGENT_SESSION_ID=%q CLAUDE_CODE_SESSION_ID=%q: page %q %q %v, want %q", c.agent, c.claude, got, note, err, c.want)
		}
	}
}

// On a machine casebook isn't set up on, `casebook serve` says how to set it
// up before it starts a serve that would fail.
func TestServePageNeedsInit(t *testing.T) {
	testgit.Env(t)
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CASEBOOK_HOME", t.TempDir())
	if code, _, errw := run("serve", "--no-open"); code != 1 || !strings.Contains(errw, "casebook init") {
		t.Fatalf("exit %d: %s", code, errw)
	}
	if _, err := serve.Running(); err == nil {
		t.Fatal("serve started on an uninitialized machine")
	}
}

func TestSettledFromClaudeStopHook(t *testing.T) {
	wbSetup(t)
	go run("serve", "--foreground", "--no-open")
	waitRunning(t)
	defer run("serve", "--stop")
	c := channel.NewClient()
	ctx := context.Background()
	_, _ = c.Do(ctx, http.MethodPost, "/api/agent/presence", map[string]any{"id": "cc-9", "harness": "claude"}, nil)
	var th struct {
		ID int64 `json:"id"`
	}
	_, _ = c.Do(ctx, http.MethodPost, "/api/threads", map[string]any{"session": "cc-9", "name": "t"}, &th)
	_, _ = c.Do(ctx, http.MethodPost, "/api/messages", map[string]any{"thread": th.ID, "body": "hi"}, nil)
	// Wait to get the delivery id (updated from old unconditional settled: now must pass delivery in shown).
	var waited struct {
		Delivery struct {
			ID int64 `json:"id"`
		} `json:"delivery"`
	}
	if code, _ := c.Do(ctx, http.MethodGet, "/api/agent/wait?session=cc-9&timeout=2", nil, &waited); code != 200 {
		t.Fatalf("wait %d", code)
	}
	// Create a temporary transcript showing the delivery.
	transcriptLine := fmt.Sprintf(
		`{"type":"user","message":{"role":"user","content":"<channel source=\"casebook\" delivery=\"%d\" source=\"casebook\">\nhi\n</channel>"},"sessionId":"cc-9"}`,
		waited.Delivery.ID,
	)
	transcriptFile := filepath.Join(t.TempDir(), "transcript.jsonl")
	if err := os.WriteFile(transcriptFile, []byte(transcriptLine+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	hookPayload := fmt.Sprintf(`{"session_id":"cc-9","hook_event_name":"Stop","transcript_path":%q}`, transcriptFile)
	if code, out := runIn(hookPayload, "settled", "--harness", "claude"); code != 0 || out != "" {
		t.Fatalf("settled %d %q", code, out)
	}
	var msgs struct {
		Messages []struct {
			ID    int64  `json:"id"`
			State string `json:"state"`
		} `json:"messages"`
	}
	_, _ = c.Do(ctx, http.MethodGet, "/api/messages?thread="+itoa(th.ID), nil, &msgs)
	if len(msgs.Messages) != 1 || msgs.Messages[0].State != "no_reply" {
		t.Fatalf("messages %+v", msgs)
	}
}

// TestSettledHarnessClaudeTranscript verifies that "settled --harness claude"
// scans the Stop hook payload's transcript_path for casebook deliveries and
// posts them as shown. The testdata fixture has delivery 6 (shown via
// attachment queued_command) and delivery 7 (shown via user entry); delivery 6
// via queue-operation entries must NOT count.
func TestSettledHarnessClaudeTranscript(t *testing.T) {
	wbSetup(t)
	var capturedBody []byte
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agent/settled" {
			capturedBody, _ = io.ReadAll(r.Body)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(ts.Close)
	// Replace the settled client so it talks to our capture server.
	prev := newSettledClient
	newSettledClient = func() *channel.Client {
		c := channel.NewClient()
		c.Find = func() (pageserve.Entry, error) {
			return pageserve.Entry{Base: ts.URL, Token: "test"}, nil
		}
		return c
	}
	t.Cleanup(func() { newSettledClient = prev })

	// Use the testdata transcript fixture (lines 54, 55 = queue-operation, 59 = attachment, 82 = user).
	transcriptPath := filepath.Join("testdata", "transcript.jsonl")
	hookPayload := fmt.Sprintf(`{"session_id":"test-session-uuid-1","hook_event_name":"Stop","transcript_path":%q}`,
		transcriptPath)
	if code, out := runIn(hookPayload, "settled", "--harness", "claude"); code != 0 || out != "" {
		t.Fatalf("settled %d %q", code, out)
	}

	var body struct {
		Session string  `json:"session"`
		Shown   []int64 `json:"shown"`
	}
	if err := json.Unmarshal(capturedBody, &body); err != nil {
		t.Fatalf("parse captured body %q: %v", capturedBody, err)
	}
	if body.Session != "test-session-uuid-1" {
		t.Fatalf("session %q, want test-session-uuid-1", body.Session)
	}
	sort.Slice(body.Shown, func(i, j int) bool { return body.Shown[i] < body.Shown[j] })
	if len(body.Shown) != 2 || body.Shown[0] != 6 || body.Shown[1] != 7 {
		t.Fatalf("shown %v, want [6 7]", body.Shown)
	}
}

// TestSettledShownFlag verifies that --shown N,x,M parses valid ids and ignores
// invalid ones, posting them to the server.
func TestSettledShownFlag(t *testing.T) {
	wbSetup(t)
	var capturedBody []byte
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agent/settled" {
			capturedBody, _ = io.ReadAll(r.Body)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(ts.Close)
	prev := newSettledClient
	newSettledClient = func() *channel.Client {
		c := channel.NewClient()
		c.Find = func() (pageserve.Entry, error) {
			return pageserve.Entry{Base: ts.URL, Token: "test"}, nil
		}
		return c
	}
	t.Cleanup(func() { newSettledClient = prev })

	if code, out := runIn("", "settled", "--session", "s-test", "--shown", "3,x,4"); code != 0 || out != "" {
		t.Fatalf("settled %d %q", code, out)
	}
	var body struct {
		Session string  `json:"session"`
		Shown   []int64 `json:"shown"`
	}
	if err := json.Unmarshal(capturedBody, &body); err != nil {
		t.Fatalf("parse captured body %q: %v", capturedBody, err)
	}
	sort.Slice(body.Shown, func(i, j int) bool { return body.Shown[i] < body.Shown[j] })
	if len(body.Shown) != 2 || body.Shown[0] != 3 || body.Shown[1] != 4 {
		t.Fatalf("shown %v, want [3 4]", body.Shown)
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

// TestShownInTranscriptQueueOpOnly verifies that a delivery that appears ONLY
// in queue-operation entries is NOT included in the shown set.
// The transcript.jsonl fixture has delivery 8 only in a queue-operation entry;
// shownInTranscript must return [6,7] (not 8).
// Fail-before evidence: temporarily removing the queue-operation skip in
// shownInTranscript would add 8 to the result.
func TestShownInTranscriptQueueOpOnly(t *testing.T) {
	transcriptPath := filepath.Join("testdata", "transcript.jsonl")
	ids := shownInTranscript(context.Background(), transcriptPath)
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	// delivery 8 appears only in a queue-operation entry and must NOT be shown.
	for _, id := range ids {
		if id == 8 {
			t.Fatalf("delivery 8 appeared in shown set %v — queue-operation entries must be excluded", ids)
		}
	}
	// deliveries 6 and 7 must still be present.
	if len(ids) != 2 || ids[0] != 6 || ids[1] != 7 {
		t.Fatalf("shown %v, want [6 7]", ids)
	}
}

// TestShownInTranscriptLongLine verifies that a transcript line longer than
// 256 KiB (the old bufio.Scanner cap) does not stop the scan; a casebook
// delivery entry appearing after the long line is still found.
// Fail-before evidence: with the old Scanner-based code the 300 KiB line
// caused scanner.Scan() to return false (ErrTooLong) and the delivery entry
// was never read.
func TestShownInTranscriptLongLine(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "transcript.jsonl")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	// Write a line longer than 300 KiB (> the old 256 KiB scanner limit).
	longContent := strings.Repeat("x", 300*1024)
	_, _ = fmt.Fprintf(f, `{"type":"user","message":{"role":"user","content":"%s"}}`+"\n", longContent)
	// Follow with a casebook delivery entry.
	_, _ = fmt.Fprintf(f, `{"type":"user","message":{"role":"user","content":"<channel source=\"casebook\" delivery=\"42\"><\/channel>"}}`+"\n")
	_ = f.Close()

	ids := shownInTranscript(context.Background(), path)
	if len(ids) != 1 || ids[0] != 42 {
		t.Fatalf("want [42], got %v — long line before delivery entry not handled", ids)
	}
}

// TestShownInTranscriptArrayContent verifies that a user entry whose
// message.content is an array of blocks (as Claude emits for multi-block
// content) is parsed and casebook delivery tags inside text blocks are found.
// Fail-before evidence: the old code decoded content as a string only;
// an array value caused json.Unmarshal to put "" in the string field, so the
// tag was never found.
func TestShownInTranscriptArrayContent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "transcript.jsonl")
	// Array content with a casebook tag inside a text block.
	line := `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<channel source=\"casebook\" delivery=\"99\"><\/channel>"},{"type":"text","text":"other block"}]}}` + "\n"
	if err := os.WriteFile(path, []byte(line), 0o644); err != nil {
		t.Fatal(err)
	}
	ids := shownInTranscript(context.Background(), path)
	if len(ids) != 1 || ids[0] != 99 {
		t.Fatalf("want [99] from array content, got %v", ids)
	}
}

// A delivery the Claude Code plugin's mod submitted is a turn holding the
// event header on a line of its own, not a <channel> tag; Claude Code puts its
// own line above it (as Claude Code 2.1.309 writes it to the transcript). It
// counts as shown, or the delivery would stay in flight until the agent
// replied to every message.
func TestShownInTranscriptModTurn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "transcript.jsonl")
	line := `{"type":"user","message":{"role":"user","content":"The casebook plugin sent a message:\ncasebook event delivery=12 messages=34,35 source=casebook\nplease look at pr:schuettc/hail#3\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns."}}` + "\n"
	if err := os.WriteFile(path, []byte(line), 0o644); err != nil {
		t.Fatal(err)
	}
	if ids := shownInTranscript(context.Background(), path); len(ids) != 1 || ids[0] != 12 {
		t.Fatalf("want [12] from the mod's turn, got %v", ids)
	}
}

// TestShownInTranscriptModHeaderOnlyInThePluginTurn: the mod's header counts
// only directly below Claude Code's own line in a user turn, never in text
// that merely looks like it (an assistant example, a user's paste, or a line
// further down a real event's body).
func TestShownInTranscriptModHeaderOnlyInThePluginTurn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "transcript.jsonl")
	lines := `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Here is an example:\ncasebook event delivery=12 messages=34 source=casebook"}]}}` + "\n" +
		`{"type":"user","message":{"role":"user","content":"pasted:\ncasebook event delivery=13 messages=35 source=casebook"}}` + "\n" +
		`{"type":"user","message":{"role":"user","content":"The casebook plugin sent a message:\ncasebook event delivery=14 messages=36 source=casebook\nbody quoting\ncasebook event delivery=15 messages=37 source=casebook"}}` + "\n"
	if err := os.WriteFile(path, []byte(lines), 0o644); err != nil {
		t.Fatal(err)
	}
	if ids := shownInTranscript(context.Background(), path); len(ids) != 1 || ids[0] != 14 {
		t.Fatalf("want only [14] (the real plugin turn's header), got %v", ids)
	}
}

// TestSettledNoServeShownFlag verifies that --shown works silently even when
// there is no serve running (no serve → silent exit 0).
func TestSettledNoServeShownFlag(t *testing.T) {
	wbSetup(t) // no serve started
	for _, args := range [][]string{
		{"settled", "--session", "x", "--shown", "3,4"},
		{"settled", "--shown", "7,9"},
	} {
		if code, out := runIn("", args...); code != 0 || out != "" {
			t.Errorf("%v: %d %q", args, code, out)
		}
	}
}

func TestSettledWithoutServeIsSilent(t *testing.T) {
	wbSetup(t)
	for _, args := range [][]string{{"settled", "--session", "x"}, {"settled"}, {"settled", "--harness", "claude"}, {"settled", "--bogus"}} {
		if code, out := runIn("not json", args...); code != 0 || out != "" {
			t.Errorf("%v: %d %q", args, code, out)
		}
	}
}

// TestSettledClaudeHungStdinReturns verifies that "settled --harness claude"
// returns promptly (well under 5 s) even when stdin never closes, prints
// nothing, and exits 0.
func TestSettledClaudeHungStdinReturns(t *testing.T) {
	wbSetup(t)
	pr, _ := io.Pipe() // writer is never closed – simulates a hung stdin
	defer func() { _ = pr.Close() }()

	type result struct {
		code int
		out  string
	}
	done := make(chan result, 1)
	go func() {
		var out, errw bytes.Buffer
		code := Main([]string{"settled", "--harness", "claude"}, pr, &out, &errw)
		done <- result{code, out.String() + errw.String()}
	}()

	select {
	case res := <-done:
		if res.code != 0 || res.out != "" {
			t.Fatalf("settled: code=%d output=%q", res.code, res.out)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("settled --harness claude with a never-closing stdin did not return within 5 s")
	}
}

// `casebook session-info` is how pi-casebook tells serve a pi session's name,
// its parent session, and that it ended. Like settled it never fails, never prints, and never
// starts serve.
func TestSessionInfoReachesServe(t *testing.T) {
	wbSetup(t)
	done := make(chan int, 1)
	go func() { code, _, _ := run("serve", "--foreground", "--no-open"); done <- code }()
	waitRunning(t)
	defer func() { run("serve", "--stop"); <-done }()
	sessions := func() map[string]map[string]any {
		var sv struct {
			Sessions []map[string]any `json:"sessions"`
		}
		if _, err := channel.NewClient().Do(context.Background(), http.MethodGet, "/api/sessions?all=1", nil, &sv); err != nil {
			t.Fatal(err)
		}
		out := map[string]map[string]any{}
		for _, s := range sv.Sessions {
			out[s["id"].(string)] = s
		}
		return out
	}
	for _, args := range [][]string{
		{"session-info", "--session", "p1", "--name", "tools-workspace/casebook", "--cwd", "/w/tools-workspace", "--pid", "4242"},
		{"session-info", "--session", "w1", "--name", "worker#40c0f7e1", "--cwd", "/w/tools-workspace", "--pid", "4242", "--parent", "p1"},
	} {
		if code, out := runIn("", args...); code != 0 || out != "" {
			t.Fatalf("%v: %d %q", args, code, out)
		}
	}
	ss := sessions()
	if p := ss["p1"]; p == nil || p["name"] != "tools-workspace/casebook" || p["harness"] != "pi" || p["worker"] != false || p["eligible"] != true {
		t.Fatalf("p1 = %v", p)
	}
	if w := ss["w1"]; w == nil || w["worker"] != true || w["eligible"] != false {
		t.Fatalf("w1 = %v", w)
	}
	// A rename.
	if code, out := runIn("", "session-info", "--session", "p1", "--name", "tools-workspace/owner", "--cwd", "/w/tools-workspace", "--pid", "4242"); code != 0 || out != "" {
		t.Fatalf("rename: %d %q", code, out)
	}
	if p := sessions()["p1"]; p["name"] != "tools-workspace/owner" {
		t.Fatalf("after the rename p1 = %v", p)
	}
	// pi replaced p1 in its process (/fork): it ended, so it has left, and
	// w1 is no worker of a live parent any more.
	if code, out := runIn("", "session-info", "--session", "p1", "--ended"); code != 0 || out != "" {
		t.Fatalf("ended: %d %q", code, out)
	}
	ss = sessions()
	if p := ss["p1"]; p["left"] != true || p["name"] != "tools-workspace/owner" {
		t.Fatalf("after the end p1 = %v", p)
	}
	if w := ss["w1"]; w["worker"] != false {
		t.Fatalf("after its parent ended w1 = %v", w)
	}
}

func TestSessionInfoWithoutServeIsSilent(t *testing.T) {
	wbSetup(t) // no serve started
	for _, args := range [][]string{{"session-info", "--session", "x", "--name", "n"}, {"session-info"}, {"session-info", "--bogus"}} {
		if code, out := runIn("", args...); code != 0 || out != "" {
			t.Errorf("%v: %d %q", args, code, out)
		}
	}
	if _, err := serve.Running(); err == nil {
		t.Fatal("session-info started serve")
	}
}
