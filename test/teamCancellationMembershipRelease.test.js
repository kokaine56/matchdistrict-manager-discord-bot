import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  saveConfigurableTeamWithExclusivity,
  releaseTeamPlayerMemberships,
  deleteConfigurableTeam,
  checkTournamentPlayerExclusivity,
  getConfigurableTeamsForUser,
  getConfigurableTeamsForTournament,
  getConfigurableTeamByName,
  getTournamentPlayerMemberships,
  localTeams,
  localPlayerMemberships,
} from '../configurableTournamentData.js';
import { isTeamVerifiedForTournament } from '../configurableRegistrationService.js';
import { handleCancelTeamConfirm } from '../tournamentService.js';
import { guildSettingsCache } from '../index.js';

describe('Discord Bot - Team Cancellation & Deletion Membership Release Tests', () => {
  const tournamentId = 'tourney-test-rel-99';
  const guildId = 'guild-test-rel-99';

  beforeEach(() => {
    localTeams.clear();
    localPlayerMemberships.clear();

    guildSettingsCache[guildId] = {
      tournaments: {
        [tournamentId]: {
          tournamentId,
          guildId,
          tournamentTitle: 'MD Elite Championship',
          roleId: 'role-tourney-participant',
          verifiedRegistrations: {},
          rounds: {},
        },
      },
    };
  });

  test('1. Enrolling a squad registers active player memberships and blocks duplicate enrollment', async () => {
    const teamDoc = {
      teamId: 'team-alpha-1',
      tournamentId,
      guildId,
      teamName: 'Alpha Squad',
      leaderDiscordId: 'leader-1',
      players: [
        { discordId: 'leader-1', ign: 'AlphaLead', uid: '1111' },
        { discordId: 'player-2', ign: 'PlayerTwo', uid: '2222' },
        { discordId: 'player-3', ign: 'PlayerThree', uid: '3333' },
        { discordId: 'player-4', ign: 'PlayerFour', uid: '4444' },
      ],
      substitutes: [
        { discordId: 'sub-1', ign: 'SubOne', uid: '5555' },
      ],
    };

    const result = await saveConfigurableTeamWithExclusivity(teamDoc, { isEdit: false });
    assert.strictEqual(result.ok, true, 'Team should enroll successfully');

    // Verify exclusivity check blocks player-2 from being used in another squad
    const duplicateCheck = await checkTournamentPlayerExclusivity(tournamentId, ['player-2', 'new-guy']);
    assert.strictEqual(duplicateCheck.ok, false);
    assert.strictEqual(duplicateCheck.code, 'PLAYER_ALREADY_ASSIGNED');
    assert.strictEqual(duplicateCheck.conflicts[0].discordUserId, 'player-2');

    // Verify getConfigurableTeamsForUser returns the enrolled team
    const leaderTeams = await getConfigurableTeamsForUser(tournamentId, 'leader-1');
    assert.strictEqual(leaderTeams.length, 1);
    assert.strictEqual(leaderTeams[0].teamName, 'Alpha Squad');

    const memberTeams = await getConfigurableTeamsForUser(tournamentId, 'player-2');
    assert.strictEqual(memberTeams.length, 1);
  });

  test('2. Deleting a squad releases memberships and allows all members to join new squads in the same tournament', async () => {
    const teamDoc = {
      teamId: 'team-beta-2',
      tournamentId,
      guildId,
      teamName: 'Beta Force',
      leaderDiscordId: 'leader-beta',
      players: [
        { discordId: 'leader-beta', ign: 'BetaLead', uid: '1001' },
        { discordId: 'member-b2', ign: 'BetaTwo', uid: '1002' },
        { discordId: 'member-b3', ign: 'BetaThree', uid: '1003' },
        { discordId: 'member-b4', ign: 'BetaFour', uid: '1004' },
      ],
      substitutes: [],
    };

    await saveConfigurableTeamWithExclusivity(teamDoc, { isEdit: false });

    // Confirm members are initially blocked
    const preCheck = await checkTournamentPlayerExclusivity(tournamentId, ['member-b2', 'member-b3']);
    assert.strictEqual(preCheck.ok, false);

    // Delete squad via deleteConfigurableTeam
    await deleteConfigurableTeam(teamDoc.teamId);

    // Verify team is no longer returned in active teams
    const userTeams = await getConfigurableTeamsForUser(tournamentId, 'leader-beta');
    assert.strictEqual(userTeams.length, 0, 'Deleted team should not be returned for leader');

    const memberTeams = await getConfigurableTeamsForUser(tournamentId, 'member-b2');
    assert.strictEqual(memberTeams.length, 0, 'Deleted team should not be returned for member');

    const tournamentTeams = await getConfigurableTeamsForTournament(tournamentId);
    assert.strictEqual(tournamentTeams.length, 0, 'Deleted team should not be in tournament teams');

    const byName = await getConfigurableTeamByName(tournamentId, 'Beta Force');
    assert.strictEqual(byName, null, 'Deleted team name should be freed');

    // Verify player exclusivity is released
    const postCheck = await checkTournamentPlayerExclusivity(tournamentId, [
      'leader-beta',
      'member-b2',
      'member-b3',
      'member-b4',
    ]);
    assert.strictEqual(postCheck.ok, true, 'All previous members must be eligible');
    assert.deepStrictEqual(postCheck.conflicts, []);

    // Former members can enroll in a brand new team in the same tournament
    const newTeamDoc = {
      teamId: 'team-gamma-3',
      tournamentId,
      guildId,
      teamName: 'Gamma Squad',
      leaderDiscordId: 'member-b2', // Former player is now leader
      players: [
        { discordId: 'member-b2', ign: 'BetaTwoNew', uid: '1002' },
        { discordId: 'member-b3', ign: 'BetaThreeNew', uid: '1003' },
        { discordId: 'fresh-guy-1', ign: 'Fresh1', uid: '9001' },
        { discordId: 'fresh-guy-2', ign: 'Fresh2', uid: '9002' },
      ],
      substitutes: [],
    };

    const newResult = await saveConfigurableTeamWithExclusivity(newTeamDoc, { isEdit: false });
    assert.strictEqual(newResult.ok, true, 'Former members must successfully enroll new team in same tournament');
  });

  test('3. Admin cancellation releases memberships so all players are immediately eligible', async () => {
    const teamDoc = {
      teamId: 'team-delta-4',
      tournamentId,
      guildId,
      teamName: 'Delta Warriors',
      leaderDiscordId: 'leader-delta',
      players: [
        { discordId: 'leader-delta', ign: 'DeltaLead', uid: '2001' },
        { discordId: 'delta-p2', ign: 'DeltaP2', uid: '2002' },
        { discordId: 'delta-p3', ign: 'DeltaP3', uid: '2003' },
        { discordId: 'delta-p4', ign: 'DeltaP4', uid: '2004' },
      ],
      substitutes: [
        { discordId: 'delta-sub', ign: 'DeltaSub', uid: '2005' },
      ],
    };

    await saveConfigurableTeamWithExclusivity(teamDoc, { isEdit: false });

    // Mock handleCancelTeamConfirm context
    const fakeInteraction = {
      guild: {
        id: guildId,
        ownerId: 'admin-1',
        members: {
          fetch: async (id) => ({
            id,
            roles: { remove: async () => {} },
          }),
        },
        channels: {
          cache: new Map(),
          fetch: async () => null,
        },
      },
      member: { id: 'admin-1' },
      user: { id: 'admin-1', tag: 'Admin#0001', username: 'admin' },
      client: { users: { fetch: async () => null } },
      channel: { send: async () => ({}) },
      editReply: async () => ({}),
      update: async () => ({}),
      deferred: true,
      replied: false,
    };

    // Populate verifiedRegistrations and pendingTeamCancellations in savedTournament
    const savedTournament = guildSettingsCache[guildId].tournaments[tournamentId];
    savedTournament.verifiedRegistrations['team-delta-4'] = {
      registrationId: 'team-delta-4',
      teamId: 'team-delta-4',
      teamName: 'Delta Warriors',
      discordId: 'leader-delta',
      discordMemberIds: ['leader-delta', 'delta-p2', 'delta-p3', 'delta-p4', 'delta-sub'],
      status: 'CONFIRMED',
    };
    savedTournament.pendingTeamCancellations = {
      'team-delta-4': {
        teamId: 'team-delta-4',
        teamName: 'Delta Warriors',
        leaderId: 'leader-delta',
        memberIds: ['leader-delta', 'delta-p2', 'delta-p3', 'delta-p4', 'delta-sub'],
        reason: 'Rule violation: Unsportsmanlike conduct.',
      },
    };

    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    });

    try {
      // Execute cancellation
      const cancelResult = await handleCancelTeamConfirm(fakeInteraction, tournamentId, 'team-delta-4');
      assert.strictEqual(cancelResult, true);
    } finally {
      global.fetch = originalFetch;
    }

    // Verify status is CANCELLED
    assert.strictEqual(savedTournament.verifiedRegistrations['team-delta-4'].status, 'CANCELLED');

    // Verify getConfigurableTeamsForUser does NOT return cancelled team
    const leaderTeams = await getConfigurableTeamsForUser(tournamentId, 'leader-delta');
    assert.strictEqual(leaderTeams.length, 0, 'Cancelled team must not be returned');

    const memberTeams = await getConfigurableTeamsForUser(tournamentId, 'delta-p2');
    assert.strictEqual(memberTeams.length, 0, 'Cancelled team must not be returned for players');

    // Verify isTeamVerifiedForTournament rejects cancelled team
    const teamInCache = localTeams.get('team-delta-4');
    assert.strictEqual(isTeamVerifiedForTournament(teamInCache, tournamentId), false);

    // Verify checkTournamentPlayerExclusivity clears all members
    const exclCheck = await checkTournamentPlayerExclusivity(tournamentId, [
      'leader-delta',
      'delta-p2',
      'delta-p3',
      'delta-p4',
      'delta-sub',
    ]);
    assert.strictEqual(exclCheck.ok, true, 'All former members must be eligible after cancellation');
    assert.strictEqual(exclCheck.conflicts.length, 0);

    // Verify team name can be reused if re-enrolling
    const teamByName = await getConfigurableTeamByName(tournamentId, 'Delta Warriors');
    assert.strictEqual(teamByName, null, 'Cancelled team name must be freed');

    // Former player delta-p2 can now enroll a new team in the same tournament
    const newTeam = {
      teamId: 'team-phoenix-5',
      tournamentId,
      guildId,
      teamName: 'Phoenix Reborn',
      leaderDiscordId: 'delta-p2',
      players: [
        { discordId: 'delta-p2', ign: 'DeltaP2', uid: '2002' },
        { discordId: 'delta-sub', ign: 'DeltaSub', uid: '2005' },
        { discordId: 'new-p3', ign: 'NewP3', uid: '7003' },
        { discordId: 'new-p4', ign: 'NewP4', uid: '7004' },
      ],
      substitutes: [],
    };

    const newTeamRes = await saveConfigurableTeamWithExclusivity(newTeam, { isEdit: false });
    assert.strictEqual(newTeamRes.ok, true, 'Cancelled team members must be able to enroll new squad');
  });

  test('4. Self-healing resilience: orphaned memberships for cancelled/deleted teams are ignored and cleaned up', async () => {
    // Simulate an orphaned active membership for a team marked CANCELLED
    localTeams.set('team-orphaned', {
      teamId: 'team-orphaned',
      tournamentId,
      teamName: 'Orphaned Squad',
      status: 'CANCELLED',
      leaderDiscordId: 'orphaned-leader',
      players: [{ discordId: 'player-orphaned', ign: 'OrphanPlayer', uid: '9999' }],
      substitutes: [],
    });

    localPlayerMemberships.set(`${tournamentId}:player-orphaned`, {
      tournamentId,
      discordUserId: 'player-orphaned',
      teamId: 'team-orphaned',
      role: 'PLAYER',
      status: 'ACTIVE',
      assignedAt: new Date(),
    });

    // Check exclusivity: should detect team is CANCELLED, self-heal, and return ok: true
    const check = await checkTournamentPlayerExclusivity(tournamentId, ['player-orphaned']);
    assert.strictEqual(check.ok, true, 'Player from cancelled team must not be blocked');
    assert.strictEqual(check.conflicts.length, 0);

    // Player should be able to enroll with another squad
    const newSquad = {
      teamId: 'team-fresh-6',
      tournamentId,
      guildId,
      teamName: 'Fresh Squad',
      leaderDiscordId: 'player-orphaned',
      players: [
        { discordId: 'player-orphaned', ign: 'OrphanPlayer', uid: '9999' },
        { discordId: 'fresh-1', ign: 'F1', uid: '8001' },
        { discordId: 'fresh-2', ign: 'F2', uid: '8002' },
        { discordId: 'fresh-3', ign: 'F3', uid: '8003' },
      ],
      substitutes: [],
    };

    const enrollRes = await saveConfigurableTeamWithExclusivity(newSquad, { isEdit: false });
    assert.strictEqual(enrollRes.ok, true, 'Player from orphaned cancelled team must enroll cleanly');
  });
});
