//=============================================================================
// session.js - a dedicated server and its clients, started from one build.
//
//   - Only games running from THIS build directory are ever stopped, never
//     another copy of the game on the machine.
//   - The hosting port is set here, not read from gg2.ini, so a repro run can
//     sit alongside a playtest on the default 8190.
//   - Each client gets its own name (client1, client2, ...). The game reads
//     PlayerName from gg2.ini at startup and writes it back, and every game in
//     one directory shares that file, so clients are started one at a time
//     with the name set just before each.
//   - Clients can join later (join()), for bugs that need someone arriving in
//     the middle of something.
//
// Three gg2.ini settings decide whether a local session works at all:
//   UseLobby=0          or a dedicated server announces itself publicly
//   MultiClientLimit    every local client connects from 127.0.0.1
//   Dedicated=0         after the server has started, or each client would
//                       host on startup too (the server writes Dedicated=1
//                       back into the shared file)
//=============================================================================

const fs = require('fs');
const path = require('path');
const lib = require('./lib.js');
const instances = require('./instances.js');
const { buildDirOf, GAME_IMAGE } = require('./build.js');
const { Bridge } = require('./bridge.js');

const LAUNCHER = path.join(__dirname, 'launcher.js');

//---------------------------------------------------------------------------
// gg2.ini, read and written byte for byte
//---------------------------------------------------------------------------

const iniFile = (buildDir) => path.join(buildDir, 'gg2.ini');

function withIniValue(text, section, key, value) {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text ? text.split(/\r?\n/) : [];
  let inSection = false;
  let sectionEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    const head = /^\s*\[(.+?)\]\s*$/.exec(lines[i]);
    if (head) {
      if (inSection) break;
      inSection = head[1].toLowerCase() === section.toLowerCase();
      if (inSection) sectionEnd = i;
      continue;
    }
    if (!inSection) continue;
    if (lines[i].trim()) sectionEnd = i;
    const kv = /^\s*([^=;]+?)\s*=\s*(.*?)\s*$/.exec(lines[i]);
    if (kv && kv[1].toLowerCase() === key.toLowerCase()) {
      if (kv[2] === String(value)) return null;
      lines[i] = `${kv[1]}=${value}`;
      return lines.join(nl);
    }
  }
  if (sectionEnd < 0) lines.push(`[${section}]`, `${key}=${value}`);
  else lines.splice(sectionEnd + 1, 0, `${key}=${value}`);
  return lines.join(nl);
}

// A game that has only just exited - or a virus scanner looking at a file the
// game just wrote - can hold gg2.ini or a log for a moment. Measured: EBUSY on
// the first run after a fresh build, twice in three.
function retrying(fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (!/^(EBUSY|EPERM|EACCES)$/.test(e.code) || attempt >= 20) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

function setIni(buildDir, section, key, value) {
  const file = iniFile(buildDir);
  retrying(() => {
    const text = fs.existsSync(file) ? lib.readText(file) : '';
    const next = withIniValue(text, section, key, value);
    if (next !== null) lib.writeText(file, next);
  });
}

//---------------------------------------------------------------------------
// One game
//---------------------------------------------------------------------------

// Start one game through the launcher (which clears GM8's modal dialogs and
// logs what they said) and wait until its bridge answers.
async function launch({ buildDir, port, name, role, gameArgs, timeoutSeconds = 60, quiet }) {
  lib.step(`Starting ${name} (bridge ${port})`, quiet);
  const launcherLog = instances.launcherLog(buildDir, port);
  lib.launchDetached(
    process.execPath,
    [LAUNCHER, path.join(buildDir, GAME_IMAGE), '--name', name, '--role', role, '-agentport', String(port), ...gameArgs],
    buildDir
  );

  const tails = () =>
    [launcherLog, instances.bridgeLog(buildDir, port)]
      .filter((p) => fs.existsSync(p))
      .map((p) => `--- ${path.basename(p)} ---\n` + lib.readText(p).split(/\r?\n/).filter(Boolean).slice(-15).join('\n'))
      .join('\n');
  // A game that dies while starting - a client handed a corrupt stream on
  // joining, say - would otherwise cost the whole timeout.
  const exited = () => fs.existsSync(launcherLog) && /game exited|^\S+ FAIL:/m.test(lib.readText(launcherLog));

  const deadline = Date.now() + timeoutSeconds * 1000;
  let open = false;
  while (!open && Date.now() < deadline) {
    if (exited()) throw new Error(`${name} exited while starting
${tails()}`);
    open = await lib.waitForPort(port, '127.0.0.1', 1000);
  }
  if (!open) {
    throw new Error(
      `${name} never opened its bridge within ${timeoutSeconds}s. GM8 needs an audio device and a connected ` +
        `desktop session; over RDP without audio redirection it hangs on a modal before any game code runs.
` +
        tails()
    );
  }

  // Listening is not the same as started. AgentBridge opens its port early in
  // game_init, and game_init goes on to write gg2.ini back - so a client whose
  // port is open can still overwrite the PlayerName set for the next one
  // (measured: 1 run in 4). The bridge only answers from its Step event, which
  // runs after game_init has finished, so an answer means init is done.
  const bridge = new Bridge(port);
  try {
    await bridge.call('PING', Math.max(1000, deadline - Date.now()));
  } catch (e) {
    throw new Error(`${name} opened its bridge but never answered: ${e.message}
${tails()}`);
  } finally {
    bridge.close();
  }
}

//---------------------------------------------------------------------------
// A session
//---------------------------------------------------------------------------

class Session {
  constructor({ repo, map, basePort, hostingPort, quiet }) {
    this.repo = repo;
    this.buildDir = buildDirOf(repo);
    this.map = map;
    this.basePort = basePort;
    this.hostingPort = hostingPort;
    this.quiet = quiet;
    this.members = []; // { name, role, port }
    this.nextClient = 1;
  }

  async start({ clients }) {
    if (!fs.existsSync(path.join(this.buildDir, GAME_IMAGE))) throw new Error(`no game built in ${this.buildDir}`);
    await lib.stopGamesIn(this.buildDir, GAME_IMAGE);
    instances.prune(this.buildDir);

    // Logs are per port and appended to; a run reads only what it produced,
    // but starting from nothing keeps the evidence it saves readable.
    for (const f of fs.readdirSync(this.buildDir)) {
      if (/^agent_(bridge|launcher)_\d+/.test(f)) retrying(() => fs.rmSync(path.join(this.buildDir, f), { force: true }));
    }

    setIni(this.buildDir, 'Settings', 'UseLobby', 0);
    setIni(this.buildDir, 'Settings', 'HostingPort', this.hostingPort);
    setIni(this.buildDir, 'Settings', 'MultiClientLimit', Math.max(3, clients + 2));
    setIni(this.buildDir, 'Server', 'Dedicated', 1);
    setIni(this.buildDir, 'Settings', 'PlayerName', 'server');

    await launch({
      buildDir: this.buildDir,
      port: this.basePort,
      name: 'server',
      role: 'server',
      gameArgs: ['-agentfailfast', '-dedicated', '-map', this.map],
      quiet: this.quiet,
    });
    this.members.push({ name: 'server', role: 'server', port: this.basePort });

    // After the server, not before: it writes Dedicated=1 back on startup.
    setIni(this.buildDir, 'Server', 'Dedicated', 0);
    for (let i = 0; i < clients; i++) await this.join();
    return this.members;
  }

  // Start one more client against the server. Resolves once its bridge is up,
  // which is before it has finished joining - wait on the server for that.
  async join() {
    const name = `client${this.nextClient++}`;
    const port = this.basePort + this.members.length;
    // Registered before it starts, so a client that dies on the way up still
    // has a name in the evidence.
    const member = { name, role: 'client', port };
    this.members.push(member);
    setIni(this.buildDir, 'Settings', 'PlayerName', name);
    await launch({
      buildDir: this.buildDir,
      port,
      name,
      role: 'client',
      gameArgs: ['-agentfailfast', '-server', '127.0.0.1', '-port', String(this.hostingPort)],
      quiet: this.quiet,
    });
    return member;
  }

  // Stop one member by name, or all of them.
  async stop(name) {
    const live = instances.list(this.buildDir);
    const targets = name ? live.filter((i) => i.name === name) : live;
    for (const t of targets) lib.capture('taskkill', ['/F', '/PID', String(t.pid)]);
    if (!name) await lib.stopGamesIn(this.buildDir, GAME_IMAGE);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!instances.list(this.buildDir).some((i) => targets.some((t) => t.port === i.port))) break;
      await lib.sleep(250);
    }
    instances.prune(this.buildDir);
    return targets.map((t) => t.name);
  }

  // Whether a member's process is still running.
  alive(name) {
    return instances.list(this.buildDir).some((i) => i.name === name);
  }
}

module.exports = { Session, withIniValue };
