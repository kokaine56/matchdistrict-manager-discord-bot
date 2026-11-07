import {
  CAMPAIGN_STATUS,
  getCurrentGuildCampaign,
  getCampaignInvitesForCampaign,
  updateCampaignInviteUses,
  updateInviteCampaign,
} from '../models/inviteCampaignModels.js';

// guildId -> Map<inviteCode, { code: string, uses: number, inviterId: string | null }>
const guildSnapshots = new Map();

// guildId -> Map<inviteCode, { code: string, uses: number, inviterId: string | null, deletedAt: number }>
const recentlyDeletedInvites = new Map();

// guildId -> Set<string> (invite codes belonging to Active or Scheduled campaign in that guild)
const allowedGuildInviteCodes = new Map();
// guildId -> Set<string> (invite URLs belonging to Active or Scheduled campaign in that guild)
const allowedGuildInviteUrls = new Map();

const RECENT_DELETE_TTL_MS = 30 * 1000;

export function clearInviteSnapshotState() {
  guildSnapshots.clear();
  recentlyDeletedInvites.clear();
  allowedGuildInviteCodes.clear();
  allowedGuildInviteUrls.clear();
}

/**
 * Registers a campaign invite in the in-memory moderation allowlist and snapshot.
 */
export function registerCampaignInviteInCache(
  guildId,
  inviteCode,
  inviteUrl,
  uses = 0,
  inviterId = null,
  campaignStatus = CAMPAIGN_STATUS.ACTIVE
) {
  if (!guildId || !inviteCode) return;
  const gId = String(guildId);
  const code = String(inviteCode);
  const url = String(inviteUrl || `https://discord.gg/${code}`);

  if (campaignStatus === CAMPAIGN_STATUS.ACTIVE || campaignStatus === CAMPAIGN_STATUS.SCHEDULED) {
    if (!allowedGuildInviteCodes.has(gId)) {
      allowedGuildInviteCodes.set(gId, new Set());
    }
    allowedGuildInviteCodes.get(gId).add(code);

    if (!allowedGuildInviteUrls.has(gId)) {
      allowedGuildInviteUrls.set(gId, new Set());
    }
    allowedGuildInviteUrls.get(gId).add(url);
  }

  // Only add to guildSnapshots if the guild snapshot is already initialized in memory,
  // so we never mask a full guild snapshot that needs to be hydrated from MongoDB.
  if (guildSnapshots.has(gId)) {
    const snap = guildSnapshots.get(gId);
    snap.set(code, {
      code,
      uses: Number(uses || 0),
      inviterId: inviterId ? String(inviterId) : null,
    });
  }
}

/**
 * Refreshes the moderation allowlist cache for a guild based on its current campaign status.
 * Only Active or Scheduled campaigns allow their invite links to bypass link moderation.
 */
export async function refreshModerationAllowlistForGuild(guildId, campaign = null) {
  if (!guildId) return;
  const gId = String(guildId);
  const current = campaign || (await getCurrentGuildCampaign(gId));

  if (
    !current ||
    (current.status !== CAMPAIGN_STATUS.ACTIVE && current.status !== CAMPAIGN_STATUS.SCHEDULED)
  ) {
    allowedGuildInviteCodes.delete(gId);
    allowedGuildInviteUrls.delete(gId);
    return;
  }

  const invites = await getCampaignInvitesForCampaign(current.campaignId);
  const codeSet = new Set();
  const urlSet = new Set();

  for (const inv of invites) {
    if (inv.inviteCode) codeSet.add(String(inv.inviteCode));
    if (inv.inviteUrl) urlSet.add(String(inv.inviteUrl));
  }

  allowedGuildInviteCodes.set(gId, codeSet);
  allowedGuildInviteUrls.set(gId, urlSet);
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Strips allowed campaign invite URLs and codes for the guild's Active or Scheduled campaign
 * from a message string so moderation only checks remaining text for prohibited links.
 *
 * @param {string} guildId
 * @param {string} content
 * @returns {Promise<string>}
 */
export async function stripAllowedCampaignInviteLinks(guildId, content) {
  if (!guildId || !content || typeof content !== 'string') return content || '';
  const gId = String(guildId);

  let codes = allowedGuildInviteCodes.get(gId);
  let urls = allowedGuildInviteUrls.get(gId);

  // Lazy-hydrate from DB/store if cache is empty
  if (!codes) {
    const campaign = await getCurrentGuildCampaign(gId);
    if (
      campaign &&
      (campaign.status === CAMPAIGN_STATUS.ACTIVE || campaign.status === CAMPAIGN_STATUS.SCHEDULED)
    ) {
      await refreshModerationAllowlistForGuild(gId, campaign);
      codes = allowedGuildInviteCodes.get(gId);
      urls = allowedGuildInviteUrls.get(gId);
    }
  }

  if ((!codes || codes.size === 0) && (!urls || urls.size === 0)) {
    return content;
  }

  let sanitized = content;

  // 1. Strip exact stored invite URLs
  if (urls && urls.size > 0) {
    for (const url of urls) {
      if (!url) continue;
      const urlRegex = new RegExp(escapeRegExp(url) + '(?![\\w-])', 'g');
      sanitized = sanitized.replace(urlRegex, ' ');
    }
  }

  // 2. Strip standard Discord invite URL variations and standalone invite codes for allowed codes
  if (codes && codes.size > 0) {
    for (const code of codes) {
      if (!code) continue;
      const escCode = escapeRegExp(code);
      const discordUrlPattern = new RegExp(
        `(?:https?:\\/\\/)?(?:www\\.)?(?:discord\\.gg|discord(?:app)?\\.com\\/invite)\\/${escCode}(?![\\w-])`,
        'gi'
      );
      sanitized = sanitized.replace(discordUrlPattern, ' ');
    }
  }

  return sanitized;
}

/**
 * Fetches current guild invites from Discord and synchronizes both the in-memory snapshot
 * and MongoDB persistence (CampaignInvite.lastKnownUses + InviteCampaign.guildInviteSnapshot).
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} [campaign]
 * @returns {Promise<Map<string, { code: string, uses: number, inviterId: string | null }>>}
 */
export async function syncGuildInviteSnapshot(guild, campaign = null) {
  if (!guild) return new Map();
  const gId = String(guild.id);
  const currentCampaign = campaign || (await getCurrentGuildCampaign(gId));

  const map = new Map();

  // Seed from stored campaign invites first
  if (currentCampaign) {
    if (
      currentCampaign.guildInviteSnapshot &&
      typeof currentCampaign.guildInviteSnapshot === 'object'
    ) {
      for (const [code, entry] of Object.entries(currentCampaign.guildInviteSnapshot)) {
        map.set(code, {
          code,
          uses: Number(entry?.uses ?? 0),
          inviterId: entry?.inviterId || null,
        });
      }
    }
    const dbInvites = await getCampaignInvitesForCampaign(currentCampaign.campaignId);
    for (const inv of dbInvites) {
      map.set(inv.inviteCode, {
        code: inv.inviteCode,
        uses: Number(inv.lastKnownUses || 0),
        inviterId: inv.inviterId || null,
      });
    }
    await refreshModerationAllowlistForGuild(gId, currentCampaign);
  }

  // Fetch live invites from Discord if available
  if (typeof guild.invites?.fetch === 'function') {
    try {
      const fetched = await guild.invites.fetch();
      if (fetched && typeof fetched.values === 'function') {
        map.clear();
        for (const inv of fetched.values()) {
          if (!inv?.code) continue;
          const uses = Number(inv.uses || 0);
          const inviterId = inv.inviter?.id || inv.inviterId || null;
          map.set(inv.code, { code: inv.code, uses, inviterId });
          if (currentCampaign) {
            await updateCampaignInviteUses(inv.code, uses).catch(() => {});
          }
        }
      }
    } catch (err) {
      console.warn(`[InviteCampaign] ⚠️ Could not fetch invites for guild ${gId}:`, err.message);
    }
  }

  guildSnapshots.set(gId, map);

  if (currentCampaign) {
    const serialized = {};
    for (const [code, val] of map.entries()) {
      serialized[code] = { uses: val.uses, inviterId: val.inviterId };
    }
    await updateInviteCampaign(currentCampaign.campaignId, {
      guildInviteSnapshot: serialized,
      lastSnapshotAt: new Date(),
    }).catch(() => {});
  }

  return map;
}

/**
 * Returns the current in-memory snapshot for a guild (hydrating from DB if needed).
 */
export async function getGuildInviteSnapshot(guildId, campaign = null) {
  const gId = String(guildId);
  const currentCampaign = campaign || (await getCurrentGuildCampaign(gId));

  let map = guildSnapshots.get(gId);
  if (!map) {
    map = new Map();
    if (
      currentCampaign?.guildInviteSnapshot &&
      typeof currentCampaign.guildInviteSnapshot === 'object'
    ) {
      for (const [code, entry] of Object.entries(currentCampaign.guildInviteSnapshot)) {
        map.set(code, {
          code,
          uses: Number(entry?.uses ?? 0),
          inviterId: entry?.inviterId || null,
        });
      }
    }
    guildSnapshots.set(gId, map);
  }

  // Always ensure all CampaignInvite records from MongoDB are present in the snapshot map
  if (currentCampaign) {
    const dbInvites = await getCampaignInvitesForCampaign(currentCampaign.campaignId);
    for (const inv of dbInvites) {
      if (!map.has(inv.inviteCode)) {
        map.set(inv.inviteCode, {
          code: inv.inviteCode,
          uses: Number(inv.lastKnownUses || 0),
          inviterId: inv.inviterId || null,
        });
      }
    }
  }

  return map;
}

/**
 * Handles Discord's InviteCreate event to keep the server snapshot accurate.
 */
export async function recordInviteCreated(invite) {
  const guildId = invite?.guild?.id || invite?.guildId;
  if (!guildId || !invite?.code) return;
  const gId = String(guildId);
  const snap = await getGuildInviteSnapshot(gId);
  const existing = snap.get(invite.code);
  const uses = Number(invite.uses ?? existing?.uses ?? 0);
  const inviterId = invite.inviter?.id || invite.inviterId || existing?.inviterId || null;

  snap.set(invite.code, {
    code: invite.code,
    uses,
    inviterId,
  });

  const currentCampaign = await getCurrentGuildCampaign(gId);
  if (currentCampaign) {
    const serialized = {};
    for (const [c, v] of snap.entries()) {
      serialized[c] = { uses: v.uses, inviterId: v.inviterId };
    }
    await updateInviteCampaign(currentCampaign.campaignId, {
      guildInviteSnapshot: serialized,
      lastSnapshotAt: new Date(),
    }).catch(() => {});
  }
}

/**
 * Handles Discord's InviteDelete event: remembers the last known uses of the deleted invite
 * in a short-lived cache (in case it was deleted right after a join) and removes it from the live snapshot.
 */
export async function recordInviteDeleted(invite) {
  const guildId = invite?.guild?.id || invite?.guildId;
  if (!guildId || !invite?.code) return;
  const gId = String(guildId);
  const snap = await getGuildInviteSnapshot(gId);
  const prior = snap.get(invite.code);

  if (!recentlyDeletedInvites.has(gId)) {
    recentlyDeletedInvites.set(gId, new Map());
  }
  recentlyDeletedInvites.get(gId).set(invite.code, {
    code: invite.code,
    uses: Number(invite.uses ?? prior?.uses ?? 0),
    inviterId: invite.inviter?.id || prior?.inviterId || null,
    deletedAt: Date.now(),
  });

  snap.delete(invite.code);

  const currentCampaign = await getCurrentGuildCampaign(gId);
  if (currentCampaign) {
    const serialized = {};
    for (const [c, v] of snap.entries()) {
      serialized[c] = { uses: v.uses, inviterId: v.inviterId };
    }
    await updateInviteCampaign(currentCampaign.campaignId, {
      guildInviteSnapshot: serialized,
      lastSnapshotAt: new Date(),
    }).catch(() => {});
  }
}

/**
 * Fetches live invites from Discord, compares their usage counts with the snapshot
 * and stored CampaignInvite.lastKnownUses, updates the snapshot & DB, and returns the diff.
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} campaign
 * @returns {Promise<{
 *   changedInvites: Array<{ code: string, priorUses: number, currentUses: number, delta: number, isCampaignInvite: boolean, campaignInvite: object | null }>,
 *   changedCampaignInvites: Array<{ code: string, priorUses: number, currentUses: number, delta: number, isCampaignInvite: boolean, campaignInvite: object }>,
 *   hadRecentlyDeletedInvite: boolean,
 *   deletedInviteCodes: string[],
 *   fetchFailed: boolean
 * }>}
 */
export async function diffAndRefreshInviteSnapshot(guild, campaign) {
  const gId = String(guild.id);
  const priorSnapshot = await getGuildInviteSnapshot(gId, campaign);
  const campaignInvites = campaign
    ? await getCampaignInvitesForCampaign(campaign.campaignId)
    : [];
  const campaignInviteByCode = new Map(campaignInvites.map((ci) => [ci.inviteCode, ci]));

  // Clean up expired recentlyDeletedInvites
  const nowMs = Date.now();
  const recentDeletesMap = recentlyDeletedInvites.get(gId);
  const activeRecentDeletes = [];
  if (recentDeletesMap) {
    for (const [code, entry] of recentDeletesMap.entries()) {
      if (nowMs - entry.deletedAt <= RECENT_DELETE_TTL_MS) {
        activeRecentDeletes.push(code);
      } else {
        recentDeletesMap.delete(code);
      }
    }
  }

  let fetchedInvites = null;
  try {
    if (typeof guild.invites?.fetch === 'function') {
      fetchedInvites = await guild.invites.fetch();
    }
  } catch (err) {
    console.warn(`[InviteCampaign] ⚠️ Failed to fetch invites on join in guild ${gId}:`, err.message);
    return {
      changedInvites: [],
      changedCampaignInvites: [],
      hadRecentlyDeletedInvite: activeRecentDeletes.length > 0,
      deletedInviteCodes: activeRecentDeletes,
      fetchFailed: true,
    };
  }

  if (!fetchedInvites || typeof fetchedInvites.values !== 'function') {
    return {
      changedInvites: [],
      changedCampaignInvites: [],
      hadRecentlyDeletedInvite: activeRecentDeletes.length > 0,
      deletedInviteCodes: activeRecentDeletes,
      fetchFailed: true,
    };
  }

  const changedInvites = [];
  const changedCampaignInvites = [];
  const nextSnapshot = new Map();
  const seenCodes = new Set();

  for (const inv of fetchedInvites.values()) {
    if (!inv?.code) continue;
    const code = String(inv.code);
    seenCodes.add(code);

    const currentUses = Number(inv.uses || 0);
    const campaignInvite = campaignInviteByCode.get(code) || null;
    const snapEntry = priorSnapshot.get(code);

    let priorUses;
    if (campaignInvite) {
      // For campaign invites, CampaignInvite.lastKnownUses in MongoDB and snapshot are authoritative
      priorUses =
        snapEntry !== undefined
          ? Number(snapEntry.uses || 0)
          : Number(campaignInvite.lastKnownUses || 0);
    } else if (snapEntry !== undefined) {
      priorUses = Number(snapEntry.uses || 0);
    } else {
      // If a non-campaign invite was not in the snapshot and already had >1 uses, baseline it at currentUses
      priorUses = currentUses === 1 ? 0 : currentUses;
    }

    const delta = currentUses - priorUses;
    if (delta > 0) {
      const changeObj = {
        code,
        priorUses,
        currentUses,
        delta,
        isCampaignInvite: Boolean(campaignInvite),
        campaignInvite,
      };
      changedInvites.push(changeObj);
      if (campaignInvite) {
        changedCampaignInvites.push(changeObj);
      }
    }

    nextSnapshot.set(code, {
      code,
      uses: currentUses,
      inviterId:
        campaignInvite?.inviterId ||
        inv.inviter?.id ||
        inv.inviterId ||
        snapEntry?.inviterId ||
        null,
    });

    if (campaignInvite && currentUses !== campaignInvite.lastKnownUses) {
      await updateCampaignInviteUses(code, currentUses).catch(() => {});
    }
  }

  // Check if any invite present in priorSnapshot disappeared without an InviteDelete event
  for (const [oldCode] of priorSnapshot.entries()) {
    if (!seenCodes.has(oldCode) && !activeRecentDeletes.includes(oldCode)) {
      activeRecentDeletes.push(oldCode);
    }
  }

  guildSnapshots.set(gId, nextSnapshot);

  if (campaign) {
    const serialized = {};
    for (const [code, val] of nextSnapshot.entries()) {
      serialized[code] = { uses: val.uses, inviterId: val.inviterId };
    }
    await updateInviteCampaign(campaign.campaignId, {
      guildInviteSnapshot: serialized,
      lastSnapshotAt: new Date(),
    }).catch(() => {});
  }

  return {
    changedInvites,
    changedCampaignInvites,
    hadRecentlyDeletedInvite: activeRecentDeletes.length > 0,
    deletedInviteCodes: activeRecentDeletes,
    fetchFailed: false,
  };
}
