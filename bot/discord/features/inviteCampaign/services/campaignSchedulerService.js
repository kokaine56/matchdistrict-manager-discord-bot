import { queueChannelSend } from '../../../../../discordQueue.js';
import {
  CAMPAIGN_STATUS,
  withCampaignLock,
  getAllNonEndedCampaigns,
  getInviteCampaignById,
  getPendingReferralsForCampaign,
  getReferralsForCampaign,
  getCampaignReferral,
  createCampaignReferral,
  updateCampaignReferral,
  getParticipantsForCampaign,
  upsertCampaignParticipant,
  getUnattributedJoinsForCampaign,
  createUnattributedJoin,
  updateInviteCampaign,
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
import { isAccountOldEnough } from './timeUtils.js';

export const SAFETY_CHECK_INTERVAL_MS = 5 * 1000;
export const MAX_TIMER_CHUNK_MS = 10 * 60 * 1000;
export const PRE_WAKEUP_BUFFER_MS = 500;

let schedulerInterval = null;
let activeClient = null;

// campaignId -> { timerId, targetTimeMs, action }
const campaignTimers = new Map();
// `${campaignId}:${invitedUserId}` -> { timerId, targetTimeMs }
const referralTimers = new Map();

export function clearCampaignTimers(campaignId) {
  if (!campaignId) return;
  const entry = campaignTimers.get(String(campaignId));
  if (entry?.timerId) clearTimeout(entry.timerId);
  campaignTimers.delete(String(campaignId));

  const prefix = `${campaignId}:`;
  for (const [key, refEntry] of referralTimers.entries()) {
    if (key.startsWith(prefix)) {
      if (refEntry?.timerId) clearTimeout(refEntry.timerId);
      referralTimers.delete(key);
    }
  }
}

export function clearReferralTimer(campaignId, invitedUserId) {
  const key = `${campaignId}:${invitedUserId}`;
  const existing = referralTimers.get(key);
  if (existing?.timerId) clearTimeout(existing.timerId);
  referralTimers.delete(key);
}

export function clearAllInviteCampaignTimers() {
  for (const entry of campaignTimers.values()) {
    if (entry?.timerId) clearTimeout(entry.timerId);
  }
  campaignTimers.clear();

  for (const entry of referralTimers.values()) {
    if (entry?.timerId) clearTimeout(entry.timerId);
  }
  referralTimers.clear();
}

/**
 * Arms an exact-second chunked timer for a target timestamp.
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
 * Evaluates a single pending referral whose stay period dueAt has arrived.
 * Rechecks that the invited member is still in the server and meets minimum account age.
 *
 * @param {import('discord.js').Client} client
 * @param {object} campaign
 * @param {object} referral
 * @param {Date} [now]
 */
export async function evaluateDueReferral(client, campaign, referral, now = new Date()) {
  if (!campaign || !referral) return null;
  if (campaign.status !== CAMPAIGN_STATUS.ACTIVE) return null;

  const lockKey = `lock:inv_cmp:ref:${campaign.campaignId}:${referral.invitedUserId}`;
  return withCampaignLock(lockKey, async () => {
    const freshCampaign = await getInviteCampaignById(campaign.campaignId);
    if (!freshCampaign || freshCampaign.status !== CAMPAIGN_STATUS.ACTIVE) return null;

    const freshRef = await getCampaignReferral(
      freshCampaign.campaignId,
      freshCampaign.guildId,
      referral.invitedUserId
    );
    if (!freshRef || !freshRef.isActive || freshRef.counted || freshRef.disqualified) {
      clearReferralTimer(freshCampaign.campaignId, referral.invitedUserId);
      return freshRef;
    }

    if (freshRef.dueAt && new Date(freshRef.dueAt) > now) {
      armReferralStayTimer(client, freshCampaign, freshRef);
      return freshRef;
    }

    const guild =
      client?.guilds?.cache?.get(freshCampaign.guildId) ||
      (typeof client?.guilds?.fetch === 'function'
        ? await client.guilds.fetch(freshCampaign.guildId).catch(() => null)
        : null);

    // Recheck that the member is still in the server
    let member = guild?.members?.cache?.get?.(freshRef.invitedUserId) || null;
    if (!member && typeof guild?.members?.fetch === 'function') {
      member = await guild.members.fetch(freshRef.invitedUserId).catch(() => null);
    }

    if (!member) {
      // Member left the server before or at due time
      const inactiveRef = await updateCampaignReferral(
        freshCampaign.campaignId,
        freshCampaign.guildId,
        freshRef.invitedUserId,
        {
          isActive: false,
          counted: false,
          leftAt: now,
          dueAt: null,
        }
      );
      clearReferralTimer(freshCampaign.campaignId, freshRef.invitedUserId);
      await recalculateParticipantEligibility(client, freshCampaign, freshRef.inviterId);
      return inactiveRef;
    }

    if (member.user?.bot) {
      const botRef = await updateCampaignReferral(
        freshCampaign.campaignId,
        freshCampaign.guildId,
        freshRef.invitedUserId,
        {
          counted: false,
          disqualified: true,
          disqualifyReason: 'Bot account',
          dueAt: null,
        }
      );
      clearReferralTimer(freshCampaign.campaignId, freshRef.invitedUserId);
      return botRef;
    }

    // Check minimum account age
    const createdAt = member.user?.createdTimestamp ?? member.user?.createdAt ?? null;
    const minAgeDays = Number(freshCampaign.minAccountAgeDays ?? 7);

    if (!isAccountOldEnough(createdAt, minAgeDays, now)) {
      const createdMs = createdAt instanceof Date ? createdAt.getTime() : Number(new Date(createdAt).getTime());
      const eligibleAccountMs = !Number.isNaN(createdMs)
        ? createdMs + minAgeDays * 24 * 60 * 60 * 1000
        : null;
      const campaignEndMs = freshCampaign.endAt ? new Date(freshCampaign.endAt).getTime() : 0;

      if (eligibleAccountMs && eligibleAccountMs > now.getTime() && (!campaignEndMs || eligibleAccountMs <= campaignEndMs)) {
        const nextDue = new Date(eligibleAccountMs);
        const postponedRef = await updateCampaignReferral(
          freshCampaign.campaignId,
          freshCampaign.guildId,
          freshRef.invitedUserId,
          { dueAt: nextDue }
        );
        armReferralStayTimer(client, freshCampaign, postponedRef);
        return postponedRef;
      }

      // Account cannot reach minAccountAgeDays before campaign ends; remains pending/uncounted
      const uncountedRef = await updateCampaignReferral(
        freshCampaign.campaignId,
        freshCampaign.guildId,
        freshRef.invitedUserId,
        { dueAt: null, counted: false }
      );
      clearReferralTimer(freshCampaign.campaignId, freshRef.invitedUserId);
      await recalculateParticipantEligibility(client, freshCampaign, freshRef.inviterId);
      return uncountedRef;
    }

    // Both stay period and minimum account age are satisfied!
    const countedRef = await updateCampaignReferral(
      freshCampaign.campaignId,
      freshCampaign.guildId,
      freshRef.invitedUserId,
      {
        counted: true,
        countedAt: now,
        dueAt: null,
      }
    );
    clearReferralTimer(freshCampaign.campaignId, freshRef.invitedUserId);
    await recalculateParticipantEligibility(client, freshCampaign, freshRef.inviterId);
    return countedRef;
  });
}

/**
 * Arms an exact-second timer for a single pending referral's dueAt.
 */
export function armReferralStayTimer(client, campaign, referral) {
  if (!campaign || !referral || !referral.isActive || referral.counted || referral.disqualified || !referral.dueAt) {
    if (campaign && referral) {
      clearReferralTimer(campaign.campaignId, referral.invitedUserId);
    }
    return;
  }

  const dueMs = new Date(referral.dueAt).getTime();
  if (Number.isNaN(dueMs)) return;

  const key = `${campaign.campaignId}:${referral.invitedUserId}`;
  armChunkedTimer(referralTimers, key, dueMs, async () => {
    await evaluateDueReferral(client || activeClient, campaign, referral, new Date());
  });
}

/**
 * Evaluates and arms exact-second lifecycle timers (Scheduled -> Active at startAt, * -> Ended at endAt)
 * and pending referral timers for a campaign.
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
      // Notify admin in announcement channel if scheduled start failed due to missing permissions/intents
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

  // 3. Process due referrals & arm timers for pending referrals if campaign is Active
  if (campaign.status === CAMPAIGN_STATUS.ACTIVE) {
    const pendingRefs = await getPendingReferralsForCampaign(campaign.campaignId);
    for (const ref of pendingRefs) {
      if (ref.dueAt && new Date(ref.dueAt) <= now) {
        await evaluateDueReferral(effectiveClient, campaign, ref, now);
      } else {
        armReferralStayTimer(effectiveClient, campaign, ref);
      }
    }
  }

  // 4. Arm next campaign lifecycle timer (startAt or endAt)
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
 * Enforces all Section 6 Counting Rules:
 * - Bots never count.
 * - Self-invites never count.
 * - Members who were already in the server before the campaign never count.
 * - One referral record per member per campaign and server.
 * - On rejoin: restores original inviter and restarts stay period; never switches inviter or counts twice.
 * - Stay period processed with stored dueAt (or immediately if stayHours === 0 and account age is met).
 */
export async function recordOrRestoreCampaignReferral(client, campaign, member, attributedInvite, joinedAt = new Date()) {
  if (!campaign || !member || member.user?.bot) return null;
  if (campaign.status !== CAMPAIGN_STATUS.ACTIVE) return null;

  const invitedUserId = String(member.id);
  const guildId = String(campaign.guildId);
  const campaignId = String(campaign.campaignId);
  const lockKey = `lock:inv_cmp:ref:${campaignId}:${invitedUserId}`;

  const createdOrRestored = await withCampaignLock(lockKey, async () => {
    const freshCampaign = (await getInviteCampaignById(campaignId)) || campaign;
    if (freshCampaign.status !== CAMPAIGN_STATUS.ACTIVE) return null;

    const existingRef = await getCampaignReferral(campaignId, guildId, invitedUserId);

    // Case 1: Member already has a referral record in this campaign & server (rejoin)
    if (existingRef) {
      if (existingRef.disqualified) {
        const updatedDisq = await updateCampaignReferral(campaignId, guildId, invitedUserId, {
          isActive: true,
          leftAt: null,
          counted: false,
          dueAt: null,
        });
        return { ref: updatedDisq, freshCampaign, disqualified: true };
      }

      // Restore original inviter relationship and count them again only once (never switch inviter)
      const restoredRef = await updateCampaignReferral(campaignId, guildId, invitedUserId, {
        isActive: true,
        leftAt: null,
        counted: true,
        countedAt: joinedAt,
        joinedAt,
        dueAt: null,
      });

      await recalculateParticipantEligibility(client, freshCampaign, restoredRef.inviterId);
      return { ref: restoredRef, freshCampaign, disqualified: false };
    }

    // Case 2: First join in this campaign — requires a valid attributed campaign invite
    if (!attributedInvite) return null;

    const inviterId = String(attributedInvite.inviterId);
    const inviteCode = String(attributedInvite.inviteCode);

    // Self-invites never count
    if (invitedUserId === inviterId) {
      const selfRef = await createCampaignReferral({
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
      return { ref: selfRef, freshCampaign, disqualified: true };
    }

    // Members who were already in the server before the campaign never count
    const initialMembers = Array.isArray(freshCampaign.initialMemberIds)
      ? freshCampaign.initialMemberIds
      : [];
    if (initialMembers.includes(invitedUserId)) {
      const preRef = await createCampaignReferral({
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
        disqualifyReason: 'Member was already in the server before the campaign',
        dueAt: null,
      });
      return { ref: preRef, freshCampaign, disqualified: true };
    }

    // Immediately count the referral and increment the owner's successful join count
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
    return { ref: createdRef, freshCampaign, disqualified: false };
  });

  if (!createdOrRestored || !createdOrRestored.ref) return null;
  return createdOrRestored.ref;
}

/**
 * Reconciles a single campaign on bot startup (Section 5 & Section 11):
 * - Rebuilds moderation allowlist and compares stored invite uses with current Discord invite uses.
 * - Detects members who left while the bot was offline and updates their referral/participant records.
 * - Detects members who joined while the bot was offline:
 *   - Attributes a join ONLY if it is certain (exactly one campaign invite increased and the number of new members matches).
 *   - Otherwise records offline joins as unattributed in UnattributedJoin (never guesses).
 * - Recalculates participants and eligibility, re-arms timers, and ensures the panel message exists in place.
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

  // Ensure member cache is populated if fetch is supported
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
          clearReferralTimer(campaign.campaignId, ref.invitedUserId);
          activeReferralByUser.delete(String(ref.invitedUserId));
        }
      }
    }

    // 2. Check if any participant (inviter) left or rejoined the server while offline
    const participants = await getParticipantsForCampaign(campaign.campaignId);
    for (const p of participants) {
      if (currentMembersMap.size > 0) {
        const inServer = currentMembersMap.has(p.userId);
        if (!inServer && !p.inviterLeftServer) {
          await upsertCampaignParticipant(campaign.campaignId, campaign.guildId, p.userId, {
            inviterLeftServer: true,
            isEligible: false,
            eligibleAt: null,
          });
        } else if (inServer && p.inviterLeftServer) {
          await upsertCampaignParticipant(campaign.campaignId, campaign.guildId, p.userId, {
            inviterLeftServer: false,
          });
        }
      }
    }

    // 3. Identify members who joined while the bot was offline
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

      const joinedMs = member.joinedTimestamp || (member.joinedAt ? new Date(member.joinedAt).getTime() : 0);
      if (joinedMs && joinedMs >= Math.max(startMs, lastSnapMs)) {
        offlineNewMembers.push(member);
      } else if (anyReferralByUser.has(uid) && !activeReferralByUser.has(uid)) {
        // Previously tracked member who left and rejoined while offline
        offlineNewMembers.push(member);
      }
    }

    // 4. Diff stored invite usage counts with current Discord invites
    const diff = await diffAndRefreshInviteSnapshot(guild, campaign);
    const { changedInvites } = diff;

    if (offlineNewMembers.length > 0) {
      // Attribute a join ONLY if it is certain (exactly one invite increased, it is a campaign invite, and the number of new members matches)
      const isCertainAttribution =
        changedInvites.length === 1 &&
        changedInvites[0].isCampaignInvite &&
        changedInvites[0].campaignInvite &&
        changedInvites[0].delta === offlineNewMembers.length;

      for (const member of offlineNewMembers) {
        const joinDate = member.joinedAt ? new Date(member.joinedAt) : now;
        const priorRef = anyReferralByUser.get(String(member.id));

        if (isCertainAttribution) {
          await recordOrRestoreCampaignReferral(
            client,
            campaign,
            member,
            changedInvites[0].campaignInvite,
            joinDate
          );
        } else if (priorRef) {
          // Rejoined member already has a bound original inviter
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

    // 5. Recalculate all participants and eligibility
    await recalculateAllCampaignParticipants(client, campaign);
  } else {
    // Campaign is Draft, Scheduled, or Paused: keep invite snapshot in sync
    await syncGuildInviteSnapshot(guild, campaign);
  }

  // 6. Evaluate due transitions and re-arm scheduled jobs
  const updatedCampaign = (await evaluateAndArmCampaignTimers(client, campaign.campaignId, now)) || campaign;

  // 7. Ensure panel message exists in invite channel (edit by stored ID, never post a duplicate)
  await ensureOrUpdateCampaignPanel(client, updatedCampaign, {
    allowCreateIfMissing: !updatedCampaign.panelMessageId,
  });
}

/**
 * Startup recovery entrypoint: loads all non-ended campaigns, rebuilds invite snapshots,
 * reconciles offline joins/leaves, restores participants/referrals/eligibility, re-arms timers,
 * and updates persistent panel messages in place.
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
