import test from 'node:test';
import assert from 'node:assert/strict';
import {
  localPendingVerifications,
  createPendingTournamentVerification,
  getPendingTournamentVerification,
  claimPendingTournamentVerification,
  releasePendingTournamentVerificationClaim,
  finishPendingTournamentVerification,
  cancelPendingTournamentVerification,
  cancelPendingTournamentVerificationsByTeam,
  expirePendingTournamentVerificationById,
  expirePendingTournamentVerifications,
} from '../mongoService.js';
import { handleTournamentVerificationInteraction } from '../tournamentService.js';

test.beforeEach(() => {
  localPendingVerifications.clear();
});

test('Verification Session Lifecycle - 1. Creation, Active State, and Retrieval', async () => {
  const pendingId = 'test-session-uuid-1';
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await createPendingTournamentVerification({
    pendingId,
    registrationId: 'reg-team-101',
    starterDiscordId: 'user-captain-1',
    tournamentId: 'tour-bgmi-1',
    guildId: 'guild-1',
    channelId: 'channel-verify-1',
    status: 'active',
    teamName: 'Team Alpha',
    teammatesNeeded: 3,
    expiresAt,
  });

  const session = await getPendingTournamentVerification(pendingId);
  assert.ok(session, 'Session must be retrievable');
  assert.equal(session.pendingId, pendingId);
  assert.equal(session.status, 'active');
  assert.equal(session.completionClaimed, false);
  assert.equal(session.teamName, 'Team Alpha');
  assert.equal(session.teammatesNeeded, 3);
  assert.ok(new Date(session.expiresAt).getTime() > Date.now(), 'Expiration must be in future');
});

test('Verification Session Lifecycle - 2. Startup/Periodic expirePendingTournamentVerifications does NOT kill active sessions', async () => {
  const activeSessionId = 'active-session-live';
  const expiredSessionId = 'expired-session-old';

  // Session 1: Active, expires in 8 minutes
  await createPendingTournamentVerification({
    pendingId: activeSessionId,
    registrationId: 'reg-team-102',
    starterDiscordId: 'user-captain-2',
    tournamentId: 'tour-bgmi-1',
    guildId: 'guild-1',
    channelId: 'channel-verify-1',
    status: 'active',
    teamName: 'Team Bravo',
    teammatesNeeded: 3,
    expiresAt: new Date(Date.now() + 8 * 60 * 1000),
  });

  // Session 2: Old session, expired 2 minutes ago
  localPendingVerifications.set(expiredSessionId, {
    pendingId: expiredSessionId,
    registrationId: 'reg-team-103',
    starterDiscordId: 'user-captain-3',
    tournamentId: 'tour-bgmi-1',
    guildId: 'guild-1',
    channelId: 'channel-verify-1',
    status: 'active',
    teamName: 'Team Charlie',
    teammatesNeeded: 3,
    expiresAt: new Date(Date.now() - 2 * 60 * 1000),
  });

  // Run bulk expiration sweep (e.g. at bot startup or cleanup)
  const expiredCount = await expirePendingTournamentVerifications();
  assert.equal(expiredCount, 1, 'Only the genuinely expired session should be expired');

  // Verify active session was NOT touched
  const activeCheck = await getPendingTournamentVerification(activeSessionId);
  assert.ok(activeCheck);
  assert.equal(activeCheck.status, 'active', 'In-flight active session must remain ACTIVE');

  // Verify expired session is marked expired
  const expiredCheck = await getPendingTournamentVerification(expiredSessionId);
  assert.ok(expiredCheck);
  assert.equal(expiredCheck.status, 'expired', 'Expired session must transition to expired');
});

test('Verification Session Lifecycle - 3. Re-verification supersedes older session cleanly without collisions', async () => {
  const oldPendingId = 'session-first-attempt';
  const newPendingId = 'session-second-attempt';

  // First verification attempt started
  await createPendingTournamentVerification({
    pendingId: oldPendingId,
    registrationId: 'reg-team-104',
    starterDiscordId: 'user-captain-4',
    tournamentId: 'tour-bgmi-1',
    guildId: 'guild-1',
    channelId: 'channel-verify-1',
    status: 'active',
    teamName: 'Team Delta',
    teammatesNeeded: 3,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });

  // User submits code again for the same team / user
  await createPendingTournamentVerification({
    pendingId: newPendingId,
    registrationId: 'reg-team-104',
    starterDiscordId: 'user-captain-4',
    tournamentId: 'tour-bgmi-1',
    guildId: 'guild-1',
    channelId: 'channel-verify-1',
    status: 'active',
    teamName: 'Team Delta',
    teammatesNeeded: 3,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });

  const oldSession = await getPendingTournamentVerification(oldPendingId);
  const newSession = await getPendingTournamentVerification(newPendingId);

  assert.equal(oldSession.status, 'superseded', 'Old uncompleted session must be marked superseded');
  assert.equal(newSession.status, 'active', 'New session must be active and ready');
});

test('Verification Session Lifecycle - 4. Atomic Claim, Release, and Completion', async () => {
  const pendingId = 'claim-lifecycle-session';
  const captainId = 'user-captain-5';

  await createPendingTournamentVerification({
    pendingId,
    registrationId: 'reg-team-105',
    starterDiscordId: captainId,
    tournamentId: 'tour-bgmi-1',
    guildId: 'guild-1',
    channelId: 'channel-verify-1',
    status: 'active',
    teamName: 'Team Echo',
    teammatesNeeded: 3,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });

  // 1. Initial claim succeeds
  const claim1 = await claimPendingTournamentVerification(pendingId, captainId);
  assert.ok(claim1, 'First claim must succeed');
  assert.equal(claim1.completionClaimed, true);

  // 2. Immediate concurrent claim by another trigger fails
  const claim2 = await claimPendingTournamentVerification(pendingId, captainId);
  assert.equal(claim2, null, 'Concurrent in-flight claim must be rejected');

  // 3. Temporary failure releases claim so user can re-select/retry
  const released = await releasePendingTournamentVerificationClaim(pendingId, captainId);
  assert.equal(released, true);

  const afterRelease = await getPendingTournamentVerification(pendingId);
  assert.equal(afterRelease.completionClaimed, false);
  assert.equal(afterRelease.status, 'active');

  // 4. Re-claim succeeds after release
  const claim3 = await claimPendingTournamentVerification(pendingId, captainId);
  assert.ok(claim3, 'Re-claim after release must succeed');

  // 5. Finish marks session completed
  const finished = await finishPendingTournamentVerification(pendingId, captainId, 'completed');
  assert.equal(finished, true);

  const completedSession = await getPendingTournamentVerification(pendingId);
  assert.equal(completedSession.status, 'completed');
  assert.equal(completedSession.completionClaimed, false);
});

test('Verification Session Lifecycle - 5. cancelPendingTournamentVerificationsByTeam does NOT invalidate unrelated teams', async () => {
  const teamAlphaId = 'session-alpha-id';
  const teamBetaId = 'session-beta-id';
  const teamDefaultNameId = 'session-default-name-id';

  await createPendingTournamentVerification({
    pendingId: teamAlphaId,
    registrationId: 'reg-alpha',
    starterDiscordId: 'user-alpha',
    tournamentId: 'tour-1',
    status: 'active',
    teamName: 'Team Alpha',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });

  await createPendingTournamentVerification({
    pendingId: teamBetaId,
    registrationId: 'reg-beta',
    starterDiscordId: 'user-beta',
    tournamentId: 'tour-1',
    status: 'active',
    teamName: 'Team Beta',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });

  await createPendingTournamentVerification({
    pendingId: teamDefaultNameId,
    registrationId: 'reg-gamma',
    starterDiscordId: 'user-gamma',
    tournamentId: 'tour-2',
    status: 'active',
    teamName: 'Your team',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });

  // Admin deletes or cancels Team Alpha in tour-1
  await cancelPendingTournamentVerificationsByTeam('tour-1', 'reg-alpha', 'Team Alpha');

  // Team Alpha must be cancelled
  const checkAlpha = await getPendingTournamentVerification(teamAlphaId);
  assert.equal(checkAlpha.status, 'cancelled');

  // Team Beta must NOT be affected
  const checkBeta = await getPendingTournamentVerification(teamBetaId);
  assert.equal(checkBeta.status, 'active', 'Unrelated team session in same tournament must remain active');

  // Team in tour-2 with default name 'Your team' must NOT be affected
  const checkDefault = await getPendingTournamentVerification(teamDefaultNameId);
  assert.equal(checkDefault.status, 'active', 'Team in other tournament must remain active');
});

test('Verification Session Lifecycle - 6. Interaction handling with uncached channel gracefully resolves and keeps session active', async () => {
  const pendingId = 'session-uncached-channel-test';
  const captainId = 'user-captain-test-6';
  const channelId = 'channel-test-verify-1';
  const guildId = 'guild-test-1';

  await createPendingTournamentVerification({
    pendingId,
    registrationId: 'reg-team-106',
    starterDiscordId: captainId,
    tournamentId: 'tour-bgmi-1',
    guildId,
    channelId,
    status: 'active',
    teamName: 'Team Uncached',
    teammatesNeeded: 2,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });

  const replies = [];
  const channelMock = {
    id: channelId,
    send: async () => ({ delete: async () => { } }),
  };

  // Mock interaction where interaction.channel is NULL (uncached), but interaction.channelId is present
  const interactionMock = {
    customId: `tver:select:${pendingId}`,
    user: { id: captainId, bot: false },
    guild: {
      id: guildId,
      channels: {
        cache: new Map([[channelId, channelMock]]),
        fetch: async (id) => (id === channelId ? channelMock : null),
      },
      members: {
        fetch: async (id) => {
          if (id === 'tm-1' || id === 'tm-2') return { id, user: { bot: false } };
          return null;
        },
      },
    },
    channel: null, // Simulate uncached channel!
    channelId,
    isUserSelectMenu: () => true,
    isButton: () => false,
    values: ['tm-1', 'tm-2'],
    deferred: false,
    replied: false,
    deferUpdate: async function () { this.deferred = true; },
    deferReply: async function () { this.deferred = true; },
    followUp: async function (opts) { replies.push(opts); },
    editReply: async function (opts) { replies.push(opts); },
    reply: async function (opts) { replies.push(opts); },
  };

  // Execute interaction
  const handled = await handleTournamentVerificationInteraction(interactionMock);
  assert.equal(handled, true);

  // Assert it did NOT reject with 'This verification is no longer active.'
  const activeError = replies.find(r => typeof r.content === 'string' && r.content.includes('no longer active'));
  assert.equal(activeError, undefined, 'Must not reject with "no longer active" due to uncached channel');
});

test('Verification Session Lifecycle - 7. Ownership enforcement and expired session feedback', async () => {
  const pendingId = 'session-ownership-test';
  const captainId = 'user-owner-1';
  const impostorId = 'user-impostor-9';

  await createPendingTournamentVerification({
    pendingId,
    registrationId: 'reg-team-107',
    starterDiscordId: captainId,
    tournamentId: 'tour-bgmi-1',
    guildId: 'guild-1',
    channelId: 'channel-1',
    status: 'active',
    teamName: 'Team Owner',
    teammatesNeeded: 1,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });

  const impostorReplies = [];
  const impostorInteraction = {
    customId: `tver:select:${pendingId}`,
    user: { id: impostorId },
    guild: { id: 'guild-1' },
    channelId: 'channel-1',
    channel: { id: 'channel-1' },
    isUserSelectMenu: () => true,
    isButton: () => false,
    deferred: false,
    replied: false,
    deferUpdate: async function () { this.deferred = true; },
    reply: async function (opts) { impostorReplies.push(opts); },
    followUp: async function (opts) { impostorReplies.push(opts); },
    editReply: async function (opts) { impostorReplies.push(opts); },
  };

  await handleTournamentVerificationInteraction(impostorInteraction);
  const ownershipReply = impostorReplies.find(r => r.content.includes("isn't your verification session"));
  assert.ok(ownershipReply, 'Must inform other users that this is not their verification session');

  // Now test genuine expiration on this session
  await expirePendingTournamentVerificationById(pendingId, captainId);

  const expiredReplies = [];
  const captainInteraction = {
    customId: `tver:select:${pendingId}`,
    user: { id: captainId },
    guild: { id: 'guild-1' },
    channelId: 'channel-1',
    channel: { id: 'channel-1' },
    isUserSelectMenu: () => true,
    isButton: () => false,
    deferred: false,
    replied: false,
    deferUpdate: async function () { this.deferred = true; },
    reply: async function (opts) { expiredReplies.push(opts); },
    followUp: async function (opts) { expiredReplies.push(opts); },
    editReply: async function (opts) { expiredReplies.push(opts); },
  };

  await handleTournamentVerificationInteraction(captainInteraction);
  const expiredReply = expiredReplies.find(r => r.content.includes('expired'));
  assert.ok(expiredReply, 'Must clearly inform captain that the session expired with instructions to restart');
});

