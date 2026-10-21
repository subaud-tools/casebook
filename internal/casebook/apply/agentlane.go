package apply

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/subaud-tools/casebook/internal/casebook/item"
	"github.com/subaud-tools/casebook/internal/casebook/observe"
)

// ObserveGh makes a targeted gh read to check the outcome of an agent-lane
// step (§5.5). It returns an item.Observed that Verify can use to promote a
// reported step to verified, or flag it as drift.
//
// Each is a REST read (casebook reads GitHub through REST only, Court,
// 2026-10-20). For pr-close and pr-merge, the PR's state; for issue-close,
// the issue's; for repo-archive, the repo's archived flag; for repo-delete,
// a 404 for the repo.
// For branch-delete-remote (casebook lane), a read of the ref on GitHub.
// Any other action or a nil gh runner returns an inconclusive observation.
func ObserveGh(ctx context.Context, step JobStep, gh observe.Runner) item.Observed {
	if gh == nil {
		return item.Observed{}
	}
	k, err := item.ParseKey(step.Key)
	if err != nil {
		return item.Observed{}
	}
	switch step.Action {
	case "branch-delete-remote":
		return observeGitHubBranch(ctx, step, gh)
	case "pr-close", "pr-merge":
		b, err := gh.Gh(ctx, "api", fmt.Sprintf("repos/%s/%s/pulls/%d", k.Owner, k.Name, k.Number))
		if err != nil {
			return item.Observed{}
		}
		var v struct {
			State    string  `json:"state"`
			MergedAt *string `json:"merged_at"`
		}
		if json.Unmarshal(b, &v) != nil || v.State == "" {
			return item.Observed{}
		}
		st := strings.ToUpper(v.State)
		if v.MergedAt != nil {
			st = "MERGED"
		}
		return item.Observed{Known: true, Exists: true, State: st}

	case "issue-close":
		b, err := gh.Gh(ctx, "api", fmt.Sprintf("repos/%s/%s/issues/%d", k.Owner, k.Name, k.Number))
		if err != nil {
			return item.Observed{}
		}
		var v struct {
			State string `json:"state"`
		}
		if json.Unmarshal(b, &v) != nil || v.State == "" {
			return item.Observed{}
		}
		return item.Observed{Known: true, Exists: true, State: strings.ToUpper(v.State)}

	case "repo-archive":
		b, err := gh.Gh(ctx, "api", "repos/"+k.Owner+"/"+k.Name)
		if err != nil {
			return item.Observed{}
		}
		var v struct {
			Archived *bool `json:"archived"`
		}
		if json.Unmarshal(b, &v) != nil || v.Archived == nil {
			return item.Observed{}
		}
		return item.Observed{Known: true, Exists: true, Archived: *v.Archived}

	case "repo-delete":
		_, err := gh.Gh(ctx, "api", "repos/"+k.Owner+"/"+k.Name)
		if err == nil {
			// No error: repo still exists.
			return item.Observed{Known: true, Exists: true}
		}
		// Only GitHub's 404 counts as deleted. Any other error (network,
		// auth, etc.) is inconclusive.
		if notFound(err) {
			return item.Observed{Known: true, Exists: false}
		}
		return item.Observed{} // inconclusive
	}
	return item.Observed{}
}
