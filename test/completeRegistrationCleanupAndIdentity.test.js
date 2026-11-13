import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  guildSettingsCache,
} from '../index.js';
import {
  getConfirmedTeamsFromDb,
  formatTeamsChannelRoster,
  updateTeamsRosterMessages,
  handleTournamentVerificationMessage,
  handleTournamentVerificationInteraction,
} from '../tournamentService.js';
import {
  localPlayerMemberships,
  localTeams,
  localEntries,
  localSlots,
  checkTournamentPlayerExclusivity,
  syncTeamPlayerMemberships,
  releaseTeamPlayerMemberships,
  deleteTournamentRegistrationComplete,
  deleteConfigurableTeam,
  getTournamentPlayerMemberships,
  clearInMemoryData,
  setExternalGuildSettingsGetter,
} from '../configurableTournamentData.js';
import {
  localPendingVerifications,
  localPermanentIdentitiesByDiscordId,
  localPermanentIdentitiesByMDId,
  createPendingTournamentVerification,
  savePermanentDiscordIdentity,
  getPermanentDiscordIdentityByDiscordId,
  getPermanentDiscordIdentityByMatchDistrictId,
  unlinkPermanentDiscordIdentity,
} from '../mongoService.js';

const TEST_GUILD_ID = 'guild-cleanup-identity-test';
const TOUR_A = 'tour-cleanup-A';
const TOUR_B = 'tour-cleanup-B';

describe('Complete Tournament Registration Cleanup & Permanent Discord Identity Linking', () => {
  beforeEach(() => {
    setExternalGuildSettingsGetter(() => guildSettingsCache);
    clearInMemoryData();
    localPendingVerifications.clear();
    localPermanentIdentitiesByDiscordId.clear();
    localPermanentIdentitiesByMDId.clear();

    guildSettingsCache[TEST_GUILD_ID] = {
      tournaments: {
        [TOUR_A]: {
          tournamentId: TOUR_A,
          tournamentTitle: 'Tournament Alpha',
          roleId: 'role-tour-a',
          verifiedRegistrations: {},
          rounds: {
            'round-1': {
              roundId: 'round-1',
              name: 'Round 1',
              groups: [
                {
                  groupId: 'group-1',
                  slots: [
                    { slotNumber: 1, status: 'AVAILABLE' },
                    { slotNumber: 2, status: 'AVAILABLE' },
                  ],
                },
              ],
            },
          },
        },
        [TOUR_B]: {
          tournamentId: TOUR_B,
          tournamentTitle: 'Tournament Beta',
          roleId: 'role-tour-b',
          verifiedRegistrations: {},
        },
      },
    };
  });

  test('Scenario 1: Admin deletes Team A → all 4 members can join another squad in same tournament', async () => {
    const leaderId = '111111111111111111';
    const mem1Id = '222222222222222222';
    const mem2Id = '333333333333333333';
    const mem3Id = '444444444444444444';
    const squadIds = [leaderId, mem1Id, mem2Id, mem3Id];

    // 1. Setup Team A with 4 members in Tournament A
    const teamDoc = {
      teamId: 'team-a',
      tournamentId: TOUR_A,
      teamName: 'Team Alpha',
      leaderDiscordId: leaderId,
      players: [
        { discordId: mem1Id },
        { discordId: mem2Id },
        { discordId: mem3Id },
      ],
      status: 'CONFIRMED',
    };
    localTeams.set('team-a', teamDoc);
    await syncTeamPlayerMemberships(teamDoc);

    const tourA = guildSettingsCache[TEST_GUILD_ID].tournaments[TOUR_A];
    tourA.verifiedRegistrations['team-a'] = {
      registrationId: 'team-a',
      teamId: 'team-a',
      teamName: 'Team Alpha',
      status: 'CONFIRMED',
      discordId: leaderId,
      discordMemberIds: squadIds,
    };

    // Pre-condition: Members are currently blocked from joining another squad
    const preCheck = await checkTournamentPlayerExclusivity(TOUR_A, squadIds);
    assert.equal(preCheck.ok, false);
    assert.equal(preCheck.conflicts.length, 4);

    // 2. Admin deletes Team A
    const cleanupResult = await deleteTournamentRegistrationComplete({
      tournamentId: TOUR_A,
      teamId: 'team-a',
      reason: 'Admin deleted team registration',
      actorId: 'admin-user',
      actorTag: 'Admin#0001',
      guildId: TEST_GUILD_ID,
      savedTournament: tourA,
      purgeRegistration: true,
    });

    assert.equal(cleanupResult.success, true);
    assert.equal(cleanupResult.freedDiscordIds.length, 4);

    // 3. Verify all 4 members are now eligible to join or register another squad in the same tournament
    const postCheck = await checkTournamentPlayerExclusivity(TOUR_A, squadIds);
    assert.equal(postCheck.ok, true, 'All 4 members must be eligible after team deletion');
    assert.equal(postCheck.conflicts.length, 0);

    // Verify another squad can register with all 4 members
    const newSquadDoc = {
      tournamentId: TOUR_A,
      teamId: 'team-new-squad',
      teamName: 'New Squad',
      leaderDiscordId: leaderId,
      players: [
        { discordId: mem1Id },
        { discordId: mem2Id },
        { discordId: mem3Id },
      ],
      status: 'CONFIRMED',
    };
    localTeams.set('team-new-squad', newSquadDoc);
    const newSquadMemberships = await syncTeamPlayerMemberships(newSquadDoc);
    assert.equal(newSquadMemberships.length, 4);
  });

  test('Scenario 2: Admin deletes Team A → leader can create another team', async () => {
    const leaderId = '111111111111111111';
    const memIds = ['222222222222222222', '333333333333333333'];

    // Register initial team
    localTeams.set('team-alpha-old', {
      teamId: 'team-alpha-old',
      registrationId: 'reg-alpha-old',
      tournamentId: TOUR_A,
      teamName: 'Team Alpha Old',
      leaderDiscordId: leaderId,
      players: memIds.map(id => ({ discordId: id })),
      status: 'CONFIRMED',
    });
    await syncTeamPlayerMemberships({
      tournamentId: TOUR_A,
      teamId: 'team-alpha-old',
      teamName: 'Team Alpha Old',
      leaderDiscordId: leaderId,
      players: memIds.map(id => ({ discordId: id })),
      status: 'CONFIRMED',
    });

    // Admin deletes team
    await deleteTournamentRegistrationComplete({
      tournamentId: TOUR_A,
      teamId: 'team-alpha-old',
      registrationId: 'reg-alpha-old',
      savedTournament: guildSettingsCache[TEST_GUILD_ID].tournaments[TOUR_A],
    });

    // Leader creates a brand new team
    const leaderCheck = await checkTournamentPlayerExclusivity(TOUR_A, [leaderId]);
    assert.equal(leaderCheck.ok, true, 'Leader must be allowed to create another team');

    const newTeamDoc = {
      teamId: 'team-alpha-new',
      registrationId: 'reg-alpha-new',
      tournamentId: TOUR_A,
      teamName: 'Team Alpha Reborn',
      leaderDiscordId: leaderId,
      players: [{ discordId: '999999999999999999' }],
      status: 'CONFIRMED',
    };
    localTeams.set('team-alpha-new', newTeamDoc);
    const enrolled = await syncTeamPlayerMemberships(newTeamDoc);
    assert.equal(enrolled.length, 2);
    assert.equal(localPlayerMemberships.get(`${TOUR_A}:${leaderId}`).teamId, 'team-alpha-new');
  });

  test('Scenario 3: Admin deletes Team A → members can join different squads', async () => {
    const leaderId = '111111111111111111';
    const mem1Id = '222222222222222222';
    const mem2Id = '333333333333333333';

    // Seed Team A
    const teamADoc = {
      tournamentId: TOUR_A,
      teamId: 'team-a',
      teamName: 'Team A',
      leaderDiscordId: leaderId,
      players: [{ discordId: mem1Id }, { discordId: mem2Id }],
      status: 'CONFIRMED',
    };
    localTeams.set('team-a', teamADoc);
    await syncTeamPlayerMemberships(teamADoc);

    // Admin deletes Team A
    await deleteTournamentRegistrationComplete({
      tournamentId: TOUR_A,
      teamId: 'team-a',
      savedTournament: guildSettingsCache[TEST_GUILD_ID].tournaments[TOUR_A],
    });

    // Member 1 joins Squad X
    const squadXExcl = await checkTournamentPlayerExclusivity(TOUR_A, [mem1Id]);
    assert.equal(squadXExcl.ok, true);
    const squadXDoc = {
      tournamentId: TOUR_A,
      teamId: 'squad-x',
      teamName: 'Squad X',
      leaderDiscordId: '888888888888888888',
      players: [{ discordId: mem1Id }],
      status: 'CONFIRMED',
    };
    localTeams.set('squad-x', squadXDoc);
    await syncTeamPlayerMemberships(squadXDoc);

    // Member 2 joins Squad Y
    const squadYExcl = await checkTournamentPlayerExclusivity(TOUR_A, [mem2Id]);
    assert.equal(squadYExcl.ok, true);
    const squadYDoc = {
      tournamentId: TOUR_A,
      teamId: 'squad-y',
      teamName: 'Squad Y',
      leaderDiscordId: '777777777777777777',
      players: [{ discordId: mem2Id }],
      status: 'CONFIRMED',
    };
    localTeams.set('squad-y', squadYDoc);
    await syncTeamPlayerMemberships(squadYDoc);

    // Assert both separate squads exist and members are independently assigned
    assert.equal(localPlayerMemberships.get(`${TOUR_A}:${mem1Id}`).teamId, 'squad-x');
    assert.equal(localPlayerMemberships.get(`${TOUR_A}:${mem2Id}`).teamId, 'squad-y');
  });

  test('Scenario 4: Delete registration in Tournament A → Tournament B remains unchanged', async () => {
    const userId = '111111111111111111';

    // User participates in Tournament A and Tournament B
    const teamADoc = {
      tournamentId: TOUR_A,
      teamId: 'team-tour-a',
      teamName: 'Alpha Tour Team',
      leaderDiscordId: userId,
      players: [],
      status: 'CONFIRMED',
    };
    localTeams.set('team-tour-a', teamADoc);
    await syncTeamPlayerMemberships(teamADoc);

    const teamBDoc = {
      tournamentId: TOUR_B,
      teamId: 'team-tour-b',
      teamName: 'Beta Tour Team',
      leaderDiscordId: userId,
      players: [],
      status: 'CONFIRMED',
    };
    localTeams.set('team-tour-b', teamBDoc);
    await syncTeamPlayerMemberships(teamBDoc);

    const tourB = guildSettingsCache[TEST_GUILD_ID].tournaments[TOUR_B];
    tourB.verifiedRegistrations['team-tour-b'] = {
      registrationId: 'team-tour-b',
      teamId: 'team-tour-b',
      teamName: 'Beta Tour Team',
      status: 'CONFIRMED',
      discordId: userId,
      discordMemberIds: [userId],
    };

    // Delete registration in Tournament A
    await deleteTournamentRegistrationComplete({
      tournamentId: TOUR_A,
      teamId: 'team-tour-a',
      savedTournament: guildSettingsCache[TEST_GUILD_ID].tournaments[TOUR_A],
    });

    // Tournament A membership is removed
    assert.equal(localPlayerMemberships.has(`${TOUR_A}:${userId}`), false);

    // Tournament B membership remains fully intact!
    assert.equal(localPlayerMemberships.has(`${TOUR_B}:${userId}`), true);
    assert.equal(localPlayerMemberships.get(`${TOUR_B}:${userId}`).teamId, 'team-tour-b');
    assert.equal(tourB.verifiedRegistrations['team-tour-b'].status, 'CONFIRMED');
  });

  test('Scenario 5 & 6: Delete registration → Match District ID and Discord account linking remain unchanged', async () => {
    const mdUserId = 'md-user-9988';
    const discordUserId = '111111111111111111';
    const username = 'GhostRider';

    // 1. Establish permanent identity linking
    const linked = await savePermanentDiscordIdentity({
      matchDistrictUserId: mdUserId,
      discordUserId,
      discordUsername: username,
      metadata: { tier: 'pro', verifiedPlayer: true },
    });

    assert.equal(linked.matchDistrictUserId, mdUserId);
    assert.equal(linked.discordUserId, discordUserId);

    // 2. Setup team registration in Tournament A
    const teamDoc = {
      tournamentId: TOUR_A,
      teamId: 'team-to-delete',
      teamName: 'Temporary Team',
      leaderDiscordId: discordUserId,
      players: [],
      status: 'CONFIRMED',
    };
    localTeams.set('team-to-delete', teamDoc);
    await syncTeamPlayerMemberships(teamDoc);

    // 3. Admin deletes the team registration completely
    await deleteTournamentRegistrationComplete({
      tournamentId: TOUR_A,
      teamId: 'team-to-delete',
      reason: 'Rule enforcement',
      savedTournament: guildSettingsCache[TEST_GUILD_ID].tournaments[TOUR_A],
      purgeRegistration: true,
    });

    // 4. Verify permanent account identity was NOT altered or deleted
    const identityByDiscord = await getPermanentDiscordIdentityByDiscordId(discordUserId);
    assert.ok(identityByDiscord, 'Permanent identity must survive team deletion');
    assert.equal(identityByDiscord.matchDistrictUserId, mdUserId);
    assert.equal(identityByDiscord.discordUserId, discordUserId);
    assert.equal(identityByDiscord.discordUsername, username);
    assert.equal(identityByDiscord.tier, 'pro');

    const identityByMD = await getPermanentDiscordIdentityByMatchDistrictId(mdUserId);
    assert.ok(identityByMD);
    assert.equal(identityByMD.discordUserId, discordUserId);
  });

  test('Scenario 7 & 8: Old verification code rejected, new registration fresh verification succeeds', async () => {
    const leaderDiscordId = '111111111111111111';
    const mdUserId = 'md-account-1234';

    // Establish permanent identity
    await savePermanentDiscordIdentity({
      matchDistrictUserId: mdUserId,
      discordUserId: leaderDiscordId,
      discordUsername: 'CaptainAlpha',
    });

    const guild = { id: TEST_GUILD_ID };

    guildSettingsCache[TEST_GUILD_ID].tournaments[TOUR_A].channels = {
      tournamentVerificationId: 'chan-verify',
    };

    // Mock fetch: old code 'OLDCODE1' was invalidated / rejected
    const originalFetch = global.fetch;
    let codeChecked = '';
    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body || '{}');
      codeChecked = body.code;
      if (body.code === 'OLDCODE1') {
        return {
          ok: false,
          status: 400,
          json: async () => ({ success: false, reason: 'registration_rejected', message: 'Code is invalid.' }),
        };
      }
      if (body.code === 'NEWCODE2') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            registration_id: 'reg-fresh-100',
            team_name: 'Fresh Champions',
            captain_name: 'CaptainAlpha',
            captain_uid: mdUserId,
            captain_discord_id: leaderDiscordId,
            squad: [{ ign: 'CaptainAlpha', uid: mdUserId }],
            players: [],
            substitutes: [],
            teammates_needed: 0,
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({ success: false, reason: 'not_found' }) };
    };

    try {
      let sentMessages = [];
      const mockChannel = {
        id: 'chan-verify',
        send: async (payload) => {
          sentMessages.push(payload);
          return { delete: async () => {} };
        },
      };

      // 1. Submit old code → must be rejected
      const oldCodeMsg = {
        guild,
        channel: mockChannel,
        author: { id: leaderDiscordId, bot: false, tag: 'CaptainAlpha#0001' },
        content: 'OLDCODE1',
        delete: async () => {},
      };
      await handleTournamentVerificationMessage(oldCodeMsg);
      assert.equal(codeChecked, 'OLDCODE1');
      assert.ok(
        sentMessages.some((m) => m.content?.includes('not valid for this tournament') || m.content?.includes('invalid')),
        'Old code must be rejected'
      );

      // 2. Submit new code for fresh registration → succeeds
      sentMessages = [];
      const newCodeMsg = {
        guild,
        channel: mockChannel,
        author: { id: leaderDiscordId, bot: false, tag: 'CaptainAlpha#0001' },
        content: 'NEWCODE2',
        delete: async () => {},
      };
      await handleTournamentVerificationMessage(newCodeMsg);
      assert.equal(codeChecked, 'NEWCODE2');
      assert.ok(
        sentMessages.some((m) => m.content?.includes('Code accepted')),
        'Fresh verification code must be accepted'
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('Scenario 9: Restart bot → deleted memberships do not reappear', async () => {
    const leaderId = '111111111111111111';
    const memId = '222222222222222222';

    // Seed team
    const ghostTeam = {
      tournamentId: TOUR_A,
      teamId: 'team-ghost',
      teamName: 'Ghost Squad',
      leaderDiscordId: leaderId,
      players: [{ discordId: memId }],
      status: 'CONFIRMED',
    };
    localTeams.set('team-ghost', ghostTeam);
    await syncTeamPlayerMemberships(ghostTeam);

    // Verify active
    let members = await getTournamentPlayerMemberships(TOUR_A);
    assert.equal(members.length, 2);

    // Admin deletes team completely
    await deleteTournamentRegistrationComplete({
      tournamentId: TOUR_A,
      teamId: 'team-ghost',
      savedTournament: guildSettingsCache[TEST_GUILD_ID].tournaments[TOUR_A],
    });

    // Verify memory maps are cleared
    assert.equal(localPlayerMemberships.size, 0);

    // Simulate bot process restart: clear in-memory stores
    clearInMemoryData();

    // Query tournament player memberships
    members = await getTournamentPlayerMemberships(TOUR_A);
    assert.equal(members.length, 0, 'Deleted memberships must not reappear after restart');
    assert.equal(localPlayerMemberships.size, 0);
  });

  test('Scenario 10: Dashboard → deleted team is no longer counted', async () => {
    const guild = { id: TEST_GUILD_ID };
    const savedTour = guildSettingsCache[TEST_GUILD_ID].tournaments[TOUR_A];

    // Register Team 1
    savedTour.verifiedRegistrations['team-1'] = {
      registrationId: 'team-1',
      teamId: 'team-1',
      teamName: 'Team One',
      status: 'CONFIRMED',
      discordId: '111111111111111111',
      discordMemberIds: ['111111111111111111'],
    };

    // Register Team 2
    savedTour.verifiedRegistrations['team-2'] = {
      registrationId: 'team-2',
      teamId: 'team-2',
      teamName: 'Team Two',
      status: 'CONFIRMED',
      discordId: '222222222222222222',
      discordMemberIds: ['222222222222222222'],
    };

    // Initially 2 confirmed teams
    let confirmed = await getConfirmedTeamsFromDb(guild, TOUR_A, savedTour);
    assert.equal(confirmed.length, 2);

    // Admin deletes Team 1
    await deleteTournamentRegistrationComplete({
      tournamentId: TOUR_A,
      teamId: 'team-1',
      guildId: TEST_GUILD_ID,
      savedTournament: savedTour,
      purgeRegistration: true,
    });

    // Dashboard query immediately reflects 1 team
    confirmed = await getConfirmedTeamsFromDb(guild, TOUR_A, savedTour);
    assert.equal(confirmed.length, 1);
    assert.equal(confirmed[0].teamId, 'team-2');

    // Format channel roster shows exactly 1 confirmed team
    const rosterChunks = formatTeamsChannelRoster({ id: TOUR_A, title: 'Tournament Alpha' }, confirmed);
    assert.ok(rosterChunks[0].includes('Total Confirmed Teams') && rosterChunks[0].includes('**1**'));
    assert.ok(!rosterChunks[0].includes('Team One'));
    assert.ok(rosterChunks[0].includes('Team Two'));
  });

  test('Scenario 11: Simultaneous registration attempts → no duplicate active memberships', async () => {
    const candidateId = 'user-concurrent-100';

    const teamConcurrentA = {
      tournamentId: TOUR_A,
      teamId: 'team-concurrent-A',
      teamName: 'Team Concurrent A',
      leaderDiscordId: candidateId,
      players: [],
      status: 'CONFIRMED',
    };
    localTeams.set('team-concurrent-A', teamConcurrentA);
    await syncTeamPlayerMemberships(teamConcurrentA);

    // Exclusivity check for second team must detect conflict
    const attempt2Check = await checkTournamentPlayerExclusivity(TOUR_A, [candidateId]);
    assert.equal(attempt2Check.ok, false, 'Second concurrent team must be rejected due to exclusivity violation');
    assert.equal(attempt2Check.conflicts[0].discordUserId, candidateId);

    // Only one active membership exists for this user in Tournament A
    const memberships = await getTournamentPlayerMemberships(TOUR_A);
    const userMemberships = memberships.filter(m => m.discordUserId === candidateId);
    assert.equal(userMemberships.length, 1);
  });
});
