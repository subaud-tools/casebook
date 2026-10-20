package serve

import (
	"fmt"
	"os"
	"testing"
)

// TestMain points casebook's state folder (github.json, the sync lock) at a
// temp dir for the whole package: serve re-reads GitHub after a delete or an
// undo and saves the cache there, and a test must never write Court's.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "casebook-serve-state-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := os.Setenv("XDG_STATE_HOME", dir); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}
