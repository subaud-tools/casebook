package observe

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/subaud-tools/casebook/internal/casebook/item"
)

var ctx = context.Background()

// fakeGh answers gh invocations from a handler.
type fakeGh struct {
	handle func(args []string) (string, error)
	mu     sync.Mutex // reads run several at a time
	calls  [][]string
}

func (f *fakeGh) Gh(_ context.Context, args ...string) ([]byte, error) {
	f.mu.Lock()
	f.calls = append(f.calls, args)
	f.mu.Unlock()
	out, err := f.handle(args)
	return []byte(out), err
}

// apiPath is the path of a gh api call, without its query; apiQuery is its
// query.
func apiPath(args []string) string {
	p, _, _ := strings.Cut(apiArg(args), "?")
	return p
}

func apiQuery(args []string) url.Values {
	_, q, _ := strings.Cut(apiArg(args), "?")
	v, _ := url.ParseQuery(q)
	return v
}

func apiArg(args []string) string {
	if len(args) == 0 || args[0] != "api" {
		return ""
	}
	for i := 1; i < len(args); i++ {
		switch a := args[i]; {
		case a == "-H" || a == "--jq":
			i++
		case strings.HasPrefix(a, "-"):
		default:
			return a
		}
	}
	return ""
}

// searchQ is a search call's q, or "".
func searchQ(args []string) string {
	if apiPath(args) != "search/issues" {
		return ""
	}
	return apiQuery(args).Get("q")
}

func countCalls(gh *fakeGh, match func([]string) bool) int {
	n := 0
	for _, c := range gh.calls {
		if match(c) {
			n++
		}
	}
	return n
}

func samlErr() error {
	return &GhError{Code: 1, Stderr: "gh: Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization. (HTTP 403)"}
}

func notFoundErr() error { return &GhError{Code: 1, Stderr: "gh: Not Found (HTTP 404)"} }

func repoJSON(full string, open int) string {
	return fmt.Sprintf(`{"full_name":%q,"node_id":"R_%s","archived":false,"fork":false,"private":true,"pushed_at":"2025-01-02T00:00:00Z",
	 "default_branch":"main","open_issues_count":%d,"permissions":{"admin":true,"maintain":true,"push":true,"triage":true,"pull":true}}`, full, full, open)
}

func issueJSON(repo string, n int, login, typ string, comments int, pr bool) string {
	prField := ""
	if pr {
		prField = `,"pull_request":{"merged_at":null}`
	}
	return fmt.Sprintf(`{"number":%d,"title":"t","html_url":"u","state":"open","draft":false,"created_at":"2026-09-01T00:00:00Z",
	 "updated_at":"2026-09-02T00:00:00Z","user":{"login":%q,"type":%q},"body_text":"b","labels":[{"name":"bug"}],"comments":%d,
	 "repository_url":"https://api.github.com/repos/%s"%s}`, n, login, typ, comments, repo, prField)
}

func searchJSON(total int, items ...string) string {
	return fmt.Sprintf(`{"total_count":%d,"incomplete_results":false,"items":[%s]}`, total, strings.Join(items, ","))
}

// emptyOwner answers an owner with no repos and nothing open, and no
// authored PRs.
func emptyOwner(a []string) (string, bool) {
	switch {
	case strings.Join(a, " ") == "api user --jq .login":
		return "schuettc", true
	case apiPath(a) == "user/repos":
		return "[]", true
	case searchQ(a) != "":
		return searchJSON(0), true
	}
	return "", false
}

func TestRefreshHappyPath(t *testing.T) {
	now := time.Date(2026, 9, 24, 0, 0, 0, 0, time.UTC)
	gh := &fakeGh{handle: func(a []string) (string, error) {
		j := strings.Join(a, " ")
		switch p, q := apiPath(a), searchQ(a); {
		case j == "api user --jq .login":
			return "schuettc\n", nil
		case strings.HasPrefix(j, "api user/orgs"):
			return "Acme\n", nil
		case p == "user/repos":
			return "[" + repoJSON("schuettc/hail", 2) + "]", nil
		case p == "orgs/Acme/repos":
			return "[" + repoJSON("Acme/widget", 0) + "]", nil
		case q == "is:open is:pr user:schuettc":
			return searchJSON(2, issueJSON("schuettc/hail", 3, "bob", "User", 2, true), issueJSON("schuettc/hail", 4, "dependabot[bot]", "Bot", 0, true)), nil
		case q == "is:open is:issue user:schuettc", q == "is:open is:pr org:Acme", q == "is:open is:issue org:Acme":
			return searchJSON(0), nil
		case p == "repos/schuettc/hail/pulls":
			return `[{"number":3,"draft":true,"created_at":"2026-09-01T00:00:01Z","head":{"ref":"feat/x","repo":{"full_name":"Bob/Hail"}}},{"number":4,"head":{"ref":"deps","repo":null}}]`, nil
		case p == "repos/schuettc/hail/issues/3/comments" && apiQuery(a).Get("page") == "2":
			return `[{"user":{"login":"schuettc","type":"User"},"created_at":"2026-09-03T00:00:00Z"}]`, nil
		case q == "is:pr is:open archived:false author:schuettc":
			return searchJSON(1, issueJSON("up/stream", 5, "schuettc", "User", 0, true)), nil
		case p == "repos/up/stream/pulls/5":
			return `{"number":5,"state":"open","mergeable_state":"clean","head":{"ref":"fix","repo":{"full_name":"schuettc/stream"}}}`, nil
		case p == "repos/up/stream/pulls/6":
			return `{"number":6,"state":"closed","merged_at":"2026-09-20T00:00:00Z","updated_at":"2026-09-20T00:00:00Z"}`, nil
		case p == "repos/up/stream":
			return `{"full_name":"up/stream","archived":false,"pushed_at":"2026-09-10T00:00:00Z"}`, nil
		case p == "repos/schuettc/hail/git/ref/heads/gone", p == "repos/schuettc/hail/issues/404":
			return "", notFoundErr()
		}
		return "", fmt.Errorf("unexpected gh %s", j)
	}}
	keys := []item.Key{item.PRKey("up/stream", 6), item.PRKey("up/stream", 5), item.RepoKey("up/stream"), item.BranchKey("schuettc/hail", "gone"), item.IssueKey("schuettc/hail", 404)}
	g, rep := Refresh(ctx, gh, NewGitHub(), RefreshOptions{Keys: keys, Now: now})
	if len(rep.Errors) != 0 {
		t.Fatalf("errors: %v", rep.Errors)
	}
	if g.User != "schuettc" || len(g.Owners) != 2 {
		t.Fatalf("owners %+v", g.Owners)
	}
	own := g.Owners["schuettc"]
	if !own.Reachable || own.Stale || len(own.Repos) != 1 || len(own.Repos[0].PRs) != 2 {
		t.Fatalf("own %+v", own)
	}
	byNum := map[int]PRObs{}
	for _, p := range own.Repos[0].PRs {
		byNum[p.Number] = p
	}
	if p := byNum[3]; p.Author != "bob" || p.LastCommentAuthor != "schuettc" || !p.Draft || p.HeadRef != "feat/x" || p.HeadRepo != "bob/hail" || p.State != "OPEN" || !p.CreatedAt.Equal(time.Date(2026, 9, 1, 0, 0, 1, 0, time.UTC)) || p.Body != "b" || len(p.Labels) != 1 {
		t.Errorf("pr 3 %+v", p)
	}
	// A bot is spelled as GraphQL spelled it, and it has no comments: no call.
	if p := byNum[4]; p.Author != "dependabot" || !p.AuthorIsBot || !p.LastCommentAt.IsZero() || p.HeadRepo != "" {
		t.Errorf("pr 4 %+v", p)
	}
	if acme := g.Owners["acme"]; acme == nil || !acme.Reachable || acme.Repos[0].Repo != "Acme/widget" {
		t.Errorf("acme %+v", acme)
	}
	if len(g.Authored) != 1 || g.Authored[0].Repo != "up/stream" || g.Authored[0].HeadRef != "fix" || g.Authored[0].MergeState != "" || !g.AuthoredAt.Equal(now) {
		t.Errorf("authored %+v", g.Authored)
	}
	want := map[string]Ref{
		"pr:up/stream#6":            {Exists: true, State: "MERGED", UpdatedAt: time.Date(2026, 9, 20, 0, 0, 0, 0, time.UTC)},
		"pr:up/stream#5":            {Exists: true, State: "OPEN", UpdatedAt: time.Date(2026, 9, 2, 0, 0, 0, 0, time.UTC)},
		"repo:up/stream":            {Exists: true, UpdatedAt: time.Date(2026, 9, 10, 0, 0, 0, 0, time.UTC)},
		"branch:schuettc/hail@gone": {Exists: false},
		"issue:schuettc/hail#404":   {Exists: false},
	}
	for k, w := range want {
		if got, ok := g.Refs[k]; !ok || got != w {
			t.Errorf("ref %s = %+v (%v), want %+v", k, got, ok, w)
		}
	}
	// The open PR an authored listing holds is not asked again, nor is a
	// listed repo, and no read goes through GraphQL.
	for _, c := range gh.calls {
		if apiPath(c) == "repos/schuettc/hail" || apiPath(c) == "graphql" {
			t.Errorf("needless call: %v", c)
		}
	}
	if n := countCalls(gh, func(c []string) bool { return apiPath(c) == "repos/up/stream/pulls/5" }); n != 1 {
		t.Errorf("authored PR 5 read %d times, want once", n)
	}
}

func TestRefreshAbsenceIsNotEvidence(t *testing.T) {
	then := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	prev := NewGitHub()
	prev.User = "schuettc"
	prev.Owners["acme"] = &Owner{Login: "acme", Reachable: true, FetchedAt: then, Repos: []RepoObs{{Repo: "acme/x"}}}
	prev.Owners["beta"] = &Owner{Login: "beta", Reachable: true, FetchedAt: then, Repos: []RepoObs{{Repo: "beta/y"}}}
	prev.Refs["pr:a/b#1"] = Ref{Exists: true, State: "OPEN"}
	gh := &fakeGh{handle: func(a []string) (string, error) {
		j := strings.Join(a, " ")
		switch p, q := apiPath(a), searchQ(a); {
		case j == "api user --jq .login":
			return "schuettc", nil
		case p == "user/repos":
			return "[]", nil
		case p == "orgs/acme/repos":
			return "", samlErr()
		case p == "orgs/beta/repos":
			return "[" + repoJSON("beta/z", 1) + "]", nil
		case q == "is:open is:pr org:beta":
			return "", &GhError{Code: 1, Stderr: "gh: HTTP 502: Bad Gateway"}
		case strings.HasPrefix(q, "is:pr is:open archived:false"):
			return "", &GhError{Code: 1, Stderr: "gh: HTTP 502"}
		case q != "":
			return searchJSON(0), nil
		case p == "repos/a/b/pulls/1":
			return "", samlErr()
		}
		return "", fmt.Errorf("unexpected gh %s", j)
	}}
	g, rep := Refresh(ctx, gh, prev, RefreshOptions{Owners: []string{"schuettc", "acme", "beta"}, Keys: []item.Key{item.PRKey("a/b", 1)}, Now: then.Add(24 * time.Hour)})
	acme := g.Owners["acme"]
	if acme.Reachable || !acme.Stale || !strings.Contains(acme.Reason, "SAML") || len(acme.Repos) != 1 || acme.Repos[0].Repo != "acme/x" || !acme.FetchedAt.Equal(then) {
		t.Errorf("acme %+v", acme)
	}
	beta := g.Owners["beta"]
	if !beta.Stale || len(beta.Repos) != 1 || beta.Repos[0].Repo != "beta/y" || !strings.Contains(beta.Reason, "502") {
		t.Errorf("beta kept a partial listing: %+v", beta)
	}
	if r := g.Refs["pr:a/b#1"]; !r.Exists || r.State != "OPEN" {
		t.Errorf("ref overwritten by a failed lookup: %+v", r)
	}
	if len(rep.Errors) < 3 {
		t.Errorf("report %v", rep.Errors)
	}
	if prev.Owners["beta"].Stale {
		t.Error("Refresh mutated prev")
	}
}

// A rate limit stops the refresh: the owner listings already running
// finish (both owners are listed at once), nothing else starts, and every
// owner keeps its previous repos.
func TestRefreshRateLimitStopsFetching(t *testing.T) {
	prev := NewGitHub()
	prev.Owners["zeta"] = &Owner{Login: "zeta", Reachable: true, Repos: []RepoObs{{Repo: "zeta/q"}}}
	gh := &fakeGh{handle: func(a []string) (string, error) {
		j := strings.Join(a, " ")
		switch p := apiPath(a); {
		case j == "api user --jq .login":
			return "schuettc", nil
		case p == "user/repos", p == "orgs/zeta/repos":
			return "", &GhError{Code: 1, Stderr: "gh: API rate limit exceeded for user ID 1. (HTTP 403)"}
		}
		return "", fmt.Errorf("unexpected gh %s", j)
	}}
	g, rep := Refresh(ctx, gh, prev, RefreshOptions{Owners: []string{"schuettc", "zeta"}, Keys: []item.Key{item.RepoKey("a/b")}, Now: time.Now()})
	n := countCalls(gh, func(c []string) bool { p := apiPath(c); return p == "user/repos" || p == "orgs/zeta/repos" })
	if !rep.RateLimited || n < 1 || n > 2 {
		t.Fatalf("rate limited=%v, owner listings=%d", rep.RateLimited, n)
	}
	if z := g.Owners["zeta"]; !z.Stale || len(z.Repos) != 1 || !strings.Contains(z.Reason, "rate") {
		t.Errorf("zeta %+v", z)
	}
	if len(gh.calls) != 1+n {
		t.Errorf("calls after the rate limit: %v", gh.calls)
	}
}

func TestRefreshLookupStopsOnRateLimit(t *testing.T) {
	// 46 repo keys, every lookup rate limited: at most the lookups already
	// running when the first answer came (one pool's worth) are made, and
	// every previous Ref is left as it was.
	prev := NewGitHub()
	prev.Refs["repo:z/z45"] = Ref{Exists: true}

	var keys []item.Key
	for i := 0; i < 45; i++ {
		keys = append(keys, item.RepoKey(fmt.Sprintf("org/repo%d", i)))
	}
	keys = append(keys, item.RepoKey("z/z45"))

	gh := &fakeGh{handle: func(a []string) (string, error) {
		if out, ok := emptyOwner(a); ok {
			return out, nil
		}
		if strings.HasPrefix(apiPath(a), "repos/") {
			return "", &GhError{Code: 1, Stderr: "gh: API rate limit exceeded (HTTP 403)"}
		}
		return "", fmt.Errorf("unexpected gh %s", strings.Join(a, " "))
	}}

	g, rep := Refresh(ctx, gh, prev, RefreshOptions{Owners: []string{"schuettc"}, Keys: keys, Now: time.Now()})
	if !rep.RateLimited {
		t.Fatalf("expected RateLimited=true")
	}
	if n := countCalls(gh, func(c []string) bool { return strings.HasPrefix(apiPath(c), "repos/") }); n < 1 || n > poolSize {
		t.Fatalf("expected 1 to %d lookup calls, got %d", poolSize, n)
	}
	if r := g.Refs["repo:z/z45"]; r != (Ref{Exists: true}) {
		t.Errorf("prev Ref was mutated or lost: %+v", r)
	}
	if len(rep.Errors) != 1 {
		t.Errorf("errors %v, want the one rate limit", rep.Errors)
	}
}

func TestRefreshWithoutGh(t *testing.T) {
	prev := NewGitHub()
	prev.Owners["acme"] = &Owner{Login: "acme", Reachable: true, Repos: []RepoObs{{Repo: "acme/x"}}}
	gh := &fakeGh{handle: func([]string) (string, error) {
		return "", &GhError{Code: 4, Stderr: "gh: To get started with GitHub CLI, please run: gh auth login"}
	}}
	g, rep := Refresh(ctx, gh, prev, RefreshOptions{Now: time.Now()})
	if len(rep.Errors) != 1 || !g.Owners["acme"].Stale || len(g.Owners["acme"].Repos) != 1 {
		t.Fatalf("got %+v %v", g.Owners["acme"], rep.Errors)
	}
}

// TestBodyTruncationIsRuneSafe verifies that toPR truncates body to exactly
// 600 runes (not 600 bytes), producing valid UTF-8.
func TestBodyTruncationIsRuneSafe(t *testing.T) {
	body601 := strings.Repeat("é", 601)
	p := toPR(restIssue{BodyText: body601}, "owner/repo")
	runes := []rune(p.Body)
	if len(runes) != 600 {
		t.Errorf("Body has %d runes, want exactly 600", len(runes))
	}
	if !utf8.ValidString(p.Body) {
		t.Error("Body is not valid UTF-8 after truncation")
	}
	for i, r := range runes {
		if r != 'é' {
			t.Errorf("rune[%d] = %q, want 'é'", i, r)
			break
		}
	}
}

// Only a PR decided merge gets its merge state: GitHub has it on the
// single-PR read alone, one call per PR.
func TestRefreshRecordsMergeState(t *testing.T) {
	gh := &fakeGh{handle: func(a []string) (string, error) {
		j := strings.Join(a, " ")
		switch p, q := apiPath(a), searchQ(a); {
		case j == "api user --jq .login":
			return "schuettc", nil
		case p == "user/repos":
			return "[" + repoJSON("schuettc/hail", 2) + "]", nil
		case q == "is:open is:pr user:schuettc":
			return searchJSON(2, issueJSON("schuettc/hail", 7, "bob", "User", 0, true), issueJSON("schuettc/hail", 8, "bob", "User", 0, true)), nil
		case q != "":
			return searchJSON(0), nil
		case p == "repos/schuettc/hail/pulls":
			return `[{"number":7,"head":{"ref":"feat/x","repo":{"full_name":"Court/Hail"}}},{"number":8,"head":{"ref":"feat/y","repo":{"full_name":"schuettc/hail"}}}]`, nil
		case p == "repos/schuettc/hail/pulls/7":
			return `{"number":7,"state":"open","mergeable_state":"behind","head":{"ref":"feat/x","repo":{"full_name":"Court/Hail"}}}`, nil
		}
		return "", fmt.Errorf("unexpected gh %s", j)
	}}
	g, rep := Refresh(ctx, gh, NewGitHub(), RefreshOptions{Owners: []string{"schuettc"}, Merge: []item.Key{item.PRKey("schuettc/hail", 7)}, Now: time.Now()})
	if len(rep.Errors) != 0 {
		t.Fatalf("errors: %v", rep.Errors)
	}
	prs := map[int]PRObs{}
	for _, p := range g.Owners["schuettc"].Repos[0].PRs {
		prs[p.Number] = p
	}
	if p := prs[7]; p.MergeState != "BEHIND" || p.HeadRef != "feat/x" || p.HeadRepo != "court/hail" {
		t.Errorf("pr %+v, want MergeState BEHIND, HeadRef feat/x and HeadRepo court/hail", p)
	}
	if p := prs[8]; p.MergeState != "" || p.HeadRef != "feat/y" {
		t.Errorf("pr 8 %+v, want no merge state and HeadRef feat/y", p)
	}
	if n := countCalls(gh, func(c []string) bool { return apiPath(c) == "repos/schuettc/hail/pulls/8" }); n != 0 {
		t.Errorf("PR 8 (not decided merge) read on its own %d times", n)
	}
}

// Over GitHub's search cap of 1000 results, each repo with anything open
// lists its own open PRs and issues instead; a repo with nothing open is not
// asked.
func TestRefreshSplitsOverTheSearchCap(t *testing.T) {
	gh := &fakeGh{handle: func(a []string) (string, error) {
		j := strings.Join(a, " ")
		switch p, q := apiPath(a), searchQ(a); {
		case j == "api user --jq .login":
			return "schuettc", nil
		case p == "user/repos":
			return "[]", nil
		case p == "orgs/big/repos":
			return "[" + repoJSON("big/a", 2) + "," + repoJSON("big/quiet", 0) + "]", nil
		case q == "is:open is:pr org:big":
			return searchJSON(1500, issueJSON("big/a", 99, "bob", "User", 0, true)), nil
		case q == "is:open is:issue org:big":
			return searchJSON(1, issueJSON("big/a", 2, "eve", "User", 0, false)), nil
		case q != "":
			return searchJSON(0), nil
		case p == "repos/big/a/issues":
			return "[" + issueJSON("big/a", 1, "bob", "User", 0, true) + "," + issueJSON("big/a", 2, "eve", "User", 0, false) + "]", nil
		case p == "repos/big/a/pulls":
			return `[{"number":1,"head":{"ref":"feat","repo":{"full_name":"big/a"}}}]`, nil
		}
		return "", fmt.Errorf("unexpected gh %s", j)
	}}
	g, rep := Refresh(ctx, gh, NewGitHub(), RefreshOptions{Owners: []string{"schuettc", "big"}, Now: time.Now()})
	if len(rep.Errors) != 0 {
		t.Fatalf("errors: %v", rep.Errors)
	}
	var a RepoObs
	for _, r := range g.Owners["big"].Repos {
		if r.Repo == "big/a" {
			a = r
		}
	}
	if len(a.PRs) != 1 || a.PRs[0].Number != 1 || a.PRs[0].HeadRef != "feat" || len(a.Issues) != 1 || a.Issues[0].Number != 2 {
		t.Errorf("big/a %+v", a)
	}
	if n := countCalls(gh, func(c []string) bool { return strings.HasPrefix(apiPath(c), "repos/big/quiet") }); n != 0 {
		t.Errorf("big/quiet has nothing open but was asked %d times", n)
	}
	if n := countCalls(gh, func(c []string) bool { return searchQ(c) == "is:open is:pr org:big" }); n != 1 {
		t.Errorf("the capped search ran %d pages, want 1", n)
	}
}

// An item whose updated_at hasn't moved keeps its last comment: a new
// comment would have moved it.
func TestRefreshKeepsAnUnchangedLastComment(t *testing.T) {
	at := time.Date(2026, 9, 3, 0, 0, 0, 0, time.UTC)
	prev := NewGitHub()
	prev.Owners["schuettc"] = &Owner{Login: "schuettc", Reachable: true, Repos: []RepoObs{{Repo: "schuettc/hail", Issues: []PRObs{
		{Repo: "schuettc/hail", Number: 2, UpdatedAt: time.Date(2026, 9, 2, 0, 0, 0, 0, time.UTC), LastCommentAt: at, LastCommentAuthor: "eve"}}}}}
	gh := &fakeGh{handle: func(a []string) (string, error) {
		j := strings.Join(a, " ")
		switch p, q := apiPath(a), searchQ(a); {
		case j == "api user --jq .login":
			return "schuettc", nil
		case p == "user/repos":
			return "[" + repoJSON("schuettc/hail", 1) + "]", nil
		case q == "is:open is:issue user:schuettc":
			return searchJSON(1, issueJSON("schuettc/hail", 2, "bob", "User", 4, false)), nil
		case q != "":
			return searchJSON(0), nil
		}
		return "", fmt.Errorf("unexpected gh %s", j)
	}}
	g, rep := Refresh(ctx, gh, prev, RefreshOptions{Owners: []string{"schuettc"}, Now: time.Now()})
	if len(rep.Errors) != 0 {
		t.Fatalf("errors: %v", rep.Errors)
	}
	if is := g.Owners["schuettc"].Repos[0].Issues[0]; !is.LastCommentAt.Equal(at) || is.LastCommentAuthor != "eve" {
		t.Errorf("issue %+v, want the previous last comment", is)
	}
}

// A branch lookup records what Court may do in its repository: a delete on
// GitHub needs write access.
func TestLookupRecordsTheViewerPermission(t *testing.T) {
	gh := &fakeGh{handle: func(a []string) (string, error) {
		if out, ok := emptyOwner(a); ok {
			return out, nil
		}
		switch apiPath(a) {
		case "repos/o/r":
			return `{"full_name":"o/r","node_id":"R_kgDO1","permissions":{"admin":false,"maintain":false,"push":false,"triage":false,"pull":true}}`, nil
		case "repos/o/r/git/ref/heads/feat/x":
			return `{"ref":"refs/heads/feat/x","object":{"sha":"abc123"}}`, nil
		}
		return "", fmt.Errorf("unexpected gh %s", strings.Join(a, " "))
	}}
	k := item.BranchKey("o/r", "feat/x")
	g, _ := Refresh(ctx, gh, NewGitHub(), RefreshOptions{Owners: []string{"schuettc"}, Keys: []item.Key{k}, Now: time.Now()})
	want := Ref{Exists: true, Tip: "abc123", RepoID: "R_kgDO1", Permission: "READ"}
	if got := g.Refs["branch:o/r@feat/x"]; got != want {
		t.Errorf("ref = %+v, want %+v", got, want)
	}
}

func TestLookupRecordsTheBranchCommit(t *testing.T) {
	for _, tc := range []struct {
		answer string
		err    error
		want   Ref
	}{
		{`{"ref":"refs/heads/feat/x","object":{"sha":"abc123"}}`, nil, Ref{Exists: true, Tip: "abc123", RepoID: "R_kgDO1", Permission: "ADMIN"}},
		{"", notFoundErr(), Ref{Exists: false}},
	} {
		gh := &fakeGh{handle: func(a []string) (string, error) {
			if out, ok := emptyOwner(a); ok {
				return out, nil
			}
			switch apiPath(a) {
			case "repos/o/r":
				return repoJSON("o/r", 0), nil
			case "repos/o/r/git/ref/heads/feat/x":
				return tc.answer, tc.err
			}
			return "", fmt.Errorf("unexpected gh %s", strings.Join(a, " "))
		}}
		k := item.BranchKey("o/r", "feat/x")
		g, _ := Refresh(ctx, gh, NewGitHub(), RefreshOptions{Owners: []string{"schuettc"}, Keys: []item.Key{k}, Now: time.Now()})
		want := tc.want
		if want.Exists {
			want.RepoID = "R_o/r"
		}
		if got := g.Refs["branch:o/r@feat/x"]; got != want {
			t.Errorf("ref = %+v, want %+v", got, want)
		}
	}
}

// A repo with more than a couple of branch keys lists its branches once,
// and asks for the repo once.
func TestLookupListsABranchRepoOnce(t *testing.T) {
	gh := &fakeGh{handle: func(a []string) (string, error) {
		if out, ok := emptyOwner(a); ok {
			return out, nil
		}
		switch apiPath(a) {
		case "repos/o/r":
			return repoJSON("o/r", 0), nil
		case "repos/o/r/git/matching-refs/heads/":
			return `[{"ref":"refs/heads/a","object":{"sha":"1"}},{"ref":"refs/heads/b/c","object":{"sha":"2"}}]` + "\n" + `[{"ref":"refs/heads/z","object":{"sha":"3"}}]`, nil
		}
		return "", fmt.Errorf("unexpected gh %s", strings.Join(a, " "))
	}}
	keys := []item.Key{item.BranchKey("o/r", "a"), item.BranchKey("o/r", "b/c"), item.BranchKey("o/r", "gone"), item.BranchKey("o/r", "z")}
	g, rep := Refresh(ctx, gh, NewGitHub(), RefreshOptions{Owners: []string{"schuettc"}, Keys: keys, Now: time.Now()})
	if len(rep.Errors) != 0 {
		t.Fatalf("errors: %v", rep.Errors)
	}
	for k, tip := range map[string]string{"branch:o/r@a": "1", "branch:o/r@b/c": "2", "branch:o/r@z": "3", "branch:o/r@gone": ""} {
		if got := g.Refs[k]; got.Exists != (tip != "") || got.Tip != tip {
			t.Errorf("%s = %+v, want tip %q", k, got, tip)
		}
	}
	if n := countCalls(gh, func(c []string) bool { return strings.HasPrefix(apiPath(c), "repos/") }); n != 2 {
		t.Errorf("%d repo calls, want 2 (the repo and its branch list)", n)
	}
}

// TestLookupRefsRechecksOnlyThoseKeys: after an undo put feat/boot-trace back
// on GitHub (Court, 2026-10-20), casebook re-reads just that ref: it is
// updated, the others keep theirs, and RefsAt (the last full lookup) stays.
func TestLookupRefsRechecksOnlyThoseKeys(t *testing.T) {
	at := time.Date(2026, 10, 20, 18, 5, 0, 0, time.UTC)
	prev := NewGitHub()
	prev.RefsAt = at
	prev.Refs["branch:o/r@a"] = Ref{Exists: false}
	prev.Refs["branch:o/r@b"] = Ref{Exists: false}
	gh := &fakeGh{handle: func(a []string) (string, error) {
		switch apiPath(a) {
		case "repos/o/r":
			return repoJSON("o/r", 0), nil
		case "repos/o/r/git/ref/heads/a":
			return `{"ref":"refs/heads/a","object":{"sha":"abc"}}`, nil
		}
		return "", fmt.Errorf("unexpected gh %s", strings.Join(a, " "))
	}}
	g, err := LookupRefs(ctx, gh, prev, []item.Key{item.BranchKey("o/r", "a")}, at.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if got := g.Refs["branch:o/r@a"]; !got.Exists || got.Tip != "abc" {
		t.Errorf("a = %+v, want exists at abc", got)
	}
	if got := g.Refs["branch:o/r@b"]; got.Exists {
		t.Errorf("b changed: %+v", got)
	}
	if !g.RefsAt.Equal(at) {
		t.Errorf("RefsAt = %v, want %v (a partial lookup is not a full one)", g.RefsAt, at)
	}
	if prev.Refs["branch:o/r@a"].Exists {
		t.Error("prev was changed in place")
	}
}

// A repo a released() condition names gets its latest release, and so does
// its listing; a repo without a release has none.
func TestRefreshReadsReleasesOnlyWhereAConditionNamesThem(t *testing.T) {
	gh := &fakeGh{handle: func(a []string) (string, error) {
		j := strings.Join(a, " ")
		switch p, q := apiPath(a), searchQ(a); {
		case j == "api user --jq .login":
			return "schuettc", nil
		case p == "user/repos":
			return "[" + repoJSON("schuettc/hail", 0) + "," + repoJSON("schuettc/kempt", 0) + "]", nil
		case q != "":
			return searchJSON(0), nil
		case p == "repos/schuettc/hail/releases/latest":
			return `{"published_at":"2026-09-11T00:00:00Z"}`, nil
		case p == "repos/up/none/releases/latest":
			return "", notFoundErr()
		case p == "repos/up/none":
			return `{"full_name":"up/none","pushed_at":"2026-09-10T00:00:00Z"}`, nil
		}
		return "", fmt.Errorf("unexpected gh %s", j)
	}}
	rel := []item.Key{item.RepoKey("schuettc/hail"), item.RepoKey("up/none")}
	keys := append([]item.Key{item.RepoKey("schuettc/kempt")}, rel...)
	g, rep := Refresh(ctx, gh, NewGitHub(), RefreshOptions{Owners: []string{"schuettc"}, Keys: keys, Releases: rel, Now: time.Now()})
	if len(rep.Errors) != 0 {
		t.Fatalf("errors: %v", rep.Errors)
	}
	want := time.Date(2026, 9, 11, 0, 0, 0, 0, time.UTC)
	if r := g.Refs["repo:schuettc/hail"]; !r.LatestRelease.Equal(want) {
		t.Errorf("hail ref %+v", r)
	}
	for _, r := range g.Owners["schuettc"].Repos {
		if r.Repo == "schuettc/hail" && !r.LatestRelease.Equal(want) {
			t.Errorf("hail listing %+v", r)
		}
	}
	if r := g.Refs["repo:up/none"]; !r.Exists || !r.LatestRelease.IsZero() {
		t.Errorf("up/none %+v", r)
	}
	if n := countCalls(gh, func(c []string) bool { return strings.HasPrefix(apiPath(c), "repos/schuettc/kempt") }); n != 0 {
		t.Errorf("kempt (listed, no condition) asked %d times", n)
	}
}

// An owner with no repos has nothing open: no search is made (GitHub's
// search refuses an org qualifier with no repos behind it, HTTP 422).
func TestRefreshOwnerWithoutReposSearchesNothing(t *testing.T) {
	gh := &fakeGh{handle: func(a []string) (string, error) {
		j := strings.Join(a, " ")
		switch p, q := apiPath(a), searchQ(a); {
		case j == "api user --jq .login":
			return "schuettc", nil
		case p == "user/repos", p == "orgs/empty/repos":
			return "[]", nil
		case strings.HasPrefix(q, "is:pr is:open archived:false"):
			return searchJSON(0), nil
		case q != "":
			return "", &GhError{Code: 1, Stderr: "gh: Validation Failed (HTTP 422)"}
		}
		return "", fmt.Errorf("unexpected gh %s", j)
	}}
	g, rep := Refresh(ctx, gh, NewGitHub(), RefreshOptions{Owners: []string{"schuettc", "empty"}, Now: time.Now()})
	if len(rep.Errors) != 0 || g.Owners["empty"].Stale || !g.Owners["empty"].Reachable {
		t.Fatalf("errors %v, empty %+v", rep.Errors, g.Owners["empty"])
	}
}
