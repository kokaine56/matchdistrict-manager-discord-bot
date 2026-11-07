import {
  CAMPAIGN_STATUS,
  getCurrentGuildCampaign,
  getCampaignReferral,
  updateCampaignReferral,
  createUnattributedJoin,
} from '../models/inviteCampaignModels.js';
import {
  diffAndRefreshInviteSnapshot,
  syncGuildInviteSnapshot,
  recordInviteCreated,
  recordInviteDeleted,
} from '../services/inviteSnapshotService.js';
import { recalculateParticipantEligibility } from '../services/eligibilityService.js';
import { recordOrRestoreCampaignReferral } from '../services/campaignSchedulerService.js';

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
 * immediately increments the inviter's successfulInvites count, and refreshes their displayed count.
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

    // Bots never count, but keep snapshot updated
    if (member.user?.bot) {
      await syncGuildInviteSnapshot(guild, campaign);
      return null;
    }

    // Joins while campaign is Paused, Scheduled, or Draft are not counted:
    // baseline the invite snapshot so uses during pause are consumed.
    if (campaign.status !== CAMPAIGN_STATUS.ACTIVE) {
      await syncGuildInviteSnapshot(guild, campaign);
      return { status: 'ignored_not_active', campaignStatus: campaign.status };
    }

    const joinedAt = member.joinedAt ? new Date(member.joinedAt) : new Date();

    // Always diff and refresh the server's invite usage snapshot on every join
    const diff = await diffAndRefreshInviteSnapshot(guild, campaign);

    // Check if this member already has a referral record in this campaign (rejoin during active campaign)
    const priorReferral = await getCampaignReferral(campaign.campaignId, guild.id, member.id);
    if (priorReferral) {
      const restored = await recordOrRestoreCampaignReferral(
        client,
        campaign,
        member,
        null,
        joinedAt
      );
      return { status: 'rejoined_restored', referral: restored };
    }

    const {
      changedCampaignInvites = [],
      changedInvites = [],
      hadRecentlyDeletedInvite,
      fetchFailed,
    } = diff;

    // 1. Exact attribution to a personal campaign invite (delta === 1)
    if (
      changedCampaignInvites.length === 1 &&
      changedCampaignInvites[0].delta === 1 &&
      changedCampaignInvites[0].campaignInvite
    ) {
      const referral = await recordOrRestoreCampaignReferral(
        client,
        campaign,
        member,
        changedCampaignInvites[0].campaignInvite,
        joinedAt
      );
      return { status: 'attributed', referral };
    }

    // 2. Fetch failed -> cannot attribute with certainty
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

    // 3. Multiple campaign invites changed or jumped by >1
    if (changedCampaignInvites.length > 1 || (changedCampaignInvites.length === 1 && changedCampaignInvites[0].delta !== 1)) {
      const unattr = await createUnattributedJoin({
        campaignId: campaign.campaignId,
        guildId: guild.id,
        userId: member.id,
        joinedAt,
        reason:
          changedCampaignInvites.length > 1
            ? `Multiple campaign invites changed simultaneously (${changedCampaignInvites.map((c) => c.code).join(', ')})`
            : `Campaign invite ${changedCampaignInvites[0].code} usage jumped by ${changedCampaignInvites[0].delta} instead of 1`,
        reviewed: false,
      });
      return { status: 'unattributed', unattributed: unattr };
    }

    // 4. Joined via a non-campaign invite
    if (changedInvites.length >= 1) {
      const unattr = await createUnattributedJoin({
        campaignId: campaign.campaignId,
        guildId: guild.id,
        userId: member.id,
        joinedAt,
        reason: `Joined via non-campaign invite (${changedInvites.map((c) => c.code).join(', ')})`,
        reviewed: false,
      });
      return { status: 'unattributed', unattributed: unattr };
    }

    // 5. No invite usage increased -> vanity URL, deleted invite, or OAuth join
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
  });
}

/**
 * Handles GuildMemberRemove for the Invite & Earn campaign system.
 * - If an invited member leaves while the campaign is not Ended:
 *   referral becomes inactive (leftAt saved, counted = false) and original inviter's successfulInvites
 *   count is immediately decreased by 1.
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
    if (!campaign || campaign.status === CAMPAIGN_STATUS.ENDED) {
      return null;
    }

    const now = new Date();
    const userId = String(member.id);

    const referral = await getCampaignReferral(campaign.campaignId, guild.id, userId);
    if (referral && referral.isActive) {
      await updateCampaignReferral(campaign.campaignId, guild.id, userId, {
        isActive: false,
        counted: false,
        leftAt: now,
        dueAt: null,
      });
      await recalculateParticipantEligibility(client, campaign, referral.inviterId);
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
