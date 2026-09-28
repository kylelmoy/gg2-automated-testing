# Working on gg2-automated-testing

Read `README.md` for what this is, and `docs/WRITING-REPROS.md` before writing a repro.

- **The game repo is read-only here.** The runner works in its own worktrees
  under `.cache/`. Never inject into, build in, or commit to a real checkout of
  Gang-Garrison-2.
- **After changing `lib/` or `payload/`,** run `node test/selftest.js` (offline, a
  few seconds). Then run one real proof end to end with a repro (`repros/example.js`
  will do), against a commit that has the bug and one that has the fix.
- **Only `repros/example.js` is tracked.** Other repros and investigation notes
  live in `repros/` and `investigations/` locally and are gitignored.
- **A payload change invalidates every cached build** (the cache key hashes
  `payload/`, `lib/payload.js`, `lib/inject.js` and the gm8-builder version), so
  the next run of each commit rebuilds it.
- **Payload `.gml` must be plain ASCII.** GM8 stores code a byte per
  character and gm8-builder replaces anything else; the selftest checks this.
- **Never report PASS for a run that did not ask the question.** That is what
  INCONCLUSIVE is for, and what `assume` is for in a repro. A missing probe, an
  unplaced hook, a setup failure or an error in hook code must never turn into
  PASS.
- **One bridge client per game.** The runner holds the only connection to every
  game it starts; nothing else may connect to them.
- **GML is Game Maker 8, not GameMaker Studio.** It has no `?:`, `try`, structs
  or string escapes. `ds_map_replace` does not add a missing key. A deactivated
  (frozen) instance cannot be read from anywhere. Code run by `execute_string`
  cannot see the calling script's `var` locals.
- Commits: subject plus a short body.
