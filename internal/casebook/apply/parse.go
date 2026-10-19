package apply

import (
	"fmt"
	"strings"
)

// ShellSplit splits a POSIX shell command line produced by command.go into its
// words, honouring single and double quotes (the only quoting shellQuote emits).
// It is not a general shell parser: it covers exactly the commands casebook
// generates so the lane runner can turn a stored command back into (dir, args).
// ShellSplit is the single shared parser used by both the casebook-lane runner
// and the serve layer that executes restore commands.
func ShellSplit(s string) ([]string, error) {
	var words []string
	var cur []byte
	inWord := false
	for i := 0; i < len(s); {
		c := s[i]
		switch c {
		case ' ', '\t':
			if inWord {
				words = append(words, string(cur))
				cur = cur[:0]
				inWord = false
			}
			i++
		case '\'':
			inWord = true
			i++
			for i < len(s) && s[i] != '\'' {
				cur = append(cur, s[i])
				i++
			}
			if i >= len(s) {
				return nil, fmt.Errorf("unterminated single quote in %q", s)
			}
			i++ // closing quote
		case '"':
			inWord = true
			i++
			for i < len(s) && s[i] != '"' {
				cur = append(cur, s[i])
				i++
			}
			if i >= len(s) {
				return nil, fmt.Errorf("unterminated double quote in %q", s)
			}
			i++ // closing quote
		default:
			inWord = true
			cur = append(cur, c)
			i++
		}
	}
	if inWord {
		words = append(words, string(cur))
	}
	return words, nil
}

// gitCommand parses a "git -C <dir> <args...>" command into its working
// directory and the argument list to pass to RunGit.
func gitCommand(cmd string) (dir string, args []string, err error) {
	w, err := ShellSplit(cmd)
	if err != nil {
		return "", nil, err
	}
	if len(w) < 4 || w[0] != "git" || w[1] != "-C" {
		return "", nil, fmt.Errorf("not a git -C command: %q", cmd)
	}
	return w[2], w[3:], nil
}

// parseLocalDelete parses the compare-and-delete local command
// "git -C <dir> update-ref -d refs/heads/<branch> <tip>".
func parseLocalDelete(cmd string) (dir, branch string, err error) {
	d, args, err := gitCommand(cmd)
	if err != nil {
		return "", "", err
	}
	if len(args) != 4 || args[0] != "update-ref" || args[1] != "-d" {
		return "", "", fmt.Errorf("not a local-delete command: %q", cmd)
	}
	ref := args[2]
	if !strings.HasPrefix(ref, "refs/heads/") {
		return "", "", fmt.Errorf("not a branch ref: %q", ref)
	}
	return d, strings.TrimPrefix(ref, "refs/heads/"), nil
}

// LocalDeleteDir is the clone a local branch delete command runs in
// (false for any other command).
func LocalDeleteDir(cmd string) (string, bool) {
	dir, _, err := parseLocalDelete(cmd)
	return dir, err == nil
}

// ghCommand parses a "gh <args...>" command into the arguments for gh.
func ghCommand(cmd string) ([]string, error) {
	w, err := ShellSplit(cmd)
	if err != nil {
		return nil, err
	}
	if len(w) < 2 || w[0] != "gh" {
		return nil, fmt.Errorf("not a gh command: %q", cmd)
	}
	return w[1:], nil
}

// parseUpdateRefs parses an updateRefsCmd into its variables.
func parseUpdateRefs(cmd string) (repoID, branch, before, after string, err error) {
	args, err := ghCommand(cmd)
	if err != nil {
		return "", "", "", "", err
	}
	if len(args) != 12 || args[0] != "api" || args[1] != "graphql" || args[2] != "-f" || args[3] != "query="+updateRefsMutation {
		return "", "", "", "", fmt.Errorf("not an updateRefs command: %q", cmd)
	}
	var vals []string
	for i, name := range []string{"r=", "n=refs/heads/", "b=", "a="} {
		flag, v := args[4+2*i], args[5+2*i]
		if flag != "-f" || !strings.HasPrefix(v, name) {
			return "", "", "", "", fmt.Errorf("not an updateRefs command: %q", cmd)
		}
		vals = append(vals, strings.TrimPrefix(v, name))
	}
	if vals[1] == "" {
		return "", "", "", "", fmt.Errorf("no branch in %q", cmd)
	}
	return vals[0], vals[1], vals[2], vals[3], nil
}

// parseGitHubDelete parses branchDeleteGitHubCmd.
func parseGitHubDelete(cmd string) (repoID, branch, tip string, err error) {
	repoID, branch, tip, after, err := parseUpdateRefs(cmd)
	if err != nil {
		return "", "", "", err
	}
	if after != zeroOid || tip == zeroOid {
		return "", "", "", fmt.Errorf("not a GitHub branch delete: %q", cmd)
	}
	return repoID, branch, tip, nil
}

// parseWorktreeRemove parses "git -C <dir> worktree remove <path>".
func parseWorktreeRemove(cmd string) (dir, path string, err error) {
	d, args, err := gitCommand(cmd)
	if err != nil {
		return "", "", err
	}
	if len(args) != 3 || args[0] != "worktree" || args[1] != "remove" {
		return "", "", fmt.Errorf("not a worktree-remove command: %q", cmd)
	}
	return d, args[2], nil
}
