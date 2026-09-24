//=============================================================================
// payload.js - what the bridge payload consists of, in one place.
//
// inject.js copies these into a game tree and registers them.
//
// A CODE_PATCH does not have to apply. The runner builds whichever commit it is
// asked about - the one before a fix as well as the one after - and the game's
// code moves under the anchors between them (clientProtocolError.gml does not
// exist before #203). So every patch belongs to a named PROBE, a probe can have
// several patches for different eras of the code, inject reports which probes
// landed, and a repro that needs a probe the build does not have is
// INCONCLUSIVE rather than quietly passing for want of the evidence.
//=============================================================================

const OBJECTS = ['AgentBridge'];
const SCRIPT_GROUP = 'AgentBridge';

// The one line added to the game's startup. It has to run before anything that
// can trigger a room change: a "-server"/"-port" launch creates a Client
// instance partway through game_init(), and instances created in the same
// creation-code run after that come out with none of their Create-event
// variables set. RoomChangeObserver's instance_create is the one that runs
// before any of that.
const INIT_ANCHOR = 'instance_create(0,0,RoomChangeObserver);';
const INIT_LINE = '    instance_create(0, 0, AgentBridge);';

// The one line added to an existing game object, so held input (left, right,
// up/jump, down, taunt) can be driven without a keyboard: keyboard_key_press
// does not make keyboard_check true on this build. Anchored right after
// PlayerControl reads the keyboard into keybyte, inside `if(!menuOpen)`, so
// simulated input is blocked by an open menu exactly like real input.
const KEYSTATE_OBJECT = 'PlayerControl';
const KEYSTATE_EVENT = 'Begin Step';
const KEYSTATE_ANCHOR = 'if(keyboard_check(global.taunt)) keybyte |= $01;';
const KEYSTATE_LINE = '        if (instance_exists(AgentBridge)) keybyte |= (AgentBridge.heldMask & $E3);';

// What each probe is for. A repro names the ones its verdict depends on in
// `needs`, and the runner refuses to call a run PASS without them.
const PROBES = {
  input: 'held movement keys can be pressed through the bridge (INPUT press/release)',
  desync: 'a stream desync the client detects is written to the bridge log as DESYNC',
  spriteError: 'an unknown class or team reaching getCharacterSpriteId is logged before it aborts',
  roomSpeed: 'room_speed can be overridden without deactivating RateController',
  snap: 'the prediction-snap correction can be measured',
  audio: 'a round end does not raise the AudioControl.currentSong modal',
};

// Call sites in the game's own code that the payload rewrites.
//
// WHY REPLACE A LINE RATHER THAN INSERT ONE. Several of these are the braceless
// body of an `if`, so an inserted neighbour would not join the branch - it would
// displace the original out of it. Swapping the whole line for a call to a
// payload script leaves the control flow alone.
//
// Every replacement is a no-op unless its global is switched on, apart from
// writing to the bridge log.
const CODE_PATCHES = [
  // --- desync ------------------------------------------------------------
  // After #203 every stream desync the client detects reports through this one
  // line, with the counts, class or recent message ids already in the text.
  {
    probe: 'desync',
    file: ['Scripts', 'Client', 'clientProtocolError.gml'],
    from: 'promptRestartOrQuit(text);',
    to: 'agentDebugProtocolError(text);',
  },
  // Before #203: the count mismatch only warned and carried on, and an unknown
  // message id prompted with no detail. The declared count is read INSIDE the
  // condition, so wrapping the read is the only way to keep it; the script hands
  // the byte straight back, so the comparison is the stock comparison.
  {
    probe: 'desync',
    file: ['Scripts', 'Serialization', 'deserializeState.gml'],
    from: 'if(read_ubyte(global.tempBuffer) != ds_list_size(global.players))',
    to: 'if(agentDebugStateCount(read_ubyte(global.tempBuffer)) != ds_list_size(global.players))',
  },
  {
    probe: 'desync',
    file: ['Scripts', 'Serialization', 'deserializeState.gml'],
    from: 'show_message("Wrong number of players while deserializing state");',
    to: 'agentDebugDesync();',
  },
  {
    probe: 'desync',
    file: ['Scripts', 'Client', 'ClientBeginStep.gml'],
    from: 'promptRestartOrQuit("The Server sent unexpected data.");',
    to: 'agentDebugProtocolError("The Server sent unexpected data.");',
  },

  // --- spriteError ---------------------------------------------------------
  {
    probe: 'spriteError',
    file: ['Scripts', 'Misc', 'getCharacterSpriteId.gml'],
    from: 'show_error("Attempted to get a sprite for unknown class ID: " + string(class), true);',
    to: 'agentDebugSpriteError(0, class, team, animation);',
  },
  {
    probe: 'spriteError',
    file: ['Scripts', 'Misc', 'getCharacterSpriteId.gml'],
    from: 'show_error("Attempted to get a sprite for unknown team ID: " + string(team), true);',
    to: 'agentDebugSpriteError(1, class, team, animation);',
  },

  // --- roomSpeed -------------------------------------------------------------
  // RateController pins room_speed every frame from global.game_fps; patching
  // the assignment keeps it active, so a speed-up survives a map change.
  {
    probe: 'roomSpeed',
    file: ['Objects', 'RateController.events', 'Begin Step.xml'],
    from: 'room_speed = 60;',
    to: 'agentRoomSpeed(60);',
  },
  {
    probe: 'roomSpeed',
    file: ['Objects', 'RateController.events', 'Begin Step.xml'],
    from: 'room_speed = 30;',
    to: 'agentRoomSpeed(30);',
  },

  // --- snap ------------------------------------------------------------------
  // Brackets the authoritative position block a client hard-assigns every
  // seventh tick, so the predicted and authoritative values are both in hand.
  {
    probe: 'snap',
    file: ['Objects', 'InGameElements', 'Character.events', 'User Event 13.xml'],
    from: 'receiveCompleteMessage(global.serverSocket,9,global.deserializeBuffer);',
    to: 'agentSnapBegin(); receiveCompleteMessage(global.serverSocket,9,global.deserializeBuffer);',
  },
  {
    probe: 'snap',
    file: ['Objects', 'InGameElements', 'Character.events', 'User Event 13.xml'],
    from: 'hp = read_ubyte(global.deserializeBuffer);',
    to: 'hp = read_ubyte(global.deserializeBuffer); agentSnapEnd();',
  },

  // --- audio -----------------------------------------------------------------
  // AudioControl destroys itself in its own Create, so currentSong is never
  // initialised and every round end raises a modal from WinBanner. The launcher
  // would dismiss it, but it would also be reported as a GML error - and a repro
  // that treats any GML error as the bug would then fail at every round end.
  {
    probe: 'audio',
    file: ['Scripts', 'AudioControl', 'AudioControlPlaySong.gml'],
    from: 'if(AudioControl.currentSong != -1) sound_stop(AudioControl.currentSong);',
    to: 'agentAudioStopSong();',
  },
];

// A hook site a repro declares: `{ file: 'Scripts/GameServer/x.gml', after: '<exact line>' }`
// or `{ object: 'Character', event: 'End Step', after: '<exact line>' }`. It becomes an
// extra line `agentHook("<name>");` inserted after the anchor. `before` is also
// accepted. An anchor that is the braceless body of an `if` must not be used - the
// hook line would displace the rest of the statement out of the branch - and
// inject refuses one whose previous line is a bare `if (...)`/`else`.
const hookLine = (name) => `agentHook("${name}");`;

module.exports = {
  OBJECTS, SCRIPT_GROUP, INIT_ANCHOR, INIT_LINE,
  KEYSTATE_OBJECT, KEYSTATE_EVENT, KEYSTATE_ANCHOR, KEYSTATE_LINE,
  PROBES, CODE_PATCHES, hookLine,
};
