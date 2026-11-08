import {
  ARENA_STATUS,
  ARENA_CONSTANTS,
  getArenaPlayer,
  upsertArenaPlayer,
  createArenaChallenge,
  getArenaChallenge,
  getOpenChallengeByCreator,
  updateArenaChallenge,
  getNextArenaSequence,
  getArenaConfig,
  atomicReservePlayerMatch,
  atomicReleasePlayerMatch,
  createArenaMatch,
  logArenaAction,
} from '../models/arenaModels.js';
import {
  buildChallengeEmbed,
  buildVolunteerPanelEmbed,
  buildMatchChannelEmbed,
  buildArenaStatusEmbed,
  safeDirectMessage,
} from './arenaNotificationService.js';
import {
  createMatchChannel,
  createRoomMakerChannel,
} from './arenaChannelService.js';
import { queueChannelSend, queueMessageEdit } from '../../../../../discordQueue.js';

export async function validatePlayerForAction(member, action = 'create') {
  if (!member) return { valid: false, error: 'Member is required' };
  const discordId = member.id;
  const player = await getArenaPlayer(discordId);

  if (!player || !player.bgmiIgn || !player.bgmiUid) {
    return { valid: false, needsRegistration: true, player };
  }

  // Refresh display name in background
  const displayName = member.displayName || member.user?.username || 'Player';
  if (player.displayName !== displayName) {
    await upsertArenaPlayer(discordId, { displayName }).catch(() => { });
  }

  if (player.suspended) {
    return {
      valid: false,
      error: '❌ **Account Suspended:** You are currently suspended from 1v1 TDM.',
    };
  }

  if (player.activeMatchId) {
    return {
      valid: false,
      error: `❌ **Active Match Exists:** You are already participating in match **${player.activeMatchId}**. Finish or resolve it before creating or accepting new challenges.`,
    };
  }

  return { valid: true, player: { ...player, displayName } };
}

export async function handleCreateChallenge(guild, member) {
  if (!guild || !member) throw new Error('Guild and member are required');

  const check = await validatePlayerForAction(member, 'create');
  if (!check.valid) return check;
  const player = check.player;

  // Enforce 1 OPEN challenge at a time
  const existingOpen = await getOpenChallengeByCreator(member.id);
  if (existingOpen) {
    return {
      valid: false,
      error: `❌ **Open Challenge Exists:** You already have an open challenge (**${existingOpen.challengeId}**). Cancel it before creating a new one.`,
    };
  }

  // Enforce 30s cooldown
  if (player.lastChallengeCreatedAt) {
    const elapsed = Date.now() - new Date(player.lastChallengeCreatedAt).getTime();
    if (elapsed < ARENA_CONSTANTS.CHALLENGE_COOLDOWN_MS) {
      const waitSec = Math.ceil((ARENA_CONSTANTS.CHALLENGE_COOLDOWN_MS - elapsed) / 1000);
      return {
        valid: false,
        error: `⏳ **Cooldown Active:** Please wait **${waitSec} seconds** before creating another challenge.`,
      };
    }
  }

  const config = await getArenaConfig(guild.id);
  if (!config || !config.availableChannelId) {
    return {
      valid: false,
      error: '❌ **TDM Not Configured:** The TDM channels have not been initialized. An administrator must run `.tdm setup`.',
    };
  }

  const availableChannel =
    guild.channels.cache.get(config.availableChannelId) ||
    (await guild.channels.fetch(config.availableChannelId).catch(() => null));
  if (!availableChannel) {
    return {
      valid: false,
      error: '❌ Available challenges channel not found. Please contact an administrator to run `.tdm setup`.',
    };
  }

  // Generate ID atomically (e.g. MD-10001)
  const challengeId = await getNextArenaSequence(guild.id);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ARENA_CONSTANTS.CHALLENGE_EXPIRY_MS);

  // Initial challenge record
  const challenge = await createArenaChallenge({
    challengeId,
    guildId: guild.id,
    creatorId: member.id,
    game: 'BGMI',
    matchType: 'TDM 1v1',
    status: ARENA_STATUS.OPEN,
    createdAt: now,
    expiresAt,
  });

  // Post embed in #available-challenges
  const payload = await buildChallengeEmbed(challenge, player.displayName, {
    creatorIgn: player.bgmiIgn,
    creatorUid: player.bgmiUid,
    guild,
    client: guild.client,
  });
  const sentMsg = await queueChannelSend(availableChannel, payload);

  if (sentMsg?.id) {
    await updateArenaChallenge(challengeId, {
      discordMessageId: sentMsg.id,
      discordChannelId: availableChannel.id,
    });
    challenge.discordMessageId = sentMsg.id;
    challenge.discordChannelId = availableChannel.id;
  }

  // Update player cooldown timestamp
  await upsertArenaPlayer(member.id, { lastChallengeCreatedAt: now });

  await logArenaAction({
    action: 'CHALLENGE_CREATED',
    challengeId,
    performedBy: member.id,
    metadata: { creatorDisplayName: player.displayName, expiresAt },
  });

  return { valid: true, ok: true, challenge };
}

export async function handleCancelChallenge(guild, member, challengeId) {
  if (!guild || !member || !challengeId) throw new Error('Missing arguments');

  const challenge = await getArenaChallenge(challengeId);
  if (!challenge) {
    return { ok: false, error: '❌ Challenge not found.' };
  }

  if (challenge.creatorId !== member.id) {
    return { ok: false, error: '❌ Only the creator can cancel this challenge.' };
  }

  if (challenge.status !== ARENA_STATUS.OPEN) {
    return { ok: false, error: `❌ Challenge cannot be cancelled (current status: \`${challenge.status}\`).` };
  }

  const updated = await updateArenaChallenge(challengeId, { status: ARENA_STATUS.CANCELLED });

  // Update embed in #available-challenges
  if (challenge.discordChannelId && challenge.discordMessageId) {
    const ch =
      guild.channels.cache.get(challenge.discordChannelId) ||
      (await guild.channels.fetch(challenge.discordChannelId).catch(() => null));
    if (ch) {
      const msg = ch.messages?.cache?.get(challenge.discordMessageId) || (await ch.messages?.fetch?.(challenge.discordMessageId).catch(() => null));
      if (msg) {
        const payload = await buildChallengeEmbed(updated, member.displayName, { guild, client: guild.client });
        await queueMessageEdit(msg, payload).catch(() => { });
      }
    }
  }

  await logArenaAction({
    action: 'CHALLENGE_CANCELLED',
    challengeId,
    performedBy: member.id,
  });

  return { ok: true, challenge: updated };
}

export async function handleAcceptChallenge(guild, member, challengeId, client) {
  if (!guild || !member || !challengeId) throw new Error('Missing arguments');

  const check = await validatePlayerForAction(member, 'accept');
  if (!check.valid) return check;
  const accepter = check.player;

  const challenge = await getArenaChallenge(challengeId);
  if (!challenge) {
    return { ok: false, error: '❌ Challenge not found.' };
  }

  if (challenge.status !== ARENA_STATUS.OPEN) {
    return { ok: false, error: '❌ This challenge has already been accepted, cancelled, or expired.' };
  }

  if (challenge.creatorId === member.id) {
    return { ok: false, error: '❌ You cannot accept your own challenge.' };
  }

  const creator = await getArenaPlayer(challenge.creatorId);
  if (!creator) {
    return { ok: false, error: '❌ Creator profile not found.' };
  }

  if (creator.bgmiUid === accepter.bgmiUid) {
    return {
      ok: false,
      error: '❌ Both players cannot have the same BGMI UID. If this is an error, contact support in #challenge-support.',
    };
  }

  // Atomically claim challenge status
  const updatedChallenge = await updateArenaChallenge(challengeId, {
    status: ARENA_STATUS.WAITING_FOR_VOLUNTEER,
    opponentId: member.id,
    acceptedAt: new Date(),
  });

  // Atomically reserve activeMatchId on both players
  const creatorReserved = await atomicReservePlayerMatch(creator.discordId, challengeId);
  const accepterReserved = await atomicReservePlayerMatch(accepter.discordId, challengeId);

  if (!creatorReserved || !accepterReserved) {
    // Rollback reservations
    if (creatorReserved) await atomicReleasePlayerMatch(creator.discordId, challengeId);
    if (accepterReserved) await atomicReleasePlayerMatch(accepter.discordId, challengeId);
    await updateArenaChallenge(challengeId, {
      status: ARENA_STATUS.OPEN,
      opponentId: null,
      acceptedAt: null,
    });
    return {
      ok: false,
      error: '❌ Acceptance failed: One of the players has another active match. Challenge returned to OPEN.',
    };
  }

  const config = await getArenaConfig(guild.id);

  // Create match document
  const match = await createArenaMatch({
    matchId: challengeId,
    challengeId,
    guildId: guild.id,
    playerA: {
      discordId: creator.discordId,
      displayName: creator.displayName,
      bgmiIgn: creator.bgmiIgn,
      bgmiUid: creator.bgmiUid,
    },
    playerB: {
      discordId: accepter.discordId,
      displayName: accepter.displayName,
      bgmiIgn: accepter.bgmiIgn,
      bgmiUid: accepter.bgmiUid,
    },
    status: ARENA_STATUS.WAITING_FOR_VOLUNTEER,
  });

  // 1. Create Private Match Channel (Challengers: match-0001)
  let matchChannel = null;
  try {
    matchChannel = await createMatchChannel(guild, match, config);
    if (matchChannel) {
      match.matchChannelId = matchChannel.id;

      // Post initial match card in challengers channel
      const channelPayload = await buildMatchChannelEmbed(match, null, { guild, client: guild?.client || client });
      const embedMsg = await queueChannelSend(matchChannel, channelPayload);
      if (embedMsg?.id) {
        match.matchEmbedMessageId = embedMsg.id;
      }

      // Clean status embed for challengers
      const initNotice = buildArenaStatusEmbed({
        title: '🏆 1v1 TDM Challenge Accepted',
        description:
          `Welcome <@${creator.discordId}> and <@${accepter.discordId}>!\n\n` +
          `Your 1v1 match has been created. A Room Maker will be assigned shortly to create the BGMI custom room.\n` +
          `Custom Room ID and Password will appear directly in this channel once prepared.`,
      });
      await queueChannelSend(matchChannel, { embeds: [initNotice] });
    }
  } catch (err) {
    console.warn(`[Arena] ⚠️ Error creating match channel for ${challengeId}:`, err.message);
  }

  // 1b. Create Room Maker's Private Channel (roommaker-0001)
  let roomMakerChannel = null;
  try {
    roomMakerChannel = await createRoomMakerChannel(guild, match, config);
    if (roomMakerChannel) {
      match.roomMakerChannelId = roomMakerChannel.id;
      match.roomChannelId = roomMakerChannel.id;
    }
  } catch (err) {
    console.warn(`[Arena] ⚠️ Error creating room maker channel for ${challengeId}:`, err.message);
  }

  // 2. Post in #room-maker-panel (Room Maker Panel)
  if (config?.volunteerPanelId) {
    const volPanel =
      guild.channels.cache.get(config.volunteerPanelId) ||
      (await guild.channels.fetch(config.volunteerPanelId).catch(() => null));
    if (volPanel) {
      const volPayload = await buildVolunteerPanelEmbed(match, null, { guild, client: guild?.client || client });
      const volMsg = await queueChannelSend(volPanel, volPayload);
      if (volMsg?.id) {
        match.panelMessageId = volMsg.id;
      }
    }
  }

  // Update match record with channel and panel message IDs
  const { updateArenaMatch } = await import('../models/arenaModels.js');
  await updateArenaMatch(match.matchId, {
    matchChannelId: match.matchChannelId,
    roomMakerChannelId: match.roomMakerChannelId,
    roomChannelId: match.roomMakerChannelId,
    matchEmbedMessageId: match.matchEmbedMessageId,
    panelMessageId: match.panelMessageId,
  });

  // 3. Update Challenge embed in #available-challenges (ACCEPTED, no buttons)
  if (challenge.discordChannelId && challenge.discordMessageId) {
    const ch =
      guild.channels.cache.get(challenge.discordChannelId) ||
      (await guild.channels.fetch(challenge.discordChannelId).catch(() => null));
    if (ch) {
      const msg = ch.messages?.cache?.get(challenge.discordMessageId) || (await ch.messages?.fetch?.(challenge.discordMessageId).catch(() => null));
      if (msg) {
        const payload = await buildChallengeEmbed(updatedChallenge, creator.displayName, {
          creatorIgn: creator.bgmiIgn,
          creatorUid: creator.bgmiUid,
          acceptedOpponent: accepter,
          guild,
          client: guild?.client || client,
        });
        await queueMessageEdit(msg, payload).catch(() => { });
      }
    }
  }

  // 4. DM both players (best effort)
  const channelLink = matchChannel ? `<#${matchChannel.id}>` : `channel match-${match.matchId.toLowerCase()}`;
  const dmContent =
    `⚔️ **1v1 TDM Challenge Accepted!**\n` +
    `Your match **${match.matchId}** has been created in ${channelLink}.\n` +
    `Please proceed to the channel and wait for the Room Maker to provide room credentials.`;
  await safeDirectMessage(client, creator.discordId, dmContent);
  await safeDirectMessage(client, accepter.discordId, dmContent);

  await logArenaAction({
    action: 'CHALLENGE_ACCEPTED',
    challengeId,
    matchId: match.matchId,
    performedBy: member.id,
    metadata: {
      creatorId: creator.discordId,
      accepterId: accepter.discordId,
      matchChannelId: match.matchChannelId,
    },
  });

  return { ok: true, match, matchChannel, roomMakerChannel };
}

