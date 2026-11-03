import { EmbedBuilder } from 'discord.js';
import {
  getConfigurableRegistration,
  getConfigurableEntriesForRegistration,
  saveConfigurableRegistration,
  parseReservedSlots,
} from './configurableTournamentData.js';

/**
 * Builds the Embed for a Slot Chart.
 * @param {object} registration
 * @param {Array<object>} entries
 * @returns {EmbedBuilder}
 */
export function buildSlotChartEmbed(registration, entries = []) {
  const totalSlots = registration.totalSlots || 20;
  const reservedSlotsList = parseReservedSlots(registration.reservedSlots, totalSlots);
  const reservedSet = new Set(reservedSlotsList);
  const reservedCount = reservedSet.size;

  const occupiedMap = new Map();
  for (const entry of entries) {
    occupiedMap.set(entry.slotNumber, entry);
  }

  const filledCount = entries.length;
  const maxAvailable = Math.max(0, totalSlots - reservedCount);
  const availableCount = Math.max(0, maxAvailable - filledCount);
  const isOpen = registration.status === 'OPEN';

  const reservedSummary = reservedSlotsList.length > 0 ? reservedSlotsList.join(', ') : 'None';
  const scheduleLine = (registration.dailyStartTime || registration.dailyResetTime)
    ? `\n**Daily Cycle:** Opens at \`${registration.dailyStartTime || 'N/A'}\` | Resets at \`${registration.dailyResetTime || 'N/A'}\``
    : '';

  const embed = new EmbedBuilder()
    .setColor(isOpen ? 0x22c55e : registration.status === 'CLOSED' ? 0xef4444 : 0x3b82f6)
    .setTitle(`📋 Slot Chart — ${registration.displayName || 'Tournament'}`)
    .setDescription(
      `**Status:** \`${registration.status || 'OPEN'}\`\n` +
      `**Filled:** \`${filledCount}/${maxAvailable}\` | **Reserved / Locked:** \`${reservedSummary}\` | **Available:** \`${availableCount}\`${scheduleLine}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━`
    )
    .setTimestamp();

  // Divide slots into 10-slot chunks for clean presentation
  const chunkSize = 10;
  const totalChunks = Math.ceil(totalSlots / chunkSize);

  for (let c = 0; c < totalChunks; c++) {
    const start = c * chunkSize + 1;
    const end = Math.min((c + 1) * chunkSize, totalSlots);
    const lines = [];

    for (let slot = start; slot <= end; slot++) {
      const paddedSlot = String(slot).padStart(2, '0');
      const entry = occupiedMap.get(slot);
      if (entry) {
        lines.push(`\`[#${paddedSlot}]\` **${entry.teamName}** (<@${entry.leaderDiscordId}>)`);
      } else if (reservedSet.has(slot)) {
        lines.push(`\`[#${paddedSlot}]\` 🔒 *[Reserved / Locked]*`);
      } else {
        lines.push(`\`[#${paddedSlot}]\` *[Available]*`);
      }
    }

    embed.addFields({
      name: `Slots ${String(start).padStart(2, '0')} - ${String(end).padStart(2, '0')}`,
      value: lines.join('\n') || '*None*',
      inline: false,
    });
  }

  return embed;
}

/**
 * Updates or creates the persistent slot chart message in the IDP channel.
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

    const entries = await getConfigurableEntriesForRegistration(registrationId);
    const embed = buildSlotChartEmbed(registration, entries);

    const channel = await client.channels.fetch(registration.idpChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      return false;
    }

    if (registration.slotChartMessageId) {
      try {
        const existingMsg = await channel.messages.fetch(registration.slotChartMessageId).catch(() => null);
        if (existingMsg) {
          await existingMsg.edit({ embeds: [embed] });
          return true;
        }
      } catch (err) {
        console.warn(`[SlotChart] ⚠️ Could not edit existing message ${registration.slotChartMessageId}:`, err.message);
      }
    }

    // Send new persistent slot chart message
    const newMsg = await channel.send({ embeds: [embed] });
    registration.slotChartMessageId = newMsg.id;
    await saveConfigurableRegistration(registration);
    return true;
  } catch (err) {
    console.error(`[SlotChart] ❌ Error updating slot chart for ${registrationId}:`, err);
    return false;
  }
}

