// Package observe gathers what the casebook knows about the world: GitHub
// (repos, pull requests, issues) and this machine's clones, branches and
// worktrees.
package observe

import "time"

// CacheVersion and SnapshotVersion are the on-disk formats this binary writes.
const (
	CacheVersion    = 1
	SnapshotVersion = 1
)

// RepoObs is one repository as GitHub reported it.
type RepoObs struct {
	Repo            string    `json:"repo"` // Owner/Name as GitHub spells it
	Archived        bool      `json:"archived,omitempty"`
	Fork            bool      `json:"fork,omitempty"`
	Private         bool      `json:"private,omitempty"`
	Admin           *bool     `json:"admin,omitempty"` // the user is an admin of it (the listing's permissions.admin); nil when not observed
	PushedAt        time.Time `json:"pushed_at,omitzero"`
	Parent          string    `json:"parent,omitempty"`
	DefaultBranch   string    `json:"default_branch,omitempty"`
	LatestRelease   time.Time `json:"latest_release,omitzero"`
	PRs             []PRObs   `json:"prs,omitempty"`    // open
	Issues          []PRObs   `json:"issues,omitempty"` // open
	PRsTruncated    bool      `json:"prs_truncated,omitempty"`
	IssuesTruncated bool      `json:"issues_truncated,omitempty"`
}

// PRObs is one pull request or issue.
type PRObs struct {
	Repo              string    `json:"repo"`
	Number            int       `json:"number"`
	Title             string    `json:"title,omitempty"`
	Author            string    `json:"author,omitempty"`
	AuthorIsBot       bool      `json:"author_is_bot,omitempty"` // true when GitHub says the author is a Bot
	State             string    `json:"state,omitempty"`         // OPEN, CLOSED, MERGED
	Draft             bool      `json:"draft,omitempty"`
	CreatedAt         time.Time `json:"created_at,omitzero"`
	UpdatedAt         time.Time `json:"updated_at,omitzero"`
	LastCommentAuthor string    `json:"last_comment_author,omitempty"`
	LastCommentAt     time.Time `json:"last_comment_at,omitzero"`
	URL               string    `json:"url,omitempty"`
	Labels            []string  `json:"labels,omitempty"`
	Body              string    `json:"body,omitempty"`             // first 600 chars of GitHub's body_text
	MergeState        string    `json:"merge_state,omitempty"`      // GitHub's mergeable_state upper-cased (BEHIND, BLOCKED, CLEAN, DIRTY, ...); set only for a PR decided merge
	HeadRef           string    `json:"head_ref,omitempty"`         // the PR's branch
	HeadRepo          string    `json:"head_repo,omitempty"`        // the repo that branch is in, lower case owner/name ("" when GitHub has none)
	ReviewRequested   bool      `json:"review_requested,omitempty"` // a PR: the user is one of its requested reviewers (teams are not read)
	Assigned          bool      `json:"assigned,omitempty"`         // the user is one of its assignees
}

// Owner is one account's or org's observation. A failed or blocked fetch
// keeps the previous Repos and says so (absence is not evidence).
type Owner struct {
	Login     string    `json:"login"`
	Reachable bool      `json:"reachable"`
	Reason    string    `json:"reason,omitempty"` // why unreachable, or the last fetch error
	Stale     bool      `json:"stale,omitempty"`  // Repos are from FetchedAt, not the latest attempt
	FetchedAt time.Time `json:"fetched_at,omitzero"`
	Repos     []RepoObs `json:"repos,omitempty"`
}

// Ref is the looked-up state of one item referenced by a decision or an
// until condition that the owner sweep doesn't cover.
type Ref struct {
	Exists        bool      `json:"exists"`
	State         string    `json:"state,omitempty"`    // pr/issue
	Archived      bool      `json:"archived,omitempty"` // repo
	LatestRelease time.Time `json:"latest_release,omitzero"`
	UpdatedAt     time.Time `json:"updated_at,omitzero"`
	Tip           string    `json:"tip,omitempty"`        // branch: the ref's commit on GitHub
	RepoID        string    `json:"repo_id,omitempty"`    // branch: the repository's GraphQL node id
	Permission    string    `json:"permission,omitempty"` // branch: the viewer's access to the repository (ADMIN, MAINTAIN, WRITE, TRIAGE, READ)
}

// MergedPR is one merged pull request: its number and head branch and commit.
type MergedPR struct {
	Number      int    `json:"number"`
	HeadRefName string `json:"headRefName"`
	HeadRefOid  string `json:"headRefOid"`
}

// MergedPRList is the cached list of merged PRs for one repo.
// Fetched=false means the list was not (or could not be) fetched.
type MergedPRList struct {
	Fetched bool       `json:"fetched"`
	At      time.Time  `json:"at,omitzero"`
	PRs     []MergedPR `json:"prs,omitempty"`
}

// GitHub is the machine-local cache of everything fetched from GitHub.
type GitHub struct {
	Version    int                     `json:"version"`
	User       string                  `json:"user,omitempty"`
	Owners     map[string]*Owner       `json:"owners"` // key: lower-case login
	Authored   []PRObs                 `json:"authored,omitempty"`
	AuthoredAt time.Time               `json:"authored_at,omitzero"`
	Refs       map[string]Ref          `json:"refs"` // key: item key text
	RefsAt     time.Time               `json:"refs_at,omitzero"`
	MergedPRs  map[string]MergedPRList `json:"merged_prs,omitempty"` // key: lower-case owner/name
}

// Snapshot is one machine's local git state (machines/<machine>.json in the
// casebook repo). It holds no timestamps of its own, so an unchanged machine
// produces an unchanged file.
type Snapshot struct {
	Version int      `json:"version"`
	Machine string   `json:"machine"`
	Roots   []string `json:"roots"`
	Clones  []Clone  `json:"clones"`
}

// Clone is one git clone (or bare repository) found under a root.
type Clone struct {
	Path           string            `json:"path"`
	Repo           string            `json:"repo,omitempty"`    // lower-case owner/name of the identifying GitHub remote
	Remotes        map[string]string `json:"remotes,omitempty"` // name → owner/name, or "url:<redacted url>" for non-GitHub
	Bare           bool              `json:"bare,omitempty"`
	Head           string            `json:"head,omitempty"` // the checked-out branch; "" when detached or bare
	Dirty          bool              `json:"dirty,omitempty"`
	Stashes        int               `json:"stashes,omitempty"`
	LocalHooksPath string            `json:"local_hooks_path,omitempty"` // set: global hooks don't run here
	Adopted        bool              `json:"adopted,omitempty"`          // casebook's shims are chained in via casebook.prevHooksPath
	Branches       []Branch          `json:"branches,omitempty"`
	Worktrees      []Worktree        `json:"worktrees,omitempty"`
}

// Branch is one local branch.
type Branch struct {
	Name           string    `json:"name"`
	Upstream       string    `json:"upstream,omitempty"`
	Ahead          int       `json:"ahead,omitempty"`
	Gone           bool      `json:"gone,omitempty"`     // upstream set but deleted on the remote (typically merged)
	Unpushed       int       `json:"unpushed,omitempty"` // commits on no remote
	OldestUnpushed time.Time `json:"oldest_unpushed,omitzero"`
	Tip            string    `json:"tip"`
	RemoteTip      string    `json:"remote_tip,omitempty"`   // SHA of the upstream remote-tracking ref; empty when no upstream or it is gone
	TipAt          time.Time `json:"tip_at,omitzero"`        // committer date of the tip commit
	Landed         string    `json:"landed,omitempty"`       // "" = not landed; "in <default>" or "merged #<n>"
	LandedState    string    `json:"landed_state,omitempty"` // "yes" | "no" | "unknown" | "" (empty = never checked)
	LandedTip      string    `json:"landed_tip,omitempty"`   // tip SHA; set ONLY when LandedState == "yes"
	LandedHow      string    `json:"landed_how,omitempty"`   // "default-branch" or "merged-pr" (empty when not landed)
	LongLived      bool      `json:"long_lived,omitempty"`   // the default branch or a named long-lived one (LongLived): never landed, never deleted
}

// Worktree is one linked worktree of a clone.
type Worktree struct {
	Path     string `json:"path"`
	Branch   string `json:"branch,omitempty"`
	Head     string `json:"head,omitempty"`
	Detached bool   `json:"detached,omitempty"`
	Dirty    bool   `json:"dirty,omitempty"`
}
