import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
} from 'discord.js';
import {
  ARENA_CONSTANTS,
  ARENA_STATUS,
  ARENA_FINAL_STATUSES,
  getArenaConfig,
  updateArenaMatch,
  updateArenaChallenge,
} from '../models/arenaModels.js';
import {
  generateMatchCardPng,
  generateChallengeCardPng,
  buildMatchCardPayload,
  buildChallengeCardPayload,
  buildMatchResultPayload,
} from './arenaImageService.js';
import { queueDirectMessage, queueChannelSend, queueMessageEdit } from '../../../../../discordQueue.js';

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

// All builders hydrate live Discord + MongoDB data (display names, avatars, IGN/UID,
// volunteer name) and render through the single bundled-font renderer in arenaImageService.
export async function buildChallengeEmbed(challenge, creatorDisplayName = null, options = {}) {
  return buildChallengeCardPayload(challenge, creatorDisplayName, options);
}

export async function buildVolunteerPanelEmbed(match, volunteerDisplayName = null, options = {}) {
  return buildMatchCardPayload(match, volunteerDisplayName, { ...options, surface: 'volunteerPanel' });
}

export async function buildMatchChannelEmbed(match, volunteerDisplayName = null, options = {}) {
  return buildMatchCardPayload(match, volunteerDisplayName, { ...options, surface: 'matchChannel' });
}

async function resolveChannel(guild, channelId) {
  if (!guild || !channelId) return null;
  return guild.channels?.cache?.get(channelId) || (await guild.channels?.fetch?.(channelId).catch(() => null));
}

async function resolveMessage(channel, messageId) {
  if (!channel || !messageId) return null;
  return channel.messages?.cache?.get(messageId) || (await channel.messages?.fetch?.(messageId).catch(() => null));
}

/**
 * Re-renders the match image card and EDITS the existing managed messages in place
 * (private match channel + #volunteer-panel). Buttons are rebuilt from current status.
 * With allowCreateIfMissing, a deleted managed message is re-created and its id persisted.
 */
export async function refreshArenaMatchCards(guild, match, options = {}) {
  if (!guild || !match) return { matchChannel: false, volunteerPanel: false };
  const client = options.client || guild.client;
  const renderOptions = { guild, client, avatars: options.avatars };
  const volunteerDisplayName = options.volunteerDisplayName || null;
  const result = { matchChannel: false, volunteerPanel: false };
  const idUpdates = {};

  // 1. Private match channel card
  if (match.matchChannelId) {
    const channel = await resolveChannel(guild, match.matchChannelId);
    if (channel) {
      const payload = await buildMatchChannelEmbed(match, volunteerDisplayName, renderOptions);
      const msg = await resolveMessage(channel, match.matchEmbedMessageId);
      if (msg) {
        await queueMessageEdit(msg, payload);
        result.matchChannel = true;
      } else if (options.allowCreateIfMissing) {
        const sent = await queueChannelSend(channel, payload);
        if (sent?.id) {
          idUpdates.matchEmbedMessageId = sent.id;
          result.matchChannel = true;
        }
      }
    }
  }

  // 2. #volunteer-panel card
  const config = await getArenaConfig(guild.id);
  if (config?.volunteerPanelId) {
    const panel = await resolveChannel(guild, config.volunteerPanelId);
    if (panel) {
      const payload = await buildVolunteerPanelEmbed(match, volunteerDisplayName, renderOptions);
      const msg = await resolveMessage(panel, match.panelMessageId);
      if (msg) {
        await queueMessageEdit(msg, payload);
        result.volunteerPanel = true;
      } else if (options.allowCreateIfMissing && !ARENA_FINAL_STATUSES.includes(match.status)) {
        const sent = await queueChannelSend(panel, payload);
        if (sent?.id) {
          idUpdates.panelMessageId = sent.id;
          result.volunteerPanel = true;
        }
      }
    }
  }

  if (Object.keys(idUpdates).length > 0) {
    await updateArenaMatch(match.matchId, idUpdates).catch((err) =>
      console.warn('[Arena] ⚠️ Failed to persist refreshed message ids:', err.message)
    );
  }
  return result;
}

/**
 * Re-renders an #available-challenges card and edits the existing managed message in place.
 * With allowCreateIfMissing, an OPEN challenge whose message was deleted gets a fresh card.
 */
export async function refreshArenaChallengeCard(guild, challenge, options = {}) {
  if (!guild || !challenge) return false;
  const client = options.client || guild.client;
  const channel = await resolveChannel(guild, challenge.discordChannelId);
  if (!channel) return false;

  const payload = await buildChallengeEmbed(challenge, options.creatorDisplayName || null, {
    guild,
    client,
    avatars: options.avatars,
    acceptedOpponent: options.acceptedOpponent || null,
  });
  const msg = await resolveMessage(channel, challenge.discordMessageId);
  if (msg) {
    await queueMessageEdit(msg, payload);
    return true;
  }
  if (options.allowCreateIfMissing && challenge.status === ARENA_STATUS.OPEN) {
    const sent = await queueChannelSend(channel, payload);
    if (sent?.id) {
      await updateArenaChallenge(challenge.challengeId, {
        discordMessageId: sent.id,
        discordChannelId: channel.id,
      }).catch((err) => console.warn('[Arena] ⚠️ Failed to persist refreshed challenge message id:', err.message));
      return true;
    }
  }
  return false;
}

export async function repositionPanelMessage(channel, storedMessageId, newPayload, onNewId = null) {
  if (!channel || !newPayload) return null;

  let existing = null;
  if (storedMessageId) {
    existing = channel.messages?.cache?.get(storedMessageId) || (await channel.messages?.fetch?.(storedMessageId).catch(() => null));
  }

  // Check if channel's last message is this message
  const lastMessageId = channel.lastMessageId || channel.lastMessage?.id || null;
  const isAtBottom = existing && lastMessageId && (lastMessageId === existing.id);

  if (existing && isAtBottom) {
    await queueMessageEdit(existing, newPayload).catch(() => {});
    return existing.id;
  }

  // Otherwise delete old managed message and recreate cleanly at the bottom
  if (existing) {
    await existing.delete().catch(() => {});
  }

  const sent = await queueChannelSend(channel, newPayload);
  if (sent?.id && typeof onNewId === 'function') {
    await onNewId(sent.id);
  }
  return sent?.id || null;
}

export function buildResultVerificationPayload(match, winnerPlayer, evidenceUrl = null) {
  const winnerIgn = winnerPlayer.bgmiIgn || winnerPlayer.displayName;
  const embed = new EmbedBuilder()
    .setTitle(`Result Submitted: ${match.matchId}`)
    .setColor(ARENA_CONSTANTS.ORANGE_COLOR)
    .setDescription(
      `The assigned Room Maker has reported **${winnerIgn}** (<@${winnerPlayer.discordId}>) as the winner.\n\n` +
      `Both players must confirm the result below. If you believe this is incorrect, click **Dispute**.\n` +
      `*Auto-review triggers if not confirmed within 15 minutes.*`
    )
    .addFields(
      { name: 'Reported Winner', value: `🏆 **${winnerIgn}** (<@${winnerPlayer.discordId}>)`, inline: true },
      { name: 'Evidence', value: evidenceUrl ? `[View Screenshot](${evidenceUrl})` : '*Attached by Room Maker*', inline: true }
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

export async function buildCompletedMatchResultPayload(match, winnerPlayer, opponentPlayer, volunteerDisplayName, options = {}) {
  return buildMatchResultPayload(match, winnerPlayer, opponentPlayer, {
    ...options,
    roomMakerDisplayName: volunteerDisplayName,
  });
}

export function buildCompletedMatchResultEmbed(match, winnerPlayer, opponentPlayer, volunteerDisplayName) {
  const winnerIgn = winnerPlayer.bgmiIgn || winnerPlayer.displayName;
  const oppIgn = opponentPlayer.bgmiIgn || opponentPlayer.displayName;
  return new EmbedBuilder()
    .setTitle(`Match Result: ${match.matchId}`)
    .setColor(ARENA_CONSTANTS.ORANGE_COLOR)
    .addFields(
      { name: 'Winner', value: `🏆 **${winnerIgn}** (<@${winnerPlayer.discordId}>)`, inline: true },
      { name: 'Opponent', value: `**${oppIgn}** (<@${opponentPlayer.discordId}>)`, inline: true },
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

