package cli

import (
	"path/filepath"
	"testing"

	"github.com/subaud-tools/tools-common/claudeplugin"
)

// The casebook plugin is rendered by tools-common, not written by hand: its
// manifest, the .mcp.json that runs `casebook channel` for the tools, and the
// mod that runs `casebook watch` and starts a turn with each event. Regenerate
// with CLAUDEPLUGIN_UPDATE=1 go test -run '^TestPluginIsCurrent$' ./internal/casebook/cli
func TestPluginIsCurrent(t *testing.T) {
	claudeplugin.AssertCurrent(t, filepath.Join("..", "..", "..", "plugin", "casebook"), claudeplugin.Spec{
		Name:        "casebook",
		DisplayName: "casebook",
		Bin:         "casebook",
		ServerName:  "casebook",
		Description: "Decide the fate of every repo, pull request, issue, branch and worktree; the user's messages from casebook's page land in the session.",
		Author:      "Court Schuett",
		AuthorURL:   "https://casebook.tools",
		Homepage:    "https://casebook.tools",
		Repository:  "https://github.com/subaud-tools/casebook",
		License:     "MIT",
		Keywords:    []string{"github", "triage", "branches", "worktrees"},
	})
}
