import crypto from 'node:crypto';
import { getMongoDb, isMongoConnected } from '../../../../../mongoService.js';

export const ARENA_COLLECTIONS = {
  PLAYERS: 'arena_players',
  CHALLENGES: 'arena_challenges',
  MATCHES: 'arena_matches',
  VOLUNTEERS: 'arena_volunteers',
  DISPUTES: 'arena_disputes',
  LOGS: 'arena_logs',
  CONFIG: 'arena_config',
};

export const ARENA_STATUS = {
  OPEN: 'OPEN',
  WAITING_FOR_VOLUNTEER: 'WAITING_FOR_VOLUNTEER',
  VOLUNTEER_ASSIGNED: 'VOLUNTEER_ASSIGNED',
  ROOM_READY: 'ROOM_READY',
  LIVE: 'LIVE',
  RESULT_PENDING: 'RESULT_PENDING',
  UNDER_REVIEW: 'UNDER_REVIEW',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
};

export const ARENA_FINAL_STATUSES = [
  ARENA_STATUS.COMPLETED,
  ARENA_STATUS.CANCELLED,
  ARENA_STATUS.EXPIRED,
];

export const ALLOWED_TRANSITIONS = {
  [ARENA_STATUS.OPEN]: [
    ARENA_STATUS.WAITING_FOR_VOLUNTEER,
    ARENA_STATUS.CANCELLED,
    ARENA_STATUS.EXPIRED,
  ],
  [ARENA_STATUS.WAITING_FOR_VOLUNTEER]: [
    ARENA_STATUS.VOLUNTEER_ASSIGNED,
    ARENA_STATUS.CANCELLED,
    ARENA_STATUS.EXPIRED,
  ],
  [ARENA_STATUS.VOLUNTEER_ASSIGNED]: [
    ARENA_STATUS.ROOM_READY,
    ARENA_STATUS.WAITING_FOR_VOLUNTEER,
    ARENA_STATUS.CANCELLED,
  ],
  [ARENA_STATUS.ROOM_READY]: [
    ARENA_STATUS.LIVE,
    ARENA_STATUS.CANCELLED,
  ],
  [ARENA_STATUS.LIVE]: [
    ARENA_STATUS.RESULT_PENDING,
    ARENA_STATUS.UNDER_REVIEW,
    ARENA_STATUS.CANCELLED,
  ],
  [ARENA_STATUS.RESULT_PENDING]: [
    ARENA_STATUS.COMPLETED,
    ARENA_STATUS.UNDER_REVIEW,
  ],
  [ARENA_STATUS.UNDER_REVIEW]: [
    ARENA_STATUS.COMPLETED,
    ARENA_STATUS.CANCELLED,
  ],
};

export const ARENA_CONSTANTS = {
  CHALLENGE_EXPIRY_MS: 30 * 60 * 1000,         // 30 minutes
  CHALLENGE_COOLDOWN_MS: 30 * 1000,             // 30 seconds
  VOLUNTEER_WARNING_MS: 15 * 60 * 1000,         // 15 minutes
  VOLUNTEER_TIMEOUT_MS: 45 * 60 * 1000,         // 45 minutes
  RESULT_CONFIRM_TIMEOUT_MS: 15 * 60 * 1000,    // 15 minutes
  CHANNEL_CLEANUP_MS: 60 * 60 * 1000,           // 60 minutes
  SCREENSHOT_TIMEOUT_MS: 5 * 60 * 1000,         // 5 minutes
  ORANGE_COLOR: 0xF97316,
};

// In-memory fallback storage for tests without live MongoDB
const memPlayers = new Map();       // discordId -> doc
const memChallenges = new Map();    // challengeId -> doc
const memMatches = new Map();       // matchId -> doc
const memVolunteers = new Map();    // discordId -> doc
const memDisputes = new Map();      // disputeId -> doc
const memLogs = [];                 // array of log docs
const memConfig = new Map();        // guildId -> doc
let memCounter = 10000;

export function clearInMemoryArenaData() {
  memPlayers.clear();
  memChallenges.clear();
  memMatches.clear();
  memVolunteers.clear();
  memDisputes.clear();
  memLogs.length = 0;
  memConfig.clear();
  memCounter = 10000;
}

export async function ensureArenaIndexes(dbInstance = null) {
  const db = dbInstance || (isMongoConnected() ? getMongoDb() : null);
  if (!db) return;

  try {
    const players = db.collection(ARENA_COLLECTIONS.PLAYERS);
    await players.createIndex({ discordId: 1 }, { unique: true });
    await players.createIndex(
      { bgmiUid: 1 },
      { unique: true, partialFilterExpression: { bgmiUid: { $exists: true, $type: 'string' } } }
    );
    await players.createIndex({ activeMatchId: 1 });

    const challenges = db.collection(ARENA_COLLECTIONS.CHALLENGES);
    await challenges.createIndex({ challengeId: 1 }, { unique: true });
    await challenges.createIndex({ creatorId: 1, status: 1 });
    await challenges.createIndex({ status: 1, expiresAt: 1 });

    const matches = db.collection(ARENA_COLLECTIONS.MATCHES);
    await matches.createIndex({ matchId: 1 }, { unique: true });
    await matches.createIndex({ challengeId: 1 }, { unique: true });
    await matches.createIndex({ status: 1 });
    await matches.createIndex({ volunteerId: 1, status: 1 });
    await matches.createIndex({ deleteChannelAt: 1 });
    await matches.createIndex({ volunteerTimeoutDueAt: 1 });
    await matches.createIndex({ resultTimeoutDueAt: 1 });

    const volunteers = db.collection(ARENA_COLLECTIONS.VOLUNTEERS);
    await volunteers.createIndex({ discordId: 1 }, { unique: true });
    await volunteers.createIndex({ status: 1 });

    const disputes = db.collection(ARENA_COLLECTIONS.DISPUTES);
    await disputes.createIndex({ disputeId: 1 }, { unique: true });
    await disputes.createIndex({ matchId: 1 });
    await disputes.createIndex({ status: 1 });

    const logs = db.collection(ARENA_COLLECTIONS.LOGS);
    await logs.createIndex({ timestamp: -1 });
    await logs.createIndex({ matchId: 1 });
    await logs.createIndex({ challengeId: 1 });

    const config = db.collection(ARENA_COLLECTIONS.CONFIG);
    await config.createIndex({ guildId: 1 }, { unique: true });
  } catch (err) {
    console.warn('[Arena] ⚠️ Error creating MongoDB indexes:', err.message);
  }
}

// ============================================================================
// Sequence / ID Generator
// ============================================================================

export async function getNextArenaSequence(guildId = null) {
  if (isMongoConnected()) {
    const db = getMongoDb();
    const configCol = db.collection(ARENA_COLLECTIONS.CONFIG);
    const filter = guildId ? { guildId: String(guildId) } : { key: 'global_arena_counter' };
    const res = await configCol.findOneAndUpdate(
      filter,
      { $inc: { counter: 1 }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true, returnDocument: 'after' }
    );
    const doc = res?.value !== undefined ? res.value : res;
    const count = doc?.counter || 10001;
    return `MD-${count}`;
  }

  memCounter += 1;
  return `MD-${memCounter}`;
}

// ============================================================================
// Config Operations
// ============================================================================

export async function getArenaConfig(guildId) {
  if (!guildId) return null;
  if (isMongoConnected()) {
    const db = getMongoDb();
    return db.collection(ARENA_COLLECTIONS.CONFIG).findOne({ guildId: String(guildId) });
  }
  const doc = memConfig.get(String(guildId));
  return doc ? { ...doc } : null;
}

export async function saveArenaConfig(guildId, updates) {
  if (!guildId) return null;
  const now = new Date();
  const cleanUpdates = { ...updates, updatedAt: now };
  delete cleanUpdates._id;

  if (isMongoConnected()) {
    const db = getMongoDb();
    const res = await db.collection(ARENA_COLLECTIONS.CONFIG).findOneAndUpdate(
      { guildId: String(guildId) },
      { $set: cleanUpdates, $setOnInsert: { guildId: String(guildId), createdAt: now } },
      { upsert: true, returnDocument: 'after' }
    );
    return res?.value !== undefined ? res.value : res;
  }

  const existing = memConfig.get(String(guildId)) || { guildId: String(guildId), createdAt: now };
  const merged = { ...existing, ...cleanUpdates };
  memConfig.set(String(guildId), merged);
  return { ...merged };
}

// ============================================================================
// Player Operations
// ============================================================================

export async function getArenaPlayer(discordId) {
  if (!discordId) return null;
  if (isMongoConnected()) {
    const db = getMongoDb();
    return db.collection(ARENA_COLLECTIONS.PLAYERS).findOne({ discordId: String(discordId) });
  }
  const doc = memPlayers.get(String(discordId));
  return doc ? { ...doc } : null;
}

export async function getArenaPlayerByUid(bgmiUid) {
  if (!bgmiUid) return null;
  const cleanUid = String(bgmiUid).trim();
  if (isMongoConnected()) {
    const db = getMongoDb();
    return db.collection(ARENA_COLLECTIONS.PLAYERS).findOne({ bgmiUid: cleanUid });
  }
  for (const p of memPlayers.values()) {
    if (p.bgmiUid === cleanUid) return { ...p };
  }
  return null;
}

export async function upsertArenaPlayer(discordId, data) {
  if (!discordId) return null;
  const now = new Date();
  const updates = { ...data, updatedAt: now };
  delete updates._id;
  delete updates.discordId;

  if (isMongoConnected()) {
    const db = getMongoDb();
    const res = await db.collection(ARENA_COLLECTIONS.PLAYERS).findOneAndUpdate(
      { discordId: String(discordId) },
      {
        $set: updates,
        $setOnInsert: {
          discordId: String(discordId),
          suspended: false,
          activeMatchId: null,
          stats: { played: 0, won: 0, lost: 0 },
          createdAt: now,
        },
      },
      { upsert: true, returnDocument: 'after' }
    );
    return res?.value !== undefined ? res.value : res;
  }

  const existing = memPlayers.get(String(discordId)) || {
    discordId: String(discordId),
    suspended: false,
    activeMatchId: null,
    stats: { played: 0, won: 0, lost: 0 },
    createdAt: now,
  };
  const merged = { ...existing, ...updates };
  memPlayers.set(String(discordId), merged);
  return { ...merged };
}

export async function updateArenaPlayer(discordId, updates) {
  if (!discordId) return null;
  const now = new Date();
  const cleanUpdates = { ...updates, updatedAt: now };
  delete cleanUpdates._id;
  delete cleanUpdates.discordId;

  if (isMongoConnected()) {
    const db = getMongoDb();
    const res = await db.collection(ARENA_COLLECTIONS.PLAYERS).findOneAndUpdate(
      { discordId: String(discordId) },
      { $set: cleanUpdates },
      { returnDocument: 'after' }
    );
    return res?.value !== undefined ? res.value : res;
  }

  const existing = memPlayers.get(String(discordId));
  if (!existing) return null;
  const merged = { ...existing, ...cleanUpdates };
  memPlayers.set(String(discordId), merged);
  return { ...merged };
}

export async function atomicReservePlayerMatch(discordId, matchId) {
  if (!discordId || !matchId) return false;
  if (isMongoConnected()) {
    const db = getMongoDb();
    const res = await db.collection(ARENA_COLLECTIONS.PLAYERS).updateOne(
      { discordId: String(discordId), activeMatchId: null, suspended: false },
      { $set: { activeMatchId: String(matchId), updatedAt: new Date() } }
    );
    return res.modifiedCount > 0;
  }

  const p = memPlayers.get(String(discordId));
  if (p && !p.activeMatchId && !p.suspended) {
    p.activeMatchId = String(matchId);
    p.updatedAt = new Date();
    return true;
  }
  return false;
}

export async function atomicReleasePlayerMatch(discordId, matchId = null) {
  if (!discordId) return false;
  const filter = { discordId: String(discordId) };
  if (matchId) filter.activeMatchId = String(matchId);

  if (isMongoConnected()) {
    const db = getMongoDb();
    const res = await db.collection(ARENA_COLLECTIONS.PLAYERS).updateOne(
      filter,
      { $set: { activeMatchId: null, updatedAt: new Date() } }
    );
    return res.modifiedCount > 0;
  }

  const p = memPlayers.get(String(discordId));
  if (p && (!matchId || p.activeMatchId === String(matchId))) {
    p.activeMatchId = null;
    p.updatedAt = new Date();
    return true;
  }
  return false;
}

// ============================================================================
// Challenge Operations
// ============================================================================

export async function createArenaChallenge(data) {
  const now = new Date();
  const doc = {
    challengeId: String(data.challengeId),
    guildId: String(data.guildId),
    creatorId: String(data.creatorId),
    opponentId: data.opponentId ? String(data.opponentId) : null,
    game: 'BGMI',
    matchType: 'TDM 1v1',
    status: data.status || ARENA_STATUS.OPEN,
    discordMessageId: data.discordMessageId ? String(data.discordMessageId) : null,
    discordChannelId: data.discordChannelId ? String(data.discordChannelId) : null,
    createdAt: data.createdAt ? new Date(data.createdAt) : now,
    acceptedAt: data.acceptedAt ? new Date(data.acceptedAt) : null,
    expiresAt: data.expiresAt ? new Date(data.expiresAt) : new Date(now.getTime() + ARENA_CONSTANTS.CHALLENGE_EXPIRY_MS),
  };

  if (isMongoConnected()) {
    const db = getMongoDb();
    await db.collection(ARENA_COLLECTIONS.CHALLENGES).insertOne({ ...doc });
    return doc;
  }

  memChallenges.set(doc.challengeId, { ...doc });
  return { ...doc };
}

export async function getArenaChallenge(challengeId) {
  if (!challengeId) return null;
  if (isMongoConnected()) {
    const db = getMongoDb();
    return db.collection(ARENA_COLLECTIONS.CHALLENGES).findOne({ challengeId: String(challengeId) });
  }
  const doc = memChallenges.get(String(challengeId));
  return doc ? { ...doc } : null;
}

export async function getOpenChallengeByCreator(creatorId) {
  if (!creatorId) return null;
  if (isMongoConnected()) {
    const db = getMongoDb();
    return db.collection(ARENA_COLLECTIONS.CHALLENGES).findOne({
      creatorId: String(creatorId),
      status: ARENA_STATUS.OPEN,
    });
  }
  for (const c of memChallenges.values()) {
    if (c.creatorId === String(creatorId) && c.status === ARENA_STATUS.OPEN) {
      return { ...c };
    }
  }
  return null;
}

export async function getActiveChallenges(guildId = null) {
  if (isMongoConnected()) {
    const db = getMongoDb();
    const filter = { status: ARENA_STATUS.OPEN };
    if (guildId) filter.guildId = String(guildId);
    return db.collection(ARENA_COLLECTIONS.CHALLENGES).find(filter).toArray();
  }
  return [...memChallenges.values()]
    .filter((c) => c.status === ARENA_STATUS.OPEN && (!guildId || c.guildId === String(guildId)))
    .map((c) => ({ ...c }));
}

export async function updateArenaChallenge(challengeId, updates) {
  if (!challengeId) return null;
  const cleanUpdates = { ...updates };
  delete cleanUpdates._id;
  delete cleanUpdates.challengeId;

  if (isMongoConnected()) {
    const db = getMongoDb();
    const res = await db.collection(ARENA_COLLECTIONS.CHALLENGES).findOneAndUpdate(
      { challengeId: String(challengeId) },
      { $set: cleanUpdates },
      { returnDocument: 'after' }
    );
    return res?.value !== undefined ? res.value : res;
  }

  const existing = memChallenges.get(String(challengeId));
  if (!existing) return null;
  const merged = { ...existing, ...cleanUpdates };
  memChallenges.set(String(challengeId), merged);
  return { ...merged };
}

// ============================================================================
// Match Operations
// ============================================================================

export async function createArenaMatch(data) {
  const now = new Date();
  const doc = {
    matchId: String(data.matchId),
    challengeId: String(data.challengeId || data.matchId),
    guildId: String(data.guildId),
    playerA: {
      discordId: String(data.playerA.discordId),
      displayName: String(data.playerA.displayName),
      bgmiIgn: String(data.playerA.bgmiIgn),
      bgmiUid: String(data.playerA.bgmiUid),
    },
    playerB: {
      discordId: String(data.playerB.discordId),
      displayName: String(data.playerB.displayName),
      bgmiIgn: String(data.playerB.bgmiIgn),
      bgmiUid: String(data.playerB.bgmiUid),
    },
    volunteerId: data.volunteerId ? String(data.volunteerId) : null,
    matchChannelId: data.matchChannelId ? String(data.matchChannelId) : null,
    panelMessageId: data.panelMessageId ? String(data.panelMessageId) : null,
    matchEmbedMessageId: data.matchEmbedMessageId ? String(data.matchEmbedMessageId) : null,
    roomId: data.roomId ? String(data.roomId) : null,
    roomPassword: data.roomPassword ? String(data.roomPassword) : null,
    status: data.status || ARENA_STATUS.WAITING_FOR_VOLUNTEER,
    winnerId: null,
    loserId: null,
    pendingWinnerId: null,
    resultEvidence: null,
    playerAConfirmation: null,
    playerBConfirmation: null,
    assignedAt: null,
    startedAt: null,
    completedAt: null,
    volunteerWarningSent: false,
    volunteerWarningDueAt: new Date(now.getTime() + ARENA_CONSTANTS.VOLUNTEER_WARNING_MS),
    volunteerTimeoutDueAt: new Date(now.getTime() + ARENA_CONSTANTS.VOLUNTEER_TIMEOUT_MS),
    resultTimeoutDueAt: null,
    deleteChannelAt: null,
    createdAt: now,
    updatedAt: now,
  };

  if (isMongoConnected()) {
    const db = getMongoDb();
    await db.collection(ARENA_COLLECTIONS.MATCHES).insertOne({ ...doc });
    return doc;
  }

  memMatches.set(doc.matchId, { ...doc });
  return { ...doc };
}

export async function getArenaMatch(matchId) {
  if (!matchId) return null;
  if (isMongoConnected()) {
    const db = getMongoDb();
    return db.collection(ARENA_COLLECTIONS.MATCHES).findOne({ matchId: String(matchId) });
  }
  const doc = memMatches.get(String(matchId));
  return doc ? { ...doc } : null;
}

export async function getArenaMatchesByStatus(status, guildId = null) {
  if (isMongoConnected()) {
    const db = getMongoDb();
    const filter = {};
    if (status) filter.status = status;
    if (guildId) filter.guildId = String(guildId);
    return db.collection(ARENA_COLLECTIONS.MATCHES).find(filter).toArray();
  }
  return [...memMatches.values()]
    .filter((m) => (!status || m.status === status) && (!guildId || m.guildId === String(guildId)))
    .map((m) => ({ ...m }));
}

export async function updateArenaMatch(matchId, updates) {
  if (!matchId) return null;
  const now = new Date();
  const cleanUpdates = { ...updates, updatedAt: now };
  delete cleanUpdates._id;
  delete cleanUpdates.matchId;

  if (isMongoConnected()) {
    const db = getMongoDb();
    const res = await db.collection(ARENA_COLLECTIONS.MATCHES).findOneAndUpdate(
      { matchId: String(matchId) },
      { $set: cleanUpdates },
      { returnDocument: 'after' }
    );
    return res?.value !== undefined ? res.value : res;
  }

  const existing = memMatches.get(String(matchId));
  if (!existing) return null;
  const merged = { ...existing, ...cleanUpdates };
  memMatches.set(String(matchId), merged);
  return { ...merged };
}

// ============================================================================
// Volunteer Operations
// ============================================================================

export async function getArenaVolunteer(discordId) {
  if (!discordId) return null;
  if (isMongoConnected()) {
    const db = getMongoDb();
    return db.collection(ARENA_COLLECTIONS.VOLUNTEERS).findOne({ discordId: String(discordId) });
  }
  const doc = memVolunteers.get(String(discordId));
  return doc ? { ...doc } : null;
}

export async function upsertArenaVolunteer(discordId, data = {}) {
  if (!discordId) return null;
  const now = new Date();
  const updates = { ...data, updatedAt: now };
  delete updates._id;
  delete updates.discordId;

  if (isMongoConnected()) {
    const db = getMongoDb();
    const res = await db.collection(ARENA_COLLECTIONS.VOLUNTEERS).findOneAndUpdate(
      { discordId: String(discordId) },
      {
        $set: updates,
        $setOnInsert: {
          discordId: String(discordId),
          status: 'AVAILABLE',
          activeMatches: 0,
          totalMatches: 0,
          completedMatches: 0,
          disputedMatches: 0,
          suspended: false,
          createdAt: now,
        },
      },
      { upsert: true, returnDocument: 'after' }
    );
    return res?.value !== undefined ? res.value : res;
  }

  const existing = memVolunteers.get(String(discordId)) || {
    discordId: String(discordId),
    status: 'AVAILABLE',
    activeMatches: 0,
    totalMatches: 0,
    completedMatches: 0,
    disputedMatches: 0,
    suspended: false,
    createdAt: now,
  };
  const merged = { ...existing, ...updates };
  memVolunteers.set(String(discordId), merged);
  return { ...merged };
}

export async function updateArenaVolunteer(discordId, updates) {
  if (!discordId) return null;
  const now = new Date();
  const cleanUpdates = { ...updates, updatedAt: now };
  delete cleanUpdates._id;
  delete cleanUpdates.discordId;

  if (isMongoConnected()) {
    const db = getMongoDb();
    const res = await db.collection(ARENA_COLLECTIONS.VOLUNTEERS).findOneAndUpdate(
      { discordId: String(discordId) },
      { $set: cleanUpdates },
      { returnDocument: 'after' }
    );
    return res?.value !== undefined ? res.value : res;
  }

  const existing = memVolunteers.get(String(discordId));
  if (!existing) return null;
  const merged = { ...existing, ...cleanUpdates };
  memVolunteers.set(String(discordId), merged);
  return { ...merged };
}

// ============================================================================
// Dispute Operations
// ============================================================================

export async function createArenaDispute(data) {
  const now = new Date();
  const doc = {
    disputeId: data.disputeId || `disp_${crypto.randomBytes(4).toString('hex')}`,
    matchId: String(data.matchId),
    reportedBy: String(data.reportedBy),
    reason: String(data.reason || '').trim(),
    evidence: data.evidence ? String(data.evidence) : null,
    status: 'OPEN',
    reviewedBy: null,
    resolution: null,
    resolvedAt: null,
    createdAt: now,
  };

  if (isMongoConnected()) {
    const db = getMongoDb();
    await db.collection(ARENA_COLLECTIONS.DISPUTES).insertOne({ ...doc });
    return doc;
  }

  memDisputes.set(doc.disputeId, { ...doc });
  return { ...doc };
}

export async function getOpenDisputes(matchId = null) {
  if (isMongoConnected()) {
    const db = getMongoDb();
    const filter = { status: 'OPEN' };
    if (matchId) filter.matchId = String(matchId);
    return db.collection(ARENA_COLLECTIONS.DISPUTES).find(filter).toArray();
  }
  return [...memDisputes.values()]
    .filter((d) => d.status === 'OPEN' && (!matchId || d.matchId === String(matchId)))
    .map((d) => ({ ...d }));
}

export async function resolveArenaDispute(disputeId, resolution, reviewedBy) {
  const now = new Date();
  const updates = {
    status: 'RESOLVED',
    resolution: String(resolution),
    reviewedBy: String(reviewedBy),
    resolvedAt: now,
  };

  if (isMongoConnected()) {
    const db = getMongoDb();
    const res = await db.collection(ARENA_COLLECTIONS.DISPUTES).findOneAndUpdate(
      { disputeId: String(disputeId) },
      { $set: updates },
      { returnDocument: 'after' }
    );
    return res?.value !== undefined ? res.value : res;
  }

  const existing = memDisputes.get(String(disputeId));
  if (!existing) return null;
  const merged = { ...existing, ...updates };
  memDisputes.set(String(disputeId), merged);
  return { ...merged };
}

// ============================================================================
// Logging Operations
// ============================================================================

export async function logArenaAction({ action, matchId = null, challengeId = null, performedBy, metadata = {} }) {
  const now = new Date();
  const doc = {
    logId: `log_${crypto.randomBytes(5).toString('hex')}`,
    action: String(action),
    matchId: matchId ? String(matchId) : null,
    challengeId: challengeId ? String(challengeId) : null,
    performedBy: String(performedBy || 'system'),
    metadata: { ...metadata },
    timestamp: now,
  };

  if (isMongoConnected()) {
    const db = getMongoDb();
    await db.collection(ARENA_COLLECTIONS.LOGS).insertOne({ ...doc });
    return doc;
  }

  memLogs.push({ ...doc });
  return { ...doc };
}

export async function getArenaLogs(matchIdOrChallengeId = null, limit = 20) {
  if (isMongoConnected()) {
    const db = getMongoDb();
    const filter = {};
    if (matchIdOrChallengeId) {
      filter.$or = [{ matchId: matchIdOrChallengeId }, { challengeId: matchIdOrChallengeId }];
    }
    return db
      .collection(ARENA_COLLECTIONS.LOGS)
      .find(filter)
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
  }

  return memLogs
    .filter((l) => !matchIdOrChallengeId || l.matchId === matchIdOrChallengeId || l.challengeId === matchIdOrChallengeId)
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    .slice(0, limit);
}
