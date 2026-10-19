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
	"slices"
	"sort"
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
	// Comment is the text a posting step posts ("" for none).
	Comment string `json:"comment,omitempty"`
	// Public is true for a posting step on a repo anyone can read.
	Public bool `json:"public,omitempty"`
}

// HeldBack is a decided item the plan leaves out of the run, with the holds
// that keep it out.
type HeldBack struct {
	Key   string        `json:"key"`
	Holds []engine.Hold `json:"holds"`
}

// Waiting is a decided item whose local copy is only on another Mac: it
// runs from review there.
type Waiting struct {
	Key     string `json:"key"`
	Machine string `json:"machine"`
	Path    string `json:"path,omitempty"`
}

// Plan is the ordered set of steps for one apply session.
type Plan struct {
	// BuiltAt is the wall-clock time at which the plan was built (= now).
	BuiltAt time.Time `json:"built_at"`
	// Head is the casebook-data HEAD SHA at build time; set by the caller.
	Head string `json:"head,omitempty"`
	// Steps are the ordered apply steps.
	Steps []Step `json:"steps"`
	// HeldBack are the decided items held out of this run, and why.
	HeldBack []HeldBack `json:"held_back,omitempty"`
	// Waiting are the decided items whose local copy waits for another Mac.
	Waiting []Waiting `json:"waiting,omitempty"`
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
		d := it.Decision.Disposition
		if it.Stopped(d) {
			plan.HeldBack = append(plan.HeldBack, HeldBack{Key: it.ID, Holds: stopping(it.Holds, d)})
			continue
		}
		ip := planItem(it, snap.Machine, sl)
		plan.Steps = append(plan.Steps, ip.steps...)
		plan.Waiting = append(plan.Waiting, ip.waiting...)
		if len(ip.held) > 0 {
			plan.HeldBack = append(plan.HeldBack, HeldBack{Key: it.ID, Holds: ip.held})
		}
		if len(ip.steps) == 0 && len(ip.held) == 0 && len(ip.waiting) == 0 && acts(d) {
			plan.HeldBack = append(plan.HeldBack, HeldBack{Key: it.ID, Holds: []engine.Hold{{
				Kind: engine.HoldNothingHere, Text: "nothing to run for it from this Mac", Stops: []item.Disposition{d}}}})
		}
	}
	sort.SliceStable(plan.Steps, func(i, j int) bool { return stepRank(plan.Steps[i].Action) < stepRank(plan.Steps[j].Action) })

	return plan, nil
}

// stepRank orders a plan's steps: a worktree goes before the branch it
// holds, and a branch's GitHub copy before its local ones.
func stepRank(action string) int {
	switch action {
	case "worktree-remove":
		return 0
	case "branch-delete-remote":
		return 1
	case "branch-delete-local":
		return 2
	}
	return 3
}

// acts reports whether a disposition makes steps (the others record a
// decision and run nothing).
func acts(d item.Disposition) bool {
	switch d {
	case item.Archive, item.Close, item.Merge, item.Delete:
		return true
	}
	return false
}

// stopping is the holds that stop disposition d.
func stopping(hs []engine.Hold, d item.Disposition) []engine.Hold {
	var out []engine.Hold
	for _, h := range hs {
		if slices.Contains(h.Stops, d) {
			out = append(out, h)
		}
	}
	return out
}

// itemPlan is what one item adds to a plan: its steps, the holds that keep
// part of it out, and the local copies that wait for another Mac.
type itemPlan struct {
	steps   []Step
	held    []engine.Hold
	waiting []Waiting
}

// waits lists an item's local copies on other Macs (its other-mac holds),
// with each one's path from the item's Locations.
func waits(it engine.Item) []Waiting {
	var out []Waiting
	for _, h := range it.Holds {
		if h.Kind != engine.HoldOtherMac {
			continue
		}
		path := ""
		for _, loc := range it.Locations {
			if m, p, ok := strings.Cut(loc, ":"); ok && m == h.Machine {
				path = p
				break
			}
		}
		out = append(out, Waiting{Key: it.ID, Machine: h.Machine, Path: path})
	}
	return out
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

// planItem dispatches to the kind-specific builder.
func planItem(it engine.Item, machine string, sl snapLookup) itemPlan {
	switch it.Kind {
	case item.KindBranch:
		return branchSteps(it, machine, sl)
	case item.KindWorktree:
		return worktreeSteps(it, machine, sl)
	case item.KindRepo:
		return itemPlan{steps: repoSteps(it)}
	case item.KindPR:
		return itemPlan{steps: prSteps(it)}
	case item.KindIssue:
		return itemPlan{steps: issueSteps(it)}
	}
	return itemPlan{}
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
// GitHub delete: one step from the item's GitHub copy (engine.Item.GitHubCopy),
// through GitHub's API, so it needs no clone and runs from either Mac.
// ExpectedTip is the copy's commit, baked into the updateRefs so GitHub
// refuses a moved branch; the precondition (PreconditionGitHubTip) reads
// GitHub again before it runs. A hold on the GitHub delete (an open PR) keeps
// it out; a copy not looked up (no repository id) says to sync first.
//
// Local delete: one step per clone on machine, with ExpectedTip set from the
// snapshot's branch tip for that clone (precondition:
// branch-tip-unchanged-and-landed), unless a local hold on this machine (a
// worktree, the clone's current branch) keeps it out.
//
// A local copy only on another Mac waits for that Mac.
func branchSteps(it engine.Item, machine string, sl snapLookup) itemPlan {
	if it.Decision.Disposition != item.Delete {
		return itemPlan{}
	}

	branch := it.Key.Branch
	localClones := machineClones(it, machine)
	longLived := observe.LongLived(branch, "")
	for _, c := range localClones {
		if b, ok := sl.branch(c, branch); ok && b.LongLived {
			longLived = true
		}
	}
	if longLived {
		return itemPlan{held: []engine.Hold{{Kind: engine.HoldLongLived, Text: branch + " is a long-lived branch: casebook never deletes it",
			Stops: []item.Disposition{item.Delete}}}}
	}

	ip := itemPlan{waiting: waits(it)}
	var remoteHolds, localHolds []engine.Hold
	for _, h := range it.Holds {
		switch {
		case h.Remote:
			remoteHolds = append(remoteHolds, h)
		case h.Local && h.Machine == machine:
			localHolds = append(localHolds, h)
		}
	}

	switch c, ok := it.GitHubCopy(); {
	case !ok:
	case len(remoteHolds) > 0:
		ip.held = append(ip.held, remoteHolds...)
	case c.RepoID == "":
		ip.held = append(ip.held, engine.Hold{Kind: engine.HoldNothingHere, Text: "GitHub copy not looked up yet: sync first", Stops: []item.Disposition{item.Delete}, Remote: true})
	default:
		ip.steps = append(ip.steps, Step{
			Key:          it.ID,
			Action:       "branch-delete-remote",
			Lane:         LaneCasebook,
			Command:      branchDeleteGitHubCmd(c.RepoID, branch, c.Tip),
			Precondition: PreconditionGitHubTip,
			ExpectedTip:  c.Tip,
		})
	}

	// One local-delete step per clone on this machine. The expected tip is the
	// snapshot's local branch tip, always known for local steps, and baked into
	// the update-ref command so it refuses a moved branch.
	if len(localHolds) > 0 && len(localClones) > 0 {
		ip.held = append(ip.held, localHolds...)
		return ip
	}
	for _, clonePath := range localClones {
		b, ok := sl.branch(clonePath, branch)
		if !ok {
			continue // this Mac's snapshot no longer has it there
		}
		tip := b.Tip
		ip.steps = append(ip.steps, Step{
			Key:          it.ID,
			Action:       "branch-delete-local",
			Lane:         LaneCasebook,
			Command:      branchDeleteLocalCmd(clonePath, branch, tip),
			Precondition: "branch-tip-unchanged-and-landed",
			ExpectedTip:  tip,
		})
	}
	return ip
}

// worktreeSteps generates a step to remove a worktree with disposition delete.
// Only generated when the worktree's machine matches the plan machine.
// The clone path is looked up from the snapshot (the clone that owns the
// worktree), not from the item's Locations list.
func worktreeSteps(it engine.Item, machine string, sl snapLookup) itemPlan {
	if it.Decision.Disposition != item.Delete {
		return itemPlan{}
	}
	if it.Key.Machine != machine {
		return itemPlan{waiting: waits(it)}
	}
	worktreePath := it.Key.Path
	clone, ok := sl.cloneForWorktree[worktreePath]
	if !ok {
		// Worktree not found in snapshot; fall back to Locations.
		clonePath := machineCloneForWorktree(it, machine)
		if clonePath == "" {
			return itemPlan{}
		}
		clone.Path = clonePath
	}
	return itemPlan{steps: []Step{{
		Key:          it.ID,
		Action:       "worktree-remove",
		Lane:         LaneCasebook,
		Command:      worktreeRemoveCmd(clone.Path, worktreePath),
		Precondition: "worktree-clean",
	}}}
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
			Comment:      comment,
			Public:       it.Public && comment != "",
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
		Comment: comment,
		Public:  it.Public && comment != "",
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
