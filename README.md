# mend

One patch tool for every AI edit format. `mend` reads an edit a model wrote and
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
