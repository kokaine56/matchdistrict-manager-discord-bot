import {
  ARENA_STATUS,
  ARENA_CONSTANTS,
  getArenaMatch,
  updateArenaMatch,
  getArenaPlayer,
  updateArenaPlayer,
  getArenaVolunteer,
  updateArenaVolunteer,
  atomicReleasePlayerMatch,
  getArenaConfig,
  logArenaAction,
} from '../models/arenaModels.js';
import { transitionArenaStatus } from './arenaMatchService.js';
import { buildCompletedMatchResultEmbed, refreshArenaMatchCards } from './arenaNotificationService.js';
import { queueChannelSend, queueMessageEdit } from '../../../../../discordQueue.js';

export async function handlePlayerConfirmation(guild, member, matchId) {
  if (!guild || !member || !matchId) throw new Error('Missing arguments');

  const match = await getArenaMatch(matchId);
  if (!match) return { ok: false, error: '❌ Match not found.' };

  if (match.status !== ARENA_STATUS.RESULT_PENDING) {
    return { ok: false, error: `❌ Match is not pending result verification (status: \`${match.status}\`).` };
  }

  const isPlayerA = match.playerA.discordId === member.id;
  const isPlayerB = match.playerB.discordId === member.id;

  if (!isPlayerA && !isPlayerB) {
    return { ok: false, error: '❌ Only the two players in this match can confirm the result.' };
  }

  const updates = {};
  if (isPlayerA) updates.playerAConfirmation = true;
  if (isPlayerB) updates.playerBConfirmation = true;

  const updatedMatch = await updateArenaMatch(matchId, updates);

  const bothConfirmed =
    (isPlayerA ? true : updatedMatch.playerAConfirmation) &&
    (isPlayerB ? true : updatedMatch.playerBConfirmation);

  if (bothConfirmed) {
    return completeArenaMatch(guild, updatedMatch, {
      winnerId: updatedMatch.winnerId,
      loserId: updatedMatch.loserId,
      resolvedBy: 'players_confirmed',
    });
  }

  return {
    ok: true,
    waitingForOpponent: true,
    message: '✅ You confirmed the result. Waiting for your opponent to confirm...',
  };
}

export async function completeArenaMatch(
  guild,
  match,
  { winnerId, loserId, resolvedBy = 'system', reason = 'Result verified' } = {}
) {
  if (!guild || !match) throw new Error('Guild and match are required');

  const effectiveWinnerId = winnerId || match.winnerId;
  const effectiveLoserId =
    loserId ||
    match.loserId ||
    (effectiveWinnerId === match.playerA.discordId ? match.playerB.discordId : match.playerA.discordId);

  const now = new Date();
  const deleteChannelAt = new Date(now.getTime() + ARENA_CONSTANTS.CHANNEL_CLEANUP_MS);

  // Transition status to COMPLETED
  const transition = await transitionArenaStatus(match.matchId, ARENA_STATUS.COMPLETED, {
    performedBy: resolvedBy,
    metadata: { winnerId: effectiveWinnerId, loserId: effectiveLoserId, reason },
    additionalUpdates: {
      winnerId: effectiveWinnerId,
      loserId: effectiveLoserId,
      completedAt: now,
      deleteChannelAt,
      roomPassword: null, // Clear room password upon completion
      resultTimeoutDueAt: null,
    },
  });

  if (!transition.ok) return transition;
  const completedMatch = transition.match;

  await refreshArenaMatchCards(guild, completedMatch);

  // 1. Update winner & loser stats in arena_players
  const winnerPlayer = await getArenaPlayer(effectiveWinnerId);
  if (winnerPlayer) {
    const stats = winnerPlayer.stats || { played: 0, won: 0, lost: 0 };
    await updateArenaPlayer(effectiveWinnerId, {
      stats: { played: stats.played + 1, won: stats.won + 1, lost: stats.lost },
    });
  }

  const loserPlayer = await getArenaPlayer(effectiveLoserId);
  if (loserPlayer) {
    const stats = loserPlayer.stats || { played: 0, won: 0, lost: 0 };
    await updateArenaPlayer(effectiveLoserId, {
      stats: { played: stats.played + 1, won: stats.won, lost: stats.lost + 1 },
    });
  }

  // 2. Free both players' activeMatchId
  await atomicReleasePlayerMatch(match.playerA.discordId, match.matchId);
  await atomicReleasePlayerMatch(match.playerB.discordId, match.matchId);

  // 3. Update volunteer stats & free volunteer active match
  let volunteerName = 'Volunteer';
  if (match.volunteerId) {
    const vol = await getArenaVolunteer(match.volunteerId);
    if (vol) {
      await updateArenaVolunteer(match.volunteerId, {
        activeMatches: Math.max(0, vol.activeMatches - 1),
        totalMatches: (vol.totalMatches || 0) + 1,
        completedMatches: (vol.completedMatches || 0) + 1,
      });
    }
    const volMember =
      guild.members.cache.get(match.volunteerId) ||
      (await guild.members.fetch(match.volunteerId).catch(() => null));
    if (volMember) {
      volunteerName = volMember.displayName || volMember.user?.username || 'Volunteer';
    }
  }

  const winnerObj =
    match.playerA.discordId === effectiveWinnerId ? match.playerA : match.playerB;
  const loserObj =
    match.playerA.discordId === effectiveWinnerId ? match.playerB : match.playerA;

  // 4. Post verified announcement in #match-results
  const config = await getArenaConfig(guild.id);
  if (config?.matchResultsId) {
    const resultsChannel =
      guild.channels.cache.get(config.matchResultsId) ||
      (await guild.channels.fetch(config.matchResultsId).catch(() => null));
    if (resultsChannel) {
      const resultEmbed = buildCompletedMatchResultEmbed(
        completedMatch,
        winnerObj,
        loserObj,
        volunteerName
      );
      await queueChannelSend(resultsChannel, { embeds: [resultEmbed] });
    }
  }

  // 5. Post in match channel that match is completed and channel will be deleted in 60m
  if (match.matchChannelId) {
    const channel =
      guild.channels.cache.get(match.matchChannelId) ||
      (await guild.channels.fetch(match.matchChannelId).catch(() => null));
    if (channel) {
      await queueChannelSend(channel, {
        content:
          `🏁 **MATCH COMPLETED & VERIFIED!**\n` +
          `• **Winner:** <@${effectiveWinnerId}> (${winnerObj.displayName})\n` +
          `• **Opponent:** <@${effectiveLoserId}> (${loserObj.displayName})\n\n` +
          `*Both players have been released to create or accept new challenges. This channel will automatically be deleted in 60 minutes.*`,
      });
    }
  }

  await logArenaAction({
    action: 'MATCH_COMPLETED',
    matchId: match.matchId,
    performedBy: resolvedBy,
    metadata: { winnerId: effectiveWinnerId, loserId: effectiveLoserId, reason },
  });

  return { ok: true, match: completedMatch };
}

