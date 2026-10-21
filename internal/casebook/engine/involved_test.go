package engine

import (
	"encoding/json"
	"slices"
	"testing"

	"github.com/subaud-tools/casebook/internal/casebook/item"
	"github.com/subaud-tools/casebook/internal/casebook/observe"
)

// orgFixture is the fixture with a fresh org, ft, whose repo ft/team has an
// open PR; Court has no clone of it and is not its admin.
func orgFixture() Input {
	in := fixture()
	in.GitHub.Owners["ft"] = &observe.Owner{Login: "ft", Reachable: true, FetchedAt: now, Repos: []observe.RepoObs{
		{Repo: "ft/team", PushedAt: days(3), DefaultBranch: "main", Admin: ptr(false),
			PRs: []observe.PRObs{{Repo: "ft/team", Number: 7, Author: "alice", State: "OPEN", CreatedAt: days(5), UpdatedAt: days(5)}}},
	}}
	return in
}

func ptr[T any](v T) *T { return &v }

func TestOrgRepoWithoutCloneOrAdminIsNoItem(t *testing.T) {
	r := Build(orgFixture())
	if _, ok := r.Find("repo:ft/team"); ok {
		t.Error("an org repo with no clone and no admin became an item")
	}
	mustFind(t, r, "pr:ft/team#7")
	// Court's own repos need neither.
	mustFind(t, r, "repo:schuettc/old")
}

func TestOrgRepoWithACloneIsAnItem(t *testing.T) {
	in := orgFixture()
	in.Snapshots = append(in.Snapshots, observe.Snapshot{Version: 1, Machine: "mini", Clones: []observe.Clone{{Path: "/c/team", Repo: "ft/team"}}})
	if it := mustFind(t, Build(in), "repo:ft/team"); it.Relation != "org" {
		t.Errorf("relation %q", it.Relation)
	}
	// The clone's repo is compared without case.
	in = orgFixture()
	in.GitHub.Owners["ft"].Repos[0].Repo = "FT/Team"
	in.Snapshots[0].Clones = append(in.Snapshots[0].Clones, observe.Clone{Path: "/c/team", Repo: "ft/team"})
	mustFind(t, Build(in), "repo:ft/team")
}

func TestOrgRepoYouAdminIsAnItem(t *testing.T) {
	in := orgFixture()
	in.GitHub.Owners["ft"].Repos[0].Admin = ptr(true)
	mustFind(t, Build(in), "repo:ft/team")
}

// TestHiddenRepoKeepsFeedingItsPRsAndHolds: a repo with no item still holds
// its PRs (archived: GitHub refuses any change).
func TestHiddenRepoKeepsFeedingItsPRsAndHolds(t *testing.T) {
	in := orgFixture()
	in.GitHub.Owners["ft"].Repos[0].Archived = true
	decide(in, "pr:ft/team#7", item.Close, "")
	r := Build(in)
	if _, ok := r.Find("repo:ft/team"); ok {
		t.Fatal("repo:ft/team became an item")
	}
	pr := mustFind(t, r, "pr:ft/team#7")
	if !slices.ContainsFunc(pr.Holds, func(h Hold) bool { return h.Kind == HoldArchived }) {
		t.Errorf("holds %+v, want archived", pr.Holds)
	}
	if !pr.Public {
		t.Error("the PR lost its repo's visibility")
	}
}

func TestDecidedRepoThatQualifiesAgainShowsItsDecision(t *testing.T) {
	in := orgFixture()
	decide(in, "repo:ft/team", item.Keep, "")
	in.GitHub.Refs["repo:ft/team"] = observe.Ref{Exists: true}
	if _, ok := Build(in).Find("repo:ft/team"); ok {
		t.Fatal("a decided repo with no clone and no admin shows")
	}
	in.GitHub.Owners["ft"].Repos[0].Admin = ptr(true)
	it := mustFind(t, Build(in), "repo:ft/team")
	if it.Decision == nil || it.Decision.Disposition != item.Keep {
		t.Errorf("decision %+v, want keep", it.Decision)
	}
}

// TestBuildCarriesReviewRequestsAndAssignments: an item says when you're
// asked to review it or it is assigned to you, and its fields match on it.
func TestBuildCarriesReviewRequestsAndAssignments(t *testing.T) {
	in := orgFixture()
	p := &in.GitHub.Owners["ft"].Repos[0].PRs[0]
	p.ReviewRequested = true
	in.GitHub.Owners["schuettc"].Repos[0].Issues[0].Assigned = true
	r := Build(in)
	pr := mustFind(t, r, "pr:ft/team#7")
	if !pr.ReviewRequested || pr.Assigned || !pr.Fields(now).ReviewRequested {
		t.Errorf("pr: review requested %v assigned %v", pr.ReviewRequested, pr.Assigned)
	}
	is := mustFind(t, r, "issue:schuettc/hail#4")
	if is.ReviewRequested || !is.Assigned || !is.Fields(now).Assigned {
		t.Errorf("issue: review requested %v assigned %v", is.ReviewRequested, is.Assigned)
	}
}

// orgRepos sets ft's repos from cache JSON, as an older or newer casebook
// wrote them.
func orgRepos(t *testing.T, in Input, js string) {
	t.Helper()
	var repos []observe.RepoObs
	if err := json.Unmarshal([]byte(js), &repos); err != nil {
		t.Fatal(err)
	}
	in.GitHub.Owners["ft"].Repos = repos
}

// TestRepoWithUnknownAdminIsAnItem: a cache from before 0.19.0 has no admin
// field; not knowing is not "not an admin", so the repo shows.
func TestRepoWithUnknownAdminIsAnItem(t *testing.T) {
	in := orgFixture()
	orgRepos(t, in, `[{"repo":"ft/team","pushed_at":"2026-09-21T12:00:00Z"}]`)
	mustFind(t, Build(in), "repo:ft/team")
	// Known false hides it.
	orgRepos(t, in, `[{"repo":"ft/team","admin":false}]`)
	if _, ok := Build(in).Find("repo:ft/team"); ok {
		t.Error("a repo known not to be the user's admin, with no clone, shows")
	}
	// With no login there is no own account to tell from an org: it shows.
	in.GitHub.User = ""
	mustFind(t, Build(in), "repo:ft/team")
}

// TestRepoWhoseOwnerListingFailedKeepsShowing: the listing errors, so the
// previous observations stay (stale) and admin is not known now: it shows.
func TestRepoWhoseOwnerListingFailedKeepsShowing(t *testing.T) {
	in := orgFixture()
	orgRepos(t, in, `[{"repo":"ft/team","admin":false}]`)
	ow := in.GitHub.Owners["ft"]
	ow.Stale, ow.Reason = true, "HTTP 502"
	mustFind(t, Build(in), "repo:ft/team")
	ow.Reachable, ow.Reason = false, "SAML SSO"
	mustFind(t, Build(in), "repo:ft/team")
}

// TestRepoDecidedArchiveShowsWithoutAdminOrClone: a repo with work pending
// (decided archive or delete) always shows, whatever its admin and clone;
// one decided to run nothing hides like an undecided one.
func TestRepoDecidedArchiveShowsWithoutAdminOrClone(t *testing.T) {
	for _, d := range []item.Disposition{item.Archive, item.Delete} {
		in := orgFixture()
		decide(in, "repo:ft/team", d, "")
		r := Build(in)
		it := mustFind(t, r, "repo:ft/team")
		if it.Decision == nil || it.Decision.Disposition != d {
			t.Errorf("%s: decision %+v", d, it.Decision)
		}
		if _, hidden := r.FindHidden("repo:ft/team"); hidden {
			t.Errorf("%s: also hidden", d)
		}
	}
	for _, d := range []item.Disposition{item.Keep, item.Ignore, item.Wait, item.Watch} {
		in := orgFixture()
		decide(in, "repo:ft/team", d, "")
		if _, ok := Build(in).Find("repo:ft/team"); ok {
			t.Errorf("%s: a repo decided to run nothing shows", d)
		}
	}
}

// TestHiddenRepoIsKeptAside: a hidden repo is not in Items but Result keeps
// it, so its item page still opens.
func TestHiddenRepoIsKeptAside(t *testing.T) {
	r := Build(orgFixture())
	it, ok := r.FindHidden("repo:ft/team")
	if !ok || it.Status != item.StatusNew {
		t.Fatalf("hidden %+v %v", it, ok)
	}
}
