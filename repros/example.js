// An example repro. Copy it to repros/<issue>-<slug>.js to start your own;
// everything in repros/ except this file is gitignored.
//
// #65 - the autobalance notice on the host names the wrong player.
//
// ServerBalanceTeams picks `balanceplayer` (the lowest scorer on the bigger
// team), moves them, and then sets `Balancer.name = player.name` - where
// `player` is the loop variable left over from the search, i.e. the LAST
// player in the list. Clients use the id in the BALANCE message and get it
// right; only the host's notice is wrong.
//
// Two clients on red with nobody on blue is an imbalance of two. Both have the
// same score (0) and neither has a character, so the search keeps the first
// one it meets - client1 - and ends with `player` on client2. So the broken
// build names client2 while moving client1.
//
// The teams are set directly on the server rather than by the clients choosing
// them, because the game will not let a client join the bigger team; the
// balance itself runs through the game's own ServerBalanceTeams, both stages.
module.exports = {
  issue: 65,
  title: 'Autobalance notice on the host names the wrong player',
  session: { clients: 2, map: 'ctf_truefort' },

  async setup({ server, assume }) {
    await server.eval(`
      var i, p;
      p = ds_list_find_value(global.players, 0);
      p.team = TEAM_SPECTATOR;
      for (i = 1; i < ds_list_size(global.players); i += 1)
      {
          p = ds_list_find_value(global.players, i);
          p.team = TEAM_RED;
      }
      global.autobalance = 1;
    `);
    // The case only exists when the moved player is not the last in the list.
    assume((await server.evalx('ds_list_find_value(global.players, 1).name')) === 'client1', 'client1 is player 1');
    assume((await server.evalx('ds_list_find_value(global.players, 2).name')) === 'client2', 'client2 is player 2');
    assume((await server.num('ds_list_find_value(global.players, 1).object')) === -1, 'client1 has no character');
  },

  async check({ server, expect, assume }) {
    // Stage 1 announces the balance; stage 2 does it once the counter has run
    // past the respawn time. Both are the game's own code.
    await server.eval(`
      with (GameServer)
      {
          serverbalance = 0;
          ServerBalanceTeams();
          balancecounter = 100000;
          ServerBalanceTeams();
      }
    `);
    await server.eval(`
      var i, p;
      global.reproMoved = "";
      for (i = 1; i < ds_list_size(global.players); i += 1)
      {
          p = ds_list_find_value(global.players, i);
          if (p.team == TEAM_BLUE)
              global.reproMoved = p.name;
      }
    `);
    const moved = await server.evalx('global.reproMoved');
    assume(moved !== '', 'the balance moved someone to blue');

    expect.equal(await server.evalx('Balancer.name'), moved, "the host's notice names the player who was moved");
  },
};
