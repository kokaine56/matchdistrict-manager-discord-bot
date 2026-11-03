import crypto from 'node:crypto';
import { getMongoDb, isMongoConnected } from './mongoService.js';

// In-memory fallback stores (used when MongoDB is disconnected or in unit tests)
const localTournaments = new Map(); // tournamentId -> doc
const localRegistrations = new Map(); // registrationId -> doc
const localTeams = new Map(); // teamId -> doc
const localEntries = new Map(); // `${registrationId}:${teamId}` -> doc

export function clearInMemoryData() {
  localTournaments.clear();
  localRegistrations.clear();
  localTeams.clear();
  localEntries.clear();
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
  const record = {
    ...doc,
    registrationId,
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

export async function getConfigurableRegistration(registrationId) {
  if (!registrationId) return null;
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_registrations');
      const doc = await col.findOne({ registrationId });
      if (doc) {
        localRegistrations.set(registrationId, doc);
        return doc;
      }
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error reading registration ${registrationId}:`, err.message);
    }
  }
  return localRegistrations.get(registrationId) || null;
}

export async function getConfigurableRegistrationsForTournament(tournamentId) {
  if (!tournamentId) return [];
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_registrations');
      const docs = await col.find({ tournamentId }).sort({ registrationNumber: 1 }).toArray();
      for (const d of docs) {
        localRegistrations.set(d.registrationId, d);
      }
      return docs;
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error listing registrations for ${tournamentId}:`, err.message);
    }
  }

  return Array.from(localRegistrations.values())
    .filter((r) => r.tournamentId === tournamentId)
    .sort((a, b) => (a.registrationNumber || 0) - (b.registrationNumber || 0));
}

export async function findConfigurableRegistrationByChannelId(channelId) {
  if (!channelId) return null;
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_registrations');
      const doc = await col.findOne({
        $or: [{ registrationChannelId: channelId }, { idpChannelId: channelId }],
      });
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
      return reg;
    }
  }
  return null;
}

export async function getAllActiveConfigurableRegistrations() {
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_registrations');
      const docs = await col.find({ status: { $in: ['UPCOMING', 'OPEN'] } }).toArray();
      for (const d of docs) {
        localRegistrations.set(d.registrationId, d);
      }
      return docs;
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error getting active registrations:`, err.message);
    }
  }

  return Array.from(localRegistrations.values()).filter(
    (r) => r.status === 'UPCOMING' || r.status === 'OPEN'
  );
}

export async function deleteConfigurableRegistration(registrationId) {
  if (!registrationId) return false;
  localRegistrations.delete(registrationId);

  // Delete all entries in this registration
  for (const [key, entry] of localEntries.entries()) {
    if (entry.registrationId === registrationId) {
      localEntries.delete(key);
    }
  }

  if (isMongoConnected()) {
    try {
      const regCol = getMongoDb().collection('discord_configurable_registrations');
      await regCol.deleteOne({ registrationId });

      const entryCol = getMongoDb().collection('discord_configurable_entries');
      await entryCol.deleteMany({ registrationId });
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error deleting registration ${registrationId}:`, err.message);
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
    status: doc.status || 'CONFIRMED',
    updatedAt: now,
    registeredAt: doc.registeredAt || now,
  };

  const key = `${record.registrationId}:${record.teamId}`;
  localEntries.set(key, { ...record });

  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_entries');
      await col.updateOne(
        { registrationId: record.registrationId, teamId: record.teamId },
        { $set: record },
        { upsert: true }
      );
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error saving entry:`, err.message);
    }
  }

  return record;
}

export async function getConfigurableEntry(registrationId, teamId) {
  if (!registrationId || !teamId) return null;
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_entries');
      const doc = await col.findOne({ registrationId, teamId, status: 'CONFIRMED' });
      if (doc) {
        localEntries.set(`${registrationId}:${teamId}`, doc);
        return doc;
      }
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error reading entry:`, err.message);
    }
  }

  const found = localEntries.get(`${registrationId}:${teamId}`);
  return found && found.status === 'CONFIRMED' ? found : null;
}

export async function getConfigurableEntriesForRegistration(registrationId) {
  if (!registrationId) return [];
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_entries');
      const docs = await col
        .find({ registrationId, status: 'CONFIRMED' })
        .sort({ slotNumber: 1 })
        .toArray();
      for (const d of docs) {
        localEntries.set(`${d.registrationId}:${d.teamId}`, d);
      }
      return docs;
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error listing entries for registration ${registrationId}:`, err.message);
    }
  }

  return Array.from(localEntries.values())
    .filter((e) => e.registrationId === registrationId && e.status === 'CONFIRMED')
    .sort((a, b) => a.slotNumber - b.slotNumber);
}

export async function getConfigurableEntriesForTeam(teamId) {
  if (!teamId) return [];
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_entries');
      const docs = await col.find({ teamId, status: 'CONFIRMED' }).toArray();
      for (const d of docs) {
        localEntries.set(`${d.registrationId}:${d.teamId}`, d);
      }
      return docs;
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error listing entries for team ${teamId}:`, err.message);
    }
  }

  return Array.from(localEntries.values()).filter(
    (e) => e.teamId === teamId && e.status === 'CONFIRMED'
  );
}

export async function deleteConfigurableEntry(registrationId, teamId) {
  if (!registrationId || !teamId) return false;
  localEntries.delete(`${registrationId}:${teamId}`);

  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_entries');
      await col.deleteOne({ registrationId, teamId });
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error deleting entry:`, err.message);
      return false;
    }
  }
  return true;
}

export async function getRegistrationEntriesCount(registrationId) {
  if (!registrationId) return 0;
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection('discord_configurable_entries');
      return await col.countDocuments({ registrationId, status: 'CONFIRMED' });
    } catch (err) {
      console.warn(`[ConfigurableTournament] ⚠️ Mongo error counting entries:`, err.message);
    }
  }

  return Array.from(localEntries.values()).filter(
    (e) => e.registrationId === registrationId && e.status === 'CONFIRMED'
  ).length;
}

/**
 * Finds the lowest unassigned slot number between 1 and totalSlots.
 * @param {string} registrationId
 * @param {number} totalSlots
 * @returns {Promise<number|null>} Returns null if full.
 */
export async function getNextAvailableSlot(registrationId, totalSlots) {
  const entries = await getConfigurableEntriesForRegistration(registrationId);
  const occupiedSlots = new Set(entries.map((e) => e.slotNumber));

  for (let slot = 1; slot <= totalSlots; slot++) {
    if (!occupiedSlots.has(slot)) {
      return slot;
    }
  }
  return null;
}

