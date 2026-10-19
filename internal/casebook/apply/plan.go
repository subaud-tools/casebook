// Package apply builds execution plans from decided to-apply items and renders
// the exact shell commands for every step. It is pure: no I/O.
//
// Two lanes carry steps:
//   - casebook: mechanical, reversible steps run by casebook itself
//     (local branch delete, GitHub branch delete, worktree remove).
//   - agent: outward or judgment steps handed to the chosen agent session
//     (repo archive/delete, PR close/merge, issue close).
package apply

import (
	"errors"
	"strings"
	"time"

	"github.com/subaud-tools/casebook/internal/casebook/engine"
	"github.com/subaud-tools/casebook/internal/casebook/item"
	"github.com/subaud-tools/casebook/internal/casebook/observe"
)

// Lane identifies which execution lane a step belongs to.
type Lane string

const (
	// LaneCasebook covers mechanical, local, reversible steps run by casebook.
	LaneCasebook Lane = "casebook"
	// LaneAgent covers outward or judgment steps handed to the agent session.
	LaneAgent Lane = "agent"
)

// Step is one action inside a Plan.
type Step struct {
	// Key is the item key this step acts on (e.g. "branch:owner/name@branch").
	Key string `json:"key"`
	// Action is a machine-readable verb identifying the step type.
	Action string `json:"action"`
	// Lane is the execution lane (casebook or agent).
	Lane Lane `json:"lane"`
	// Command is the exact, copy-pasteable shell command for this step.
	Command string `json:"command"`
	// Precondition is the live check run before executing (empty means none).
	Precondition string `json:"precondition,omitempty"`
	// Posts is true when executing this step publishes public text and requires
	// a per-item confirmation before the text is sent (§5.4).
	Posts bool `json:"posts,omitempty"`
	// ExpectedTip is the branch tip SHA we expect to see at execution time and
	// is baked into the compare-and-delete command. For local-delete steps it is
	// the snapshot's local branch tip for that clone; for GitHub-delete steps it
	// is the branch's commit on GitHub. The precondition compares this against
	// the live tip before executing, and treats an already-absent branch as
	// done.
	ExpectedTip string `json:"expected_tip,omitempty"`
}

// Plan is the ordered set of steps for one apply session.
type Plan struct {
	// BuiltAt is the wall-clock time at which the plan was built (= now).
	BuiltAt time.Time `json:"built_at"`
	// Head is the casebook-data HEAD SHA at build time; set by the caller.
	Head string `json:"head,omitempty"`
	// Steps are the ordered apply steps.
	Steps []Step `json:"steps"`
}

// Group groups steps that share the same action and lane, for page display.
// Undo says whether its steps can be undone (UndoNote).
type Group struct {
	Action string `json:"action"`
	Lane   Lane   `json:"lane"`
	Undo   string `json:"undo"`
	Steps  []Step `json:"steps"`
}

// UndoNote says whether a step of action can be undone and how. An action
// whose restore is automatic (RestoreFor, AutoUndoable) starts "Can be
// undone"; every other says it can't.
func UndoNote(action string) string {
	switch action {
	case "branch-delete-local":
		return "Can be undone: undo makes the branch again at the same commit."
	case "branch-delete-remote":
		return "Can be undone: undo makes the branch on GitHub again at the same commit."
	case "worktree-remove":
		return "Can be undone: undo adds the worktree back on its branch."
	case "repo-archive":
		return "No undo here: unarchive it on GitHub to reverse it."
	case "repo-delete":
		return "Cannot be undone: GitHub deletes the repository."
	case "pr-close":
		return "No undo here: reopen it on GitHub; a posted comment stays."
	case "pr-merge":
		return "Cannot be undone: a merge stays merged."
	case "issue-close":
		return "No undo here: reopen it on GitHub; a posted comment stays."
	}
	return "No undo here."
}

// Permanent reports whether a step of action can never be undone (a
// deleted repository, a merge): the page asks Court to confirm before it
// runs.
func Permanent(action string) bool {
	return action == "repo-delete" || action == "pr-merge"
}

// ErrStale is returned by Build when the observation age exceeds syncInterval.
// The caller should offer a sync before retrying.
var ErrStale = errors.New("observation is older than one sync interval; sync first")

// Groups returns the plan's steps aggregated by (action, lane), preserving
// the first-seen order of each (action, lane) pair.
func (p Plan) Groups() []Group {
	type key struct {
		action string
		lane   Lane
	}
	seen := map[key]int{} // key → index in result
	var result []Group

	for _, s := range p.Steps {
		k := key{s.Action, s.Lane}
		if idx, ok := seen[k]; ok {
			result[idx].Steps = append(result[idx].Steps, s)
		} else {
			seen[k] = len(result)
			result = append(result, Group{
				Action: s.Action,
				Lane:   s.Lane,
				Undo:   UndoNote(s.Action),
				Steps:  []Step{s},
			})
		}
	}
	return result
}

// Build constructs a Plan from decided to-apply items for the machine described
// by snap.
//
// Staleness: ErrStale is returned when now.Sub(builtAt) > syncInterval.
// The stale check uses builtAt (the snapshot/cache time the index was built
// from), not the plan's own build time.
//
// Machine scope:
//   - local steps (branch delete, worktree remove) are generated only for
//     locations on snap.Machine;
//   - GitHub steps (a branch's GitHub copy included) run once, from
//     whichever machine applies them.
func Build(items []engine.Item, snap observe.Snapshot, now, builtAt time.Time, syncInterval time.Duration) (Plan, error) {
	if now.Sub(builtAt) > syncInterval {
		return Plan{}, ErrStale
	}

	sl := newSnapLookup(snap)
	plan := Plan{BuiltAt: now}

	for _, it := range items {
		if it.Status != item.StatusToApply || it.Decision == nil {
			continue
		}
		plan.Steps = append(plan.Steps, stepsForItem(it, snap.Machine, sl)...)
	}

	return plan, nil
}

// snapLookup is a precomputed index into an observe.Snapshot for fast lookups.
type snapLookup struct {
	// cloneByPath maps clone path → Clone.
	cloneByPath map[string]observe.Clone
	// cloneForWorktree maps worktree path → Clone that owns it.
	cloneForWorktree map[string]observe.Clone
}

func newSnapLookup(snap observe.Snapshot) snapLookup {
	sl := snapLookup{
		cloneByPath:      make(map[string]observe.Clone, len(snap.Clones)),
		cloneForWorktree: make(map[string]observe.Clone),
	}
	for _, c := range snap.Clones {
		sl.cloneByPath[c.Path] = c
		for _, w := range c.Worktrees {
			sl.cloneForWorktree[w.Path] = c
		}
	}
	return sl
}

// branchTip returns the Tip SHA for branchName in the clone at clonePath, or
// "" if not found.
func (sl snapLookup) branchTip(clonePath, branchName string) string {
	b, _ := sl.branch(clonePath, branchName)
	return b.Tip
}

// branch returns the snapshot's record of branchName in the clone at clonePath.
func (sl snapLookup) branch(clonePath, branchName string) (observe.Branch, bool) {
	c, ok := sl.cloneByPath[clonePath]
	if !ok {
		return observe.Branch{}, false
	}
	for _, b := range c.Branches {
		if b.Name == branchName {
			return b, true
		}
	}
	return observe.Branch{}, false
}

// stepsForItem dispatches to the kind-specific builder.
func stepsForItem(it engine.Item, machine string, sl snapLookup) []Step {
	switch it.Kind {
	case item.KindBranch:
		return branchSteps(it, machine, sl)
	case item.KindWorktree:
		return worktreeSteps(it, machine, sl)
	case item.KindRepo:
		return repoSteps(it)
	case item.KindPR:
		return prSteps(it)
	case item.KindIssue:
		return issueSteps(it)
	}
	return nil
}

// machineClones returns the clone paths that are on the given machine,
// extracted from item.Locations entries of the form "machine:path".
func machineClones(it engine.Item, machine string) []string {
	var paths []string
	for _, loc := range it.Locations {
		m, p, ok := strings.Cut(loc, ":")
		if ok && m == machine {
			paths = append(paths, p)
		}
	}
	return paths
}

// branchSteps generates steps for a branch item with disposition delete.
//
// Local delete: one step per clone on machine, with ExpectedTip set from the
// snapshot's branch tip for that clone (precondition:
// branch-tip-unchanged-and-landed).
//
// GitHub delete: one step from the item's GitHub copy (engine.Item.GitHubCopy),
// through GitHub's API, so it needs no clone and runs from either Mac.
// ExpectedTip is the copy's commit, baked into the updateRefs so GitHub
// refuses a moved branch; the precondition (PreconditionGitHubTip) reads
// GitHub again before it runs. Omitted when no GitHub copy is known or it
// wasn't looked up (no repository id).
func branchSteps(it engine.Item, machine string, sl snapLookup) []Step {
	if it.Decision.Disposition != item.Delete {
		return nil
	}

	branch := it.Key.Branch
	localClones := machineClones(it, machine)
	if observe.LongLived(branch, "") {
		return nil
	}
	for _, c := range localClones {
		if b, ok := sl.branch(c, branch); ok && b.LongLived {
			return nil
		}
	}

	var steps []Step

	// One local-delete step per clone on this machine. The expected tip is the
	// snapshot's local branch tip, always known for local steps, and baked into
	// the update-ref command so it refuses a moved branch.
	for _, clonePath := range localClones {
		tip := sl.branchTip(clonePath, branch)
		steps = append(steps, Step{
			Key:          it.ID,
			Action:       "branch-delete-local",
			Lane:         LaneCasebook,
			Command:      branchDeleteLocalCmd(clonePath, branch, tip),
			Precondition: "branch-tip-unchanged-and-landed",
			ExpectedTip:  tip,
		})
	}

	if c, ok := it.GitHubCopy(); ok && c.RepoID != "" {
		steps = append(steps, Step{
			Key:          it.ID,
			Action:       "branch-delete-remote",
			Lane:         LaneCasebook,
			Command:      branchDeleteGitHubCmd(c.RepoID, branch, c.Tip),
			Precondition: PreconditionGitHubTip,
			ExpectedTip:  c.Tip,
		})
	}

	return steps
}

// worktreeSteps generates a step to remove a worktree with disposition delete.
// Only generated when the worktree's machine matches the plan machine.
// The clone path is looked up from the snapshot (the clone that owns the
// worktree), not from the item's Locations list.
func worktreeSteps(it engine.Item, machine string, sl snapLookup) []Step {
	if it.Decision.Disposition != item.Delete {
		return nil
	}
	if it.Key.Machine != machine {
		return nil
	}
	worktreePath := it.Key.Path
	clone, ok := sl.cloneForWorktree[worktreePath]
	if !ok {
		// Worktree not found in snapshot; fall back to Locations.
		clonePath := machineCloneForWorktree(it, machine)
		if clonePath == "" {
			return nil
		}
		clone.Path = clonePath
	}
	return []Step{{
		Key:          it.ID,
		Action:       "worktree-remove",
		Lane:         LaneCasebook,
		Command:      worktreeRemoveCmd(clone.Path, worktreePath),
		Precondition: "worktree-clean",
	}}
}

// machineCloneForWorktree returns the clone path from the first Locations
// entry on the given machine. Used as fallback when the worktree is not found
// in the snapshot's cloneForWorktree index.
func machineCloneForWorktree(it engine.Item, machine string) string {
	for _, loc := range it.Locations {
		m, p, ok := strings.Cut(loc, ":")
		if ok && m == machine {
			return p
		}
	}
	return ""
}

// repoSteps generates steps for a repo item with disposition archive or delete.
func repoSteps(it engine.Item) []Step {
	repo := it.Key.Repo()
	switch it.Decision.Disposition {
	case item.Archive:
		return []Step{{
			Key:          it.ID,
			Action:       "repo-archive",
			Lane:         LaneAgent,
			Command:      repoArchiveCmd(repo),
			Precondition: "repo-no-open-human-prs",
		}}
	case item.Delete:
		return []Step{{
			Key:     it.ID,
			Action:  "repo-delete",
			Lane:    LaneAgent,
			Command: repoDeleteCmd(repo),
		}}
	}
	return nil
}

// prSteps generates steps for a PR item with disposition close or merge.
func prSteps(it engine.Item) []Step {
	repo := it.Key.Repo()
	n := it.Key.Number
	switch it.Decision.Disposition {
	case item.Close:
		comment := closingComment(it.Decision)
		return []Step{{
			Key:          it.ID,
			Action:       "pr-close",
			Lane:         LaneAgent,
			Command:      prCloseCmd(n, repo, comment),
			Precondition: "pr-no-new-activity",
			Posts:        comment != "",
		}}
	case item.Merge:
		return []Step{{
			Key:          it.ID,
			Action:       "pr-merge",
			Lane:         LaneAgent,
			Command:      prMergeCmd(n, repo),
			Precondition: "pr-no-new-activity",
		}}
	}
	return nil
}

// issueSteps generates a step for an issue item with disposition close.
func issueSteps(it engine.Item) []Step {
	if it.Decision.Disposition != item.Close {
		return nil
	}
	repo := it.Key.Repo()
	n := it.Key.Number
	comment := closingComment(it.Decision)
	return []Step{{
		Key:     it.ID,
		Action:  "issue-close",
		Lane:    LaneAgent,
		Command: issueCloseCmd(n, repo, comment),
		Posts:   comment != "",
	}}
}

// closingComment is what a close posts: the decision's note, as written. A
// note left empty (or blank) means no comment: the close posts nothing, and
// its step doesn't post (Posts is false), so no comment is drafted for it.
func closingComment(d *item.Decision) string {
	if strings.TrimSpace(d.Note) == "" {
		return ""
	}
	return d.Note
}
