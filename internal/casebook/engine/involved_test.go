package engine

import (
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
		{Repo: "ft/team", PushedAt: days(3), DefaultBranch: "main",
			PRs: []observe.PRObs{{Repo: "ft/team", Number: 7, Author: "alice", State: "OPEN", CreatedAt: days(5), UpdatedAt: days(5)}}},
	}}
	return in
}

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
	in.GitHub.Owners["ft"].Repos[0].Admin = true
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
	in.GitHub.Owners["ft"].Repos[0].Admin = true
	it := mustFind(t, Build(in), "repo:ft/team")
	if it.Decision == nil || it.Decision.Disposition != item.Keep {
		t.Errorf("decision %+v, want keep", it.Decision)
	}
}
