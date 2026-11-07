import {
  CAMPAIGN_STATUS,
  getCurrentGuildCampaign,
  getCampaignReferral,
  updateCampaignReferral,
  getCampaignParticipant,
  upsertCampaignParticipant,
  createUnattributedJoin,
  updateInviteCampaign,
} from '../models/inviteCampaignModels.js';
import {
  diffAndRefreshInviteSnapshot,
  syncGuildInviteSnapshot,
  recordInviteCreated,
  recordInviteDeleted,
} from '../services/inviteSnapshotService.js';
import { recalculateParticipantEligibility } from '../services/eligibilityService.js';
import {
  recordOrRestoreCampaignReferral,
  clearReferralTimer,
} from '../services/campaignSchedulerService.js';

// Per-guild sequential event processing queue (ensures joins/leaves in a guild run strictly one at a time)
const guildEventQueues = new Map(); // guildId -> Promise

/**
 * Enqueues a task to run sequentially per guild.
 *
 * @template T
 * @param {string} guildId
 * @param {() => Promise<T>} taskFn
 * @returns {Promise<T>}
 */
export function enqueueGuildInviteTask(guildId, taskFn) {
  const gId = String(guildId);
  const prev = guildEventQueues.get(gId) || Promise.resolve();

  let resolveTask;
  let rejectTask;
  const resultPromise = new Promise((resolve, reject) => {
    resolveTask = resolve;
    rejectTask = reject;
  });

  const nextChain = prev
    .catch(() => {})
    .then(async () => {
      try {
        const res = await taskFn();
        resolveTask(res);
      } catch (err) {
        rejectTask(err);
      }
    })
    .finally(() => {
      if (guildEventQueues.get(gId) === nextChain) {
        guildEventQueues.delete(gId);
      }
    });

  guildEventQueues.set(gId, nextChain);
  return resultPromise;
}

/**
 * Handles GuildMemberAdd for the Invite & Earn campaign system.
 * Processes joins one at a time per server, diffs invite uses against the snapshot,
 * and attributes only when unambiguous.
 *
 * @param {import('discord.js').GuildMember} member
 */
export async function handleInviteCampaignMemberAdd(member) {
  if (!member || !member.guild) return null;
  const guild = member.guild;
  const client = member.client || guild.client || null;

  return enqueueGuildInviteTask(guild.id, async () => {
    const campaign = await getCurrentGuildCampaign(guild.id);
    if (!campaign || campaign.status === CAMPAIGN_STATUS.ENDED) {
      return null;
    }

    // Bots never count, but keep snapshot updated if needed
    if (member.user?.bot) {
      await syncGuildInviteSnapshot(guild, campaign);
      return null;
    }

    // If an inviter who previously left the server rejoins while campaign is non-ended, restore their presence
    const existingParticipant = await getCampaignParticipant(campaign.campaignId, member.id);
    if (existingParticipant && existingParticipant.inviterLeftServer) {
      await upsertCampaignParticipant(campaign.campaignId, guild.id, member.id, {
        inviterLeftServer: false,
      });
      if (campaign.status === CAMPAIGN_STATUS.ACTIVE) {
        await recalculateParticipantEligibility(client, campaign, member.id);
      }
    }

    // Joins while campaign is Paused, Scheduled, or Draft are never counted afterwards:
    // baseline the invite snapshot and record the member in initialMemberIds so they cannot be counted later.
    if (campaign.status !== CAMPAIGN_STATUS.ACTIVE) {
      const initialIds = new Set((campaign.initialMemberIds || []).map(String));
      if (!initialIds.has(String(member.id))) {
        initialIds.add(String(member.id));
        await updateInviteCampaign(campaign.campaignId, {
          initialMemberIds: [...initialIds],
        });
      }
      await syncGuildInviteSnapshot(guild, campaign);
      return { status: 'ignored_not_active', campaignStatus: campaign.status };
    }

    const joinedAt = member.joinedAt ? new Date(member.joinedAt) : new Date();

    // Always diff and refresh the server's invite usage snapshot on every join
    const diff = await diffAndRefreshInviteSnapshot(guild, campaign);

    // Check if this member already has a referral record in this campaign (rejoin during active campaign)
    const priorReferral = await getCampaignReferral(campaign.campaignId, guild.id, member.id);
    if (priorReferral) {
      const restored = await recordOrRestoreCampaignReferral(client, campaign, member, null, joinedAt);
      return { status: 'rejoined_restored', referral: restored };
    }

    const { changedInvites, hadRecentlyDeletedInvite, fetchFailed } = diff;

    // 1. Fetch failed -> cannot attribute with certainty
    if (fetchFailed) {
      const unattr = await createUnattributedJoin({
        campaignId: campaign.campaignId,
        guildId: guild.id,
        userId: member.id,
        joinedAt,
        reason: 'Could not fetch server invites during join (missing permission or API error)',
        reviewed: false,
      });
      return { status: 'unattributed', unattributed: unattr };
    }

    // 2. No invite usage increased -> vanity URL, deleted invite, or OAuth join
    if (changedInvites.length === 0) {
      const reason = hadRecentlyDeletedInvite
        ? 'Invite was deleted immediately before/after join (ambiguous uses)'
        : 'No invite usage change detected (possible vanity URL, server discovery, or deleted invite)';
      const unattr = await createUnattributedJoin({
        campaignId: campaign.campaignId,
        guildId: guild.id,
        userId: member.id,
        joinedAt,
        reason,
        reviewed: false,
      });
      return { status: 'unattributed', unattributed: unattr };
    }

    // 3. Multiple invites changed, or a single invite increased by more than 1 -> ambiguous
    if (changedInvites.length > 1 || changedInvites[0].delta !== 1) {
      const unattr = await createUnattributedJoin({
        campaignId: campaign.campaignId,
        guildId: guild.id,
        userId: member.id,
        joinedAt,
        reason:
          changedInvites.length > 1
            ? `Multiple invites changed simultaneously (${changedInvites.map((c) => c.code).join(', ')})`
            : `Invite ${changedInvites[0].code} usage jumped by ${changedInvites[0].delta} instead of 1`,
        reviewed: false,
      });
      return { status: 'unattributed', unattributed: unattr };
    }

    const matchedChange = changedInvites[0];

    // 4. Single invite increased by 1, but it is NOT a campaign invite for the active campaign
    if (!matchedChange.isCampaignInvite || !matchedChange.campaignInvite) {
      const unattr = await createUnattributedJoin({
        campaignId: campaign.campaignId,
        guildId: guild.id,
        userId: member.id,
        joinedAt,
        reason: `Joined via non-campaign invite (${matchedChange.code})`,
        reviewed: false,
      });
      return { status: 'unattributed', unattributed: unattr };
    }

    // 5. Exact attribution to a campaign invite! Apply Section 6 Counting Rules
    const referral = await recordOrRestoreCampaignReferral(
      client,
      campaign,
      member,
      matchedChange.campaignInvite,
      joinedAt
    );

    return { status: 'attributed', referral };
  });
}

/**
 * Handles GuildMemberRemove for the Invite & Earn campaign system.
 * - If an invited member leaves while the campaign is not Ended:
 *   referral becomes inactive (leftAt saved, counted = false) and inviter's count/eligibility is recalculated.
 * - If an inviter leaves the server while the campaign is not Ended:
 *   their referrals stay in history, but the inviter is no longer eligible.
 * - Later leaves must never change an Ended campaign.
 *
 * @param {import('discord.js').GuildMember} member
 */
export async function handleInviteCampaignMemberRemove(member) {
  if (!member || !member.guild) return null;
  const guild = member.guild;
  const client = member.client || guild.client || null;

  return enqueueGuildInviteTask(guild.id, async () => {
    const campaign = await getCurrentGuildCampaign(guild.id);
    // If there is no non-ended campaign (or campaign is Ended), do nothing
    if (!campaign || campaign.status === CAMPAIGN_STATUS.ENDED) {
      return null;
    }

    const now = new Date();
    const userId = String(member.id);

    // 1. Check if the departing member was an invited user in this campaign
    const referral = await getCampaignReferral(campaign.campaignId, guild.id, userId);
    if (referral && referral.isActive) {
      clearReferralTimer(campaign.campaignId, userId);
      await updateCampaignReferral(campaign.campaignId, guild.id, userId, {
        isActive: false,
        counted: false,
        leftAt: now,
        dueAt: null,
      });
      await recalculateParticipantEligibility(client, campaign, referral.inviterId);
    }

    // 2. Check if the departing member is an inviter (participant) in this campaign
    const participant = await getCampaignParticipant(campaign.campaignId, userId);
    if (participant) {
      await upsertCampaignParticipant(campaign.campaignId, guild.id, userId, {
        inviterLeftServer: true,
        isEligible: false,
        eligibleAt: null,
      });
      await recalculateParticipantEligibility(client, campaign, userId);
    }

    return true;
  });
}

/**
 * Handles InviteCreate to keep the per-guild snapshot accurate.
 */
export async function handleInviteCampaignInviteCreate(invite) {
  if (!invite) return;
  await recordInviteCreated(invite);
}

/**
 * Handles InviteDelete to remember the uses of an invite deleted right after a join.
 */
export async function handleInviteCampaignInviteDelete(invite) {
  if (!invite) return;
  await recordInviteDeleted(invite);
}

