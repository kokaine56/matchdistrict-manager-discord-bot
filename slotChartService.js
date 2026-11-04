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
  const reservedCount = parseReservedSlots(registration.reservedSlots, totalSlots);
  const unlockedTotal = Math.max(0, totalSlots - reservedCount);

  const occupiedMap = new Map();
  for (const entry of entries) {
    occupiedMap.set(entry.slotNumber, entry);
  }

  const title = buildSlotListTitle(tournament?.name, registration.displayName);
  const lines = [title];

  let occupiedUnlockedCount = 0;

  for (let slot = 1; slot <= totalSlots; slot++) {
    const padded = String(slot).padStart(2, '0');
    if (slot <= reservedCount) {
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

let activeDiscordClient = null;

/**
 * Sets the active Discord client reference for slot list updates.
 * @param {import('discord.js').Client} client
 */
export function setSlotChartClient(client) {
  activeDiscordClient = client;
}

/**
 * Gets the active Discord client reference.
 * @returns {import('discord.js').Client|null}
 */
export function getSlotChartClient() {
  return activeDiscordClient;
}

/**
 * Updates or creates the persistent slot list message in the registration's IDP channel.
 * Real-time synchronization service:
 * 1. Retrieves registration.
 * 2. Retrieves current cycle.
 * 3. Retrieves all active registration entries from MongoDB.
 * 4. Retrieves reserved slot configuration.
 * 5. Builds every slot sequentially from 01 through total capacity.
 * 6. Marks reserved slots 🔒 LOCKED.
 * 7. Marks occupied slots with their team names.
 * 8. Marks remaining slots AVAILABLE.
 * 9. Updates the existing Discord message in-place without duplicates.
 *
 * Supports flexible signatures:
 * - updateRegistrationSlotList(registrationId, [cycleId], [client])
 * - updateRegistrationSlotList(client, registrationId, [cycleId])
 *
 * @param {string|import('discord.js').Client} firstArg
 * @param {string|import('discord.js').Client} [secondArg]
 * @param {string|import('discord.js').Client} [thirdArg]
 * @returns {Promise<boolean>}
 */
export async function updateRegistrationSlotList(firstArg, secondArg = null, thirdArg = null) {
  let client = null;
  let registrationId = null;
  let cycleId = null;

  if (typeof firstArg === 'string') {
    registrationId = firstArg;
    if (secondArg && typeof secondArg === 'object' && (secondArg.channels || secondArg.guilds || secondArg.user)) {
      client = secondArg;
      cycleId = typeof thirdArg === 'string' ? thirdArg : null;
    } else {
      cycleId = typeof secondArg === 'string' ? secondArg : null;
      client = thirdArg || activeDiscordClient;
    }
  } else {
    client = firstArg || activeDiscordClient;
    registrationId = secondArg;
    cycleId = typeof thirdArg === 'string' ? thirdArg : null;
  }

  if (!client) {
    client = activeDiscordClient;
  }

  try {
    if (!registrationId) return false;

    const registration = await getConfigurableRegistration(registrationId);
    if (!registration || !registration.idpChannelId) {
      return false;
    }

    const tournament = registration.tournamentId
      ? await getConfigurableTournament(registration.tournamentId)
      : null;

    const currentCycleId = cycleId || registration.currentCycleId || null;
    // Always fetch latest entries directly from MongoDB for this registration instance and cycle
    const entries = await getConfigurableEntriesForRegistration(registrationId, currentCycleId);

    if (!client) {
      console.warn(`[SlotChart] ⚠️ Discord client not available for updating slot list of ${registrationId}`);
      return false;
    }

    let channel = null;
    if (client.channels?.fetch) {
      channel = await client.channels.fetch(registration.idpChannelId).catch(() => null);
    }
    if (!channel && registration.guildId && client.guilds?.fetch) {
      const guild = await client.guilds.fetch(registration.guildId).catch(() => null);
      if (guild?.channels?.fetch) {
        channel = await guild.channels.fetch(registration.idpChannelId).catch(() => null);
      }
    }

    if (!channel) {
      return false;
    }
    const isText = typeof channel.isTextBased === 'function' ? channel.isTextBased() : Boolean(channel.send);
    if (!isText) {
      return false;
    }

    const title = buildSlotListTitle(tournament?.name, registration.displayName || registration.name);
    const chunks = buildSlotListChunks(tournament, registration, entries);

    const storedMessageIds = Array.isArray(registration.slotChartMessageIds) && registration.slotChartMessageIds.length > 0
      ? [...registration.slotChartMessageIds]
      : registration.slotChartMessageId ? [registration.slotChartMessageId] : [];

    const updatedMessageIds = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];
      let existingMsg = null;
      const existingId = storedMessageIds[i];

      if (existingId) {
        try {
          existingMsg = await channel.messages.fetch(existingId).catch(() => null);
        } catch {}
      }

      // If stored message was missing or not found, check recent channel messages before sending to prevent duplicates
      if (!existingMsg && i === 0 && channel.messages?.fetch) {
        try {
          const recent = await channel.messages.fetch({ limit: 10 }).catch(() => null);
          if (recent) {
            existingMsg = recent.find((m) => m.content && (m.content.startsWith(title) || m.content.includes('Slot 01')));
          }
        } catch {}
      }

      if (existingMsg) {
        try {
          await existingMsg.edit({ content: chunkText, embeds: [] });
          updatedMessageIds.push(existingMsg.id);
          continue;
        } catch (err) {
          console.warn(`[SlotChart] ⚠️ Could not edit existing message ${existingMsg.id}:`, err.message);
        }
      }

      // Send new persistent message only if no existing message was found
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
 * Alias for updateRegistrationSlotList to ensure 100% backward compatibility.
 */
export const updateSlotChartMessage = updateRegistrationSlotList;

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

  const reservedCount = parseReservedSlots(reg.reservedSlots, reg.totalSlots);
  if (newSlotNumber <= reservedCount) {
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

  const resolvedClient = client || activeDiscordClient;
  if (resolvedClient) {
    await updateRegistrationSlotList(registrationId, currentCycleId, resolvedClient);
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
  const resolvedClient = client || activeDiscordClient;
  if (resolvedClient && reg.idpChannelId && entry.leaderDiscordId) {
    try {
      const guild = await resolvedClient.guilds.fetch(reg.guildId).catch(() => null);
      const idpChannel = guild ? await guild.channels.fetch(reg.idpChannelId).catch(() => null) : null;
      if (idpChannel && typeof idpChannel.permissionOverwrites?.delete === 'function') {
        await idpChannel.permissionOverwrites.delete(entry.leaderDiscordId).catch(() => {});
      }
    } catch {}
  }

  if (resolvedClient) {
    await updateRegistrationSlotList(registrationId, currentCycleId, resolvedClient);
  }

  return { success: true };
}
