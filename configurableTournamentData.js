import crypto from 'node:crypto';
import {
  getMongoDb,
  getMongoClient,
  isMongoConnected,
  acquireLock,
  releaseLock,
  localPendingVerifications,
  cancelPendingTournamentVerificationsByTeam,
} from './mongoService.js';

let externalGuildSettingsGetter = null;
export function setExternalGuildSettingsGetter(fn) {
  externalGuildSettingsGetter = fn;
}

// In-memory fallback stores (used when MongoDB is disconnected or in unit tests)
const localTournaments = new Map(); // tournamentId -> doc
const localRegistrations = new Map(); // registrationId -> doc
const localTeams = new Map(); // teamId -> doc
const localEntries = new Map(); // `${registrationId}:${teamId}` or `${registrationId}:${cycleId}:${teamId}` -> doc
const localPendingEnrollments = new Map(); // `${tournamentId}:${userId}` -> sessionDoc
const localDailyCycles = new Map(); // cycleId -> doc
const localSlots = new Map(); // `${registrationId}:${cycleId}:${slotNumber}` -> slotStateDoc
const localPlayerMemberships = new Map(); // `${tournamentId}:${discordUserId}` -> membershipDoc
const localAuditLogs = []; // Array of audit log docs
const localMutexChains = new Map(); // lockKey -> Promise

export function clearInMemoryData() {
  localTournaments.clear();
  localRegistrations.clear();
  localTeams.clear();
  localEntries.clear();
  localPendingEnrollments.clear();
  localDailyCycles.clear();
  localSlots.clear();
  localPlayerMemberships.clear();
  localAuditLogs.length = 0;
  localMutexChains.clear();
}

/**
 * Serializes concurrent operations for a given lockKey across both in-memory execution
 * and distributed MongoDB locks.
 *
 * @template T
 * @param {string} lockKey
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withAtomicMutex(lockKey, fn) {
  const prev = localMutexChains.get(lockKey) || Promise.resolve();
  let releaseLocal;
  const current = new Promise((resolve) => {
    releaseLocal = resolve;
  });
  localMutexChains.set(lockKey, prev.then(() => current));

  await prev;
  await acquireLock(lockKey);
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

function normalizeTournament(doc) {
  if (!doc) return null;
  const rawReq = doc.requiredDiscordMembers;
  const parsed = typeof rawReq === 'number' ? rawReq : parseInt(rawReq, 10);
  const requiredDiscordMembers = (!isNaN(parsed) && parsed >= 1 && parsed <= 4) ? parsed : 4;
  return {
    ...doc,
    requiredDiscordMembers,
  };
}

/**
 * Extracts and returns a sorted, deduplicated array of integer locked slot numbers (1..totalSlots).
 * Supports:
 * - A registration object (`reg.lockedSlots` or `reg.reservedSlots`)
 * - An array of slot numbers (e.g. `[1, 2, 7, 17, 18]`)
 * - A number count (e.g. `2` -> `[1, 2]`)
 * - A string (e.g. `"2"` -> `[1, 2]` or `"1, 2, 7"` -> `[1, 2, 7]`)
 *
 * @param {object|Array<number>|number|string} registrationOrInput
 * @param {number} [totalSlots]
 * @returns {number[]}
 */
export function getLockedSlotNumbers(registrationOrInput, totalSlots = null) {
  if (registrationOrInput === null || registrationOrInput === undefined || registrationOrInput === '') {
    return [];
  }

  let effectiveTotal = typeof totalSlots === 'number' && totalSlots > 0 ? Math.floor(totalSlots) : null;
  if (
    registrationOrInput &&
    typeof registrationOrInput === 'object' &&
    !Array.isArray(registrationOrInput)
  ) {
    if (!effectiveTotal && typeof registrationOrInput.totalSlots === 'number' && registrationOrInput.totalSlots > 0) {
      effectiveTotal = Math.floor(registrationOrInput.totalSlots);
    }
    if (Array.isArray(registrationOrInput.lockedSlots)) {
      return getLockedSlotNumbers(registrationOrInput.lockedSlots, effectiveTotal);
    }
    if (registrationOrInput.reservedSlots !== undefined && registrationOrInput.reservedSlots !== null) {
      return getLockedSlotNumbers(registrationOrInput.reservedSlots, effectiveTotal);
    }
    return [];
  }

  const clampFilter = (arr) => {
    const set = new Set();
    for (const raw of arr) {
      const n = typeof raw === 'number' ? Math.floor(raw) : parseInt(String(raw).trim(), 10);
      if (!Number.isInteger(n) || n < 1) continue;
      if (effectiveTotal && n > effectiveTotal) continue;
      set.add(n);
    }
    return Array.from(set).sort((a, b) => a - b);
  };

  if (Array.isArray(registrationOrInput)) {
    return clampFilter(registrationOrInput);
  }

  if (typeof registrationOrInput === 'number') {
    const count = isNaN(registrationOrInput) ? 0 : Math.max(0, Math.floor(registrationOrInput));
    const maxCount = effectiveTotal ? Math.min(effectiveTotal, count) : count;
    const result = [];
    for (let s = 1; s <= maxCount; s++) {
      result.push(s);
    }
    return result;
  }

  if (typeof registrationOrInput === 'string') {
    const trimmed = registrationOrInput.trim();
    if (!trimmed) return [];
    if (/^\d+$/.test(trimmed)) {
      const count = Math.max(0, parseInt(trimmed, 10));
      const maxCount = effectiveTotal ? Math.min(effectiveTotal, count) : count;
      const result = [];
      for (let s = 1; s <= maxCount; s++) {
        result.push(s);
      }
      return result;
    }
    const tokens = trimmed.split(/[\s,;]+/).filter(Boolean);
    const parsedNums = tokens.map((t) => parseInt(t, 10)).filter((n) => Number.isInteger(n) && n >= 1);
    if (parsedNums.length > 0) {
      return clampFilter(parsedNums);
    }
  }

  return [];
}

/**
 * Normalizes reserved/locked slots input into an integer count of locked slots.
 * @param {object|string|Array<number>|number} input
 * @param {number} [totalSlots]
 * @returns {number}
 */
export function parseReservedSlots(input, totalSlots = null) {
  if (input === null || input === undefined || input === '') return 0;
  if (typeof input === 'object' && !Array.isArray(input)) {
    return getLockedSlotNumbers(input, totalSlots).length;
  }
  let count = 0;

  if (typeof input === 'number') {
    count = isNaN(input) ? 0 : Math.max(0, Math.floor(input));
  } else if (Array.isArray(input)) {
    count = getLockedSlotNumbers(input, totalSlots).length;
  } else if (typeof input === 'string') {
    const trimmed = input.trim();
    const num = parseInt(trimmed, 10);
    if (!isNaN(num) && /^\d+$/.test(trimmed)) {
      count = Math.max(0, num);
    } else {
      const tokens = trimmed.split(/[\s,;]+/).filter(Boolean);
      count = tokens.length;
    }
  }

  if (typeof totalSlots === 'number' && totalSlots > 0) {
    count = Math.min(totalSlots, count);
  }

  return count;
}

/**
 * Parses a recurring time string (e.g. "10:00 AM", "18:00", "02:00 AM", "6:00 pm").
 * @param {string} timeStr
 * @returns {{ hours: number, minutes: number, formatted: string } | null}
 */
export function parseTimeString(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const match = timeStr.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const meridiem = match[3] ? match[3].toLowerCase() : null;

  if (minutes < 0 || minutes > 59) return null;

  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    if (meridiem === 'pm' && hours < 12) hours += 12;
    if (meridiem === 'am' && hours === 12) hours = 0;
  } else {
    if (hours < 0 || hours > 23) return null;
  }

  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  return { hours, minutes, formatted: `${hh}:${mm}` };
}

/**
 * Returns current date/time parts in the specified timezone.
 * @param {string} timezone
 * @param {Date} [baseDate]
 */
export function getCurrentTimeInTimezone(timezone = 'Asia/Kolkata', baseDate = new Date()) {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = formatter.formatToParts(baseDate);
    const map = {};
    for (const p of parts) map[p.type] = p.value;

    const year = parseInt(map.year, 10);
    const month = parseInt(map.month, 10);
    const day = parseInt(map.day, 10);
    const hour = parseInt(map.hour, 10);
    const minute = parseInt(map.minute, 10);
    const second = parseInt(map.second, 10);

    const dateString = `${map.year}-${map.month}-${map.day}`;
    const totalMinutes = hour * 60 + minute;
    const timeString = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

    return { year, month, day, hour, minute, second, dateString, totalMinutes, timeString };
  } catch {
    // Fallback if timezone string is invalid
    const d = baseDate;
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const hour = d.getUTCHours();
    const minute = d.getUTCMinutes();
    const second = d.getUTCSeconds();
    const dateString = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return { year, month, day, hour, minute, second, dateString, totalMinutes: hour * 60 + minute, timeString: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
  }
}

/**
 * Calculates next calendar cycle date string.
 * @param {string} timezone
 * @param {Date} [baseDate]
 * @returns {string}
 */
export function getNextCycleDateString(timezone = 'Asia/Kolkata', baseDate = new Date()) {
  const nextDay = new Date(baseDate.getTime() + 24 * 60 * 60 * 1000);
  return getCurrentTimeInTimezone(timezone, nextDay).dateString;
}

/**
 * Computes the exact UTC Date for a given wall-clock time (hours, minutes, seconds = 0)
 * on a specific calendar date (year, month, day) in the given IANA timezone.
 * @param {number} year
 * @param {number} month 1-12
 * @param {number} day
 * @param {number} hours 0-23
 * @param {number} minutes 0-59
 * @param {string} [timezone]
 * @returns {Date}
 */
export function getExactTimeInTimezone(year, month, day, hours, minutes, timezone = 'Asia/Kolkata') {
  const targetUtcMs = Date.UTC(year, month - 1, day, hours, minutes, 0, 0);
  let guessMs = targetUtcMs;

  for (let i = 0; i < 2; i++) {
    const tzParts = getCurrentTimeInTimezone(timezone, new Date(guessMs));
    const representedUtcMs = Date.UTC(
      tzParts.year,
      tzParts.month - 1,
      tzParts.day,
      tzParts.hour,
      tzParts.minute,
      tzParts.second,
      0
    );
    const diffMs = representedUtcMs - targetUtcMs;
    guessMs -= diffMs;
  }

  return new Date(guessMs);
}

/**
 * Computes the next due UTC timestamps for daily start and daily reset in the registration's timezone.
 * @param {string} dailyStartTime
 * @param {string} dailyResetTime
 * @param {string} [timezone]
 * @param {Date} [now]
 * @returns {{ nextStartAt: Date|null, nextResetAt: Date|null, nextDueAt: Date|null, nextDueAction: 'START'|'RESET'|null }}
 */
export function computeNextScheduleTimestamps(
  dailyStartTime,
  dailyResetTime,
  timezone = 'Asia/Kolkata',
  now = new Date()
) {
  const parsedStart = parseTimeString(dailyStartTime);
  const parsedReset = parseTimeString(dailyResetTime);
  const tzNow = getCurrentTimeInTimezone(timezone, now);
  const nowMs = now.getTime();

  let nextStartAt = null;
  if (parsedStart) {
    let startCandidate = getExactTimeInTimezone(
      tzNow.year,
      tzNow.month,
      tzNow.day,
      parsedStart.hours,
      parsedStart.minutes,
      timezone
    );
    if (startCandidate.getTime() <= nowMs) {
      startCandidate = getExactTimeInTimezone(
        tzNow.year,
        tzNow.month,
        tzNow.day + 1,
        parsedStart.hours,
        parsedStart.minutes,
        timezone
      );
    }
    nextStartAt = startCandidate;
  }

  let nextResetAt = null;
  if (parsedReset) {
    let resetCandidate = getExactTimeInTimezone(
      tzNow.year,
      tzNow.month,
      tzNow.day,
      parsedReset.hours,
      parsedReset.minutes,
      timezone
    );
    if (resetCandidate.getTime() <= nowMs) {
      resetCandidate = getExactTimeInTimezone(
        tzNow.year,
        tzNow.month,
        tzNow.day + 1,
        parsedReset.hours,
        parsedReset.minutes,
        timezone
      );
    }
    nextResetAt = resetCandidate;
  }

  let nextDueAt = null;
  let nextDueAction = null;
  if (nextStartAt && nextResetAt) {
    if (nextStartAt.getTime() <= nextResetAt.getTime()) {
      nextDueAt = nextStartAt;
      nextDueAction = 'START';
    } else {
      nextDueAt = nextResetAt;
      nextDueAction = 'RESET';
    }
  } else if (nextStartAt) {
    nextDueAt = nextStartAt;
    nextDueAction = 'START';
  } else if (nextResetAt) {
    nextDueAt = nextResetAt;
    nextDueAction = 'RESET';
  }

  return {
    nextStartAt,
    nextResetAt,
    nextDueAt,
    nextDueAction,
  };
}

/**
 * Evaluates whether current clock time in the timezone falls within the daily active cycle.
 * Handles both same-day (start < reset) and midnight-crossing (reset <= start) configurations.
 * @param {string} dailyStartTime
 * @param {string} dailyResetTime
 * @param {string} timezone
 * @param {Date} [now]
 * @returns {{ isOpen: boolean, status: string, cycleDate: string }}
 */
export function evaluateDailyCycleStatus(dailyStartTime, dailyResetTime, timezone = 'Asia/Kolkata', now = new Date()) {
  const parsedStart = parseTimeString(dailyStartTime);
  const parsedReset = parseTimeString(dailyResetTime);

  const tzInfo = getCurrentTimeInTimezone(timezone, now);
  if (!parsedStart || !parsedReset) {
    return {
      isOpen: true,
      status: 'OPEN',
      cycleDate: tzInfo.dateString,
      activeCycleDate: tzInfo.dateString,
      endedCycleDate: null,
    };
  }

  const startMinutes = parsedStart.hours * 60 + parsedStart.minutes;
  const resetMinutes = parsedReset.hours * 60 + parsedReset.minutes;
  const currentMinutes = tzInfo.totalMinutes;

  const yesterdayDate = getCurrentTimeInTimezone(timezone, new Date(now.getTime() - 24 * 60 * 60 * 1000)).dateString;
  const dayBeforeYesterdayDate = getCurrentTimeInTimezone(timezone, new Date(now.getTime() - 48 * 60 * 60 * 1000)).dateString;

  let isOpen = false;
  let beforeStart = false;
  let cycleEnded = false;
  let activeCycleDate = tzInfo.dateString;
  let endedCycleDate = yesterdayDate;

  if (startMinutes < resetMinutes) {
    // Same-day cycle (e.g. 10:00 to 22:00)
    if (currentMinutes < startMinutes) {
      isOpen = false;
      beforeStart = true;
      activeCycleDate = tzInfo.dateString;
      endedCycleDate = yesterdayDate;
    } else if (currentMinutes < resetMinutes) {
      isOpen = true;
      activeCycleDate = tzInfo.dateString;
      endedCycleDate = yesterdayDate;
    } else {
      isOpen = false;
      cycleEnded = true;
      activeCycleDate = getNextCycleDateString(timezone, now);
      endedCycleDate = tzInfo.dateString;
    }
  } else {
    // Midnight-crossing cycle (e.g. 10:00 AM to 02:00 AM next day)
    if (currentMinutes >= startMinutes) {
      isOpen = true;
      activeCycleDate = tzInfo.dateString;
      endedCycleDate = yesterdayDate;
    } else if (currentMinutes < resetMinutes) {
      isOpen = true;
      activeCycleDate = yesterdayDate;
      endedCycleDate = dayBeforeYesterdayDate;
    } else {
      // Between resetMinutes and startMinutes (e.g. 02:00 AM to 10:00 AM):
      // The cycle that ended at resetMinutes today was yesterday's cycle.
      isOpen = false;
      beforeStart = true;
      activeCycleDate = tzInfo.dateString;
      endedCycleDate = yesterdayDate;
    }
  }

  return {
    isOpen,
    beforeStart,
    cycleEnded,
    status: isOpen ? 'OPEN' : beforeStart ? 'NOT OPENED YET' : 'CLOSED',
    cycleDate: activeCycleDate,
    activeCycleDate,
    endedCycleDate,
  };
}

// ----------------------------------------------------
// TOURNAMENT CRUD
// ----------------------------------------------------

export async function saveConfigurableTournament(doc) {
  if (!doc) return null;
  const now = new Date();
  const { _id, ...cleanDoc } = doc;
  const tournamentId = cleanDoc.tournamentId || crypto.randomUUID();
  const normalized = normalizeTournament(cleanDoc);
  const nameLower = (cleanDoc.name || '').trim().toLowerCase();
  const record = {
    ...normalized,
    tournamentId,
    nameLower,
    prefix: cleanDoc.prefix || null,
    boldPrefix: cleanDoc.boldPrefix || null,
    updatedAt: now,
    createdAt: cleanDoc.createdAt || now,
  };

  localTournaments.set(tournamentId, { ...record });

  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_tournaments');
      await col.updateOne(
        { tournamentId },
        { $set: record },
        { upsert: true }
      );
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error saving tournament ${tournamentId}:`, err.message);
    }
  }

  return record;
}

export async function getConfigurableTournament(tournamentId, includeDeleted = false) {
  if (!tournamentId) return null;
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_tournaments');
      const doc = await col.findOne({ tournamentId });
      if (doc) {
        const normalized = normalizeTournament(doc);
        localTournaments.set(tournamentId, normalized);
        if (!includeDeleted && (doc.status === 'DELETED' || doc.isDeleted === true)) {
          return null;
        }
        return normalized;
      }
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error reading tournament ${tournamentId}:`, err.message);
    }
  }
  const local = localTournaments.get(tournamentId);
  if (!local) return null;
  if (!includeDeleted && (local.status === 'DELETED' || local.isDeleted === true)) {
    return null;
  }
  return normalizeTournament(local);
}

export async function getConfigurableTournamentByCategory(guildId, categoryId, includeDeleted = false) {
  if (!guildId || !categoryId) return null;
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_tournaments');
      const query = { guildId, categoryId };
      if (!includeDeleted) {
        query.status = { $ne: 'DELETED' };
        query.isDeleted = { $ne: true };
      }
      const doc = await col.findOne(query);
      if (doc) {
        const normalized = normalizeTournament(doc);
        localTournaments.set(doc.tournamentId, normalized);
        return normalized;
      }
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error reading tournament by category:`, err.message);
    }
  }

  for (const doc of localTournaments.values()) {
    if (doc.guildId === guildId && doc.categoryId === categoryId) {
      if (!includeDeleted && (doc.status === 'DELETED' || doc.isDeleted === true)) continue;
      return normalizeTournament(doc);
    }
  }
  return null;
}

export async function getConfigurableTournamentByName(guildId, name, includeDeleted = false) {
  if (!guildId || !name) return null;
  const nameLower = name.trim().toLowerCase();

  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_tournaments');
      const query = {
        guildId,
        $or: [
          { nameLower },
          { name: { $regex: new RegExp(`^${nameLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } },
        ],
      };
      if (!includeDeleted) {
        query.status = { $ne: 'DELETED' };
        query.isDeleted = { $ne: true };
      }
      const doc = await col.findOne(query);
      if (doc) {
        const normalized = normalizeTournament(doc);
        localTournaments.set(doc.tournamentId, normalized);
        return normalized;
      }
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error reading tournament by name:`, err.message);
    }
  }

  for (const doc of localTournaments.values()) {
    if (doc.guildId === guildId) {
      const docNameLower = (doc.nameLower || doc.name || '').trim().toLowerCase();
      if (docNameLower === nameLower) {
        if (!includeDeleted && (doc.status === 'DELETED' || doc.isDeleted === true)) continue;
        return normalizeTournament(doc);
      }
    }
  }
  return null;
}

export async function getConfigurableTournamentBySetupChannel(setupChannelId, includeDeleted = false) {
  if (!setupChannelId) return null;
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_tournaments');
      const query = { setupChannelId };
      if (!includeDeleted) {
        query.status = { $ne: 'DELETED' };
        query.isDeleted = { $ne: true };
      }
      const doc = await col.findOne(query);
      if (doc) {
        const normalized = normalizeTournament(doc);
        localTournaments.set(doc.tournamentId, normalized);
        return normalized;
      }
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error reading tournament by setup channel:`, err.message);
    }
  }

  for (const doc of localTournaments.values()) {
    if (doc.setupChannelId === setupChannelId) {
      if (!includeDeleted && (doc.status === 'DELETED' || doc.isDeleted === true)) continue;
      return normalizeTournament(doc);
    }
  }
  return null;
}

export async function getAllConfigurableTournaments(guildId = null, includeDeleted = false) {
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_tournaments');
      const query = guildId ? { guildId } : {};
      if (!includeDeleted) {
        query.status = { $ne: 'DELETED' };
        query.isDeleted = { $ne: true };
      }
      const docs = await col.find(query).toArray();
      const normalizedDocs = docs.map(normalizeTournament);
      for (const d of normalizedDocs) {
        localTournaments.set(d.tournamentId, d);
      }
      return normalizedDocs;
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error getting all tournaments:`, err.message);
    }
  }

  const all = Array.from(localTournaments.values())
    .filter((d) => includeDeleted || (d.status !== 'DELETED' && !d.isDeleted))
    .map(normalizeTournament);
  return guildId ? all.filter((d) => d.guildId === guildId) : all;
}

export async function deleteConfigurableTournament(tournamentId, client = null) {
  if (!tournamentId) return false;
  const tour = await getConfigurableTournament(tournamentId, true);
  if (!tour) return false;

  const now = new Date();

  // 1. Soft-delete and cleanup all registrations belonging to this tournament
  const registrations = await getConfigurableRegistrationsForTournament(tournamentId, true);
  for (const reg of registrations) {
    if (reg.status !== 'DELETED') {
      await deleteConfigurableRegistration(reg.registrationId, client);
    }
  }

  // 2. Mark tournament as soft-deleted and remove stored channel and message IDs
  tour.status = 'DELETED';
  tour.isDeleted = true;
  tour.deletedAt = now;
  tour.setupChannelId = null;
  tour.dashboardMessageId = null;
  tour.standardChannels = null;
  tour.categoryId = null;
  tour.updatedAt = now;

  localTournaments.set(tournamentId, { ...tour });

  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_tournaments');
      await col.updateOne(
        { tournamentId },
        {
          $set: {
            status: 'DELETED',
            isDeleted: true,
            deletedAt: now,
            setupChannelId: null,
            dashboardMessageId: null,
            standardChannels: null,
            categoryId: null,
            updatedAt: now,
          },
        }
      );
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error soft-deleting tournament ${tournamentId}:`, err.message);
      return false;
    }
  }
  return true;
}

// ----------------------------------------------------
// REGISTRATION INSTANCE CRUD
// ----------------------------------------------------

export async function saveConfigurableRegistration(doc) {
  if (!doc) return null;
  const now = new Date();
  const { _id, ...cleanDoc } = doc;
  const registrationId = cleanDoc.registrationId || crypto.randomUUID();
  const totalSlots = typeof cleanDoc.totalSlots === 'number' && cleanDoc.totalSlots > 0 ? cleanDoc.totalSlots : 20;
  const existingLocal = localRegistrations.get(registrationId);

  let lockedSlots = [];
  if (cleanDoc.lockedSlots !== undefined && cleanDoc.lockedSlots !== null) {
    lockedSlots = getLockedSlotNumbers(cleanDoc.lockedSlots, totalSlots);
  } else if (Array.isArray(cleanDoc.reservedSlots)) {
    lockedSlots = getLockedSlotNumbers(cleanDoc.reservedSlots, totalSlots);
  } else if (typeof cleanDoc.reservedSlots === 'number' || typeof cleanDoc.reservedSlots === 'string') {
    const requestedCount = parseReservedSlots(cleanDoc.reservedSlots, totalSlots);
    const existingLocked = existingLocal ? getLockedSlotNumbers(existingLocal, totalSlots) : [];
    if (existingLocked.length === requestedCount && existingLocked.length > 0) {
      lockedSlots = existingLocked;
    } else if (typeof cleanDoc.reservedSlots === 'string' && /[\s,;]/.test(cleanDoc.reservedSlots.trim())) {
      lockedSlots = getLockedSlotNumbers(cleanDoc.reservedSlots, totalSlots);
    } else {
      lockedSlots = getLockedSlotNumbers(requestedCount, totalSlots);
    }
  } else if (existingLocal) {
    lockedSlots = getLockedSlotNumbers(existingLocal, totalSlots);
  }

  const reservedSlots = lockedSlots.length;
  const lockedSlotsMeta = {
    ...(existingLocal?.lockedSlotsMeta || {}),
    ...(cleanDoc.lockedSlotsMeta || {}),
  };

  const parsedMatches = typeof cleanDoc.matches === 'number'
    ? cleanDoc.matches
    : parseInt(cleanDoc.matches, 10);
  const matches = !isNaN(parsedMatches) && parsedMatches > 0 ? parsedMatches : 1;
  const timezone = cleanDoc.timezone || 'Asia/Kolkata';

  let scheduleFields = {};
  if (cleanDoc.dailyStartTime || cleanDoc.dailyResetTime) {
    const computed = computeNextScheduleTimestamps(
      cleanDoc.dailyStartTime,
      cleanDoc.dailyResetTime,
      timezone,
      cleanDoc._scheduleBaseNow instanceof Date ? cleanDoc._scheduleBaseNow : now
    );
    scheduleFields = {
      nextStartAt: cleanDoc.nextStartAt instanceof Date ? cleanDoc.nextStartAt : computed.nextStartAt,
      nextResetAt: cleanDoc.nextResetAt instanceof Date ? cleanDoc.nextResetAt : computed.nextResetAt,
      nextDueAt: cleanDoc.nextDueAt instanceof Date ? cleanDoc.nextDueAt : computed.nextDueAt,
      nextDueAction: cleanDoc.nextDueAction || computed.nextDueAction,
    };
  }
  delete cleanDoc._scheduleBaseNow;

  let registrationNumber = cleanDoc.registrationNumber ?? existingLocal?.registrationNumber;
  if (
    (!Number.isFinite(Number(registrationNumber)) || Number(registrationNumber) <= 0) &&
    cleanDoc.tournamentId
  ) {
    let maxNum = 0;
    for (const r of localRegistrations.values()) {
      if (r.tournamentId === cleanDoc.tournamentId && Number.isFinite(Number(r.registrationNumber))) {
        maxNum = Math.max(maxNum, Number(r.registrationNumber));
      }
    }
    registrationNumber = maxNum + 1;
  }

  const record = {
    ...cleanDoc,
    ...scheduleFields,
    registrationId,
    ...(Number.isFinite(Number(registrationNumber)) && Number(registrationNumber) > 0
      ? { registrationNumber: Number(registrationNumber) }
      : {}),
    totalSlots,
    reservedSlots,
    lockedSlots,
    lockedSlotsMeta,
    matches,
    timezone,
    scheduleImageUrl:
      cleanDoc.scheduleImageUrl !== undefined
        ? cleanDoc.scheduleImageUrl
        : (existingLocal?.scheduleImageUrl ?? null),
    scheduleMessageId:
      cleanDoc.scheduleMessageId !== undefined
        ? cleanDoc.scheduleMessageId
        : (existingLocal?.scheduleMessageId ?? null),
    scheduleChannelId:
      cleanDoc.scheduleChannelId !== undefined
        ? cleanDoc.scheduleChannelId
        : (existingLocal?.scheduleChannelId ?? null),
    uploadedBy:
      cleanDoc.uploadedBy !== undefined
        ? cleanDoc.uploadedBy
        : (existingLocal?.uploadedBy ?? null),
    uploadedAt:
      cleanDoc.uploadedAt !== undefined
        ? cleanDoc.uploadedAt
        : (existingLocal?.uploadedAt ?? null),
    updatedAt: now,
    createdAt: cleanDoc.createdAt || existingLocal?.createdAt || now,
  };

  localRegistrations.set(registrationId, { ...record });

  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_registrations');
      await col.updateOne(
        { registrationId },
        { $set: record },
        { upsert: true }
      );
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error saving registration ${registrationId}:`, err.message);
    }
  }

  // Keep per-slot state documents synchronized for the registration's active cycle
  await syncRegistrationSlotStates(registrationId, record.currentCycleId || 'default', record).catch(() => {});

  return record;
}

export async function getConfigurableRegistration(registrationId, includeDeleted = false) {
  if (!registrationId) return null;
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_registrations');
      const doc = await col.findOne({ registrationId });
      if (doc) {
        localRegistrations.set(registrationId, doc);
        if (!includeDeleted && (doc.status === 'DELETED' || doc.isDeleted === true)) {
          return null;
        }
        return doc;
      }
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error reading registration ${registrationId}:`, err.message);
    }
  }
  const local = localRegistrations.get(registrationId) || null;
  if (local && !includeDeleted && (local.status === 'DELETED' || local.isDeleted === true)) {
    return null;
  }
  return local;
}

export async function getConfigurableRegistrationsForTournament(tournamentId, includeDeleted = false) {
  if (!tournamentId) return [];
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_registrations');
      const query = { tournamentId };
      if (!includeDeleted) {
        query.status = { $ne: 'DELETED' };
        query.isDeleted = { $ne: true };
      }
      const docs = await col.find(query).sort({ registrationNumber: 1, createdAt: 1, registrationId: 1 }).toArray();
      for (const d of docs) {
        localRegistrations.set(d.registrationId, d);
      }
      return docs;
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error listing registrations for ${tournamentId}:`, err.message);
    }
  }

  return Array.from(localRegistrations.values())
    .filter((r) => {
      if (r.tournamentId !== tournamentId) return false;
      if (!includeDeleted && (r.status === 'DELETED' || r.isDeleted === true)) return false;
      return true;
    })
    .sort((a, b) => {
      const numA = Number.isFinite(Number(a.registrationNumber)) && Number(a.registrationNumber) > 0
        ? Number(a.registrationNumber)
        : Number.MAX_SAFE_INTEGER;
      const numB = Number.isFinite(Number(b.registrationNumber)) && Number(b.registrationNumber) > 0
        ? Number(b.registrationNumber)
        : Number.MAX_SAFE_INTEGER;
      if (numA !== numB) return numA - numB;
      const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      if (timeA !== timeB) return timeA - timeB;
      return String(a.registrationId || '').localeCompare(String(b.registrationId || ''));
    });
}

export async function findConfigurableRegistrationByChannelId(channelId, includeDeleted = false) {
  if (!channelId) return null;
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_registrations');
      const query = {
        $or: [{ registrationChannelId: channelId }, { idpChannelId: channelId }],
      };
      if (!includeDeleted) {
        query.status = { $ne: 'DELETED' };
        query.isDeleted = { $ne: true };
      }
      const doc = await col.findOne(query);
      if (doc) {
        localRegistrations.set(doc.registrationId, doc);
        return doc;
      }
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error finding registration by channel ${channelId}:`, err.message);
    }
  }

  for (const reg of localRegistrations.values()) {
    if (reg.registrationChannelId === channelId || reg.idpChannelId === channelId) {
      if (!includeDeleted && (reg.status === 'DELETED' || reg.isDeleted === true)) continue;
      return reg;
    }
  }
  return null;
}

export async function findConfigurableRegistrationByMessageId(messageId, includeDeleted = false) {
  if (!messageId) return null;
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_registrations');
      const query = {
        $or: [{ registrationMessageId: messageId }, { slotChartMessageId: messageId }],
      };
      if (!includeDeleted) {
        query.status = { $ne: 'DELETED' };
        query.isDeleted = { $ne: true };
      }
      const doc = await col.findOne(query);
      if (doc) {
        localRegistrations.set(doc.registrationId, doc);
        return doc;
      }
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error finding registration by message ${messageId}:`, err.message);
    }
  }

  for (const reg of localRegistrations.values()) {
    if (reg.registrationMessageId === messageId || reg.slotChartMessageId === messageId) {
      if (!includeDeleted && (reg.status === 'DELETED' || reg.isDeleted === true)) continue;
      return reg;
    }
  }
  return null;
}

export async function getAllActiveConfigurableRegistrations() {
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_registrations');
      const docs = await col.find({
        status: { $ne: 'DELETED' },
        isDeleted: { $ne: true },
      }).toArray();
      for (const d of docs) {
        localRegistrations.set(d.registrationId, d);
      }
      return docs;
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error getting active registrations:`, err.message);
    }
  }

  return Array.from(localRegistrations.values()).filter(
    (r) => r.status !== 'DELETED' && !r.isDeleted
  );
}

export async function deleteConfigurableRegistration(registrationId, client = null) {
  if (!registrationId) return false;
  const reg = await getConfigurableRegistration(registrationId, true);
  const now = new Date();

  // 1. Get active entries before archiving
  const activeEntries = await getConfigurableEntriesForRegistration(registrationId);

  // 2. Revoke IDP channel permissions for this registration's entries
  if (client && reg && reg.idpChannelId) {
    try {
      const idpChannel = await client.channels.fetch(reg.idpChannelId).catch(() => null);
      if (idpChannel && idpChannel.permissionOverwrites) {
        for (const entry of activeEntries) {
          if (entry.leaderDiscordId) {
            await idpChannel.permissionOverwrites.delete(entry.leaderDiscordId).catch(() => {});
          }
        }
      }
    } catch {}
  }

  // 3. Archive active entries to daily registration cycles (never hard delete)
  if (reg) {
    await archiveActiveRegistrationCycle(registrationId, {
      reason: 'REGISTRATION_DELETED',
      archivedAt: now,
    }).catch(() => {});
  }

  // 4. Mark active entries as ARCHIVED in localEntries and MongoDB
  for (const entry of activeEntries) {
    entry.status = 'ARCHIVED';
    entry.archivedAt = now;
    const cycleKey = `${entry.registrationId}:${entry.cycleId || 'default'}:${entry.teamId}`;
    localEntries.set(cycleKey, { ...entry });
  }

  // 5. Update localRegistration to DELETED and clear persistent message IDs
  if (reg) {
    reg.status = 'DELETED';
    reg.isDeleted = true;
    reg.deletedAt = now;
    reg.registrationMessageId = null;
    reg.slotChartMessageId = null;
    reg.scheduleImageUrl = null;
    reg.scheduleMessageId = null;
    reg.scheduleChannelId = null;
    reg.uploadedBy = null;
    reg.uploadedAt = null;
    reg.registrationChannelId = null;
    reg.idpChannelId = null;
    localRegistrations.set(registrationId, { ...reg });
  } else {
    localRegistrations.delete(registrationId);
  }

  if (isMongoConnected()) {
    try {
      const regCol = getMongoDb().collection('discord_configurable_registrations');
      await regCol.updateOne(
        { registrationId },
        {
          $set: {
            status: 'DELETED',
            isDeleted: true,
            deletedAt: now,
            registrationMessageId: null,
            slotChartMessageId: null,
            scheduleImageUrl: null,
            scheduleMessageId: null,
            scheduleChannelId: null,
            uploadedBy: null,
            uploadedAt: null,
            registrationChannelId: null,
            idpChannelId: null,
          },
        }
      );

      const entryCol = getMongoDb().collection('discord_configurable_entries');
      await entryCol.updateMany(
        { registrationId, status: { $in: ['CONFIRMED', 'REGISTERED'] } },
        { $set: { status: 'ARCHIVED', archivedAt: now } }
      );
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error soft deleting registration ${registrationId}:`, err.message);
      return false;
    }
  }

  return true;
}

// ----------------------------------------------------
// ENROLLED TEAM CRUD
// ----------------------------------------------------

export async function saveConfigurableTeam(doc) {
  if (!doc) return null;
  const now = new Date();
  const teamId = doc.teamId || crypto.randomUUID();
  const record = {
    ...doc,
    teamId,
    teamNameLower: (doc.teamName || '').trim().toLowerCase(),
    updatedAt: now,
    createdAt: doc.createdAt || now,
  };

  localTeams.set(teamId, { ...record });

  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_teams');
      await col.updateOne(
        { teamId },
        { $set: record },
        { upsert: true }
      );
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error saving team ${teamId}:`, err.message);
    }
  }

  if (record.tournamentId) {
    await syncTeamPlayerMemberships(record).catch(() => {});
  }

  return record;
}

/**
 * Extracts all Discord member assignments (main players + substitutes) from a team document.
 *
 * @param {object} teamDoc
 * @returns {{
 *   memberships: Array<{ tournamentId: string, discordUserId: string, teamId: string, role: string, status: string, assignedAt: Date, updatedAt: Date }>,
 *   hasDuplicateWithinTeam: boolean,
 *   duplicateUserId: string|null
 * }}
 */
export function extractTeamDiscordMemberships(teamDoc) {
  if (!teamDoc || !teamDoc.tournamentId || !teamDoc.teamId) {
    return { memberships: [], hasDuplicateWithinTeam: false, duplicateUserId: null };
  }
  const now = new Date();
  const seen = new Set();
  const memberships = [];
  let hasDuplicateWithinTeam = false;
  let duplicateUserId = null;

  const addMember = (rawId, role) => {
    if (!rawId || typeof rawId !== 'string') return;
    const uid = rawId.trim();
    if (!uid) return;
    if (seen.has(uid)) {
      hasDuplicateWithinTeam = true;
      duplicateUserId = uid;
      return;
    }
    seen.add(uid);
    memberships.push({
      tournamentId: teamDoc.tournamentId,
      discordUserId: uid,
      teamId: teamDoc.teamId,
      role,
      status: 'ACTIVE',
      assignedAt: now,
      updatedAt: now,
    });
  };

  if (Array.isArray(teamDoc.players)) {
    for (let i = 0; i < teamDoc.players.length; i++) {
      const p = teamDoc.players[i];
      const uid = p?.discordId || p?.discordUserId;
      if (uid) {
        const role = uid === teamDoc.leaderDiscordId || i === 0 ? 'LEADER' : `MAIN_PLAYER_${i + 1}`;
        addMember(uid, role);
      }
    }
  }

  if (teamDoc.leaderDiscordId && !seen.has(String(teamDoc.leaderDiscordId).trim())) {
    addMember(String(teamDoc.leaderDiscordId).trim(), 'LEADER');
  }

  if (Array.isArray(teamDoc.substitutes)) {
    for (let j = 0; j < teamDoc.substitutes.length; j++) {
      const sub = teamDoc.substitutes[j];
      const uid = sub?.discordId || sub?.discordUserId;
      if (uid) {
        addMember(uid, `SUBSTITUTE_${j + 1}`);
      }
    }
  }

  return { memberships, hasDuplicateWithinTeam, duplicateUserId };
}

/**
 * Synchronizes player memberships in `discord_tournament_player_memberships` and `localPlayerMemberships`
 * for a given team document, releasing any old memberships of that same team that are no longer assigned.
 *
 * @param {object} teamDoc
 */
export async function syncTeamPlayerMemberships(teamDoc) {
  if (!teamDoc || !teamDoc.tournamentId || !teamDoc.teamId) return [];
  if (['CANCELLED', 'DELETED'].includes(teamDoc.status) || teamDoc.isDeleted === true) {
    await releaseTeamPlayerMemberships(teamDoc.tournamentId, teamDoc.teamId);
    return [];
  }
  const { memberships } = extractTeamDiscordMemberships(teamDoc);
  const newUserIds = new Set(memberships.map((m) => m.discordUserId));

  // Remove old memberships for this team that are no longer in the team's roster/substitutes
  for (const [key, mem] of Array.from(localPlayerMemberships.entries())) {
    if (mem.tournamentId === teamDoc.tournamentId && mem.teamId === teamDoc.teamId) {
      if (!newUserIds.has(mem.discordUserId)) {
        localPlayerMemberships.delete(key);
      }
    }
  }

  // Upsert current memberships
  for (const m of memberships) {
    const key = `${m.tournamentId}:${m.discordUserId}`;
    const existing = localPlayerMemberships.get(key);
    localPlayerMemberships.set(key, {
      ...m,
      assignedAt: existing?.teamId === m.teamId ? (existing.assignedAt || m.assignedAt) : m.assignedAt,
      updatedAt: new Date(),
    });
  }

  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_tournament_player_memberships');
      await col.deleteMany({
        tournamentId: teamDoc.tournamentId,
        teamId: teamDoc.teamId,
        discordUserId: { $nin: Array.from(newUserIds) },
      });
      for (const m of memberships) {
        await col.updateOne(
          { tournamentId: m.tournamentId, discordUserId: m.discordUserId },
          {
            $set: {
              tournamentId: m.tournamentId,
              discordUserId: m.discordUserId,
              teamId: m.teamId,
              role: m.role,
              status: 'ACTIVE',
              updatedAt: new Date(),
            },
            $setOnInsert: {
              assignedAt: m.assignedAt,
            },
          },
          { upsert: true }
        );
      }
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error syncing player memberships for team ${teamDoc.teamId}:`, err.message);
    }
  }

  return memberships;
}

/**
 * Releases all player memberships (main players and substitutes) for a deleted team.
 *
 * @param {string} tournamentId
 * @param {string} teamId
 */
export async function releaseTeamPlayerMemberships(tournamentId, teamId) {
  if (!teamId) return false;
  for (const [key, mem] of Array.from(localPlayerMemberships.entries())) {
    if (mem.teamId === teamId && (!tournamentId || mem.tournamentId === tournamentId)) {
      localPlayerMemberships.delete(key);
    }
  }

  // Also update in-memory team status if present
  const localTeam = localTeams.get(teamId);
  if (localTeam && (!localTeam.status || localTeam.status !== 'CANCELLED')) {
    localTeam.status = 'CANCELLED';
  }

  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_tournament_player_memberships');
      const query = tournamentId ? { tournamentId, teamId } : { teamId };
      await col.deleteMany(query);
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error releasing player memberships for team ${teamId}:`, err.message);
      return false;
    }
  }
  return true;
}

/**
 * Queries all active player memberships for a tournament.
 * Also reconciles from existing enrolled teams in that tournament so legacy/seeded teams are respected.
 *
 * @param {string} tournamentId
 * @returns {Promise<Array<object>>}
 */
export async function getTournamentPlayerMemberships(tournamentId) {
  if (!tournamentId) return [];

  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_tournament_player_memberships');
      const docs = await col.find({ tournamentId, status: 'ACTIVE' }).toArray();
      for (const d of docs) {
        localPlayerMemberships.set(`${d.tournamentId}:${d.discordUserId}`, d);
      }
      return docs;
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error reading player memberships for tournament ${tournamentId}:`, err.message);
    }
  }

  // Ensure any in-memory teams for this tournament have their memberships populated
  for (const team of localTeams.values()) {
    if (team.tournamentId === tournamentId && !['CANCELLED', 'DELETED'].includes(team.status) && team.isDeleted !== true) {
      const { memberships } = extractTeamDiscordMemberships(team);
      for (const m of memberships) {
        const key = `${m.tournamentId}:${m.discordUserId}`;
        if (!localPlayerMemberships.has(key)) {
          localPlayerMemberships.set(key, m);
        }
      }
    }
  }

  return Array.from(localPlayerMemberships.values()).filter(
    (m) => m.tournamentId === tournamentId && m.status === 'ACTIVE'
  );
}

/**
 * Checks whether any of the candidate Discord user IDs are already assigned to another squad in the same tournament.
 *
 * @param {string} tournamentId
 * @param {string[]} discordUserIds
 * @param {string|null} [excludeTeamId] Team ID allowed to retain its own members (during Edit Squad)
 * @returns {Promise<{ ok: boolean, conflicts: Array<{ discordUserId: string, teamId: string, teamName?: string, role: string }>, message?: string }>}
 */
export async function checkTournamentPlayerExclusivity(tournamentId, discordUserIds = [], excludeTeamId = null) {
  if (!tournamentId) {
    return { ok: false, conflicts: [], message: '❌ Tournament ID is required.' };
  }

  const seen = new Set();
  for (const rawId of discordUserIds) {
    if (!rawId) continue;
    const uid = String(rawId).trim();
    if (!uid) continue;
    if (seen.has(uid)) {
      return {
        ok: false,
        code: 'DUPLICATE_SELECTION',
        conflicts: [{ discordUserId: uid, teamId: excludeTeamId || null, role: 'DUPLICATE' }],
        message: '❌ Duplicate member selections are not allowed. All selected accounts must be distinct.',
      };
    }
    seen.add(uid);
  }

  const existingMemberships = await getTournamentPlayerMemberships(tournamentId);
  const membershipByUser = new Map();

  // Also check enrolled teams in the tournament directly as a secondary safeguard
  const rawTeamsInTournament = await getConfigurableTeamsForTournament(tournamentId);
  const teamsInTournament = rawTeamsInTournament.filter(
    (t) => !['CANCELLED', 'DELETED'].includes(t.status) && t.isDeleted !== true
  );
  const activeTeamIds = new Set(teamsInTournament.map((t) => t.teamId));

  for (const m of existingMemberships) {
    if (m.status !== 'ACTIVE') continue;

    // Verify that the team this membership belongs to is still active in the tournament
    if (!activeTeamIds.has(m.teamId)) {
      const teamDoc = localTeams.get(m.teamId) || (await getConfigurableTeam(m.teamId));
      if (teamDoc) {
        if (['CANCELLED', 'DELETED'].includes(teamDoc.status) || teamDoc.isDeleted === true) {
          releaseTeamPlayerMemberships(tournamentId, m.teamId).catch(() => {});
          continue;
        }
      } else {
        // Check if it belongs to an active verified registration
        let isActiveVerified = false;
        let verifiedTeamName = null;
        const currentSettings = (typeof externalGuildSettingsGetter === 'function' ? externalGuildSettingsGetter() : null) || {};
        for (const g of Object.values(currentSettings || {})) {
          const reg = g.tournaments?.[tournamentId]?.verifiedRegistrations?.[m.teamId];
          if (reg && reg.status !== 'CANCELLED' && reg.status !== 'DELETED') {
            isActiveVerified = true;
            verifiedTeamName = reg.teamName || null;
            break;
          }
        }
        if (!isActiveVerified && isMongoConnected()) {
          try {
            const db = getMongoDb();
            const tourDoc = await db?.collection('discord_tournaments').findOne({
              tournamentId,
              [`verifiedRegistrations.${m.teamId}`]: { $exists: true },
            });
            const reg = tourDoc?.verifiedRegistrations?.[m.teamId];
            if (reg && reg.status !== 'CANCELLED' && reg.status !== 'DELETED') {
              isActiveVerified = true;
              verifiedTeamName = reg.teamName || null;
            }
          } catch {}
        }
        if (!isActiveVerified) {
          // Stale membership from a removed/cancelled team: release it and do not block user
          releaseTeamPlayerMemberships(tournamentId, m.teamId).catch(() => {});
          continue;
        }
        if (!m.teamName && verifiedTeamName) {
          m.teamName = verifiedTeamName;
        }
      }
    }

    membershipByUser.set(m.discordUserId, m);
  }

  for (const team of teamsInTournament) {
    const { memberships } = extractTeamDiscordMemberships(team);
    for (const m of memberships) {
      if (!membershipByUser.has(m.discordUserId)) {
        membershipByUser.set(m.discordUserId, { ...m, teamName: team.teamName });
      }
    }
  }

  const conflicts = [];
  for (const uid of seen) {
    const existing = membershipByUser.get(uid);
    if (existing && (!excludeTeamId || existing.teamId !== excludeTeamId)) {
      const conflictingTeam = teamsInTournament.find((t) => t.teamId === existing.teamId);
      conflicts.push({
        discordUserId: uid,
        teamId: existing.teamId,
        teamName: conflictingTeam?.teamName || existing.teamName || null,
        role: existing.role,
      });
    }
  }

  if (conflicts.length > 0) {
    return {
      ok: false,
      code: 'PLAYER_ALREADY_ASSIGNED',
      conflicts,
      message: 'One or more selected members are already assigned to another squad in this tournament.',
    };
  }

  return { ok: true, conflicts: [] };
}

/**
 * Atomically validates player exclusivity (main players + substitutes) and saves the team and its memberships.
 * Prevents concurrent enrollment conflicts using an atomic tournament lock, unique membership constraints,
 * and MongoDB transactions where supported.
 * During Edit Squad (`isEdit: true`), existing assignments are NEVER released before replacements are validated.
 *
 * @param {object} teamDoc
 * @param {{ isEdit?: boolean }} [options]
 * @returns {Promise<{ ok: boolean, code?: string, message?: string, team?: object, conflicts?: Array<object> }>}
 */
export async function saveConfigurableTeamWithExclusivity(teamDoc, options = {}) {
  if (!teamDoc || !teamDoc.tournamentId) {
    return { ok: false, code: 'INVALID_TEAM', message: '❌ Invalid team data.' };
  }

  const tournamentId = teamDoc.tournamentId;
  const teamId = teamDoc.teamId || crypto.randomUUID();
  const isEdit = Boolean(options.isEdit);
  const candidateDoc = { ...teamDoc, teamId };

  return await withAtomicMutex(`lock:tour_player_excl:${tournamentId}`, async () => {
    // 1. Validate no duplicate player/substitute within the same submission
    const { memberships, hasDuplicateWithinTeam } = extractTeamDiscordMemberships(candidateDoc);
    if (hasDuplicateWithinTeam) {
      return {
        ok: false,
        code: 'DUPLICATE_SELECTION',
        message: '❌ Duplicate member selections are not allowed. All selected accounts must be distinct.',
      };
    }

    // 2. Check team name uniqueness within the atomic lock
    const existingByName = await getConfigurableTeamByName(tournamentId, candidateDoc.teamName);
    if (existingByName && (!isEdit || existingByName.teamId !== teamId)) {
      return {
        ok: false,
        code: 'DUPLICATE_TEAM_NAME',
        message: `❌ A squad named **${candidateDoc.teamName}** has already been registered.`,
      };
    }

    // 3. Check player & substitute exclusivity across the tournament (excluding this teamId when editing)
    const allDiscordUserIds = memberships.map((m) => m.discordUserId);
    const exclCheck = await checkTournamentPlayerExclusivity(
      tournamentId,
      allDiscordUserIds,
      isEdit ? teamId : null
    );
    if (!exclCheck.ok) {
      return exclCheck;
    }

    // 4. Commit atomically (using MongoDB transaction if connected and supported, plus in-memory state)
    const now = new Date();
    const record = {
      ...candidateDoc,
      teamId,
      teamNameLower: (candidateDoc.teamName || '').trim().toLowerCase(),
      updatedAt: now,
      createdAt: candidateDoc.createdAt || now,
    };

    if (isMongoConnected()) {
      const db = getMongoDb();
      const teamCol = db.collection('discord_configurable_teams');
      const memCol = db.collection('discord_tournament_player_memberships');
      const newUserIds = memberships.map((m) => m.discordUserId);

      try {
        // Attempt transactional write if client supports sessions/transactions
        let committedViaTx = false;
        if (typeof db.client?.startSession === 'function') {
          const session = db.client.startSession();
          try {
            await session.withTransaction(async () => {
              // Verify no conflicting membership exists inside transaction
              if (newUserIds.length > 0) {
                const conflictInDb = await memCol.findOne(
                  {
                    tournamentId,
                    discordUserId: { $in: newUserIds },
                    ...(isEdit ? { teamId: { $ne: teamId } } : {}),
                  },
                  { session }
                );
                if (conflictInDb) {
                  const conflictingTeam = await teamCol.findOne({ teamId: conflictInDb.teamId }, { session });
                  if (!conflictingTeam || ['CANCELLED', 'DELETED'].includes(conflictingTeam.status) || conflictingTeam.isDeleted === true) {
                    // Stale membership from cancelled or deleted team: clean it up and proceed
                    await memCol.deleteMany({ tournamentId, teamId: conflictInDb.teamId }, { session });
                    await releaseTeamPlayerMemberships(tournamentId, conflictInDb.teamId);
                  } else {
                    const conflictErr = new Error('One or more selected members are already assigned to another squad in this tournament.');
                    conflictErr.code = 'PLAYER_ALREADY_ASSIGNED';
                    throw conflictErr;
                  }
                }
              }

              // Upsert new/kept player memberships first
              for (const m of memberships) {
                await memCol.updateOne(
                  { tournamentId: m.tournamentId, discordUserId: m.discordUserId },
                  {
                    $set: {
                      tournamentId: m.tournamentId,
                      discordUserId: m.discordUserId,
                      teamId: m.teamId,
                      role: m.role,
                      status: 'ACTIVE',
                      updatedAt: now,
                    },
                    $setOnInsert: { assignedAt: now },
                  },
                  { upsert: true, session }
                );
              }

              // Release any old memberships for this team that were replaced during Edit Squad
              if (isEdit) {
                await memCol.deleteMany(
                  {
                    tournamentId,
                    teamId,
                    discordUserId: { $nin: newUserIds },
                  },
                  { session }
                );
              }

              // Save the team document
              await teamCol.updateOne(
                { teamId },
                { $set: record },
                { upsert: true, session }
              );
            });
            committedViaTx = true;
          } catch (txErr) {
            if (txErr?.code === 'PLAYER_ALREADY_ASSIGNED' || txErr?.code === 11000) {
              throw txErr;
            }
            // Fallback to non-transactional atomic operations if standalone Mongo doesn't support transactions
          } finally {
            await session.endSession().catch(() => {});
          }
        }

        if (!committedViaTx) {
          // Check and remove any stale memberships from cancelled/deleted teams before writing
          if (newUserIds.length > 0) {
            try {
              const staleMemberships = await memCol.find({
                tournamentId,
                discordUserId: { $in: newUserIds },
                ...(isEdit ? { teamId: { $ne: teamId } } : {}),
              }).toArray();
              for (const sm of staleMemberships) {
                const smTeam = await teamCol.findOne({ teamId: sm.teamId });
                if (!smTeam || ['CANCELLED', 'DELETED'].includes(smTeam.status) || smTeam.isDeleted === true) {
                  await memCol.deleteMany({ tournamentId, teamId: sm.teamId });
                  await releaseTeamPlayerMemberships(tournamentId, sm.teamId);
                }
              }
            } catch (staleErr) {
              console.warn('[ConfigurableTournament] ⚠️ Stale membership cleanup warning:', staleErr.message);
            }
          }

          // Non-replica-set fallback using unique index enforcement on discord_tournament_player_memberships
          const insertedThisAttempt = [];
          try {
            for (const m of memberships) {
              const filter = isEdit
                ? { tournamentId: m.tournamentId, discordUserId: m.discordUserId, teamId: { $in: [m.teamId] } }
                : { tournamentId: m.tournamentId, discordUserId: m.discordUserId, teamId: m.teamId };
              await memCol.updateOne(
                filter,
                {
                  $set: {
                    tournamentId: m.tournamentId,
                    discordUserId: m.discordUserId,
                    teamId: m.teamId,
                    role: m.role,
                    status: 'ACTIVE',
                    updatedAt: now,
                  },
                  $setOnInsert: { assignedAt: now },
                },
                { upsert: true }
              );
              insertedThisAttempt.push(m.discordUserId);
            }
          } catch (writeErr) {
            if (!isEdit && insertedThisAttempt.length > 0) {
              await memCol.deleteMany({ tournamentId, teamId, discordUserId: { $in: insertedThisAttempt } }).catch(() => {});
            }
            throw writeErr;
          }

          if (isEdit) {
            await memCol.deleteMany({
              tournamentId,
              teamId,
              discordUserId: { $nin: newUserIds },
            });
          }

          await teamCol.updateOne({ teamId }, { $set: record }, { upsert: true });
        }
      } catch (err) {
        if (err?.code === 'PLAYER_ALREADY_ASSIGNED' || err?.code === 11000) {
          return {
            ok: false,
            code: 'PLAYER_ALREADY_ASSIGNED',
            message: 'One or more selected members are already assigned to another squad in this tournament.',
          };
        }
        console.error(`[ConfigurableTournament] ❌ Database error committing team ${teamId}:`, err.message);
        return {
          ok: false,
          code: 'DB_ERROR',
          message: `❌ Database error while saving squad: ${err.message}`,
        };
      }
    }

    // Update in-memory stores atomically (releasing old replaced members only after validation succeeded)
    const newUserIdSet = new Set(memberships.map((m) => m.discordUserId));
    if (isEdit) {
      for (const [key, mem] of Array.from(localPlayerMemberships.entries())) {
        if (mem.tournamentId === tournamentId && mem.teamId === teamId && !newUserIdSet.has(mem.discordUserId)) {
          localPlayerMemberships.delete(key);
        }
      }
    }
    for (const m of memberships) {
      const key = `${m.tournamentId}:${m.discordUserId}`;
      const prev = localPlayerMemberships.get(key);
      localPlayerMemberships.set(key, {
        ...m,
        assignedAt: prev?.teamId === m.teamId ? (prev.assignedAt || now) : now,
        updatedAt: now,
      });
    }
    localTeams.set(teamId, { ...record });

    return { ok: true, team: record, memberships };
  });
}

export async function getConfigurableTeam(teamId) {
  if (!teamId) return null;
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_teams');
      const doc = await col.findOne({ teamId });
      if (doc) {
        localTeams.set(teamId, doc);
        return doc;
      }
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error reading team ${teamId}:`, err.message);
    }
  }
  return localTeams.get(teamId) || null;
}

export async function getConfigurableTeamByName(tournamentId, teamName) {
  if (!tournamentId || !teamName) return null;
  const lower = teamName.trim().toLowerCase();

  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_teams');
      const doc = await col.findOne({
        tournamentId,
        teamNameLower: lower,
        status: { $nin: ['CANCELLED', 'DELETED'] },
        isDeleted: { $ne: true },
      });
      if (doc) {
        localTeams.set(doc.teamId, doc);
        return doc;
      }
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error reading team by name ${teamName}:`, err.message);
    }
  }

  for (const team of localTeams.values()) {
    if (
      team.tournamentId === tournamentId &&
      team.teamNameLower === lower &&
      !['CANCELLED', 'DELETED'].includes(team.status) &&
      team.isDeleted !== true
    ) {
      return team;
    }
  }
  return null;
}

export async function getConfigurableTeamsForUser(tournamentId, discordId) {
  if (!tournamentId || !discordId) return [];
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_teams');
      const docs = await col
        .find({
          tournamentId,
          status: { $nin: ['CANCELLED', 'DELETED'] },
          isDeleted: { $ne: true },
          $or: [
            { leaderDiscordId: discordId },
            { 'players.discordId': discordId },
            { 'substitutes.discordId': discordId },
            { 'substitutes.discordUserId': discordId },
          ],
        })
        .toArray();
      for (const d of docs) {
        localTeams.set(d.teamId, d);
      }
      return docs;
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error finding teams for user ${discordId}:`, err.message);
    }
  }

  return Array.from(localTeams.values()).filter(
    (t) =>
      t.tournamentId === tournamentId &&
      !['CANCELLED', 'DELETED'].includes(t.status) &&
      t.isDeleted !== true &&
      (t.leaderDiscordId === discordId ||
        (t.players && t.players.some((p) => p.discordId === discordId || p.discordUserId === discordId)) ||
        (t.substitutes && t.substitutes.some((s) => s.discordId === discordId || s.discordUserId === discordId)))
  );
}

export async function getConfigurableTeamsForTournament(tournamentId) {
  if (!tournamentId) return [];
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_teams');
      const docs = await col.find({
        tournamentId,
        status: { $nin: ['CANCELLED', 'DELETED'] },
        isDeleted: { $ne: true },
      }).toArray();
      for (const d of docs) {
        localTeams.set(d.teamId, d);
      }
      return docs;
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error listing teams for tournament ${tournamentId}:`, err.message);
    }
  }

  return Array.from(localTeams.values()).filter(
    (t) => t.tournamentId === tournamentId && !['CANCELLED', 'DELETED'].includes(t.status) && t.isDeleted !== true
  );
}

export async function getEnrolledTeamsCount(tournamentId) {
  if (!tournamentId) return 0;
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_teams');
      return await col.countDocuments({
        tournamentId,
        status: { $nin: ['CANCELLED', 'DELETED'] },
        isDeleted: { $ne: true },
      });
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error counting teams:`, err.message);
    }
  }
  return Array.from(localTeams.values()).filter(
    (t) => t.tournamentId === tournamentId && !['CANCELLED', 'DELETED'].includes(t.status) && t.isDeleted !== true
  ).length;
}

export async function deleteTournamentRegistrationComplete({
  tournamentId,
  teamId,
  registrationId = null,
  teamName = null,
  reason = 'Registration deleted by tournament administrator.',
  actorId = null,
  actorTag = null,
  guildId = null,
  savedTournament = null,
  purgeRegistration = false,
} = {}) {
  if (!tournamentId || (!teamId && !registrationId)) {
    throw new Error('deleteTournamentRegistrationComplete requires tournamentId and either teamId or registrationId.');
  }

  const primaryTeamId = String(teamId || registrationId);
  const altRegId = registrationId ? String(registrationId) : null;
  const targetIds = Array.from(new Set([primaryTeamId, altRegId].filter(Boolean)));

  // 1. Gather all member Discord IDs associated with this team before deletion
  const freedDiscordIds = new Set();
  let resolvedTeamName = teamName || '';

  // Check in-memory localTeams
  for (const tid of targetIds) {
    const t = localTeams.get(tid);
    if (t) {
      if (t.teamName && !resolvedTeamName) resolvedTeamName = t.teamName;
      if (t.leaderDiscordId) freedDiscordIds.add(String(t.leaderDiscordId));
      if (Array.isArray(t.players)) {
        for (const p of t.players) {
          const pid = p.discordId || p.discordUserId || p.id;
          if (pid) freedDiscordIds.add(String(pid));
        }
      }
      if (Array.isArray(t.substitutes)) {
        for (const s of t.substitutes) {
          const sid = s.discordId || s.discordUserId || s.id;
          if (sid) freedDiscordIds.add(String(sid));
        }
      }
    }
  }

  // Check savedTournament / cached guildSettings
  const currentSettings = typeof externalGuildSettingsGetter === 'function' ? externalGuildSettingsGetter() : null;
  const tour = savedTournament || (guildId && currentSettings ? currentSettings[guildId]?.tournaments?.[tournamentId] : null);
  if (tour?.verifiedRegistrations) {
    for (const tid of targetIds) {
      const v = tour.verifiedRegistrations[tid];
      if (v) {
        if (v.teamName && !resolvedTeamName) resolvedTeamName = v.teamName;
        if (v.discordId) freedDiscordIds.add(String(v.discordId));
        if (Array.isArray(v.discordMemberIds)) {
          for (const mid of v.discordMemberIds) freedDiscordIds.add(String(mid));
        }
      }
    }
  }

  // Check localPlayerMemberships
  for (const [key, mem] of localPlayerMemberships.entries()) {
    if (mem.tournamentId === tournamentId && targetIds.includes(String(mem.teamId))) {
      if (mem.discordUserId) freedDiscordIds.add(String(mem.discordUserId));
      localPlayerMemberships.delete(key);
    }
  }

  // 2. In-Memory cleanup across local stores
  for (const tid of targetIds) {
    localTeams.delete(tid);
  }

  for (const [key, entry] of Array.from(localEntries.entries())) {
    if (entry.tournamentId === tournamentId && targetIds.includes(String(entry.teamId || entry.registrationId))) {
      localEntries.delete(key);
    }
  }

  for (const [, slot] of localSlots.entries()) {
    if (slot.tournamentId === tournamentId && targetIds.includes(String(slot.teamId || slot.registrationId))) {
      slot.status = 'OPEN';
      slot.teamId = null;
      slot.teamName = null;
    }
  }

  // Invalidate or remove from localPendingVerifications
  for (const [pid, session] of localPendingVerifications.entries()) {
    if (
      session.tournamentId === tournamentId &&
      (targetIds.includes(String(session.registrationId)) || (resolvedTeamName && session.teamName === resolvedTeamName))
    ) {
      localPendingVerifications.delete(pid);
    }
  }

  // Remove verified registration from savedTournament (or mark CANCELLED) and free group/round slots
  if (tour) {
    if (tour.verifiedRegistrations) {
      for (const tid of targetIds) {
        if (purgeRegistration) {
          delete tour.verifiedRegistrations[tid];
        } else {
          const prev = tour.verifiedRegistrations[tid] || {};
          tour.verifiedRegistrations[tid] = {
            ...prev,
            registrationId: tid,
            teamId: tid,
            teamName: resolvedTeamName || prev.teamName || 'Cancelled Team',
            status: 'CANCELLED',
            cancellationReason: reason,
            cancelledBy: actorTag || actorId || 'Admin',
            cancelledAt: new Date().toISOString(),
          };
        }
      }
    }
    if (tour.pendingTeamCancellations) {
      for (const tid of targetIds) {
        delete tour.pendingTeamCancellations[tid];
      }
    }
    if (tour.rounds) {
      for (const round of Object.values(tour.rounds)) {
        if (!round || !Array.isArray(round.groups)) continue;
        for (const group of round.groups) {
          if (!group || !Array.isArray(group.slots)) continue;
          for (const slot of group.slots) {
            if (
              targetIds.includes(String(slot.teamId)) ||
              (resolvedTeamName && slot.teamName && slot.teamName.toLowerCase() === resolvedTeamName.toLowerCase())
            ) {
              slot.status = 'AVAILABLE';
              delete slot.teamId;
              delete slot.teamName;
              delete slot.leaderId;
              delete slot.memberIds;
            }
          }
          if (Array.isArray(group.qualifiedTeams)) {
            group.qualifiedTeams = group.qualifiedTeams.filter(
              (qt) => !targetIds.includes(String(qt.teamId)) && (!resolvedTeamName || qt.teamName !== resolvedTeamName)
            );
          }
        }
      }
    }
  }

  // 3. MongoDB Deletions across all tournament collections
  if (isMongoConnected()) {
    const db = getMongoDb();
    const client = getMongoClient();
    let session = null;
    let useTransaction = false;

    if (typeof client?.startSession === 'function') {
      try {
        session = client.startSession();
        session.startTransaction();
        useTransaction = true;
      } catch {
        session = null;
        useTransaction = false;
      }
    }

    const sessionOpts = useTransaction ? { session } : {};

    try {
      const idFilter = {
        tournamentId,
        $or: [
          { teamId: { $in: targetIds } },
          { registrationId: { $in: targetIds } },
        ],
      };

      // 3.1. Delete team record from discord_configurable_teams
      await db.collection('discord_configurable_teams').deleteMany(idFilter, sessionOpts);

      // 3.2. Delete entry records from discord_configurable_entries
      await db.collection('discord_configurable_entries').deleteMany(idFilter, sessionOpts);

      // 3.3. Free slots in discord_configurable_slots
      await db.collection('discord_configurable_slots').updateMany(
        idFilter,
        {
          $set: { status: 'OPEN', teamId: null, teamName: null, updatedAt: new Date() },
        },
        sessionOpts
      );

      // 3.4. Delete all tournament player memberships for this team
      await db.collection('discord_tournament_player_memberships').deleteMany(
        idFilter,
        sessionOpts
      );

      // 3.5. Delete / invalidate pending verification sessions
      const pendingFilter = {
        tournamentId,
        $or: [
          { registrationId: { $in: targetIds } },
          ...(resolvedTeamName ? [{ teamName: resolvedTeamName }] : []),
        ],
      };
      await db.collection('pending_tournament_verifications').deleteMany(pendingFilter, sessionOpts);

      // 3.6. Update discord_tournaments to unset or mark cancelled
      const tourQuery = guildId ? { guildId, tournamentId } : { tournamentId };
      if (purgeRegistration) {
        const unsetFields = {};
        for (const tid of targetIds) {
          unsetFields[`verifiedRegistrations.${tid}`] = '';
          unsetFields[`pendingTeamCancellations.${tid}`] = '';
        }
        await db.collection('discord_tournaments').updateMany(tourQuery, { $unset: unsetFields }, sessionOpts);
      } else {
        const setFields = {};
        const unsetFields = {};
        for (const tid of targetIds) {
          setFields[`verifiedRegistrations.${tid}.status`] = 'CANCELLED';
          setFields[`verifiedRegistrations.${tid}.cancellationReason`] = reason;
          setFields[`verifiedRegistrations.${tid}.cancelledBy`] = actorTag || actorId || 'Admin';
          setFields[`verifiedRegistrations.${tid}.cancelledAt`] = new Date().toISOString();
          unsetFields[`pendingTeamCancellations.${tid}`] = '';
        }
        await db.collection('discord_tournaments').updateMany(tourQuery, { $set: setFields, $unset: unsetFields }, sessionOpts);
      }

      if (useTransaction) {
        await session.commitTransaction();
      }
    } catch (dbErr) {
      if (useTransaction) {
        await session.abortTransaction().catch(() => {});
      }
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error during complete registration cleanup:`, dbErr.message);
      // Fallback sequential execution if transaction failed
      try {
        await db.collection('discord_configurable_teams').deleteMany({ tournamentId, $or: [{ teamId: { $in: targetIds } }, { registrationId: { $in: targetIds } }] });
        await db.collection('discord_configurable_entries').deleteMany({ tournamentId, $or: [{ teamId: { $in: targetIds } }, { registrationId: { $in: targetIds } }] });
        await db.collection('discord_configurable_slots').updateMany({ tournamentId, $or: [{ teamId: { $in: targetIds } }, { registrationId: { $in: targetIds } }] }, { $set: { status: 'OPEN', teamId: null, teamName: null, updatedAt: new Date() } });
        await db.collection('discord_tournament_player_memberships').deleteMany({ tournamentId, $or: [{ teamId: { $in: targetIds } }, { registrationId: { $in: targetIds } }] });
        await db.collection('pending_tournament_verifications').deleteMany({ tournamentId, $or: [{ registrationId: { $in: targetIds } }, ...(resolvedTeamName ? [{ teamName: resolvedTeamName }] : [])] });
      } catch (fallbackErr) {
        console.warn(`[ConfigurableTournament] ⚠️ Fallback cleanup error:`, fallbackErr.message);
      }
    } finally {
      if (session) {
        await session.endSession().catch(() => {});
      }
    }
  }

  // 4. Record audit log
  await recordConfigurableAuditLog({
    action: 'REGISTRATION_DELETED_COMPLETE',
    tournamentId,
    guildId,
    teamId: primaryTeamId,
    teamName: resolvedTeamName,
    actorId: actorId || 'system',
    actorTag: actorTag || 'Admin',
    reason,
    freedCount: freedDiscordIds.size,
    timestamp: new Date(),
  }).catch(() => {});

  return {
    success: true,
    tournamentId,
    targetIds,
    teamName: resolvedTeamName,
    freedDiscordIds: Array.from(freedDiscordIds),
  };
}

export async function deleteConfigurableTeam(teamId) {
  if (!teamId) return false;
  const existingTeam = localTeams.get(teamId) || (await getConfigurableTeam(teamId));
  const tournamentId = existingTeam?.tournamentId || null;
  const registrationId = existingTeam?.registrationId ? String(existingTeam.registrationId) : null;

  if (tournamentId) {
    await deleteTournamentRegistrationComplete({
      tournamentId,
      teamId,
      registrationId,
      teamName: existingTeam?.teamName || null,
      actorId: existingTeam?.leaderDiscordId || null,
      guildId: existingTeam?.guildId || null,
    });
    return true;
  }

  localTeams.delete(teamId);

  // Release all player & substitute memberships for this team
  await releaseTeamPlayerMemberships(null, teamId);
  if (registrationId && String(registrationId) !== String(teamId)) {
    await releaseTeamPlayerMemberships(null, String(registrationId));
  }

  // Remove entries belonging to this team and release their slot states
  for (const [key, entry] of Array.from(localEntries.entries())) {
    if (entry.teamId === teamId) {
      localEntries.delete(key);
    }
  }

  if (isMongoConnected()) {
    try {
      const teamCol = getMongoDb().collection('discord_configurable_teams');
      await teamCol.deleteOne({ teamId });

      const entryCol = getMongoDb().collection('discord_configurable_entries');
      await entryCol.deleteMany({ teamId });

      await cancelPendingTournamentVerificationsByTeam(null, teamId, existingTeam?.teamName);
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error deleting team ${teamId}:`, err.message);
      return false;
    }
  }

  if (existingTeam) {
    await recordConfigurableAuditLog({
      action: 'SQUAD_DELETED',
      tournamentId: existingTeam.tournamentId,
      guildId: existingTeam.guildId,
      teamId: existingTeam.teamId,
      teamName: existingTeam.teamName,
      actorId: existingTeam.leaderDiscordId,
      timestamp: new Date(),
    }).catch(() => {});
  }

  return true;
}

/**
 * Records an audit log entry in MongoDB (`discord_audit_logs`) and in-memory (`localAuditLogs`).
 *
 * @param {object} auditDoc
 * @returns {Promise<object>}
 */
export async function recordConfigurableAuditLog(auditDoc) {
  const record = {
    auditId: crypto.randomUUID(),
    timestamp: new Date(),
    ...auditDoc,
  };
  localAuditLogs.push(record);

  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_audit_logs');
      await col.insertOne({ ...record });
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error writing audit log:`, err.message);
    }
  }
  return record;
}

/**
 * Retrieves recorded audit logs matching optional filter criteria.
 *
 * @param {{ tournamentId?: string, registrationId?: string, teamId?: string, action?: string }} [filter]
 * @returns {Promise<Array<object>>}
 */
export async function getConfigurableAuditLogs(filter = {}) {
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_audit_logs');
      const query = {};
      if (filter.tournamentId) query.tournamentId = filter.tournamentId;
      if (filter.registrationId) query.registrationId = filter.registrationId;
      if (filter.teamId) query.teamId = filter.teamId;
      if (filter.action) query.action = filter.action;
      return await col.find(query).sort({ timestamp: -1 }).toArray();
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error reading audit logs:`, err.message);
    }
  }

  return localAuditLogs.filter((log) => {
    if (filter.tournamentId && log.tournamentId !== filter.tournamentId) return false;
    if (filter.registrationId && log.registrationId !== filter.registrationId) return false;
    if (filter.teamId && log.teamId !== filter.teamId) return false;
    if (filter.action && log.action !== filter.action) return false;
    return true;
  });
}

/**
 * Marks a team's registration entry as REMOVED for a specific registration and cycle,
 * releasing its allocated slot without deleting the team's tournament enrollment or freeing player memberships.
 *
 * @param {string} registrationId
 * @param {string} teamId
 * @param {string|null} [cycleId]
 * @param {string|null} [removedBy]
 * @param {object} [extra]
 * @returns {Promise<{ ok: boolean, entry?: object, releasedSlot?: number, message?: string }>}
 */
export async function markConfigurableEntryRemoved(
  registrationId,
  teamId,
  cycleId = null,
  removedBy = null,
  extra = {}
) {
  if (!registrationId || !teamId) {
    return { ok: false, message: 'Registration ID and Team ID are required.' };
  }

  const entry = await getConfigurableEntry(registrationId, teamId, cycleId);
  if (!entry) {
    return { ok: false, code: 'ENTRY_NOT_FOUND', message: 'Team is not currently registered in this registration cycle.' };
  }

  const now = new Date();
  const resolvedCycleId = entry.cycleId || cycleId || 'default';
  const releasedSlot = Number(entry.slotNumber);

  const updatedEntry = {
    ...entry,
    status: 'REMOVED',
    removedAt: now,
    removedBy: removedBy || null,
    updatedAt: now,
    ...extra,
  };

  // Update in-memory entry to REMOVED (preserving history while making it inactive)
  for (const [key, item] of Array.from(localEntries.entries())) {
    if (
      item.registrationId === registrationId &&
      item.teamId === teamId &&
      (!cycleId || item.cycleId === resolvedCycleId || item.cycleId === 'default') &&
      ACTIVE_ENTRY_STATUSES.includes(item.status)
    ) {
      localEntries.set(key, { ...updatedEntry });
    }
  }
  localEntries.set(`${registrationId}:${resolvedCycleId}:${teamId}`, { ...updatedEntry });

  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_entries');
      const query = {
        registrationId,
        teamId,
        status: { $in: ACTIVE_ENTRY_STATUSES },
      };
      if (cycleId) {
        query.cycleId = { $in: [cycleId, 'default'] };
      }
      await col.updateMany(query, {
        $set: {
          status: 'REMOVED',
          removedAt: now,
          removedBy: removedBy || null,
          updatedAt: now,
          ...extra,
        },
      });
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error marking entry removed:`, err.message);
      return { ok: false, code: 'DB_ERROR', message: `Database error removing registration entry: ${err.message}` };
    }
  }

  // Release the allocated slot state to AVAILABLE (unless locked)
  const reg = localRegistrations.get(registrationId) || (await getConfigurableRegistration(registrationId));
  const lockedSet = new Set(reg ? getLockedSlotNumbers(reg, reg.totalSlots) : []);
  if (Number.isInteger(releasedSlot) && releasedSlot >= 1) {
    const isLocked = lockedSet.has(releasedSlot);
    const meta = reg?.lockedSlotsMeta?.[releasedSlot] || {};
    await saveRegistrationSlotState({
      registrationId,
      cycleId: resolvedCycleId,
      slotNumber: releasedSlot,
      status: isLocked ? 'LOCKED' : 'AVAILABLE',
      teamId: null,
      teamName: null,
      lockedBy: isLocked ? (meta.lockedBy || null) : null,
      lockedAt: isLocked ? (meta.lockedAt || null) : null,
    }).catch(() => {});
  }

  return { ok: true, entry: updatedEntry, releasedSlot };
}

// ----------------------------------------------------
// REGISTRATION ENTRIES CRUD (Slots)
// ----------------------------------------------------

export async function saveConfigurableEntry(doc) {
  if (!doc) return null;
  const now = new Date();
  const { _id, ...cleanDoc } = doc;
  const entryId = cleanDoc.entryId || crypto.randomUUID();
  const parsedSlotNumber = typeof cleanDoc.slotNumber === 'number'
    ? cleanDoc.slotNumber
    : parseInt(cleanDoc.slotNumber, 10);
  const slotNumber = !isNaN(parsedSlotNumber) ? parsedSlotNumber : cleanDoc.slotNumber;
  const resolvedCycleId =
    cleanDoc.cycleId ||
    localRegistrations.get(cleanDoc.registrationId)?.currentCycleId ||
    'default';

  const record = {
    ...cleanDoc,
    entryId,
    slotNumber,
    cycleId: resolvedCycleId,
    status: cleanDoc.status || 'CONFIRMED',
    updatedAt: now,
    registeredAt: cleanDoc.registeredAt || now,
  };

  const cycleKey = `${record.registrationId}:${record.cycleId}:${record.teamId}`;
  localEntries.set(cycleKey, { ...record });

  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_entries');
      await col.updateOne(
        { registrationId: record.registrationId, cycleId: record.cycleId, teamId: record.teamId },
        { $set: record },
        { upsert: true }
      );
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error saving entry:`, err.message);
    }
  }

  if (Number.isInteger(Number(slotNumber)) && Number(slotNumber) >= 1) {
    if (['CONFIRMED', 'REGISTERED'].includes(record.status)) {
      await saveRegistrationSlotState({
        registrationId: record.registrationId,
        cycleId: resolvedCycleId,
        slotNumber: Number(slotNumber),
        status: 'OCCUPIED',
        teamId: record.teamId,
        teamName: record.teamName || null,
        lockedBy: null,
        lockedAt: null,
      }).catch(() => {});
    }
  }

  return record;
}

const ACTIVE_ENTRY_STATUSES = ['CONFIRMED', 'REGISTERED'];

export async function getConfigurableEntry(registrationId, teamId, cycleId = null) {
  if (!registrationId || !teamId) return null;
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_entries');
      const query = { registrationId, teamId, status: { $in: ACTIVE_ENTRY_STATUSES } };
      if (cycleId) {
        query.cycleId = { $in: [cycleId, 'default'] };
      }
      const doc = await col.findOne(query);
      if (doc) {
        doc.slotNumber = Number(doc.slotNumber);
        localEntries.set(`${registrationId}:${doc.cycleId || 'default'}:${teamId}`, doc);
        return doc;
      }
      return null;
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error reading entry:`, err.message);
    }
  }

  if (cycleId) {
    const cycleEntry = localEntries.get(`${registrationId}:${cycleId}:${teamId}`);
    if (cycleEntry && ACTIVE_ENTRY_STATUSES.includes(cycleEntry.status)) {
      return { ...cycleEntry, slotNumber: Number(cycleEntry.slotNumber) };
    }
    for (const entry of localEntries.values()) {
      if (
        entry.registrationId === registrationId &&
        entry.teamId === teamId &&
        (entry.cycleId === cycleId || entry.cycleId === 'default') &&
        ACTIVE_ENTRY_STATUSES.includes(entry.status)
      ) {
        return { ...entry, slotNumber: Number(entry.slotNumber) };
      }
    }
    return null;
  }
  for (const entry of localEntries.values()) {
    if (entry.registrationId === registrationId && entry.teamId === teamId && ACTIVE_ENTRY_STATUSES.includes(entry.status)) {
      return { ...entry, slotNumber: Number(entry.slotNumber) };
    }
  }
  return null;
}

export async function getConfigurableEntriesForRegistration(registrationId, cycleId = null) {
  if (!registrationId) return [];
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_entries');
      const query = { registrationId, status: { $in: ACTIVE_ENTRY_STATUSES } };
      if (cycleId) {
        query.cycleId = { $in: [cycleId, 'default'] };
      }
      const docs = await col
        .find(query)
        .sort({ slotNumber: 1 })
        .toArray();
      for (const d of docs) {
        d.slotNumber = Number(d.slotNumber);
        localEntries.set(`${d.registrationId}:${d.cycleId || 'default'}:${d.teamId}`, d);
      }
      return docs.sort((a, b) => Number(a.slotNumber) - Number(b.slotNumber));
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error listing entries for registration ${registrationId}:`, err.message);
    }
  }

  return Array.from(localEntries.values())
    .filter((e) => {
      if (e.registrationId !== registrationId || !ACTIVE_ENTRY_STATUSES.includes(e.status)) return false;
      if (cycleId && e.cycleId && e.cycleId !== 'default' && e.cycleId !== cycleId) return false;
      return true;
    })
    .map((e) => ({ ...e, slotNumber: Number(e.slotNumber) }))
    .sort((a, b) => Number(a.slotNumber) - Number(b.slotNumber));
}

export async function getConfigurableEntriesForTeam(teamId) {
  if (!teamId) return [];
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_entries');
      const docs = await col.find({ teamId, status: { $in: ACTIVE_ENTRY_STATUSES } }).toArray();
      for (const d of docs) {
        d.slotNumber = Number(d.slotNumber);
        localEntries.set(`${d.registrationId}:${d.cycleId || 'default'}:${d.teamId}`, d);
      }
      return docs;
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error listing entries for team ${teamId}:`, err.message);
    }
  }

  return Array.from(localEntries.values()).filter(
    (e) => e.teamId === teamId && ACTIVE_ENTRY_STATUSES.includes(e.status)
  );
}

export async function deleteConfigurableEntry(registrationId, teamId, cycleId = null) {
  if (!registrationId || !teamId) return false;
  const releasedSlots = [];
  for (const [key, entry] of Array.from(localEntries.entries())) {
    if (entry.registrationId === registrationId && entry.teamId === teamId) {
      if (!cycleId || entry.cycleId === cycleId || entry.cycleId === 'default') {
        if (Number.isInteger(Number(entry.slotNumber))) {
          releasedSlots.push({ slotNumber: Number(entry.slotNumber), cycleId: entry.cycleId || cycleId || 'default' });
        }
        localEntries.delete(key);
      }
    }
  }

  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_entries');
      const query = { registrationId, teamId };
      if (cycleId) {
        query.cycleId = { $in: [cycleId, 'default'] };
      }
      await col.deleteOne(query);
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error deleting entry:`, err.message);
      return false;
    }
  }

  const reg = localRegistrations.get(registrationId);
  const lockedSet = new Set(reg ? getLockedSlotNumbers(reg, reg.totalSlots) : []);
  for (const rel of releasedSlots) {
    const isLocked = lockedSet.has(rel.slotNumber);
    const meta = reg?.lockedSlotsMeta?.[rel.slotNumber] || {};
    await saveRegistrationSlotState({
      registrationId,
      cycleId: rel.cycleId,
      slotNumber: rel.slotNumber,
      status: isLocked ? 'LOCKED' : 'AVAILABLE',
      teamId: null,
      teamName: null,
      lockedBy: isLocked ? (meta.lockedBy || null) : null,
      lockedAt: isLocked ? (meta.lockedAt || null) : null,
    }).catch(() => {});
  }

  return true;
}

// ----------------------------------------------------
// INDIVIDUAL SLOT STATE CRUD & LOCK MANAGEMENT
// ----------------------------------------------------

/**
 * Persists a single slot state document for a registration and daily cycle.
 * Schema:
 * {
 *   registrationId,
 *   cycleId,
 *   slotNumber,
 *   status: "LOCKED" | "AVAILABLE" | "OCCUPIED",
 *   teamId: null | string,
 *   lockedBy: null | string,
 *   lockedAt: null | Date
 * }
 * @param {object} slotDoc
 * @returns {Promise<object|null>}
 */
export async function saveRegistrationSlotState(slotDoc) {
  if (!slotDoc || !slotDoc.registrationId || !Number.isInteger(Number(slotDoc.slotNumber))) {
    return null;
  }
  const now = new Date();
  const registrationId = slotDoc.registrationId;
  const cycleId = slotDoc.cycleId || localRegistrations.get(registrationId)?.currentCycleId || 'default';
  const slotNumber = Number(slotDoc.slotNumber);
  const status = ['LOCKED', 'AVAILABLE', 'OCCUPIED'].includes(slotDoc.status) ? slotDoc.status : 'AVAILABLE';

  const record = {
    registrationId,
    cycleId,
    slotNumber,
    status,
    teamId: status === 'OCCUPIED' ? (slotDoc.teamId || null) : null,
    teamName: status === 'OCCUPIED' ? (slotDoc.teamName || null) : null,
    lockedBy: status === 'LOCKED' ? (slotDoc.lockedBy || null) : null,
    lockedAt: status === 'LOCKED' ? (slotDoc.lockedAt || now) : null,
    updatedAt: now,
  };

  const slotKey = `${registrationId}:${cycleId}:${slotNumber}`;
  localSlots.set(slotKey, { ...record });

  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_slots');
      await col.updateOne(
        { registrationId, cycleId, slotNumber },
        { $set: record },
        { upsert: true }
      );
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error saving slot state ${slotKey}:`, err.message);
    }
  }

  return record;
}

/**
 * Synchronizes and persists all 1..totalSlots individual slot state documents for a registration and cycle.
 * Preserves locked slots from the registration configuration and occupied team allocations from active entries.
 *
 * @param {string} registrationId
 * @param {string} [cycleId]
 * @param {object} [preloadedReg]
 * @returns {Promise<Array<object>>}
 */
export async function syncRegistrationSlotStates(registrationId, cycleId = null, preloadedReg = null) {
  if (!registrationId) return [];
  const reg = preloadedReg || (await getConfigurableRegistration(registrationId));
  if (!reg) return [];

  const totalSlots = typeof reg.totalSlots === 'number' && reg.totalSlots > 0 ? reg.totalSlots : 20;
  const resolvedCycleId = cycleId || reg.currentCycleId || 'default';
  const lockedSet = new Set(getLockedSlotNumbers(reg, totalSlots));
  const lockedMeta = reg.lockedSlotsMeta || {};

  const entries = await getConfigurableEntriesForRegistration(registrationId, resolvedCycleId);
  const occupiedBySlot = new Map();
  for (const e of entries) {
    const sNum = Number(e.slotNumber);
    if (Number.isInteger(sNum) && sNum >= 1 && sNum <= totalSlots && !occupiedBySlot.has(sNum)) {
      occupiedBySlot.set(sNum, e);
    }
  }

  const now = new Date();
  const slotStates = [];
  const bulkOps = [];

  for (let slot = 1; slot <= totalSlots; slot++) {
    const slotKey = `${registrationId}:${resolvedCycleId}:${slot}`;
    const existingSlotDoc = localSlots.get(slotKey);
    const occupiedEntry = occupiedBySlot.get(slot);
    const isLocked = lockedSet.has(slot);

    let status = 'AVAILABLE';
    let teamId = null;
    let teamName = null;
    let lockedBy = null;
    let lockedAt = null;

    if (occupiedEntry && !isLocked) {
      status = 'OCCUPIED';
      teamId = occupiedEntry.teamId || null;
      teamName = occupiedEntry.teamName || null;
    } else if (isLocked) {
      status = 'LOCKED';
      const meta = lockedMeta[slot] || {};
      lockedBy = meta.lockedBy ?? existingSlotDoc?.lockedBy ?? null;
      lockedAt = meta.lockedAt ?? existingSlotDoc?.lockedAt ?? now;
    } else if (occupiedEntry) {
      // Safeguard: never silently drop an existing occupied team allocation
      status = 'OCCUPIED';
      teamId = occupiedEntry.teamId || null;
      teamName = occupiedEntry.teamName || null;
    }

    const record = {
      registrationId,
      cycleId: resolvedCycleId,
      slotNumber: slot,
      status,
      teamId,
      teamName,
      lockedBy,
      lockedAt,
      updatedAt: now,
    };

    localSlots.set(slotKey, record);
    slotStates.push(record);

    if (isMongoConnected()) {
      bulkOps.push({
        updateOne: {
          filter: { registrationId, cycleId: resolvedCycleId, slotNumber: slot },
          update: { $set: record },
          upsert: true,
        },
      });
    }
  }

  // Clean up any slot documents beyond totalSlots if capacity was reduced
  for (const [key, doc] of Array.from(localSlots.entries())) {
    if (doc.registrationId === registrationId && doc.cycleId === resolvedCycleId && doc.slotNumber > totalSlots) {
      localSlots.delete(key);
    }
  }

  if (isMongoConnected() && bulkOps.length > 0) {
    try {
      const col = getMongoDb().collection('discord_configurable_slots');
      await col.bulkWrite(bulkOps, { ordered: false });
      await col.deleteMany({
        registrationId,
        cycleId: resolvedCycleId,
        slotNumber: { $gt: totalSlots },
      });
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error syncing slot states for ${registrationId}:`, err.message);
    }
  }

  return slotStates;
}

/**
 * Retrieves the ordered array of individual slot states (1..totalSlots) for a registration and cycle.
 * @param {string} registrationId
 * @param {string} [cycleId]
 * @returns {Promise<Array<object>>}
 */
export async function getRegistrationSlotStates(registrationId, cycleId = null) {
  if (!registrationId) return [];
  const reg = await getConfigurableRegistration(registrationId);
  if (!reg) return [];

  const resolvedCycleId = cycleId || reg.currentCycleId || 'default';
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_slots');
      const docs = await col
        .find({ registrationId, cycleId: resolvedCycleId })
        .sort({ slotNumber: 1 })
        .toArray();
      for (const d of docs) {
        d.slotNumber = Number(d.slotNumber);
        localSlots.set(`${registrationId}:${resolvedCycleId}:${d.slotNumber}`, d);
      }
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error reading slot states for ${registrationId}:`, err.message);
    }
  }

  return syncRegistrationSlotStates(registrationId, resolvedCycleId, reg);
}

/**
 * Atomically locks one or more individual slots for a specific registration.
 * Enforces Occupied Slot Protection: refuses to lock any slot currently assigned to a team
 * unless the team is removed or reassigned first.
 *
 * @param {string} registrationId
 * @param {number|Array<number|string>} slotNumbersInput
 * @param {string} [lockedBy]
 * @param {string} [cycleId]
 * @returns {Promise<{
 *   ok: boolean,
 *   code?: string,
 *   message?: string,
 *   conflicts?: Array<{ slotNumber: number, teamId: string, teamName: string }>,
 *   lockedSlots?: number[],
 *   newlyLocked?: number[],
 *   slotStates?: Array<object>,
 *   registration?: object
 * }>}
 */
export async function lockRegistrationSlots(registrationId, slotNumbersInput, lockedBy = null, cycleId = null) {
  if (!registrationId) {
    return { ok: false, code: 'INVALID_REGISTRATION', message: '❌ Registration not found.' };
  }

  const lockKey = `lock:reg_confirm:${registrationId}`;
  await acquireLock(lockKey, 10, 3000);
  try {
    const reg = await getConfigurableRegistration(registrationId);
    if (!reg) {
      return { ok: false, code: 'INVALID_REGISTRATION', message: '❌ Registration instance not found.' };
    }

    const totalSlots = typeof reg.totalSlots === 'number' && reg.totalSlots > 0 ? reg.totalSlots : 20;
    const rawList = Array.isArray(slotNumbersInput) ? slotNumbersInput : [slotNumbersInput];
    const requestedSlots = [];
    for (const item of rawList) {
      const num = typeof item === 'number' ? Math.floor(item) : parseInt(String(item).trim(), 10);
      if (!Number.isInteger(num) || num < 1 || num > totalSlots) {
        return {
          ok: false,
          code: 'INVALID_SLOT_NUMBER',
          message: `❌ Invalid slot number "${item}". Slot numbers must be between 1 and ${totalSlots}.`,
        };
      }
      if (!requestedSlots.includes(num)) {
        requestedSlots.push(num);
      }
    }

    if (requestedSlots.length === 0) {
      return { ok: false, code: 'NO_SLOTS_SELECTED', message: '❌ Please select at least one slot to lock.' };
    }

    const resolvedCycleId = cycleId || reg.currentCycleId || 'default';
    const activeEntries = await getConfigurableEntriesForRegistration(registrationId, resolvedCycleId);
    const occupiedBySlot = new Map();
    for (const entry of activeEntries) {
      const sNum = Number(entry.slotNumber);
      if (Number.isInteger(sNum) && !occupiedBySlot.has(sNum)) {
        occupiedBySlot.set(sNum, entry);
      }
    }

    // Occupied Slot Protection: never lock a slot currently assigned to a team without handling the team first
    const conflicts = [];
    for (const slotNum of requestedSlots) {
      const occ = occupiedBySlot.get(slotNum);
      if (occ) {
        conflicts.push({
          slotNumber: slotNum,
          teamId: occ.teamId,
          teamName: occ.teamName || 'Assigned Team',
        });
      }
    }

    if (conflicts.length > 0) {
      const primaryConflict = conflicts[0];
      const msg =
        `This slot is currently assigned to ${primaryConflict.teamName}. Remove or reassign the team before locking this slot.`;
      return {
        ok: false,
        code: 'SLOT_OCCUPIED',
        message: msg,
        conflicts,
      };
    }

    const now = new Date();
    const existingLocked = new Set(getLockedSlotNumbers(reg, totalSlots));
    const newlyLocked = [];
    const lockedMeta = { ...(reg.lockedSlotsMeta || {}) };

    for (const slotNum of requestedSlots) {
      if (!existingLocked.has(slotNum)) {
        newlyLocked.push(slotNum);
      }
      existingLocked.add(slotNum);
      lockedMeta[slotNum] = {
        lockedBy: lockedBy || lockedMeta[slotNum]?.lockedBy || null,
        lockedAt: lockedMeta[slotNum]?.lockedAt || now,
      };
    }

    const updatedLockedSlots = Array.from(existingLocked).sort((a, b) => a - b);
    reg.lockedSlots = updatedLockedSlots;
    reg.reservedSlots = updatedLockedSlots.length;
    reg.lockedSlotsMeta = lockedMeta;

    // Check if locking slots caused all usable slots to be filled
    const unlockedCapacity = Math.max(0, totalSlots - updatedLockedSlots.length);
    if (reg.status === 'OPEN' && activeEntries.length >= unlockedCapacity && unlockedCapacity >= 0) {
      reg.status = 'CLOSED';
    }

    const savedReg = await saveConfigurableRegistration(reg);
    const slotStates = await syncRegistrationSlotStates(registrationId, resolvedCycleId, savedReg);

    return {
      ok: true,
      lockedSlots: updatedLockedSlots,
      newlyLocked,
      slotStates,
      registration: savedReg,
    };
  } finally {
    await releaseLock(lockKey);
  }
}

/**
 * Atomically unlocks one or more individual slots for a specific registration,
 * immediately restoring them to AVAILABLE for future registration.
 *
 * @param {string} registrationId
 * @param {number|Array<number|string>} slotNumbersInput
 * @param {string} [unlockedBy]
 * @param {string} [cycleId]
 * @returns {Promise<{
 *   ok: boolean,
 *   code?: string,
 *   message?: string,
 *   lockedSlots?: number[],
 *   newlyUnlocked?: number[],
 *   slotStates?: Array<object>,
 *   registration?: object
 * }>}
 */
export async function unlockRegistrationSlots(registrationId, slotNumbersInput, unlockedBy = null, cycleId = null) {
  if (!registrationId) {
    return { ok: false, code: 'INVALID_REGISTRATION', message: '❌ Registration not found.' };
  }

  const lockKey = `lock:reg_confirm:${registrationId}`;
  await acquireLock(lockKey, 10, 3000);
  try {
    const reg = await getConfigurableRegistration(registrationId);
    if (!reg) {
      return { ok: false, code: 'INVALID_REGISTRATION', message: '❌ Registration instance not found.' };
    }

    const totalSlots = typeof reg.totalSlots === 'number' && reg.totalSlots > 0 ? reg.totalSlots : 20;
    const rawList = Array.isArray(slotNumbersInput) ? slotNumbersInput : [slotNumbersInput];
    const requestedSlots = [];
    for (const item of rawList) {
      const num = typeof item === 'number' ? Math.floor(item) : parseInt(String(item).trim(), 10);
      if (!Number.isInteger(num) || num < 1 || num > totalSlots) {
        return {
          ok: false,
          code: 'INVALID_SLOT_NUMBER',
          message: `❌ Invalid slot number "${item}". Slot numbers must be between 1 and ${totalSlots}.`,
        };
      }
      if (!requestedSlots.includes(num)) {
        requestedSlots.push(num);
      }
    }

    if (requestedSlots.length === 0) {
      return { ok: false, code: 'NO_SLOTS_SELECTED', message: '❌ Please select at least one locked slot to unlock.' };
    }

    const resolvedCycleId = cycleId || reg.currentCycleId || 'default';
    const existingLocked = new Set(getLockedSlotNumbers(reg, totalSlots));
    const newlyUnlocked = [];
    const lockedMeta = { ...(reg.lockedSlotsMeta || {}) };

    for (const slotNum of requestedSlots) {
      if (existingLocked.has(slotNum)) {
        existingLocked.delete(slotNum);
        newlyUnlocked.push(slotNum);
      }
      delete lockedMeta[slotNum];
    }

    const updatedLockedSlots = Array.from(existingLocked).sort((a, b) => a - b);
    reg.lockedSlots = updatedLockedSlots;
    reg.reservedSlots = updatedLockedSlots.length;
    reg.lockedSlotsMeta = lockedMeta;

    const savedReg = await saveConfigurableRegistration(reg);
    const slotStates = await syncRegistrationSlotStates(registrationId, resolvedCycleId, savedReg);

    return {
      ok: true,
      lockedSlots: updatedLockedSlots,
      newlyUnlocked,
      slotStates,
      registration: savedReg,
    };
  } finally {
    await releaseLock(lockKey);
  }
}

export async function getRegistrationEntriesCount(registrationId, cycleId = null) {
  if (!registrationId) return 0;
  const entries = await getConfigurableEntriesForRegistration(registrationId, cycleId);
  const seenTeams = new Set();
  const seenSlots = new Set();
  let count = 0;
  for (const e of entries) {
    const slotNum = Number(e.slotNumber);
    const teamKey = e.teamId || (e.teamName || '').trim().toLowerCase();
    if (teamKey && seenTeams.has(teamKey)) continue;
    if (Number.isInteger(slotNum) && seenSlots.has(slotNum)) continue;
    if (teamKey) seenTeams.add(teamKey);
    if (Number.isInteger(slotNum)) seenSlots.add(slotNum);
    count++;
  }
  return count;
}

/**
 * Dynamically identifies all locked and occupied slots for the registration and cycle,
 * and returns the lowest available unlocked slot number between 1 and totalSlots.
 * Never allocates a locked slot or an occupied slot.
 *
 * @param {string} registrationId
 * @param {number} [totalSlots]
 * @param {number|Array<number>|object} [reservedSlotsInput]
 * @param {string} [cycleId]
 * @returns {Promise<number|null>} Returns null if full.
 */
export async function getNextAvailableSlot(registrationId, totalSlots = null, reservedSlotsInput = 0, cycleId = null) {
  const reg = registrationId ? await getConfigurableRegistration(registrationId) : null;
  const effectiveTotal =
    (typeof totalSlots === 'number' && totalSlots > 0 ? Math.floor(totalSlots) : null) ||
    (typeof reg?.totalSlots === 'number' && reg.totalSlots > 0 ? Math.floor(reg.totalSlots) : 20);
  const resolvedCycleId = cycleId || reg?.currentCycleId || null;

  const entries = await getConfigurableEntriesForRegistration(registrationId, resolvedCycleId);
  const occupiedSlots = new Set(entries.map((e) => Number(e.slotNumber)).filter((n) => Number.isInteger(n)));

  // Build locked slots set from registration configuration, direct input, and cycle slot state documents
  const lockedSlotsSet = new Set();
  if (reg) {
    for (const s of getLockedSlotNumbers(reg, effectiveTotal)) {
      lockedSlotsSet.add(s);
    }
  }

  if (Array.isArray(reservedSlotsInput) || (reservedSlotsInput && typeof reservedSlotsInput === 'object')) {
    for (const s of getLockedSlotNumbers(reservedSlotsInput, effectiveTotal)) {
      lockedSlotsSet.add(s);
    }
  } else if (lockedSlotsSet.size === 0 && reservedSlotsInput) {
    for (const s of getLockedSlotNumbers(reservedSlotsInput, effectiveTotal)) {
      lockedSlotsSet.add(s);
    }
  }

  const slotLookupCycle = resolvedCycleId || 'default';
  for (let slot = 1; slot <= effectiveTotal; slot++) {
    const slotDoc = localSlots.get(`${registrationId}:${slotLookupCycle}:${slot}`);
    if (slotDoc?.status === 'LOCKED' && lockedSlotsSet.has(slot)) {
      lockedSlotsSet.add(slot);
    }
    if (slotDoc?.status === 'OCCUPIED' && slotDoc.teamId) {
      occupiedSlots.add(slot);
    }
  }

  for (let slot = 1; slot <= effectiveTotal; slot++) {
    if (!lockedSlotsSet.has(slot) && !occupiedSlots.has(slot)) {
      return slot;
    }
  }
  return null;
}

// ----------------------------------------------------
// DAILY REGISTRATION CYCLES ARCHIVAL CRUD
// ----------------------------------------------------

export async function saveDailyCycle(doc) {
  if (!doc || !doc.cycleId) return null;
  const now = new Date();
  const record = {
    ...doc,
    updatedAt: now,
    createdAt: doc.createdAt || now,
  };

  localDailyCycles.set(record.cycleId, { ...record });

  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_daily_registration_cycles');
      await col.updateOne(
        { cycleId: record.cycleId },
        { $set: record },
        { upsert: true }
      );
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error saving daily cycle ${record.cycleId}:`, err.message);
    }
  }

  return record;
}

export async function getDailyCycle(cycleId) {
  if (!cycleId) return null;
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_daily_registration_cycles');
      const doc = await col.findOne({ cycleId });
      if (doc) {
        localDailyCycles.set(cycleId, doc);
        return doc;
      }
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error reading daily cycle ${cycleId}:`, err.message);
    }
  }
  return localDailyCycles.get(cycleId) || null;
}

export async function getDailyCyclesForRegistration(registrationId, limit = 10) {
  if (!registrationId) return [];
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_daily_registration_cycles');
      const docs = await col
        .find({ registrationId })
        .sort({ endedAt: -1, createdAt: -1 })
        .limit(limit)
        .toArray();
      for (const d of docs) {
        localDailyCycles.set(d.cycleId, d);
      }
      return docs;
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error listing daily cycles:`, err.message);
    }
  }

  return Array.from(localDailyCycles.values())
    .filter((c) => c.registrationId === registrationId)
    .sort((a, b) => new Date(b.endedAt || b.createdAt || 0) - new Date(a.endedAt || a.createdAt || 0))
    .slice(0, limit);
}

/**
 * Safely archives active confirmed entries for a registration cycle into discord_daily_registration_cycles,
 * marks active entries as ARCHIVED so the same team can register again in the next daily cycle,
 * and clears active slot allocations without touching team enrollments or player data.
 * @param {string} registrationId
 * @param {object} [extraData]
 * @returns {Promise<object|null>}
 */
export async function archiveActiveRegistrationCycle(registrationId, extraData = {}) {
  const reg = await getConfigurableRegistration(registrationId);
  if (!reg) return null;

  const { entries: preloadedEntries, ...restExtra } = extraData;
  const activeEntries = Array.isArray(preloadedEntries)
    ? preloadedEntries
    : await getConfigurableEntriesForRegistration(registrationId, restExtra.cycleId || null);
  const now = new Date();
  const cycleDate = restExtra.cycleDate || reg.currentCycleDate || getCurrentTimeInTimezone(reg.timezone || 'Asia/Kolkata', now).dateString;
  const cycleId = restExtra.cycleId || reg.currentCycleId || `${registrationId}:${cycleDate}`;

  const lockedSlots = getLockedSlotNumbers(reg, reg.totalSlots);
  const cycleRecord = {
    cycleId,
    registrationId: reg.registrationId,
    tournamentId: reg.tournamentId,
    guildId: reg.guildId,
    displayName: reg.displayName,
    cycleDate,
    entries: activeEntries.map((e) => ({ ...e })),
    slotAllocations: activeEntries.map((e) => ({
      slotNumber: e.slotNumber,
      teamId: e.teamId,
      teamName: e.teamName,
      leaderDiscordId: e.leaderDiscordId,
      registeredAt: e.registeredAt,
    })),
    totalSlots: reg.totalSlots,
    reservedSlots: lockedSlots.length,
    lockedSlots,
    status: 'COMPLETED',
    startedAt: reg.currentCycleStartedAt || null,
    endedAt: now,
    archivedAt: now,
    ...restExtra,
  };

  await saveDailyCycle(cycleRecord);

  // Mark active entries as ARCHIVED
  for (const entry of activeEntries) {
    entry.status = 'ARCHIVED';
    entry.archivedAt = now;
    const cycleKey = `${entry.registrationId}:${entry.cycleId || 'default'}:${entry.teamId}`;
    localEntries.set(cycleKey, { ...entry });
  }

  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_entries');
      const archiveQuery = { registrationId, status: 'CONFIRMED' };
      if (restExtra.cycleId) {
        archiveQuery.cycleId = { $in: [restExtra.cycleId, 'default', null] };
      }
      await col.updateMany(
        archiveQuery,
        { $set: { status: 'ARCHIVED', archivedAt: now } }
      );
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error archiving entries for ${registrationId}:`, err.message);
    }
  }

  // Restore new/current cycle slot states: preserve LOCKED slots, restore all unlocked slots to AVAILABLE
  await syncRegistrationSlotStates(registrationId, reg.currentCycleId || 'default', reg).catch(() => {});

  return cycleRecord;
}

// ----------------------------------------------------
// PENDING ENROLLMENT SESSION CRUD (Multi-step form)
// ----------------------------------------------------

export async function savePendingEnrollment(session) {
  if (!session || !session.tournamentId || !session.userId) return null;
  const key = `${session.tournamentId}:${session.userId}`;
  const now = new Date();
  const expiresAt = session.expiresAt instanceof Date
    ? session.expiresAt
    : new Date(session.expiresAt || (Date.now() + 15 * 60 * 1000));

  const record = {
    ...session,
    updatedAt: now,
    expiresAt,
  };
  localPendingEnrollments.set(key, record);

  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_pending_enrollments');
      await col.updateOne(
        { tournamentId: session.tournamentId, userId: session.userId },
        { $set: record },
        { upsert: true }
      );
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error saving pending enrollment:`, err.message);
    }
  }
  return record;
}

export async function getPendingEnrollment(tournamentId, userId) {
  if (!tournamentId || !userId) return null;
  const key = `${tournamentId}:${userId}`;

  // 1. Fast path: check in-memory cache first (< 1ms)
  const local = localPendingEnrollments.get(key);
  if (local) {
    const expTime = local.expiresAt instanceof Date ? local.expiresAt.getTime() : new Date(local.expiresAt).getTime();
    if (expTime > Date.now()) {
      return local;
    }
    localPendingEnrollments.delete(key);
  }

  // 2. Persistent path: check MongoDB (e.g. after bot restart)
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_pending_enrollments');
      const doc = await col.findOne({ tournamentId, userId });
      if (doc) {
        const expTime = doc.expiresAt instanceof Date ? doc.expiresAt.getTime() : new Date(doc.expiresAt).getTime();
        if (expTime > Date.now()) {
          localPendingEnrollments.set(key, doc);
          return doc;
        } else {
          localPendingEnrollments.delete(key);
          await col.deleteOne({ tournamentId, userId }).catch(() => {});
          return null;
        }
      }
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error reading pending enrollment:`, err.message);
    }
  }

  return null;
}

export async function deletePendingEnrollment(tournamentId, userId) {
  if (!tournamentId || !userId) return false;
  const key = `${tournamentId}:${userId}`;
  localPendingEnrollments.delete(key);

  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_pending_enrollments');
      await col.deleteOne({ tournamentId, userId });
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error deleting pending enrollment:`, err.message);
      return false;
    }
  }
  return true;
}

/**
 * One-time and bot startup reconciliation cleanup:
 * 1. Finds active registrations whose registration or IDP channel no longer exists in Discord,
 *    and marks them DELETED while archiving active entries and releasing slots.
 * 2. Finds any active entries (CONFIRMED/REGISTERED) whose registration is deleted,
 *    missing, or whose channels are deleted, and archives them with slots released.
 *    (Clears stale Slot #3 entries like 4Crows).
 */
export async function cleanUpStaleConfigurableRegistrationsAndEntries(client = null) {
  const now = new Date();
  let cleanedRegistrations = 0;
  let cleanedEntries = 0;

  try {
    // 1. Check all non-deleted registrations against Discord channels (if client provided)
    if (client) {
      const allActiveRegs = await getAllActiveConfigurableRegistrations();
      for (const reg of allActiveRegs) {
        let channelsValid = true;
        try {
          if (reg.guildId) {
            const guild = client.guilds?.cache?.get(reg.guildId) || await client.guilds?.fetch(reg.guildId).catch(() => null);
            if (guild) {
              if (reg.registrationChannelId) {
                const regCh =
                  guild.channels?.cache?.get(reg.registrationChannelId) ||
                  await guild.channels?.fetch(reg.registrationChannelId).catch(() => null) ||
                  client.channels?.cache?.get(reg.registrationChannelId) ||
                  await client.channels?.fetch?.(reg.registrationChannelId).catch(() => null);
                if (!regCh) channelsValid = false;
              }
              if (reg.idpChannelId) {
                const idpCh =
                  guild.channels?.cache?.get(reg.idpChannelId) ||
                  await guild.channels?.fetch(reg.idpChannelId).catch(() => null) ||
                  client.channels?.cache?.get(reg.idpChannelId) ||
                  await client.channels?.fetch?.(reg.idpChannelId).catch(() => null);
                if (!idpCh) channelsValid = false;
              }
            }
          }
        } catch {
          channelsValid = false;
        }

        if (!channelsValid) {
          console.log(`[ConfigurableTournament] 🧹 Cleaning up orphaned registration "${reg.displayName}" (${reg.registrationId}) - channels missing in Discord.`);
          await deleteConfigurableRegistration(reg.registrationId, client);
          cleanedRegistrations++;
        }
      }
    }

    // 2. Clean up any active entries in MongoDB that:
    // - Point to deleted/missing registrations
    // - Do NOT appear in their registration's current slot chart (cycleId != currentCycleId)
    if (isMongoConnected()) {
      const regCol = getMongoDb().collection('discord_configurable_registrations');
      const entryCol = getMongoDb().collection('discord_configurable_entries');

      // Get all active (non-deleted) registrations and their current cycleId
      const activeRegDocs = await regCol.find({
        status: { $ne: 'DELETED' },
        isDeleted: { $ne: true },
      }, { projection: { registrationId: 1, currentCycleId: 1 } }).toArray();

      const validRegCycleMap = new Map();
      for (const r of activeRegDocs) {
        validRegCycleMap.set(r.registrationId, r.currentCycleId || null);
      }

      // Fetch all active entries (CONFIRMED / REGISTERED)
      const allActiveEntries = await entryCol.find({
        status: { $in: ACTIVE_ENTRY_STATUSES },
      }).toArray();

      const entriesToArchive = [];
      for (const entry of allActiveEntries) {
        const regCurrentCycleId = validRegCycleMap.get(entry.registrationId);
        // If registration is deleted/missing OR entry's cycle does not match registration's currentCycleId
        // (meaning it does NOT appear in its registration's current slot chart)
        if (!validRegCycleMap.has(entry.registrationId) || !regCurrentCycleId || entry.cycleId !== regCurrentCycleId) {
          entriesToArchive.push(entry._id);
        }
      }

      if (entriesToArchive.length > 0) {
        console.log(`[ConfigurableTournament] 🧹 Found ${entriesToArchive.length} stale/orphaned active entry/entries (not in current slot charts) to archive.`);
        await entryCol.updateMany(
          { _id: { $in: entriesToArchive } },
          { $set: { status: 'ARCHIVED', archivedAt: now, archiveReason: 'STALE_ENTRY_NOT_IN_CURRENT_CHART' } }
        );
        cleanedEntries += entriesToArchive.length;
      }
    }

    // Also clean up in local memory
    for (const [key, entry] of localEntries.entries()) {
      if (ACTIVE_ENTRY_STATUSES.includes(entry.status)) {
        const reg = localRegistrations.get(entry.registrationId);
        if (!reg || reg.status === 'DELETED' || reg.isDeleted === true || (reg.currentCycleId && entry.cycleId !== reg.currentCycleId)) {
          entry.status = 'ARCHIVED';
          entry.archivedAt = now;
          localEntries.set(key, { ...entry });
          cleanedEntries++;
        }
      }
    }
  } catch (err) {
    console.warn(`[ConfigurableTournament] ⚠️ Error in cleanUpStaleConfigurableRegistrationsAndEntries:`, err.message);
  }

  return { cleanedRegistrations, cleanedEntries };
}

export { localTeams, localPlayerMemberships, localEntries, localSlots, localAuditLogs };



