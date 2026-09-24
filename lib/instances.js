//=============================================================================
// instances.js - the register of running game instances.
//
// Half of Gang Garrison 2 is the network protocol, and nothing about a server
// and its clients is observable from inside one process - so a session holds
// several games at once, and needs to know which process is which.
//
// The launcher owns each game as a child process, so it is what writes here: an
// entry when the game starts, and no entry once it has gone. Everything else
// reads. The file lives beside the executable, with the logs.
//
// Nothing here locks. Two launchers starting at the same instant can lose an
// entry, which costs a name in a listing and nothing else, and a stale entry is
// pruned on the next read by asking the operating system whether the pid is
// still there.
//=============================================================================

const fs = require('fs');
const path = require('path');

const FILE = 'agent_instances.json';

const file = (dir) => path.join(dir, FILE);

function alive(pid) {
  if (!pid) return false;
  try {
    // Signal 0 asks whether the process exists without touching it.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // running, but not ours to signal
  }
}

function readRaw(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(dir), 'utf8'));
    return Array.isArray(parsed.instances) ? parsed.instances : [];
  } catch (e) {
    return [];
  }
}

function writeRaw(dir, instances) {
  const tmp = file(dir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ instances }, null, 2));
  fs.renameSync(tmp, file(dir));
}

// Every instance that is still running, oldest first.
function list(dir) {
  const live = readRaw(dir).filter((i) => alive(i.pid));
  return live.sort((a, b) => (a.started || '').localeCompare(b.started || ''));
}

// Prune the dead and write the survivors back, so a listing does not grow
// forever across sessions.
function prune(dir) {
  const live = list(dir);
  if (live.length !== readRaw(dir).length) writeRaw(dir, live);
  return live;
}

function register(dir, entry) {
  const now = list(dir).filter((i) => i.port !== entry.port);
  now.push(Object.assign({ started: new Date().toISOString() }, entry));
  writeRaw(dir, now);
  return entry;
}

function unregister(dir, port) {
  writeRaw(dir, list(dir).filter((i) => i.port !== port));
}

// The log files an instance writes, both named after its port so two games in
// one directory cannot interleave their output.
const bridgeLog = (dir, port) => path.join(dir, `agent_bridge_${port}.log`);
const launcherLog = (dir, port) => path.join(dir, `agent_launcher_${port}.log`);

// GM8's own error log. Not ours and not per port - the engine picks the name
// and writes it beside the executable, so two games in one directory share it.
// It matters because it is the only record of a compilation error inside
// execute_string: those raise no dialog at all, and the bridge replies "OK 0"
// as though nothing had happened.
const errorLog = (dir) => path.join(dir, 'game_errors.log');

module.exports = { list, prune, register, unregister, alive, bridgeLog, launcherLog, errorLog, FILE };
