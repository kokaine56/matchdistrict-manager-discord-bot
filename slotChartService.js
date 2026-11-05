import { EmbedBuilder } from 'discord.js';
import {
  getConfigurableRegistration,
  getConfigurableTournament,
  getConfigurableTeam,
  getConfigurableEntry,
  getConfigurableEntriesForRegistration,
  saveConfigurableRegistration,
  saveConfigurableEntry,
  deleteConfigurableEntry,
  parseReservedSlots,
} from './configurableTournamentData.js';

/**
 * Extracts the short code for a tournament name (e.g. "T3 Scrims" -> "T3").
 * @param {string} [tournamentName]
 * @returns {string}
 */
export function extractTournamentShortCode(tournamentName) {
  if (!tournamentName || typeof tournamentName !== 'string') return '';
  const trimmed = tournamentName.trim();
  if (!trimmed) return '';
  const words = trimmed
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0];
  const firstWord = words[0];
  if (firstWord.length <= 4 && /\d/.test(firstWord)) {
    return firstWord;
  }
  const nonNumberWords = words.filter((w) => !/^\d+$/.test(w));
  if (nonNumberWords.length === 0) return firstWord;
  if (nonNumberWords.length === 1) return nonNumberWords[0];
  const initials = nonNumberWords
    .map((w) => {
      const m = w.match(/[\p{L}\p{N}]/u);
      return m ? m[0].toUpperCase() : '';
    })
    .filter(Boolean)
    .join('');
  return initials || firstWord;
}

/**
 * Builds the canonical title for a slot list message:
 * "<tournament name> <registration name> Slotlist"
 * If the registration name already starts with the tournament's short code
 * (for example "T3 10PM" in tournament "T3 Scrims"), uses only the rest of the name ("10PM").
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
    const rest = rName.slice(tName.length).trim();
    return rest ? `${tName} ${rest} Slotlist` : `${tName} Slotlist`;
  }

  // If registration name starts with the tournament's short code (e.g. "T3 10PM" in "T3 Scrims"),
  // use only the rest of the name ("10PM") so the code isn't repeated.
  const shortCode = extractTournamentShortCode(tName);
  if (shortCode) {
    const escapedCode = shortCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const codePrefixRegex = new RegExp(`^${escapedCode}\\s+(.+)$`, 'i');
    const match = rName.match(codePrefixRegex);
    if (match && match[1]) {
      return `${tName} ${match[1].trim()} Slotlist`;
    }
  }

  return `${tName} ${rName} Slotlist`;
}

/**
 * Generates the status circle emoji counter for the bottom of the slot list:
 * - ⚪ when 0 filled
 * - 🟡 when partly filled
 * - 🟢 when all filled
 *
 * @param {number} occupiedCount
 * @param {number} unlockedTotal
 * @returns {string}
 */
export function getFilledSlotCounter(occupiedCount, unlockedTotal) {
  if (unlockedTotal <= 0 || occupiedCount <= 0) {
    return `⚪ 0/${Math.max(0, unlockedTotal)} filled`;
  }

  const emoji = occupiedCount >= unlockedTotal ? '🟢' : '🟡';
  return `${emoji} ${occupiedCount}/${unlockedTotal} filled`;
}

/**
 * Wraps the slot list text in a triple-backtick code block for one-click copy-paste.
 * @param {string} text
 * @returns {string}
 */
export function formatSlotListCodeBlock(text) {
  const trimmed = String(text || '').trim();
  if (trimmed.startsWith('```') && trimmed.endsWith('```')) {
    return trimmed;
  }
  return `\`\`\`\n${trimmed}\n\`\`\``;
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
 * 🟢 1/16 filled
 *
 * Rules enforced:
 * - Do not count reserved slots as occupied.
 * - Do not count the same team twice.
 * - Coerce slotNumber to Number.
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
  const seenTeams = new Set();

  for (const entry of entries) {
    if (!entry) continue;
    if (entry.status && !['CONFIRMED', 'REGISTERED'].includes(entry.status)) continue;
    const slotNum = Number(entry.slotNumber);
    if (!Number.isInteger(slotNum) || slotNum <= reservedCount || slotNum > totalSlots) {
      continue;
    }
    const teamKey = entry.teamId || (entry.teamName || '').trim().toLowerCase();
    if (teamKey && seenTeams.has(teamKey)) {
      continue;
    }
    if (!occupiedMap.has(slotNum) && entry.teamName) {
      occupiedMap.set(slotNum, entry);
      if (teamKey) seenTeams.add(teamKey);
    }
  }

  const title = buildSlotListTitle(tournament?.name, registration.displayName || registration.name);
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
 * Single reusable synchronization service: syncRegistrationSlotList(registrationId, cycleId, [client], [context])
 * 1. Reads current registration configuration.
 * 2. Reads the current daily cycle.
 * 3. Reads all active registration entries from MongoDB.
 * 4. Detects & logs discrepancies if 0 entries are found after a successful registration.
 * 5. Builds all slot states and exact counters.
 * 6. Updates the correct existing Discord message in-place (never creates duplicates during normal sync).
 * 7. Records synchronization status and errors, and outputs structured diagnostic logs.
 *
 * Supports flexible signatures:
 * - syncRegistrationSlotList(registrationId, [cycleId], [client], [context])
 * - syncRegistrationSlotList(client, registrationId, [cycleId], [context])
 *
 * @param {string|import('discord.js').Client} firstArg
 * @param {string|import('discord.js').Client} [secondArg]
 * @param {string|import('discord.js').Client|object} [thirdArg]
 * @param {object} [fourthArg]
 * @returns {Promise<boolean>}
 */
export async function syncRegistrationSlotList(firstArg, secondArg = null, thirdArg = null, fourthArg = null) {
  let client = null;
  let registrationId = null;
  let cycleId = null;
  let context = null;

  if (typeof firstArg === 'string') {
    registrationId = firstArg;
    if (secondArg && typeof secondArg === 'object' && (secondArg.channels || secondArg.guilds || secondArg.user)) {
      client = secondArg;
      if (typeof thirdArg === 'string') {
        cycleId = thirdArg;
        context = fourthArg && typeof fourthArg === 'object' ? fourthArg : null;
      } else if (thirdArg && typeof thirdArg === 'object') {
        context = thirdArg;
      }
    } else {
      cycleId = typeof secondArg === 'string' ? secondArg : null;
      if (thirdArg && typeof thirdArg === 'object' && (thirdArg.channels || thirdArg.guilds || thirdArg.user)) {
        client = thirdArg;
        context = fourthArg && typeof fourthArg === 'object' ? fourthArg : null;
      } else if (thirdArg && typeof thirdArg === 'object') {
        context = thirdArg;
        client = activeDiscordClient;
      } else {
        client = activeDiscordClient;
        context = fourthArg && typeof fourthArg === 'object' ? fourthArg : null;
      }
    }
  } else {
    client = firstArg || activeDiscordClient;
    registrationId = secondArg;
    if (typeof thirdArg === 'string') {
      cycleId = thirdArg;
      context = fourthArg && typeof fourthArg === 'object' ? fourthArg : null;
    } else if (thirdArg && typeof thirdArg === 'object') {
      context = thirdArg;
    }
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

    // Fetch latest active entries directly from MongoDB for this registration instance and cycle
    let entries = await getConfigurableEntriesForRegistration(registrationId, currentCycleId);

    // Discrepancy check: If zero entries are found after a successful registration (or expected entry is missing),
    // log the discrepancy and inspect all active entries for this registrationId instead of silently displaying 0/16.
    if (
      (entries.length === 0 && (context?.expectEntries || context?.entryId || context?.teamId)) ||
      (context?.entryId && !entries.some((e) => e.entryId === context.entryId))
    ) {
      console.error(
        `[SlotChart] 🚨 DISCREPANCY DETECTED: Expected active entry [entryId=${context?.entryId || 'N/A'}, teamId=${context?.teamId || 'N/A'}, slot=${context?.slotNumber ?? 'N/A'}] ` +
        `not found in query for registrationId=${registrationId}, cycleId=${currentCycleId} (found=${entries.length}). Inspecting all active entries for registrationId...`
      );
      const allActiveForReg = await getConfigurableEntriesForRegistration(registrationId, null);
      if (allActiveForReg.length > 0) {
        console.warn(
          `[SlotChart] ⚠️ Recovered ${allActiveForReg.length} active entry/entries for registrationId=${registrationId} with mismatched cycleId(s): ` +
          `${allActiveForReg.map((e) => `${e.teamName}(#${e.slotNumber}, cycle=${e.cycleId})`).join(', ')}`
        );
        for (const recEntry of allActiveForReg) {
          if (currentCycleId && recEntry.cycleId !== currentCycleId) {
            recEntry.cycleId = currentCycleId;
            await saveConfigurableEntry(recEntry);
          }
        }
        entries = allActiveForReg;
      }
    }

    // Ensure every entry has the actual teamName from MongoDB
    for (const entry of entries) {
      if (!entry.teamName && entry.teamId) {
        const teamDoc = await getConfigurableTeam(entry.teamId);
        if (teamDoc?.teamName) {
          entry.teamName = teamDoc.teamName;
        }
      }
    }

    const totalSlots = registration.totalSlots || 20;
    const reservedCount = parseReservedSlots(registration.reservedSlots, totalSlots);
    const unlockedTotal = Math.max(0, totalSlots - reservedCount);

    // Count valid occupied unlocked slots (excluding reserved slots and duplicate teams)
    const occupiedSlotsSet = new Set();
    const seenTeamsSet = new Set();
    for (const entry of entries) {
      const slotNum = Number(entry.slotNumber);
      if (!Number.isInteger(slotNum) || slotNum <= reservedCount || slotNum > totalSlots) continue;
      const teamKey = entry.teamId || (entry.teamName || '').trim().toLowerCase();
      if (teamKey && seenTeamsSet.has(teamKey)) continue;
      if (!occupiedSlotsSet.has(slotNum) && entry.teamName) {
        occupiedSlotsSet.add(slotNum);
        if (teamKey) seenTeamsSet.add(teamKey);
      }
    }
    const occupiedCount = occupiedSlotsSet.size;
    const availableCount = Math.max(0, unlockedTotal - occupiedCount);

    if (!client) {
      console.warn(
        `[SlotChart] ⚠️ Discord client not available for updating slot list ` +
        JSON.stringify({
          registrationId,
          cycleId: currentCycleId,
          teamId: context?.teamId || null,
          allocatedSlotNumber: context?.slotNumber ?? null,
          entryId: context?.entryId || null,
          activeEntriesFound: entries.length,
          occupiedSlotsCount: occupiedCount,
          slotChartMessageId: registration.slotChartMessageId || null,
          idpChannelId: registration.idpChannelId,
          discordUpdateResult: 'SKIPPED_NO_CLIENT',
        })
      );
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
      console.warn(
        `[SlotChart] ⚠️ IDP channel not reachable ` +
        JSON.stringify({
          registrationId,
          cycleId: currentCycleId,
          teamId: context?.teamId || null,
          allocatedSlotNumber: context?.slotNumber ?? null,
          entryId: context?.entryId || null,
          activeEntriesFound: entries.length,
          occupiedSlotsCount: occupiedCount,
          slotChartMessageId: registration.slotChartMessageId || null,
          idpChannelId: registration.idpChannelId,
          discordUpdateResult: 'FAILED_CHANNEL_NOT_FOUND',
        })
      );
      return false;
    }
    const isText = typeof channel.isTextBased === 'function' ? channel.isTextBased() : Boolean(channel.send);
    if (!isText) {
      return false;
    }

    const title = buildSlotListTitle(tournament?.name, registration.displayName || registration.name);
    const chunks = buildSlotListChunks(tournament, registration, entries);

    const storedMessageIds = [];
    if (registration.slotChartMessageId) {
      storedMessageIds.push(registration.slotChartMessageId);
    }
    if (Array.isArray(registration.slotChartMessageIds)) {
      for (const id of registration.slotChartMessageIds) {
        if (id && !storedMessageIds.includes(id)) {
          storedMessageIds.push(id);
        }
      }
    }

    const updatedMessageIds = [];
    let discordUpdateResult = 'UPDATED';

    for (let i = 0; i < chunks.length; i++) {
      const chunkText = formatSlotListCodeBlock(chunks[i]);
      let existingMsg = null;
      let fetchErrorCode = null;
      const existingId = storedMessageIds[i];

      if (existingId && channel.messages?.fetch) {
        try {
          existingMsg = await channel.messages.fetch(existingId);
        } catch (fetchErr) {
          fetchErrorCode = fetchErr?.code || null;
          existingMsg = null;
        }
      }

      // If stored message was not found by ID, check recent channel messages before sending to prevent duplicates
      if (!existingMsg && i === 0 && channel.messages?.fetch) {
        try {
          const recent = await channel.messages.fetch({ limit: 10 }).catch(() => null);
          if (recent && typeof recent.find === 'function') {
            existingMsg = recent.find((m) => m.content && (m.content.includes(title) || m.content.includes('Slot 01')));
          }
        } catch {}
      }

      if (existingMsg) {
        try {
          await existingMsg.edit({ content: chunkText, embeds: [] });
          updatedMessageIds.push(existingMsg.id);
          discordUpdateResult = 'EDITED_EXISTING';
          continue;
        } catch (editErr) {
          // If the message was genuinely deleted in Discord (10008 Unknown Message), recreate it once below.
          // Otherwise, do NOT create a duplicate message; fail and allow separate retry synchronization!
          if (editErr?.code !== 10008) {
            console.error(
              `[SlotChart] ❌ Failed to edit existing slot-list message ` +
              JSON.stringify({
                registrationId,
                cycleId: currentCycleId,
                teamId: context?.teamId || null,
                allocatedSlotNumber: context?.slotNumber ?? null,
                entryId: context?.entryId || null,
                activeEntriesFound: entries.length,
                occupiedSlotsCount: occupiedCount,
                slotChartMessageId: existingMsg.id,
                idpChannelId: registration.idpChannelId,
                discordUpdateResult: `EDIT_FAILED: ${editErr.message}`,
              })
            );
            const latestReg = (await getConfigurableRegistration(registrationId)) || registration;
            latestReg.lastSlotSyncStatus = 'FAILED';
            latestReg.lastSlotSyncError = editErr.message;
            latestReg.lastSlotSyncAt = new Date();
            await saveConfigurableRegistration(latestReg);
            return false;
          }
          console.warn(`[SlotChart] ⚠️ Stored message ${existingMsg.id} no longer exists in Discord (10008); recreating once.`);
        }
      } else if (existingId && fetchErrorCode && fetchErrorCode !== 10008) {
        // Fetching existing message failed due to a transient error (not 10008 Unknown Message)
        console.error(
          `[SlotChart] ❌ Transient error fetching existing slot-list message ${existingId} (code: ${fetchErrorCode}); skipping duplicate send.`
        );
        return false;
      }

      // Send new persistent message only if no existing message exists
      const newMsg = await channel.send({ content: chunkText });
      updatedMessageIds.push(newMsg.id);
      discordUpdateResult = existingId ? 'RECREATED_MISSING_MESSAGE' : 'CREATED_INITIAL_MESSAGE';
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

    const latestReg = (await getConfigurableRegistration(registrationId)) || registration;
    latestReg.slotChartMessageId = updatedMessageIds[0] || null;
    latestReg.slotChartMessageIds = updatedMessageIds;
    latestReg.lastSlotSyncStatus = 'SYNCED';
    latestReg.lastSlotSyncError = null;
    latestReg.lastSlotSyncAt = new Date();
    await saveConfigurableRegistration(latestReg);

    const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null;
    console.log(
      `[SlotChart] ✅ SlotListSyncDiag ` +
      JSON.stringify({
        registrationId,
        cycleId: currentCycleId,
        teamId: context?.teamId || lastEntry?.teamId || null,
        allocatedSlotNumber: context?.slotNumber ?? lastEntry?.slotNumber ?? null,
        entryId: context?.entryId || lastEntry?.entryId || null,
        activeEntriesFound: entries.length,
        occupiedSlotsCount: occupiedCount,
        availableSlotsCount: availableCount,
        slotChartMessageId: latestReg.slotChartMessageId,
        idpChannelId: latestReg.idpChannelId,
        discordUpdateResult,
      })
    );

    return true;
  } catch (err) {
    console.error(
      `[SlotChart] ❌ Error in syncRegistrationSlotList ` +
      JSON.stringify({
        registrationId,
        cycleId,
        teamId: context?.teamId || null,
        allocatedSlotNumber: context?.slotNumber ?? null,
        entryId: context?.entryId || null,
        discordUpdateResult: `ERROR: ${err.message}`,
      }),
      err
    );
    return false;
  }
}

/**
 * Retries slot-list synchronization separately if the initial Discord message edit failed,
 * without ever re-allocating a slot.
 *
 * @param {string} registrationId
 * @param {string} cycleId
 * @param {import('discord.js').Client} [client]
 * @param {object} [context]
 * @param {number} [maxRetries]
 * @returns {Promise<boolean>}
 */
export async function retrySlotListSync(registrationId, cycleId, client = null, context = null, maxRetries = 2) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await new Promise((r) => setTimeout(r, attempt * 150));
    const ok = await syncRegistrationSlotList(registrationId, cycleId, client, context);
    if (ok) {
      if (context?.teamId) {
        const entry = await getConfigurableEntry(registrationId, context.teamId, cycleId);
        if (entry) {
          entry.synchronized = true;
          entry.slotSyncStatus = 'SYNCED';
          entry.slotSyncedAt = new Date();
          await saveConfigurableEntry(entry);
        }
      }
      console.log(`[SlotChart] 🔄 Separate retry #${attempt} succeeded for registrationId=${registrationId}, cycleId=${cycleId}`);
      return true;
    }
  }
  console.warn(`[SlotChart] ⚠️ Separate retry exhausted for registrationId=${registrationId}, cycleId=${cycleId}`);
  return false;
}

/**
 * Aliases for syncRegistrationSlotList to ensure 100% backward compatibility without duplicate services.
 */
export const updateRegistrationSlotList = syncRegistrationSlotList;
export const updateSlotChartMessage = syncRegistrationSlotList;

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
      let idpChannel = null;
      if (resolvedClient.channels?.fetch) {
        idpChannel = await resolvedClient.channels.fetch(reg.idpChannelId).catch(() => null);
      }
      if (!idpChannel && reg.guildId && resolvedClient.guilds?.fetch) {
        const guild = await resolvedClient.guilds.fetch(reg.guildId).catch(() => null);
        if (guild?.channels?.fetch) {
          idpChannel = await guild.channels.fetch(reg.idpChannelId).catch(() => null);
        }
      }
      if (idpChannel && typeof idpChannel.permissionOverwrites?.delete === 'function') {
        await idpChannel.permissionOverwrites.delete(entry.leaderDiscordId).catch(() => {});
      }
    } catch {}
  }

  if (resolvedClient) {
    await syncRegistrationSlotList(registrationId, currentCycleId, resolvedClient);
    const { updateRegistrationMessage } = await import('./configurableRegistrationService.js');
    await updateRegistrationMessage(resolvedClient, registrationId).catch(() => {});
  }

  return { success: true };
}
