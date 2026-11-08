import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import {
  ARENA_STATUS,
  ALLOWED_TRANSITIONS,
  ARENA_CONSTANTS,
  ARENA_FINAL_STATUSES,
  getArenaMatch,
  updateArenaMatch,
  getArenaConfig,
  atomicReportRoomIssue,
  logArenaAction,
} from '../models/arenaModels.js';
import {
  buildMatchChannelEmbed,
  buildResultVerificationPayload,
} from './arenaNotificationService.js';
import { fetchMatchAvatars } from './arenaImageService.js';
import {
  queueChannelSend,
  queueMessageEdit,
} from '../../../../../discordQueue.js';
import {
  grantVolunteerScreenshotPermission,
  revokeVolunteerScreenshotPermission,
} from './arenaChannelService.js';

const activeScreenshotTimers = new Map();

export function cancelScreenshotTimer(matchId) {
  if (activeScreenshotTimers.has(matchId)) {
    clearTimeout(activeScreenshotTimers.get(matchId));
    activeScreenshotTimers.delete(matchId);
  }
}

export function cancelAllScreenshotTimers() {
  for (const timer of activeScreenshotTimers.values()) {
    clearTimeout(timer);
  }
  activeScreenshotTimers.clear();
}

export async function handleScreenshotTimeout(guild, matchId, volunteerId) {
  cancelScreenshotTimer(matchId);

  const match = await getArenaMatch(matchId);
  if (!match || match.status !== ARENA_STATUS.LIVE || !match.pendingWinnerId) {
    return;
  }

  // Revoke temporary permissions
  if (match.matchChannelId && guild) {
    const channel =
      guild.channels.cache.get(match.matchChannelId) ||
      (await guild.channels.fetch(match.matchChannelId).catch(() => null));
    if (channel) {
      await revokeVolunteerScreenshotPermission(channel, volunteerId);
      await queueChannelSend(channel, {
        content: `⏳ <@${volunteerId}>, your **5-minute screenshot upload window** has expired. Temporary message permissions have been revoked. Please click **Submit Winner** again when you are ready to upload the scoreboard screenshot.`,
      });
    }
  }

  // Clear pending winner fields so volunteer can retry
  await updateArenaMatch(matchId, {
    pendingWinnerId: null,
    pendingLoserId: null,
    screenshotRequestedAt: null,
  });
}

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
    return { ok: false, error: '❌ Only the assigned Room Maker can submit room credentials.' };
  }

  if (
    match.status !== ARENA_STATUS.VOLUNTEER_ASSIGNED &&
    match.status !== ARENA_STATUS.ROOM_READY &&
    match.status !== ARENA_STATUS.ROOM_ISSUE
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
      roomReports: [],
    });
  } else {
    const transition = await transitionArenaStatus(matchId, ARENA_STATUS.ROOM_READY, {
      performedBy: member.id,
      additionalUpdates: {
        roomId: cleanRoomId,
        roomPassword: cleanPassword,
        roomReports: [],
      },
    });
    if (!transition.ok) return transition;
    updatedMatch = transition.match;
  }

  // Post or edit room credentials message directly inside this private match channel
  if (match.matchChannelId) {
    const channel =
      guild.channels.cache.get(match.matchChannelId) ||
      (await guild.channels.fetch(match.matchChannelId).catch(() => null));
    if (channel) {
      const roomCredsPayload = {
        content:
          `🔐 **BGMI Custom Room Credentials:**\n` +
          `• **Room ID:** \`${cleanRoomId}\`\n` +
          `• **Password:** \`${cleanPassword}\`\n\n` +
          `*Both players (<@${match.playerA.discordId}> & <@${match.playerB.discordId}>), please join the BGMI custom room now. If the credentials do not work, click **Report Incorrect ID/Password** below.*`,
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`arena:report_room_issue:${match.matchId}`)
              .setLabel('Report Incorrect ID/Password')
              .setStyle(ButtonStyle.Danger)
          ),
        ],
      };

      let edited = false;
      if (match.roomMessageId) {
        const existingRoomMsg =
          channel.messages?.cache?.get(match.roomMessageId) ||
          (await channel.messages?.fetch?.(match.roomMessageId).catch(() => null));
        if (existingRoomMsg) {
          await queueMessageEdit(existingRoomMsg, roomCredsPayload).catch(() => {});
          edited = true;
        }
      }
      if (!edited) {
        const newMsg = await queueChannelSend(channel, roomCredsPayload);
        if (newMsg?.id) {
          await updateArenaMatch(matchId, { roomMessageId: newMsg.id });
        }
      }

      // Update match image card in this same channel to show ROOM READY
      if (match.matchEmbedMessageId) {
        const msg =
          channel.messages?.cache?.get(match.matchEmbedMessageId) ||
          (await channel.messages?.fetch?.(match.matchEmbedMessageId).catch(() => null));
        if (msg) {
          const avatars = await fetchMatchAvatars(guild.client, updatedMatch);
          const payload = await buildMatchChannelEmbed(updatedMatch, member.displayName, { avatars, guild, client: guild.client });
          await queueMessageEdit(msg, payload).catch(() => {});
        }
      }
    }
  }

  return { ok: true, match: updatedMatch };
}

export async function startMatch(guild, member, matchId) {
  if (!guild || !member || !matchId) throw new Error('Missing arguments');

  const match = await getArenaMatch(matchId);
  if (!match) return { ok: false, error: '❌ Match not found.' };

  if (match.volunteerId !== member.id) {
    return { ok: false, error: '❌ Only the assigned Room Maker can start this match.' };
  }

  if (match.status !== ARENA_STATUS.ROOM_READY) {
    if (match.status === ARENA_STATUS.ROOM_ISSUE) {
      return {
        ok: false,
        error: '❌ Cannot start match: A player has reported incorrect room credentials. The Room Maker must submit corrected credentials first.',
      };
    }
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
          const avatars = await fetchMatchAvatars(guild.client, updatedMatch);
          const payload = await buildMatchChannelEmbed(updatedMatch, member.displayName, { avatars, guild, client: guild.client });
          await queueMessageEdit(msg, payload).catch(() => { });
        }
      }

      await queueChannelSend(channel, {
        content: `⚔️ **MATCH IS NOW LIVE!**\nGood luck to both players. The Room Maker will submit the winner once the game concludes.`,
      });
    }
  }

  return { ok: true, match: updatedMatch };
}

export async function handleReportRoomCredentials(guild, member, matchId, issueType = 'BOTH') {
  if (!guild || !member || !matchId) throw new Error('Missing arguments');

  const match = await getArenaMatch(matchId);
  if (!match) return { ok: false, error: '❌ Match not found.' };

  const isPlayerA = match.playerA.discordId === member.id;
  const isPlayerB = match.playerB.discordId === member.id;
  if (!isPlayerA && !isPlayerB) {
    return { ok: false, error: '❌ Only Player A or Player B can report incorrect room credentials.' };
  }

  if (match.status === ARENA_STATUS.LIVE || ARENA_FINAL_STATUSES.includes(match.status)) {
    return { ok: false, error: `❌ Cannot report room credentials once the match is ${match.status}.` };
  }

  const reportRes = await atomicReportRoomIssue(matchId, member.id, issueType);
  if (!reportRes.ok) {
    return {
      ok: false,
      error: '❌ You have already reported an issue with these credentials, or the match is not awaiting room entry.',
    };
  }

  const updatedMatch = reportRes.match;

  // Refresh match card in matchChannel
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
          const avatars = await fetchMatchAvatars(guild.client, updatedMatch);
          const volunteerName = match.volunteerId
            ? (guild.members?.cache?.get(match.volunteerId)?.displayName || 'Room Maker')
            : null;
          const payload = await buildMatchChannelEmbed(updatedMatch, volunteerName, { avatars, guild, client: guild.client });
          await queueMessageEdit(msg, payload).catch(() => {});
        }
      }

      await queueChannelSend(channel, {
        content:
          `⚠️ **Incorrect Room Credentials Reported!**\n` +
          `<@${member.id}> reported: **${issueType}** is incorrect.\n` +
          `<@${match.volunteerId}>, please review the custom room and submit corrected credentials using **Edit Room Details**. The match cannot start until resolved.`,
      });
    }
  }

  await logArenaAction({
    action: 'ROOM_ISSUE_REPORTED',
    matchId,
    performedBy: member.id,
    metadata: { issueType, reporterId: member.id },
  });

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

  // Prompt the volunteer in the match channel to upload the scoreboard screenshot and temporarily grant permissions
  if (match.matchChannelId) {
    const channel =
      guild.channels.cache.get(match.matchChannelId) ||
      (await guild.channels.fetch(match.matchChannelId).catch(() => null));
    if (channel) {
      // Temporarily grant Send Messages and Attach Files to the assigned volunteer
      await grantVolunteerScreenshotPermission(channel, member.id);

      await queueChannelSend(channel, {
        content:
          `📸 **Scoreboard Screenshot Required:**\n` +
          `<@${member.id}>, please upload the end-game scoreboard / match result screenshot in this channel within **5 minutes**.\n` +
          `*You have been temporarily granted \`Send Messages\` and \`Attach Files\` permissions for this upload.*`,
      });

      // Start 5-minute timeout timer
      cancelScreenshotTimer(matchId);
      const timer = setTimeout(async () => {
        try {
          await handleScreenshotTimeout(guild, matchId, member.id);
        } catch (err) {
          console.warn(`[Arena] ⚠️ Error in screenshot timeout handler for ${matchId}:`, err.message);
        }
      }, 5 * 60 * 1000);

      if (typeof timer.unref === 'function') timer.unref();
      activeScreenshotTimers.set(matchId, timer);
    }
  }

  return { ok: true, pendingWinner: winnerPlayer };
}

export async function processWinnerScreenshot(guild, match, volunteerMember, attachmentUrl) {
  if (!guild || !match || !attachmentUrl) throw new Error('Missing arguments');

  // Cancel any active timeout timer
  cancelScreenshotTimer(match.matchId);

  // Immediately revoke temporary permissions from volunteer in match channel
  if (match.matchChannelId && volunteerMember?.id) {
    const channel =
      guild.channels.cache.get(match.matchChannelId) ||
      (await guild.channels.fetch(match.matchChannelId).catch(() => null));
    if (channel) {
      await revokeVolunteerScreenshotPermission(channel, volunteerMember.id);
    }
  }

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

