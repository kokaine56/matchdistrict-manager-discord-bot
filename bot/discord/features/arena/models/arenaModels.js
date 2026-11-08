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
  ROOM_ISSUE: 'ROOM_ISSUE',
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
    ARENA_STATUS.ROOM_ISSUE,
    ARENA_STATUS.WAITING_FOR_VOLUNTEER,
    ARENA_STATUS.CANCELLED,
  ],
  // A player reported incorrect Room ID/Password: match cannot start until the Room Maker
  // submits corrected credentials (-> ROOM_READY) or leaves (-> WAITING_FOR_VOLUNTEER).
  [ARENA_STATUS.ROOM_ISSUE]: [
    ARENA_STATUS.ROOM_READY,
    ARENA_STATUS.WAITING_FOR_VOLUNTEER,
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

export function formatMatchId(rawId) {
  if (!rawId) return 'MD-0001';
  const str = String(rawId).trim();
  const digits = str.match(/\d+/)?.[0];
  if (!digits) return str.toUpperCase().startsWith('MD-') ? str.toUpperCase() : `MD-${str.toUpperCase()}`;
  if (digits.length <= 4) {
    return `MD-${digits.padStart(4, '0')}`;
  }
  const num = parseInt(digits, 10);
  if (num >= 10000 && num < 20000) {
    return `MD-${String(num - 10000).padStart(4, '0')}`;
  }
  return `MD-${digits.slice(-4).padStart(4, '0')}`;
}

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
    const count = doc?.counter || 1;
    return formatMatchId(count);
  }

  memCounter += 1;
  return formatMatchId(memCounter);
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
  const setFields = { ...updates, updatedAt: now };
  delete setFields._id;
  delete setFields.guildId;
  delete setFields.createdAt;

  const setOnInsertFields = {
    guildId: String(guildId),
    createdAt: now,
  };

  const setKeys = new Set(Object.keys(setFields));
  for (const insertKey of Object.keys(setOnInsertFields)) {
    if (setKeys.has(insertKey)) {
      throw new Error(`Updating the path '${insertKey}' would create a conflict at '${insertKey}'.`);
    }
  }

  if (isMongoConnected()) {
    const db = getMongoDb();
    const res = await db.collection(ARENA_COLLECTIONS.CONFIG).findOneAndUpdate(
      { guildId: String(guildId) },
      { $set: setFields, $setOnInsert: setOnInsertFields },
      { upsert: true, returnDocument: 'after' }
    );
    return res?.value !== undefined ? res.value : res;
  }

  const existing = memConfig.get(String(guildId));
  if (existing) {
    const merged = { ...existing, ...setFields };
    memConfig.set(String(guildId), merged);
    return { ...merged };
  }

  const newDoc = { ...setOnInsertFields, ...setFields };
  memConfig.set(String(guildId), newDoc);
  return { ...newDoc };
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

export async function upsertArenaPlayer(discordId, data = {}) {
  if (!discordId) return null;
  const now = new Date();
  const setFields = { ...data, updatedAt: now };
  delete setFields._id;
  delete setFields.discordId;
  delete setFields.createdAt;

  const setOnInsertFields = {
    discordId: String(discordId),
    createdAt: now,
  };

  if (!('suspended' in setFields)) {
    setOnInsertFields.suspended = false;
  }
  if (!('activeMatchId' in setFields)) {
    setOnInsertFields.activeMatchId = null;
  }
  if (!('stats' in setFields)) {
    setOnInsertFields.stats = { played: 0, won: 0, lost: 0 };
  }

  // Validate MongoDB operator path conflicts to prevent regressions
  const setKeys = new Set(Object.keys(setFields));
  for (const insertKey of Object.keys(setOnInsertFields)) {
    if (setKeys.has(insertKey)) {
      throw new Error(`Updating the path '${insertKey}' would create a conflict at '${insertKey}'.`);
    }
  }

  if (isMongoConnected()) {
    const db = getMongoDb();
    const res = await db.collection(ARENA_COLLECTIONS.PLAYERS).findOneAndUpdate(
      { discordId: String(discordId) },
      {
        $set: setFields,
        $setOnInsert: setOnInsertFields,
      },
      { upsert: true, returnDocument: 'after' }
    );
    return res?.value !== undefined ? res.value : res;
  }

  const existing = memPlayers.get(String(discordId));
  if (existing) {
    const merged = { ...existing, ...setFields };
    memPlayers.set(String(discordId), merged);
    return { ...merged };
  }

  const newDoc = { ...setOnInsertFields, ...setFields };
  memPlayers.set(String(discordId), newDoc);
  return { ...newDoc };
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
    roomMakerChannelId: data.roomMakerChannelId ? String(data.roomMakerChannelId) : (data.roomChannelId ? String(data.roomChannelId) : null),
    roomMakerMessageId: data.roomMakerMessageId ? String(data.roomMakerMessageId) : null,
    panelMessageId: data.panelMessageId ? String(data.panelMessageId) : null,
    matchEmbedMessageId: data.matchEmbedMessageId ? String(data.matchEmbedMessageId) : null,
    roomId: data.roomId ? String(data.roomId) : null,
    roomPassword: data.roomPassword ? String(data.roomPassword) : null,
    roomChannelId: data.roomMakerChannelId ? String(data.roomMakerChannelId) : (data.roomChannelId ? String(data.roomChannelId) : null),
    roomMessageId: data.roomMessageId ? String(data.roomMessageId) : null,
    roomReports: Array.isArray(data.roomReports) ? data.roomReports : [],
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

export async function getArenaMatchByChannelId(channelId) {
  if (!channelId) return null;
  const cId = String(channelId);
  if (isMongoConnected()) {
    const db = getMongoDb();
    return db.collection(ARENA_COLLECTIONS.MATCHES).findOne({
      $or: [
        { roomMakerChannelId: cId },
        { matchChannelId: cId },
        { roomChannelId: cId },
      ],
    });
  }
  return (
    [...memMatches.values()].find(
      (m) =>
        m.roomMakerChannelId === cId ||
        m.matchChannelId === cId ||
        m.roomChannelId === cId
    ) || null
  );
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
  const setFields = { ...data, updatedAt: now };
  delete setFields._id;
  delete setFields.discordId;
  delete setFields.createdAt;

  // Defaults strictly for $setOnInsert (only if NOT in setFields!)
  const setOnInsertFields = {
    discordId: String(discordId),
    createdAt: now,
  };

  // Ensure displayName is assigned in exactly one update operator
  if (!('displayName' in setFields) || setFields.displayName === undefined || setFields.displayName === null) {
    delete setFields.displayName;
    setOnInsertFields.displayName = 'Volunteer';
  } else {
    setFields.displayName = String(setFields.displayName);
  }

  if (!('status' in setFields)) {
    setOnInsertFields.status = 'AVAILABLE';
  }
  if (!('activeMatches' in setFields)) {
    setOnInsertFields.activeMatches = 0;
  }
  if (!('totalMatches' in setFields)) {
    setOnInsertFields.totalMatches = 0;
  }
  if (!('completedMatches' in setFields)) {
    setOnInsertFields.completedMatches = 0;
  }
  if (!('disputedMatches' in setFields)) {
    setOnInsertFields.disputedMatches = 0;
  }
  if (!('suspended' in setFields)) {
    setOnInsertFields.suspended = false;
  }

  // Validate MongoDB operator path conflicts to prevent regressions
  const setKeys = new Set(Object.keys(setFields));
  for (const insertKey of Object.keys(setOnInsertFields)) {
    if (setKeys.has(insertKey)) {
      throw new Error(`Updating the path '${insertKey}' would create a conflict at '${insertKey}'.`);
    }
  }

  if (isMongoConnected()) {
    const db = getMongoDb();
    const res = await db.collection(ARENA_COLLECTIONS.VOLUNTEERS).findOneAndUpdate(
      { discordId: String(discordId) },
      {
        $set: setFields,
        $setOnInsert: setOnInsertFields,
      },
      { upsert: true, returnDocument: 'after' }
    );
    return res?.value !== undefined ? res.value : res;
  }

  const existing = memVolunteers.get(String(discordId));
  if (existing) {
    // Existing document: apply $set updates only, preserving existing counters and status
    const merged = { ...existing, ...setFields };
    memVolunteers.set(String(discordId), merged);
    return { ...merged };
  }

  // New document: apply both $setOnInsert and $set
  const newDoc = { ...setOnInsertFields, ...setFields };
  memVolunteers.set(String(discordId), newDoc);
  return { ...newDoc };
}

export async function atomicClaimArenaMatch(matchId, volunteerId, limit = 1) {
  if (!matchId || !volunteerId) {
    return { ok: false, error: 'Match ID and Volunteer ID are required.' };
  }

  if (isMongoConnected()) {
    const db = getMongoDb();
    const matchCol = db.collection(ARENA_COLLECTIONS.MATCHES);
    const volCol = db.collection(ARENA_COLLECTIONS.VOLUNTEERS);
    const now = new Date();

    // 1. Atomically attempt to claim match
    const matchRes = await matchCol.findOneAndUpdate(
      {
        matchId: String(matchId),
        status: ARENA_STATUS.WAITING_FOR_VOLUNTEER,
        volunteerId: null,
      },
      {
        $set: {
          status: ARENA_STATUS.VOLUNTEER_ASSIGNED,
          volunteerId: String(volunteerId),
          assignedAt: now,
          updatedAt: now,
        },
      },
      { returnDocument: 'after' }
    );

    const claimedMatch = matchRes?.value !== undefined ? matchRes.value : matchRes;
    if (!claimedMatch) {
      return { ok: false, error: 'This match has already been claimed by another volunteer.' };
    }

    // 2. Atomically increment volunteer activeMatches if below limit
    const volRes = await volCol.findOneAndUpdate(
      {
        discordId: String(volunteerId),
        suspended: false,
        status: 'AVAILABLE',
        activeMatches: { $lt: limit },
      },
      {
        $inc: { activeMatches: 1 },
        $set: { updatedAt: now },
      },
      { returnDocument: 'after' }
    );

    const updatedVol = volRes?.value !== undefined ? volRes.value : volRes;
    if (!updatedVol) {
      // Rollback match claim if volunteer was at limit or unavailable
      await matchCol.updateOne(
        { matchId: String(matchId), volunteerId: String(volunteerId) },
        {
          $set: {
            status: ARENA_STATUS.WAITING_FOR_VOLUNTEER,
            volunteerId: null,
            assignedAt: null,
            updatedAt: new Date(),
          },
        }
      );
      return { ok: false, error: `❌ You have reached your active match limit of ${limit}.` };
    }

    return { ok: true, match: claimedMatch, volunteer: updatedVol };
  }

  // In-memory fallback for testing
  const match = memMatches.get(String(matchId));
  if (!match || match.status !== ARENA_STATUS.WAITING_FOR_VOLUNTEER || match.volunteerId) {
    return { ok: false, error: 'This match has already been claimed by another volunteer.' };
  }

  const vol = memVolunteers.get(String(volunteerId)) || {
    discordId: String(volunteerId),
    displayName: 'Volunteer',
    status: 'AVAILABLE',
    activeMatches: 0,
    suspended: false,
  };

  if (vol.suspended) {
    return { ok: false, error: '❌ You are suspended from volunteering.' };
  }

  if (vol.status === 'UNAVAILABLE') {
    return { ok: false, error: '❌ You are marked as unavailable.' };
  }

  if (vol.activeMatches >= limit) {
    return { ok: false, error: `❌ You have reached your active match limit of ${limit}.` };
  }

  const now = new Date();
  match.status = ARENA_STATUS.VOLUNTEER_ASSIGNED;
  match.volunteerId = String(volunteerId);
  match.assignedAt = now;
  match.updatedAt = now;

  vol.activeMatches = (vol.activeMatches || 0) + 1;
  vol.updatedAt = now;
  memVolunteers.set(String(volunteerId), vol);

  return { ok: true, match: { ...match }, volunteer: { ...vol } };
}

export const ARENA_LEAVABLE_STATUSES = [
  ARENA_STATUS.VOLUNTEER_ASSIGNED,
  ARENA_STATUS.ROOM_READY,
  ARENA_STATUS.ROOM_ISSUE,
];

/**
 * Atomically removes the assigned Room Maker from a match that has not started yet and returns
 * it to WAITING_FOR_VOLUNTEER. A single conditional update (status + assigned user) makes
 * double-clicks safe: only the first call wins, later calls get { ok: false }.
 * Clears room credentials and credential reports, and decrements the Room Maker's activeMatches.
 * `roomMakerId` null = administrator action (any current assignee).
 */
export async function atomicLeaveArenaMatch(matchId, roomMakerId = null) {
  if (!matchId) return { ok: false, error: 'Match ID is required.' };
  const now = new Date();
  const resetFields = {
    status: ARENA_STATUS.WAITING_FOR_VOLUNTEER,
    volunteerId: null,
    assignedAt: null,
    roomId: null,
    roomPassword: null,
    roomReports: [],
    volunteerWarningSent: false,
    volunteerWarningDueAt: new Date(now.getTime() + ARENA_CONSTANTS.VOLUNTEER_WARNING_MS),
    volunteerTimeoutDueAt: new Date(now.getTime() + ARENA_CONSTANTS.VOLUNTEER_TIMEOUT_MS),
    updatedAt: now,
  };

  if (isMongoConnected()) {
    const db = getMongoDb();
    const filter = {
      matchId: String(matchId),
      status: roomMakerId ? ARENA_STATUS.VOLUNTEER_ASSIGNED : { $in: ARENA_LEAVABLE_STATUSES },
      volunteerId: roomMakerId ? String(roomMakerId) : { $ne: null },
      ...(roomMakerId ? { roomId: null } : {}),
    };
    const res = await db.collection(ARENA_COLLECTIONS.MATCHES).findOneAndUpdate(
      filter,
      { $set: resetFields },
      { returnDocument: 'before' }
    );
    const previous = res?.value !== undefined ? res.value : res;
    if (!previous) {
      const current = await db.collection(ARENA_COLLECTIONS.MATCHES).findOne({ matchId: String(matchId) });
      if (current && (current.roomId || current.status !== ARENA_STATUS.VOLUNTEER_ASSIGNED) && roomMakerId) {
        return {
          ok: false,
          error: '❌ You cannot leave the match after submitting room credentials. Only an administrator can reassign this match.',
        };
      }
      return { ok: false, error: 'This match can no longer be left (already left, started or reassigned).' };
    }
    await db.collection(ARENA_COLLECTIONS.VOLUNTEERS).updateOne(
      { discordId: String(previous.volunteerId), activeMatches: { $gt: 0 } },
      { $inc: { activeMatches: -1 }, $set: { updatedAt: now } }
    );
    const match = await db.collection(ARENA_COLLECTIONS.MATCHES).findOne({ matchId: String(matchId) });
    return { ok: true, previous, match, previousRoomMakerId: String(previous.volunteerId) };
  }

  const existing = memMatches.get(String(matchId));
  if (!existing) {
    return { ok: false, error: 'Match not found.' };
  }
  if (roomMakerId && (existing.roomId || existing.status !== ARENA_STATUS.VOLUNTEER_ASSIGNED)) {
    return {
      ok: false,
      error: '❌ You cannot leave the match after submitting room credentials. Only an administrator can reassign this match.',
    };
  }
  if (
    !ARENA_LEAVABLE_STATUSES.includes(existing.status) ||
    !existing.volunteerId ||
    (roomMakerId && existing.volunteerId !== String(roomMakerId))
  ) {
    return { ok: false, error: 'This match can no longer be left (already left, started or reassigned).' };
  }
  const previous = { ...existing };
  memMatches.set(String(matchId), { ...existing, ...resetFields });
  const vol = memVolunteers.get(String(previous.volunteerId));
  if (vol && vol.activeMatches > 0) {
    vol.activeMatches -= 1;
    vol.updatedAt = now;
  }
  return {
    ok: true,
    previous,
    match: { ...memMatches.get(String(matchId)) },
    previousRoomMakerId: String(previous.volunteerId),
  };
}

export const ROOM_ISSUE_TYPES = {
  ROOM_ID: 'ROOM_ID',
  PASSWORD: 'PASSWORD',
  BOTH: 'BOTH',
};

/**
 * Atomically records an incorrect-credentials report from one player and moves the match to
 * ROOM_ISSUE. The conditional filter rejects (a) matches that are not ROOM_READY/ROOM_ISSUE
 * (e.g. already LIVE) and (b) a second report from the same player for the same credentials.
 */
export async function atomicReportRoomIssue(matchId, playerId, issueType) {
  if (!matchId || !playerId) return { ok: false, error: 'Match ID and player ID are required.' };
  const now = new Date();
  const report = { playerId: String(playerId), issueType: String(issueType), reportedAt: now };

  if (isMongoConnected()) {
    const db = getMongoDb();
    const res = await db.collection(ARENA_COLLECTIONS.MATCHES).findOneAndUpdate(
      {
        matchId: String(matchId),
        status: { $in: [ARENA_STATUS.ROOM_READY, ARENA_STATUS.ROOM_ISSUE] },
        'roomReports.playerId': { $ne: String(playerId) },
      },
      {
        $set: { status: ARENA_STATUS.ROOM_ISSUE, updatedAt: now },
        $push: { roomReports: report },
      },
      { returnDocument: 'after' }
    );
    const match = res?.value !== undefined ? res.value : res;
    return match ? { ok: true, match } : { ok: false };
  }

  const existing = memMatches.get(String(matchId));
  if (
    !existing ||
    ![ARENA_STATUS.ROOM_READY, ARENA_STATUS.ROOM_ISSUE].includes(existing.status) ||
    (existing.roomReports || []).some((r) => r.playerId === String(playerId))
  ) {
    return { ok: false };
  }
  existing.status = ARENA_STATUS.ROOM_ISSUE;
  existing.roomReports = [...(existing.roomReports || []), report];
  existing.updatedAt = now;
  return { ok: true, match: { ...existing } };
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

// ============================================================================
// Complete Arena Deletion
// ============================================================================

export async function deleteAllArenaData(guildId) {
  const gId = String(guildId);
  const result = {
    configsDeleted: 0,
    challengesDeleted: 0,
    matchesDeleted: 0,
    disputesDeleted: 0,
    logsDeleted: 0,
    playersDeleted: 0,
    volunteersDeleted: 0,
  };

  if (isMongoConnected()) {
    const db = getMongoDb();

    // 1. Fetch matches for guild to get all matchIds
    const guildMatches = await db.collection(ARENA_COLLECTIONS.MATCHES).find({ guildId: gId }).toArray();
    const matchIds = guildMatches.map((m) => String(m.matchId));

    // 2. Fetch challenges for guild to get all challengeIds
    const guildChallenges = await db.collection(ARENA_COLLECTIONS.CHALLENGES).find({ guildId: gId }).toArray();
    const challengeIds = guildChallenges.map((c) => String(c.challengeId));

    // 3. Delete config
    const cfgRes = await db.collection(ARENA_COLLECTIONS.CONFIG).deleteMany({ guildId: gId });
    result.configsDeleted = cfgRes.deletedCount || 0;

    // 4. Delete challenges
    const chRes = await db.collection(ARENA_COLLECTIONS.CHALLENGES).deleteMany({ guildId: gId });
    result.challengesDeleted = chRes.deletedCount || 0;

    // 5. Delete matches
    const mRes = await db.collection(ARENA_COLLECTIONS.MATCHES).deleteMany({ guildId: gId });
    result.matchesDeleted = mRes.deletedCount || 0;

    // 6. Delete disputes
    const dispFilter = matchIds.length > 0 ? { matchId: { $in: matchIds } } : { matchId: '__none__' };
    const dispRes = await db.collection(ARENA_COLLECTIONS.DISPUTES).deleteMany(dispFilter);
    result.disputesDeleted = dispRes.deletedCount || 0;

    // 7. Delete logs
    const orClauses = [{ 'metadata.guildId': gId }];
    if (matchIds.length > 0) orClauses.push({ matchId: { $in: matchIds } });
    if (challengeIds.length > 0) orClauses.push({ challengeId: { $in: challengeIds } });
    const logRes = await db.collection(ARENA_COLLECTIONS.LOGS).deleteMany({ $or: orClauses });
    result.logsDeleted = logRes.deletedCount || 0;

    // 8. Delete players (all registered BGMI details, stats, activeMatchId)
    const pRes = await db.collection(ARENA_COLLECTIONS.PLAYERS).deleteMany({});
    result.playersDeleted = pRes.deletedCount || 0;

    // 9. Delete volunteers
    const vRes = await db.collection(ARENA_COLLECTIONS.VOLUNTEERS).deleteMany({});
    result.volunteersDeleted = vRes.deletedCount || 0;

    return result;
  }

  // In-memory fallback
  if (memConfig.has(gId)) {
    memConfig.delete(gId);
    result.configsDeleted = 1;
  }

  const matchIds = [];
  for (const [mId, m] of memMatches.entries()) {
    if (m.guildId === gId) {
      matchIds.push(mId);
      memMatches.delete(mId);
      result.matchesDeleted++;
    }
  }

  const challengeIds = [];
  for (const [cId, c] of memChallenges.entries()) {
    if (c.guildId === gId) {
      challengeIds.push(cId);
      memChallenges.delete(cId);
      result.challengesDeleted++;
    }
  }

  for (const [dId, d] of memDisputes.entries()) {
    if (matchIds.includes(d.matchId)) {
      memDisputes.delete(dId);
      result.disputesDeleted++;
    }
  }

  for (let i = memLogs.length - 1; i >= 0; i--) {
    const l = memLogs[i];
    if (matchIds.includes(l.matchId) || challengeIds.includes(l.challengeId) || l.metadata?.guildId === gId) {
      memLogs.splice(i, 1);
      result.logsDeleted++;
    }
  }

  result.playersDeleted = memPlayers.size;
  memPlayers.clear();

  result.volunteersDeleted = memVolunteers.size;
  memVolunteers.clear();

  return result;
}
