// Package apptest builds an initialized, hermetic casebook for tests of the
// packages above app (serve, channel, cli): isolated git and HOME, a bare
// local remote, a scanned clone and a fake gh. Test-only by convention.
package apptest

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/subaud-tools/casebook/internal/casebook/app"
	"github.com/subaud-tools/casebook/internal/casebook/observe"
	"github.com/subaud-tools/casebook/internal/casebook/testgit"
)

// FakeGh serves a tiny GitHub through REST: user schuettc, no orgs, one repo
// schuettc/hail with open incoming PR (#3 by bob) and open issues (#4 by
// alice, #5 by carol, #6 by frank, #7 by grace, and #8–#19 for
// TestSinceListsOverruledWithReasons). The extra issues give the probe's T5
// scenarios enough dedicated items so no two scenarios share an item. GitHub
// has none of the scanned clone's branches.
type FakeGh struct{}

const fakeHail = `{"full_name":"schuettc/hail","node_id":"R_hail","pushed_at":"2026-09-20T00:00:00Z","default_branch":"main","open_issues_count":17,
 "permissions":{"admin":true,"maintain":true,"push":true,"triage":true,"pull":true}}`

const fakePR3 = `{"number":3,"title":"fix nudge","state":"open","created_at":"2026-08-01T00:00:00Z","updated_at":"2026-08-01T00:00:00Z",
 "user":{"login":"bob","type":"User"},"repository_url":"https://api.github.com/repos/schuettc/hail","pull_request":{"merged_at":null}}`

const fakeIssues = `[
	 {"number":4,"title":"crash on start","state":"open","created_at":"2026-08-02T00:00:00Z","updated_at":"2026-08-02T00:00:00Z","user":{"login":"alice","type":"User"},"repository_url":"https://api.github.com/repos/schuettc/hail"},
	 {"number":5,"title":"docs missing","state":"open","created_at":"2026-08-03T00:00:00Z","updated_at":"2026-08-03T00:00:00Z","user":{"login":"carol","type":"User"},"repository_url":"https://api.github.com/repos/schuettc/hail"},
	 {"number":6,"title":"perf regression","state":"open","created_at":"2026-08-05T00:00:00Z","updated_at":"2026-08-05T00:00:00Z","user":{"login":"frank","type":"User"},"repository_url":"https://api.github.com/repos/schuettc/hail"},
	 {"number":7,"title":"memory leak","state":"open","created_at":"2026-08-06T00:00:00Z","updated_at":"2026-08-06T00:00:00Z","user":{"login":"grace","type":"User"},"repository_url":"https://api.github.com/repos/schuettc/hail"},
	 {"number":8,"title":"auth timeout","state":"open","created_at":"2026-08-07T00:00:00Z","updated_at":"2026-08-07T00:00:00Z","user":{"login":"henry","type":"User"},"repository_url":"https://api.github.com/repos/schuettc/hail"},
	 {"number":9,"title":"log rotation","state":"open","created_at":"2026-08-08T00:00:00Z","updated_at":"2026-08-08T00:00:00Z","user":{"login":"iris","type":"User"},"repository_url":"https://api.github.com/repos/schuettc/hail"},
	 {"number":10,"title":"rate limit","state":"open","created_at":"2026-08-09T00:00:00Z","updated_at":"2026-08-09T00:00:00Z","user":{"login":"jake","type":"User"},"repository_url":"https://api.github.com/repos/schuettc/hail"},
	 {"number":11,"title":"dark mode","state":"open","created_at":"2026-08-10T00:00:00Z","updated_at":"2026-08-10T00:00:00Z","user":{"login":"kara","type":"User"},"repository_url":"https://api.github.com/repos/schuettc/hail"},
	 {"number":12,"title":"mobile layout","state":"open","created_at":"2026-08-11T00:00:00Z","updated_at":"2026-08-11T00:00:00Z","user":{"login":"leo","type":"User"},"repository_url":"https://api.github.com/repos/schuettc/hail"},
	 {"number":13,"title":"api versioning","state":"open","created_at":"2026-08-12T00:00:00Z","updated_at":"2026-08-12T00:00:00Z","user":{"login":"mia","type":"User"},"repository_url":"https://api.github.com/repos/schuettc/hail"},
	 {"number":14,"title":"search index","state":"open","created_at":"2026-08-13T00:00:00Z","updated_at":"2026-08-13T00:00:00Z","user":{"login":"noah","type":"User"},"repository_url":"https://api.github.com/repos/schuettc/hail"},
	 {"number":15,"title":"webhook retry","state":"open","created_at":"2026-08-14T00:00:00Z","updated_at":"2026-08-14T00:00:00Z","user":{"login":"olga","type":"User"},"repository_url":"https://api.github.com/repos/schuettc/hail"},
	 {"number":16,"title":"cache invalidation","state":"open","created_at":"2026-08-15T00:00:00Z","updated_at":"2026-08-15T00:00:00Z","user":{"login":"pete","type":"User"},"repository_url":"https://api.github.com/repos/schuettc/hail"},
	 {"number":17,"title":"migration tool","state":"open","created_at":"2026-08-16T00:00:00Z","updated_at":"2026-08-16T00:00:00Z","user":{"login":"quinn","type":"User"},"repository_url":"https://api.github.com/repos/schuettc/hail"},
	 {"number":18,"title":"retry backoff","state":"open","created_at":"2026-08-17T00:00:00Z","updated_at":"2026-08-17T00:00:00Z","user":{"login":"rosa","type":"User"},"repository_url":"https://api.github.com/repos/schuettc/hail"},
	 {"number":19,"title":"export api","state":"open","created_at":"2026-08-18T00:00:00Z","updated_at":"2026-08-18T00:00:00Z","user":{"login":"sam","type":"User"},"repository_url":"https://api.github.com/repos/schuettc/hail"}
]`

// Gh answers the reads casebook makes.
func (FakeGh) Gh(_ context.Context, args ...string) ([]byte, error) {
	j := strings.Join(args, " ")
	path := ""
	for i := 1; i < len(args) && args[0] == "api"; i++ {
		if args[i] == "-H" || args[i] == "--jq" {
			i++
		} else if !strings.HasPrefix(args[i], "-") {
			path = args[i]
			break
		}
	}
	p, rawQ, _ := strings.Cut(path, "?")
	q, _ := url.ParseQuery(rawQ)
	switch {
	case j == "api user --jq .login":
		return []byte("schuettc\n"), nil
	case strings.HasPrefix(j, "api user/orgs"):
		return []byte(""), nil
	case strings.HasPrefix(j, "auth status"):
		return []byte("ok"), nil
	case p == "user/repos":
		return []byte("[" + fakeHail + "]"), nil
	case p == "search/issues" && q.Get("q") == "is:open is:pr user:schuettc":
		return []byte(`{"total_count":1,"items":[` + fakePR3 + `]}`), nil
	case p == "search/issues" && q.Get("q") == "is:open is:issue user:schuettc":
		return []byte(`{"total_count":16,"items":` + fakeIssues + `}`), nil
	case p == "search/issues":
		return []byte(`{"total_count":0,"items":[]}`), nil
	case p == "repos/schuettc/hail/pulls" && q.Get("state") == "closed":
		// Merged PR list: no merged PRs in the test fixture.
		return []byte(`[]`), nil
	case p == "repos/schuettc/hail/pulls" && q.Get("state") == "open" && strings.Contains(j, "--jq"):
		// The repo-no-open-human-prs precondition: one PR per line. hail's
		// only open PR (#3) is by bob, a human.
		return []byte(`{"user":{"login":"bob","type":"User"}}`), nil
	case p == "repos/schuettc/hail/pulls" && q.Get("state") == "open":
		return []byte(`[{"number":3,"head":{"ref":"","repo":null}}]`), nil
	case strings.HasPrefix(p, "repos/schuettc/hail/pulls/"):
		// Agent-lane step verification reports the PR closed; the
		// pr-no-new-activity precondition reads its updated_at.
		return []byte(`{"state":"closed","merged_at":null,"updated_at":"2026-08-01T00:00:00Z"}`), nil
	case strings.HasPrefix(p, "repos/schuettc/hail/issues/"):
		// Agent-lane step verification: report the issue closed.
		return []byte(`{"state":"closed"}`), nil
	case strings.HasPrefix(p, "repos/") && strings.Contains(p, "/git/"):
		return nil, &observe.GhError{Code: 1, Stderr: "gh: Not Found (HTTP 404)"}
	case strings.HasPrefix(p, "repos/") && strings.Count(p, "/") == 2:
		// Agent-lane step verification: the repo exists, archived.
		return []byte(`{"archived":true}`), nil
	}
	return nil, fmt.Errorf("apptest.FakeGh: unexpected %s", j)
}

var _ observe.Runner = FakeGh{}

// Rig is an initialized casebook.
type Rig struct {
	App    *app.App
	Remote string // the bare casebook-data remote
	Root   string // the scan root
	Now    time.Time
}

// New initializes a casebook, syncs it once (so the index has items:
// repo:schuettc/hail, pr:schuettc/hail#3, issue:schuettc/hail#4 through #7,
// and the branch/worktree items from the scanned clone), and opens it. The
// casebook is built once per test binary; each test gets its own copy of it
// (HOME, remote and clone) from testgit.Fixture.
func New(t testing.TB) *Rig {
	t.Helper()
	ctx := context.Background()
	testgit.Env(t)
	gh := FakeGh{}
	r := &Rig{Now: time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)}
	use := func(dir string) {
		home := filepath.Join(dir, "home")
		t.Setenv("HOME", home)
		t.Setenv("CASEBOOK_HOME", filepath.Join(home, "casebook-home"))
		r.Remote = filepath.Join(dir, "remote", "remote.git")
		r.Root, _ = filepath.EvalSymlinks(filepath.Join(dir, "root"))
	}
	dir := testgit.Fixture(t, "apptest", func(dir string) {
		for _, d := range []string{"home", "remote", filepath.Join("root", "hail")} {
			if err := os.MkdirAll(filepath.Join(dir, d), 0o755); err != nil {
				t.Fatal(err)
			}
		}
		use(dir)
		testgit.Git(t, filepath.Dir(r.Remote), "init", "-q", "--bare", "-b", "main", r.Remote)
		clone := filepath.Join(r.Root, "hail")
		testgit.Git(t, clone, "init", "-q", "-b", "main")
		c1 := testgit.Commit(t, clone, "a", "1")
		testgit.Git(t, clone, "remote", "add", "origin", "git@github.com:schuettc/hail.git")
		testgit.Git(t, clone, "update-ref", "refs/remotes/origin/main", c1)
		testgit.Git(t, clone, "switch", "-q", "-c", "feat/client")
		testgit.Commit(t, clone, "b", "2")
		if _, err := app.Init(ctx, app.InitOptions{Remote: r.Remote, Machine: "mbp", User: "schuettc", Roots: []string{r.Root}}, gh); err != nil {
			t.Fatal(err)
		}
		a, err := app.Open(gh)
		if err != nil {
			t.Fatal(err)
		}
		a.Now = func() time.Time { return r.Now }
		if _, err := a.Sync(ctx, app.SyncOptions{}); err != nil {
			t.Fatal(err)
		}
	})
	use(dir)
	a, err := app.Open(gh)
	if err != nil {
		t.Fatal(err)
	}
	a.Now = func() time.Time { return r.Now }
	r.App = a
	return r
}
