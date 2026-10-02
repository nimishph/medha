---
title: Maintenance and sharing
description: Preflight, compaction, backup and restore, sharing a store across machines, and the local dashboard and HTML report.
---

# Maintenance and sharing

Everything medha knows is in `.medha/`. This page covers keeping it healthy, moving it between
machines, and looking at it.

## What is in the directory

```
.medha/
├── config.json     # the registries — small, human-authored, meant to be committed
├── store.sqlite    # the append-only episode log — gitignored by default
├── .gitignore      # written by init; safe to edit or delete
└── README.md       # a short orientation note, also written by init
```

The split is deliberate. `config.json` is configuration: review it in a pull request, commit it like
any other project file. The store is data, and it has its own sync channel (below) with its own
conflict resolution — which is *not* git's. Committing the store directly is supported, but expect
merge conflicts that a normal `git merge` cannot resolve intelligently.

`medha init` writes a `.gitignore` that excludes the store and its SQLite journal files, with a
comment explaining why. If you would rather commit the store as a simple manual sync, delete that
file.

## Check the store

```sh
medha maintain preflight
```

```
medha: preflight for /your/project/.medha
  status:     ok
  episodes:   6
  entities:   2
  integrity:  ok
  registries: 4 kinds, 4 signals, 1 anchors
  last sweep: 2026-09-28T05:57:31.194Z
```

This verifies store integrity and that the registries match. Run it after editing
[the configuration](/guide/extending), and any time you want to know whether a store is still sound —
it is cheap and it gates `medha init` too.

`medha status` is the broader view: preflight, the distribution of entities across lifecycle statuses,
the drift count, and the registry sizes.

```
medha: status for /your/project/.medha
  store:      /your/project/.medha/store.sqlite
  preflight:  ok — 6 episodes, 2 entities, integrity ok
  last sweep: 2026-09-28T05:57:31.194Z
  by status:  probation 1, active 1, trusted 0, quarantined 0, retired 0
  drifting:   0
  registries: 4 kinds, 4 signals, 1 anchors
  params:     read-only canonical defaults — run `medha params` to see them
```

## Compact the log

The store is append-only, so it only grows. `compact` folds old episodes into per-entity baselines
once they are past their useful life, and tells you exactly what it folded:

```sh
medha maintain compact --older-than 90
```

```
medha: compaction for /your/project/.medha
  folded range:        none
  baselines written:   0
  remaining episodes:  6
  entities affected:   2
  older than (days):   90
```

`folded range: none` is the expected result on a young store — there is nothing old enough yet. The
defaults are 90 days for folding and 90 days of retention afterwards.

Compaction is safe because state is a fold over the log: folding replaces a run of old episodes with
the summary they would have produced, so the answer does not change. It reduces the log to what is
still worth reading episode by episode.

## Back up and restore

```sh
medha maintain backup snapshot.json
```

```
medha: backup for /your/project/.medha
  written to:   snapshot.json
  format:       sutras.medha/v1
  episodes:     6
  as of:        2026-09-28T06:01:14.387Z
```

Atomic and portable: it is a single self-describing file, safe to keep in version control or to move
between machines. Restoring is the inverse:

```sh
medha maintain restore snapshot.json
```

## Share a store between machines

```sh
medha sync status
```

```
Sync Status: UNINITIALIZED
  Local entities:  2
  Target ref/file: refs/medha/memory
  Note:            Directory is not a git repository
```

Sync moves evidence between machines through a **git ref** or a **file**. `push` and `pull` carry the
episodes; `status` compares the local store against the target.

The important property: **registries travel with the episodes**. Custom kinds, signals and anchor
kinds come along, so a collaborator does not have to hand-maintain the same `config.json` you did. If
you have extended the model, that is handled for you.

The reason this is not just `git commit` is merge semantics. The log is append-only, and medha's merge
resolves concurrent appends; git would hand you a textual conflict in a store file and leave you to
work it out. Using a dedicated ref keeps the evidence channel separate from the code channel.

`--remote` takes a configured remote name (`origin`, `team`) or a path or URL to a repository
directly. A name that is not configured is an error rather than a local-only sync. The ref is
`refs/medha/memory`; medha 0.5 and earlier used `refs/sutra/medha/memory`, which `pull` and
`status` still read, so an upgrade does not strand evidence pushed by an older version.

See [the sync commands](/cli) for the full set of flags.

## Look at it

**A local dashboard:**

```sh
medha ui
```

**A standalone HTML report:**

```sh
medha report --out report.html
```

```
medha: generated evidential report snapshot at /your/project/report.html
  entities: 2  episodes: 6
```

`report` writes a single self-contained offline file — no server, no assets, no network. It is meant
to be attached to a review or a ticket, so the trust state at a point in time can be discussed by
people who do not have medha installed.

## Routine

There is no scheduler to configure. A background sweep runs inside the engine on reads and writes
(`medha status` reports when it last ran), and nothing about the store requires babysitting.

What is worth doing by hand:

| When | What |
| --- | --- |
| After editing `config.json` | `medha maintain preflight` |
| Occasionally, as the log grows | `medha maintain compact --older-than 90` |
| Before anything risky | `medha maintain backup snapshot.json` |
| When something looks wrong | `medha status`, then `medha show --id <id>` |

## Fixing bad data

Because state is derived from an append-only log, corrections are ordinary operations rather than
emergency repairs.

```sh
medha retract --seq 12 --reason "recorded against the wrong entity"   # mask it
medha remove-episode --seq 13 --author human:you --reason "duplicate"  # drop it
```

`retract` appends a masking episode and recomputes; `remove-episode` takes the entry out of the log
entirely and resequences what follows. Both leave a trace: a retraction is itself an episode, and a
removal is kept in the store's `audit:removedEpisodes` meta (who, why, when, and the episode that was
removed), which `maintain backup` carries along.

Over MCP these are the `retract_episode` and `remove_episode` tools.

## Next

- [Extending medha](/guide/extending) — custom kinds, signals, and thresholds.
- [CLI reference](/cli) — every command and flag.
