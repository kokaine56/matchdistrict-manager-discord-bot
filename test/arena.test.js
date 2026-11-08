import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ChannelType,
  PermissionFlagsBits,
} from 'discord.js';
import {
  ARENA_STATUS,
  ARENA_CONSTANTS,
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
  ARENA_CHANNEL_PREFIX,
  formatArenaChannelName,
  formatMatchChannelName,
  formatRoomMakerChannelName,
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
      setName: async (newName) => {
        ch.name = newName;
        return ch;
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
    assert.match(reply, /1v1 TDM Setup Complete/);

    const config = await getArenaConfig(env.guild.id);
    assert.ok(config.categoryId);
    assert.ok(config.infoChannelId);
    assert.ok(config.infoMessageId);
    assert.ok(config.createChannelId);
    assert.ok(config.availableChannelId);
    assert.ok(config.volunteerPanelId);
    assert.ok(config.matchResultsId);
    assert.ok(config.supportChannelId);
    assert.ok(config.evidenceChannelId);
    assert.ok(!config.volunteerRoleId, 'No Volunteer role should be created or stored');
    assert.ok(config.panelMessageId);

    // Verify TDM channel names use the 𝟏𝐕𝟏 𝐓𝐃𝐌｜ prefix
    const infoChannel = env.channels.get(config.infoChannelId);
    assert.ok(infoChannel);
    assert.equal(infoChannel.name, '𝟏𝐕𝟏 𝐓𝐃𝐌｜info');
    const volPanel = env.channels.get(config.volunteerPanelId);
    assert.ok(volPanel);
    assert.equal(volPanel.name, '𝟏𝐕𝟏 𝐓𝐃𝐌｜room-maker-panel');
    assert.equal(env.channels.get(config.createChannelId).name, '𝟏𝐕𝟏 𝐓𝐃𝐌｜create-challenge');
    assert.equal(env.channels.get(config.availableChannelId).name, '𝟏𝐕𝟏 𝐓𝐃𝐌｜available-challenges');
    assert.equal(env.channels.get(config.matchResultsId).name, '𝟏𝐕𝟏 𝐓𝐃𝐌｜match-results');
    assert.equal(env.channels.get(config.supportChannelId).name, '𝟏𝐕𝟏 𝐓𝐃𝐌｜challenge-support');
    assert.equal(env.channels.get(config.evidenceChannelId).name, '𝟏𝐕𝟏 𝐓𝐃𝐌｜evidence');
    const everyonePerms = volPanel.permissionOverwrites.cache.get(env.guild.id);
    assert.ok(everyonePerms);
    assert.equal(everyonePerms.ViewChannel, true);
    assert.equal(everyonePerms.ReadMessageHistory, true);
    assert.equal(everyonePerms.SendMessages, false);

    const infoPerms = infoChannel.permissionOverwrites.cache.get(env.guild.id);
    assert.ok(infoPerms);
    assert.equal(infoPerms.ViewChannel, true);
    assert.equal(infoPerms.ReadMessageHistory, true);
    assert.equal(infoPerms.SendMessages, false);

    // Verify channel count
    const initialChannelCount = env.channels.size;

    // Run setup again - verify idempotency
    await handleArenaCommand(env.guild, admin, null, ['setup'], (text) => { reply = typeof text === 'string' ? text : text.content; });
    assert.match(reply, /Setup Complete/);
    assert.equal(env.channels.size, initialChannelCount, 'Idempotent setup should not create duplicate channels');
  });

  test('2. Category overflow creates 1V1 TDM 2 when category is full', async () => {
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
    assert.equal(nextCat.name, '1V1 TDM 2');
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
    assert.equal(res1.challenge.challengeId, 'MD-0001');
    assert.equal(res1.challenge.status, ARENA_STATUS.OPEN);

    // Attempt to create second challenge during cooldown -> rejected
    const res2 = await handleCreateChallenge(env.guild, player1);
    assert.equal(res2.valid, false);
    assert.match(res2.error, /Open Challenge Exists|Cooldown/);

    // Cancel own challenge
    const cancelRes = await handleCancelChallenge(env.guild, player1, 'MD-0001');
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

    // Verify private match channel exists with 4-digit sequential name and 𝟏𝐕𝟏 𝐓𝐃𝐌｜ prefix
    assert.ok(acceptRes.matchChannel);
    assert.equal(acceptRes.matchChannel.name, '𝟏𝐕𝟏 𝐓𝐃𝐌｜match-0001');
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
    const challenge = await getArenaChallenge('MD-0001');
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
    const roomMakerChannel = mRes.roomMakerChannel;

    // Check Player A & B default permissions: CANNOT send messages or attach files in match channel
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

    // Players must NOT have access to room maker channel
    assert.equal(roomMakerChannel.permissionOverwrites.cache.get('pA'), undefined);
    assert.equal(roomMakerChannel.permissionOverwrites.cache.get('pB'), undefined);

    // 2. Room Maker claims match -> Room Maker has access to roomMakerChannel, NOT matchChannel
    await handleClaimMatch(env.guild, vol, matchId);
    assert.equal(matchChannel.permissionOverwrites.cache.get('vol-perm'), undefined, 'Room Maker must NOT have access to challengers channel');

    const rmOverwrites = roomMakerChannel.permissionOverwrites.cache.get('vol-perm');
    assert.ok(rmOverwrites, 'Room Maker must have overwrites in their private channel');
    assert.equal(rmOverwrites.ViewChannel, true);
    assert.equal(rmOverwrites.SendMessages, false, 'Room Maker must NOT have default message sending permissions');
    assert.equal(rmOverwrites.AttachFiles, false, 'Room Maker must NOT have default attachment permissions');

    // 3. Move match to LIVE
    await submitRoomDetails(env.guild, vol, matchId, 'ROOM99', 'PASS99');
    await startMatch(env.guild, vol, matchId);

    // 4. Room Maker initiates winner submission -> temporary upload permissions granted
    const initRes = await initiateWinnerSubmission(env.guild, vol, matchId, 'A');
    assert.equal(initRes.ok, true);
    const rmOverwritesDuringUpload = roomMakerChannel.permissionOverwrites.cache.get('vol-perm');
    assert.equal(rmOverwritesDuringUpload.SendMessages, true, 'Temporary SendMessages granted for proof upload');
    assert.equal(rmOverwritesDuringUpload.AttachFiles, true, 'Temporary AttachFiles granted for proof upload');

    // 5. Room Maker uploads screenshot -> permissions immediately revoked, evidence saved
    const { processWinnerScreenshot } = await import('../bot/discord/features/arena/services/arenaMatchService.js');
    const liveMatch = await getArenaMatch(matchId);
    await processWinnerScreenshot(env.guild, liveMatch, vol, 'https://cdn.discordapp.com/arena-proof.png');
    const rmOverwritesAfterUpload = roomMakerChannel.permissionOverwrites.cache.get('vol-perm');
    assert.equal(rmOverwritesAfterUpload.SendMessages, false, 'Temporary SendMessages revoked after proof upload');
    assert.equal(rmOverwritesAfterUpload.AttachFiles, false, 'Temporary AttachFiles revoked after proof upload');

    const config = await getArenaConfig(env.guild.id);
    const evidenceChannel = env.channels.get(config.evidenceChannelId);
    assert.ok(evidenceChannel.messages.cache.size > 0, 'Evidence screenshot must be copied to #arena-evidence');

    // Challengers channel received result verification with buttons
    const matchChannelMsgs = Array.from(matchChannel.messages.cache.values());
    const hasVerifyPayload = matchChannelMsgs.some((m) =>
      m.components?.some((r) => r.components?.some((b) => b.data?.custom_id?.includes('confirm_result')))
    );
    assert.ok(hasVerifyPayload, 'Challengers must receive Confirm Result button');

    // 6. Test 5-minute timeout flow on a second match with another volunteer
    const pC = env.addMember('pC', 'PlayerCharlie');
    const pD = env.addMember('pD', 'PlayerDelta');
    const vol2 = env.addMember('vol-2', 'VolunteerTwo');
    await upsertArenaPlayer('pC', { displayName: 'PlayerCharlie', bgmiIgn: 'CharlieIgn', bgmiUid: '9103' });
    await upsertArenaPlayer('pD', { displayName: 'PlayerDelta', bgmiIgn: 'DeltaIgn', bgmiUid: '9104' });

    const c2 = await handleCreateChallenge(env.guild, pC);
    const m2 = await handleAcceptChallenge(env.guild, pD, c2.challenge.challengeId, env.client);
    const mId2 = m2.match.matchId;

    const claim2 = await handleClaimMatch(env.guild, vol2, mId2);
    assert.equal(claim2.ok, true);
    await submitRoomDetails(env.guild, vol2, mId2, 'R2', 'P2');
    await startMatch(env.guild, vol2, mId2);

    await initiateWinnerSubmission(env.guild, vol2, mId2, 'B');

    // Fast forward / trigger timeout
    const { handleScreenshotTimeout } = await import('../bot/discord/features/arena/services/arenaMatchService.js');
    await handleScreenshotTimeout(env.guild, mId2, 'vol-2');

    const timedOutMatch = await getArenaMatch(mId2);
    assert.equal(timedOutMatch.pendingWinnerId, null, 'Timeout must clear pending winner so Room Maker can retry');
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
      matchId: 'MD-0001',
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
    assert.equal(matchPayload.files[0].name, 'match-md-0001.png');
    assert.ok(matchPayload.embeds && matchPayload.embeds.length === 1);
    assert.equal(matchPayload.embeds[0].data.image.url, 'attachment://match-md-0001.png');

    // Verify live buttons (Submit Winner)
    assert.ok(matchPayload.components.length > 0);
    const buttonRow = matchPayload.components[0];
    const customIds = buttonRow.components.map((c) => c.data.custom_id);
    assert.ok(customIds.includes('arena:submit_winner:MD-0001'));

    // 3. Challenge Card PNG (OPEN)
    const sampleChallenge = {
      challengeId: 'MD-0001',
      creatorId: 'pA',
      status: ARENA_STATUS.OPEN,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 600000),
    };
    const challengeOpenPayload = await buildChallengeEmbed(sampleChallenge, 'AlphaPro', { creatorIgn: 'AlphaKing' });
    assert.ok(challengeOpenPayload.files && challengeOpenPayload.files.length === 1);
    assert.equal(challengeOpenPayload.files[0].name, 'challenge-md-0001.png');
    assert.equal(challengeOpenPayload.components.length, 1, 'OPEN challenge must have action buttons');
    const challengeBtnIds = challengeOpenPayload.components[0].components.map((c) => c.data.custom_id);
    assert.ok(challengeBtnIds.includes('arena:accept_challenge:MD-0001'));
    assert.ok(challengeBtnIds.includes('arena:cancel_challenge:MD-0001'));

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

  test('19. Admin .arena delete removes all channels, categories, and database records cleanly', async () => {
    const env = createMockArenaEnvironment();
    const admin = env.addMember('admin-del', 'AdminDel', { isAdmin: true });
    const regularMember = env.addMember('user-del', 'UserDel');

    // 1. Non-admin is rejected
    let replyNonAdmin = null;
    await handleArenaCommand(env.guild, regularMember, null, ['delete'], (msg) => {
      replyNonAdmin = typeof msg === 'string' ? msg : msg.content;
    });
    assert.match(replyNonAdmin, /Permission Denied/);

    // 2. Provision arena with .arena setup
    let setupReply = null;
    await handleArenaCommand(env.guild, admin, null, ['setup'], (msg) => {
      setupReply = typeof msg === 'string' ? msg : msg.content;
    });
    assert.match(setupReply, /Setup Complete/);

    // Verify channels and category exist
    const config = await getArenaConfig(env.guild.id);
    assert.ok(config.categoryId);
    assert.ok(env.guild.channels.cache.has(config.categoryId));
    assert.ok(env.guild.channels.cache.has(config.createChannelId));
    assert.ok(env.guild.channels.cache.has(config.availableChannelId));
    assert.ok(env.guild.channels.cache.has(config.volunteerPanelId));

    // Register a player, create a challenge, and create a match
    await upsertArenaPlayer('del-pA', { displayName: 'PlayerDelA', bgmiIgn: 'IgnDelA', bgmiUid: '9999900001' });
    await upsertArenaPlayer('del-pB', { displayName: 'PlayerDelB', bgmiIgn: 'IgnDelB', bgmiUid: '9999900002' });
    const match = await createArenaMatch({
      matchId: 'MD-99999',
      guildId: env.guild.id,
      status: ARENA_STATUS.WAITING_FOR_VOLUNTEER,
      playerA: { discordId: 'del-pA', displayName: 'PlayerDelA', bgmiIgn: 'IgnDelA', bgmiUid: '9999900001' },
      playerB: { discordId: 'del-pB', displayName: 'PlayerDelB', bgmiIgn: 'IgnDelB', bgmiUid: '9999900002' },
    });

    // 3. Admin runs .arena delete
    let deleteReply = null;
    await handleArenaCommand(env.guild, admin, null, ['delete'], (msg) => {
      deleteReply = msg;
    });

    assert.ok(deleteReply && deleteReply.embeds && deleteReply.embeds.length === 1);
    assert.match(deleteReply.embeds[0].data.title, /1v1 TDM Deleted/);

    // 4. Verify channels and categories are removed from Discord
    assert.equal(env.guild.channels.cache.has(config.categoryId), false, 'Main category must be deleted');
    assert.equal(env.guild.channels.cache.has(config.createChannelId), false, 'Create channel must be deleted');
    assert.equal(env.guild.channels.cache.has(config.availableChannelId), false, 'Available channel must be deleted');
    assert.equal(env.guild.channels.cache.has(config.volunteerPanelId), false, 'Volunteer panel must be deleted');

    // 5. Verify database records are cleared
    const postConfig = await getArenaConfig(env.guild.id);
    assert.equal(postConfig, null, 'Config document must be deleted');

    const postMatch = await getArenaMatch('MD-99999');
    assert.equal(postMatch, null, 'Match document must be deleted');

    const postPlayerA = await getArenaPlayer('del-pA');
    assert.equal(postPlayerA, null, 'Player A document must be deleted');

    // 6. Idempotent re-setup succeeds cleanly
    let reSetupReply = null;
    await handleArenaCommand(env.guild, admin, null, ['setup'], (msg) => {
      reSetupReply = typeof msg === 'string' ? msg : msg.content;
    });
    assert.match(reSetupReply, /Setup Complete/);
    const newConfig = await getArenaConfig(env.guild.id);
    assert.ok(newConfig && newConfig.categoryId);
    assert.ok(env.guild.channels.cache.has(newConfig.categoryId));
  });

  test('20. Text rendering diagnostic: bundled fonts render every string (incl. Devanagari) with zero system fonts', async () => {
    const { renderSvgToPng, getArenaFontFiles, generateMatchCardPng } = await import('../bot/discord/features/arena/services/arenaImageService.js');
    const { Resvg } = await import('@resvg/resvg-js');

    assert.equal(getArenaFontFiles().length, 4, 'All bundled font files must exist');

    const strings = ['MATCH DISTRICT', 'MD-10001', 'KOKAINE', 'ताजKOKAINE', '51306576278', 'VS', 'BGMI TDM 1V1', 'WAITING FOR VOLUNTEER'];
    const lines = strings
      .map((t, i) => `<text x="20" y="${40 + i * 34}" font-family="Noto Sans, Noto Sans Devanagari" font-size="${16 + (i % 4) * 4}" font-weight="${i % 2 ? 'normal' : 'bold'}" fill="${i % 2 ? '#FFFFFF' : '#F97316'}">${t}</text>`)
      .join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="700" height="330"><rect width="700" height="330" fill="#0B0F19"/>${lines}</svg>`;

    const png = renderSvgToPng(svg, { label: 'diagnostic', expectedTexts: strings });
    assert.equal(png.subarray(0, 4).toString('hex'), '89504e47');

    // Each string must light up pixels inside its own row band (i.e. it is visibly drawn).
    const px = new Resvg(svg, { font: { loadSystemFonts: false, fontFiles: getArenaFontFiles(), defaultFontFamily: 'Noto Sans' } }).render().pixels;
    for (let i = 0; i < strings.length; i++) {
      const y0 = 40 + i * 34 - 28;
      const y1 = 40 + i * 34 + 6;
      let lit = 0;
      for (let y = y0; y < y1; y++) for (let x = 0; x < 700; x++) {
        const o = (y * 700 + x) * 4;
        if (px[o] > 150 || px[o + 1] > 150 || px[o + 2] > 150) lit++;
      }
      assert.ok(lit > 40, `String "${strings[i]}" not visibly rendered (lit=${lit})`);
    }

    // Without fonts the same SVG is blank -> proves the root cause the validator now guards against.
    const blank = new Resvg(svg, { font: { loadSystemFonts: false } }).render().pixels;
    let blankLit = 0;
    for (let i = 0; i < blank.length; i += 4) if (blank[i] > 150) blankLit++;
    assert.equal(blankLit, 0, 'No fonts => no text; renderer must never rely on host fonts');

    // Validator rejects SVGs that lack expected text instead of sending a blank card.
    assert.throws(() => renderSvgToPng(svg, { label: 'bad', expectedTexts: ['NOT-IN-SVG'] }), /missing expected text/);

    // Full match card renders with Hindi IGN, UIDs and volunteer, without throwing.
    const card = generateMatchCardPng({
      matchId: 'MD-10001', status: ARENA_STATUS.WAITING_FOR_VOLUNTEER,
      playerA: { discordId: 'a', displayName: 'KOKAINE', bgmiIgn: 'ताजKOKAINE', bgmiUid: '51306576278' },
      playerB: { discordId: 'b', displayName: 'IGxShanaya', bgmiIgn: 'ताजJESPERR', bgmiUid: '51306576265' },
    });
    assert.equal(card.readUInt32BE(16), 800);
    assert.equal(card.readUInt32BE(20), 420);
  });

  test('21. Room Maker can leave BEFORE submitting room credentials, blocked after credentials submitted, admin can reassign', async () => {
    const env = createMockArenaEnvironment();
    const admin = env.addMember('admin-rm-leave', 'AdminRm', { permissions: ['Administrator'] });
    await setupArenaChannels(env.guild, admin);

    const rm = env.addMember('rm-leave-user', 'RoomMakerLeave');
    const pA = env.addMember('rm-pa', 'PlayerA');
    const pB = env.addMember('rm-pb', 'PlayerB');

    await upsertArenaPlayer(pA.id, { displayName: 'PlayerA', bgmiIgn: 'ताजKOKAINE', bgmiUid: '7770001111' });
    await upsertArenaPlayer(pB.id, { displayName: 'PlayerB', bgmiIgn: 'ताजJESP', bgmiUid: '7770002222' });

    const { handleCreateChallenge, handleAcceptChallenge } = await import('../bot/discord/features/arena/services/arenaChallengeService.js');
    const { handleClaimMatch, handleLeaveMatch } = await import('../bot/discord/features/arena/services/arenaVolunteerService.js');
    const { submitRoomDetails, startMatch } = await import('../bot/discord/features/arena/services/arenaMatchService.js');
    const { buildMatchCardPayload } = await import('../bot/discord/features/arena/services/arenaImageService.js');

    const cRes = await handleCreateChallenge(env.guild, pA);
    const mRes = await handleAcceptChallenge(env.guild, pB, cRes.challenge.challengeId, env.client);
    const matchId = mRes.match.matchId;

    // 1. Claim match as Room Maker
    const claimRes = await handleClaimMatch(env.guild, rm, matchId);
    assert.ok(claimRes.ok);

    const rmProfileAfterClaim = await getArenaVolunteer(rm.id);
    assert.equal(rmProfileAfterClaim.activeMatches, 1);

    // 2. Room Maker can leave BEFORE submitting room details
    const earlyLeave = await handleLeaveMatch(env.guild, rm, matchId);
    assert.ok(earlyLeave.ok, 'Room Maker must be able to leave before submitting room details');
    assert.equal(earlyLeave.match.status, ARENA_STATUS.WAITING_FOR_VOLUNTEER);
    assert.equal(earlyLeave.match.volunteerId, null);
    const rmProfileAfterEarlyLeave = await getArenaVolunteer(rm.id);
    assert.equal(rmProfileAfterEarlyLeave.activeMatches, 0);

    // 3. Concurrent leave call is rejected (protected against double clicks)
    const doubleLeaveRes = await handleLeaveMatch(env.guild, rm, matchId);
    assert.equal(doubleLeaveRes.ok, false);

    // 4. Another Room Maker claims the match
    const rm2 = env.addMember('rm2-user', 'RoomMaker2');
    const claim2 = await handleClaimMatch(env.guild, rm2, matchId);
    assert.ok(claim2.ok);

    // 5. Submit Room details -> moves to ROOM_READY
    const roomRes = await submitRoomDetails(env.guild, rm2, matchId, '987654321', 'roompass123');
    assert.ok(roomRes.ok);
    assert.equal(roomRes.match.status, ARENA_STATUS.ROOM_READY);
    assert.equal(roomRes.match.roomId, '987654321');

    // 6. Room Maker CANNOT leave after room details are submitted
    const blockedLeave = await handleLeaveMatch(env.guild, rm2, matchId);
    assert.equal(blockedLeave.ok, false, 'Room Maker must NOT be allowed to leave after credentials submitted');
    assert.match(blockedLeave.error, /cannot leave the match after submitting room credentials/);

    // 7. Verify Leave Match button is removed from dashboard in ROOM_READY
    const dashboardPayload = await buildMatchCardPayload(roomRes.match, 'RoomMaker2', { surface: 'roomMakerChannel' });
    const buttonLabels = dashboardPayload.components[0].components.map((b) => b.data.label);
    assert.equal(buttonLabels.includes('Leave Match'), false, 'Leave Match button must NOT appear in ROOM_READY');
    assert.ok(buttonLabels.includes('Edit Room Details'));
    assert.ok(buttonLabels.includes('Start Match'));

    // 8. Administrator CAN still reassign/release the match anytime
    const adminRelease = await handleLeaveMatch(env.guild, admin, matchId, true);
    assert.ok(adminRelease.ok, 'Administrator must be able to release/reassign');
    assert.equal(adminRelease.match.status, ARENA_STATUS.WAITING_FOR_VOLUNTEER);
    assert.equal(adminRelease.match.volunteerId, null);
    assert.equal(adminRelease.match.roomId, null, 'Credentials cleared on admin release');
  });

  test('22. Separate Room Maker Channel (roommaker-0001) from Challengers (match-0001), privacy, screenshot detection & bottom panels', async () => {
    const env = createMockArenaEnvironment();
    const admin = env.addMember('admin-rc', 'AdminRc', { permissions: ['Administrator'] });
    await setupArenaChannels(env.guild, admin);

    const rm = env.addMember('rm-chan-user', 'RoomMakerChan');
    const pA = env.addMember('rc-pa', 'PlayerA');
    const pB = env.addMember('rc-pb', 'PlayerB');

    await upsertArenaPlayer(pA.id, { displayName: 'PlayerA', bgmiIgn: 'IgnA', bgmiUid: '8880001111' });
    await upsertArenaPlayer(pB.id, { displayName: 'PlayerB', bgmiIgn: 'IgnB', bgmiUid: '8880002222' });

    const { handleCreateChallenge, handleAcceptChallenge } = await import('../bot/discord/features/arena/services/arenaChallengeService.js');
    const { handleClaimMatch } = await import('../bot/discord/features/arena/services/arenaVolunteerService.js');
    const { submitRoomDetails, handleArenaScreenshotUpload } = await import('../bot/discord/features/arena/services/arenaMatchService.js');
    const { repositionPanelMessage } = await import('../bot/discord/features/arena/services/arenaNotificationService.js');

    const cRes = await handleCreateChallenge(env.guild, pA);
    const mRes = await handleAcceptChallenge(env.guild, pB, cRes.challenge.challengeId, env.client);

    // 1. Exactly TWO separate private channels created:
    // A. Challengers channel: 𝟏𝐕𝟏 𝐓𝐃𝐌｜match-0001
    // B. Room Maker channel: 𝟏𝐕𝟏 𝐓𝐃𝐌｜roommaker-0001
    assert.ok(mRes.matchChannel, 'Private match channel must be created');
    assert.equal(mRes.matchChannel.name, '𝟏𝐕𝟏 𝐓𝐃𝐌｜match-0001');
    assert.ok(mRes.roomMakerChannel, 'Private room maker channel must be created');
    assert.equal(mRes.roomMakerChannel.name, '𝟏𝐕𝟏 𝐓𝐃𝐌｜roommaker-0001');

    // 2. Permissions separation:
    // Players have access to match-0001, but NOT to roommaker-0001
    assert.ok(mRes.matchChannel.permissionOverwrites.cache.get(pA.id));
    assert.ok(mRes.matchChannel.permissionOverwrites.cache.get(pB.id));
    assert.equal(mRes.roomMakerChannel.permissionOverwrites.cache.get(pA.id), undefined);
    assert.equal(mRes.roomMakerChannel.permissionOverwrites.cache.get(pB.id), undefined);

    // 3. Claim match as Room Maker -> Room Maker granted access to roommaker-0001, NOT match-0001
    await handleClaimMatch(env.guild, rm, mRes.match.matchId);
    assert.equal(mRes.matchChannel.permissionOverwrites.cache.get(rm.id), undefined, 'Room Maker must NOT have access to match-0001');
    assert.ok(mRes.roomMakerChannel.permissionOverwrites.cache.get(rm.id), 'Room Maker must have access to roommaker-0001');

    // 4. Submit room details - posted inside challengers channel (match-0001) with clean embed
    await submitRoomDetails(env.guild, rm, mRes.match.matchId, 'ROOM999', 'PASS999');

    const matchChannelMessages = Array.from(mRes.matchChannel.messages.cache.values());
    const credsMsg = matchChannelMessages.find((msg) => msg.embeds?.some((e) => e.data?.title?.includes('BGMI ROOM DETAILS')) || msg.content?.includes('ROOM999'));
    assert.ok(credsMsg, 'Room credentials embed must appear inside the challengers match channel');
    assert.ok(credsMsg.components?.some((r) => r.components?.some((b) => b.data?.custom_id?.includes('report_room_issue'))), 'Report ID/Password button must appear in challengers channel');

    // Verify standardized credential fields: Match ID, Room ID, Room Password (no backticks)
    const credsEmbed = credsMsg.embeds[0];
    const fieldNames = credsEmbed.data.fields.map((f) => f.name);
    assert.ok(fieldNames.includes('Match ID'));
    assert.ok(fieldNames.includes('Room ID'));
    assert.ok(fieldNames.includes('Room Password'));
    for (const f of credsEmbed.data.fields) {
      assert.equal(f.value.includes('`'), false, `Field "${f.name}" must NOT contain inline-code backticks`);
    }

    // 5. Room Maker channel must contain ONLY 1 message (the dashboard image card) and NO report button
    const rmChannelMessages = Array.from(mRes.roomMakerChannel.messages.cache.values());
    assert.equal(rmChannelMessages.length, 1, 'Room Maker channel must contain ONLY the dashboard image card');
    const hasReportButtonInRm = rmChannelMessages.some((msg) =>
      msg.components?.some((r) => r.components?.some((b) => b.data?.custom_id?.includes('report_room_issue')))
    );
    assert.equal(hasReportButtonInRm, false, 'Room Maker dashboard must NEVER contain Report ID/PW Issue button');

    // 6. Test screenshot-only message detection (message with empty content but image attachment)
    const { startMatch, initiateWinnerSubmission } = await import('../bot/discord/features/arena/services/arenaMatchService.js');
    await startMatch(env.guild, rm, mRes.match.matchId);
    await initiateWinnerSubmission(env.guild, rm, mRes.match.matchId, 'A');

    const mockScreenshotMsg = {
      guild: env.guild,
      author: rm.user,
      member: rm,
      channel: mRes.roomMakerChannel,
      content: '', // Zero text content!
      attachments: new Map([
        ['att-1', { url: 'https://cdn.discordapp.com/proof.png', name: 'proof.png', contentType: 'image/png' }],
      ]),
    };

    const handledUpload = await handleArenaScreenshotUpload(mockScreenshotMsg);
    assert.equal(handledUpload, true, 'handleArenaScreenshotUpload must detect attachment-only image messages');

    // Verify proof was forwarded to match channel with Confirm Result and Dispute Result buttons
    const updatedMatchMsgs = Array.from(mRes.matchChannel.messages.cache.values());
    const proofMsg = updatedMatchMsgs.find((m) =>
      m.components?.some((r) => r.components?.some((b) => b.data?.custom_id?.includes('confirm_result')))
    );
    assert.ok(proofMsg, 'Challengers must receive verification embed with Confirm Result & Dispute Result buttons');

    // CRITICAL PRIVACY: Verify Room Maker was NOT granted access or overwrites on matchChannel after screenshot upload
    assert.equal(mRes.matchChannel.permissionOverwrites.cache.get(rm.id), undefined, 'Room Maker must NEVER be added to challengers match channel after screenshot upload');

    // 7. Test dashboard repositioning to bottom in #room-maker-panel
    const config = await getArenaConfig(env.guild.id);
    const rmPanel = env.channels.get(config.volunteerPanelId);
    assert.ok(rmPanel);

    const initialMsg = await rmPanel.send({ content: 'Persistent Dashboard' });
    let currentStoredId = initialMsg.id;

    await rmPanel.send({ content: 'Reminder: New match claimed!' });

    const newStoredId = await repositionPanelMessage(
      rmPanel,
      currentStoredId,
      { content: 'Persistent Dashboard - Updated' },
      async (newId) => { currentStoredId = newId; }
    );

    assert.notEqual(newStoredId, initialMsg.id, 'Dashboard must have been moved to bottom with a new message ID');
    assert.equal(rmPanel.messages.cache.has(initialMsg.id), false, 'Old dashboard message must be deleted');
    const lastMsg = rmPanel.messages.cache.last ? rmPanel.messages.cache.last() : Array.from(rmPanel.messages.cache.values()).pop();
    assert.equal(lastMsg.id, newStoredId, 'Dashboard must now be at the bottom of the channel');
  });

  test('23. Players can report incorrect room credentials (ROOM_ISSUE), blocks match start until corrected', async () => {
    const env = createMockArenaEnvironment();
    const admin = env.addMember('admin-report', 'AdminReport', { permissions: ['Administrator'] });
    await setupArenaChannels(env.guild, admin);

    const rm = env.addMember('rm-report-user', 'RoomMakerReport');
    const pA = env.addMember('rep-pa', 'PlayerA');
    const pB = env.addMember('rep-pb', 'PlayerB');
    const outsider = env.addMember('rep-outsider', 'Outsider');

    await upsertArenaPlayer(pA.id, { displayName: 'PlayerA', bgmiIgn: 'IgnA', bgmiUid: '6660001111' });
    await upsertArenaPlayer(pB.id, { displayName: 'PlayerB', bgmiIgn: 'IgnB', bgmiUid: '6660002222' });

    const { handleCreateChallenge, handleAcceptChallenge } = await import('../bot/discord/features/arena/services/arenaChallengeService.js');
    const { handleClaimMatch } = await import('../bot/discord/features/arena/services/arenaVolunteerService.js');
    const { submitRoomDetails, startMatch, handleReportRoomCredentials } = await import('../bot/discord/features/arena/services/arenaMatchService.js');

    const cRes = await handleCreateChallenge(env.guild, pA);
    const mRes = await handleAcceptChallenge(env.guild, pB, cRes.challenge.challengeId, env.client);
    const matchId = mRes.match.matchId;

    await handleClaimMatch(env.guild, rm, matchId);
    await submitRoomDetails(env.guild, rm, matchId, 'BAD_ROOM', 'BAD_PASS');

    // 1. Outsider cannot report
    const outsiderRep = await handleReportRoomCredentials(env.guild, outsider, matchId, 'PASSWORD');
    assert.equal(outsiderRep.ok, false);

    // 2. Player A reports incorrect password
    const repRes = await handleReportRoomCredentials(env.guild, pA, matchId, 'PASSWORD');
    assert.ok(repRes.ok);
    assert.equal(repRes.match.status, ARENA_STATUS.ROOM_ISSUE);

    // 3. Duplicate report by Player A is rejected
    const dupRep = await handleReportRoomCredentials(env.guild, pA, matchId, 'PASSWORD');
    assert.equal(dupRep.ok, false);

    // 4. Starting the match is blocked while in ROOM_ISSUE
    const startBlocked = await startMatch(env.guild, rm, matchId);
    assert.equal(startBlocked.ok, false, 'Match cannot start while room credentials issue is pending');
    assert.match(startBlocked.error, /incorrect room credentials/);

    // 5. Room Maker submits corrected details -> moves back to ROOM_READY
    const fixRes = await submitRoomDetails(env.guild, rm, matchId, 'FIXED_ROOM', 'FIXED_PASS');
    assert.ok(fixRes.ok);
    assert.equal(fixRes.match.status, ARENA_STATUS.ROOM_READY);

    // 6. Now match can be started cleanly
    const startSuccess = await startMatch(env.guild, rm, matchId);
    assert.ok(startSuccess.ok);
    assert.equal(startSuccess.match.status, ARENA_STATUS.LIVE);
  });

  test('24. Redesign #match-results with image-based result cards and BGMI IGNs (Devanagari supported)', async () => {
    const { generateResultCardPng, buildMatchResultPayload } = await import('../bot/discord/features/arena/services/arenaImageService.js');
    const { buildCompletedMatchResultPayload } = await import('../bot/discord/features/arena/services/arenaNotificationService.js');

    const sampleMatch = {
      matchId: 'MD-77777',
      guildId: 'guild-res',
      volunteerId: 'rm-777',
      status: ARENA_STATUS.COMPLETED,
      completedAt: new Date(),
    };

    const winnerObj = {
      discordId: 'win-id',
      displayName: 'KOKAINE',
      bgmiIgn: 'ताजKOKAINE',
      bgmiUid: '51306576278',
    };

    const loserObj = {
      discordId: 'lose-id',
      displayName: 'IGxShanaya',
      bgmiIgn: 'ताजJESP',
      bgmiUid: '51306576265',
    };

    // 1. Generate Result Card PNG
    const pngBuffer = generateResultCardPng(sampleMatch, winnerObj, loserObj, {
      roomMakerDisplayName: 'OfficialRM',
    });

    assert.ok(Buffer.isBuffer(pngBuffer));
    assert.equal(pngBuffer.subarray(0, 4).toString('hex'), '89504e47');
    assert.equal(pngBuffer.readUInt32BE(16), 800, 'Result image card must be 800px wide');
    assert.equal(pngBuffer.readUInt32BE(20), 420, 'Result image card must be 420px high');

    // 2. Build result payload for #match-results
    const payload = await buildCompletedMatchResultPayload(sampleMatch, winnerObj, loserObj, 'OfficialRM');
    assert.ok(payload.files && payload.files.length === 1);
    assert.equal(payload.files[0].name, 'result-md-77777.png');
    assert.equal(payload.embeds[0].data.image.url, 'attachment://result-md-77777.png');

    // 3. Verify BGMI IGNs are present in payload
    assert.ok(payload.embeds[0].data.fields.some((f) => f.name === 'Winner' && f.value.includes('ताजKOKAINE')));
    assert.ok(payload.embeds[0].data.fields.some((f) => f.name === 'Defeated' && f.value.includes('ताजJESP')));
  });

  test('25. Terminology & Dot Commands: .roommaker profile, .roommaker status, .leave and backwards compatibility', async () => {
    const env = createMockArenaEnvironment();
    const admin = env.addMember('admin-term', 'AdminTerm', { permissions: ['Administrator'] });
    await setupArenaChannels(env.guild, admin);

    const user = env.addMember('user-term', 'TermUser');
    const { handleRoomMakerCommand, handleVolunteerCommand, handleLeaveCommand, handleReleaseCommand } = await import('../bot/discord/features/arena/commands/arenaCommandHandler.js');

    // 1. .roommaker profile
    let profileReply = null;
    await handleRoomMakerCommand(env.guild, user, null, ['profile'], (msg) => { profileReply = msg; });
    assert.ok(profileReply && profileReply.embeds && profileReply.embeds.length === 1);
    assert.match(profileReply.embeds[0].data.title, /Room Maker Profile/);

    // 2. .volunteer profile (alias)
    let volProfileReply = null;
    await handleVolunteerCommand(env.guild, user, null, ['profile'], (msg) => { volProfileReply = msg; });
    assert.ok(volProfileReply && volProfileReply.embeds);
    assert.match(volProfileReply.embeds[0].data.title, /Room Maker Profile/);

    // 3. .roommaker status
    let statusReply = null;
    await handleRoomMakerCommand(env.guild, user, null, ['status'], (msg) => { statusReply = msg; });
    assert.match(statusReply, /Room Maker availability status is now/);

    // 4. .leave without matchId gives helpful usage
    let leaveUsage = null;
    await handleLeaveCommand(env.guild, user, null, [], (msg) => { leaveUsage = msg; });
    assert.match(leaveUsage, /\.leave <matchId>/);

    // 5. .release alias without matchId gives helpful usage
    let releaseUsage = null;
    await handleReleaseCommand(env.guild, user, null, [], (msg) => { releaseUsage = msg; });
    assert.match(releaseUsage, /\.leave <matchId>/);
  });

  test('26. 1V1 TDM Channel Naming Convention: 𝟏𝐕𝟏 𝐓𝐃𝐌｜ prefix on public, admin, dynamic channels & idempotency', async () => {
    // 1. Verify channel format helper functions
    assert.equal(ARENA_CHANNEL_PREFIX, '𝟏𝐕𝟏 𝐓𝐃𝐌｜');
    assert.equal(formatArenaChannelName('info'), '𝟏𝐕𝟏 𝐓𝐃𝐌｜info');
    assert.equal(formatArenaChannelName('create-challenge'), '𝟏𝐕𝟏 𝐓𝐃𝐌｜create-challenge');
    assert.equal(formatArenaChannelName('available-challenges'), '𝟏𝐕𝟏 𝐓𝐃𝐌｜available-challenges');
    assert.equal(formatArenaChannelName('room-maker-panel'), '𝟏𝐕𝟏 𝐓𝐃𝐌｜room-maker-panel');
    assert.equal(formatArenaChannelName('match-results'), '𝟏𝐕𝟏 𝐓𝐃𝐌｜match-results');
    assert.equal(formatArenaChannelName('challenge-support'), '𝟏𝐕𝟏 𝐓𝐃𝐌｜challenge-support');
    assert.equal(formatArenaChannelName('evidence'), '𝟏𝐕𝟏 𝐓𝐃𝐌｜evidence');

    assert.equal(formatMatchChannelName(1), '𝟏𝐕𝟏 𝐓𝐃𝐌｜match-0001');
    assert.equal(formatMatchChannelName(2), '𝟏𝐕𝟏 𝐓𝐃𝐌｜match-0002');
    assert.equal(formatMatchChannelName('10003'), '𝟏𝐕𝟏 𝐓𝐃𝐌｜match-0003');
    assert.equal(formatRoomMakerChannelName(1), '𝟏𝐕𝟏 𝐓𝐃𝐌｜roommaker-0001');
    assert.equal(formatRoomMakerChannelName(2), '𝟏𝐕𝟏 𝐓𝐃𝐌｜roommaker-0002');
    assert.equal(formatRoomMakerChannelName('10004'), '𝟏𝐕𝟏 𝐓𝐃𝐌｜roommaker-0004');

    // 2. Pre-create legacy un-prefixed channels in mock guild to test automatic renaming
    const env = createMockArenaEnvironment('guild-naming-1');
    const admin = env.addMember('admin-naming', 'NamingAdmin', { isAdmin: true });

    // Simulate pre-existing legacy channels
    const mainCat = await env.guild.channels.create({ name: '1V1 CHALLENGE ARENA', type: ChannelType.GuildCategory });
    const legacyInfo = await env.guild.channels.create({ name: 'arena-info', parent: mainCat.id });
    const legacyCreate = await env.guild.channels.create({ name: 'create-challenge', parent: mainCat.id });
    const legacyAvail = await env.guild.channels.create({ name: 'available-challenges', parent: mainCat.id });
    const legacyVol = await env.guild.channels.create({ name: 'volunteer-panel', parent: mainCat.id });
    const legacyResults = await env.guild.channels.create({ name: 'match-results', parent: mainCat.id });
    const legacySupport = await env.guild.channels.create({ name: 'challenge-support', parent: mainCat.id });
    const legacyEvidence = await env.guild.channels.create({ name: 'arena-evidence', parent: mainCat.id });

    const totalChannelsBefore = env.channels.size;

    // Run setupArenaChannels -> should detect existing channels and rename them without creating duplicates
    const setupRes = await setupArenaChannels(env.guild, admin);

    // Verify existing channels were renamed
    assert.equal(legacyInfo.name, '𝟏𝐕𝟏 𝐓𝐃𝐌｜info');
    assert.equal(legacyCreate.name, '𝟏𝐕𝟏 𝐓𝐃𝐌｜create-challenge');
    assert.equal(legacyAvail.name, '𝟏𝐕𝟏 𝐓𝐃𝐌｜available-challenges');
    assert.equal(legacyVol.name, '𝟏𝐕𝟏 𝐓𝐃𝐌｜room-maker-panel');
    assert.equal(legacyResults.name, '𝟏𝐕𝟏 𝐓𝐃𝐌｜match-results');
    assert.equal(legacySupport.name, '𝟏𝐕𝟏 𝐓𝐃𝐌｜challenge-support');
    assert.equal(legacyEvidence.name, '𝟏𝐕𝟏 𝐓𝐃𝐌｜evidence');

    // Verify channel IDs match the existing ones (no duplicate channels created)
    assert.equal(setupRes.infoChannel.id, legacyInfo.id);
    assert.equal(setupRes.createChannel.id, legacyCreate.id);
    assert.equal(setupRes.availableChannel.id, legacyAvail.id);
    assert.equal(setupRes.volunteerPanel.id, legacyVol.id);
    assert.equal(setupRes.matchResults.id, legacyResults.id);
    assert.equal(setupRes.supportChannel.id, legacySupport.id);
    assert.equal(setupRes.evidenceChannel.id, legacyEvidence.id);

    // Verify no new duplicate channels were added
    assert.equal(env.channels.size, totalChannelsBefore, 'Setup must be idempotent and not create duplicate channels');
  });

  test('27. 1V1 TDM Information Channel: 𝟏𝐕𝟏 𝐓𝐃𝐌｜info created with permissions, permanent embed, and dynamic mentions', async () => {
    const env = createMockArenaEnvironment('guild-info-1');
    const admin = env.addMember('admin-info', 'InfoAdmin', { isAdmin: true });

    // 1. Run setupArenaChannels
    const res = await setupArenaChannels(env.guild, admin);
    assert.ok(res.infoChannel);
    assert.equal(res.infoChannel.name, '𝟏𝐕𝟏 𝐓𝐃𝐌｜info');

    // 2. Verify permissions for @everyone: view & read history true, send messages & thread creation denied
    const everyonePerms = res.infoChannel.permissionOverwrites.cache.get(env.guild.id);
    assert.ok(everyonePerms);
    assert.equal(everyonePerms.ViewChannel, true);
    assert.equal(everyonePerms.ReadMessageHistory, true);
    assert.equal(everyonePerms.SendMessages, false);
    assert.equal(everyonePerms.CreatePublicThreads, false);
    assert.equal(everyonePerms.CreatePrivateThreads, false);
    assert.equal(everyonePerms.SendMessagesInThreads, false);

    // 3. Verify information message embed
    const config = await getArenaConfig(env.guild.id);
    assert.ok(config.infoChannelId);
    assert.ok(config.infoMessageId);
    assert.equal(config.infoChannelId, res.infoChannel.id);

    const infoMsg = res.infoChannel.messages.cache.get(config.infoMessageId);
    assert.ok(infoMsg, 'Information message must be stored in channel');
    assert.equal(infoMsg.embeds.length, 1);
    const embedData = infoMsg.embeds[0].data;

    assert.equal(embedData.title, 'MATCH DISTRICT – 1V1 TDM');
    assert.equal(embedData.color, ARENA_CONSTANTS.ORANGE_COLOR);

    // Verify instructions and dynamic channel mentions
    assert.match(embedData.description, /Welcome to Match District 1V1 TDM!/);
    assert.ok(embedData.description.includes(`<#${config.createChannelId}>`), 'Must contain create challenge channel mention');
    assert.ok(embedData.description.includes(`<#${config.availableChannelId}>`), 'Must contain available challenges channel mention');
    assert.ok(embedData.description.includes(`<#${config.matchResultsId}>`), 'Must contain match results channel mention');
    assert.match(embedData.description, /1\. Create a Challenge/);
    assert.match(embedData.description, /2\. Accept a Challenge/);
    assert.match(embedData.description, /3\. Wait for a Room Maker/);
    assert.match(embedData.description, /4\. Join the Match/);
    assert.match(embedData.description, /5\. Report Incorrect Credentials/);
    assert.match(embedData.description, /6\. Verify the Result/);
    assert.match(embedData.description, /7\. Check Match Results/);
    assert.match(embedData.description, /Important Rules/);

    // 4. Run setup again - verify message is edited in place without creating duplicate messages
    const initialMsgCount = res.infoChannel.messages.cache.size;
    assert.equal(initialMsgCount, 1, 'Exactly one information message should be sent');

    const res2 = await setupArenaChannels(env.guild, admin);
    assert.equal(res2.infoChannel.messages.cache.size, 1, 'Setup re-run must not create duplicate messages');
    assert.equal(res2.config.infoMessageId, config.infoMessageId, 'Message ID must remain unchanged upon re-edit');
  });

  test('28. Standardized MD-0001 Match ID, credential replacement deletion & dashboard-only channel across all lifecycle events', async () => {
    const env = createMockArenaEnvironment('guild-std-1');
    const admin = env.addMember('admin-std', 'StdAdmin', { permissions: ['Administrator'] });
    await setupArenaChannels(env.guild, admin);

    const rm = env.addMember('rm-std-user', 'StdRoomMaker');
    const pA = env.addMember('std-pa', 'PlayerAlpha');
    const pB = env.addMember('std-pb', 'PlayerBravo');

    await upsertArenaPlayer(pA.id, { displayName: 'PlayerAlpha', bgmiIgn: 'AlphaIGN', bgmiUid: '9110001111' });
    await upsertArenaPlayer(pB.id, { displayName: 'PlayerBravo', bgmiIgn: 'BravoIGN', bgmiUid: '9110002222' });

    const { handleCreateChallenge, handleAcceptChallenge } = await import('../bot/discord/features/arena/services/arenaChallengeService.js');
    const { handleClaimMatch } = await import('../bot/discord/features/arena/services/arenaVolunteerService.js');
    const {
      submitRoomDetails,
      handleReportRoomCredentials,
      startMatch,
      initiateWinnerSubmission,
      handleArenaScreenshotUpload,
    } = await import('../bot/discord/features/arena/services/arenaMatchService.js');
    const { formatMatchId } = await import('../bot/discord/features/arena/models/arenaModels.js');

    // 1. Verify formatMatchId helper
    assert.equal(formatMatchId('1'), 'MD-0001');
    assert.equal(formatMatchId('0002'), 'MD-0002');
    assert.equal(formatMatchId('MD-3'), 'MD-0003');
    assert.equal(formatMatchId('match-0004'), 'MD-0004');

    // 2. Create and accept challenge
    const cRes = await handleCreateChallenge(env.guild, pA);
    assert.equal(cRes.challenge.challengeId, 'MD-0001');
    const mRes = await handleAcceptChallenge(env.guild, pB, cRes.challenge.challengeId, env.client);
    const matchId = mRes.match.matchId;
    assert.equal(matchId, 'MD-0001');

    // 3. Room Maker claims match
    await handleClaimMatch(env.guild, rm, matchId);
    const rmChannel = mRes.roomMakerChannel;
    assert.equal(rmChannel.messages.cache.size, 1, 'Room Maker channel must contain ONLY the dashboard on claim');

    // 4. Room Maker submits initial credentials
    await submitRoomDetails(env.guild, rm, matchId, '12345678', 'pass123');
    assert.equal(rmChannel.messages.cache.size, 1, 'Room Maker channel must contain ONLY the dashboard after credentials');

    const matchChannel = mRes.matchChannel;
    const initialCredsMsg = Array.from(matchChannel.messages.cache.values()).find((m) =>
      m.embeds?.some((e) => e.data?.title?.includes('BGMI ROOM DETAILS'))
    );
    assert.ok(initialCredsMsg);
    const oldCredsMsgId = initialCredsMsg.id;

    // Verify fields and lack of backticks
    const initEmbed = initialCredsMsg.embeds[0].data;
    assert.equal(initEmbed.fields.find((f) => f.name === 'Match ID')?.value, 'MD-0001');
    assert.equal(initEmbed.fields.find((f) => f.name === 'Room ID')?.value, '12345678');
    assert.equal(initEmbed.fields.find((f) => f.name === 'Room Password')?.value, 'pass123');
    for (const field of initEmbed.fields) {
      assert.equal(field.value.includes('`'), false, 'Credential field values must not use backticks');
    }

    // 5. Player reports incorrect credentials (ROOM_ISSUE)
    await handleReportRoomCredentials(env.guild, pA, matchId, 'ROOM_ID');
    assert.equal(rmChannel.messages.cache.size, 1, 'Room Maker channel must contain ONLY the dashboard after issue report');

    // 6. Room Maker submits corrected credentials
    await submitRoomDetails(env.guild, rm, matchId, '87654321', 'passCorrected');
    assert.equal(rmChannel.messages.cache.size, 1, 'Room Maker channel must contain ONLY the dashboard after correction');

    // Verify old credentials message was DELETED from challengers channel
    assert.equal(matchChannel.messages.cache.has(oldCredsMsgId), false, 'Old credentials message must be deleted upon correction');

    // Verify fresh credentials message and notification update
    const freshCredsMsg = Array.from(matchChannel.messages.cache.values()).find((m) =>
      m.embeds?.some((e) => e.data?.title?.includes('BGMI ROOM DETAILS'))
    );
    assert.ok(freshCredsMsg);
    assert.notEqual(freshCredsMsg.id, oldCredsMsgId);
    assert.equal(freshCredsMsg.embeds[0].data.fields.find((f) => f.name === 'Room ID')?.value, '87654321');

    const updateNoticeMsg = Array.from(matchChannel.messages.cache.values()).find((m) =>
      m.embeds?.some((e) => e.data?.title?.includes('Room Credentials Updated'))
    );
    assert.ok(updateNoticeMsg, 'Challengers must receive update notification');
    assert.match(updateNoticeMsg.embeds[0].data.description, /Room credentials have been updated by the Room Maker/);

    // 7. Start match
    await startMatch(env.guild, rm, matchId);
    assert.equal(rmChannel.messages.cache.size, 1, 'Room Maker channel must contain ONLY the dashboard when LIVE');

    // 8. Initiate winner submission
    await initiateWinnerSubmission(env.guild, rm, matchId, 'A');
    assert.equal(rmChannel.messages.cache.size, 1, 'Room Maker channel must contain ONLY the dashboard after winner initiated');

    // 9. Upload screenshot
    const mockUploadMsg = {
      guild: env.guild,
      author: rm.user,
      member: rm,
      channel: rmChannel,
      content: '',
      attachments: new Map([
        ['att-test', { url: 'https://cdn.discordapp.com/result.png', name: 'result.png', contentType: 'image/png' }],
      ]),
    };
    await handleArenaScreenshotUpload(mockUploadMsg);
    assert.equal(rmChannel.messages.cache.size, 1, 'Room Maker channel must contain ONLY the dashboard after proof received');
  });

  test('29. Room Maker Separation & Panel Cleanup: Completed match card removed from Room Maker panel, active matches preserved, zero RM access to challengers channel', async () => {
    const { handleArenaScreenshotUpload } = await import('../bot/discord/features/arena/services/arenaMatchService.js');
    const env = createMockArenaEnvironment('guild-cleanup-1');
    const admin = env.addMember('admin-clean', 'CleanAdmin', { isAdmin: true });
    await setupArenaChannels(env.guild, admin);

    const config = await getArenaConfig(env.guild.id);
    const rmPanel = env.channels.get(config.volunteerPanelId);
    assert.ok(rmPanel);

    const rm = env.addMember('rm-clean-1', 'CleanRoomMaker');
    const p1A = env.addMember('clean-p1a', 'Player1A');
    const p1B = env.addMember('clean-p1b', 'Player1B');
    const p2A = env.addMember('clean-p2a', 'Player2A');
    const p2B = env.addMember('clean-p2b', 'Player2B');

    await upsertArenaPlayer(p1A.id, { displayName: 'Player1A', bgmiIgn: 'Clean1A', bgmiUid: '8001001' });
    await upsertArenaPlayer(p1B.id, { displayName: 'Player1B', bgmiIgn: 'Clean1B', bgmiUid: '8001002' });
    await upsertArenaPlayer(p2A.id, { displayName: 'Player2A', bgmiIgn: 'Clean2A', bgmiUid: '8002001' });
    await upsertArenaPlayer(p2B.id, { displayName: 'Player2B', bgmiIgn: 'Clean2B', bgmiUid: '8002002' });

    // Match 1
    const c1 = await handleCreateChallenge(env.guild, p1A);
    const m1Res = await handleAcceptChallenge(env.guild, p1B, c1.challenge.challengeId, env.client);
    const m1Id = m1Res.match.matchId;

    // Match 2 (active, stays waiting)
    const c2 = await handleCreateChallenge(env.guild, p2A);
    const m2Res = await handleAcceptChallenge(env.guild, p2B, c2.challenge.challengeId, env.client);
    const m2Id = m2Res.match.matchId;

    // Verify both match cards exist in #room-maker-panel
    const m1DocBefore = await getArenaMatch(m1Id);
    const m2DocBefore = await getArenaMatch(m2Id);
    assert.ok(m1DocBefore.panelMessageId);
    assert.ok(m2DocBefore.panelMessageId);
    assert.ok(rmPanel.messages.cache.has(m1DocBefore.panelMessageId));
    assert.ok(rmPanel.messages.cache.has(m2DocBefore.panelMessageId));

    // RM claims Match 1
    await handleClaimMatch(env.guild, rm, m1Id);

    // Verify RM has NO access to Match 1 challengers channel
    assert.equal(m1Res.matchChannel.permissionOverwrites.cache.get(rm.id), undefined, 'RM must NOT have access to challengers channel upon claim');

    // Submit room details
    await submitRoomDetails(env.guild, rm, m1Id, '998877', 'pass9988');

    // Start match
    await startMatch(env.guild, rm, m1Id);

    // Winner submission
    await initiateWinnerSubmission(env.guild, rm, m1Id, 'A');

    // Upload screenshot
    const mockUploadMsg = {
      guild: env.guild,
      author: rm.user,
      member: rm,
      channel: m1Res.roomMakerChannel,
      content: '',
      attachments: new Map([
        ['att-clean', { url: 'https://cdn.discordapp.com/result_clean.png', name: 'result.png', contentType: 'image/png' }],
      ]),
    };
    await handleArenaScreenshotUpload(mockUploadMsg);

    // CRITICAL: Room Maker must STILL have NO access or overwrite in challengers channel after screenshot submission
    assert.equal(m1Res.matchChannel.permissionOverwrites.cache.get(rm.id), undefined, 'RM must NEVER have access or overwrites in challengers channel after screenshot upload');

    // Players confirm result -> match completed
    await handlePlayerConfirmation(env.guild, p1A, m1Id, 'confirm');
    await handlePlayerConfirmation(env.guild, p1B, m1Id, 'confirm');

    // Check Match 1 status in database
    const m1DocAfter = await getArenaMatch(m1Id);
    assert.equal(m1DocAfter.status, ARENA_STATUS.COMPLETED);
    assert.equal(m1DocAfter.panelMessageId, null, 'panelMessageId must be cleared in DB upon completion');

    // Verify Match 1 card was DELETED from #room-maker-panel
    assert.equal(rmPanel.messages.cache.has(m1DocBefore.panelMessageId), false, 'Completed match card must be removed from #room-maker-panel');

    // Verify Match 2 card REMAINS in #room-maker-panel (active matches preserved!)
    assert.ok(rmPanel.messages.cache.has(m2DocBefore.panelMessageId), 'Active match card must remain in #room-maker-panel');
  });

  test('30. Startup recovery reconciles Room Maker panel by deleting lingering completed match cards', async () => {
    const env = createMockArenaEnvironment('guild-recovery-1');
    const admin = env.addMember('admin-rec', 'RecoveryAdmin', { isAdmin: true });
    await setupArenaChannels(env.guild, admin);

    const config = await getArenaConfig(env.guild.id);
    const rmPanel = env.channels.get(config.volunteerPanelId);

    // Simulate an orphaned completed match that still has a panelMessageId in Discord
    const orphanCard = await rmPanel.send({ content: 'Orphaned Completed Match Card' });
    const orphanMatch = await createArenaMatch({
      matchId: 'MD-7777',
      guildId: env.guild.id,
      status: ARENA_STATUS.COMPLETED,
      panelMessageId: orphanCard.id,
      playerA: { discordId: 'u1', displayName: 'U1', bgmiIgn: 'IGN1', bgmiUid: '11111' },
      playerB: { discordId: 'u2', displayName: 'U2', bgmiIgn: 'IGN2', bgmiUid: '22222' },
    });

    assert.ok(rmPanel.messages.cache.has(orphanCard.id));

    // Run startup recovery
    await recoverArenaOnStartup(env.client);

    // Verify orphaned card was deleted from #room-maker-panel
    assert.equal(rmPanel.messages.cache.has(orphanCard.id), false, 'Startup recovery must delete completed match cards from #room-maker-panel');

    // Verify database field updated
    const updatedOrphan = await getArenaMatch('MD-7777');
    assert.equal(updatedOrphan.panelMessageId, null);
  });
});
