# casebook

casebook records the intended fate of every repo, pull request, issue, branch
and worktree you own or touch, journals git/gh activity from any agent or
terminal, and shows what needs attention. Its data lives in your own private
git repo. (Preview.) A `.tools` family member.

## Install

    kempt apply -manifest cmd/casebook/kempt.toml -packages casebook

Then `casebook init` (creates a private `<you>/casebook-data` if needed) and
`casebook hooks install`. The binary downloads from casebook.tools
(`https://casebook.tools/dl/casebook/<version>/`).

A casebook installed before 0.15.0 (built in github.com/subaud-tools/tackle)
updates from tackle.tools and stays at 0.14.0: run `kempt update` or the
casebook.tools installer once to move it to casebook.tools.

## Releasing

A merge to `main` that raises `VERSION` releases casebook: signed and
notarized, published to GitHub and to casebook.tools/dl. `version-guard`
fails a pull request that doesn't raise it (or carry the `no-release` label).

## Develop

    go build ./cmd/casebook
    go test ./...
    just verify        # what CI and the pre-push hook run
    just verify-slow   # the page's browser probe

## License

[MIT](LICENSE) © 2026 Court Schuett
