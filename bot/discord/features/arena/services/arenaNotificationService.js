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
  formatMatchId,
  atomicClaimChallengeNotification,
  atomicClaimRoomMakerNotification,
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
    .setTitle('1v1 BGMI TDM Challenge')
    .setColor(ARENA_CONSTANTS.ORANGE_COLOR)
    .setDescription(
      'Instant 1v1 BGMI TDM challenges officiated by verified Room Makers.\n\n' +
      '• Click **Create Challenge** to post an open challenge.\n' +
      '• Click **Update BGMI Details** to manage your registered IGN and UID.'
    )
    .setFooter({ text: 'Match District TDM' });

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

export function buildArenaInfoPanel(channelIds = {}) {
  const createMention = channelIds.createChannelId ? `<#${channelIds.createChannelId}>` : '#create';
  const availableMention = channelIds.availableChannelId ? `<#${channelIds.availableChannelId}>` : '#available-matches';
  const resultsMention = channelIds.matchResultsId ? `<#${channelIds.matchResultsId}>` : '#match-results';

  const embed = new EmbedBuilder()
    .setTitle('MATCH DISTRICT – 1V1 TDM')
    .setColor(ARENA_CONSTANTS.ORANGE_COLOR)
    .setDescription(
      'Welcome to Match District 1V1 TDM!\n' +
      'Challenge other players to a BGMI TDM 1v1 match. Follow these simple steps to get started.\n\n' +
      `**1. Create a Challenge**\n` +
      `Go to ${createMention} and click **Create Challenge**. Enter your BGMI IGN and UID if this is your first time.\n\n` +
      `**2. Accept a Challenge**\n` +
      `Visit ${availableMention} and accept an available challenge. Two players are required for every match.\n\n` +
      `**3. Wait for a Room Maker**\n` +
      `Once another player accepts, wait for a Room Maker to claim your match and prepare the custom room.\n\n` +
      `**4. Join the Match**\n` +
      `The bot will share the Room ID and Password in your private match channel. Join the room and play fairly.\n\n` +
      `**5. Report Incorrect Credentials**\n` +
      `If the Room ID or Password does not work, use the **Report Incorrect ID/Password** button in your match channel.\n\n` +
      `**6. Verify the Result**\n` +
      `After the match, the Room Maker submits the winner and screenshot proof. Check the evidence and select **Confirm Result** or **Dispute Result**.\n\n` +
      `**7. Check Match Results**\n` +
      `Completed matches will appear in ${resultsMention}.\n\n` +
      `**Important Rules**\n` +
      `• Only participate in your own assigned match.\n` +
      `• Never share private room credentials outside your match.\n` +
      `• Do not submit fake results or evidence.\n` +
      `• Report incorrect credentials immediately.\n` +
      `• Respect other players and Room Makers.\n` +
      `• Follow administrator instructions during disputes.`
    )
    .setFooter({ text: 'Match District TDM • Fair Play & Sportsmanship' });

  return { embeds: [embed] };
}

/**
 * Notifies online members via @here when a new challenge is created in #available-matches.
 * Guarantees exactly-once send via atomic DB claim.
 */
export async function sendChallengeCreationNotification(guild, challenge, availableChannel) {
  if (!guild || !challenge || !availableChannel) return false;

  const claimed = await atomicClaimChallengeNotification(challenge.challengeId);
  if (!claimed.ok) {
    return false;
  }

  const content = `@here A new BGMI TDM 1V1 challenge is available! Head over to <#${availableChannel.id}> and accept the challenge.`;
  try {
    await queueChannelSend(availableChannel, {
      content,
      allowedMentions: { parse: ['everyone'] },
    });
    return true;
  } catch (err) {
    console.warn(`[Arena] ⚠️ Failed to send challenge creation @here notification in ${availableChannel.id}:`, err?.message || err);
    return false;
  }
}

/**
 * Notifies online members via @here when a match enters WAITING_FOR_VOLUNTEER in #room-maker-panel.
 * Guarantees exactly-once send per WAITING_FOR_VOLUNTEER transition via atomic DB claim.
 */
export async function sendRoomMakerNeededNotification(guild, match, volunteerPanel) {
  if (!guild || !match || !volunteerPanel) return false;

  const claimed = await atomicClaimRoomMakerNotification(match.matchId);
  if (!claimed.ok) {
    return false;
  }

  const content = `@here A BGMI TDM 1V1 match needs a Room Maker! Visit <#${volunteerPanel.id}> and claim an available match.`;
  try {
    await queueChannelSend(volunteerPanel, {
      content,
      allowedMentions: { parse: ['everyone'] },
    });
    return true;
  } catch (err) {
    console.warn(`[Arena] ⚠️ Failed to send Room Maker needed @here notification in ${volunteerPanel.id}:`, err?.message || err);
    return false;
  }
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
  return buildMatchCardPayload(match, volunteerDisplayName, options);
}

export function buildRoomCredentialsEmbed(match, roomId, roomPassword) {
  const formattedMatchId = formatMatchId(match?.matchId);
  return new EmbedBuilder()
    .setTitle('BGMI ROOM DETAILS')
    .setColor(ARENA_CONSTANTS.ORANGE_COLOR)
    .setDescription(
      'Both players should join the BGMI custom room.\n' +
      'If the credentials do not work, use the **Report Incorrect ID/Password** button below.'
    )
    .addFields(
      { name: 'Match ID', value: formattedMatchId, inline: true },
      { name: 'Room ID', value: String(roomId), inline: true },
      { name: 'Room Password', value: String(roomPassword), inline: true }
    )
    .setFooter({ text: 'Match District TDM' });
}

export async function purgeStandaloneRoomMakerMessages(channel, dashboardMessageId) {
  if (!channel || !channel.messages) return;
  try {
    const messages = typeof channel.messages.fetch === 'function'
      ? await channel.messages.fetch({ limit: 50 }).catch(() => null)
      : channel.messages.cache;
    if (!messages) return;
    const msgList = Array.isArray(messages) ? messages : Array.from(messages.values ? messages.values() : []);
    for (const msg of msgList) {
      if (msg && msg.author?.bot && msg.id !== dashboardMessageId) {
        await msg.delete().catch(() => {});
      }
    }
  } catch (err) {
    // Non-fatal cleanup
  }
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
      const payload = await buildMatchChannelEmbed(match, volunteerDisplayName, { ...renderOptions, surface: 'matchChannel' });
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

  // 2. Room Maker's private channel card
  const rmChannelId = match.roomMakerChannelId || match.roomChannelId;
  if (rmChannelId) {
    const rmChannel = await resolveChannel(guild, rmChannelId);
    if (rmChannel) {
      const payload = await buildMatchChannelEmbed(match, volunteerDisplayName, { ...renderOptions, surface: 'roomMakerChannel' });
      const msg = await resolveMessage(rmChannel, match.roomMakerMessageId);
      let currentDashboardId = match.roomMakerMessageId;
      if (msg) {
        await queueMessageEdit(msg, payload);
        result.roomMakerChannel = true;
      } else if (options.allowCreateIfMissing) {
        const sent = await queueChannelSend(rmChannel, payload);
        if (sent?.id) {
          idUpdates.roomMakerMessageId = sent.id;
          currentDashboardId = sent.id;
          result.roomMakerChannel = true;
        }
      }
      if (currentDashboardId) {
        await purgeStandaloneRoomMakerMessages(rmChannel, currentDashboardId);
      }
    }
  }

  // 3. #room-maker-panel card (Completed matches removed; active matches kept at bottom)
  const config = await getArenaConfig(guild.id);
  if (config?.volunteerPanelId) {
    const panel = await resolveChannel(guild, config.volunteerPanelId);
    if (panel) {
      if (ARENA_FINAL_STATUSES.includes(match.status)) {
        if (match.panelMessageId) {
          const msg = await resolveMessage(panel, match.panelMessageId);
          if (msg) {
            await msg.delete().catch(() => {});
          }
          idUpdates.panelMessageId = null;
        }
      } else {
        const payload = await buildVolunteerPanelEmbed(match, volunteerDisplayName, renderOptions);
        if (match.panelMessageId || (options.allowCreateIfMissing && !ARENA_FINAL_STATUSES.includes(match.status))) {
          const finalId = await repositionPanelMessage(
            panel,
            match.panelMessageId,
            payload,
            (newId) => {
              idUpdates.panelMessageId = newId;
            }
          );
          if (finalId) result.volunteerPanel = true;
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
 * Re-renders an #available-challenges card and ensures the dashboard remains at the bottom of the channel.
 * Moves existing dashboard to the bottom when new messages appear above it, editing in place otherwise.
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

  if (challenge.discordMessageId || (options.allowCreateIfMissing && challenge.status === ARENA_STATUS.OPEN)) {
    const finalId = await repositionPanelMessage(
      channel,
      challenge.discordMessageId,
      payload,
      async (newId) => {
        await updateArenaChallenge(challenge.challengeId, {
          discordMessageId: newId,
          discordChannelId: channel.id,
        }).catch((err) => console.warn('[Arena] ⚠️ Failed to persist refreshed challenge message id:', err.message));
      }
    );
    return Boolean(finalId);
  }
  return false;
}

export async function repositionPanelMessage(channel, storedMessageId, newPayload, onNewId = null) {
  if (!channel || !newPayload) return null;

  let existing = null;
  if (storedMessageId) {
    existing =
      channel.messages?.cache?.get(storedMessageId) ||
      (await channel.messages?.fetch?.(storedMessageId).catch(() => null));
  }

  // Determine the ID of the last message in the channel
  let lastId = channel.lastMessageId || channel.lastMessage?.id || null;
  if (!lastId && channel.messages?.cache) {
    if (typeof channel.messages.cache.last === 'function') {
      lastId = channel.messages.cache.last()?.id || null;
    } else {
      const arr = Array.from(channel.messages.cache.values?.() || []);
      lastId = arr.length > 0 ? arr[arr.length - 1]?.id : null;
    }
  }

  const isAtBottom = existing && lastId && (lastId === existing.id);

  if (existing && isAtBottom) {
    // Already the latest message: edit in place without recreation
    await queueMessageEdit(existing, newPayload).catch(() => {});
    return existing.id;
  }

  // Not at bottom or missing: create replacement at bottom first
  const sent = await queueChannelSend(channel, newPayload);
  if (sent?.id) {
    // Delete previous dashboard message only after replacement is successfully created
    if (existing) {
      await existing.delete().catch(() => {});
    }
    if (typeof onNewId === 'function') {
      await onNewId(sent.id);
    }
    return sent.id;
  }

  return existing?.id || null;
}

export function buildArenaStatusEmbed({
  title,
  description,
  fields = [],
  color = ARENA_CONSTANTS.ORANGE_COLOR,
  footer = 'MatchDistrict 1v1 TDM',
}) {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setFooter({ text: footer });
  if (description) embed.setDescription(description);
  if (fields && fields.length > 0) embed.addFields(fields);
  return embed;
}

export function buildResultVerificationPayload(match, winnerPlayer, evidenceUrl = null) {
  const winnerIgn = winnerPlayer.bgmiIgn || winnerPlayer.displayName;
  const embed = new EmbedBuilder()
    .setTitle(`Match Result Submitted: ${match.matchId}`)
    .setColor(ARENA_CONSTANTS.ORANGE_COLOR)
    .setDescription(
      `The assigned Room Maker has reported **${winnerIgn}** as the winner.\n\n` +
      `Both players must confirm the result below. If you believe this result is incorrect, click **Dispute Result**.\n` +
      `*Automatic staff review triggers if not confirmed within 15 minutes.*`
    )
    .addFields(
      { name: 'Reported Winner', value: `🏆 **${winnerIgn}** (<@${winnerPlayer.discordId}>)`, inline: true },
      { name: 'Proof Screenshot', value: evidenceUrl ? `[View Evidence Attachment](${evidenceUrl})` : '*Uploaded by Room Maker*', inline: true }
    )
    .setFooter({ text: 'MatchDistrict 1v1 TDM Verification' });

  if (evidenceUrl && (evidenceUrl.startsWith('http://') || evidenceUrl.startsWith('https://'))) {
    embed.setImage(evidenceUrl);
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`arena:confirm_result:${match.matchId}`)
      .setLabel('Confirm Result')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`arena:dispute_result:${match.matchId}`)
      .setLabel('Dispute Result')
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
    .setFooter({ text: 'Match District 1v1 TDM' });
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
    .setFooter({ text: 'Use .tdm result <id> <A|B> <reason> to resolve' });

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

