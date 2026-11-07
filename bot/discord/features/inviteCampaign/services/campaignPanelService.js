import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { queueChannelSend, queueMessageEdit } from '../../../../../discordQueue.js';
import {
  CAMPAIGN_STATUS,
  updateInviteCampaign,
  getParticipantsForCampaign,
  getReferralsForCampaign,
} from '../models/inviteCampaignModels.js';
import { formatISTDateTime } from './timeUtils.js';

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
 * Simple user-facing design: no eligibility targets or qualification clutter.
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

  const embed = new EmbedBuilder()
    .setTitle(`🔗 ${campaign.name}`)
    .setDescription(
      campaign.description ||
        'Click **Generate My Invite** below to get your personal invite link and track your successful invites!'
    )
    .setColor(color)
    .addFields(
      { name: '📌 Status', value: statusText, inline: true },
      {
        name: '⏰ Ends At (IST)',
        value: formatISTDateTime(campaign.endAt),
        inline: true,
      }
    )
    .setFooter({ text: 'MatchDistrict Invite Tracker' })
    .setTimestamp(new Date());

  const button = new ButtonBuilder()
    .setCustomId(`inv_cmp:generate:${campaign.campaignId}`)
    .setLabel('Generate My Invite')
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
 * Posts the final campaign invite totals in the announcement channel when the campaign ends.
 *
 * @param {import('discord.js').Client} client
 * @param {object} campaign
 */
export async function postCampaignFinalResults(client, campaign) {
  if (!client || !campaign || !campaign.announcementChannelId) return null;

  const guild =
    client.guilds?.cache?.get(campaign.guildId) ||
    (typeof client.guilds?.fetch === 'function'
      ? await client.guilds.fetch(campaign.guildId).catch(() => null)
      : null);
  if (!guild) return null;

  const anncChannel =
    guild.channels?.cache?.get(campaign.announcementChannelId) ||
    (typeof guild.channels?.fetch === 'function'
      ? await guild.channels.fetch(campaign.announcementChannelId).catch(() => null)
      : null);
  if (!anncChannel) return null;

  const [allParticipants, referrals] = await Promise.all([
    getParticipantsForCampaign(campaign.campaignId),
    getReferralsForCampaign(campaign.campaignId),
  ]);

  const activeCountedReferrals = referrals.filter((r) => r.isActive && r.counted && !r.disqualified).length;
  const topParticipants = allParticipants.filter((p) => !p.disqualified && p.successfulInvites > 0);

  const topLines =
    topParticipants.length > 0
      ? topParticipants
          .slice(0, 25)
          .map(
            (p, idx) =>
              `**${idx + 1}.** <@${p.userId}> — **${p.successfulInvites}** successful invite${p.successfulInvites === 1 ? '' : 's'}`
          )
          .join('\n')
      : '*No successful invites were recorded during this campaign.*';

  const embed = new EmbedBuilder()
    .setTitle(`🏁 Invite Campaign Ended — ${campaign.name}`)
    .setColor(0xed4245)
    .setDescription(
      `The **${campaign.name}** campaign has ended and final invite counts have been frozen.`
    )
    .addFields(
      { name: '👥 Total Successful Joins', value: `${activeCountedReferrals}`, inline: true },
      { name: '🔗 Active Inviters', value: `${topParticipants.length}`, inline: true },
      {
        name: '🕒 Ended At (IST)',
        value: formatISTDateTime(campaign.endedAt || new Date()),
        inline: true,
      },
      {
        name: '📊 Final Invite Totals',
        value: topLines.slice(0, 1024),
        inline: false,
      }
    )
    .setFooter({ text: 'MatchDistrict Invite Tracker' })
    .setTimestamp(new Date());

  return queueChannelSend(anncChannel, { embeds: [embed] }).catch((err) => {
    console.warn(`[InviteCampaign] ⚠️ Failed to post final campaign result:`, err.message);
    return null;
  });
}
