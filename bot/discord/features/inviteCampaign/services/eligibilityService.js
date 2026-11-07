import { EmbedBuilder } from 'discord.js';
import { queueDirectMessage, queueChannelSend } from '../../../../../discordQueue.js';
import {
  CAMPAIGN_STATUS,
  withCampaignLock,
  getInviteCampaignById,
  getReferralsByInviter,
  getCampaignParticipant,
  upsertCampaignParticipant,
  getReferralsForCampaign,
  getParticipantsForCampaign,
} from '../models/inviteCampaignModels.js';
import { formatISTDateTime } from './timeUtils.js';

/**
 * Atomically recalculates a participant's successfulInvites, pendingInvites, and isEligible
 * directly from their CampaignReferral records in MongoDB.
 *
 * Never relies on an incremented counter.
 * Sends congratulation DM and announcement notification (via shared rate-limited queue)
 * at most once per user per campaign (`notified: true`).
 *
 * @param {import('discord.js').Client|null} client
 * @param {object} campaign
 * @param {string} userId
 * @param {object} [options]
 * @param {boolean} [options.allowEndedFreeze=false]
 * @param {boolean} [options.skipNotifications=false]
 * @returns {Promise<object|null>} Updated CampaignParticipant document
 */
export async function recalculateParticipantEligibility(client, campaign, userId, options = {}) {
  if (!campaign || !campaign.campaignId || !userId) return null;

  // Later joins and leaves must never change an ended campaign
  if (campaign.status === CAMPAIGN_STATUS.ENDED && !options.allowEndedFreeze) {
    return getCampaignParticipant(campaign.campaignId, userId);
  }

  const lockKey = `lock:inv_cmp:participant:${campaign.campaignId}:${userId}`;

  return withCampaignLock(lockKey, async () => {
    const freshCampaign = (await getInviteCampaignById(campaign.campaignId)) || campaign;
    if (freshCampaign.status === CAMPAIGN_STATUS.ENDED && !options.allowEndedFreeze) {
      return getCampaignParticipant(freshCampaign.campaignId, userId);
    }

    const referrals = await getReferralsByInviter(
      freshCampaign.campaignId,
      freshCampaign.guildId,
      userId
    );

    let successfulInvites = 0;
    let pendingInvites = 0;

    for (const ref of referrals) {
      if (!ref.isActive || ref.disqualified) continue;
      if (ref.counted) {
        successfulInvites++;
      } else {
        pendingInvites++;
      }
    }

    const existing = await getCampaignParticipant(freshCampaign.campaignId, userId);
    const disqualified = Boolean(existing?.disqualified);
    let inviterLeftServer = Boolean(existing?.inviterLeftServer);

    // If client & guild member cache is available and inviterLeftServer wasn't explicitly set, verify presence if needed
    const requiredInvites = Math.max(1, Number(freshCampaign.requiredInvites || 1));
    const isEligible =
      !disqualified && !inviterLeftServer && successfulInvites >= requiredInvites;

    let eligibleAt = existing?.eligibleAt || null;
    if (isEligible && !eligibleAt) {
      eligibleAt = new Date();
    } else if (!isEligible) {
      eligibleAt = null;
    }

    const alreadyNotified = Boolean(existing?.notified);
    const shouldNotifyNow = isEligible && !alreadyNotified && !options.skipNotifications;
    const notified = alreadyNotified || shouldNotifyNow;

    const updatedParticipant = await upsertCampaignParticipant(
      freshCampaign.campaignId,
      freshCampaign.guildId,
      userId,
      {
        successfulInvites,
        pendingInvites,
        isEligible,
        eligibleAt,
        notified,
        disqualified,
        disqualifyReason: existing?.disqualifyReason || null,
        inviterLeftServer,
      }
    );

    if (shouldNotifyNow && client) {
      await dispatchEligibilityNotifications(client, freshCampaign, updatedParticipant).catch((err) => {
        console.warn(`[InviteCampaign] ⚠️ Error dispatching eligibility notifications for ${userId}:`, err.message);
      });
    }

    return updatedParticipant;
  });
}

/**
 * Recalculates all participants in a campaign (used on startup recovery and final campaign freeze).
 */
export async function recalculateAllCampaignParticipants(client, campaign, options = {}) {
  if (!campaign?.campaignId) return [];
  const referrals = await getReferralsForCampaign(campaign.campaignId);
  const existingParticipants = await getParticipantsForCampaign(campaign.campaignId);

  const userIds = new Set();
  for (const r of referrals) {
    if (r.inviterId) userIds.add(String(r.inviterId));
  }
  for (const p of existingParticipants) {
    if (p.userId) userIds.add(String(p.userId));
  }

  const results = [];
  for (const uid of userIds) {
    const updated = await recalculateParticipantEligibility(client, campaign, uid, options);
    if (updated) results.push(updated);
  }
  return results;
}

/**
 * Sends a congratulation DM to the newly eligible user (ignoring closed DM errors)
 * and posts an eligibility alert in the configured announcement channel via the shared queue.
 */
async function dispatchEligibilityNotifications(client, campaign, participant) {
  if (!client) return;

  const guild =
    client.guilds?.cache?.get(campaign.guildId) ||
    (typeof client.guilds?.fetch === 'function'
      ? await client.guilds.fetch(campaign.guildId).catch(() => null)
      : null);

  // 1. Congratulation DM to the user (ignore failures if DMs are closed)
  try {
    let targetUser =
      guild?.members?.cache?.get(participant.userId) ||
      client.users?.cache?.get(participant.userId) ||
      null;
    if (!targetUser && typeof guild?.members?.fetch === 'function') {
      targetUser = await guild.members.fetch(participant.userId).catch(() => null);
    }
    if (!targetUser && typeof client.users?.fetch === 'function') {
      targetUser = await client.users.fetch(participant.userId).catch(() => null);
    }

    if (targetUser) {
      const dmText =
        `🎉 **Congratulations!** You have reached **${participant.successfulInvites} / ${campaign.requiredInvites}** verified invites in the **${campaign.name}** campaign!\n\n` +
        `✅ **Status:** Eligible for the giveaway\n` +
        `🕒 **Qualified At:** ${formatISTDateTime(participant.eligibleAt)}\n\n` +
        `*Keep your invited members in the server until the campaign ends (${formatISTDateTime(campaign.endAt)}) to retain your eligibility!*`;

      await queueDirectMessage(targetUser, dmText).catch(() => {});
    }
  } catch {
    // Ignore DM failures when user DMs are closed
  }

  // 2. Notify admin in the announcement channel
  if (guild && campaign.announcementChannelId) {
    try {
      const anncChannel =
        guild.channels?.cache?.get(campaign.announcementChannelId) ||
        (typeof guild.channels?.fetch === 'function'
          ? await guild.channels.fetch(campaign.announcementChannelId).catch(() => null)
          : null);

      if (anncChannel) {
        const embed = new EmbedBuilder()
          .setTitle('🎉 New Giveaway Qualifier — Invite & Earn')
          .setColor(0x2ecc71)
          .setDescription(
            `<@${participant.userId}> has reached the target of **${campaign.requiredInvites}** successful invites for **${campaign.name}**!`
          )
          .addFields(
            { name: '👤 Member', value: `<@${participant.userId}> (\`${participant.userId}\`)`, inline: true },
            {
              name: '📈 Successful Invites',
              value: `${participant.successfulInvites} / ${campaign.requiredInvites}`,
              inline: true,
            },
            {
              name: '🕒 Qualified At (IST)',
              value: formatISTDateTime(participant.eligibleAt),
              inline: true,
            }
          )
          .setTimestamp(new Date());

        await queueChannelSend(anncChannel, { embeds: [embed] }).catch(() => {});
      }
    } catch (err) {
      console.warn(`[InviteCampaign] ⚠️ Failed to post eligibility notice in channel ${campaign.announcementChannelId}:`, err.message);
    }
  }
}
