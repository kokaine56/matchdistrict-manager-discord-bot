import { queueChannelSend } from '../../../../../discordQueue.js';
import {
  CAMPAIGN_STATUS,
  withCampaignLock,
  getAllNonEndedCampaigns,
  getInviteCampaignById,
  getReferralsForCampaign,
  getCampaignReferral,
  createCampaignReferral,
  updateCampaignReferral,
  getUnattributedJoinsForCampaign,
  createUnattributedJoin,
} from '../models/inviteCampaignModels.js';
import {
  syncGuildInviteSnapshot,
  diffAndRefreshInviteSnapshot,
  refreshModerationAllowlistForGuild,
} from './inviteSnapshotService.js';
import {
  recalculateParticipantEligibility,
  recalculateAllCampaignParticipants,
} from './eligibilityService.js';
import {
  startCampaign,
  endCampaign,
} from './campaignLifecycleService.js';
import { ensureOrUpdateCampaignPanel } from './campaignPanelService.js';

export const SAFETY_CHECK_INTERVAL_MS = 5 * 1000;
export const MAX_TIMER_CHUNK_MS = 10 * 60 * 1000;
export const PRE_WAKEUP_BUFFER_MS = 500;

let schedulerInterval = null;
let activeClient = null;

// campaignId -> { timerId, targetTimeMs }
const campaignTimers = new Map();

export function clearCampaignTimers(campaignId) {
  if (!campaignId) return;
  const entry = campaignTimers.get(String(campaignId));
  if (entry?.timerId) clearTimeout(entry.timerId);
  campaignTimers.delete(String(campaignId));
}

export function clearReferralTimer() {
  // No-op kept for backwards compatibility; referrals count immediately without timers
}

export function clearAllInviteCampaignTimers() {
  for (const entry of campaignTimers.values()) {
    if (entry?.timerId) clearTimeout(entry.timerId);
  }
  campaignTimers.clear();
}

/**
 * Arms an exact-second chunked timer for a campaign lifecycle transition.
 */
function armChunkedTimer(map, key, targetTimeMs, onDueFn) {
  const existing = map.get(key);
  if (existing?.timerId) {
    clearTimeout(existing.timerId);
  }

  const scheduleNextChunk = () => {
    const remainingMs = targetTimeMs - Date.now();
    if (remainingMs <= 0) {
      map.delete(key);
      Promise.resolve()
        .then(() => onDueFn())
        .catch((err) => {
          console.warn(`[InviteCampaignScheduler] ⚠️ Timer execution error for ${key}:`, err.message);
        });
      return;
    }

    let delayMs;
    if (remainingMs > MAX_TIMER_CHUNK_MS) {
      delayMs = MAX_TIMER_CHUNK_MS;
    } else if (remainingMs > 2000) {
      delayMs = remainingMs - PRE_WAKEUP_BUFFER_MS;
    } else {
      delayMs = remainingMs;
    }

    const timerId = setTimeout(scheduleNextChunk, Math.max(1, delayMs));
    if (typeof timerId?.unref === 'function') {
      timerId.unref();
    }
    map.set(key, { timerId, targetTimeMs });
  };

  scheduleNextChunk();
}

/**
 * Evaluates and arms exact-second lifecycle timers (Scheduled -> Active at startAt, * -> Ended at endAt).
 */
export async function evaluateAndArmCampaignTimers(client, campaignOrId, customNow = null) {
  const effectiveClient = client || activeClient;
  const now = customNow instanceof Date ? customNow : new Date();
  let campaign =
    typeof campaignOrId === 'string'
      ? await getInviteCampaignById(campaignOrId)
      : campaignOrId;

  if (!campaign || campaign.status === CAMPAIGN_STATUS.ENDED) {
    if (campaign?.campaignId) clearCampaignTimers(campaign.campaignId);
    return null;
  }

  const guild =
    effectiveClient?.guilds?.cache?.get(campaign.guildId) ||
    (typeof effectiveClient?.guilds?.fetch === 'function'
      ? await effectiveClient.guilds.fetch(campaign.guildId).catch(() => null)
      : null);

  // 1. Check if campaign End time has arrived
  if (campaign.endAt && new Date(campaign.endAt) <= now) {
    clearCampaignTimers(campaign.campaignId);
    const endRes = await endCampaign(effectiveClient, guild, campaign.campaignId, now);
    return endRes.campaign || campaign;
  }

  // 2. Check if Scheduled campaign Start time has arrived
  if (
    campaign.status === CAMPAIGN_STATUS.SCHEDULED &&
    campaign.startAt &&
    new Date(campaign.startAt) <= now
  ) {
    const startRes = await startCampaign(effectiveClient, guild, campaign.campaignId, now);
    if (startRes.ok && startRes.campaign) {
      campaign = startRes.campaign;
    } else if (!startRes.ok && guild && campaign.announcementChannelId) {
      const anncChannel =
        guild.channels?.cache?.get(campaign.announcementChannelId) ||
        (typeof guild.channels?.fetch === 'function'
          ? await guild.channels.fetch(campaign.announcementChannelId).catch(() => null)
          : null);
      if (anncChannel) {
        await queueChannelSend(anncChannel, {
          content: `⚠️ **Scheduled Campaign "${campaign.name}" could not auto-start:**\n${startRes.error}\n*Fix the permissions/intents and run \`.invite start\`.*`,
        }).catch(() => {});
      }
    }
  }

  // 3. Arm next campaign lifecycle timer (startAt or endAt)
  let nextTargetMs = null;
  if (campaign.status === CAMPAIGN_STATUS.SCHEDULED && campaign.startAt) {
    const startMs = new Date(campaign.startAt).getTime();
    if (!Number.isNaN(startMs) && startMs > now.getTime()) {
      nextTargetMs = startMs;
    }
  }
  if (campaign.endAt) {
    const endMs = new Date(campaign.endAt).getTime();
    if (!Number.isNaN(endMs) && endMs > now.getTime()) {
      nextTargetMs = nextTargetMs !== null ? Math.min(nextTargetMs, endMs) : endMs;
    }
  }

  if (nextTargetMs !== null) {
    armChunkedTimer(campaignTimers, campaign.campaignId, nextTargetMs, async () => {
      await evaluateAndArmCampaignTimers(effectiveClient, campaign.campaignId, new Date());
    });
  }

  return campaign;
}

/**
 * Checks all non-ended campaigns in MongoDB against the current time (used by the 5s safety interval).
 */
export async function checkInviteCampaignLifecycles(client = null, customNow = null) {
  const effectiveClient = client || activeClient;
  const now = customNow instanceof Date ? customNow : new Date();
  try {
    const campaigns = await getAllNonEndedCampaigns();
    for (const campaign of campaigns) {
      await evaluateAndArmCampaignTimers(effectiveClient, campaign, now);
    }
  } catch (err) {
    console.warn('[InviteCampaignScheduler] ⚠️ Safety check error:', err.message);
  }
}

/**
 * Processes a member join that has been attributed to a specific campaignInvite,
 * OR restores an existing referral if the member is rejoining during the active campaign.
 *
 * Rules:
 * - Every successfully attributed human member joining through a personal invite immediately increases
 *   the inviter's successfulInvites count (no 24h stay wait, no minimum account age restriction).
 * - Bots and self-invites never count.
 * - One referral record per member per campaign and server.
 * - If the member leaves and rejoins during the campaign, restores the original inviter's count
 *   without creating duplicate referral records or switching inviters.
 */
export async function recordOrRestoreCampaignReferral(
  client,
  campaign,
  member,
  attributedInvite,
  joinedAt = new Date()
) {
  if (!campaign || !member || member.user?.bot) return null;
  if (campaign.status !== CAMPAIGN_STATUS.ACTIVE) return null;

  const invitedUserId = String(member.id);
  const guildId = String(campaign.guildId);
  const campaignId = String(campaign.campaignId);
  const lockKey = `lock:inv_cmp:ref:${campaignId}:${invitedUserId}`;

  return withCampaignLock(lockKey, async () => {
    const freshCampaign = (await getInviteCampaignById(campaignId)) || campaign;
    if (freshCampaign.status !== CAMPAIGN_STATUS.ACTIVE) return null;

    const existingRef = await getCampaignReferral(campaignId, guildId, invitedUserId);

    // Case 1: Member already has a referral record in this campaign & server (rejoin)
    if (existingRef) {
      if (existingRef.disqualified) {
        return updateCampaignReferral(campaignId, guildId, invitedUserId, {
          isActive: true,
          leftAt: null,
          counted: false,
          dueAt: null,
        });
      }

      // Restore original inviter relationship permanently and count them again only once
      const restoredRef = await updateCampaignReferral(campaignId, guildId, invitedUserId, {
        isActive: true,
        leftAt: null,
        counted: true,
        countedAt: joinedAt,
        joinedAt,
        dueAt: null,
      });

      await recalculateParticipantEligibility(client, freshCampaign, restoredRef.inviterId);
      return restoredRef;
    }

    // Case 2: First join in this campaign — requires a valid attributed campaign invite
    if (!attributedInvite) return null;

    const inviterId = String(attributedInvite.inviterId);
    const inviteCode = String(attributedInvite.inviteCode);

    // Self-invites never count
    if (invitedUserId === inviterId) {
      return createCampaignReferral({
        campaignId,
        guildId,
        invitedUserId,
        inviterId,
        inviteCode,
        joinedAt,
        leftAt: null,
        isActive: true,
        counted: false,
        countedAt: null,
        disqualified: true,
        disqualifyReason: 'Self-invite',
        dueAt: null,
      });
    }

    // Immediately count the referral and increment the owner's successfulInvites count
    const createdRef = await createCampaignReferral({
      campaignId,
      guildId,
      invitedUserId,
      inviterId,
      inviteCode,
      joinedAt,
      leftAt: null,
      isActive: true,
      counted: true,
      countedAt: joinedAt,
      disqualified: false,
      disqualifyReason: null,
      dueAt: null,
    });

    await recalculateParticipantEligibility(client, freshCampaign, inviterId);
    return createdRef;
  });
}

/**
 * Reconciles a single campaign on bot startup:
 * - Rebuilds moderation allowlist and compares stored invite uses with current Discord invite uses.
 * - Detects members who left while the bot was offline and updates their referral/participant records.
 * - Detects members who joined while the bot was offline and attributes only when certain.
 * - Recalculates all participant counts, re-arms campaign start/end timers, and updates the panel message in place.
 */
export async function reconcileSingleCampaignOnStartup(client, campaign, now = new Date()) {
  if (!client || !campaign) return;

  const guild =
    client.guilds?.cache?.get(campaign.guildId) ||
    (typeof client.guilds?.fetch === 'function'
      ? await client.guilds.fetch(campaign.guildId).catch(() => null)
      : null);

  if (!guild) return;

  await refreshModerationAllowlistForGuild(guild.id, campaign);

  if (typeof guild.members?.fetch === 'function') {
    await guild.members.fetch().catch(() => {});
  }

  const currentMembersMap = guild.members?.cache || new Map();

  if (campaign.status === CAMPAIGN_STATUS.ACTIVE) {
    // 1. Check if any previously active referrals left while the bot was offline
    const existingReferrals = await getReferralsForCampaign(campaign.campaignId);
    const activeReferralByUser = new Map();
    const anyReferralByUser = new Map();

    for (const ref of existingReferrals) {
      anyReferralByUser.set(String(ref.invitedUserId), ref);
      if (ref.isActive) {
        activeReferralByUser.set(String(ref.invitedUserId), ref);
        if (currentMembersMap.size > 0 && !currentMembersMap.has(ref.invitedUserId)) {
          await updateCampaignReferral(campaign.campaignId, campaign.guildId, ref.invitedUserId, {
            isActive: false,
            counted: false,
            leftAt: now,
            dueAt: null,
          });
          activeReferralByUser.delete(String(ref.invitedUserId));
        }
      }
    }

    // 2. Identify members who joined while the bot was offline
    const existingUnattributed = await getUnattributedJoinsForCampaign(campaign.campaignId);
    const unattributedUserIds = new Set(existingUnattributed.map((u) => String(u.userId)));
    const initialMemberSet = new Set((campaign.initialMemberIds || []).map(String));
    const startMs = campaign.startAt ? new Date(campaign.startAt).getTime() : 0;
    const lastSnapMs = campaign.lastSnapshotAt ? new Date(campaign.lastSnapshotAt).getTime() : startMs;

    const offlineNewMembers = [];
    for (const member of currentMembersMap.values()) {
      if (!member?.id || member.user?.bot) continue;
      const uid = String(member.id);
      if (activeReferralByUser.has(uid)) continue;
      if (unattributedUserIds.has(uid)) continue;
      if (initialMemberSet.has(uid) && !anyReferralByUser.has(uid)) continue;

      const joinedMs =
        member.joinedTimestamp || (member.joinedAt ? new Date(member.joinedAt).getTime() : 0);
      if (joinedMs && joinedMs >= Math.max(startMs, lastSnapMs)) {
        offlineNewMembers.push(member);
      } else if (anyReferralByUser.has(uid) && !activeReferralByUser.has(uid)) {
        offlineNewMembers.push(member);
      }
    }

    // 3. Diff stored invite usage counts with current Discord invites
    const diff = await diffAndRefreshInviteSnapshot(guild, campaign);
    const { changedCampaignInvites, changedInvites } = diff;

    if (offlineNewMembers.length > 0) {
      const isCertainAttribution =
        changedCampaignInvites.length === 1 &&
        changedCampaignInvites[0].campaignInvite &&
        changedCampaignInvites[0].delta === offlineNewMembers.length;

      for (const member of offlineNewMembers) {
        const joinDate = member.joinedAt ? new Date(member.joinedAt) : now;
        const priorRef = anyReferralByUser.get(String(member.id));

        if (isCertainAttribution) {
          await recordOrRestoreCampaignReferral(
            client,
            campaign,
            member,
            changedCampaignInvites[0].campaignInvite,
            joinDate
          );
        } else if (priorRef) {
          await recordOrRestoreCampaignReferral(client, campaign, member, null, joinDate);
        } else {
          await createUnattributedJoin({
            campaignId: campaign.campaignId,
            guildId: campaign.guildId,
            userId: member.id,
            joinedAt: joinDate,
            reason:
              changedInvites.length === 0
                ? 'Joined while bot was offline (no invite usage increase detected)'
                : 'Joined while bot was offline (ambiguous invite usage changes across invites)',
            reviewed: false,
          });
        }
      }
    }

    // 4. Recalculate all participants (also upgrades any legacy pending referrals to counted)
    await recalculateAllCampaignParticipants(client, campaign);
  } else {
    await syncGuildInviteSnapshot(guild, campaign);
  }

  const updatedCampaign =
    (await evaluateAndArmCampaignTimers(client, campaign.campaignId, now)) || campaign;

  await ensureOrUpdateCampaignPanel(client, updatedCampaign, {
    allowCreateIfMissing: !updatedCampaign.panelMessageId,
  });
}

/**
 * Startup recovery entrypoint.
 */
export async function recoverInviteCampaignsOnStartup(client) {
  if (!client) return;
  activeClient = client;
  try {
    const campaigns = await getAllNonEndedCampaigns();
    for (const campaign of campaigns) {
      await reconcileSingleCampaignOnStartup(client, campaign, new Date()).catch((err) => {
        console.warn(`[InviteCampaign] ⚠️ Error recovering campaign ${campaign.campaignId}:`, err.message);
      });
    }
  } catch (err) {
    console.warn('[InviteCampaign] ⚠️ Error during startup campaign recovery:', err.message);
  }
}

/**
 * Starts the Invite Campaign scheduler (arms timers + 5-second safety interval).
 */
export function startInviteCampaignScheduler(client) {
  if (client) activeClient = client;
  if (schedulerInterval) return;

  checkInviteCampaignLifecycles(client).catch(() => {});
  schedulerInterval = setInterval(() => {
    checkInviteCampaignLifecycles(client).catch(() => {});
  }, SAFETY_CHECK_INTERVAL_MS);
  if (typeof schedulerInterval?.unref === 'function') {
    schedulerInterval.unref();
  }
}

/**
 * Stops the Invite Campaign scheduler and clears all armed timers.
 */
export function stopInviteCampaignScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
  clearAllInviteCampaignTimers();
}
