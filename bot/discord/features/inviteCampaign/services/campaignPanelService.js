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
  getEligibleParticipantsForCampaign,
  getParticipantsForCampaign,
  getReferralsForCampaign,
} from '../models/inviteCampaignModels.js';
import { formatISTDateTime } from './timeUtils.js';

/**
 * Formats the display status string for the Invite Panel according to Section 3:
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
    .setTitle(`🎁 ${campaign.name}`)
    .setDescription(campaign.description || 'Invite new members to the server using your personal invite link to qualify for the giveaway!')
    .setColor(color)
    .addFields(
      { name: '📌 Status', value: statusText, inline: true },
      {
        name: '🎯 Required Invites',
        value: `**${campaign.requiredInvites}** successful invite${campaign.requiredInvites === 1 ? '' : 's'}`,
        inline: true,
      },
      {
        name: '⏰ Ends At (IST)',
        value: formatISTDateTime(campaign.endAt),
        inline: true,
      },
      {
        name: '📋 Qualification Rules',
        value:
          `• Invited members must stay in the server for at least **${campaign.stayHours ?? 24} hour(s)**.\n` +
          `• Invited accounts must be at least **${campaign.minAccountAgeDays ?? 7} day(s)** old.\n` +
          `• Bots, self-invites, and members already in the server do not count.`,
        inline: false,
      }
    )
    .setFooter({ text: 'MatchDistrict Invite & Earn Campaign' })
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
    // If panelMessageId is set and options.allowCreateIfMissing is false, do not create a duplicate
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
 * Posts the final campaign result summary in the announcement channel when the campaign ends.
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

  const [eligibleParticipants, allParticipants, referrals] = await Promise.all([
    getEligibleParticipantsForCampaign(campaign.campaignId),
    getParticipantsForCampaign(campaign.campaignId),
    getReferralsForCampaign(campaign.campaignId),
  ]);

  const countedReferrals = referrals.filter((r) => r.isActive && r.counted && !r.disqualified).length;

  const eligibleLines =
    eligibleParticipants.length > 0
      ? eligibleParticipants
          .slice(0, 25)
          .map(
            (p, idx) =>
              `**${idx + 1}.** <@${p.userId}> — **${p.successfulInvites} / ${campaign.requiredInvites}** invites *(Qualified: ${formatISTDateTime(p.eligibleAt)})*`
          )
          .join('\n')
      : '*No members reached the required invite target during this campaign.*';

  const embed = new EmbedBuilder()
    .setTitle(`🏁 Campaign Ended — ${campaign.name}`)
    .setColor(0xed4245)
    .setDescription(
      `The **${campaign.name}** Invite & Earn campaign has officially ended and all final counts and eligibility have been frozen.`
    )
    .addFields(
      { name: '🎯 Target Invites', value: `${campaign.requiredInvites}`, inline: true },
      { name: '✅ Total Eligible Members', value: `${eligibleParticipants.length}`, inline: true },
      { name: '👥 Total Verified Referrals', value: `${countedReferrals}`, inline: true },
      {
        name: '🕒 Ended At (IST)',
        value: formatISTDateTime(campaign.endedAt || new Date()),
        inline: false,
      },
      {
        name: `🏆 Eligible Members (${eligibleParticipants.length})`,
        value: eligibleLines.slice(0, 1024),
        inline: false,
      }
    )
    .setFooter({ text: `Total Participants: ${allParticipants.length} • Use .invite eligible for full details` })
    .setTimestamp(new Date());

  return queueChannelSend(anncChannel, { embeds: [embed] }).catch((err) => {
    console.warn(`[InviteCampaign] ⚠️ Failed to post final campaign result:`, err.message);
    return null;
  });
}
