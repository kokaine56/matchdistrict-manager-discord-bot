import { EmbedBuilder } from 'discord.js';
import {
  getConfigurableRegistration,
  getConfigurableTournament,
  getConfigurableEntry,
  getConfigurableEntriesForRegistration,
  saveConfigurableRegistration,
  saveConfigurableEntry,
  deleteConfigurableEntry,
  parseReservedSlots,
} from './configurableTournamentData.js';

/**
 * Builds the canonical title for a slot list message:
 * Tournament Name + Registration Name + Slotlist
 * e.g. "T3 10PM Slotlist"
 *
 * @param {string} [tournamentName]
 * @param {string} [registrationName]
 * @returns {string}
 */
export function buildSlotListTitle(tournamentName, registrationName) {
  const tName = (tournamentName || '').trim();
  const rName = (registrationName || '').trim();

  if (!tName && !rName) return 'Slotlist';
  if (!tName) return `${rName} Slotlist`;
  if (!rName) return `${tName} Slotlist`;

  // Avoid repeating tournament name if registration name already starts with it
  if (rName.toLowerCase().startsWith(tName.toLowerCase())) {
    return `${rName} Slotlist`;
  }

  return `${tName} ${rName} Slotlist`;
}

/**
 * Generates the status circle emoji counter for the bottom of the slot list:
 * - 🟢 when all available (unlocked) slots are occupied
 * - 🟡 when partially occupied (1 or more, but not full)
 * - ⚪ when 0 teams are registered
 *
 * @param {number} occupiedCount
 * @param {number} unlockedTotal
 * @returns {string}
 */
export function getFilledSlotCounter(occupiedCount, unlockedTotal) {
  if (unlockedTotal <= 0) {
    return `⚪ 0/0 filled`;
  }

  let emoji = '⚪';
  if (occupiedCount >= unlockedTotal) {
    emoji = '🟢';
  } else if (occupiedCount > 0) {
    emoji = '🟡';
  } else {
    emoji = '⚪';
  }

  return `${emoji} ${occupiedCount}/${unlockedTotal} filled`;
}

/**
 * Builds the exact slot list text following the required format:
 *
 * Tournament Name + Registration Name + Slotlist
 * Slot 01 → 🔒 LOCKED
 * Slot 02 → 🔒 LOCKED
 * Slot 03 → Team guardians
 * Slot 04 → AVAILABLE
 * ...
 * 🟢 16/16 filled
 *
 * @param {object} [tournament]
 * @param {object} registration
 * @param {Array<object>} [entries]
 * @returns {string}
 */
export function buildSlotListText(tournament, registration, entries = []) {
  const totalSlots = registration.totalSlots || 20;
  const reservedSlotsList = parseReservedSlots(registration.reservedSlots, totalSlots);
  const reservedSet = new Set(reservedSlotsList);
  const unlockedTotal = Math.max(0, totalSlots - reservedSet.size);

  const occupiedMap = new Map();
  for (const entry of entries) {
    occupiedMap.set(entry.slotNumber, entry);
  }

  const title = buildSlotListTitle(tournament?.name, registration.displayName);
  const lines = [title];

  let occupiedUnlockedCount = 0;

  for (let slot = 1; slot <= totalSlots; slot++) {
    const padded = String(slot).padStart(2, '0');
    if (reservedSet.has(slot)) {
      lines.push(`Slot ${padded} → 🔒 LOCKED`);
    } else {
      const entry = occupiedMap.get(slot);
      if (entry && entry.teamName) {
        lines.push(`Slot ${padded} → ${entry.teamName}`);
        occupiedUnlockedCount++;
      } else {
        lines.push(`Slot ${padded} → AVAILABLE`);
      }
    }
  }

  const counter = getFilledSlotCounter(occupiedUnlockedCount, unlockedTotal);
  lines.push(counter);

  return lines.join('\n');
}

/**
 * Chunks the slot list text if it exceeds Discord's 2000 character limit.
 * Keeps lines intact and places the counter at the bottom of the final chunk.
 *
 * @param {object} [tournament]
 * @param {object} registration
 * @param {Array<object>} [entries]
 * @returns {Array<string>}
 */
export function buildSlotListChunks(tournament, registration, entries = []) {
  const fullText = buildSlotListText(tournament, registration, entries);
  if (fullText.length <= 1900) {
    return [fullText];
  }

  const lines = fullText.split('\n');
  const chunks = [];
  let currentLines = [];
  let currentLength = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLength = line.length + 1; // including newline

    if (currentLines.length > 0 && currentLength + lineLength > 1900) {
      chunks.push(currentLines.join('\n'));
      currentLines = [line];
      currentLength = lineLength;
    } else {
      currentLines.push(line);
      currentLength += lineLength;
    }
  }

  if (currentLines.length > 0) {
    chunks.push(currentLines.join('\n'));
  }

  return chunks;
}

/**
 * Builds an Embed for slot list (useful for dashboard modals or embed previews).
 * @param {object} registration
 * @param {Array<object>} [entries]
 * @param {object} [tournament]
 * @returns {EmbedBuilder}
 */
export function buildSlotChartEmbed(registration, entries = [], tournament = null) {
  const fullText = buildSlotListText(tournament, registration, entries);
  const title = buildSlotListTitle(tournament?.name, registration.displayName);
  const isOpen = registration.status === 'OPEN';

  return new EmbedBuilder()
    .setColor(isOpen ? 0x22c55e : registration.status === 'CLOSED' ? 0xef4444 : 0x3b82f6)
    .setTitle(title)
    .setDescription(fullText)
    .setTimestamp();
}

/**
 * Updates or creates the persistent slot list message in the registration's IDP channel.
 * Edits the existing message in-place using its stored Discord message ID.
 * Avoids unnecessary embeds or decorative content to ensure maximum mobile readability.
 *
 * @param {import('discord.js').Client} client
 * @param {string} registrationId
 * @returns {Promise<boolean>}
 */
export async function updateSlotChartMessage(client, registrationId) {
  try {
    const registration = await getConfigurableRegistration(registrationId);
    if (!registration || !registration.idpChannelId) {
      return false;
    }

    const tournament = registration.tournamentId
      ? await getConfigurableTournament(registration.tournamentId)
      : null;

    const currentCycleId = registration.currentCycleId || null;
    const entries = await getConfigurableEntriesForRegistration(registrationId, currentCycleId);

    const channel = await client.channels.fetch(registration.idpChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      return false;
    }

    const chunks = buildSlotListChunks(tournament, registration, entries);

    const storedMessageIds = Array.isArray(registration.slotChartMessageIds) && registration.slotChartMessageIds.length > 0
      ? [...registration.slotChartMessageIds]
      : registration.slotChartMessageId ? [registration.slotChartMessageId] : [];

    const updatedMessageIds = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];
      const existingId = storedMessageIds[i];

      if (existingId) {
        try {
          const existingMsg = await channel.messages.fetch(existingId).catch(() => null);
          if (existingMsg) {
            await existingMsg.edit({ content: chunkText, embeds: [] });
            updatedMessageIds.push(existingId);
            continue;
          }
        } catch (err) {
          console.warn(`[SlotChart] ⚠️ Could not edit existing message ${existingId}:`, err.message);
        }
      }

      // Send new persistent message
      const newMsg = await channel.send({ content: chunkText });
      updatedMessageIds.push(newMsg.id);
    }

    // Cleanup extra messages if chunks decreased
    if (storedMessageIds.length > chunks.length) {
      for (let i = chunks.length; i < storedMessageIds.length; i++) {
        const extraId = storedMessageIds[i];
        try {
          const extraMsg = await channel.messages.fetch(extraId).catch(() => null);
          if (extraMsg) await extraMsg.delete().catch(() => null);
        } catch {}
      }
    }

    registration.slotChartMessageId = updatedMessageIds[0] || null;
    registration.slotChartMessageIds = updatedMessageIds;
    await saveConfigurableRegistration(registration);
    return true;
  } catch (err) {
    console.error(`[SlotChart] ❌ Error updating slot chart for ${registrationId}:`, err);
    return false;
  }
}

/**
 * Organiser tool: changes an allocated team's slot number within the current cycle.
 * Validates target slot is non-reserved and unassigned, then updates slot list in place.
 *
 * @param {string} registrationId
 * @param {string} teamId
 * @param {number} newSlotNumber
 * @param {import('discord.js').Client} [client]
 * @returns {Promise<{ success: boolean, message?: string }>}
 */
export async function changeTeamSlot(registrationId, teamId, newSlotNumber, client = null) {
  const reg = await getConfigurableRegistration(registrationId);
  if (!reg) return { success: false, message: 'Registration not found' };

  if (newSlotNumber < 1 || newSlotNumber > reg.totalSlots) {
    return { success: false, message: `Slot number must be between 1 and ${reg.totalSlots}` };
  }

  const reservedList = parseReservedSlots(reg.reservedSlots, reg.totalSlots);
  if (reservedList.includes(newSlotNumber)) {
    return { success: false, message: `Slot ${newSlotNumber} is LOCKED / Reserved.` };
  }

  const currentCycleId = reg.currentCycleId || null;
  const entries = await getConfigurableEntriesForRegistration(registrationId, currentCycleId);
  const targetOccupied = entries.find((e) => e.slotNumber === newSlotNumber);
  if (targetOccupied && targetOccupied.teamId !== teamId) {
    return { success: false, message: `Slot ${newSlotNumber} is already occupied by ${targetOccupied.teamName}.` };
  }

  const teamEntry = entries.find((e) => e.teamId === teamId);
  if (!teamEntry) {
    return { success: false, message: 'Team is not registered in this cycle.' };
  }

  teamEntry.slotNumber = newSlotNumber;
  await saveConfigurableEntry(teamEntry);

  if (client) {
    await updateSlotChartMessage(client, registrationId);
  }

  return { success: true };
}

/**
 * Organiser tool: removes a team from a registration cycle.
 * Releases their slot, updates the persistent slot list, and revokes IDP channel access.
 *
 * @param {string} registrationId
 * @param {string} teamId
 * @param {import('discord.js').Client} [client]
 * @returns {Promise<{ success: boolean, message?: string }>}
 */
export async function removeTeamFromRegistration(registrationId, teamId, client = null) {
  const reg = await getConfigurableRegistration(registrationId);
  if (!reg) return { success: false, message: 'Registration not found' };

  const currentCycleId = reg.currentCycleId || null;
  const entry = await getConfigurableEntry(registrationId, teamId, currentCycleId);
  if (!entry) {
    return { success: false, message: 'Team registration entry not found in current cycle.' };
  }

  await deleteConfigurableEntry(registrationId, teamId, currentCycleId);

  // Revoke IDP access
  if (client && reg.idpChannelId && entry.leaderDiscordId) {
    try {
      const guild = await client.guilds.fetch(reg.guildId).catch(() => null);
      const idpChannel = guild ? await guild.channels.fetch(reg.idpChannelId).catch(() => null) : null;
      if (idpChannel && typeof idpChannel.permissionOverwrites?.delete === 'function') {
        await idpChannel.permissionOverwrites.delete(entry.leaderDiscordId).catch(() => {});
      }
    } catch {}
  }

  if (client) {
    await updateSlotChartMessage(client, registrationId);
  }

  return { success: true };
}
