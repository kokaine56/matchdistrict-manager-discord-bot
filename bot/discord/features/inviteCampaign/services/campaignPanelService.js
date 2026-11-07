import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
} from 'discord.js';
import { queueChannelSend, queueMessageEdit } from '../../../../../discordQueue.js';
import {
  CAMPAIGN_STATUS,
  getInviteCampaignById,
  updateInviteCampaign,
  getParticipantsForCampaign,
} from '../models/inviteCampaignModels.js';
import { formatISTDateTime } from './timeUtils.js';
import {
  computeCampaignLeaderboardRows,
  generateLeaderboardPng,
} from './leaderboardImageService.js';

/**
 * Formats the display status string for the Invite Panel:
 * "Active / Paused / Ended / Starts <date>"
 *
 * @param {object} campaign
 * @returns {string}
 */
export function formatPanelStatusDisplay(campaign) {
  if (!campaign) return 'Unknown';
  switch (campaign.status) {
    case CAMPAIGN_STATUS.ACTIVE:
      return '🟢 Active';
    case CAMPAIGN_STATUS.PAUSED:
      return '⏸️ Paused';
    case CAMPAIGN_STATUS.ENDED:
      return '🔴 Ended';
    case CAMPAIGN_STATUS.SCHEDULED:
      return `🕒 Starts ${formatISTDateTime(campaign.startAt)}`;
    case CAMPAIGN_STATUS.DRAFT:
      return campaign.startAt
        ? `📝 Draft (Starts ${formatISTDateTime(campaign.startAt)})`
        : '📝 Draft (Starts TBA)';
    default:
      return String(campaign.status);
  }
}

/**
 * Builds the Embed and ActionRow payload for the persistent Invite Panel message.
 * Button label is "Create Link".
 *
 * @param {object} campaign
 * @returns {{ embeds: EmbedBuilder[], components: ActionRowBuilder[] }}
 */
export function buildCampaignPanelPayload(campaign) {
  const isActive = campaign.status === CAMPAIGN_STATUS.ACTIVE;
  const color =
    campaign.status === CAMPAIGN_STATUS.ACTIVE
      ? 0x2ecc71
      : campaign.status === CAMPAIGN_STATUS.PAUSED
        ? 0xf39c12
        : campaign.status === CAMPAIGN_STATUS.ENDED
          ? 0xed4245
          : 0x3498db;

  const statusText = formatPanelStatusDisplay(campaign);
  const prizes = Array.isArray(campaign.rewards)
    ? campaign.rewards
        .filter((reward) => Number.isInteger(Number(reward.position)) && Number(reward.position) > 0 && Number.isFinite(Number(reward.amount)) && Number(reward.amount) >= 0)
        .sort((a, b) => Number(a.position) - Number(b.position))
    : [];
  const ordinal = (rank) => {
    const mod100 = rank % 100;
    const suffix = mod100 >= 11 && mod100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[rank % 10] || 'th');
    return `${rank}${suffix} Place`;
  };

  const embed = new EmbedBuilder()
    .setTitle(`🔗 ${campaign.name}`)
    .setDescription(
      campaign.description ||
        'Click **Create Link** below to get your personal invite link and track your successful invites!'
    )
    .setColor(color)
    .addFields({ name: '📌 Status', value: statusText, inline: true });

  if (prizes.length) {
    embed.addFields({
      name: '🏆 Prize Distribution',
      value: prizes.map(({ position, amount }) => `${ordinal(Number(position))} — ₹${Number(amount)}`).join('\n'),
      inline: false,
    });
  }
  embed.addFields({ name: '⏰ Ends At (IST)', value: formatISTDateTime(campaign.endAt), inline: true });

  embed
    .setFooter({ text: 'MatchDistrict Invite Tracker' })
    .setTimestamp(new Date());

  const button = new ButtonBuilder()
    .setCustomId(`inv_cmp:generate:${campaign.campaignId}`)
    .setLabel('Create Link')
    .setEmoji('🔗')
    .setStyle(isActive ? ButtonStyle.Success : ButtonStyle.Secondary)
    .setDisabled(!isActive);

  const row = new ActionRowBuilder().addComponents(button);

  return {
    embeds: [embed],
    components: [row],
  };
}

/**
 * Ensures or updates the persistent Invite Panel message in place using the stored panelMessageId.
 * Never posts a duplicate if the stored message exists.
 *
 * @param {import('discord.js').Client} client
 * @param {object} campaign
 * @param {object} [options]
 * @param {boolean} [options.allowCreateIfMissing=true]
 * @returns {Promise<import('discord.js').Message|null>}
 */
export async function ensureOrUpdateCampaignPanel(client, campaign, options = {}) {
  if (!client || !campaign || !campaign.inviteChannelId) return null;
  const allowCreate = options.allowCreateIfMissing !== false;

  const guild =
    client.guilds?.cache?.get(campaign.guildId) ||
    (typeof client.guilds?.fetch === 'function'
      ? await client.guilds.fetch(campaign.guildId).catch(() => null)
      : null);
  if (!guild) return null;

  const inviteChannel =
    guild.channels?.cache?.get(campaign.inviteChannelId) ||
    (typeof guild.channels?.fetch === 'function'
      ? await guild.channels.fetch(campaign.inviteChannelId).catch(() => null)
      : null);
  if (!inviteChannel) return null;

  const payload = buildCampaignPanelPayload(campaign);

  // 1. Try editing the existing panel message by stored panelMessageId
  if (campaign.panelMessageId) {
    let existingMsg = inviteChannel.messages?.cache?.get?.(campaign.panelMessageId) || null;
    if (!existingMsg && typeof inviteChannel.messages?.fetch === 'function') {
      existingMsg = await inviteChannel.messages.fetch(campaign.panelMessageId).catch(() => null);
    }

    if (existingMsg) {
      await queueMessageEdit(existingMsg, payload).catch((err) => {
        console.warn(`[InviteCampaign] ⚠️ Failed to edit panel message ${campaign.panelMessageId}:`, err.message);
      });
      return existingMsg;
    }
    if (!allowCreate) {
      return null;
    }
  }

  // 2. Post initial panel message only when panelMessageId is not set yet (or was deleted and allowed)
  if (!allowCreate) return null;

  try {
    const sent = await queueChannelSend(inviteChannel, payload);
    if (sent?.id) {
      campaign.panelMessageId = sent.id;
      await updateInviteCampaign(campaign.campaignId, { panelMessageId: sent.id });
    }
    return sent;
  } catch (err) {
    console.warn(`[InviteCampaign] ⚠️ Failed to send panel message in channel ${campaign.inviteChannelId}:`, err.message);
    return null;
  }
}

/**
 * Builds the Discord message payload containing the generated PNG leaderboard image attachment
 * and the "Refresh Leaderboard" button below it.
 *
 * @param {object} campaign
 * @param {Array<object>} rows
 * @param {{ buffer: Buffer, width: number, height: number, rows: Array<object> }} pngResult
 */
export function buildLeaderboardMessagePayload(campaign, rows, pngResult) {
  const isEnded = campaign.status === CAMPAIGN_STATUS.ENDED;
  const attachment = new AttachmentBuilder(pngResult.buffer, {
    name: 'leaderboard.png',
  });
  attachment._leaderboardMeta = {
    campaignId: campaign.campaignId,
    status: isEnded ? 'EVENT ENDED' : String(campaign.status).toUpperCase(),
    width: pngResult.width,
    height: pngResult.height,
    rows: pngResult.rows,
  };

  const refreshBtn = new ButtonBuilder()
    .setCustomId(`inv_cmp:refresh_lb:${campaign.campaignId}`)
    .setLabel('Refresh Leaderboard')
    .setEmoji('🔄')
    .setStyle(isEnded ? ButtonStyle.Secondary : ButtonStyle.Primary)
    .setDisabled(isEnded);

  const actionRow = new ActionRowBuilder().addComponents(refreshBtn);

  return {
    content: '',
    embeds: [],
    files: [attachment],
    components: [actionRow],
    _leaderboardMeta: attachment._leaderboardMeta,
  };
}

async function fetchLeaderboardAvatars(client, rows) {
  const avatars = new Map();
  if (typeof globalThis.fetch !== 'function') return avatars;
  await Promise.all(rows.map(async (row) => {
    const userId = String(row.userId || '');
    if (!userId) return;
    let avatarUrl = null;
    try {
      const user = await client.users?.fetch?.(userId);
      avatarUrl = user?.displayAvatarURL?.({ extension: 'png', size: 64, forceStatic: true }) || null;
    } catch {
      // Fall back to Discord's deterministic default avatar for this user ID below.
    }
    const urls = avatarUrl ? [avatarUrl] : [];
    try {
      const defaultIndex = Number((BigInt(userId) >> 22n) % 6n);
      urls.push(`https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`);
    } catch {
      return;
    }
    for (const url of urls) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
        if (!response.ok) continue;
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length <= 1024 * 1024) {
          avatars.set(userId, bytes);
          return;
        }
      } catch {
        // Try the Discord default avatar when the custom avatar is unavailable.
      }
    }
  }));
  return avatars;
}

/**
 * Generates the PNG leaderboard image and posts or edits the managed announcement leaderboard message
 * in place using `campaign.leaderboardMessageId`.
 *
 * Rules enforced:
 * - Never sends a new message when refreshing if the managed leaderboard message exists.
 * - Preserves the same `leaderboardMessageId`.
 * - If the campaign is already `Ended` and not currently being finalized (`options.isFinalizing !== true`),
 *   uses the frozen `finalLeaderboardSnapshot` and refuses to overwrite finalized rankings.
 *
 * @param {import('discord.js').Client} client
 * @param {object} campaign
 * @param {object} [options]
 * @param {boolean} [options.allowCreateIfMissing=true]
 * @param {boolean} [options.isFinalizing=false]
 * @returns {Promise<{ message: any, rows: Array<object>, png: object } | null>}
 */
export async function ensureOrUpdateLeaderboardMessage(client, campaign, options = {}) {
  if (!client || !campaign || !campaign.announcementChannelId) return null;
  const allowCreate = options.allowCreateIfMissing !== false;
  const isFinalizing = Boolean(options.isFinalizing);

  const freshCampaign = (await getInviteCampaignById(campaign.campaignId)) || campaign;

  // Once a campaign is finalized and Ended, never allow non-finalizing refreshes to alter it
  if (
    freshCampaign.status === CAMPAIGN_STATUS.ENDED &&
    !isFinalizing &&
    freshCampaign.finalizedAt &&
    options.fromRefreshInteraction
  ) {
    return null;
  }

  const guild =
    client.guilds?.cache?.get(freshCampaign.guildId) ||
    (typeof client.guilds?.fetch === 'function'
      ? await client.guilds.fetch(freshCampaign.guildId).catch(() => null)
      : null);
  if (!guild) return null;

  const anncChannel =
    guild.channels?.cache?.get(freshCampaign.announcementChannelId) ||
    (typeof guild.channels?.fetch === 'function'
      ? await guild.channels.fetch(freshCampaign.announcementChannelId).catch(() => null)
      : null);
  if (!anncChannel) return null;

  let rows;
  if (
    freshCampaign.status === CAMPAIGN_STATUS.ENDED &&
    !isFinalizing &&
    Array.isArray(freshCampaign.finalLeaderboardSnapshot)
  ) {
    rows = freshCampaign.finalLeaderboardSnapshot;
  } else {
    const participants = await getParticipantsForCampaign(freshCampaign.campaignId);
    rows = computeCampaignLeaderboardRows(freshCampaign, participants, guild);
  }

  const avatars = await fetchLeaderboardAvatars(client, rows);
  const png = generateLeaderboardPng(freshCampaign, rows, avatars);
  const payload = buildLeaderboardMessagePayload(freshCampaign, rows, png);

  const dbUpdates = {
    currentLeaderboardSnapshot: rows,
  };
  if (freshCampaign.status === CAMPAIGN_STATUS.ENDED || isFinalizing) {
    dbUpdates.finalLeaderboardSnapshot = rows;
    if (!freshCampaign.finalizedAt) {
      dbUpdates.finalizedAt = new Date();
    }
  }

  const messageId = freshCampaign.leaderboardMessageId || campaign.leaderboardMessageId;

  // 1. Edit existing managed leaderboard message in place if present
  if (messageId) {
    let existingMsg = anncChannel.messages?.cache?.get?.(messageId) || null;
    if (!existingMsg && typeof anncChannel.messages?.fetch === 'function') {
      existingMsg = await anncChannel.messages.fetch(messageId).catch(() => null);
    }

    if (existingMsg) {
      let editError = null;
      await queueMessageEdit(existingMsg, payload).catch((err) => {
        editError = err;
        console.warn(
          `[InviteCampaign] ⚠️ Failed to edit leaderboard message ${messageId}:`,
          err.message
        );
      });
      if (editError && options.fromRefreshInteraction) {
        throw editError;
      }
      await updateInviteCampaign(freshCampaign.campaignId, dbUpdates);
      Object.assign(campaign, dbUpdates, { leaderboardMessageId: messageId });
      return { message: existingMsg, rows, png };
    }

    if (!allowCreate) {
      return null;
    }
  }

  if (!allowCreate) return null;

  // 2. Post initial managed leaderboard message only if none exists yet
  try {
    const sent = await queueChannelSend(anncChannel, payload);
    if (sent?.id) {
      dbUpdates.leaderboardMessageId = sent.id;
      await updateInviteCampaign(freshCampaign.campaignId, dbUpdates);
      Object.assign(campaign, dbUpdates);
    }
    return { message: sent, rows, png };
  } catch (err) {
    console.warn(
      `[InviteCampaign] ⚠️ Failed to send leaderboard message in channel ${freshCampaign.announcementChannelId}:`,
      err.message
    );
    return null;
  }
}

/**
 * Finalizes the campaign leaderboard in the announcement channel when the campaign ends:
 * - Generates the final leaderboard image with status `EVENT ENDED`.
 * - Updates the existing announcement message (`leaderboardMessageId`) one last time (or creates it if never posted).
 * - Disables the `Refresh Leaderboard` button.
 * - Stores `finalLeaderboardSnapshot` and `finalizedAt` in MongoDB.
 *
 * @param {import('discord.js').Client} client
 * @param {object} campaign
 */
export async function postCampaignFinalResults(client, campaign) {
  if (!client || !campaign || !campaign.announcementChannelId) return null;
  const res = await ensureOrUpdateLeaderboardMessage(client, campaign, {
    allowCreateIfMissing: true,
    isFinalizing: true,
  });
  return res?.message || null;
}
