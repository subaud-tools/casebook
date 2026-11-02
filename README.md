# casebook

casebook records the intended fate of every repo, pull request, issue, branch and worktree you own or touch, journals git/gh activity from any agent or terminal, and shows what needs attention. Its data lives in your own private git repo. (Preview.) A `.tools` family member.

## Install

    kempt apply -manifest cmd/casebook/kempt.toml -packages casebook

Then `casebook init` (creates a private `<you>/casebook-data` if needed) and `casebook hooks install`. The binary downloads from casebook.tools (`https://casebook.tools/dl/casebook/<version>/`).

The manifest also enables casebook's Claude Code plugin, which lives in the [subaud-tools/plugins](https://github.com/subaud-tools/plugins) marketplace. Without kempt, run `/plugin marketplace add subaud-tools/plugins` and `/plugin install casebook@subaud-tools` in Claude Code.

A casebook installed before 0.15.0 (built in github.com/subaud-tools/tackle) updates from tackle.tools and stays at 0.14.0: run `kempt update` or the casebook.tools installer once to move it to casebook.tools.

## Releasing

A merge to `main` that raises `VERSION` releases casebook: signed and notarized, published to GitHub and to casebook.tools/dl. `version-guard` fails a pull request that doesn't raise it (or carry the `no-release` label).

Releases also publish `casebook_setup.tar.gz`, built with `casebook setup-bundle --version X.Y.Z --out PATH`. This build-only command packages the embedded declaration without reading personal configuration or installing anything. The fragment requires kempt 0.13 or newer for exact Claude hook reconciliation and includes the existing sync service, plugin and channel configuration. It contains no binary download or filesystem assets. Private data initialization and the global Git recorder with prior-hook chaining remain explicit personal actions (`casebook init` and `casebook hooks install`); the bundle does not perform them.

## Develop

    go build ./cmd/casebook
    go test ./...
    just verify        # what CI and the pre-push hook run
    just verify-slow   # the page's browser probe

## License

[MIT](LICENSE) © 2026 Court Schuett
