import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { ARENA_CONSTANTS, ARENA_STATUS, getArenaConfig, updateArenaChallenge, updateArenaMatch } from '../models/arenaModels.js';
import {
  buildMatchCardPayload,
  buildChallengeCardPayload,
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

export async function buildChallengeEmbed(challenge, creatorDisplayName = null, options = {}) {
  return buildChallengeCardPayload(challenge, creatorDisplayName, options);
}

export async function buildVolunteerPanelEmbed(match, volunteerDisplayName = null, options = {}) {
  return buildMatchCardPayload(match, volunteerDisplayName, { ...options, surface: 'volunteerPanel' });
}

export async function buildMatchChannelEmbed(match, volunteerDisplayName = null, options = {}) {
  return buildMatchCardPayload(match, volunteerDisplayName, { ...options, surface: 'matchChannel' });
}

async function updateStoredCard(channel, messageId, payload, allowCreateIfMissing) {
  if (!channel) return null;
  let message = messageId ? channel.messages?.cache?.get?.(messageId) || null : null;
  if (!message && messageId && typeof channel.messages?.fetch === 'function') {
    message = await channel.messages.fetch(messageId).catch(() => null);
  }
  if (message) {
    await queueMessageEdit(message, payload);
    return message.id;
  }
  if (!allowCreateIfMissing) return null;
  const sent = await queueChannelSend(channel, payload);
  return sent?.id || null;
}

export async function refreshArenaChallengeCard(guild, challenge, { client = guild?.client, allowCreateIfMissing = false } = {}) {
  if (!guild || !challenge?.discordChannelId) return null;
  const channel = guild.channels?.cache?.get?.(challenge.discordChannelId) || await guild.channels?.fetch?.(challenge.discordChannelId).catch(() => null);
  if (!channel) return null;
  const payload = await buildChallengeEmbed(challenge, null, { guild, client });
  let messageId = null;
  try {
    messageId = await updateStoredCard(channel, challenge.discordMessageId, payload, allowCreateIfMissing);
  } catch (err) {
    console.warn(`[Arena] Failed to update challenge card ${challenge.challengeId}:`, err.message);
    return null;
  }
  if (messageId && messageId !== challenge.discordMessageId) {
    await updateArenaChallenge(challenge.challengeId, { discordMessageId: messageId, discordChannelId: channel.id });
    challenge.discordMessageId = messageId;
  }
  return messageId;
}

export async function refreshArenaMatchCards(guild, match, {
  client = guild?.client,
  volunteerDisplayName = null,
  updatePrivate = true,
  updateVolunteerPanel = true,
  allowCreateIfMissing = false,
} = {}) {
  if (!guild || !match?.matchId) return null;
  const updates = {};
  if (updatePrivate && match.matchChannelId) {
    const channel = guild.channels?.cache?.get?.(match.matchChannelId) || await guild.channels?.fetch?.(match.matchChannelId).catch(() => null);
    if (channel) {
      try {
        const payload = await buildMatchChannelEmbed(match, volunteerDisplayName, { guild, client });
        const messageId = await updateStoredCard(channel, match.matchEmbedMessageId, payload, allowCreateIfMissing);
        if (messageId && messageId !== match.matchEmbedMessageId) {
          updates.matchEmbedMessageId = messageId;
          match.matchEmbedMessageId = messageId;
        }
      } catch (err) {
        console.warn(`[Arena] Failed to update private match card ${match.matchId}:`, err.message);
      }
    }
  }
  if (updateVolunteerPanel && (match.panelMessageId || allowCreateIfMissing)) {
    const config = await getArenaConfig(guild.id);
    const channel = config?.volunteerPanelId
      ? guild.channels?.cache?.get?.(config.volunteerPanelId) || await guild.channels?.fetch?.(config.volunteerPanelId).catch(() => null)
      : null;
    if (channel) {
      const payload = await buildVolunteerPanelEmbed(match, volunteerDisplayName, { guild, client });
      let messageId = null;
      try {
        messageId = await updateStoredCard(channel, match.panelMessageId, payload, allowCreateIfMissing);
      } catch (err) {
        console.warn(`[Arena] Failed to update volunteer card ${match.matchId}:`, err.message);
      }
      if (messageId && messageId !== match.panelMessageId) {
        updates.panelMessageId = messageId;
        match.panelMessageId = messageId;
      }
    }
  }
  if (Object.keys(updates).length) await updateArenaMatch(match.matchId, updates);
  return updates;
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

