import test from 'node:test';
import assert from 'node:assert/strict';
import {
  guildSettingsCache,
} from '../index.js';
import {
  getConfirmedTeamsFromDb,
  formatTeamsChannelRoster,
  updateTeamsRosterMessages,
  handleTournamentVerificationInteraction,
} from '../tournamentService.js';
import {
  localPlayerMemberships,
  localTeams,
  checkTournamentPlayerExclusivity,
  syncTeamPlayerMemberships,
  releaseTeamPlayerMemberships,
  setExternalGuildSettingsGetter,
} from '../configurableTournamentData.js';
import {
  localPendingVerifications,
  createPendingTournamentVerification,
} from '../mongoService.js';

const TEST_GUILD_ID = 'guild-consistency-test';
const TOUR_1 = 'tour-consistency-1';
const TOUR_2 = 'tour-consistency-2';

test.beforeEach(() => {
  setExternalGuildSettingsGetter(() => guildSettingsCache);
  localPlayerMemberships.clear();
  localTeams.clear();
  localPendingVerifications.clear();
  guildSettingsCache[TEST_GUILD_ID] = {
    tournaments: {
      [TOUR_1]: {
        tournamentId: TOUR_1,
        tournamentTitle: '10K Tournament',
        verifiedRegistrations: {},
      },
      [TOUR_2]: {
        tournamentId: TOUR_2,
        tournamentTitle: 'Another Tournament',
        verifiedRegistrations: {},
      },
    },
  };
});

test('Consistency - 1. Zero confirmed teams allows registration and dashboard shows 0', async () => {
  const guild = { id: TEST_GUILD_ID };
  const savedTour = guildSettingsCache[TEST_GUILD_ID].tournaments[TOUR_1];

  // 1. Dashboard query returns 0 teams
  const confirmedTeams = await getConfirmedTeamsFromDb(guild, TOUR_1, savedTour);
  assert.equal(confirmedTeams.length, 0, 'Must have zero confirmed teams');

  // 2. Channel roster formatting shows 0 and empty message
  const rosterChunks = formatTeamsChannelRoster({ id: TOUR_1, title: '10K Tournament' }, []);
  assert.ok(rosterChunks[0].includes('Total Confirmed Teams') && rosterChunks[0].includes('**0**'));
  assert.ok(rosterChunks[0].includes('No confirmed or approved teams have been registered yet'));

  // 3. User verification check allows user to register
  const candidateIds = ['user-shanaya', 'user-teammate-1', 'user-teammate-2'];
  const exclusivity = await checkTournamentPlayerExclusivity(TOUR_1, candidateIds);
  assert.equal(exclusivity.ok, true, 'User must not be blocked when there are zero confirmed teams');
  assert.equal(exclusivity.conflicts.length, 0);
});

test('Consistency - 2. User belonging to an active verified team is blocked from duplicate verification', async () => {
  const guild = { id: TEST_GUILD_ID };
  const savedTour = guildSettingsCache[TEST_GUILD_ID].tournaments[TOUR_1];

  // Register active verified team "Team ताऊ"
  savedTour.verifiedRegistrations['team-tau-id'] = {
    registrationId: 'team-tau-id',
    teamId: 'team-tau-id',
    teamName: 'Team ताऊ',
    status: 'CONFIRMED',
    discordId: 'user-shanaya',
    discordMemberIds: ['user-shanaya', 'user-tau-2', 'user-tau-3'],
  };

  await syncTeamPlayerMemberships({
    tournamentId: TOUR_1,
    teamId: 'team-tau-id',
    teamName: 'Team ताऊ',
    leaderDiscordId: 'user-shanaya',
    players: [
      { discordId: 'user-tau-2', id: 'user-tau-2' },
      { discordId: 'user-tau-3', id: 'user-tau-3' },
    ],
    status: 'CONFIRMED',
  });

  // Verify dashboard counts 1 team
  const confirmedTeams = await getConfirmedTeamsFromDb(guild, TOUR_1, savedTour);
  assert.equal(confirmedTeams.length, 1);
  assert.equal(confirmedTeams[0].teamName, 'Team ताऊ');

  // Shanaya tries to register in a new squad in the same tournament
  const candidateIds = ['user-shanaya', 'new-guy-1', 'new-guy-2'];
  const exclusivity = await checkTournamentPlayerExclusivity(TOUR_1, candidateIds);
  assert.equal(exclusivity.ok, false, 'Shanaya must be blocked from joining another squad');
  assert.equal(exclusivity.conflicts[0].discordUserId, 'user-shanaya');
});

test('Consistency - 3. Admin / Organiser cancels or deletes verified team → previous members can register again', async () => {
  const guild = { id: TEST_GUILD_ID };
  const savedTour = guildSettingsCache[TEST_GUILD_ID].tournaments[TOUR_1];

  // Set up active Team ताऊ
  savedTour.verifiedRegistrations['team-tau-id'] = {
    registrationId: 'team-tau-id',
    teamId: 'team-tau-id',
    teamName: 'Team ताऊ',
    status: 'CONFIRMED',
    discordId: 'user-shanaya',
    discordMemberIds: ['user-shanaya', 'user-tau-2', 'user-tau-3'],
  };

  await syncTeamPlayerMemberships({
    tournamentId: TOUR_1,
    teamId: 'team-tau-id',
    teamName: 'Team ताऊ',
    leaderDiscordId: 'user-shanaya',
    players: [
      { discordId: 'user-tau-2', id: 'user-tau-2' },
      { discordId: 'user-tau-3', id: 'user-tau-3' },
    ],
    status: 'CONFIRMED',
  });

  // Simulate cancellation: mark team CANCELLED and release memberships
  savedTour.verifiedRegistrations['team-tau-id'].status = 'CANCELLED';
  await releaseTeamPlayerMemberships(TOUR_1, 'team-tau-id');

  // Verify dashboard now returns 0 confirmed teams
  const confirmedTeams = await getConfirmedTeamsFromDb(guild, TOUR_1, savedTour);
  assert.equal(confirmedTeams.length, 0, 'Cancelled team must not be counted as confirmed');

  // Shanaya can now verify with a new squad
  const candidateIds = ['user-shanaya', 'new-guy-1', 'new-guy-2'];
  const exclusivity = await checkTournamentPlayerExclusivity(TOUR_1, candidateIds);
  assert.equal(exclusivity.ok, true, 'Shanaya must be eligible after team is cancelled');
  assert.equal(exclusivity.conflicts.length, 0);
});

test('Consistency - 4. All teams deleted: updateTeamsRosterMessages reconciles and dashboard shows 0', async () => {
  const guild = { id: TEST_GUILD_ID, client: {} };
  const savedTour = guildSettingsCache[TEST_GUILD_ID].tournaments[TOUR_1];

  // Old verified team left over in savedTournament
  savedTour.verifiedRegistrations['old-team-1'] = {
    registrationId: 'old-team-1',
    teamName: 'Team ताऊ',
    status: 'CONFIRMED',
    discordId: 'user-shanaya',
    discordMemberIds: ['user-shanaya'],
  };
  await syncTeamPlayerMemberships({
    tournamentId: TOUR_1,
    teamId: 'old-team-1',
    teamName: 'Team ताऊ',
    leaderDiscordId: 'user-shanaya',
    players: [],
    status: 'CONFIRMED',
  });

  const dummyChannel = {
    id: 'ch-teams-1',
    send: async () => ({ id: 'msg-1', edit: async () => {} }),
    messages: { fetch: async () => null },
  };

  // Backend returned 0 active teams: updateTeamsRosterMessages reconciles
  await updateTeamsRosterMessages(guild, { id: TOUR_1, title: '10K Tournament' }, [], dummyChannel, savedTour);

  // Status must be flipped to CANCELLED
  assert.equal(savedTour.verifiedRegistrations['old-team-1'].status, 'CANCELLED');

  // Dashboard must return 0 confirmed teams
  const confirmedTeams = await getConfirmedTeamsFromDb(guild, TOUR_1, savedTour);
  assert.equal(confirmedTeams.length, 0);

  // Exclusivity check must allow Shanaya
  const exclusivity = await checkTournamentPlayerExclusivity(TOUR_1, ['user-shanaya']);
  assert.equal(exclusivity.ok, true, 'Shanaya must not be blocked by reconciled cancelled team');
});

test('Consistency - 5. One active team and one cancelled team: only members of active team are blocked', async () => {
  const guild = { id: TEST_GUILD_ID };
  const savedTour = guildSettingsCache[TEST_GUILD_ID].tournaments[TOUR_1];

  // Team 1: Active
  savedTour.verifiedRegistrations['active-team-1'] = {
    registrationId: 'active-team-1',
    teamName: 'Team Active',
    status: 'CONFIRMED',
    discordId: 'user-active-leader',
    discordMemberIds: ['user-active-leader', 'user-active-player'],
  };
  await syncTeamPlayerMemberships({
    tournamentId: TOUR_1,
    teamId: 'active-team-1',
    teamName: 'Team Active',
    leaderDiscordId: 'user-active-leader',
    players: [{ discordId: 'user-active-player', id: 'user-active-player' }],
    status: 'CONFIRMED',
  });

  // Team 2: Cancelled (Team ताऊ)
  savedTour.verifiedRegistrations['cancelled-team-tau'] = {
    registrationId: 'cancelled-team-tau',
    teamName: 'Team ताऊ',
    status: 'CANCELLED',
    discordId: 'user-shanaya',
    discordMemberIds: ['user-shanaya'],
  };
  await releaseTeamPlayerMemberships(TOUR_1, 'cancelled-team-tau');

  // Dashboard must show exactly 1 team
  const confirmedTeams = await getConfirmedTeamsFromDb(guild, TOUR_1, savedTour);
  assert.equal(confirmedTeams.length, 1);
  assert.equal(confirmedTeams[0].teamName, 'Team Active');

  // Member of active team is blocked
  const activeCheck = await checkTournamentPlayerExclusivity(TOUR_1, ['user-active-player']);
  assert.equal(activeCheck.ok, false);

  // Member of cancelled team (Shanaya) is NOT blocked
  const shanayaCheck = await checkTournamentPlayerExclusivity(TOUR_1, ['user-shanaya']);
  assert.equal(shanayaCheck.ok, true, 'Member of cancelled team must be allowed');
});

test('Consistency - 6. Tournament 1 membership does NOT affect Tournament 2', async () => {
  const guild = { id: TEST_GUILD_ID };
  const savedTour1 = guildSettingsCache[TEST_GUILD_ID].tournaments[TOUR_1];

  // User is verified in Tournament 1
  savedTour1.verifiedRegistrations['team-tour-1'] = {
    registrationId: 'team-tour-1',
    teamName: 'Tour 1 Squad',
    status: 'CONFIRMED',
    discordId: 'user-shanaya',
    discordMemberIds: ['user-shanaya'],
  };
  await syncTeamPlayerMemberships({
    tournamentId: TOUR_1,
    teamId: 'team-tour-1',
    teamName: 'Tour 1 Squad',
    leaderDiscordId: 'user-shanaya',
    players: [],
    status: 'CONFIRMED',
  });

  // Check exclusivity in Tournament 2
  const tour2Check = await checkTournamentPlayerExclusivity(TOUR_2, ['user-shanaya']);
  assert.equal(tour2Check.ok, true, 'Tournament 1 active membership must NOT block Tournament 2 registration');
});

test('Consistency - 7. End-to-end handleTournamentVerificationInteraction blocks active conflicts and allows released users', async () => {
  const guild = {
    id: TEST_GUILD_ID,
    channels: {
      cache: new Map([['ch-verify-1', { id: 'ch-verify-1', send: async () => ({ delete: async () => {} }) }]]),
      fetch: async (id) => ({ id, send: async () => ({ delete: async () => {} }) }),
    },
    members: {
      fetch: async (id) => ({ id, user: { bot: false } }),
    },
  };
  const savedTour = guildSettingsCache[TEST_GUILD_ID].tournaments[TOUR_1];

  // Setup: Active team "Team Rivals" with member "user-rival"
  savedTour.verifiedRegistrations['team-rival-id'] = {
    registrationId: 'team-rival-id',
    teamName: 'Team Rivals',
    status: 'CONFIRMED',
    discordId: 'user-rival',
    discordMemberIds: ['user-rival'],
  };

  // Setup: Cancelled team "Team ताऊ" with member "user-shanaya"
  savedTour.verifiedRegistrations['team-tau-id'] = {
    registrationId: 'team-tau-id',
    teamName: 'Team ताऊ',
    status: 'CANCELLED',
    discordId: 'user-shanaya',
    discordMemberIds: ['user-shanaya'],
  };

  // Case A: Shanaya creates a new verification session with new teammate
  const pendingId = 'session-shanaya-new';
  await createPendingTournamentVerification({
    pendingId,
    registrationId: 'reg-shanaya-new',
    starterDiscordId: 'user-shanaya',
    tournamentId: TOUR_1,
    guildId: TEST_GUILD_ID,
    channelId: 'ch-verify-1',
    status: 'active',
    teamName: 'Team Shanaya New',
    teammatesNeeded: 1,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });

  // Shanaya tries to select "user-rival" (who is already in active Team Rivals)
  const rivalReplies = [];
  const rivalInteraction = {
    customId: `tver:select:${pendingId}`,
    user: { id: 'user-shanaya' },
    guild,
    channelId: 'ch-verify-1',
    channel: guild.channels.cache.get('ch-verify-1'),
    isUserSelectMenu: () => true,
    isButton: () => false,
    values: ['user-rival'],
    deferred: false,
    replied: false,
    deferUpdate: async function () { this.deferred = true; },
    reply: async function (opts) { rivalReplies.push(opts); },
    followUp: async function (opts) { rivalReplies.push(opts); },
    editReply: async function (opts) { rivalReplies.push(opts); },
  };

  await handleTournamentVerificationInteraction(rivalInteraction);
  const rivalBlocked = rivalReplies.find(r => r.content.includes('already in verified team "Team Rivals"'));
  assert.ok(rivalBlocked, 'Must block selection of user-rival who is in active Team Rivals');

  // Case B: Shanaya selects "user-fresh" (not in any active team)
  // Shanaya (from cancelled Team ताऊ) is NOT blocked
  const freshReplies = [];
  const freshInteraction = {
    customId: `tver:select:${pendingId}`,
    user: { id: 'user-shanaya' },
    guild,
    channelId: 'ch-verify-1',
    channel: guild.channels.cache.get('ch-verify-1'),
    isUserSelectMenu: () => true,
    isButton: () => false,
    values: ['user-fresh'],
    deferred: false,
    replied: false,
    deferUpdate: async function () { this.deferred = true; },
    reply: async function (opts) { freshReplies.push(opts); },
    followUp: async function (opts) { freshReplies.push(opts); },
    editReply: async function (opts) { freshReplies.push(opts); },
  };

  await handleTournamentVerificationInteraction(freshInteraction);
  const freshBlocked = freshReplies.find(r => r.content?.includes('already in verified team'));
  assert.equal(freshBlocked, undefined, 'Shanaya must NOT be blocked because Team ताऊ is cancelled');
});
