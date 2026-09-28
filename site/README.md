# site/

The public documentation site for medha, published to GitHub Pages.

```sh
bun run docs:dev      # generate content, then serve with hot reload
bun run docs:build    # generate content, then build to site/.vitepress/dist
bun run docs:preview  # serve the built site
```

The first two run `scripts/sync-content.mjs` and `scripts/gen-cli-ref.ts` before VitePress starts, so
the generated pages always exist and never go stale. `bun` is required for the second script: it
imports TypeScript sources that resolve through the workspace, which node cannot load.

## What gets published

GitHub Pages serves whatever this build produces. The site is a **curated** surface, and the curation
is the point — see the boundary below.

| URL | Source |
| --- | --- |
| `/` | `index.md` (hand-written) |
| `/overview` | copied from the repo `README.md` |
| `/agent-skill` | copied from the repo `SKILL.md` |
| `/guide/*` | hand-written in `guide/` |
| `/cli` | generated from `cli/src/commands.ts` |

`README.md` and `SKILL.md` are copied rather than duplicated on purpose: both are already public (the
README is the GitHub landing page, `SKILL.md` ships inside the npm tarball), and a second hand-kept
copy would drift.

The three generated pages are gitignored — they are build output, and a stale committed copy is worse
than none. This file is excluded from the build via `srcExclude`, because it is a maintainer note
rather than a page.

## The publishing boundary

**Do not add these to the site**, in any form — not as pages, not as excerpts, not as quotes:

| Path | Why |
| --- | --- |
| `docs/spec/trust-formula.md` | The normative reimplementation spec. It exists so another language can be made conformant against the vectors. Publishing it hands over the design. |
| `docs/spec/vectors/**` | Conformance vectors, plus `generate.py` — which is a second, independent implementation of the kernel. |
| `docs/tasklog/**` | Implementation history and internal task identifiers. |
| `docs/tasks/**` | Roadmap. |
| `medha-core/src/**` and friends | The kernel. All four internal packages are `private: true` and ship raw TypeScript, so they are not a published API and do not get TypeDoc pages. |

Two further things are deliberately **not documented on the site**, though they exist in the engine
and are reachable through the shipped binary:

- **Decision trees and entity definitions.** `medha define` and `medha decision` are excluded from the
  generated CLI reference by the `UNPUBLISHED` set in `scripts/gen-cli-ref.ts`. Their help text is
  visible to anyone who installs the package, so this is about the site not presenting the design as a
  supported surface — not about hiding the commands. Remove a name from `UNPUBLISHED` to document it.- **`signalLimits` in the kind spec.** The per-author success limiting in `.medha/config.json` is
  undocumented on the site. The [Extending](/guide/extending) page shows a `kindSpec` without it.

The site's own rule: **describe behaviour a user can observe through the CLI, MCP or `--json`; do not
publish the formula's algebra, the invariants, or the fold mechanics.** `medha show`,
`medha explain-threshold`, `medha params` and `--json` all expose everything a user legitimately needs
to understand the system, and the [How trust is computed](/guide/trust) page is written to that
altitude on purpose — it gives the shape of the formula, the meaning of each component and the
reasoning, which is what makes medha usable, without the derivation.

## Keeping transcripts honest

Every terminal transcript in the guide pages was captured from a real medha 0.5.0 run, not written by
hand. If a command's output changes, re-capture it rather than editing the block — a plausible-looking
transcript that no longer matches the binary is the worst thing this site can contain.

## Adding a page

1. Write it under `guide/`.
2. Add it to the sidebar in `.vitepress/config.mts`.
3. Check it against the boundary table above.

`ignoreDeadLinks` is off, so a link to something that does not exist fails the build. That is
intentional — with a curated set of pages it is easy to link to a page you decided not to write.
