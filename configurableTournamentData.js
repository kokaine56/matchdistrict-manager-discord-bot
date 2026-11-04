import crypto from 'node:crypto';
import { getMongoDb, isMongoConnected } from './mongoService.js';

// In-memory fallback stores (used when MongoDB is disconnected or in unit tests)
const localTournaments = new Map(); // tournamentId -> doc
const localRegistrations = new Map(); // registrationId -> doc
const localTeams = new Map(); // teamId -> doc
const localEntries = new Map(); // `${registrationId}:${teamId}` or `${registrationId}:${cycleId}:${teamId}` -> doc
const localPendingEnrollments = new Map(); // `${tournamentId}:${userId}` -> sessionDoc
const localDailyCycles = new Map(); // cycleId -> doc

export function clearInMemoryData() {
  localTournaments.clear();
  localRegistrations.clear();
  localTeams.clear();
  localEntries.clear();
  localPendingEnrollments.clear();
  localDailyCycles.clear();
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
 * Normalizes reserved slots input into an integer count of locked slots starting from Slot 01.
 * @param {string|Array<number>|number} input
 * @param {number} [totalSlots]
 * @returns {number}
 */
export function parseReservedSlots(input, totalSlots = null) {
  if (input === null || input === undefined || input === '') return 0;
  let count = 0;

  if (typeof input === 'number') {
    count = isNaN(input) ? 0 : Math.max(0, Math.floor(input));
  } else if (Array.isArray(input)) {
    count = input.length;
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
  let activeCycleDate = tzInfo.dateString;
  let endedCycleDate = yesterdayDate;

  if (startMinutes < resetMinutes) {
    // Same-day cycle (e.g. 10:00 to 22:00)
    if (currentMinutes < startMinutes) {
      isOpen = false;
      activeCycleDate = tzInfo.dateString;
      endedCycleDate = yesterdayDate;
    } else if (currentMinutes < resetMinutes) {
      isOpen = true;
      activeCycleDate = tzInfo.dateString;
      endedCycleDate = yesterdayDate;
    } else {
      isOpen = false;
      activeCycleDate = tzInfo.dateString;
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
      activeCycleDate = tzInfo.dateString;
      endedCycleDate = yesterdayDate;
    }
  }

  return {
    isOpen,
    status: isOpen ? 'OPEN' : 'CLOSED',
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
  const tournamentId = doc.tournamentId || crypto.randomUUID();
  const normalized = normalizeTournament(doc);
  const record = {
    ...normalized,
    tournamentId,
    updatedAt: now,
    createdAt: doc.createdAt || now,
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

export async function getConfigurableTournament(tournamentId) {
  if (!tournamentId) return null;
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_tournaments');
      const doc = await col.findOne({ tournamentId });
      if (doc) {
        const normalized = normalizeTournament(doc);
        localTournaments.set(tournamentId, normalized);
        return normalized;
      }
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error reading tournament ${tournamentId}:`, err.message);
    }
  }
  const local = localTournaments.get(tournamentId);
  return local ? normalizeTournament(local) : null;
}

export async function getConfigurableTournamentByCategory(guildId, categoryId) {
  if (!guildId || !categoryId) return null;
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_tournaments');
      const doc = await col.findOne({ guildId, categoryId });
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
      return normalizeTournament(doc);
    }
  }
  return null;
}

export async function getConfigurableTournamentBySetupChannel(setupChannelId) {
  if (!setupChannelId) return null;
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_tournaments');
      const doc = await col.findOne({ setupChannelId });
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
      return normalizeTournament(doc);
    }
  }
  return null;
}

export async function getAllConfigurableTournaments(guildId = null) {
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_tournaments');
      const query = guildId ? { guildId } : {};
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

  const all = Array.from(localTournaments.values()).map(normalizeTournament);
  return guildId ? all.filter((d) => d.guildId === guildId) : all;
}

export async function deleteConfigurableTournament(tournamentId) {
  if (!tournamentId) return false;
  localTournaments.delete(tournamentId);

  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_tournaments');
      await col.deleteOne({ tournamentId });
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error deleting tournament ${tournamentId}:`, err.message);
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
  const registrationId = doc.registrationId || crypto.randomUUID();
  const totalSlots = typeof doc.totalSlots === 'number' && doc.totalSlots > 0 ? doc.totalSlots : 20;
  const reservedSlots = parseReservedSlots(doc.reservedSlots, totalSlots);
  const timezone = doc.timezone || 'Asia/Kolkata';

  const record = {
    ...doc,
    registrationId,
    totalSlots,
    reservedSlots,
    timezone,
    updatedAt: now,
    createdAt: doc.createdAt || now,
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
      const docs = await col.find(query).sort({ registrationNumber: 1 }).toArray();
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
    .sort((a, b) => (a.registrationNumber || 0) - (b.registrationNumber || 0));
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

  return record;
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
      const doc = await col.findOne({ tournamentId, teamNameLower: lower });
      if (doc) {
        localTeams.set(doc.teamId, doc);
        return doc;
      }
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error reading team by name ${teamName}:`, err.message);
    }
  }

  for (const team of localTeams.values()) {
    if (team.tournamentId === tournamentId && team.teamNameLower === lower) {
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
          $or: [
            { leaderDiscordId: discordId },
            { 'players.discordId': discordId },
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
      (t.leaderDiscordId === discordId ||
        (t.players && t.players.some((p) => p.discordId === discordId)))
  );
}

export async function getConfigurableTeamsForTournament(tournamentId) {
  if (!tournamentId) return [];
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_teams');
      const docs = await col.find({ tournamentId }).toArray();
      for (const d of docs) {
        localTeams.set(d.teamId, d);
      }
      return docs;
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error listing teams for tournament ${tournamentId}:`, err.message);
    }
  }

  return Array.from(localTeams.values()).filter((t) => t.tournamentId === tournamentId);
}

export async function getEnrolledTeamsCount(tournamentId) {
  if (!tournamentId) return 0;
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_teams');
      return await col.countDocuments({ tournamentId });
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error counting teams:`, err.message);
    }
  }
  return Array.from(localTeams.values()).filter((t) => t.tournamentId === tournamentId).length;
}

export async function deleteConfigurableTeam(teamId) {
  if (!teamId) return false;
  localTeams.delete(teamId);

  // Remove entries belonging to this team
  for (const [key, entry] of localEntries.entries()) {
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
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error deleting team ${teamId}:`, err.message);
      return false;
    }
  }
  return true;
}

// ----------------------------------------------------
// REGISTRATION ENTRIES CRUD (Slots)
// ----------------------------------------------------

export async function saveConfigurableEntry(doc) {
  if (!doc) return null;
  const now = new Date();
  const entryId = doc.entryId || crypto.randomUUID();
  const record = {
    ...doc,
    entryId,
    cycleId: doc.cycleId || 'default',
    status: doc.status || 'CONFIRMED',
    updatedAt: now,
    registeredAt: doc.registeredAt || now,
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

  return record;
}

const ACTIVE_ENTRY_STATUSES = ['CONFIRMED', 'REGISTERED'];

export async function getConfigurableEntry(registrationId, teamId, cycleId = null) {
  if (!registrationId || !teamId) return null;
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_entries');
      const query = { registrationId, teamId, status: { $in: ACTIVE_ENTRY_STATUSES } };
      if (cycleId) query.cycleId = cycleId;
      const doc = await col.findOne(query);
      if (doc) {
        localEntries.set(`${registrationId}:${doc.cycleId || 'default'}:${teamId}`, doc);
        return doc;
      }
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error reading entry:`, err.message);
    }
  }

  if (cycleId) {
    const cycleEntry = localEntries.get(`${registrationId}:${cycleId}:${teamId}`);
    if (cycleEntry && ACTIVE_ENTRY_STATUSES.includes(cycleEntry.status)) return cycleEntry;
  }
  for (const entry of localEntries.values()) {
    if (entry.registrationId === registrationId && entry.teamId === teamId && ACTIVE_ENTRY_STATUSES.includes(entry.status)) {
      if (!cycleId || entry.cycleId === cycleId) return entry;
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
      if (cycleId) query.cycleId = cycleId;
      const docs = await col
        .find(query)
        .sort({ slotNumber: 1 })
        .toArray();
      for (const d of docs) {
        localEntries.set(`${d.registrationId}:${d.cycleId || 'default'}:${d.teamId}`, d);
      }
      return docs;
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error listing entries for registration ${registrationId}:`, err.message);
    }
  }

  return Array.from(localEntries.values())
    .filter((e) => {
      if (e.registrationId !== registrationId || !ACTIVE_ENTRY_STATUSES.includes(e.status)) return false;
      if (cycleId && e.cycleId && e.cycleId !== cycleId) return false;
      return true;
    })
    .sort((a, b) => a.slotNumber - b.slotNumber);
}

export async function getConfigurableEntriesForTeam(teamId) {
  if (!teamId) return [];
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_entries');
      const docs = await col.find({ teamId, status: { $in: ACTIVE_ENTRY_STATUSES } }).toArray();
      for (const d of docs) {
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
  for (const [key, entry] of Array.from(localEntries.entries())) {
    if (entry.registrationId === registrationId && entry.teamId === teamId) {
      if (!cycleId || entry.cycleId === cycleId) {
        localEntries.delete(key);
      }
    }
  }

  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_entries');
      const query = { registrationId, teamId };
      if (cycleId) query.cycleId = cycleId;
      await col.deleteOne(query);
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error deleting entry:`, err.message);
      return false;
    }
  }
  return true;
}

export async function getRegistrationEntriesCount(registrationId, cycleId = null) {
  if (!registrationId) return 0;
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_entries');
      const query = { registrationId, status: { $in: ACTIVE_ENTRY_STATUSES } };
      if (cycleId) query.cycleId = cycleId;
      return await col.countDocuments(query);
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error counting entries:`, err.message);
    }
  }

  return (await getConfigurableEntriesForRegistration(registrationId, cycleId)).length;
}

/**
 * Finds the lowest unassigned slot number between 1 and totalSlots.
 * Reserved slots always occupy the beginning (Slot 01 to Slot reservedSlots).
 * Formula: firstAvailableSlot = reservedSlots + 1
 *
 * @param {string} registrationId
 * @param {number} totalSlots
 * @param {number} [reservedSlotsCount]
 * @param {string} [cycleId]
 * @returns {Promise<number|null>} Returns null if full.
 */
export async function getNextAvailableSlot(registrationId, totalSlots, reservedSlotsCount = 0, cycleId = null) {
  const entries = await getConfigurableEntriesForRegistration(registrationId, cycleId);
  const occupiedSlots = new Set(entries.map((e) => e.slotNumber));
  const rCount = parseReservedSlots(reservedSlotsCount, totalSlots);

  for (let slot = rCount + 1; slot <= totalSlots; slot++) {
    if (!occupiedSlots.has(slot)) {
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

  const activeEntries = await getConfigurableEntriesForRegistration(registrationId);
  const now = new Date();
  const cycleDate = reg.currentCycleDate || getCurrentTimeInTimezone(reg.timezone || 'Asia/Kolkata', now).dateString;
  const cycleId = reg.currentCycleId || `${registrationId}:${cycleDate}`;

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
    reservedSlots: parseReservedSlots(reg.reservedSlots, reg.totalSlots),
    status: 'COMPLETED',
    startedAt: reg.currentCycleStartedAt || null,
    endedAt: now,
    archivedAt: now,
    ...extraData,
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
      await col.updateMany(
        { registrationId, status: 'CONFIRMED' },
        { $set: { status: 'ARCHIVED', archivedAt: now } }
      );
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error archiving entries for ${registrationId}:`, err.message);
    }
  }

  return cycleRecord;
}

// ----------------------------------------------------
// PENDING ENROLLMENT SESSION CRUD (Multi-step form)
// ----------------------------------------------------

export async function savePendingEnrollment(session) {
  if (!session || !session.tournamentId || !session.userId) return null;
  const key = `${session.tournamentId}:${session.userId}`;
  const record = {
    ...session,
    updatedAt: new Date(),
    expiresAt: session.expiresAt || (Date.now() + 15 * 60 * 1000),
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

  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_pending_enrollments');
      const doc = await col.findOne({ tournamentId, userId });
      if (doc && doc.expiresAt > Date.now()) {
        localPendingEnrollments.set(key, doc);
        return doc;
      }
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error reading pending enrollment:`, err.message);
    }
  }

  const local = localPendingEnrollments.get(key);
  if (local && local.expiresAt > Date.now()) {
    return local;
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
                const regCh = guild.channels?.cache?.get(reg.registrationChannelId) || await guild.channels?.fetch(reg.registrationChannelId).catch(() => null);
                if (!regCh) channelsValid = false;
              }
              if (reg.idpChannelId) {
                const idpCh = guild.channels?.cache?.get(reg.idpChannelId) || await guild.channels?.fetch(reg.idpChannelId).catch(() => null);
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

    // 2. Clean up any active entries belonging to DELETED or missing registrations
    if (isMongoConnected()) {
      const regCol = getMongoDb().collection('discord_configurable_registrations');
      const entryCol = getMongoDb().collection('discord_configurable_entries');

      // Get all active or non-deleted registration IDs
      const activeRegDocs = await regCol.find({
        status: { $ne: 'DELETED' },
        isDeleted: { $ne: true },
      }, { projection: { registrationId: 1 } }).toArray();
      const validRegIds = new Set(activeRegDocs.map((r) => r.registrationId));

      // Find any confirmed entries whose registrationId is not in validRegIds
      const orphanedEntries = await entryCol.find({
        status: { $in: ACTIVE_ENTRY_STATUSES },
        registrationId: { $nin: Array.from(validRegIds) },
      }).toArray();

      if (orphanedEntries.length > 0) {
        console.log(`[ConfigurableTournament] 🧹 Found ${orphanedEntries.length} orphaned active entry/entries to archive.`);
        const orphanedIds = orphanedEntries.map((e) => e._id);
        await entryCol.updateMany(
          { _id: { $in: orphanedIds } },
          { $set: { status: 'ARCHIVED', archivedAt: now, archiveReason: 'STALE_REGISTRATION_CLEANUP' } }
        );
        cleanedEntries += orphanedEntries.length;
      }
    }

    // Also clean up in local memory
    for (const [key, entry] of localEntries.entries()) {
      if (ACTIVE_ENTRY_STATUSES.includes(entry.status)) {
        const reg = localRegistrations.get(entry.registrationId);
        if (!reg || reg.status === 'DELETED' || reg.isDeleted === true) {
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


