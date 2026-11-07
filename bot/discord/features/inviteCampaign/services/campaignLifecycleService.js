import { GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { enqueueDiscordAction } from '../../../../../discordQueue.js';
import {
  CAMPAIGN_STATUS,
  NON_ENDED_STATUSES,
  withCampaignLock,
  getInviteCampaignById,
  updateInviteCampaign,
  getCampaignInvitesForCampaign,
  getPendingReferralsForCampaign,
  updateCampaignReferral,
} from '../models/inviteCampaignModels.js';
import {
  syncGuildInviteSnapshot,
  refreshModerationAllowlistForGuild,
} from './inviteSnapshotService.js';
import { recalculateAllCampaignParticipants } from './eligibilityService.js';
import {
  ensureOrUpdateCampaignPanel,
  postCampaignFinalResults,
} from './campaignPanelService.js';

/**
 * Checks whether a Discord client has a specific GatewayIntentBit enabled.
 */
function hasGatewayIntent(client, intentBit) {
  const intents = client?.options?.intents;
  if (!intents) return true; // If not explicitly configured on a mock client, assume present unless specified
  if (typeof intents.has === 'function') {
    return intents.has(intentBit);
  }
  if (Array.isArray(intents)) {
    return intents.includes(intentBit);
  }
  if (typeof intents.bitfield === 'number' || typeof intents.bitfield === 'bigint') {
    return Boolean(BigInt(intents.bitfield) & BigInt(intentBit));
  }
  if (typeof intents === 'number' || typeof intents === 'bigint') {
    return Boolean(BigInt(intents) & BigInt(intentBit));
  }
  return true;
}

/**
 * Verifies that GuildMembers and GuildInvites intents are enabled on the client,
 * and that the bot has Manage Server (ManageGuild) and Create Invite (CreateInstantInvite) permissions in the guild.
 *
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').Guild} guild
 * @returns {{ valid: boolean, missingIntents: string[], missingPermissions: string[], summary: string }}
 */
export function verifyCampaignBotRequirements(client, guild) {
  const missingIntents = [];
  const missingPermissions = [];

  if (!hasGatewayIntent(client, GatewayIntentBits.GuildMembers)) {
    missingIntents.push('GuildMembers (Server Members Intent)');
  }
  if (!hasGatewayIntent(client, GatewayIntentBits.GuildInvites)) {
    missingIntents.push('GuildInvites');
  }

  const botMember = guild?.members?.me;
  if (!botMember || !botMember.permissions) {
    missingPermissions.push('Manage Server', 'Create Invite');
  } else {
    if (!botMember.permissions.has(PermissionFlagsBits.ManageGuild)) {
      missingPermissions.push('Manage Server (ManageGuild)');
    }
    if (!botMember.permissions.has(PermissionFlagsBits.CreateInstantInvite)) {
      missingPermissions.push('Create Invite (CreateInstantInvite)');
    }
  }

  const valid = missingIntents.length === 0 && missingPermissions.length === 0;
  const parts = [];
  if (missingIntents.length > 0) {
    parts.push(`Missing Gateway Intents: **${missingIntents.join(', ')}**`);
  }
  if (missingPermissions.length > 0) {
    parts.push(`Missing Bot Permissions: **${missingPermissions.join(', ')}**`);
  }

  return {
    valid,
    missingIntents,
    missingPermissions,
    summary: parts.join(' | '),
  };
}

/**
 * Collects current member IDs in the guild (excluding bots) so pre-existing members
 * who leave and rejoin cannot be counted as new campaign referrals.
 */
async function collectGuildMemberIds(guild, existingIds = []) {
  const idSet = new Set(Array.isArray(existingIds) ? existingIds.map(String) : []);
  if (!guild?.members) return [...idSet];

  if (guild.members.cache && typeof guild.members.cache.values === 'function') {
    for (const m of guild.members.cache.values()) {
      if (m?.id && !m.user?.bot) {
        idSet.add(String(m.id));
      }
    }
  }
  return [...idSet];
}

/**
 * Activates a Draft or Scheduled campaign.
 *
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').Guild} guild
 * @param {object|string} campaignOrId
 * @param {Date} [now]
 * @returns {Promise<{ ok: boolean, campaign?: object, error?: string, missingIntents?: string[], missingPermissions?: string[] }>}
 */
export async function startCampaign(client, guild, campaignOrId, now = new Date()) {
  const campaignId = typeof campaignOrId === 'string' ? campaignOrId : campaignOrId?.campaignId;
  if (!campaignId) return { ok: false, error: 'Campaign not found.' };

  return withCampaignLock(`lock:inv_cmp:lifecycle:${campaignId}`, async () => {
    const campaign = await getInviteCampaignById(campaignId);
    if (!campaign) return { ok: false, error: 'Campaign not found.' };

    if (campaign.status === CAMPAIGN_STATUS.ACTIVE) {
      return { ok: true, campaign };
    }
    if (
      campaign.status !== CAMPAIGN_STATUS.DRAFT &&
      campaign.status !== CAMPAIGN_STATUS.SCHEDULED
    ) {
      return {
        ok: false,
        error: `Cannot start a campaign in **${campaign.status}** state (must be Draft or Scheduled).`,
      };
    }

    const effectiveGuild =
      guild ||
      client?.guilds?.cache?.get(campaign.guildId) ||
      (typeof client?.guilds?.fetch === 'function'
        ? await client.guilds.fetch(campaign.guildId).catch(() => null)
        : null);

    if (!effectiveGuild) {
      return { ok: false, error: 'Guild not available to start the campaign.' };
    }

    // Check required intents and permissions
    const reqCheck = verifyCampaignBotRequirements(client, effectiveGuild);
    if (!reqCheck.valid) {
      return {
        ok: false,
        error: `❌ **Cannot start campaign — missing required Discord configuration:**\n${reqCheck.summary}`,
        missingIntents: reqCheck.missingIntents,
        missingPermissions: reqCheck.missingPermissions,
      };
    }

    const initialMemberIds = await collectGuildMemberIds(effectiveGuild, campaign.initialMemberIds);
    const effectiveStartAt =
      campaign.status === CAMPAIGN_STATUS.SCHEDULED && campaign.startAt && new Date(campaign.startAt) <= now
        ? new Date(campaign.startAt)
        : now;

    const updated = await updateInviteCampaign(campaign.campaignId, {
      status: CAMPAIGN_STATUS.ACTIVE,
      startAt: effectiveStartAt,
      initialMemberIds,
    });

    await syncGuildInviteSnapshot(effectiveGuild, updated);
    await refreshModerationAllowlistForGuild(effectiveGuild.id, updated);
    if (client) {
      await ensureOrUpdateCampaignPanel(client, updated);
    }

    return { ok: true, campaign: updated };
  });
}

/**
 * Pauses an Active campaign. Joins during a pause are not counted.
 */
export async function pauseCampaign(client, guild, campaignOrId) {
  const campaignId = typeof campaignOrId === 'string' ? campaignOrId : campaignOrId?.campaignId;
  if (!campaignId) return { ok: false, error: 'Campaign not found.' };

  return withCampaignLock(`lock:inv_cmp:lifecycle:${campaignId}`, async () => {
    const campaign = await getInviteCampaignById(campaignId);
    if (!campaign) return { ok: false, error: 'Campaign not found.' };

    if (campaign.status !== CAMPAIGN_STATUS.ACTIVE) {
      return {
        ok: false,
        error: `Cannot pause a campaign in **${campaign.status}** state (must be Active).`,
      };
    }

    const updated = await updateInviteCampaign(campaign.campaignId, {
      status: CAMPAIGN_STATUS.PAUSED,
    });

    await refreshModerationAllowlistForGuild(campaign.guildId, updated);
    if (client) {
      await ensureOrUpdateCampaignPanel(client, updated);
    }

    return { ok: true, campaign: updated };
  });
}

/**
 * Resumes a Paused campaign. Joins that occurred during the pause are baselined and not counted.
 */
export async function resumeCampaign(client, guild, campaignOrId) {
  const campaignId = typeof campaignOrId === 'string' ? campaignOrId : campaignOrId?.campaignId;
  if (!campaignId) return { ok: false, error: 'Campaign not found.' };

  return withCampaignLock(`lock:inv_cmp:lifecycle:${campaignId}`, async () => {
    const campaign = await getInviteCampaignById(campaignId);
    if (!campaign) return { ok: false, error: 'Campaign not found.' };

    if (campaign.status !== CAMPAIGN_STATUS.PAUSED) {
      return {
        ok: false,
        error: `Cannot resume a campaign in **${campaign.status}** state (must be Paused).`,
      };
    }

    const effectiveGuild =
      guild ||
      client?.guilds?.cache?.get(campaign.guildId) ||
      (typeof client?.guilds?.fetch === 'function'
        ? await client.guilds.fetch(campaign.guildId).catch(() => null)
        : null);

    if (!effectiveGuild) {
      return { ok: false, error: 'Guild not available to resume the campaign.' };
    }

    const reqCheck = verifyCampaignBotRequirements(client, effectiveGuild);
    if (!reqCheck.valid) {
      return {
        ok: false,
        error: `❌ **Cannot resume campaign — missing required Discord configuration:**\n${reqCheck.summary}`,
        missingIntents: reqCheck.missingIntents,
        missingPermissions: reqCheck.missingPermissions,
      };
    }

    // Baseline current server members and current invite usages so joins during pause are never counted
    const initialMemberIds = await collectGuildMemberIds(effectiveGuild, campaign.initialMemberIds);
    const updated = await updateInviteCampaign(campaign.campaignId, {
      status: CAMPAIGN_STATUS.ACTIVE,
      initialMemberIds,
    });

    await syncGuildInviteSnapshot(effectiveGuild, updated);
    await refreshModerationAllowlistForGuild(effectiveGuild.id, updated);
    if (client) {
      await ensureOrUpdateCampaignPanel(client, updated);
    }

    return { ok: true, campaign: updated };
  });
}

/**
 * Deletes all Discord invites created for a campaign via the shared rate-limited queue,
 * while preserving the CampaignInvite records in MongoDB.
 */
async function deleteCampaignDiscordInvites(guild, campaignId) {
  if (!guild || !campaignId) return 0;
  const campaignInvites = await getCampaignInvitesForCampaign(campaignId);
  let deletedCount = 0;

  for (const inv of campaignInvites) {
    if (!inv.inviteCode) continue;
    try {
      await enqueueDiscordAction(async () => {
        try {
          if (typeof guild.invites?.delete === 'function') {
            await guild.invites.delete(inv.inviteCode, 'Invite & Earn campaign ended');
            deletedCount++;
          } else if (typeof guild.invites?.fetch === 'function') {
            const fetched = await guild.invites.fetch(inv.inviteCode).catch(() => null);
            if (fetched && typeof fetched.delete === 'function') {
              await fetched.delete('Invite & Earn campaign ended');
              deletedCount++;
            }
          }
        } catch (err) {
          if (err?.code === 10006) return; // Unknown Invite (already deleted)
          throw err;
        }
      }, 'action');
    } catch (err) {
      console.warn(`[InviteCampaign] ⚠️ Failed to delete campaign invite ${inv.inviteCode}:`, err.message);
    }
  }

  return deletedCount;
}

/**
 * Ends a campaign:
 * 1. Freezes final counts and eligibility.
 * 2. Transitions status to Ended and sets endedAt.
 * 3. Clears pending referral due timers so no later stay completions change counts.
 * 4. Deletes all the campaign's invite links from Discord (keeping MongoDB records).
 * 5. Disables the panel's button and updates the panel status to Ended.
 * 6. Posts the final result in the announcement channel.
 */
export async function endCampaign(client, guild, campaignOrId, now = new Date()) {
  const campaignId = typeof campaignOrId === 'string' ? campaignOrId : campaignOrId?.campaignId;
  if (!campaignId) return { ok: false, error: 'Campaign not found.' };

  return withCampaignLock(`lock:inv_cmp:lifecycle:${campaignId}`, async () => {
    const campaign = await getInviteCampaignById(campaignId);
    if (!campaign) return { ok: false, error: 'Campaign not found.' };

    if (campaign.status === CAMPAIGN_STATUS.ENDED) {
      return { ok: true, campaign, alreadyEnded: true };
    }
    if (!NON_ENDED_STATUSES.includes(campaign.status)) {
      return { ok: false, error: `Campaign is already in ${campaign.status} state.` };
    }

    const effectiveGuild =
      guild ||
      client?.guilds?.cache?.get(campaign.guildId) ||
      (typeof client?.guilds?.fetch === 'function'
        ? await client.guilds.fetch(campaign.guildId).catch(() => null)
        : null);

    // 1. Freeze final counts and eligibility from active counted referrals before marking Ended
    await recalculateAllCampaignParticipants(client, campaign, {
      allowEndedFreeze: true,
      skipNotifications: false,
    });

    // 2. Clear dueAt on any still-pending referrals so they never count after campaign end
    const pendingRefs = await getPendingReferralsForCampaign(campaign.campaignId);
    for (const ref of pendingRefs) {
      await updateCampaignReferral(campaign.campaignId, campaign.guildId, ref.invitedUserId, {
        dueAt: null,
      });
    }

    // 3. Mark campaign as Ended in MongoDB
    const endedCampaign = await updateInviteCampaign(campaign.campaignId, {
      status: CAMPAIGN_STATUS.ENDED,
      endedAt: now,
    });

    // 4. Remove campaign invites from moderation allowlist
    await refreshModerationAllowlistForGuild(campaign.guildId, endedCampaign);

    // 5. Update panel message immediately (status: Ended, button: disabled)
    if (client) {
      await ensureOrUpdateCampaignPanel(client, endedCampaign, { allowCreateIfMissing: false });
    }

    // 6. Delete all campaign invites from Discord (keeping records in CampaignInvite)
    if (effectiveGuild) {
      await deleteCampaignDiscordInvites(effectiveGuild, endedCampaign.campaignId);
    }

    // 7. Post final result in the announcement channel
    if (client) {
      await postCampaignFinalResults(client, endedCampaign);
    }

    return { ok: true, campaign: endedCampaign };
  });
}
