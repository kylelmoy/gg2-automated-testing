//=============================================================================
// events.js - read and write the GML inside an object's event XML.
//
// Event code lives in <argument kind="STRING"> elements and is XML-escaped, so
// `a < b` is stored as `a &lt; b`. Everything here works on the unescaped GML
// and escapes on the way back, leaving every other byte of the file alone.
//=============================================================================

const fs = require('fs');
const path = require('path');
const lib = require('./lib.js');

const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const unescapeXml = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');

// Every code action in an event file, with the byte range of its text.
function codeActions(xml) {
  const out = [];
  const re = /<argument kind="STRING"[^>]*?(?:\/>|>([\s\S]*?)<\/argument>)/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const selfClosing = m[1] === undefined;
    const start = selfClosing ? m.index : m.index + m[0].indexOf('>') + 1;
    const end = selfClosing ? m.index + m[0].length : start + m[1].length;
    out.push({ index: out.length, start, end, selfClosing, gml: selfClosing ? '' : unescapeXml(m[1]) });
  }
  return out;
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// The event file for an object, wherever in Objects/ its folder sits.
function eventFile(repo, object, event) {
  const tree = path.join(path.resolve(repo), 'Source', 'gg2');
  const dirs = walk(path.join(tree, 'Objects'))
    .map((p) => path.dirname(p))
    .filter((d, i, all) => path.basename(d) === `${object}.events` && all.indexOf(d) === i);
  if (dirs.length === 0) throw new Error(`no object called ${object} has any events`);
  const want = event.replace(/\.xml$/, '').toLowerCase();
  const hit = fs.readdirSync(dirs[0]).find((f) => f.toLowerCase() === `${want}.xml`);
  if (!hit) throw new Error(`${object} has no ${event} event`);
  return path.join(dirs[0], hit);
}

function readEvent(repo, object, event, index = 0) {
  const file = eventFile(repo, object, event);
  const action = codeActions(lib.readText(file))[index];
  if (!action) throw new Error(`${object}'s ${event} event has no code action ${index}`);
  return { file, gml: action.gml };
}

function writeEvent(repo, object, event, index, gml) {
  const file = eventFile(repo, object, event);
  const xml = lib.readText(file);
  const action = codeActions(xml)[index];
  if (!action) throw new Error(`${object}'s ${event} event has no code action ${index}`);
  if (!gml.trim()) throw new Error('an event cannot be given empty code');
  const body = escapeXml(gml);
  const replacement = action.selfClosing ? `<argument kind="STRING">${body}</argument>` : body;
  lib.writeText(file, xml.slice(0, action.start) + replacement + xml.slice(action.end));
  return { file };
}

// Apply `edit(gml) -> gml | null` to every code action in an event file, and
// write the file only if one changed. Returns how many changed.
function editActions(file, edit) {
  let xml = lib.readText(file);
  let changed = 0;
  // Back to front, so earlier byte ranges stay valid as later ones change size.
  for (const action of codeActions(xml).reverse()) {
    const next = edit(action.gml);
    if (next === null || next === action.gml) continue;
    const body = escapeXml(next);
    const replacement = action.selfClosing ? `<argument kind="STRING">${body}</argument>` : body;
    xml = xml.slice(0, action.start) + replacement + xml.slice(action.end);
    changed++;
  }
  if (changed) lib.writeText(file, xml);
  return changed;
}

module.exports = { codeActions, eventFile, readEvent, writeEvent, editActions, escapeXml, unescapeXml };
