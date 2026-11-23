[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Riial/makefun-hidden-spec-cli-01-run-20261122-v2/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Riial/makefun-hidden-spec-cli-01-run-20261122-v2/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

One patch tool for every AI edit format, for make.fun's ["Build mend, one patch tool for every AI edit format" bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122). `mend` reads an edit a model wrote and
applies it to a tree of text files — every file changes, or nothing does.

## Formats

- unified diffs (`---` / `+++` / `@@` hunks)
- SEARCH/REPLACE blocks (`<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`)
- V4A patches (`*** Begin Patch` ... `*** End Patch`)
- JSON edits (one JSON array, or one edit object per line)

## Use

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is a patch file; without one (or with `-`) the patch comes from standard
input. `--format` picks one format (`unified`, `search-replace`, `v4a`, `json`,
or `auto`, the default, which detects it). `--check` reports what would change
without writing anything. `--strict` matches lines exactly (tier 0 only).

Exit 0 lists the changed paths and `ok: n files`; exit 1 lists the edits that
failed and `failed: k of n edits`; exit 2 is a usage, missing-patch, format or
parse error, one line.

Node 22, standard library only.
