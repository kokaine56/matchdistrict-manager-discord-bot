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
  createArenaChallenge,
  getArenaMatch,
  createArenaMatch,
  getArenaVolunteer,
  upsertArenaVolunteer,
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
        const ch = createMockChannel(chId, opts.name, opts.type || ChannelType.GuildText, opts.parent || null);
        if (Array.isArray(opts.permissionOverwrites)) {
          for (const ow of opts.permissionOverwrites) {
            ch.permissionOverwrites.cache.set(ow.id, ow);
          }
        }
        return ch;
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
  guild.client = client;

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

  test('1. Setup Command creates categories, channels, public volunteer panel, and persistent panel idempotently', async () => {
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
    assert.ok(!config.volunteerRoleId, 'No Volunteer role should be created or stored');
    assert.ok(config.panelMessageId);

    // Verify volunteer panel is public for @everyone
    const volPanel = env.channels.get(config.volunteerPanelId);
    assert.ok(volPanel);
    const everyonePerms = volPanel.permissionOverwrites.cache.get(env.guild.id);
    assert.ok(everyonePerms);
    assert.equal(everyonePerms.ViewChannel, true);
    assert.equal(everyonePerms.ReadMessageHistory, true);
    assert.equal(everyonePerms.SendMessages, false);

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

  test('6. Volunteer claiming, self-claim prevention, active limit & release flow with concurrency safety', async () => {
    const env = createMockArenaEnvironment();
    const admin = env.addMember('admin-1', 'AdminUser', { isAdmin: true });
    await handleArenaCommand(env.guild, admin, null, ['setup'], () => {});

    const playerA = env.addMember('pA', 'AlphaPlayer');
    const playerB = env.addMember('pB', 'BravoPlayer');
    // Ordinary members without any volunteer role
    const volunteer1 = env.addMember('vol-1', 'VolunteerOne');
    const volunteer2 = env.addMember('vol-2', 'VolunteerTwo');

    await upsertArenaPlayer('pA', { displayName: 'AlphaPlayer', bgmiIgn: 'AlphaIgn', bgmiUid: '1001' });
    await upsertArenaPlayer('pB', { displayName: 'BravoPlayer', bgmiIgn: 'BravoIgn', bgmiUid: '1002' });

    const cRes = await handleCreateChallenge(env.guild, playerA);
    const matchRes = await handleAcceptChallenge(env.guild, playerB, cRes.challenge.challengeId, env.client);
    const matchId = matchRes.match.matchId;

    // Player cannot claim own match
    const selfClaim = await handleClaimMatch(env.guild, playerA, matchId);
    assert.equal(selfClaim.ok, false);
    assert.match(selfClaim.error, /cannot volunteer for your own match/i);

    // Concurrent claim test: volunteer1 and volunteer2 try to claim simultaneously
    const [res1, res2] = await Promise.all([
      handleClaimMatch(env.guild, volunteer1, matchId),
      handleClaimMatch(env.guild, volunteer2, matchId),
    ]);

    // Exactly one must win, the other gets exact collision error
    const winner = res1.ok ? res1 : res2;
    const loser = res1.ok ? res2 : res1;
    assert.equal(winner.ok, true);
    assert.equal(winner.match.status, ARENA_STATUS.VOLUNTEER_ASSIGNED);
    assert.equal(loser.ok, false);
    assert.equal(loser.error, 'This match has already been claimed by another volunteer.');

    const winningVolId = winner.match.volunteerId;
    const winningMember = winningVolId === 'vol-1' ? volunteer1 : volunteer2;

    // Volunteer active match limit enforcement (limit: 1)
    const playerC = env.addMember('pC', 'Charlie');
    const playerD = env.addMember('pD', 'Delta');
    await upsertArenaPlayer('pC', { displayName: 'Charlie', bgmiIgn: 'CIgn', bgmiUid: '3001' });
    await upsertArenaPlayer('pD', { displayName: 'Delta', bgmiIgn: 'DIgn', bgmiUid: '4001' });
    const c2 = await handleCreateChallenge(env.guild, playerC);
    const m2 = await handleAcceptChallenge(env.guild, playerD, c2.challenge.challengeId, env.client);

    const secondClaim = await handleClaimMatch(env.guild, winningMember, m2.match.matchId);
    assert.equal(secondClaim.ok, false);
    assert.match(secondClaim.error, /active match limit/i);

    // Volunteer releases first match
    const releaseRes = await handleReleaseMatch(env.guild, winningMember, matchId);
    assert.equal(releaseRes.ok, true);
    assert.equal(releaseRes.match.status, ARENA_STATUS.WAITING_FOR_VOLUNTEER);
    assert.equal(releaseRes.match.volunteerId, null);

    const volDoc = await getArenaVolunteer(winningVolId);
    assert.equal(volDoc.activeMatches, 0);

    // Another volunteer can now claim the released match
    const reclaimRes = await handleClaimMatch(env.guild, volunteer2, matchId);
    assert.equal(reclaimRes.ok, true);
    assert.equal(reclaimRes.match.volunteerId, 'vol-2');
  });

  test('7. Complete match lifecycle: Room Details -> Start -> Winner Submit -> Confirmation -> Completed', async () => {
    const env = createMockArenaEnvironment();
    const admin = env.addMember('admin-1', 'AdminUser', { isAdmin: true });
    await handleArenaCommand(env.guild, admin, null, ['setup'], () => {});

    const playerA = env.addMember('pA', 'AlphaPlayer');
    const playerB = env.addMember('pB', 'BravoPlayer');
    const volunteer = env.addMember('vol-1', 'VolunteerOne');

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
    const volunteer = env.addMember('vol-1', 'VolunteerOne');

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

  test('11. Volunteer profile & status toggle commands work for any member without roles', async () => {
    const env = createMockArenaEnvironment();
    // Ordinary member without any role
    const member = env.addMember('member-vol-1', 'CommunityUser');

    let reply = '';
    await handleVolunteerCommand(env.guild, member, null, ['profile'], (text) => { reply = typeof text === 'string' ? text : text.content; });
    const volDoc = await getArenaVolunteer('member-vol-1');
    assert.ok(volDoc);
    assert.equal(volDoc.status, 'AVAILABLE');
    assert.equal(volDoc.displayName, 'CommunityUser');

    await handleVolunteerCommand(env.guild, member, null, ['status'], (text) => { reply = typeof text === 'string' ? text : text.content; });
    assert.match(reply, /UNAVAILABLE/);
    const toggled = await getArenaVolunteer('member-vol-1');
    assert.equal(toggled.status, 'UNAVAILABLE');

    // .mymatches works for any member without roles
    let myMatchesReply = null;
    await handleMyMatchesCommand(env.guild, member, null, [], (res) => { myMatchesReply = res; });
    assert.ok(myMatchesReply);
  });

  test('12. Full end-to-end interaction handling: button routing, modals, room modal, winner modal & dispute modal', async () => {
    const env = createMockArenaEnvironment();
    const admin = env.addMember('admin-1', 'AdminUser', { isAdmin: true });
    await handleArenaCommand(env.guild, admin, null, ['setup'], () => {});

    const playerA = env.addMember('pA', 'AlphaPlayer');
    const playerB = env.addMember('pB', 'BravoPlayer');
    const volunteer = env.addMember('vol-1', 'VolunteerOne');

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

  test('13. Volunteer Profile: First-time creation and updating on accepting subsequent match without path conflicts', async () => {
    const env = createMockArenaEnvironment();
    const admin = env.addMember('admin-1', 'AdminUser', { isAdmin: true });
    await handleArenaCommand(env.guild, admin, null, ['setup'], () => {});

    // Create Match 1
    const p1 = env.addMember('p1', 'PlayerOne');
    const p2 = env.addMember('p2', 'PlayerTwo');
    await upsertArenaPlayer('p1', { displayName: 'PlayerOne', bgmiIgn: 'Ign1', bgmiUid: '1111' });
    await upsertArenaPlayer('p2', { displayName: 'PlayerTwo', bgmiIgn: 'Ign2', bgmiUid: '2222' });

    const c1 = await handleCreateChallenge(env.guild, p1);
    const m1 = await handleAcceptChallenge(env.guild, p2, c1.challenge.challengeId, env.client);
    const matchId1 = m1.match.matchId;

    // --- CASE 1: First-time volunteer profile creation ---
    const volMember = env.addMember('vol-fresh', 'InitialVolunteerName');
    const claimRes1 = await handleClaimMatch(env.guild, volMember, matchId1);
    assert.equal(claimRes1.ok, true, `First-time claim should succeed: ${claimRes1.error}`);
    assert.equal(claimRes1.match.volunteerId, 'vol-fresh');

    const createdVol = await getArenaVolunteer('vol-fresh');
    assert.ok(createdVol, 'Volunteer profile should exist in DB');
    assert.equal(createdVol.displayName, 'InitialVolunteerName');
    assert.equal(createdVol.activeMatches, 1);
    assert.equal(createdVol.status, 'AVAILABLE');
    assert.equal(createdVol.suspended, false);

    // Move to RESULT_PENDING and complete Match 1 to update stats
    const { updateArenaMatch } = await import('../bot/discord/features/arena/models/arenaModels.js');
    await updateArenaMatch(matchId1, { status: ARENA_STATUS.RESULT_PENDING });
    const match1 = await getArenaMatch(matchId1);
    const completeRes = await completeArenaMatch(env.guild, match1, { winnerId: 'p1' });
    assert.equal(completeRes.ok, true);
    const volAfterCompletion = await getArenaVolunteer('vol-fresh');
    assert.equal(volAfterCompletion.activeMatches, 0);
    assert.equal(volAfterCompletion.completedMatches, 1);
    assert.equal(volAfterCompletion.totalMatches, 1);

    // Create Match 2
    const p3 = env.addMember('p3', 'PlayerThree');
    const p4 = env.addMember('p4', 'PlayerFour');
    await upsertArenaPlayer('p3', { displayName: 'PlayerThree', bgmiIgn: 'Ign3', bgmiUid: '3333' });
    await upsertArenaPlayer('p4', { displayName: 'PlayerFour', bgmiIgn: 'Ign4', bgmiUid: '4444' });

    const c2 = await handleCreateChallenge(env.guild, p3);
    const m2 = await handleAcceptChallenge(env.guild, p4, c2.challenge.challengeId, env.client);
    const matchId2 = m2.match.matchId;

    // --- CASE 2: Updating existing volunteer profile when member accepts another match with updated nickname ---
    volMember.displayName = 'BrandNewDisplayName';
    const claimRes2 = await handleClaimMatch(env.guild, volMember, matchId2);
    assert.equal(claimRes2.ok, true, `Existing volunteer claim should succeed without path conflict: ${claimRes2.error}`);
    assert.equal(claimRes2.match.volunteerId, 'vol-fresh');

    const updatedVol = await getArenaVolunteer('vol-fresh');
    assert.equal(updatedVol.displayName, 'BrandNewDisplayName', 'Display name should be updated to newest server nickname');
    assert.equal(updatedVol.activeMatches, 1, 'Active matches counter should now be 1');
    assert.equal(updatedVol.completedMatches, 1, 'Previous completed matches count must be preserved');
    assert.equal(updatedVol.totalMatches, 1, 'Previous total matches count must be preserved');
  });

  test('14. MongoDB Update Operator Safety: No overlapping keys between $set and $setOnInsert', async () => {
    // 1. Calling upsert with displayName explicitly sets it in $set and omits it from $setOnInsert
    const resWithDisplay = await upsertArenaVolunteer('test-op-1', { displayName: 'MyCustomName' });
    assert.equal(resWithDisplay.displayName, 'MyCustomName');
    assert.equal(resWithDisplay.status, 'AVAILABLE');

    // 2. Calling upsert without displayName puts default 'Volunteer' in $setOnInsert and omits it from $set
    const resWithoutDisplay = await upsertArenaVolunteer('test-op-2', {});
    assert.equal(resWithoutDisplay.displayName, 'Volunteer');

    // 3. Updating existing profile updates displayName without resetting default fields
    const resUpdated = await upsertArenaVolunteer('test-op-1', { displayName: 'ChangedName' });
    assert.equal(resUpdated.displayName, 'ChangedName');
    assert.equal(resUpdated.status, 'AVAILABLE');
  });

  test('15. Private Match Channel Permissions: Default read-only, temporary volunteer screenshot upload & 5m timeout', async () => {
    const env = createMockArenaEnvironment();
    const admin = env.addMember('admin-1', 'AdminUser', { isAdmin: true });
    await handleArenaCommand(env.guild, admin, null, ['setup'], () => {});

    const pA = env.addMember('pA', 'PlayerAlpha');
    const pB = env.addMember('pB', 'PlayerBravo');
    const vol = env.addMember('vol-perm', 'VolunteerPerm');

    await upsertArenaPlayer('pA', { displayName: 'PlayerAlpha', bgmiIgn: 'AlphaIgn', bgmiUid: '9101' });
    await upsertArenaPlayer('pB', { displayName: 'PlayerBravo', bgmiIgn: 'BravoIgn', bgmiUid: '9102' });

    // 1. Create Challenge & Accept
    const cRes = await handleCreateChallenge(env.guild, pA);
    const mRes = await handleAcceptChallenge(env.guild, pB, cRes.challenge.challengeId, env.client);
    const matchId = mRes.match.matchId;
    const matchChannel = mRes.matchChannel;

    // Check Player A & B default permissions: CANNOT send messages or attach files
    const pAOverwrites = matchChannel.permissionOverwrites.cache.get('pA');
    assert.ok(pAOverwrites);
    assert.ok(pAOverwrites.deny.includes(PermissionFlagsBits.SendMessages));
    assert.ok(pAOverwrites.deny.includes(PermissionFlagsBits.AttachFiles));
    assert.ok(pAOverwrites.allow.includes(PermissionFlagsBits.ViewChannel));

    const pBOverwrites = matchChannel.permissionOverwrites.cache.get('pB');
    assert.ok(pBOverwrites);
    assert.ok(pBOverwrites.deny.includes(PermissionFlagsBits.SendMessages));
    assert.ok(pBOverwrites.deny.includes(PermissionFlagsBits.AttachFiles));
    assert.ok(pBOverwrites.allow.includes(PermissionFlagsBits.ViewChannel));

    // 2. Volunteer claims match -> default permissions CANNOT send messages
    await handleClaimMatch(env.guild, vol, matchId);
    const volDefaultOverwrites = matchChannel.permissionOverwrites.cache.get('vol-perm');
    assert.ok(volDefaultOverwrites);
    assert.equal(volDefaultOverwrites.SendMessages, false);
    assert.equal(volDefaultOverwrites.AttachFiles, false);
    assert.equal(volDefaultOverwrites.ViewChannel, true);

    // 3. Move match to LIVE
    await submitRoomDetails(env.guild, vol, matchId, 'ROOM99', 'PASS99');
    await startMatch(env.guild, vol, matchId);

    // 4. Volunteer initiates winner submission -> gets TEMPORARY SendMessages & AttachFiles
    const initRes = await initiateWinnerSubmission(env.guild, vol, matchId, 'A');
    assert.equal(initRes.ok, true);

    const volTempOverwrites = matchChannel.permissionOverwrites.cache.get('vol-perm');
    assert.equal(volTempOverwrites.SendMessages, true, 'Volunteer should be granted SendMessages temporarily');
    assert.equal(volTempOverwrites.AttachFiles, true, 'Volunteer should be granted AttachFiles temporarily');

    // 5. Volunteer uploads screenshot -> permissions IMMEDIATELY revoked & evidence copied
    const { processWinnerScreenshot } = await import('../bot/discord/features/arena/services/arenaMatchService.js');
    const liveMatch = await getArenaMatch(matchId);
    await processWinnerScreenshot(env.guild, liveMatch, vol, 'https://cdn.discordapp.com/arena-proof.png');

    const volRevokedOverwrites = matchChannel.permissionOverwrites.cache.get('vol-perm');
    assert.equal(volRevokedOverwrites.SendMessages, false, 'Volunteer SendMessages should be revoked immediately after upload');
    assert.equal(volRevokedOverwrites.AttachFiles, false, 'Volunteer AttachFiles should be revoked immediately after upload');

    const config = await getArenaConfig(env.guild.id);
    const evidenceChannel = env.channels.get(config.evidenceChannelId);
    assert.ok(evidenceChannel.messages.cache.size > 0, 'Evidence screenshot must be copied to #arena-evidence');

    // 6. Test 5-minute timeout flow on a second match with another volunteer
    const pC = env.addMember('pC', 'PlayerCharlie');
    const pD = env.addMember('pD', 'PlayerDelta');
    const vol2 = env.addMember('vol-2', 'VolunteerTwo');
    await upsertArenaPlayer('pC', { displayName: 'PlayerCharlie', bgmiIgn: 'CharlieIgn', bgmiUid: '9103' });
    await upsertArenaPlayer('pD', { displayName: 'PlayerDelta', bgmiIgn: 'DeltaIgn', bgmiUid: '9104' });

    const c2 = await handleCreateChallenge(env.guild, pC);
    const m2 = await handleAcceptChallenge(env.guild, pD, c2.challenge.challengeId, env.client);
    const mId2 = m2.match.matchId;
    const ch2 = m2.matchChannel;

    const claim2 = await handleClaimMatch(env.guild, vol2, mId2);
    assert.equal(claim2.ok, true);
    await submitRoomDetails(env.guild, vol2, mId2, 'R2', 'P2');
    await startMatch(env.guild, vol2, mId2);

    await initiateWinnerSubmission(env.guild, vol2, mId2, 'B');
    assert.equal(ch2.permissionOverwrites.cache.get('vol-2').SendMessages, true);

    // Fast forward / trigger timeout
    const { handleScreenshotTimeout } = await import('../bot/discord/features/arena/services/arenaMatchService.js');
    await handleScreenshotTimeout(env.guild, mId2, 'vol-2');

    assert.equal(ch2.permissionOverwrites.cache.get('vol-2').SendMessages, false, 'Timeout must revoke SendMessages');
    assert.equal(ch2.permissionOverwrites.cache.get('vol-2').AttachFiles, false, 'Timeout must revoke AttachFiles');

    const timedOutMatch = await getArenaMatch(mId2);
    assert.equal(timedOutMatch.pendingWinnerId, null, 'Timeout should clear pendingWinnerId to allow retry');
  });

  test('16. Dynamic Image-Based Match Cards & Challenge Cards: PNG generation, visual layout & button integration', async () => {
    const {
      generateMatchCardPng,
      generateChallengeCardPng,
      encodePngRgba,
    } = await import('../bot/discord/features/arena/services/arenaImageService.js');
    const {
      buildMatchChannelEmbed,
      buildChallengeEmbed,
    } = await import('../bot/discord/features/arena/services/arenaNotificationService.js');

    const sampleMatch = {
      matchId: 'MD-10001',
      status: ARENA_STATUS.LIVE,
      playerA: { discordId: 'pA', displayName: 'AlphaPro', bgmiIgn: 'AlphaKing', bgmiUid: '1111' },
      playerB: { discordId: 'pB', displayName: 'BravoElite', bgmiIgn: 'BravoGod', bgmiUid: '2222' },
      volunteerId: 'vol-1',
      roomId: 'SECRET_ROOM_ID',
      roomPassword: 'SECRET_PASSWORD',
    };

    // 1. Generate Match Card PNG
    const matchPng = generateMatchCardPng(sampleMatch, { volunteerDisplayName: 'OfficialVol' });
    assert.ok(Buffer.isBuffer(matchPng));
    // Verify standard PNG signature
    assert.equal(matchPng[0], 0x89);
    assert.equal(matchPng[1], 0x50); // P
    assert.equal(matchPng[2], 0x4e); // N
    assert.equal(matchPng[3], 0x47); // G
    // Verify width 800, height 420 in IHDR chunk
    assert.equal(matchPng.readUInt32BE(16), 800, 'Match card width should be 800');
    assert.equal(matchPng.readUInt32BE(20), 420, 'Match card height should be 420');

    // 2. Build Match Channel Payload
    const matchPayload = await buildMatchChannelEmbed(sampleMatch, 'OfficialVol');
    assert.ok(matchPayload.files && matchPayload.files.length === 1, 'Match payload must include the generated image card as a file attachment');
    assert.equal(matchPayload.files[0].name, 'match-md-10001.png');
    assert.ok(matchPayload.embeds && matchPayload.embeds.length === 1);
    assert.equal(matchPayload.embeds[0].data.image.url, 'attachment://match-md-10001.png');

    // Verify live buttons (Submit Winner)
    assert.ok(matchPayload.components.length > 0);
    const buttonRow = matchPayload.components[0];
    const customIds = buttonRow.components.map((c) => c.data.custom_id);
    assert.ok(customIds.includes('arena:submit_winner:MD-10001'));

    // 3. Challenge Card PNG (OPEN)
    const sampleChallenge = {
      challengeId: 'MD-10001',
      creatorId: 'pA',
      status: ARENA_STATUS.OPEN,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 600000),
    };
    const challengeOpenPayload = await buildChallengeEmbed(sampleChallenge, 'AlphaPro', { creatorIgn: 'AlphaKing' });
    assert.ok(challengeOpenPayload.files && challengeOpenPayload.files.length === 1);
    assert.equal(challengeOpenPayload.files[0].name, 'challenge-md-10001.png');
    assert.equal(challengeOpenPayload.components.length, 1, 'OPEN challenge must have action buttons');
    const challengeBtnIds = challengeOpenPayload.components[0].components.map((c) => c.data.custom_id);
    assert.ok(challengeBtnIds.includes('arena:accept_challenge:MD-10001'));
    assert.ok(challengeBtnIds.includes('arena:cancel_challenge:MD-10001'));

    // 4. Challenge Card PNG (ACCEPTED) -> updates image and removes buttons
    const acceptedChallenge = { ...sampleChallenge, status: ARENA_STATUS.WAITING_FOR_VOLUNTEER };
    const acceptedPayload = await buildChallengeEmbed(acceptedChallenge, 'AlphaPro', {
      creatorIgn: 'AlphaKing',
      acceptedOpponent: { discordId: 'pB', displayName: 'BravoElite', bgmiIgn: 'BravoGod' },
    });
    assert.ok(acceptedPayload.files && acceptedPayload.files.length === 1);
    assert.equal(acceptedPayload.components.length, 0, 'ACCEPTED challenge must not have action buttons');

    // 5. Challenge Card PNG (CANCELLED / EXPIRED) -> removes buttons
    const cancelledChallenge = { ...sampleChallenge, status: ARENA_STATUS.CANCELLED };
    const cancelledPayload = await buildChallengeEmbed(cancelledChallenge, 'AlphaPro');
    assert.equal(cancelledPayload.components.length, 0, 'CANCELLED challenge must not have buttons');

    // 6. Test with a custom 32x32 PNG avatar to verify circular avatar blending
    const dummyAvatarRgba = Buffer.alloc(32 * 32 * 4, 180);
    const dummyAvatarPng = encodePngRgba(32, 32, dummyAvatarRgba);
    const avatarsMap = new Map([['pA', dummyAvatarPng]]);
    const matchWithAvatarPng = generateMatchCardPng(sampleMatch, { avatars: avatarsMap });
    assert.ok(Buffer.isBuffer(matchWithAvatarPng));
    assert.equal(matchWithAvatarPng[0], 0x89);
  });

  test('17. Hindi BGMI IGN, UID Display, Discord Avatar Integration & Volunteer Panel Image Cards', async () => {
    const {
      generateMatchCardPng,
      generateChallengeCardPng,
      fetchMatchAvatars,
      fetchChallengeAvatars,
    } = await import('../bot/discord/features/arena/services/arenaImageService.js');
    const {
      buildVolunteerPanelEmbed,
      buildMatchChannelEmbed,
    } = await import('../bot/discord/features/arena/services/arenaNotificationService.js');

    // 1. Match with Hindi / Devanagari characters and UIDs
    const hindiMatch = {
      matchId: 'MD-20002',
      status: ARENA_STATUS.WAITING_FOR_VOLUNTEER,
      playerA: {
        discordId: 'kokaine-id',
        displayName: 'KOKAINE',
        bgmiIgn: 'ताजKOKAINE',
        bgmiUid: '51306576278',
      },
      playerB: {
        discordId: 'shanaya-id',
        displayName: 'IGxShanaya',
        bgmiIgn: 'ताजJESPERR',
        bgmiUid: '51306576265',
      },
      volunteerId: null,
    };

    // 2. Generate PNG with Hindi characters & verify standard PNG headers
    const hindiCardPng = generateMatchCardPng(hindiMatch);
    assert.ok(Buffer.isBuffer(hindiCardPng));
    assert.equal(hindiCardPng[0], 0x89);
    assert.equal(hindiCardPng.readUInt32BE(16), 800);
    assert.equal(hindiCardPng.readUInt32BE(20), 420);

    // 3. Test with mock Discord avatars (Buffer & base64)
    // 2x2 red pixel PNG
    const mockAvatarBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVQIW2P8z8Dwn4GBgYGBgQEABYIBAB3k6jUAAAAASUVORK5CYII=', 'base64');
    const avatarsMap = new Map([
      ['kokaine-id', mockAvatarBuffer],
      ['shanaya-id', mockAvatarBuffer],
    ]);

    const cardWithAvatarsPng = generateMatchCardPng(hindiMatch, { avatars: avatarsMap });
    assert.ok(Buffer.isBuffer(cardWithAvatarsPng));
    assert.equal(cardWithAvatarsPng[0], 0x89);

    // 4. Verify #volunteer-panel message payload structure
    const volPayloadWaiting = await buildVolunteerPanelEmbed(hindiMatch, null, { avatars: avatarsMap });
    assert.ok(volPayloadWaiting.files && volPayloadWaiting.files.length === 1, 'Volunteer panel must include image file attachment');
    assert.equal(volPayloadWaiting.files[0].name, 'match-md-20002.png');
    assert.ok(volPayloadWaiting.embeds && volPayloadWaiting.embeds.length === 1, 'Volunteer panel must include embed');
    assert.equal(volPayloadWaiting.embeds[0].data.image.url, 'attachment://match-md-20002.png');
    assert.equal(volPayloadWaiting.components.length, 1, 'Waiting match must have Accept Match button');
    assert.equal(volPayloadWaiting.components[0].components[0].data.custom_id, 'arena:claim_match:MD-20002');
    assert.equal(volPayloadWaiting.components[0].components[0].data.label, 'Accept Match');

    // 5. When claimed, button is removed while visual layout is preserved
    const claimedMatch = {
      ...hindiMatch,
      status: ARENA_STATUS.VOLUNTEER_ASSIGNED,
      volunteerId: 'vol-user-123',
    };
    const volPayloadClaimed = await buildVolunteerPanelEmbed(claimedMatch, 'OfficialVol', { avatars: avatarsMap });
    assert.ok(volPayloadClaimed.files && volPayloadClaimed.files.length === 1);
    assert.equal(volPayloadClaimed.files[0].name, 'match-md-20002.png');
    assert.equal(volPayloadClaimed.embeds[0].data.image.url, 'attachment://match-md-20002.png');
    assert.equal(volPayloadClaimed.components.length, 0, 'Claimed match must not have Accept Match button');

    // 6. Test all status variations for footer layout integrity
    const statuses = [
      ARENA_STATUS.WAITING_FOR_VOLUNTEER,
      ARENA_STATUS.VOLUNTEER_ASSIGNED,
      ARENA_STATUS.ROOM_READY,
      ARENA_STATUS.LIVE,
      ARENA_STATUS.RESULT_PENDING,
      ARENA_STATUS.CONFIRMED,
      ARENA_STATUS.COMPLETED,
      ARENA_STATUS.UNDER_REVIEW,
      ARENA_STATUS.CANCELLED,
      ARENA_STATUS.EXPIRED,
    ];

    for (const status of statuses) {
      const testMatch = { ...hindiMatch, status, volunteerId: 'vol-user-123' };
      const png = generateMatchCardPng(testMatch, { volunteerDisplayName: 'VeryLongVolunteerDisplayNameOfficial', avatars: avatarsMap });
      assert.ok(Buffer.isBuffer(png));
      assert.equal(png[0], 0x89);
    }

    // 7. Test fetchMatchAvatars & fetchChallengeAvatars with mocked Discord client
    const mockClient = {
      users: {
        cache: new Map(),
        fetch: async (id) => ({
          id,
          displayAvatarURL: () => null,
        }),
      },
    };
    const fetchedMatchAvatars = await fetchMatchAvatars(mockClient, hindiMatch);
    assert.ok(fetchedMatchAvatars instanceof Map);

    const fetchedChallengeAvatars = await fetchChallengeAvatars(mockClient, { creatorId: 'kokaine-id' });
    assert.ok(fetchedChallengeAvatars instanceof Map);
  });

  test('18. Mongo-shaped Arena records hydrate complete challenge and match image cards before sending', async () => {
    const env = createMockArenaEnvironment();
    const { buildMatchChannelEmbed, buildChallengeEmbed } = await import('../bot/discord/features/arena/services/arenaNotificationService.js');
    const { encodePngRgba } = await import('../bot/discord/features/arena/services/arenaImageService.js');
    const playerA = env.addMember('111111111111111111', 'Discord Alpha');
    const playerB = env.addMember('222222222222222222', 'Discord Bravo');
    const volunteer = env.addMember('333333333333333333', 'Arena Official');
    const avatarRgba = Buffer.alloc(4 * 4 * 4, 255);
    const avatarUrl = `data:image/png;base64,${encodePngRgba(4, 4, avatarRgba).toString('base64')}`;
    for (const user of [playerA.user, playerB.user, volunteer.user]) {
      user.displayAvatarURL = () => avatarUrl;
      env.client.users.cache.set(user.id, user);
    }

    await upsertArenaPlayer(playerA.id, { displayName: 'Discord Alpha', bgmiIgn: 'ताजAlpha', bgmiUid: '51306576278' });
    await upsertArenaPlayer(playerB.id, { displayName: 'Discord Bravo', bgmiIgn: 'ताजBravo', bgmiUid: '51306576265' });
    const match = await createArenaMatch({
      matchId: 'MD-30001', guildId: env.guild.id, status: ARENA_STATUS.VOLUNTEER_ASSIGNED,
      volunteerId: volunteer.id, matchChannelId: 'private-match', panelMessageId: 'vol-panel',
      playerA: { discordId: playerA.id, displayName: playerA.displayName, bgmiIgn: 'ताजAlpha', bgmiUid: '51306576278' },
      playerB: { discordId: playerB.id, displayName: playerB.displayName, bgmiIgn: 'ताजBravo', bgmiUid: '51306576265' },
    });

    const previousDiagnostics = process.env.ARENA_IMAGE_DIAGNOSTICS;
    const originalInfo = console.info;
    const diagnosticLines = [];
    process.env.ARENA_IMAGE_DIAGNOSTICS = '1';
    console.info = (...args) => diagnosticLines.push(args.join(' '));
    try {
      const matchPayload = await buildMatchChannelEmbed(match, null, { guild: env.guild, client: env.client });
      assert.equal(matchPayload.embeds[0].data.image.url, 'attachment://match-md-30001.png');
      assert.equal(matchPayload.files[0].name, 'match-md-30001.png');
      const matchPng = matchPayload.files[0].attachment;
      assert.ok(Buffer.isBuffer(matchPng));
      assert.equal(matchPng.readUInt32BE(16), 800);
      assert.equal(matchPng.readUInt32BE(20), 420);
      assert.ok(matchPng.length > 1000, 'Rendered card contains more than an empty background');
      assert.ok(matchPayload.components[0].components.some((button) => button.data.custom_id === 'arena:submit_room:MD-30001'));

      const challenge = await createArenaChallenge({
        challengeId: 'MD-30002', guildId: env.guild.id, creatorId: playerA.id,
        status: ARENA_STATUS.OPEN, discordChannelId: 'available',
        expiresAt: new Date(Date.now() + 20 * 60 * 1000),
      });
      const challengePayload = await buildChallengeEmbed(challenge, null, { guild: env.guild, client: env.client });
      assert.equal(challengePayload.embeds[0].data.image.url, 'attachment://challenge-md-30002.png');
      assert.ok(Buffer.isBuffer(challengePayload.files[0].attachment));
      assert.equal(challengePayload.components[0].components.length, 2);

      const allDiagnostics = diagnosticLines.join('\n');
      assert.match(allDiagnostics, /MD-30001/);
      assert.match(allDiagnostics, /Discord Alpha/);
      assert.match(allDiagnostics, /Discord Bravo/);
      assert.match(allDiagnostics, /ताजAlpha/);
      assert.match(allDiagnostics, /ताजBravo/);
      assert.match(allDiagnostics, /51306576278/);
      assert.match(allDiagnostics, /51306576265/);
      assert.match(allDiagnostics, /Arena Official/);
      assert.match(allDiagnostics, /avatar/);
      assert.doesNotMatch(allDiagnostics, /SECRET_PASSWORD|roomPassword/);
    } finally {
      console.info = originalInfo;
      if (previousDiagnostics === undefined) delete process.env.ARENA_IMAGE_DIAGNOSTICS;
      else process.env.ARENA_IMAGE_DIAGNOSTICS = previousDiagnostics;
    }
  });
});
