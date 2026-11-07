import {
  ARENA_STATUS,
  ALLOWED_TRANSITIONS,
  ARENA_CONSTANTS,
  getArenaMatch,
  updateArenaMatch,
  getArenaConfig,
  logArenaAction,
} from '../models/arenaModels.js';
import {
  buildMatchChannelEmbed,
  buildResultVerificationPayload,
} from './arenaNotificationService.js';
import {
  queueChannelSend,
  queueMessageEdit,
} from '../../../../../discordQueue.js';

/**
 * Authoritative single status transition engine.
 * Uses conditional database checks to guarantee valid lifecycle transitions.
 */
export async function transitionArenaStatus(
  matchId,
  targetStatus,
  { performedBy = 'system', metadata = {}, additionalUpdates = {} } = {}
) {
  if (!matchId || !targetStatus) throw new Error('matchId and targetStatus are required');

  const match = await getArenaMatch(matchId);
  if (!match) {
    return { ok: false, error: `Match ${matchId} not found.` };
  }

  const currentStatus = match.status;
  const allowedNext = ALLOWED_TRANSITIONS[currentStatus] || [];

  if (!allowedNext.includes(targetStatus)) {
    return {
      ok: false,
      error: `Invalid status transition from ${currentStatus} to ${targetStatus}. Allowed: [${allowedNext.join(', ')}]`,
    };
  }

  const now = new Date();
  const updates = {
    ...additionalUpdates,
    status: targetStatus,
    updatedAt: now,
  };

  const updatedMatch = await updateArenaMatch(matchId, updates);

  await logArenaAction({
    action: `STATUS_${targetStatus}`,
    matchId,
    performedBy,
    metadata: {
      fromStatus: currentStatus,
      toStatus: targetStatus,
      ...metadata,
    },
  });

  return { ok: true, match: updatedMatch, fromStatus: currentStatus };
}

export async function submitRoomDetails(guild, member, matchId, roomId, roomPassword) {
  if (!guild || !member || !matchId) throw new Error('Missing arguments');

  const match = await getArenaMatch(matchId);
  if (!match) return { ok: false, error: '❌ Match not found.' };

  if (match.volunteerId !== member.id) {
    return { ok: false, error: '❌ Only the assigned volunteer can submit room credentials.' };
  }

  if (
    match.status !== ARENA_STATUS.VOLUNTEER_ASSIGNED &&
    match.status !== ARENA_STATUS.ROOM_READY
  ) {
    return {
      ok: false,
      error: `❌ Cannot submit room details while match is in status \`${match.status}\`.`,
    };
  }

  const cleanRoomId = String(roomId).trim();
  const cleanPassword = String(roomPassword).trim();

  // If already ROOM_READY, update in place; otherwise transition
  let updatedMatch;
  if (match.status === ARENA_STATUS.ROOM_READY) {
    updatedMatch = await updateArenaMatch(matchId, {
      roomId: cleanRoomId,
      roomPassword: cleanPassword,
    });
  } else {
    const transition = await transitionArenaStatus(matchId, ARENA_STATUS.ROOM_READY, {
      performedBy: member.id,
      additionalUpdates: {
        roomId: cleanRoomId,
        roomPassword: cleanPassword,
      },
    });
    if (!transition.ok) return transition;
    updatedMatch = transition.match;
  }

  // Update match channel embed & announce room details
  if (match.matchChannelId) {
    const channel =
      guild.channels.cache.get(match.matchChannelId) ||
      (await guild.channels.fetch(match.matchChannelId).catch(() => null));
    if (channel) {
      if (match.matchEmbedMessageId) {
        const msg =
          channel.messages?.cache?.get(match.matchEmbedMessageId) ||
          (await channel.messages?.fetch?.(match.matchEmbedMessageId).catch(() => null));
        if (msg) {
          const payload = buildMatchChannelEmbed(updatedMatch, member.displayName);
          await queueMessageEdit(msg, payload).catch(() => {});
        }
      }

      // Post room credentials in private channel (never in public channels)
      await queueChannelSend(channel, {
        content:
          `🔐 **BGMI Custom Room Credentials Submitted:**\n` +
          `• **Room ID:** \`${cleanRoomId}\`\n` +
          `• **Password:** \`${cleanPassword}\`\n\n` +
          `*Both players, please join the room. The volunteer will start the match once players are seated.*`,
      });
    }
  }

  return { ok: true, match: updatedMatch };
}

export async function startMatch(guild, member, matchId) {
  if (!guild || !member || !matchId) throw new Error('Missing arguments');

  const match = await getArenaMatch(matchId);
  if (!match) return { ok: false, error: '❌ Match not found.' };

  if (match.volunteerId !== member.id) {
    return { ok: false, error: '❌ Only the assigned volunteer can start this match.' };
  }

  if (match.status !== ARENA_STATUS.ROOM_READY) {
    return {
      ok: false,
      error: `❌ Match cannot be started (status: \`${match.status}\`). Room credentials must be submitted first.`,
    };
  }

  const now = new Date();
  const transition = await transitionArenaStatus(matchId, ARENA_STATUS.LIVE, {
    performedBy: member.id,
    additionalUpdates: {
      startedAt: now,
    },
  });
  if (!transition.ok) return transition;
  const updatedMatch = transition.match;

  // Update channel embed and post started announcement
  if (match.matchChannelId) {
    const channel =
      guild.channels.cache.get(match.matchChannelId) ||
      (await guild.channels.fetch(match.matchChannelId).catch(() => null));
    if (channel) {
      if (match.matchEmbedMessageId) {
        const msg =
          channel.messages?.cache?.get(match.matchEmbedMessageId) ||
          (await channel.messages?.fetch?.(match.matchEmbedMessageId).catch(() => null));
        if (msg) {
          const payload = buildMatchChannelEmbed(updatedMatch, member.displayName);
          await queueMessageEdit(msg, payload).catch(() => {});
        }
      }

      await queueChannelSend(channel, {
        content: `⚔️ **MATCH IS NOW LIVE!**\nGood luck to both players. The volunteer will submit the winner once the game concludes.`,
      });
    }
  }

  return { ok: true, match: updatedMatch };
}

export async function initiateWinnerSubmission(guild, member, matchId, winnerSide) {
  if (!guild || !member || !matchId) throw new Error('Missing arguments');

  const match = await getArenaMatch(matchId);
  if (!match) return { ok: false, error: '❌ Match not found.' };

  if (match.volunteerId !== member.id) {
    return { ok: false, error: '❌ Only the assigned volunteer can submit the winner.' };
  }

  if (match.status !== ARENA_STATUS.LIVE) {
    return {
      ok: false,
      error: `❌ Winner can only be submitted while match is LIVE (current: \`${match.status}\`).`,
    };
  }

  const winnerPlayer = winnerSide === 'A' ? match.playerA : match.playerB;
  const loserPlayer = winnerSide === 'A' ? match.playerB : match.playerA;

  await updateArenaMatch(matchId, {
    pendingWinnerId: winnerPlayer.discordId,
    pendingLoserId: loserPlayer.discordId,
    screenshotRequestedAt: new Date(),
  });

  // Prompt the volunteer in the match channel to upload the scoreboard screenshot
  if (match.matchChannelId) {
    const channel =
      guild.channels.cache.get(match.matchChannelId) ||
      (await guild.channels.fetch(match.matchChannelId).catch(() => null));
    if (channel) {
      await queueChannelSend(channel, {
        content:
          `📸 **Scoreboard Screenshot Required:**\n` +
          `<@${member.id}>, please upload the end-game scoreboard / match result screenshot in this channel within **5 minutes**.\n` +
          `*The match result verification will begin immediately after the screenshot is attached.*`,
      });
    }
  }

  return { ok: true, pendingWinner: winnerPlayer };
}

export async function processWinnerScreenshot(guild, match, volunteerMember, attachmentUrl) {
  if (!guild || !match || !attachmentUrl) throw new Error('Missing arguments');

  const config = await getArenaConfig(guild.id);
  let evidenceLink = attachmentUrl;

  // 1. Copy screenshot into #arena-evidence (staff only)
  if (config?.evidenceChannelId) {
    const evidenceChannel =
      guild.channels.cache.get(config.evidenceChannelId) ||
      (await guild.channels.fetch(config.evidenceChannelId).catch(() => null));
    if (evidenceChannel) {
      const evidenceMsg = await queueChannelSend(evidenceChannel, {
        content:
          `📊 **Evidence for Match ${match.matchId}**\n` +
          `• **Submitted By:** <@${volunteerMember.id}>\n` +
          `• **Player A:** ${match.playerA.displayName} (<@${match.playerA.discordId}>)\n` +
          `• **Player B:** ${match.playerB.displayName} (<@${match.playerB.discordId}>)\n` +
          `• **Reported Winner:** <@${match.pendingWinnerId}>`,
        files: [attachmentUrl],
      });
      if (evidenceMsg?.id) {
        evidenceLink = `https://discord.com/channels/${guild.id}/${evidenceChannel.id}/${evidenceMsg.id}`;
      }
    }
  }

  const now = new Date();
  const resultTimeoutDueAt = new Date(now.getTime() + ARENA_CONSTANTS.RESULT_CONFIRM_TIMEOUT_MS);

  // 2. Transition status: LIVE -> RESULT_PENDING
  const transition = await transitionArenaStatus(match.matchId, ARENA_STATUS.RESULT_PENDING, {
    performedBy: volunteerMember.id,
    additionalUpdates: {
      resultEvidence: evidenceLink,
      winnerId: match.pendingWinnerId,
      loserId: match.pendingLoserId,
      resultTimeoutDueAt,
      playerAConfirmation: null,
      playerBConfirmation: null,
    },
  });
  if (!transition.ok) return transition;
  const updatedMatch = transition.match;

  // 3. Post verification payload with Confirm and Dispute buttons
  if (match.matchChannelId) {
    const channel =
      guild.channels.cache.get(match.matchChannelId) ||
      (await guild.channels.fetch(match.matchChannelId).catch(() => null));
    if (channel) {
      const winnerPlayer =
        match.playerA.discordId === match.pendingWinnerId ? match.playerA : match.playerB;
      const verifyPayload = buildResultVerificationPayload(updatedMatch, winnerPlayer, evidenceLink);
      await queueChannelSend(channel, {
        content: `🔔 <@${match.playerA.discordId}> <@${match.playerB.discordId}> Please verify your match result below:`,
        ...verifyPayload,
      });
    }
  }

  return { ok: true, match: updatedMatch };
}

