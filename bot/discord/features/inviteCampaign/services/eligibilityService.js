import {
  CAMPAIGN_STATUS,
  withCampaignLock,
  getInviteCampaignById,
  getReferralsByInviter,
  updateCampaignReferral,
  getCampaignParticipant,
  upsertCampaignParticipant,
  getReferralsForCampaign,
  getParticipantsForCampaign,
} from '../models/inviteCampaignModels.js';

let liveUserViewRefreshHook = null;

/**
 * Registers a callback invoked whenever a participant's invite count changes,
 * allowing any open ephemeral "Generate My Invite" response for that user to refresh in real time.
 *
 * @param {(campaignId: string, userId: string, participant: object) => Promise<void>} fn
 */
export function setLiveUserViewRefreshHook(fn) {
  liveUserViewRefreshHook = fn;
}

/**
 * Atomically recalculates a participant's successfulInvites count directly from their
 * active CampaignReferral records in MongoDB and refreshes their open Discord view if present.
 *
 * Every active, non-disqualified referral counts immediately toward successfulInvites.
 *
 * @param {import('discord.js').Client|null} client
 * @param {object} campaign
 * @param {string} userId
 * @param {object} [options]
 * @param {boolean} [options.allowEndedFreeze=false]
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

    for (const ref of referrals) {
      if (!ref.isActive || ref.disqualified) continue;
      // Upgrade any legacy pending referral to counted immediately
      if (!ref.counted) {
        await updateCampaignReferral(
          freshCampaign.campaignId,
          freshCampaign.guildId,
          ref.invitedUserId,
          { counted: true, countedAt: ref.joinedAt || new Date(), dueAt: null }
        ).catch(() => {});
      }
      successfulInvites++;
    }

    const existing = await getCampaignParticipant(freshCampaign.campaignId, userId);
    const disqualified = Boolean(existing?.disqualified);

    const updatedParticipant = await upsertCampaignParticipant(
      freshCampaign.campaignId,
      freshCampaign.guildId,
      userId,
      {
        successfulInvites: disqualified ? 0 : successfulInvites,
        pendingInvites: 0,
        isEligible: false,
        eligibleAt: null,
        notified: false,
        disqualified,
        disqualifyReason: existing?.disqualifyReason || null,
        inviterLeftServer: Boolean(existing?.inviterLeftServer),
      }
    );

    if (typeof liveUserViewRefreshHook === 'function') {
      await liveUserViewRefreshHook(
        freshCampaign.campaignId,
        String(userId),
        updatedParticipant
      ).catch(() => {});
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
