import {
  ARENA_STATUS,
  getArenaMatch,
  createArenaDispute,
  getOpenDisputes,
  resolveArenaDispute,
  getArenaVolunteer,
  updateArenaVolunteer,
  getArenaConfig,
  logArenaAction,
} from '../models/arenaModels.js';
import { transitionArenaStatus } from './arenaMatchService.js';
import { completeArenaMatch } from './arenaResultService.js';
import { buildDisputeEvidenceEmbed, refreshArenaMatchCards } from './arenaNotificationService.js';
import { queueChannelSend } from '../../../../../discordQueue.js';

export async function handleFileDispute(guild, member, matchId, reason = 'Result disputed by player') {
  if (!guild || !member || !matchId) throw new Error('Missing arguments');

  const match = await getArenaMatch(matchId);
  if (!match) return { ok: false, error: '❌ Match not found.' };

  const isPlayerA = match.playerA.discordId === member.id;
  const isPlayerB = match.playerB.discordId === member.id;

  if (!isPlayerA && !isPlayerB) {
    return { ok: false, error: '❌ Only the players in this match can file a dispute.' };
  }

  if (match.status === ARENA_STATUS.COMPLETED || match.status === ARENA_STATUS.CANCELLED) {
    return { ok: false, error: `❌ Match has already reached a final status (\`${match.status}\`).` };
  }

  // Transition to UNDER_REVIEW
  const transition = await transitionArenaStatus(matchId, ARENA_STATUS.UNDER_REVIEW, {
    performedBy: member.id,
    metadata: { reason, disputedBy: member.id },
  });
  if (!transition.ok) return transition;
  const updatedMatch = transition.match;

  await refreshArenaMatchCards(guild, updatedMatch);

  // Create dispute record
  const dispute = await createArenaDispute({
    matchId,
    reportedBy: member.id,
    reason,
    evidence: match.resultEvidence,
  });

  // Track disputed count on volunteer if volunteer was assigned
  if (match.volunteerId) {
    const vol = await getArenaVolunteer(match.volunteerId);
    if (vol) {
      await updateArenaVolunteer(match.volunteerId, {
        disputedMatches: (vol.disputedMatches || 0) + 1,
      });
    }
  }

  // Post alert in #arena-evidence
  const config = await getArenaConfig(guild.id);
  if (config?.evidenceChannelId) {
    const evidenceChannel =
      guild.channels.cache.get(config.evidenceChannelId) ||
      (await guild.channels.fetch(config.evidenceChannelId).catch(() => null));
    if (evidenceChannel) {
      const disputeEmbed = buildDisputeEvidenceEmbed(
        updatedMatch,
        member.id,
        reason,
        match.resultEvidence
      );
      await queueChannelSend(evidenceChannel, {
        content: `🚨 **DISPUTE ALERT — ACTION REQUIRED**\nMatch **${matchId}** has been disputed and requires administrator review.`,
        embeds: [disputeEmbed],
      });
    }
  }

  // Post in match channel
  if (match.matchChannelId) {
    const channel =
      guild.channels.cache.get(match.matchChannelId) ||
      (await guild.channels.fetch(match.matchChannelId).catch(() => null));
    if (channel) {
      await queueChannelSend(channel, {
        content:
          `⚠️ **MATCH DISPUTED & UNDER REVIEW**\n` +
          `A dispute has been raised by <@${member.id}>.\n` +
          `**Reason:** ${reason}\n\n` +
          `*Administrators have been alerted in #arena-evidence. Staff will inspect the match evidence and finalize the result shortly.*`,
      });
    }
  }

  await logArenaAction({
    action: 'DISPUTE_FILED',
    matchId,
    performedBy: member.id,
    metadata: { disputeId: dispute.disputeId, reason },
  });

  return { ok: true, match: updatedMatch, dispute };
}

export async function handleAdminResolveDispute(guild, adminMember, matchId, winningSide, reason) {
  if (!guild || !adminMember || !matchId || !winningSide) throw new Error('Missing arguments');

  const match = await getArenaMatch(matchId);
  if (!match) return { ok: false, error: '❌ Match not found.' };

  if (match.status !== ARENA_STATUS.UNDER_REVIEW) {
    return {
      ok: false,
      error: `❌ Match is not currently under review (status: \`${match.status}\`).`,
    };
  }

  const side = winningSide.toUpperCase();
  if (side !== 'A' && side !== 'B') {
    return { ok: false, error: '❌ Winner must be designated as `A` (Player A) or `B` (Player B).' };
  }

  const winnerPlayer = side === 'A' ? match.playerA : match.playerB;
  const loserPlayer = side === 'A' ? match.playerB : match.playerA;

  // Mark all open disputes for this match as resolved
  const openDisputes = await getOpenDisputes(matchId);
  for (const d of openDisputes) {
    await resolveArenaDispute(
      d.disputeId,
      `Resolved by admin ${adminMember.displayName}: Winner ${winnerPlayer.displayName}. Reason: ${reason}`,
      adminMember.id
    );
  }

  // Complete match with chosen winner
  const result = await completeArenaMatch(guild, match, {
    winnerId: winnerPlayer.discordId,
    loserId: loserPlayer.discordId,
    resolvedBy: adminMember.id,
    reason: `Admin resolution: ${reason}`,
  });

  if (!result.ok) return result;

  await logArenaAction({
    action: 'DISPUTE_RESOLVED',
    matchId,
    performedBy: adminMember.id,
    metadata: {
      winnerId: winnerPlayer.discordId,
      loserId: loserPlayer.discordId,
      side,
      reason,
    },
  });

  return { ok: true, match: result.match, winner: winnerPlayer };
}

