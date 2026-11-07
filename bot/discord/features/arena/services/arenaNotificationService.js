import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { ARENA_CONSTANTS, ARENA_STATUS } from '../models/arenaModels.js';
import { queueDirectMessage, queueChannelSend } from '../../../../../discordQueue.js';

export function buildCreateChallengePanel() {
  const embed = new EmbedBuilder()
    .setTitle('1v1 BGMI Challenge Arena')
    .setColor(ARENA_CONSTANTS.ORANGE_COLOR)
    .setDescription(
      'Instant 1v1 BGMI TDM challenges officiated by verified volunteers.\n\n' +
        '• Click **Create Challenge** to post an open challenge.\n' +
        '• Click **Update BGMI Details** to manage your registered IGN and UID.'
    )
    .setFooter({ text: 'Match District Arena' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('arena:create_challenge')
      .setLabel('Create Challenge')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('arena:update_bgmi')
      .setLabel('Update BGMI Details')
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row] };
}

export function buildChallengeEmbed(challenge, creatorDisplayName) {
  const isExpired = challenge.status === ARENA_STATUS.EXPIRED;
  const isCancelled = challenge.status === ARENA_STATUS.CANCELLED;
  const isAccepted = challenge.status !== ARENA_STATUS.OPEN && !isExpired && !isCancelled;

  const statusLabel = isExpired
    ? 'EXPIRED'
    : isCancelled
      ? 'CANCELLED'
      : isAccepted
        ? 'ACCEPTED'
        : 'OPEN';

  const embed = new EmbedBuilder()
    .setTitle(`Challenge ${challenge.challengeId}`)
    .setColor(ARENA_CONSTANTS.ORANGE_COLOR)
    .addFields(
      { name: 'Challenger', value: creatorDisplayName || `<@${challenge.creatorId}>`, inline: true },
      { name: 'Game', value: challenge.game || 'BGMI', inline: true },
      { name: 'Match', value: challenge.matchType || 'TDM 1v1', inline: true },
      { name: 'Status', value: `\`${statusLabel}\``, inline: true },
      { name: 'Created', value: `<t:${Math.floor(new Date(challenge.createdAt).getTime() / 1000)}:R>`, inline: true },
      { name: 'Expires', value: `<t:${Math.floor(new Date(challenge.expiresAt).getTime() / 1000)}:R>`, inline: true }
    )
    .setFooter({ text: 'Match District Arena' });

  if (challenge.status !== ARENA_STATUS.OPEN) {
    return { embeds: [embed], components: [] };
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`arena:accept_challenge:${challenge.challengeId}`)
      .setLabel('Accept Challenge')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`arena:cancel_challenge:${challenge.challengeId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [row] };
}

export function buildVolunteerPanelEmbed(match, volunteerDisplayName = null) {
  const isAssigned = Boolean(match.volunteerId);
  const statusLabel = isAssigned ? 'VOLUNTEER ASSIGNED' : 'WAITING FOR VOLUNTEER';

  const embed = new EmbedBuilder()
    .setTitle(`Match Request ${match.matchId}`)
    .setColor(ARENA_CONSTANTS.ORANGE_COLOR)
    .addFields(
      { name: 'Game', value: 'BGMI', inline: true },
      { name: 'Match Type', value: 'TDM 1v1', inline: true },
      { name: 'Status', value: `\`${statusLabel}\``, inline: true },
      { name: 'Player A', value: match.playerA.displayName, inline: true },
      { name: 'Player B', value: match.playerB.displayName, inline: true },
      {
        name: 'Volunteer',
        value: isAssigned ? volunteerDisplayName || `<@${match.volunteerId}>` : '*None*',
        inline: true,
      }
    )
    .setFooter({ text: 'Match District Arena • Volunteer Queue' });

  if (isAssigned || match.status !== ARENA_STATUS.WAITING_FOR_VOLUNTEER) {
    return { embeds: [embed], components: [] };
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`arena:claim_match:${match.matchId}`)
      .setLabel('Accept Match')
      .setStyle(ButtonStyle.Primary)
  );

  return { embeds: [embed], components: [row] };
}

export function buildMatchChannelEmbed(match, volunteerDisplayName = null) {
  const embed = new EmbedBuilder()
    .setTitle(`1v1 Match: ${match.matchId}`)
    .setColor(ARENA_CONSTANTS.ORANGE_COLOR)
    .setDescription(
      `**Status:** \`${match.status}\`\n` +
      `**Volunteer:** ${match.volunteerId ? volunteerDisplayName || `<@${match.volunteerId}>` : '*Waiting for volunteer...*'}`
    )
    .addFields(
      {
        name: `Player A: ${match.playerA.displayName}`,
        value: `• **IGN:** ${match.playerA.bgmiIgn}\n• **UID:** \`${match.playerA.bgmiUid}\`\n• **Mention:** <@${match.playerA.discordId}>`,
        inline: true,
      },
      {
        name: `Player B: ${match.playerB.displayName}`,
        value: `• **IGN:** ${match.playerB.bgmiIgn}\n• **UID:** \`${match.playerB.bgmiUid}\`\n• **Mention:** <@${match.playerB.discordId}>`,
        inline: true,
      }
    );

  if (match.roomId && match.roomPassword) {
    embed.addFields({
      name: 'Room Credentials',
      value: `• **Room ID:** \`${match.roomId}\`\n• **Password:** \`${match.roomPassword}\``,
      inline: false,
    });
  }

  embed.setFooter({ text: 'Use buttons below to officiate this match' });

  // Volunteer Controls
  const buttons = [];
  if (match.status === ARENA_STATUS.VOLUNTEER_ASSIGNED || match.status === ARENA_STATUS.ROOM_READY) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`arena:submit_room:${match.matchId}`)
        .setLabel(match.roomId ? 'Edit Room Details' : 'Submit Room Details')
        .setStyle(ButtonStyle.Primary)
    );
  }

  if (match.status === ARENA_STATUS.ROOM_READY) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`arena:start_match:${match.matchId}`)
        .setLabel('Start Match')
        .setStyle(ButtonStyle.Success)
    );
  }

  if (match.status === ARENA_STATUS.LIVE) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`arena:submit_winner:${match.matchId}`)
        .setLabel('Submit Winner')
        .setStyle(ButtonStyle.Primary)
    );
  }

  // Release Match allowed until match is LIVE
  if (
    match.status === ARENA_STATUS.VOLUNTEER_ASSIGNED ||
    match.status === ARENA_STATUS.ROOM_READY
  ) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`arena:release_match:${match.matchId}`)
        .setLabel('Release Match')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  const components = buttons.length ? [new ActionRowBuilder().addComponents(buttons)] : [];
  return { embeds: [embed], components };
}

export function buildResultVerificationPayload(match, winnerPlayer, evidenceUrl = null) {
  const embed = new EmbedBuilder()
    .setTitle(`Result Submitted: ${match.matchId}`)
    .setColor(ARENA_CONSTANTS.ORANGE_COLOR)
    .setDescription(
      `The assigned volunteer has reported **${winnerPlayer.displayName}** (<@${winnerPlayer.discordId}>) as the winner.\n\n` +
      `Both players must confirm the result below. If you believe this is incorrect, click **Dispute**.\n` +
      `*Auto-review triggers if not confirmed within 15 minutes.*`
    )
    .addFields(
      { name: 'Reported Winner', value: `${winnerPlayer.displayName} (\`${winnerPlayer.bgmiIgn}\`)`, inline: true },
      { name: 'Evidence', value: evidenceUrl ? `[View Screenshot](${evidenceUrl})` : '*Attached by staff*', inline: true }
    )
    .setFooter({ text: 'Match District Arena Verification' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`arena:confirm_result:${match.matchId}`)
      .setLabel('Confirm Result')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`arena:dispute_result:${match.matchId}`)
      .setLabel('Dispute')
      .setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [row] };
}

export function buildCompletedMatchResultEmbed(match, winnerPlayer, opponentPlayer, volunteerDisplayName) {
  return new EmbedBuilder()
    .setTitle(`Match Result: ${match.matchId}`)
    .setColor(ARENA_CONSTANTS.ORANGE_COLOR)
    .addFields(
      { name: 'Winner', value: `🏆 **${winnerPlayer.displayName}** (<@${winnerPlayer.discordId}>)`, inline: true },
      { name: 'Opponent', value: `${opponentPlayer.displayName} (<@${opponentPlayer.discordId}>)`, inline: true },
      { name: 'Officiated By', value: volunteerDisplayName || `<@${match.volunteerId}>`, inline: true },
      { name: 'Status', value: '`Result: VERIFIED`', inline: true },
      { name: 'Completed', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true }
    )
    .setFooter({ text: 'Match District 1v1 Arena' });
}

export function buildDisputeEvidenceEmbed(match, reportedBy, reason, evidenceUrl = null) {
  const embed = new EmbedBuilder()
    .setTitle(`⚠️ Dispute Filed: ${match.matchId}`)
    .setColor(0xED4245)
    .addFields(
      { name: 'Match ID', value: match.matchId, inline: true },
      { name: 'Reported By', value: `<@${reportedBy}>`, inline: true },
      { name: 'Volunteer', value: match.volunteerId ? `<@${match.volunteerId}>` : '*None*', inline: true },
      { name: 'Player A', value: `${match.playerA.displayName} (<@${match.playerA.discordId}>)`, inline: true },
      { name: 'Player B', value: `${match.playerB.displayName} (<@${match.playerB.discordId}>)`, inline: true },
      { name: 'Reason', value: reason || '*No specific reason stated*', inline: false }
    )
    .setFooter({ text: 'Use .arena result <id> <A|B> <reason> to resolve' });

  if (evidenceUrl) {
    embed.addFields({ name: 'Evidence Link', value: `[View Screenshot](${evidenceUrl})`, inline: false });
  }

  return embed;
}

export async function safeDirectMessage(client, userId, messagePayload) {
  if (!client || !userId) return false;
  try {
    const user = client.users?.cache?.get(userId) || (await client.users?.fetch?.(userId).catch(() => null));
    if (!user) return false;
    await queueDirectMessage(user, messagePayload);
    return true;
  } catch (err) {
    // Gracefully ignore closed DMs (code 50007)
    return false;
  }
}

