//=============================================================================
// inject.js - put the bridge, the probes and a repro's hooks into a game tree.
//
// The tree is whichever commit the runner was asked to build, so the game's
// code may not match what a patch expects. An anchor that is missing is a fact
// to report, not a reason to stop. Every probe and every hook comes back as landed or not, and
// the runner decides what that means for a verdict.
//
// There is no cleanup counterpart. The runner only ever injects into its own
// cached worktrees (see checkout.js), and resets one with git before every
// build, which is both simpler and more thorough than reversing each edit.
//=============================================================================

const fs = require('fs');
const path = require('path');
const lib = require('./lib.js');
const spec = require('./payload.js');
const events = require('./events.js');

const PAYLOAD = path.resolve(__dirname, '..', 'payload');

// A line that opens a statement whose body is the NEXT line - `if (x)`,
// `else`, `with (y)` with no brace. Inserting after one of these would make the
// hook the body and push the real body out of the branch.
const HEADER = /^(if|else|while|for|with|repeat)\b/;
function opensBody(line) {
  const t = line.trim();
  return HEADER.test(t) && !/[;{}]$/.test(t);
}

const countLines = (text, line) => text.split(/\r?\n/).filter((l) => l.trim() === line.trim()).length;

// Insert `insert` next to the single line equal to `anchor`, refusing any
// placement that would change which statement a braceless body belongs to.
// Returns { text } or { error }.
function placeHook(text, anchor, insert, where) {
  const lines = text.split(/\r?\n/);
  const at = lines.map((l, i) => (l.trim() === anchor.trim() ? i : -1)).filter((i) => i >= 0);
  if (at.length === 0) return { error: 'anchor not found' };
  if (at.length > 1) return { error: `anchor appears ${at.length} times, so the site is ambiguous` };
  const i = at[0];
  if (where === 'after' && opensBody(lines[i])) {
    return { error: 'anchor opens a braceless body; the hook would become that body' };
  }
  if (where === 'before' && i > 0 && opensBody(lines[i - 1])) {
    return { error: 'anchor is the braceless body of the line above it; the hook would displace it' };
  }
  const indent = lines[i].slice(0, lines[i].length - lines[i].trimStart().length);
  lines.splice(where === 'after' ? i + 1 : i, 0, indent + insert);
  return { text: lines.join(text.includes('\r\n') ? '\r\n' : '\n') };
}

// hooks: { <name>: { file: 'Scripts/.../x.gml' | object: 'Name', event: 'Step', after|before: '<line>' } }
function inject(repo, { hooks = {}, quiet = false } = {}) {
  const tree = lib.resolveGg2Tree(repo);
  lib.step(`Injecting the bridge into ${tree}`, quiet);

  // --- the payload ----------------------------------------------------------
  for (const name of spec.OBJECTS) {
    fs.copyFileSync(path.join(PAYLOAD, 'Objects', `${name}.xml`), path.join(tree, 'Objects', `${name}.xml`));
    fs.cpSync(path.join(PAYLOAD, 'Objects', `${name}.events`), path.join(tree, 'Objects', `${name}.events`), {
      recursive: true,
      force: true,
    });
  }
  fs.cpSync(path.join(PAYLOAD, 'Scripts', spec.SCRIPT_GROUP), path.join(tree, 'Scripts', spec.SCRIPT_GROUP), {
    recursive: true,
    force: true,
  });

  const objList = path.join(tree, 'Objects', '_resources.list.xml');
  for (const name of spec.OBJECTS) lib.addBeforeLine(objList, '</resources>', `  <resource name="${name}" type="RESOURCE"/>`);
  lib.addBeforeLine(path.join(tree, 'Scripts', '_resources.list.xml'), '</resources>', `  <resource name="${spec.SCRIPT_GROUP}" type="GROUP"/>`);

  // Without this there is no bridge at all, so it is the one edit allowed to
  // fail the build.
  lib.addAfterLine(path.join(tree, 'Scripts', 'Game', 'game_init.gml'), spec.INIT_ANCHOR, spec.INIT_LINE);

  // Held input. Reported like a probe: a repro that never presses a key does
  // not care whether this tree still has the anchor.
  let input = false;
  try {
    const before = events.readEvent(repo, spec.KEYSTATE_OBJECT, spec.KEYSTATE_EVENT, 0).gml;
    const after = lib.insertLineText(before, spec.KEYSTATE_ANCHOR, spec.KEYSTATE_LINE, 'after');
    if (after !== null) events.writeEvent(repo, spec.KEYSTATE_OBJECT, spec.KEYSTATE_EVENT, 0, after);
    input = true;
  } catch (e) {
    lib.warn(`held input not wired: ${e.message}`);
  }

  // --- probes ---------------------------------------------------------------
  const patches = [];
  for (const patch of spec.CODE_PATCHES) {
    const file = path.join(tree, ...patch.file);
    const where = patch.file.join('/');
    let status = 'missing';
    if (fs.existsSync(file)) {
      const text = lib.readText(file);
      if (countLines(text, patch.to) > 0) status = 'landed';
      else {
        const n = countLines(text, patch.from);
        if (n === 1) {
          lib.writeText(file, lib.replaceLineText(text, patch.from, patch.to));
          status = 'landed';
        } else if (n > 1) {
          status = 'ambiguous';
        }
      }
    }
    patches.push({ probe: patch.probe, file: where, status });
  }
  const probes = { input };
  for (const name of Object.keys(spec.PROBES).filter((p) => p !== 'input')) {
    probes[name] = patches.some((p) => p.probe === name && p.status === 'landed');
  }
  const have = Object.keys(probes).filter((p) => probes[p]);
  const lack = Object.keys(probes).filter((p) => !probes[p]);
  lib.ok(`probes: ${have.join(', ') || 'none'}${lack.length ? ` (not in this tree: ${lack.join(', ')})` : ''}`, quiet);

  // --- hooks ----------------------------------------------------------------
  const hookReport = {};
  for (const [name, site] of Object.entries(hooks)) {
    if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`hook name ${JSON.stringify(name)} must be letters, digits and _`);
    const where = site.after !== undefined ? 'after' : 'before';
    const anchor = site.after !== undefined ? site.after : site.before;
    if (typeof anchor !== 'string') throw new Error(`hook ${name} needs an 'after' or 'before' line`);
    const line = spec.hookLine(name);
    let result;
    try {
      if (site.file) {
        const file = path.join(tree, ...site.file.split(/[\\/]/));
        if (!fs.existsSync(file)) result = { error: `${site.file} does not exist in this tree` };
        else {
          const placed = placeHook(lib.readText(file), anchor, line, where);
          if (placed.text) lib.writeText(file, placed.text);
          result = placed;
        }
      } else if (site.object && site.event) {
        const file = events.eventFile(repo, site.object, site.event);
        let placed = { error: 'anchor not found' };
        let found = 0;
        events.editActions(file, (gml) => {
          const attempt = placeHook(gml, anchor, line, where);
          if (attempt.error === 'anchor not found') return null;
          found++;
          placed = attempt;
          return attempt.text || null;
        });
        if (found > 1) placed = { error: 'anchor appears in more than one code action' };
        result = placed;
      } else {
        throw new Error(`hook ${name} needs either 'file' or 'object' and 'event'`);
      }
    } catch (e) {
      result = { error: e.message };
    }
    hookReport[name] = result.error ? { landed: false, error: result.error } : { landed: true };
    if (result.error) lib.warn(`hook ${name} not placed: ${result.error}`);
    else lib.ok(`hook ${name} placed ${where} '${anchor.trim()}'`, quiet);
  }

  return { probes, patches, hooks: hookReport };
}

module.exports = { inject, placeHook, opensBody };
