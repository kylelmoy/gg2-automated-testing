// void agentHook(string name)
// A named point in the game's own code where a repro can run GML in the same
// frame, at the same place, as the code around it.
//
// The runner injects a call to this at every hook site a repro declares, and a
// repro arms a site by putting GML under its name in global.agentHooks (the
// runner does that with an EVAL). Nothing armed means nothing runs, so an
// injected hook is observationally a no-op.
//
// This exists because some bugs live in a window one tick wide - a sentry build
// command processed in the tick right after a join is served, say - and a
// call from outside the game lands whenever the socket gets round to it, ~40ms
// and one or two frames later at best. Code that runs here cannot miss.
//
// The armed code runs in whatever instance the surrounding game code is
// running in, and cannot see that code's `var` locals.
//
// A hook whose code raises an error is disarmed, and logged as HOOKERROR: a
// hook site runs every frame or every message, and an error there would
// otherwise be raised just as often - burying the game in dialogs, and making
// the repro's own mistake look like the bug. Same sentinel as agentBridgeDefer:
// when the launcher presses Ignore, GM8 abandons the execute_string that
// raised, so the assignment after the armed code never runs.
//
// The armed code disarms itself if it should only run once:
// ds_map_delete(global.agentHooks, "<name>").

if (!ds_map_exists(global.agentHooks, argument0))
    exit;

var q;
q = chr(34);
global.agentHookOutcome = "raised";
execute_string(ds_map_find_value(global.agentHooks, argument0) + chr(10) + ";global.agentHookOutcome = " + q + "ok" + q + ";");

if (global.agentHookOutcome == "raised")
{
    agentBridgeLog("HOOKERROR " + argument0 + " raised an error and was disarmed");
    ds_map_delete(global.agentHooks, argument0);
}
else if (!ds_map_exists(global.agentHookSeen, argument0))
{
    // Once per hook, not once per call: some sites run every frame.
    ds_map_add(global.agentHookSeen, argument0, 1);
    agentBridgeLog("HOOK " + argument0);
}
