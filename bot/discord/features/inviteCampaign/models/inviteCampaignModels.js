import crypto from 'node:crypto';
import { getMongoDb, isMongoConnected, acquireLock, releaseLock } from '../../../../../mongoService.js';

export const CAMPAIGN_STATUS = {
  DRAFT: 'Draft',
  SCHEDULED: 'Scheduled',
  ACTIVE: 'Active',
  PAUSED: 'Paused',
  ENDED: 'Ended',
};

export const NON_ENDED_STATUSES = [
  CAMPAIGN_STATUS.DRAFT,
  CAMPAIGN_STATUS.SCHEDULED,
  CAMPAIGN_STATUS.ACTIVE,
  CAMPAIGN_STATUS.PAUSED,
];

export const COLLECTIONS = {
  INVITE_CAMPAIGN: 'InviteCampaign',
  CAMPAIGN_INVITE: 'CampaignInvite',
  CAMPAIGN_REFERRAL: 'CampaignReferral',
  CAMPAIGN_PARTICIPANT: 'CampaignParticipant',
  UNATTRIBUTED_JOIN: 'UnattributedJoin',
};

// In-memory fallback stores for unit testing when MongoDB is not connected
const memCampaigns = new Map(); // campaignId -> doc
const memInvites = new Map(); // `${campaignId}:${inviterId}` -> doc
const memReferrals = new Map(); // `${campaignId}:${guildId}:${invitedUserId}` -> doc
const memParticipants = new Map(); // `${campaignId}:${userId}` -> doc
const memUnattributedJoins = []; // array of docs
const localMutexChains = new Map();

export function clearInMemoryInviteCampaignData() {
  memCampaigns.clear();
  memInvites.clear();
  memReferrals.clear();
  memParticipants.clear();
  memUnattributedJoins.length = 0;
  localMutexChains.clear();
}

function createDuplicateKeyError(message) {
  const err = new Error(message);
  err.code = 11000;
  return err;
}

/**
 * Serializes operations for a given lockKey across both in-memory execution and MongoDB locks.
 *
 * @template T
 * @param {string} lockKey
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withCampaignLock(lockKey, fn) {
  const prev = localMutexChains.get(lockKey) || Promise.resolve();
  let releaseLocal;
  const current = new Promise((resolve) => {
    releaseLocal = resolve;
  });
  localMutexChains.set(lockKey, prev.then(() => current));

  await prev;
  await acquireLock(lockKey, 15, 5000);
  try {
    return await fn();
  } finally {
    await releaseLock(lockKey);
    releaseLocal();
    if (localMutexChains.get(lockKey) === current) {
      localMutexChains.delete(lockKey);
    }
  }
}

/**
 * Creates all required indexes for the Invite & Earn campaign collections in MongoDB.
 *
 * @param {import('mongodb').Db} [dbInstance]
 */
export async function ensureInviteCampaignIndexes(dbInstance = null) {
  const db = dbInstance || getMongoDb();
  if (!db) return;

  try {
    const campaignCol = db.collection(COLLECTIONS.INVITE_CAMPAIGN);
    await campaignCol.createIndex({ campaignId: 1 }, { unique: true });
    // Partial unique index: only one campaign per server can be Draft, Scheduled, Active, or Paused at a time
    await campaignCol.createIndex(
      { guildId: 1 },
      {
        unique: true,
        name: 'uniq_active_campaign_per_guild',
        partialFilterExpression: {
          status: { $in: NON_ENDED_STATUSES },
        },
      }
    );
    await campaignCol.createIndex({ guildId: 1, status: 1 });
    await campaignCol.createIndex({ status: 1, startAt: 1, endAt: 1 });

    const inviteCol = db.collection(COLLECTIONS.CAMPAIGN_INVITE);
    await inviteCol.createIndex({ campaignId: 1, inviterId: 1 }, { unique: true });
    await inviteCol.createIndex({ inviteCode: 1 }, { unique: true });
    await inviteCol.createIndex({ guildId: 1, campaignId: 1 });

    const referralCol = db.collection(COLLECTIONS.CAMPAIGN_REFERRAL);
    await referralCol.createIndex({ campaignId: 1, guildId: 1, invitedUserId: 1 }, { unique: true });
    await referralCol.createIndex({ campaignId: 1, inviterId: 1 });
    await referralCol.createIndex({ campaignId: 1, isActive: 1, counted: 1, dueAt: 1 });

    const participantCol = db.collection(COLLECTIONS.CAMPAIGN_PARTICIPANT);
    await participantCol.createIndex({ campaignId: 1, userId: 1 }, { unique: true });
    await participantCol.createIndex({ campaignId: 1, isEligible: 1, successfulInvites: -1 });

    const unattributedCol = db.collection(COLLECTIONS.UNATTRIBUTED_JOIN);
    await unattributedCol.createIndex({ campaignId: 1, guildId: 1, userId: 1, joinedAt: 1 });
    await unattributedCol.createIndex({ campaignId: 1, guildId: 1, reviewed: 1 });
  } catch (err) {
    console.warn('[InviteCampaign] ⚠️ Error creating MongoDB indexes:', err.message);
  }
}

// ============================================================================
// 1. InviteCampaign Operations
// ============================================================================

export async function createInviteCampaign(data) {
  const now = new Date();
  const doc = {
    campaignId: data.campaignId || `cmp_${crypto.randomBytes(6).toString('hex')}`,
    guildId: String(data.guildId),
    name: String(data.name).trim(),
    description: String(data.description || '').trim(),
    status: data.status || CAMPAIGN_STATUS.DRAFT,
    startAt: data.startAt ? new Date(data.startAt) : null,
    endAt: data.endAt ? new Date(data.endAt) : null,
    requiredInvites: Math.max(1, Number(data.requiredInvites || 1)),
    stayHours: data.stayHours !== undefined ? Number(data.stayHours) : 24,
    minAccountAgeDays: data.minAccountAgeDays !== undefined ? Number(data.minAccountAgeDays) : 7,
    inviteChannelId: String(data.inviteChannelId),
    announcementChannelId: String(data.announcementChannelId),
    panelMessageId: data.panelMessageId ? String(data.panelMessageId) : null,
    createdBy: String(data.createdBy),
    createdAt: data.createdAt ? new Date(data.createdAt) : now,
    endedAt: data.endedAt ? new Date(data.endedAt) : null,
    initialMemberIds: Array.isArray(data.initialMemberIds) ? [...data.initialMemberIds] : [],
    guildInviteSnapshot: data.guildInviteSnapshot || {},
    lastSnapshotAt: data.lastSnapshotAt ? new Date(data.lastSnapshotAt) : null,
    limitAlertSent: Boolean(data.limitAlertSent),
  };

  if (isMongoConnected()) {
    const db = getMongoDb();
    await db.collection(COLLECTIONS.INVITE_CAMPAIGN).insertOne({ ...doc });
    return doc;
  }

  // Enforce partial unique index in memory
  if (NON_ENDED_STATUSES.includes(doc.status)) {
    for (const existing of memCampaigns.values()) {
      if (existing.guildId === doc.guildId && NON_ENDED_STATUSES.includes(existing.status)) {
        throw createDuplicateKeyError(
          `E11000 duplicate key error: guild ${doc.guildId} already has a ${existing.status} campaign (${existing.campaignId}).`
        );
      }
    }
  }
  if (memCampaigns.has(doc.campaignId)) {
    throw createDuplicateKeyError(`E11000 duplicate key error on campaignId ${doc.campaignId}`);
  }

  memCampaigns.set(doc.campaignId, { ...doc });
  return { ...doc };
}

export async function getInviteCampaignById(campaignId) {
  if (!campaignId) return null;
  if (isMongoConnected()) {
    const db = getMongoDb();
    return db.collection(COLLECTIONS.INVITE_CAMPAIGN).findOne({ campaignId: String(campaignId) });
  }
  const doc = memCampaigns.get(String(campaignId));
  return doc ? { ...doc } : null;
}

/**
 * Returns the current non-ended campaign (Draft, Scheduled, Active, or Paused) for a guild.
 */
export async function getCurrentGuildCampaign(guildId) {
  if (!guildId) return null;
  if (isMongoConnected()) {
    const db = getMongoDb();
    return db.collection(COLLECTIONS.INVITE_CAMPAIGN).findOne({
      guildId: String(guildId),
      status: { $in: NON_ENDED_STATUSES },
    });
  }
  for (const doc of memCampaigns.values()) {
    if (doc.guildId === String(guildId) && NON_ENDED_STATUSES.includes(doc.status)) {
      return { ...doc };
    }
  }
  return null;
}

/**
 * Returns the current non-ended campaign for a guild, or the most recently created/ended campaign if none is active.
 */
export async function getLatestGuildCampaign(guildId) {
  if (!guildId) return null;
  const active = await getCurrentGuildCampaign(guildId);
  if (active) return active;

  if (isMongoConnected()) {
    const db = getMongoDb();
    const list = await db
      .collection(COLLECTIONS.INVITE_CAMPAIGN)
      .find({ guildId: String(guildId) })
      .sort({ createdAt: -1 })
      .limit(1)
      .toArray();
    return list[0] || null;
  }

  const matching = [...memCampaigns.values()]
    .filter((c) => c.guildId === String(guildId))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return matching[0] ? { ...matching[0] } : null;
}

export async function getAllNonEndedCampaigns() {
  if (isMongoConnected()) {
    const db = getMongoDb();
    return db
      .collection(COLLECTIONS.INVITE_CAMPAIGN)
      .find({ status: { $in: NON_ENDED_STATUSES } })
      .toArray();
  }
  return [...memCampaigns.values()]
    .filter((c) => NON_ENDED_STATUSES.includes(c.status))
    .map((c) => ({ ...c }));
}

export async function updateInviteCampaign(campaignId, updates) {
  if (!campaignId) return null;
  const cleanUpdates = { ...updates };
  delete cleanUpdates._id;

  if (isMongoConnected()) {
    const db = getMongoDb();
    const res = await db.collection(COLLECTIONS.INVITE_CAMPAIGN).findOneAndUpdate(
      { campaignId: String(campaignId) },
      { $set: cleanUpdates },
      { returnDocument: 'after' }
    );
    return res?.value !== undefined ? res.value : res;
  }

  const existing = memCampaigns.get(String(campaignId));
  if (!existing) return null;
  const updated = { ...existing, ...cleanUpdates };
  if (NON_ENDED_STATUSES.includes(updated.status)) {
    for (const other of memCampaigns.values()) {
      if (
        other.campaignId !== updated.campaignId &&
        other.guildId === updated.guildId &&
        NON_ENDED_STATUSES.includes(other.status)
      ) {
        throw createDuplicateKeyError(
          `E11000 duplicate key error: guild ${updated.guildId} already has a non-ended campaign.`
        );
      }
    }
  }
  memCampaigns.set(String(campaignId), updated);
  return { ...updated };
}

// ============================================================================
// 2. CampaignInvite Operations
// ============================================================================

export async function getCampaignInviteByUser(campaignId, inviterId) {
  if (!campaignId || !inviterId) return null;
  if (isMongoConnected()) {
    const db = getMongoDb();
    return db.collection(COLLECTIONS.CAMPAIGN_INVITE).findOne({
      campaignId: String(campaignId),
      inviterId: String(inviterId),
    });
  }
  const doc = memInvites.get(`${campaignId}:${inviterId}`);
  return doc ? { ...doc } : null;
}

export async function getCampaignInviteByCode(inviteCode) {
  if (!inviteCode) return null;
  if (isMongoConnected()) {
    const db = getMongoDb();
    return db.collection(COLLECTIONS.CAMPAIGN_INVITE).findOne({
      inviteCode: String(inviteCode),
    });
  }
  for (const doc of memInvites.values()) {
    if (doc.inviteCode === String(inviteCode)) return { ...doc };
  }
  return null;
}

export async function getCampaignInvitesForCampaign(campaignId) {
  if (!campaignId) return [];
  if (isMongoConnected()) {
    const db = getMongoDb();
    return db
      .collection(COLLECTIONS.CAMPAIGN_INVITE)
      .find({ campaignId: String(campaignId) })
      .toArray();
  }
  return [...memInvites.values()]
    .filter((i) => i.campaignId === String(campaignId))
    .map((i) => ({ ...i }));
}

export async function createCampaignInvite(data) {
  const doc = {
    campaignId: String(data.campaignId),
    guildId: String(data.guildId),
    inviterId: String(data.inviterId),
    inviteCode: String(data.inviteCode),
    inviteUrl: String(data.inviteUrl || `https://discord.gg/${data.inviteCode}`),
    lastKnownUses: Number(data.lastKnownUses || 0),
    createdAt: data.createdAt ? new Date(data.createdAt) : new Date(),
  };

  if (isMongoConnected()) {
    const db = getMongoDb();
    await db.collection(COLLECTIONS.CAMPAIGN_INVITE).insertOne({ ...doc });
    return doc;
  }

  const key = `${doc.campaignId}:${doc.inviterId}`;
  if (memInvites.has(key)) {
    throw createDuplicateKeyError(`E11000 duplicate key on CampaignInvite (${key})`);
  }
  for (const existing of memInvites.values()) {
    if (existing.inviteCode === doc.inviteCode) {
      throw createDuplicateKeyError(`E11000 duplicate key on inviteCode (${doc.inviteCode})`);
    }
  }
  memInvites.set(key, { ...doc });
  return { ...doc };
}

export async function updateCampaignInviteUses(inviteCode, lastKnownUses) {
  if (!inviteCode) return null;
  if (isMongoConnected()) {
    const db = getMongoDb();
    const res = await db.collection(COLLECTIONS.CAMPAIGN_INVITE).findOneAndUpdate(
      { inviteCode: String(inviteCode) },
      { $set: { lastKnownUses: Number(lastKnownUses) } },
      { returnDocument: 'after' }
    );
    return res?.value !== undefined ? res.value : res;
  }
  for (const [key, doc] of memInvites.entries()) {
    if (doc.inviteCode === String(inviteCode)) {
      doc.lastKnownUses = Number(lastKnownUses);
      memInvites.set(key, doc);
      return { ...doc };
    }
  }
  return null;
}

// ============================================================================
// 3. CampaignReferral Operations
// ============================================================================

export async function getCampaignReferral(campaignId, guildId, invitedUserId) {
  if (!campaignId || !guildId || !invitedUserId) return null;
  if (isMongoConnected()) {
    const db = getMongoDb();
    return db.collection(COLLECTIONS.CAMPAIGN_REFERRAL).findOne({
      campaignId: String(campaignId),
      guildId: String(guildId),
      invitedUserId: String(invitedUserId),
    });
  }
  const key = `${campaignId}:${guildId}:${invitedUserId}`;
  const doc = memReferrals.get(key);
  return doc ? { ...doc } : null;
}

export async function getReferralsByInviter(campaignId, guildId, inviterId) {
  if (!campaignId || !inviterId) return [];
  if (isMongoConnected()) {
    const db = getMongoDb();
    return db
      .collection(COLLECTIONS.CAMPAIGN_REFERRAL)
      .find({
        campaignId: String(campaignId),
        ...(guildId ? { guildId: String(guildId) } : {}),
        inviterId: String(inviterId),
      })
      .toArray();
  }
  return [...memReferrals.values()]
    .filter(
      (r) =>
        r.campaignId === String(campaignId) &&
        (!guildId || r.guildId === String(guildId)) &&
        r.inviterId === String(inviterId)
    )
    .map((r) => ({ ...r }));
}

export async function getReferralsForCampaign(campaignId) {
  if (!campaignId) return [];
  if (isMongoConnected()) {
    const db = getMongoDb();
    return db
      .collection(COLLECTIONS.CAMPAIGN_REFERRAL)
      .find({ campaignId: String(campaignId) })
      .toArray();
  }
  return [...memReferrals.values()]
    .filter((r) => r.campaignId === String(campaignId))
    .map((r) => ({ ...r }));
}

export async function getPendingReferralsForCampaign(campaignId) {
  if (!campaignId) return [];
  if (isMongoConnected()) {
    const db = getMongoDb();
    return db
      .collection(COLLECTIONS.CAMPAIGN_REFERRAL)
      .find({
        campaignId: String(campaignId),
        isActive: true,
        counted: false,
        disqualified: { $ne: true },
        dueAt: { $ne: null },
      })
      .toArray();
  }
  return [...memReferrals.values()]
    .filter(
      (r) =>
        r.campaignId === String(campaignId) &&
        r.isActive === true &&
        r.counted === false &&
        !r.disqualified &&
        r.dueAt != null
    )
    .map((r) => ({ ...r }));
}

export async function createCampaignReferral(data) {
  const doc = {
    campaignId: String(data.campaignId),
    guildId: String(data.guildId),
    invitedUserId: String(data.invitedUserId),
    inviterId: String(data.inviterId),
    inviteCode: String(data.inviteCode),
    joinedAt: data.joinedAt ? new Date(data.joinedAt) : new Date(),
    leftAt: data.leftAt ? new Date(data.leftAt) : null,
    isActive: data.isActive !== undefined ? Boolean(data.isActive) : true,
    counted: Boolean(data.counted),
    countedAt: data.countedAt ? new Date(data.countedAt) : null,
    disqualified: Boolean(data.disqualified),
    disqualifyReason: data.disqualifyReason ? String(data.disqualifyReason) : null,
    dueAt: data.dueAt ? new Date(data.dueAt) : null,
  };

  if (isMongoConnected()) {
    const db = getMongoDb();
    await db.collection(COLLECTIONS.CAMPAIGN_REFERRAL).insertOne({ ...doc });
    return doc;
  }

  const key = `${doc.campaignId}:${doc.guildId}:${doc.invitedUserId}`;
  if (memReferrals.has(key)) {
    throw createDuplicateKeyError(`E11000 duplicate key on CampaignReferral (${key})`);
  }
  memReferrals.set(key, { ...doc });
  return { ...doc };
}

export async function updateCampaignReferral(campaignId, guildId, invitedUserId, updates) {
  const cleanUpdates = { ...updates };
  delete cleanUpdates._id;

  if (isMongoConnected()) {
    const db = getMongoDb();
    const res = await db.collection(COLLECTIONS.CAMPAIGN_REFERRAL).findOneAndUpdate(
      {
        campaignId: String(campaignId),
        guildId: String(guildId),
        invitedUserId: String(invitedUserId),
      },
      { $set: cleanUpdates },
      { returnDocument: 'after' }
    );
    return res?.value !== undefined ? res.value : res;
  }

  const key = `${campaignId}:${guildId}:${invitedUserId}`;
  const existing = memReferrals.get(key);
  if (!existing) return null;
  const updated = { ...existing, ...cleanUpdates };
  memReferrals.set(key, updated);
  return { ...updated };
}

// ============================================================================
// 4. CampaignParticipant Operations
// ============================================================================

export async function getCampaignParticipant(campaignId, userId) {
  if (!campaignId || !userId) return null;
  if (isMongoConnected()) {
    const db = getMongoDb();
    return db.collection(COLLECTIONS.CAMPAIGN_PARTICIPANT).findOne({
      campaignId: String(campaignId),
      userId: String(userId),
    });
  }
  const key = `${campaignId}:${userId}`;
  const doc = memParticipants.get(key);
  return doc ? { ...doc } : null;
}

export async function upsertCampaignParticipant(campaignId, guildId, userId, updates) {
  const cleanUpdates = { ...updates };
  delete cleanUpdates._id;
  delete cleanUpdates.campaignId;
  delete cleanUpdates.guildId;
  delete cleanUpdates.userId;

  const defaults = {
    successfulInvites: 0,
    pendingInvites: 0,
    isEligible: false,
    eligibleAt: null,
    notified: false,
    disqualified: false,
    disqualifyReason: null,
    inviterLeftServer: false,
  };

  if (isMongoConnected()) {
    const db = getMongoDb();
    const setOnInsert = {
      campaignId: String(campaignId),
      guildId: String(guildId),
      userId: String(userId),
    };
    for (const [k, v] of Object.entries(defaults)) {
      if (!(k in cleanUpdates)) {
        setOnInsert[k] = v;
      }
    }
    const res = await db.collection(COLLECTIONS.CAMPAIGN_PARTICIPANT).findOneAndUpdate(
      { campaignId: String(campaignId), userId: String(userId) },
      {
        $set: cleanUpdates,
        $setOnInsert: setOnInsert,
      },
      { upsert: true, returnDocument: 'after' }
    );
    return res?.value !== undefined ? res.value : res;
  }

  const key = `${campaignId}:${userId}`;
  const existing = memParticipants.get(key) || {
    campaignId: String(campaignId),
    guildId: String(guildId),
    userId: String(userId),
    ...defaults,
  };
  const updated = { ...existing, ...cleanUpdates };
  memParticipants.set(key, updated);
  return { ...updated };
}

export async function getParticipantsForCampaign(campaignId) {
  if (!campaignId) return [];
  if (isMongoConnected()) {
    const db = getMongoDb();
    return db
      .collection(COLLECTIONS.CAMPAIGN_PARTICIPANT)
      .find({ campaignId: String(campaignId) })
      .sort({ successfulInvites: -1, eligibleAt: 1, userId: 1 })
      .toArray();
  }
  return [...memParticipants.values()]
    .filter((p) => p.campaignId === String(campaignId))
    .sort((a, b) => {
      if (b.successfulInvites !== a.successfulInvites) {
        return b.successfulInvites - a.successfulInvites;
      }
      const aTime = a.eligibleAt ? new Date(a.eligibleAt).getTime() : Number.MAX_SAFE_INTEGER;
      const bTime = b.eligibleAt ? new Date(b.eligibleAt).getTime() : Number.MAX_SAFE_INTEGER;
      if (aTime !== bTime) return aTime - bTime;
      return String(a.userId).localeCompare(String(b.userId));
    })
    .map((p) => ({ ...p }));
}

export async function getEligibleParticipantsForCampaign(campaignId) {
  if (!campaignId) return [];
  const all = await getParticipantsForCampaign(campaignId);
  return all
    .filter((p) => p.isEligible === true && !p.disqualified && !p.inviterLeftServer)
    .sort((a, b) => {
      const aTime = a.eligibleAt ? new Date(a.eligibleAt).getTime() : 0;
      const bTime = b.eligibleAt ? new Date(b.eligibleAt).getTime() : 0;
      if (aTime !== bTime) return aTime - bTime;
      return b.successfulInvites - a.successfulInvites;
    });
}

// ============================================================================
// 5. UnattributedJoin Operations
// ============================================================================

export async function createUnattributedJoin(data) {
  const doc = {
    campaignId: String(data.campaignId),
    guildId: String(data.guildId),
    userId: String(data.userId),
    joinedAt: data.joinedAt ? new Date(data.joinedAt) : new Date(),
    reason: String(data.reason || 'Ambiguous or unknown invite attribution'),
    reviewed: Boolean(data.reviewed),
  };

  if (isMongoConnected()) {
    const db = getMongoDb();
    await db.collection(COLLECTIONS.UNATTRIBUTED_JOIN).insertOne({ ...doc });
    return doc;
  }

  memUnattributedJoins.push({ ...doc });
  return { ...doc };
}

export async function getUnattributedJoinsForCampaign(campaignId, onlyUnreviewed = false) {
  if (!campaignId) return [];
  if (isMongoConnected()) {
    const db = getMongoDb();
    const query = { campaignId: String(campaignId) };
    if (onlyUnreviewed) query.reviewed = false;
    return db
      .collection(COLLECTIONS.UNATTRIBUTED_JOIN)
      .find(query)
      .sort({ joinedAt: -1 })
      .toArray();
  }
  return memUnattributedJoins
    .filter((u) => u.campaignId === String(campaignId) && (!onlyUnreviewed || !u.reviewed))
    .sort((a, b) => new Date(b.joinedAt).getTime() - new Date(a.joinedAt).getTime())
    .map((u) => ({ ...u }));
}

export async function markUnattributedJoinReviewed(campaignId, userId = null) {
  if (!campaignId) return 0;
  if (isMongoConnected()) {
    const db = getMongoDb();
    const filter = { campaignId: String(campaignId) };
    if (userId) filter.userId = String(userId);
    const res = await db
      .collection(COLLECTIONS.UNATTRIBUTED_JOIN)
      .updateMany(filter, { $set: { reviewed: true } });
    return res.modifiedCount || 0;
  }
  let count = 0;
  for (const item of memUnattributedJoins) {
    if (item.campaignId === String(campaignId) && (!userId || item.userId === String(userId))) {
      if (!item.reviewed) {
        item.reviewed = true;
        count++;
      }
    }
  }
  return count;
}
