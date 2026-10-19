package apply

import (
	"fmt"
	"strings"
)

// shellQuote wraps s in POSIX single quotes, escaping any embedded single
// quotes as '"'"' so the result is always safe to embed in a shell command.
// The output is copy-pasteable into any POSIX-compatible shell.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'"'"'`) + "'"
}

// branchDeleteLocalCmd renders the exact compare-and-delete command for a local
// branch: update-ref -d carries the expected tip, so git refuses to delete if
// the branch moved between the precondition and the command (closes the
// check\u2192delete race). The tip is always known for local steps.
func branchDeleteLocalCmd(clonePath, branch, tip string) string {
	return fmt.Sprintf("git -C %s update-ref -d %s %s",
		shellQuote(clonePath), shellQuote("refs/heads/"+branch), tip)
}

// updateRefsMutation is GitHub's atomic ref update: it refuses unless each
// ref is still at beforeOid. An all-zero afterOid deletes the ref; an
// all-zero beforeOid means the ref must not exist (a create).
const updateRefsMutation = `mutation($r:ID!,$n:String!,$b:GitObjectID!,$a:GitObjectID!){updateRefs(input:{repositoryId:$r,refUpdates:[{name:$n,beforeOid:$b,afterOid:$a}]}){clientMutationId}}`

// zeroOid is git's all-zero object id: "no ref" in an updateRefs.
const zeroOid = "0000000000000000000000000000000000000000"

// branchDeleteGitHubCmd renders the exact command that deletes a branch on
// GitHub through its API, from either Mac: GitHub refuses it unless the
// branch is still at tip.
func branchDeleteGitHubCmd(repoID, branch, tip string) string {
	return updateRefsCmd(repoID, branch, tip, zeroOid)
}

// branchRestoreGitHubCmd renders the undo of branchDeleteGitHubCmd: it makes
// the branch on GitHub again at tip, and GitHub refuses it if the branch
// exists.
func branchRestoreGitHubCmd(repoID, branch, tip string) string {
	return updateRefsCmd(repoID, branch, zeroOid, tip)
}

func updateRefsCmd(repoID, branch, before, after string) string {
	return "gh api graphql -f query=" + shellQuote(updateRefsMutation) +
		" -f r=" + shellQuote(repoID) +
		" -f n=" + shellQuote("refs/heads/"+branch) +
		" -f b=" + shellQuote(before) +
		" -f a=" + shellQuote(after)
}

// worktreeRemoveCmd renders the exact command to remove a linked worktree.
func worktreeRemoveCmd(clonePath, worktreePath string) string {
	return fmt.Sprintf("git -C %s worktree remove %s",
		shellQuote(clonePath), shellQuote(worktreePath))
}

// repoArchiveCmd renders the exact command to archive a GitHub repository.
func repoArchiveCmd(repo string) string {
	return fmt.Sprintf("gh repo archive %s --yes", shellQuote(repo))
}

// repoDeleteCmd renders the exact command to delete a GitHub repository.
func repoDeleteCmd(repo string) string {
	return fmt.Sprintf("gh repo delete %s --yes", shellQuote(repo))
}

// prCloseCmd renders the exact command to close a pull request, with the
// closing comment when there is one ("" closes without a comment).
func prCloseCmd(n int, repo, comment string) string {
	return fmt.Sprintf("gh pr close %d -R %s", n, shellQuote(repo)) + commentFlag(comment)
}

// prMergeCmd renders the exact command to merge a pull request, as a squash:
// gh refuses to choose a method when nobody is at the keyboard.
func prMergeCmd(n int, repo string) string {
	return fmt.Sprintf("gh pr merge %d -R %s --squash", n, shellQuote(repo))
}

// issueCloseCmd renders the exact command to close an issue, with the
// closing comment when there is one ("" closes without a comment).
func issueCloseCmd(n int, repo, comment string) string {
	return fmt.Sprintf("gh issue close %d -R %s", n, shellQuote(repo)) + commentFlag(comment)
}

// commentFlag is a close command's " --comment '<comment>'", or "" for no
// comment.
func commentFlag(comment string) string {
	if comment == "" {
		return ""
	}
	return " --comment " + shellQuote(comment)
}
