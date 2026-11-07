import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ChannelType,
  PermissionFlagsBits,
} from 'discord.js';
import {
  ARENA_STATUS,
  clearInMemoryArenaData,
  getArenaPlayer,
  upsertArenaPlayer,
  getArenaChallenge,
  getArenaMatch,
  getArenaVolunteer,
  getArenaConfig,
  getOpenDisputes,
  getArenaLogs,
  ALLOWED_TRANSITIONS,
} from '../bot/discord/features/arena/models/arenaModels.js';
import {
  setupArenaChannels,
  getOrCreateMatchCategory,
} from '../bot/discord/features/arena/services/arenaChannelService.js';
import {
  handleCreateChallenge,
  handleCancelChallenge,
  handleAcceptChallenge,
} from '../bot/discord/features/arena/services/arenaChallengeService.js';
import {
  handleClaimMatch,
  handleReleaseMatch,
} from '../bot/discord/features/arena/services/arenaVolunteerService.js';
import {
  transitionArenaStatus,
  submitRoomDetails,
  startMatch,
  initiateWinnerSubmission,
  processWinnerScreenshot,
} from '../bot/discord/features/arena/services/arenaMatchService.js';
import {
  handlePlayerConfirmation,
  completeArenaMatch,
} from '../bot/discord/features/arena/services/arenaResultService.js';
import {
  handleFileDispute,
  handleAdminResolveDispute,
} from '../bot/discord/features/arena/services/arenaDisputeService.js';
import {
  checkArenaLifecycles,
  recoverArenaOnStartup,
} from '../bot/discord/features/arena/services/arenaScheduler.js';
import {
  handleArenaCommand,
  handleVolunteerCommand,
  handleMyMatchesCommand,
  handleReleaseCommand,
} from '../bot/discord/features/arena/commands/arenaCommandHandler.js';
import {
  handleArenaInteraction,
} from '../bot/discord/features/arena/components/arenaInteractionHandler.js';

function createMockArenaEnvironment(guildId = 'guild-arena-100') {
  const channels = new Map();
  const roles = new Map();
  const members = new Map();

  const createMockChannel = (id, name, type = ChannelType.GuildText, parentId = null) => {
    const messages = new Map();
    const sentMessages = [];
    const ch = {
      id,
      name,
      type,
      parentId,
      guildId,
      messages: {
        cache: messages,
        fetch: async (msgId) => messages.get(msgId) || null,
        fetchPinned: async () => new Map(),
      },
      permissionOverwrites: {
        cache: new Map(),
        edit: async (targetId, perms) => {
          ch.permissionOverwrites.cache.set(targetId, perms);
          return ch;
        },
        delete: async (targetId) => {
          ch.permissionOverwrites.cache.delete(targetId);
          return ch;
        },
      },
      send: async (payload) => {
        const msgId = `msg-${id}-${sentMessages.length + 1}`;
        const msgObj = {
          id: msgId,
          channelId: id,
          content: typeof payload === 'string' ? payload : payload?.content || '',
          embeds: payload?.embeds || [],
          components: payload?.components || [],
          files: payload?.files || [],
          edits: [],
          edit: async (editPayload) => {
            msgObj.content = typeof editPayload === 'string' ? editPayload : editPayload?.content ?? msgObj.content;
            msgObj.embeds = editPayload?.embeds ?? msgObj.embeds;
            msgObj.components = editPayload?.components ?? msgObj.components;
            msgObj.edits.push(editPayload);
            return msgObj;
          },
          pin: async () => true,
          delete: async () => {
            messages.delete(msgId);
            return msgObj;
          },
        };
        messages.set(msgId, msgObj);
        sentMessages.push(msgObj);
        return msgObj;
      },
      delete: async () => {
        channels.delete(id);
        return ch;
      },
      _sent: sentMessages,
    };
    channels.set(id, ch);
    return ch;
  };

  const guild = {
    id: guildId,
    name: 'MatchDistrict Arena Guild',
    channels: {
      cache: channels,
      fetch: async (id) => channels.get(id) || null,
      create: async (opts) => {
        const chId = `ch-${opts.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}-${channels.size + 1}`;
        return createMockChannel(chId, opts.name, opts.type || ChannelType.GuildText, opts.parent || null);
      },
    },
    roles: {
      cache: roles,
      fetch: async (id) => roles.get(id) || null,
      create: async (opts) => {
        const roleId = `role-${opts.name.toLowerCase()}-${roles.size + 1}`;
        const role = { id: roleId, name: opts.name, color: opts.color || 0 };
        roles.set(roleId, role);
        return role;
      },
    },
    members: {
      cache: members,
      fetch: async (id) => members.get(id) || null,
    },
  };

  const client = {
    guilds: {
      cache: new Map([[guildId, guild]]),
      fetch: async (id) => (id === guildId ? guild : null),
    },
    users: {
      cache: new Map(),
      fetch: async (id) => {
        const m = members.get(id);
        return m?.user || { id, username: `user-${id}`, send: async () => ({ id: `dm-${Date.now()}` }) };
      },
    },
  };

  const addMember = (id, displayName, { isAdmin = false, isVolunteer = false } = {}) => {
    const memberRoles = new Map();
    if (isVolunteer) {
      memberRoles.set('role-volunteer', { id: 'role-volunteer', name: 'Volunteer' });
    }
    const mem = {
      id,
      displayName,
      user: { id, username: displayName },
      guild,
      client,
      roles: {
        cache: memberRoles,
        add: async (role) => {
          memberRoles.set(role.id, role);
          return mem;
        },
        remove: async (role) => {
          memberRoles.delete(role.id);
          return mem;
        },
      },
      permissions: {
        has: (p) => {
          if (isAdmin) return true;
          return false;
        },
      },
    };
    members.set(id, mem);
    return mem;
  };

  return { guild, client, channels, roles, members, addMember };
}

test.describe('1v1 Challenge Arena Test Suite', () => {
  test.beforeEach(() => {
    clearInMemoryArenaData();
  });

  test('1. Setup Command creates categories, channels, Volunteer role, and persistent panel idempotently', async () => {
    const env = createMockArenaEnvironment();
    const admin = env.addMember('admin-1', 'AdminUser', { isAdmin: true });

    let reply = '';
    await handleArenaCommand(env.guild, admin, null, ['setup'], (text) => { reply = typeof text === 'string' ? text : text.content; });
    assert.match(reply, /1v1 Challenge Arena Setup Complete/);

    const config = await getArenaConfig(env.guild.id);
    assert.ok(config.categoryId);
    assert.ok(config.createChannelId);
    assert.ok(config.availableChannelId);
    assert.ok(config.volunteerPanelId);
    assert.ok(config.matchResultsId);
    assert.ok(config.supportChannelId);
    assert.ok(config.evidenceChannelId);
    assert.ok(config.volunteerRoleId);
    assert.ok(config.panelMessageId);

    // Verify channel count
    const initialChannelCount = env.channels.size;

    // Run setup again - verify idempotency
    await handleArenaCommand(env.guild, admin, null, ['setup'], (text) => { reply = typeof text === 'string' ? text : text.content; });
    assert.match(reply, /Setup Complete/);
    assert.equal(env.channels.size, initialChannelCount, 'Idempotent setup should not create duplicate channels');
  });

  test('2. Category overflow creates ARENA MATCHES 2 when category is full', async () => {
    const env = createMockArenaEnvironment();
    const admin = env.addMember('admin-1', 'AdminUser', { isAdmin: true });
    await handleArenaCommand(env.guild, admin, null, ['setup'], () => {});

    const config = await getArenaConfig(env.guild.id);
    // Simulate first category having 49 channels
    const firstCat = env.channels.get(config.matchCategories[0]);
    firstCat.children = { cache: new Map() };
    for (let i = 0; i < 49; i++) {
      firstCat.children.cache.set(`dummy-${i}`, { id: `dummy-${i}` });
    }

    const nextCat = await getOrCreateMatchCategory(env.guild, config);
    assert.equal(nextCat.name, 'ARENA MATCHES 2');
    const updatedConfig = await getArenaConfig(env.guild.id);
    assert.equal(updatedConfig.matchCategories.length, 2);
  });

  test('3. Player BGMI details registration, digits-only validation & unique UID enforcement', async () => {
    const env = createMockArenaEnvironment();
    const player1 = env.addMember('p1', 'PlayerOne');
    const player2 = env.addMember('p2', 'PlayerTwo');

    // Register Player 1 with valid numeric UID
    let modalReply1 = null;
    await handleArenaInteraction({
      customId: 'arena:modal_bgmi:update:none',
      isButton: () => false,
      isModalSubmit: () => true,
      user: player1.user,
      member: player1,
      guild: env.guild,
      client: env.client,
      fields: {
        getTextInputValue: (field) => (field === 'bgmi_ign' ? 'SniperOne' : '5123456789'),
      },
      reply: async (p) => { modalReply1 = p; },
    });
    assert.match(modalReply1.content, /Details Saved/);

    const p1Doc = await getArenaPlayer('p1');
    assert.equal(p1Doc.bgmiIgn, 'SniperOne');
    assert.equal(p1Doc.bgmiUid, '5123456789');

    // Reject non-numeric UID
    let modalReplyInvalid = null;
    await handleArenaInteraction({
      customId: 'arena:modal_bgmi:update:none',
      isButton: () => false,
      isModalSubmit: () => true,
      user: player2.user,
      member: player2,
      guild: env.guild,
      client: env.client,
      fields: {
        getTextInputValue: (field) => (field === 'bgmi_ign' ? 'Player2' : 'UID_INVALID_123'),
      },
      reply: async (p) => { modalReplyInvalid = p; },
    });
    assert.match(modalReplyInvalid.content, /digits only/);

    // Reject duplicate UID taken by Player 1
    let modalReplyDup = null;
    await handleArenaInteraction({
      customId: 'arena:modal_bgmi:update:none',
      isButton: () => false,
      isModalSubmit: () => true,
      user: player2.user,
      member: player2,
      guild: env.guild,
      client: env.client,
      fields: {
        getTextInputValue: (field) => (field === 'bgmi_ign' ? 'Player2' : '5123456789'),
      },
      reply: async (p) => { modalReplyDup = p; },
    });
    assert.match(modalReplyDup.content, /already registered/);
  });

  test('4. Challenge creation, 30s cooldown, single open challenge, and cancellation', async () => {
    const env = createMockArenaEnvironment();
    const admin = env.addMember('admin-1', 'AdminUser', { isAdmin: true });
    await handleArenaCommand(env.guild, admin, null, ['setup'], () => {});

    const player1 = env.addMember('p1', 'PlayerOne');
    await upsertArenaPlayer('p1', { displayName: 'PlayerOne', bgmiIgn: 'P1Ign', bgmiUid: '11111' });

    // Create challenge
    const res1 = await handleCreateChallenge(env.guild, player1);
    assert.equal(res1.ok, true);
    assert.equal(res1.challenge.challengeId, 'MD-10001');
    assert.equal(res1.challenge.status, ARENA_STATUS.OPEN);

    // Attempt to create second challenge during cooldown -> rejected
    const res2 = await handleCreateChallenge(env.guild, player1);
    assert.equal(res2.valid, false);
    assert.match(res2.error, /Open Challenge Exists|Cooldown/);

    // Cancel own challenge
    const cancelRes = await handleCancelChallenge(env.guild, player1, 'MD-10001');
    assert.equal(cancelRes.ok, true);
    assert.equal(cancelRes.challenge.status, ARENA_STATUS.CANCELLED);

    // Non-creator cannot cancel
    const player2 = env.addMember('p2', 'PlayerTwo');
    await upsertArenaPlayer('p2', { displayName: 'PlayerTwo', bgmiIgn: 'P2Ign', bgmiUid: '22222' });
    const res3 = await handleCreateChallenge(env.guild, player2);
    const cancelUnauthorized = await handleCancelChallenge(env.guild, player1, res3.challenge.challengeId);
    assert.equal(cancelUnauthorized.ok, false);
    assert.match(cancelUnauthorized.error, /Only the creator can cancel/);
  });

  test('5. Accepting challenge atomically reserves active matches and creates private match channel', async () => {
    const env = createMockArenaEnvironment();
    const admin = env.addMember('admin-1', 'AdminUser', { isAdmin: true });
    await handleArenaCommand(env.guild, admin, null, ['setup'], () => {});

    const playerA = env.addMember('pA', 'AlphaPlayer');
    const playerB = env.addMember('pB', 'BravoPlayer');
    await upsertArenaPlayer('pA', { displayName: 'AlphaPlayer', bgmiIgn: 'AlphaIgn', bgmiUid: '1001' });
    await upsertArenaPlayer('pB', { displayName: 'BravoPlayer', bgmiIgn: 'BravoIgn', bgmiUid: '1002' });

    const cRes = await handleCreateChallenge(env.guild, playerA);
    const challengeId = cRes.challenge.challengeId;

    // Creator cannot accept own challenge
    const selfAccept = await handleAcceptChallenge(env.guild, playerA, challengeId, env.client);
    assert.equal(selfAccept.ok, false);
    assert.match(selfAccept.error, /cannot accept your own/);

    // Player B accepts
    const acceptRes = await handleAcceptChallenge(env.guild, playerB, challengeId, env.client);
    assert.equal(acceptRes.ok, true);
    assert.equal(acceptRes.match.status, ARENA_STATUS.WAITING_FOR_VOLUNTEER);

    // Verify activeMatchId set on both players
    const pADoc = await getArenaPlayer('pA');
    const pBDoc = await getArenaPlayer('pB');
    assert.equal(pADoc.activeMatchId, challengeId);
    assert.equal(pBDoc.activeMatchId, challengeId);

    // Verify private match channel exists
    assert.ok(acceptRes.matchChannel);
    assert.equal(acceptRes.matchChannel.name, `match-${challengeId.toLowerCase()}`);
  });

  test('6. Volunteer claiming, self-claim prevention, active limit & release flow', async () => {
    const env = createMockArenaEnvironment();
    const admin = env.addMember('admin-1', 'AdminUser', { isAdmin: true });
    await handleArenaCommand(env.guild, admin, null, ['setup'], () => {});

    const playerA = env.addMember('pA', 'AlphaPlayer');
    const playerB = env.addMember('pB', 'BravoPlayer');
    const volunteer = env.addMember('vol-1', 'VolunteerOne', { isVolunteer: true });

    await upsertArenaPlayer('pA', { displayName: 'AlphaPlayer', bgmiIgn: 'AlphaIgn', bgmiUid: '1001' });
    await upsertArenaPlayer('pB', { displayName: 'BravoPlayer', bgmiIgn: 'BravoIgn', bgmiUid: '1002' });

    const cRes = await handleCreateChallenge(env.guild, playerA);
    const matchRes = await handleAcceptChallenge(env.guild, playerB, cRes.challenge.challengeId, env.client);
    const matchId = matchRes.match.matchId;

    // Player cannot claim own match
    const selfClaim = await handleClaimMatch(env.guild, playerA, matchId);
    assert.equal(selfClaim.ok, false);

    // Volunteer claims match
    const claimRes = await handleClaimMatch(env.guild, volunteer, matchId);
    assert.equal(claimRes.ok, true);
    assert.equal(claimRes.match.status, ARENA_STATUS.VOLUNTEER_ASSIGNED);
    assert.equal(claimRes.match.volunteerId, 'vol-1');

    // Volunteer active match limit enforcement (limit: 1)
    const secondChallenge = await handleCreateChallenge(env.guild, playerA); // wait, playerA is active
    // create with new players
    const playerC = env.addMember('pC', 'Charlie');
    const playerD = env.addMember('pD', 'Delta');
    await upsertArenaPlayer('pC', { displayName: 'Charlie', bgmiIgn: 'CIgn', bgmiUid: '3001' });
    await upsertArenaPlayer('pD', { displayName: 'Delta', bgmiIgn: 'DIgn', bgmiUid: '4001' });
    const c2 = await handleCreateChallenge(env.guild, playerC);
    const m2 = await handleAcceptChallenge(env.guild, playerD, c2.challenge.challengeId, env.client);

    const secondClaim = await handleClaimMatch(env.guild, volunteer, m2.match.matchId);
    assert.equal(secondClaim.ok, false);
    assert.match(secondClaim.error, /Match Limit Reached/);

    // Volunteer releases first match
    const releaseRes = await handleReleaseMatch(env.guild, volunteer, matchId);
    assert.equal(releaseRes.ok, true);
    assert.equal(releaseRes.match.status, ARENA_STATUS.WAITING_FOR_VOLUNTEER);
    assert.equal(releaseRes.match.volunteerId, null);

    const volDoc = await getArenaVolunteer('vol-1');
    assert.equal(volDoc.activeMatches, 0);
  });

  test('7. Complete match lifecycle: Room Details -> Start -> Winner Submit -> Confirmation -> Completed', async () => {
    const env = createMockArenaEnvironment();
    const admin = env.addMember('admin-1', 'AdminUser', { isAdmin: true });
    await handleArenaCommand(env.guild, admin, null, ['setup'], () => {});

    const playerA = env.addMember('pA', 'AlphaPlayer');
    const playerB = env.addMember('pB', 'BravoPlayer');
    const volunteer = env.addMember('vol-1', 'VolunteerOne', { isVolunteer: true });

    await upsertArenaPlayer('pA', { displayName: 'AlphaPlayer', bgmiIgn: 'AlphaIgn', bgmiUid: '1001' });
    await upsertArenaPlayer('pB', { displayName: 'BravoPlayer', bgmiIgn: 'BravoIgn', bgmiUid: '1002' });

    const cRes = await handleCreateChallenge(env.guild, playerA);
    const matchRes = await handleAcceptChallenge(env.guild, playerB, cRes.challenge.challengeId, env.client);
    const matchId = matchRes.match.matchId;

    await handleClaimMatch(env.guild, volunteer, matchId);

    // 1. Submit Room Details
    const roomRes = await submitRoomDetails(env.guild, volunteer, matchId, '987654', 'pass123');
    assert.equal(roomRes.ok, true);
    assert.equal(roomRes.match.status, ARENA_STATUS.ROOM_READY);
    assert.equal(roomRes.match.roomId, '987654');
    assert.equal(roomRes.match.roomPassword, 'pass123');

    // 2. Start Match
    const startRes = await startMatch(env.guild, volunteer, matchId);
    assert.equal(startRes.ok, true);
    assert.equal(startRes.match.status, ARENA_STATUS.LIVE);

    // Once LIVE, volunteer release is prohibited
    const releaseFail = await handleReleaseMatch(env.guild, volunteer, matchId);
    assert.equal(releaseFail.ok, false);

    // 3. Submit Winner (Player A)
    await initiateWinnerSubmission(env.guild, volunteer, matchId, 'A');
    const currentMatch = await getArenaMatch(matchId);
    assert.equal(currentMatch.pendingWinnerId, 'pA');

    // 4. Volunteer uploads screenshot
    const screenshotRes = await processWinnerScreenshot(
      env.guild,
      currentMatch,
      volunteer,
      'https://cdn.discordapp.com/attachments/1/2/screenshot.png'
    );
    assert.equal(screenshotRes.ok, true);
    assert.equal(screenshotRes.match.status, ARENA_STATUS.RESULT_PENDING);

    // 5. Player A confirms result
    const pAConfirm = await handlePlayerConfirmation(env.guild, playerA, matchId);
    assert.equal(pAConfirm.ok, true);
    assert.equal(pAConfirm.waitingForOpponent, true);

    // 6. Player B confirms result -> Completes match
    const pBConfirm = await handlePlayerConfirmation(env.guild, playerB, matchId);
    assert.equal(pBConfirm.ok, true);
    assert.equal(pBConfirm.match.status, ARENA_STATUS.COMPLETED);

    // Check stats updated
    const pADoc = await getArenaPlayer('pA');
    const pBDoc = await getArenaPlayer('pB');
    assert.equal(pADoc.stats.won, 1);
    assert.equal(pADoc.stats.played, 1);
    assert.equal(pBDoc.stats.lost, 1);
    assert.equal(pBDoc.stats.played, 1);

    // Check activeMatchId freed
    assert.equal(pADoc.activeMatchId, null);
    assert.equal(pBDoc.activeMatchId, null);

    // Check volunteer active matches decremented and completedMatches incremented
    const volDoc = await getArenaVolunteer('vol-1');
    assert.equal(volDoc.activeMatches, 0);
    assert.equal(volDoc.completedMatches, 1);

    // Check room password cleared
    const finalMatch = await getArenaMatch(matchId);
    assert.equal(finalMatch.roomPassword, null);
    assert.ok(finalMatch.deleteChannelAt);
  });

  test('8. Dispute filing moves match to UNDER_REVIEW and admin resolves dispute', async () => {
    const env = createMockArenaEnvironment();
    const admin = env.addMember('admin-1', 'AdminUser', { isAdmin: true });
    await handleArenaCommand(env.guild, admin, null, ['setup'], () => {});

    const playerA = env.addMember('pA', 'AlphaPlayer');
    const playerB = env.addMember('pB', 'BravoPlayer');
    const volunteer = env.addMember('vol-1', 'VolunteerOne', { isVolunteer: true });

    await upsertArenaPlayer('pA', { displayName: 'AlphaPlayer', bgmiIgn: 'AlphaIgn', bgmiUid: '1001' });
    await upsertArenaPlayer('pB', { displayName: 'BravoPlayer', bgmiIgn: 'BravoIgn', bgmiUid: '1002' });

    const cRes = await handleCreateChallenge(env.guild, playerA);
    const matchRes = await handleAcceptChallenge(env.guild, playerB, cRes.challenge.challengeId, env.client);
    const matchId = matchRes.match.matchId;

    await handleClaimMatch(env.guild, volunteer, matchId);
    await submitRoomDetails(env.guild, volunteer, matchId, '123', 'pass');
    await startMatch(env.guild, volunteer, matchId);

    // Player B files dispute
    const disputeRes = await handleFileDispute(env.guild, playerB, matchId, 'Player A used unauthorized weapon');
    assert.equal(disputeRes.ok, true);
    assert.equal(disputeRes.match.status, ARENA_STATUS.UNDER_REVIEW);

    const openDisputes = await getOpenDisputes(matchId);
    assert.equal(openDisputes.length, 1);

    // Admin resolves dispute in favor of Player B
    const resolveRes = await handleAdminResolveDispute(env.guild, admin, matchId, 'B', 'Evidence confirms rule violation');
    assert.equal(resolveRes.ok, true);
    assert.equal(resolveRes.match.status, ARENA_STATUS.COMPLETED);
    assert.equal(resolveRes.match.winnerId, 'pB');

    const pBDoc = await getArenaPlayer('pB');
    assert.equal(pBDoc.stats.won, 1);
  });

  test('9. Strict Allowed Status Transitions Engine rejects invalid state jumps', async () => {
    // Attempt jump from OPEN to LIVE
    const invalidJump = await transitionArenaStatus('MD-99999', ARENA_STATUS.LIVE);
    assert.equal(invalidJump.ok, false);

    // Transition from COMPLETED
    const allowedFromCompleted = ALLOWED_TRANSITIONS[ARENA_STATUS.COMPLETED] || [];
    assert.equal(allowedFromCompleted.length, 0, 'Completed is a terminal state');
  });

  test('10. Scheduler lifecycle: challenge expiry, volunteer timeout and channel cleanup', async () => {
    const env = createMockArenaEnvironment();
    const admin = env.addMember('admin-1', 'AdminUser', { isAdmin: true });
    await handleArenaCommand(env.guild, admin, null, ['setup'], () => {});

    const playerA = env.addMember('pA', 'AlphaPlayer');
    await upsertArenaPlayer('pA', { displayName: 'AlphaPlayer', bgmiIgn: 'AlphaIgn', bgmiUid: '1001' });

    // 1. Challenge Expiry
    const cRes = await handleCreateChallenge(env.guild, playerA);
    const challengeId = cRes.challenge.challengeId;

    // Fast-forward expiresAt to 1 second in the past
    const { updateArenaChallenge } = await import('../bot/discord/features/arena/models/arenaModels.js');
    await updateArenaChallenge(challengeId, { expiresAt: new Date(Date.now() - 1000) });

    await checkArenaLifecycles(env.client);
    const expiredChallenge = await getArenaChallenge(challengeId);
    assert.equal(expiredChallenge.status, ARENA_STATUS.EXPIRED);
  });

  test('11. Volunteer profile & status toggle commands', async () => {
    const env = createMockArenaEnvironment();
    const volunteer = env.addMember('vol-1', 'VolunteerOne', { isVolunteer: true });

    let reply = '';
    await handleVolunteerCommand(env.guild, volunteer, null, ['profile'], (text) => { reply = typeof text === 'string' ? text : text.content; });
    const volDoc = await getArenaVolunteer('vol-1');
    assert.equal(volDoc.status, 'AVAILABLE');

    await handleVolunteerCommand(env.guild, volunteer, null, ['status'], (text) => { reply = typeof text === 'string' ? text : text.content; });
    assert.match(reply, /UNAVAILABLE/);
    const toggled = await getArenaVolunteer('vol-1');
    assert.equal(toggled.status, 'UNAVAILABLE');
  });

  test('12. Full end-to-end interaction handling: button routing, modals, room modal, winner modal & dispute modal', async () => {
    const env = createMockArenaEnvironment();
    const admin = env.addMember('admin-1', 'AdminUser', { isAdmin: true });
    await handleArenaCommand(env.guild, admin, null, ['setup'], () => {});

    const playerA = env.addMember('pA', 'AlphaPlayer');
    const playerB = env.addMember('pB', 'BravoPlayer');
    const volunteer = env.addMember('vol-1', 'VolunteerOne', { isVolunteer: true });

    // 1. Player A clicks Create Challenge without registration -> shows modal
    let modalShown = null;
    await handleArenaInteraction({
      customId: 'arena:create_challenge',
      isButton: () => true,
      isModalSubmit: () => false,
      user: playerA.user,
      member: playerA,
      guild: env.guild,
      client: env.client,
      showModal: async (m) => { modalShown = m; },
    });
    assert.ok(modalShown);
    assert.equal(modalShown.data.custom_id, 'arena:modal_bgmi:create:none');

    // Submit registration modal with create action
    let editReplyContent = '';
    await handleArenaInteraction({
      customId: 'arena:modal_bgmi:create:none',
      isButton: () => false,
      isModalSubmit: () => true,
      user: playerA.user,
      member: playerA,
      guild: env.guild,
      client: env.client,
      fields: {
        getTextInputValue: (id) => (id === 'bgmi_ign' ? 'AlphaIgn' : '99001'),
      },
      deferReply: async () => {},
      editReply: async (p) => { editReplyContent = p.content; },
    });
    assert.match(editReplyContent, /open challenge|Details Saved/);
    const challenge = await getArenaChallenge('MD-10001');
    assert.ok(challenge);

    // 2. Player B registers and accepts challenge via interaction button
    await upsertArenaPlayer('pB', { displayName: 'BravoPlayer', bgmiIgn: 'BravoIgn', bgmiUid: '99002' });
    let acceptReply = '';
    await handleArenaInteraction({
      customId: `arena:accept_challenge:${challenge.challengeId}`,
      isButton: () => true,
      isModalSubmit: () => false,
      user: playerB.user,
      member: playerB,
      guild: env.guild,
      client: env.client,
      deferReply: async () => {},
      editReply: async (p) => { acceptReply = p.content; },
    });
    assert.match(acceptReply, /Challenge Accepted/);
    const matchId = challenge.challengeId;

    // 3. Volunteer claims match via button
    let claimReply = '';
    await handleArenaInteraction({
      customId: `arena:claim_match:${matchId}`,
      isButton: () => true,
      isModalSubmit: () => false,
      user: volunteer.user,
      member: volunteer,
      guild: env.guild,
      client: env.client,
      deferReply: async () => {},
      editReply: async (p) => { claimReply = p.content; },
    });
    assert.match(claimReply, /Match Claimed/);

    // 4. Volunteer clicks Submit Room Details -> shows modal
    let roomModal = null;
    await handleArenaInteraction({
      customId: `arena:submit_room:${matchId}`,
      isButton: () => true,
      isModalSubmit: () => false,
      user: volunteer.user,
      member: volunteer,
      guild: env.guild,
      client: env.client,
      showModal: async (m) => { roomModal = m; },
    });
    assert.ok(roomModal);
    assert.equal(roomModal.data.custom_id, `arena:modal_room:${matchId}`);

    // Submit room modal
    let roomSubmitReply = '';
    await handleArenaInteraction({
      customId: `arena:modal_room:${matchId}`,
      isButton: () => false,
      isModalSubmit: () => true,
      user: volunteer.user,
      member: volunteer,
      guild: env.guild,
      client: env.client,
      fields: {
        getTextInputValue: (id) => (id === 'room_id' ? 'ROOM555' : 'PASS555'),
      },
      deferReply: async () => {},
      editReply: async (p) => { roomSubmitReply = p.content; },
    });
    assert.match(roomSubmitReply, /Room Credentials Published/);

    // 5. Volunteer starts match via button
    let startReply = '';
    await handleArenaInteraction({
      customId: `arena:start_match:${matchId}`,
      isButton: () => true,
      isModalSubmit: () => false,
      user: volunteer.user,
      member: volunteer,
      guild: env.guild,
      client: env.client,
      deferReply: async () => {},
      editReply: async (p) => { startReply = p.content; },
    });
    assert.match(startReply, /Match Started/);

    // 6. Volunteer submits winner modal
    let winnerModal = null;
    await handleArenaInteraction({
      customId: `arena:submit_winner:${matchId}`,
      isButton: () => true,
      isModalSubmit: () => false,
      user: volunteer.user,
      member: volunteer,
      guild: env.guild,
      client: env.client,
      showModal: async (m) => { winnerModal = m; },
    });
    assert.ok(winnerModal);

    // Submit winner selection modal (Player A)
    let winnerSubmitReply = '';
    await handleArenaInteraction({
      customId: `arena:modal_winner:${matchId}`,
      isButton: () => false,
      isModalSubmit: () => true,
      user: volunteer.user,
      member: volunteer,
      guild: env.guild,
      client: env.client,
      fields: {
        getTextInputValue: (id) => 'A',
      },
      deferReply: async () => {},
      editReply: async (p) => { winnerSubmitReply = p.content; },
    });
    assert.match(winnerSubmitReply, /Winner Selection Recorded/);

    // Simulate volunteer uploading screenshot
    const matchDoc = await getArenaMatch(matchId);
    await processWinnerScreenshot(env.guild, matchDoc, volunteer, 'https://cdn.discordapp.com/screenshot.png');

    // 7. Player B clicks Dispute button -> shows dispute modal
    let disputeModal = null;
    await handleArenaInteraction({
      customId: `arena:dispute_result:${matchId}`,
      isButton: () => true,
      isModalSubmit: () => false,
      user: playerB.user,
      member: playerB,
      guild: env.guild,
      client: env.client,
      showModal: async (m) => { disputeModal = m; },
    });
    assert.ok(disputeModal);
    assert.equal(disputeModal.data.custom_id, `arena:modal_dispute:${matchId}`);

    // Submit dispute modal
    let disputeSubmitReply = '';
    await handleArenaInteraction({
      customId: `arena:modal_dispute:${matchId}`,
      isButton: () => false,
      isModalSubmit: () => true,
      user: playerB.user,
      member: playerB,
      guild: env.guild,
      client: env.client,
      fields: {
        getTextInputValue: (id) => 'Desync occurred during match',
      },
      deferReply: async () => {},
      editReply: async (p) => { disputeSubmitReply = p.content; },
    });
    assert.match(disputeSubmitReply, /Dispute Filed/);
    const underReviewMatch = await getArenaMatch(matchId);
    assert.equal(underReviewMatch.status, ARENA_STATUS.UNDER_REVIEW);
  });
});
