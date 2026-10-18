// Package version holds casebook's ldflags-stamped build metadata. The release
// workflow stamps these vars from the VERSION file on main.
package version

// These are overridden at release time via `-ldflags -X`.
var (
	version = "dev"
	commit  = ""
	date    = ""
)

// Number returns the semantic version (e.g. "0.1.0"), or "dev" for local builds.
func Number() string { return version }

// Commit returns the short commit SHA the binary was built from, if stamped.
func Commit() string { return commit }

// Date returns the build date (YYYY-MM-DD), if stamped.
func Date() string { return date }
