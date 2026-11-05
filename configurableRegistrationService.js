import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
} from 'discord.js';
import crypto from 'node:crypto';
import {
  getConfigurableTournament,
  getConfigurableRegistration,
  getConfigurableRegistrationsForTournament,
  findConfigurableRegistrationByChannelId,
  findConfigurableRegistrationByMessageId,
  saveConfigurableRegistration,
  deleteConfigurableRegistration,
  getConfigurableTeamsForUser,
  getConfigurableTeam,
  getConfigurableEntry,
  getConfigurableEntriesForRegistration,
  getRegistrationEntriesCount,
  getNextAvailableSlot,
  saveConfigurableEntry,
  deleteConfigurableEntry,
  parseReservedSlots,
  parseTimeString,
  getCurrentTimeInTimezone,
  evaluateDailyCycleStatus,
  getDailyCyclesForRegistration,
} from './configurableTournamentData.js';
import { acquireLock, releaseLock } from './mongoService.js';
import {
  updateSlotChartMessage,
  updateRegistrationSlotList,
  syncRegistrationSlotList,
  retrySlotListSync,
  buildSlotChartEmbed,
  buildSlotListText,
} from './slotChartService.js';
import {
  TOURNAMENT_DENIED_PERMISSIONS,
  refreshDashboard,
  buildTournamentPrefix,
  toMathematicalBold,
  createTournamentChannel,
} from './configurableTournamentService.js';

/**
 * Safely reads a modal text input field without throwing if the field is absent.
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 * @param {string} fieldId
 * @returns {string}
 */
function getSafeFieldValue(interaction, fieldId) {
  try {
    const val = interaction?.fields?.getTextInputValue?.(fieldId);
    return typeof val === 'string' ? val.trim() : '';
  } catch {
    return '';
  }
}

/**
 * Formats a registration's daily start time into 12-hour AM/PM clock format (e.g. "11:00 AM").
 * @param {object} registration
 * @returns {string}
 */
export function formatRegistrationStartTime(registration) {
  const raw = registration?.rawDailyStartTime || registration?.dailyStartTime;
  if (!raw || typeof raw !== 'string') return 'N/A';
  const parsed = parseTimeString(raw);
  if (!parsed) return raw.trim();
  const meridiem = parsed.hours >= 12 ? 'PM' : 'AM';
  const hour12 = parsed.hours % 12 === 0 ? 12 : parsed.hours % 12;
  const mm = String(parsed.minutes).padStart(2, '0');
  return `${hour12}:${mm} ${meridiem}`;
}

/**
 * Resolves the display status of a registration instance:
 * - NOT OPENED YET — Before daily start time.
 * - OPEN — Registration is accepting teams.
 * - CLOSED — Organiser has manually closed registration or the daily cycle has ended.
 * - FULL — All available slots are occupied.
 *
 * @param {object} registration
 * @param {number} [filledCount]
 * @returns {'NOT OPENED YET' | 'OPEN' | 'CLOSED' | 'FULL'}
 */
export function resolveRegistrationStatus(registration, filledCount = 0) {
  if (!registration) return 'CLOSED';
  const totalSlots = Number(registration.totalSlots) > 0 ? Number(registration.totalSlots) : 20;
  const reservedCount = parseReservedSlots(registration.reservedSlots, totalSlots);
  const maxAvailable = Math.max(0, totalSlots - reservedCount);

  if (registration.status === 'FULL' || (maxAvailable > 0 && filledCount >= maxAvailable)) {
    return 'FULL';
  }
  if (
    registration.status === 'NOT OPENED YET' ||
    registration.status === 'UPCOMING' ||
    (registration.status === 'CLOSED' && registration.beforeStart === true && registration.manualOverride !== 'CLOSED')
  ) {
    return 'NOT OPENED YET';
  }
  if (registration.status === 'OPEN') {
    return 'OPEN';
  }
  if (registration.status === 'CLOSED') {
    return 'CLOSED';
  }
  return 'OPEN';
}

/**
 * Retrieves the verification channel ID from the tournament configuration.
 * @param {object} tournament
 * @returns {string|null}
 */
export function getTournamentVerifyChannelId(tournament) {
  if (!tournament) return null;
  return (
    tournament.standardChannels?.verifyChannelId ||
    tournament.verifyChannelId ||
    tournament.verificationChannelId ||
    tournament.enrollTeamChannelId ||
    null
  );
}

/**
 * Returns the clickable Discord channel mention (`<#channelId>`) for the tournament's verification channel.
 * @param {object} tournament
 * @returns {string}
 */
export function getTournamentVerifyChannelMention(tournament) {
  const channelId = getTournamentVerifyChannelId(tournament);
  return channelId ? `<#${channelId}>` : '#verify';
}

/**
 * Validates whether an enrolled team record is verified and active for the given tournament.
 * @param {object} team
 * @param {string} tournamentId
 * @returns {boolean}
 */
export function isTeamVerifiedForTournament(team, tournamentId) {
  if (!team || !tournamentId) return false;
  if (team.tournamentId !== tournamentId) return false;
  if (team.verified === false) return false;
  if (team.status === 'REVOKED' || team.status === 'UNVERIFIED' || team.status === 'DELETED' || team.isDeleted === true) {
    return false;
  }
  if (!team.leaderDiscordId) return false;
  return true;
}

/**
 * Builds the clean, compact registration message text for a registration channel:
 * <Registration Name>
 * Time: <Daily Start Time>
 * Status: <NOT OPENED YET | OPEN | CLOSED | FULL>
 * Slots: <Total Slot Capacity>
 * Matches: <Number of Matches>
 *
 * @param {object} registration
 * @param {number} [filledCount]
 * @returns {string}
 */
export function buildRegistrationMessageText(registration, filledCount = 0) {
  const regName = registration?.displayName || registration?.name || 'Registration';
  const timeStr = formatRegistrationStartTime(registration);
  const statusStr = resolveRegistrationStatus(registration, filledCount);
  const totalSlots = Number(registration?.totalSlots) > 0 ? Number(registration.totalSlots) : 20;
  const parsedMatches = parseInt(registration?.matches, 10);
  const matches = !isNaN(parsedMatches) && parsedMatches > 0 ? parsedMatches : 1;

  return [
    regName,
    `Time: ${timeStr}`,
    `Status: ${statusStr}`,
    `Slots: ${totalSlots}`,
    `Matches: ${matches}`,
  ].join('\n');
}

/**
 * Builds the Embed for a public Registration Channel.
 * @param {object} registration
 * @param {number} filledCount
 * @returns {EmbedBuilder}
 */
export function buildRegistrationEmbed(registration, filledCount = 0) {
  const statusStr = resolveRegistrationStatus(registration, filledCount);
  const isOpen = statusStr === 'OPEN';
  const text = buildRegistrationMessageText(registration, filledCount);

  return new EmbedBuilder()
    .setColor(isOpen ? 0x22c55e : statusStr === 'NOT OPENED YET' ? 0x3b82f6 : 0xef4444)
    .setTitle(registration?.displayName || registration?.name || 'Registration')
    .setDescription(text);
}

/**
 * Builds the register button component row.
 * @param {object} registration
 * @param {number} [filledCount]
 * @returns {ActionRowBuilder}
 */
export function buildRegistrationComponents(registration, filledCount = 0) {
  const statusStr = resolveRegistrationStatus(registration, filledCount);
  const isOpen = statusStr === 'OPEN';
  const button = new ButtonBuilder()
    .setCustomId(`md_cfg_reg_btn_${registration.registrationId}`)
    .setLabel('Register Squad')
    .setStyle(isOpen ? ButtonStyle.Success : ButtonStyle.Secondary)
    .setDisabled(false);

  return new ActionRowBuilder().addComponents(button);
}

/**
 * Updates or posts the persistent registration message in the registration channel.
 * Edits the existing persistent Discord message instead of sending duplicates.
 * @param {import('discord.js').Client} client
 * @param {string} registrationId
 * @returns {Promise<boolean>}
 */
export async function updateRegistrationMessage(client, registrationId) {
  try {
    if (!client || !registrationId) return false;
    const registration = await getConfigurableRegistration(registrationId);
    if (!registration || !registration.registrationChannelId) return false;

    let channel = null;
    if (client.channels?.fetch) {
      channel = await client.channels.fetch(registration.registrationChannelId).catch(() => null);
    }
    if (!channel && registration.guildId && client.guilds?.fetch) {
      const guild = await client.guilds.fetch(registration.guildId).catch(() => null);
      if (guild?.channels?.fetch) {
        channel = await guild.channels.fetch(registration.registrationChannelId).catch(() => null);
      }
    }
    if (!channel || !channel.isTextBased()) return false;

    const currentCycleId = registration.currentCycleId || null;
    const filledCount = await getRegistrationEntriesCount(registrationId, currentCycleId);
    const content = buildRegistrationMessageText(registration, filledCount);
    const row = buildRegistrationComponents(registration, filledCount);

    let existing = null;
    let fetchErrCode = null;
    if (registration.registrationMessageId && channel.messages?.fetch) {
      try {
        existing = await channel.messages.fetch(registration.registrationMessageId);
      } catch (err) {
        fetchErrCode = err?.code || null;
        existing = null;
      }
    }

    if (!existing && channel.messages?.fetch) {
      try {
        const recent = await channel.messages.fetch({ limit: 10 }).catch(() => null);
        if (recent && typeof recent.find === 'function') {
          existing = recent.find(
            (m) =>
              m.components?.some((r) =>
                r.components?.some((b) => (b.customId || b.data?.custom_id) === `md_cfg_reg_btn_${registrationId}`)
              ) ||
              (typeof m.content === 'string' && registration.displayName && m.content.startsWith(registration.displayName))
          );
        }
      } catch {}
    }

    if (existing) {
      await existing.edit({ content, embeds: [], components: [row] });
      if (registration.registrationMessageId !== existing.id) {
        registration.registrationMessageId = existing.id;
        await saveConfigurableRegistration(registration);
      }
      return true;
    }

    if (registration.registrationMessageId && fetchErrCode && fetchErrCode !== 10008) {
      // Transient error fetching existing message; do not post a duplicate
      return false;
    }

    const msg = await channel.send({ content, embeds: [], components: [row] });
    if (msg?.id) {
      registration.registrationMessageId = msg.id;
      await saveConfigurableRegistration(registration);
    }
    return true;
  } catch (err) {
    console.error(`[ConfigurableRegistration] ❌ Error updating registration message ${registrationId}:`, err);
    return false;
  }
}

/**
 * Displays the modal for adding a new registration instance asking for ONLY the 4 settings (5 inputs):
 * 1. Registration Name
 * 2. Slots (positive integer capacity)
 * 3. Reserved Slots (specific slot numbers locked)
 * 4. Daily Start Time (clock time in timezone)
 * 5. Daily Data Clear / Reset Time (clock time in timezone)
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} tournamentId
 */
export async function handleAddRegistrationButton(interaction, tournamentId) {
  const modal = new ModalBuilder()
    .setCustomId(`md_cfg_add_reg_modal_${tournamentId}`)
    .setTitle('Create Registration');

  const nameInput = new TextInputBuilder()
    .setCustomId('registration_name')
    .setLabel('Registration Name')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. T3 Registration 1, BGIS Qualifier A')
    .setMinLength(2)
    .setMaxLength(50)
    .setRequired(true);

  const capacityInput = new TextInputBuilder()
    .setCustomId('total_slots')
    .setLabel('Total Slots')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 16, 25, 32, 64, 100')
    .setRequired(true);

  const reservedInput = new TextInputBuilder()
    .setCustomId('reserved_slots')
    .setLabel('Reserved Slots (Count from Slot 01)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 2 (locks Slot 01 and Slot 02, or 0 for none)')
    .setRequired(false);

  const startInput = new TextInputBuilder()
    .setCustomId('daily_start_time')
    .setLabel('Daily Start Time (Timezone: IST)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 10:00 AM or 18:00')
    .setRequired(true);

  const resetInput = new TextInputBuilder()
    .setCustomId('daily_reset_time')
    .setLabel('Daily Reset Time (Timezone: IST)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 02:00 AM or 04:00')
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(nameInput),
    new ActionRowBuilder().addComponents(capacityInput),
    new ActionRowBuilder().addComponents(reservedInput),
    new ActionRowBuilder().addComponents(startInput),
    new ActionRowBuilder().addComponents(resetInput)
  );

  await interaction.showModal(modal);
}

/**
 * Handles submission of the Add Registration modal.
 * Validates inputs, creates registration & IDP channels, sets up daily schedule, and saves data.
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 * @param {string} tournamentId
 */
export async function handleAddRegistrationModalSubmit(interaction, tournamentId) {
  await interaction.deferReply({ ephemeral: true });

  const tournament = await getConfigurableTournament(tournamentId);
  if (!tournament) {
    return interaction.editReply({ content: '❌ Tournament configuration not found.' });
  }

  // Support both new 'registration_name' and fallback 'display_name'
  const displayName = (
    getSafeFieldValue(interaction, 'registration_name') ||
    getSafeFieldValue(interaction, 'display_name') ||
    ''
  ).trim();

  if (!displayName || displayName.length < 2) {
    return interaction.editReply({ content: '❌ Registration Name must be at least 2 characters long.' });
  }

  const rawTotalField = getSafeFieldValue(interaction, 'total_slots') || '';
  const totalParts = rawTotalField.split('|').map((s) => s.trim()).filter(Boolean);
  const rawTotal = parseInt(totalParts[0], 10);
  if (isNaN(rawTotal) || rawTotal <= 0) {
    return interaction.editReply({ content: '❌ Total Slots must be a positive integer (e.g. 16, 25, 32, 64).' });
  }
  const totalSlots = rawTotal;

  const rawMatchesField = getSafeFieldValue(interaction, 'matches') || totalParts[1] || '';
  let matches = 1;
  if (rawMatchesField !== '') {
    const parsedMatches = parseInt(rawMatchesField, 10);
    if (isNaN(parsedMatches) || parsedMatches <= 0) {
      return interaction.editReply({ content: '❌ Number of Matches must be a positive integer (e.g. 1, 2, 3).' });
    }
    matches = parsedMatches;
  }

  const rawReserved = getSafeFieldValue(interaction, 'reserved_slots') || '';
  const reservedSlots = parseReservedSlots(rawReserved, totalSlots);

  if (reservedSlots >= totalSlots) {
    return interaction.editReply({ content: '❌ Reserved slots count cannot equal or exceed total capacity.' });
  }

  // Daily Start Time (or fallback starts_at)
  const rawStart = (
    getSafeFieldValue(interaction, 'daily_start_time') ||
    getSafeFieldValue(interaction, 'starts_at') ||
    '10:00 AM'
  ).trim();
  const parsedStart = parseTimeString(rawStart);
  if (!parsedStart) {
    return interaction.editReply({
      content: `❌ Invalid Daily Start Time "${rawStart}". Please use a valid clock time such as "10:00 AM" or "18:00".`,
    });
  }

  // Daily Reset Time (or fallback ends_at)
  const rawReset = (
    getSafeFieldValue(interaction, 'daily_reset_time') ||
    getSafeFieldValue(interaction, 'ends_at') ||
    '02:00 AM'
  ).trim();
  const parsedReset = parseTimeString(rawReset);
  if (!parsedReset) {
    return interaction.editReply({
      content: `❌ Invalid Daily Reset Time "${rawReset}". Please use a valid clock time such as "02:00 AM" or "04:00".`,
    });
  }

  const timezone = tournament.timezone || 'Asia/Kolkata';
  const now = new Date();
  const cycleEval = evaluateDailyCycleStatus(parsedStart.formatted, parsedReset.formatted, timezone, now);
  const status = cycleEval.status;
  const currentCycleDate = cycleEval.cycleDate;

  // Monotonically increment registration number across all registrations (including deleted)
  // Never reuse the registration number of a deleted registration
  const allRegs = await getConfigurableRegistrationsForTournament(tournamentId, true);
  const highestRegNumber = allRegs.reduce((max, r) => Math.max(max, r.registrationNumber || 0), 0);
  const regNumber = highestRegNumber + 1;

  // Generate channel slugs
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20) || `group-${regNumber}`;

  const rawPrefix = tournament.prefix || (tournament.name ? buildTournamentPrefix(tournament.name) : 'md');
  const boldPrefix = tournament.boldPrefix || toMathematicalBold(rawPrefix);

  const guild = interaction.guild;
  const categoryId = tournament.categoryId;

  try {
    // 1. Create Public Registration Channel (Viewable by everyone, SendMessages disabled)
    const regChannel = await createTournamentChannel(guild, {
      boldPrefix,
      rawPrefix,
      fallbackSuffix: `${slug}-reg`,
      type: ChannelType.GuildText,
      parent: categoryId,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
          deny: [PermissionFlagsBits.SendMessages, ...TOURNAMENT_DENIED_PERMISSIONS],
        },
      ],
    });

    // 2. Create Private IDP Channel (Hidden from everyone by default)
    const idpChannel = await createTournamentChannel(guild, {
      boldPrefix,
      rawPrefix,
      fallbackSuffix: `${slug}-idp`,
      type: ChannelType.GuildText,
      parent: categoryId,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel, ...TOURNAMENT_DENIED_PERMISSIONS],
        },
      ],
    });

    const registrationId = crypto.randomUUID();
    const currentCycleId = `${registrationId}:${currentCycleDate}`;
    const registrationDoc = {
      registrationId,
      tournamentId,
      guildId: guild.id,
      registrationNumber: regNumber,
      displayName,
      registrationChannelId: regChannel.id,
      registrationMessageId: null,
      idpChannelId: idpChannel.id,
      slotChartMessageId: null,
      totalSlots,
      reservedSlots, // integer count (e.g. 2)
      matches,
      dailyStartTime: parsedStart.formatted,
      rawDailyStartTime: rawStart,
      dailyResetTime: parsedReset.formatted,
      rawDailyResetTime: rawReset,
      timezone,
      currentCycleId,
      currentCycleDate,
      currentCycleStartedAt: cycleEval.isOpen ? now : null,
      lastResetAt: null,
      lastResetCycleDate: cycleEval.endedCycleDate || null,
      beforeStart: cycleEval.beforeStart || false,
      status,
      createdAt: now,
    };

    await saveConfigurableRegistration(registrationDoc);

    // 3. Post Persistent Registration Message
    await updateRegistrationMessage(interaction.client, registrationId);

    // 4. Post Persistent Slot Chart Message in IDP channel
    await syncRegistrationSlotList(registrationId, currentCycleId, interaction.client);

    // 5. Refresh Setup Dashboard
    if (interaction.client) {
      await refreshDashboard(interaction.client, tournamentId).catch(() => {});
    }

    const reservedDisplay = reservedSlots > 0 ? `${reservedSlots} (01-${String(reservedSlots).padStart(2, '0')})` : 'None';

    await interaction.editReply({
      content:
        `✅ **Registration Instance Created!**\n\n` +
        `**Name:** ${displayName}\n` +
        `**Status:** \`${status}\` (Cycle: \`${currentCycleDate}\`)\n` +
        `**Total Slots:** ${totalSlots} (Reserved: ${reservedDisplay})\n` +
        `**Matches:** ${matches}\n` +
        `**Daily Schedule:** Opens at \`${parsedStart.formatted}\` | Resets at \`${parsedReset.formatted}\` (${timezone})\n` +
        `**Registration Channel:** <#${regChannel.id}>\n` +
        `**Private IDP Channel:** <#${idpChannel.id}>`,
    });
  } catch (err) {
    console.error('[ConfigurableRegistration] ❌ Failed to create registration channels:', err);
    await interaction.editReply({
      content: `❌ Error creating registration channels: ${err.message}`,
    });
  }
}

/**
 * Helper to reply, edit, or update confirmation interactions uniformly.
 * @param {import('discord.js').Interaction} interaction
 * @param {object} payload
 */
async function respondToConfirmationInteraction(interaction, payload) {
  try {
    if (interaction.deferred) {
      if (typeof interaction.editReply === 'function') {
        return await interaction.editReply(payload);
      }
      if (typeof interaction.update === 'function') {
        return await interaction.update(payload);
      }
      if (typeof interaction.reply === 'function') {
        return await interaction.reply(payload);
      }
    }
    if (typeof interaction.update === 'function' && interaction.isButton?.()) {
      return await interaction.update(payload);
    }
    if (!interaction.replied && typeof interaction.reply === 'function') {
      return await interaction.reply({ ...payload, ephemeral: true });
    }
    if (typeof interaction.editReply === 'function') {
      return await interaction.editReply(payload);
    }
    if (typeof interaction.followUp === 'function') {
      return await interaction.followUp({ ...payload, ephemeral: true });
    }
  } catch (err) {
    if (err?.code === 40060) return null;
    console.error(`[ConfigurableRegistration] ❌ Error in respondToConfirmationInteraction:`, err.message);
  }
}

const inFlightConfirmations = new Set();

/**
 * Handles the "Register Squad" button click in a registration channel.
 * Opens an ephemeral confirmation message with squad details, available slots,
 * and Confirm / Cancel buttons. Does NOT immediately register the team.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} registrationId
 */
export async function handleRegisterSquadButtonClick(interaction, registrationId) {
  // Resolve the registration from the channel ID or message ID where the button was clicked
  let registration = null;
  if (interaction?.channelId) {
    registration = await findConfigurableRegistrationByChannelId(interaction.channelId);
  }
  if (!registration && interaction?.message?.id) {
    registration = await findConfigurableRegistrationByMessageId(interaction.message.id);
  }
  if (!registration && registrationId) {
    registration = await getConfigurableRegistration(registrationId);
  }

  if (!registration || registration.status === 'DELETED' || registration.isDeleted) {
    return interaction.reply({
      content: '❌ Registration instance not found or has been deleted.',
      ephemeral: true,
    });
  }

  registrationId = registration.registrationId;
  const tournament = await getConfigurableTournament(registration.tournamentId);

  // 1. Verification Check FIRST: Check whether user's team is enrolled and verified in this tournament
  const userTeams = await getConfigurableTeamsForUser(registration.tournamentId, interaction.user.id);
  const verifiedTeams = userTeams.filter((t) => isTeamVerifiedForTournament(t, registration.tournamentId));

  if (verifiedTeams.length === 0) {
    return interaction.reply({
      content: `First verify your squad here ${getTournamentVerifyChannelMention(tournament)} channel`,
      ephemeral: true,
    });
  }

  // 2. Verify that the user is the team leader
  const leaderTeams = verifiedTeams.filter((t) => t.leaderDiscordId === interaction.user.id);
  if (leaderTeams.length === 0) {
    const enrolledTeam = verifiedTeams[0];
    return interaction.reply({
      content: `❌ Only the verified **Team Leader** (<@${enrolledTeam.leaderDiscordId}>) can register **${enrolledTeam.teamName}**.`,
      ephemeral: true,
    });
  }

  const team = leaderTeams[0]; // Leader's enrolled & verified team
  if (!registration.currentCycleId) {
    registration.currentCycleId = `${registrationId}:cycle-${crypto.randomUUID()}`;
    await saveConfigurableRegistration(registration);
  }
  const currentCycleId = registration.currentCycleId;

  // 3. Fetch active entries of THIS registrationId and currentCycleId to check duplicate and capacity
  const activeEntries = await getConfigurableEntriesForRegistration(registrationId, currentCycleId);
  const existingEntry = activeEntries.find((e) => e.teamId === team.teamId);
  if (existingEntry && existingEntry.registrationId === registrationId) {
    return interaction.reply({
      content:
        `❌ Your team **${team.teamName}** is already registered in this daily cycle!\n` +
        `Assigned to **Slot #${existingEntry.slotNumber}** in <#${registration.idpChannelId}>.`,
      ephemeral: true,
    });
  }

  // 4. Check capacity and registration status
  const filledCount = activeEntries.length;
  const reservedCount = parseReservedSlots(registration.reservedSlots, registration.totalSlots);
  const maxAvailable = Math.max(0, registration.totalSlots - reservedCount);

  if (filledCount >= maxAvailable || registration.status === 'FULL') {
    if (registration.status === 'OPEN') {
      registration.status = 'CLOSED';
      await saveConfigurableRegistration(registration);
      await updateRegistrationMessage(interaction.client, registrationId).catch(() => {});
      await updateSlotChartMessage(interaction.client, registrationId).catch(() => {});
      if (interaction.client) {
        await refreshDashboard(interaction.client, registration.tournamentId).catch(() => {});
      }
    }
    return interaction.reply({
      content: '❌ Registration is currently **FULL**. All available slots for this registration instance are occupied!',
      ephemeral: true,
    });
  }

  if (registration.status !== 'OPEN') {
    const displayStatus = resolveRegistrationStatus(registration, filledCount);
    return interaction.reply({
      content:
        `❌ Registration is currently **${displayStatus}**.\n` +
        `Daily Schedule: Opens at \`${formatRegistrationStartTime(registration)}\` | Resets at \`${registration.dailyResetTime || 'N/A'}\`.`,
      ephemeral: true,
    });
  }

  // 5. Build compact, mobile-friendly Confirmation Message
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Confirm Squad Registration')
    .setDescription(
      `You are about to register your enrolled squad for this registration.\n` +
      `Please confirm that you want to proceed.\n\n` +
      `🏆 **Tournament:** **${tournament?.name || 'Tournament'}**\n` +
      `📝 **Registration:** **${registration.displayName || registration.name}**\n` +
      `🛡️ **Team:** **${team.teamName}**\n` +
      `📊 **Total Available Slots:** **${maxAvailable}**\n` +
      `🟢 **Status:** **${registration.status}**`
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`md_cfg_reg_confirm_${registrationId}:${team.teamId}`)
      .setLabel('Confirm Registration')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`md_cfg_reg_cancel_${registrationId}:${team.teamId}`)
      .setLabel('Cancel')
      .setEmoji('✖️')
      .setStyle(ButtonStyle.Secondary)
  );

  return interaction.reply({
    embeds: [embed],
    components: [row],
    ephemeral: true,
  });
}

/**
 * Handles the "Cancel" button on the registration confirmation message.
 * Immediately acknowledges interaction and terminates pending confirmation.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} [registrationId]
 * @param {string} [teamId]
 */
export async function handleCancelRegistrationButtonClick(interaction, registrationId = null, teamId = null) {
  const interactionId = interaction?.id || 'unknown';
  console.log(`[ConfigurableRegistration] 📥 Cancel button clicked [interactionId: ${interactionId}, regId: ${registrationId || 'N/A'}, teamId: ${teamId || 'N/A'}, user: ${interaction?.user?.id}]`);

  // Immediately acknowledge the interaction
  if (typeof interaction.deferUpdate === 'function' && !interaction.deferred && !interaction.replied) {
    try {
      await interaction.deferUpdate();
      interaction.deferred = true;
      console.log(`[ConfigurableRegistration] ⏱️ Cancel interaction acknowledged via deferUpdate [interactionId: ${interactionId}]`);
    } catch (err) {
      if (err?.code !== 40060) {
        console.warn(`[ConfigurableRegistration] ⚠️ Failed to deferUpdate cancel [interactionId: ${interactionId}]:`, err.message);
      }
    }
  }

  try {
    // If teamId is supplied, verify only the original user/leader can cancel
    if (teamId && interaction?.user?.id) {
      const team = await getConfigurableTeam(teamId);
      if (team && team.leaderDiscordId && team.leaderDiscordId !== interaction.user.id) {
        console.warn(`[ConfigurableRegistration] ❌ Cancel rejected: non-leader [interactionId: ${interactionId}, user: ${interaction.user.id}, leader: ${team.leaderDiscordId}]`);
        return respondToConfirmationInteraction(interaction, {
          content: '❌ Only the original verified team leader can cancel this registration.',
          embeds: [],
          components: [],
        });
      }
    }

    const payload = {
      content: '❌ Registration cancelled.',
      embeds: [],
      components: [],
    };
    await respondToConfirmationInteraction(interaction, payload);
    console.log(`[ConfigurableRegistration] ⏱️ Cancel interaction completed successfully [interactionId: ${interactionId}]`);
    return true;
  } catch (err) {
    console.error(`[ConfigurableRegistration] ❌ Error in handleCancelRegistrationButtonClick [interactionId: ${interactionId}]:`, err);
    return respondToConfirmationInteraction(interaction, {
      content: '❌ An error occurred while cancelling registration.',
      embeds: [],
      components: [],
    });
  }
}

/**
 * Handles the "Confirm Registration" button click.
 * Sequence:
 * 1. User clicks Confirm Registration.
 * 2. Immediately acknowledge interaction using deferReply (<3s deadline).
 * 3. Disable/mark confirmation buttons as processing.
 * 4. Verify interaction belongs to the correct user.
 * 5. Retrieve team and registration from MongoDB.
 * 6. Verify user is the team leader.
 * 7. Verify team is enrolled.
 * 8. Verify registration is OPEN.
 * 9. Verify current daily cycle.
 * 10. Check duplicate registration.
 * 11. Atomically allocate an available unlocked slot.
 * 12. Create registration entry.
 * 13. Grant leader access to corresponding IDP channel.
 * 14. Update existing slot chart.
 * 15. Update registration message and dashboard.
 * 16. Edit deferred ephemeral reply with result via editReply.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} registrationId
 * @param {string} teamId
 */
export async function handleConfirmRegistrationButtonClick(interaction, registrationId, teamId) {
  const interactionId = interaction?.id || 'unknown';
  console.log(`[ConfigurableRegistration] 📥 Confirmation button clicked [interactionId: ${interactionId}, regId: ${registrationId}, teamId: ${teamId}, user: ${interaction?.user?.id}]`);

  // Step 2: Immediately acknowledge the interaction using deferUpdate (<3s deadline)
  // deferUpdate keeps the interaction tied to the existing ephemeral confirmation message,
  // allowing editReply to update it in-place and remove its buttons.
  if (!interaction.deferred && !interaction.replied) {
    if (typeof interaction.deferUpdate === 'function') {
      try {
        await interaction.deferUpdate();
        interaction.deferred = true;
        console.log(`[ConfigurableRegistration] ⏱️ Interaction acknowledged via deferUpdate [interactionId: ${interactionId}, regId: ${registrationId}]`);
      } catch (err) {
        if (err?.code === 40060) {
          console.warn(`[ConfigurableRegistration] ⚠️ Interaction already acknowledged [interactionId: ${interactionId}]:`, err.message);
          return;
        }
        console.warn(`[ConfigurableRegistration] ⚠️ Failed to deferUpdate [interactionId: ${interactionId}]:`, err.message);
      }
    } else if (typeof interaction.deferReply === 'function') {
      try {
        await interaction.deferReply({ ephemeral: true });
        interaction.deferred = true;
        console.log(`[ConfigurableRegistration] ⏱️ Interaction acknowledged via deferReply [interactionId: ${interactionId}, regId: ${registrationId}]`);
      } catch (err) {
        if (err?.code === 40060) {
          console.warn(`[ConfigurableRegistration] ⚠️ Interaction already acknowledged [interactionId: ${interactionId}]:`, err.message);
          return;
        }
        console.warn(`[ConfigurableRegistration] ⚠️ Failed to deferReply [interactionId: ${interactionId}]:`, err.message);
      }
    }
  }

  // Idempotency: Prevent concurrent/repeated button clicks
  const idempotencyKey = `${registrationId}:${teamId}`;
  if (inFlightConfirmations.has(idempotencyKey)) {
    console.warn(`[ConfigurableRegistration] ⚠️ Registration already in flight [interactionId: ${interactionId}, key: ${idempotencyKey}]`);
    return respondToConfirmationInteraction(interaction, {
      content: '⏳ Registration is already being processed. Please wait...',
      embeds: [],
      components: [],
    });
  }

  inFlightConfirmations.add(idempotencyKey);
  const lockKey = `lock:reg_confirm:${registrationId}`;
  await acquireLock(lockKey, 10, 3000);

  try {
    // Retrieve registration and tournament from MongoDB
    const registration = await getConfigurableRegistration(registrationId);
    if (!registration || registration.status === 'DELETED' || registration.isDeleted) {
      console.warn(`[ConfigurableRegistration] ❌ Registration not found or deleted [interactionId: ${interactionId}, regId: ${registrationId}]`);
      return respondToConfirmationInteraction(interaction, {
        content: '❌ Registration instance not found or has been deleted.',
        embeds: [],
        components: [],
      });
    }

    const tournament = registration.tournamentId ? await getConfigurableTournament(registration.tournamentId) : null;

    // Step 2: Re-verify the team enrollment and verification status
    const team = await getConfigurableTeam(teamId);
    if (!team || !isTeamVerifiedForTournament(team, team.tournamentId)) {
      console.warn(`[ConfigurableRegistration] ❌ Team record not found or unverified [interactionId: ${interactionId}, teamId: ${teamId}]`);
      return respondToConfirmationInteraction(interaction, {
        content: `❌ Team record not found. Squad is not enrolled or verification was revoked. First verify your squad here ${getTournamentVerifyChannelMention(tournament)} channel`,
        embeds: [],
        components: [],
      });
    }

    console.log(`[ConfigurableRegistration] 🛡️ Team validation [interactionId: ${interactionId}, teamId: ${teamId}, teamName: ${team.teamName}, leader: ${team.leaderDiscordId}]`);

    // Verify interaction belongs to the correct user (user is the team leader)
    if (interaction?.user?.id && team.leaderDiscordId !== interaction.user.id) {
      console.warn(`[ConfigurableRegistration] ❌ Non-leader confirmation attempt [interactionId: ${interactionId}, user: ${interaction.user.id}, leader: ${team.leaderDiscordId}]`);
      return respondToConfirmationInteraction(interaction, {
        content: '❌ Only the original verified team leader can confirm registration for this squad.',
        embeds: [],
        components: [],
      });
    }

    // Verify team belongs to tournament of this registration
    if (team.tournamentId !== registration.tournamentId) {
      console.warn(`[ConfigurableRegistration] ❌ Team tournament mismatch [interactionId: ${interactionId}, teamTour: ${team.tournamentId}, regTour: ${registration.tournamentId}]`);
      return respondToConfirmationInteraction(interaction, {
        content: `❌ Team is not enrolled in this tournament. First verify your squad here ${getTournamentVerifyChannelMention(tournament)} channel`,
        embeds: [],
        components: [],
      });
    }

    // Verify registration is OPEN
    if (registration.status !== 'OPEN') {
      console.warn(`[ConfigurableRegistration] ❌ Registration closed [interactionId: ${interactionId}, regId: ${registrationId}, status: ${registration.status}]`);
      return respondToConfirmationInteraction(interaction, {
        content: `❌ This registration is currently closed. Registration is no longer open (Current status: **${registration.status || 'CLOSED'}**).`,
        embeds: [],
        components: [],
      });
    }

    // Verify the current daily cycle
    if (!registration.currentCycleId) {
      const fallbackDate = registration.currentCycleDate || getCurrentTimeInTimezone(registration.timezone || 'Asia/Kolkata', new Date()).dateString;
      registration.currentCycleId = `${registrationId}:${fallbackDate}`;
      await saveConfigurableRegistration(registration);
    }
    const currentCycleId = registration.currentCycleId;

    console.log(`[ConfigurableRegistration] 📋 Registration validation [interactionId: ${interactionId}, regId: ${registrationId}, status: ${registration.status}, cycleId: ${currentCycleId}]`);

    // Check duplicate registration (only for this registration instance + currentCycleId + team)
    const activeEntries = await getConfigurableEntriesForRegistration(registrationId, currentCycleId);
    const existingEntry = activeEntries.find((e) => e.teamId === team.teamId);
    if (existingEntry) {
      console.warn(`[ConfigurableRegistration] ❌ Team already registered [interactionId: ${interactionId}, teamId: ${team.teamId}, slot: ${existingEntry.slotNumber}]`);
      return respondToConfirmationInteraction(interaction, {
        content:
          `❌ Your team **${team.teamName}** is already registered in this daily cycle!\n` +
          `Assigned to **Slot #${existingEntry.slotNumber}** in <#${registration.idpChannelId}>.`,
        embeds: [],
        components: [],
      });
    }

    // Verify capacity against non-reserved slots
    const filledCount = activeEntries.length;
    const reservedCount = parseReservedSlots(registration.reservedSlots, registration.totalSlots);
    const maxAvailable = Math.max(0, registration.totalSlots - reservedCount);

    if (filledCount >= maxAvailable) {
      console.warn(`[ConfigurableRegistration] ❌ Capacity reached [interactionId: ${interactionId}, filled: ${filledCount}, max: ${maxAvailable}]`);
      if (registration.status === 'OPEN') {
        registration.status = 'CLOSED';
        await saveConfigurableRegistration(registration);
        if (interaction.client?.channels) {
          await updateRegistrationMessage(interaction.client, registrationId).catch(() => {});
          await syncRegistrationSlotList(registrationId, currentCycleId, interaction.client).catch(() => {});
          await refreshDashboard(interaction.client, registration.tournamentId).catch(() => {});
        }
      }
      return respondToConfirmationInteraction(interaction, {
        content: '❌ Sorry, all available slots have been filled. (all available slots for this registration instance have just been filled!)',
        embeds: [],
        components: [],
      });
    }

    // Step 3: Allocate an available unlocked slot atomically
    const rawSlotNumber = await getNextAvailableSlot(registrationId, registration.totalSlots, reservedCount, currentCycleId);
    if (!rawSlotNumber) {
      console.warn(`[ConfigurableRegistration] ❌ Slot allocation failed: none available [interactionId: ${interactionId}, regId: ${registrationId}]`);
      return respondToConfirmationInteraction(interaction, {
        content: '❌ Sorry, all available slots have been filled. No available slot number could be allocated.',
        embeds: [],
        components: [],
      });
    }
    const slotNumber = Number(rawSlotNumber);

    console.log(`[ConfigurableRegistration] 🎯 Slot allocated [interactionId: ${interactionId}, regId: ${registrationId}, cycleId: ${currentCycleId}, teamId: ${team.teamId}, slot: ${slotNumber}]`);

    // Step 4 & 5: Save the RegistrationEntry in MongoDB and commit
    const now = new Date();
    const entryDoc = {
      entryId: crypto.randomUUID(),
      registrationId,
      cycleId: currentCycleId,
      cycleDate: registration.currentCycleDate || getCurrentTimeInTimezone(registration.timezone || 'Asia/Kolkata', now).dateString,
      tournamentId: registration.tournamentId,
      guildId: interaction.guildId || registration.guildId,
      teamId: team.teamId,
      teamName: team.teamName,
      leaderDiscordId: interaction.user.id,
      slotNumber,
      status: 'CONFIRMED',
      synchronized: false,
      slotSyncStatus: 'PENDING',
      registeredAt: now,
    };

    await saveConfigurableEntry(entryDoc);

    // Step 6: Confirm the registration entry exists in MongoDB
    let confirmedEntry = await getConfigurableEntry(registrationId, team.teamId, currentCycleId);
    if (!confirmedEntry) {
      console.warn(`[ConfigurableRegistration] ⚠️ Entry verification retry for regId=${registrationId}, teamId=${team.teamId}, cycleId=${currentCycleId}`);
      await saveConfigurableEntry(entryDoc);
      confirmedEntry = await getConfigurableEntry(registrationId, team.teamId, currentCycleId);
    }
    if (!confirmedEntry) {
      throw new Error('Failed to confirm registration entry persistence in database.');
    }

    console.log(
      `[ConfigurableRegistration] 💾 Confirmed RegistrationEntry in MongoDB ` +
      JSON.stringify({
        registrationId,
        cycleId: currentCycleId,
        teamId: team.teamId,
        teamName: confirmedEntry.teamName,
        slotNumber: confirmedEntry.slotNumber,
        entryId: confirmedEntry.entryId,
        status: confirmedEntry.status,
      })
    );

    // Auto-close if this was the last slot
    if (filledCount + 1 >= maxAvailable) {
      registration.status = 'CLOSED';
      await saveConfigurableRegistration(registration);

      try {
        const regChannel = interaction.guild ? await interaction.guild.channels.fetch(registration.registrationChannelId).catch(() => null) : null;
        if (regChannel) {
          await regChannel.permissionOverwrites.edit(interaction.guild.roles.everyone.id, {
            SendMessages: false,
          }).catch(() => {});
        }
      } catch {}

      await updateManageDashboardMessage(interaction.client, registrationId).catch(() => {});
      if (interaction.client) {
        await refreshDashboard(interaction.client, registration.tournamentId).catch(() => {});
      }
    }

    // Grant leader access to corresponding IDP channel
    let idpPermissionGranted = false;
    if (registration.idpChannelId && interaction.guild) {
      try {
        const idpChannel = await interaction.guild.channels.fetch(registration.idpChannelId).catch(() => null);
        if (idpChannel && typeof idpChannel.permissionOverwrites?.edit === 'function') {
          await idpChannel.permissionOverwrites.edit(interaction.user.id, {
            ViewChannel: true,
            ReadMessageHistory: true,
            SendMessages: true,
            CreatePublicThreads: false,
            CreatePrivateThreads: false,
            SendMessagesInThreads: false,
            ManageThreads: false,
            ManageChannels: false,
            ManageRoles: false,
          });
          idpPermissionGranted = true;
          console.log(`[ConfigurableRegistration] 🔐 IDP permission update successful [interactionId: ${interactionId}, idpChannelId: ${registration.idpChannelId}, leader: ${interaction.user.id}]`);
        }
      } catch (err) {
        console.warn(`[ConfigurableRegistration] ⚠️ Failed to update IDP overwrite for leader ${interaction.user.id} [interactionId: ${interactionId}]: ${err.message}. Registration preserved; permission queued for reconciliation.`);
      }
    }

    if (!idpPermissionGranted && registration.idpChannelId) {
      entryDoc.permissionPending = true;
      await saveConfigurableEntry(entryDoc).catch(() => {});
    }

    // Step 7-11: Trigger slot-list synchronization using the exact registrationId and cycleId
    const syncContext = {
      teamId: team.teamId,
      slotNumber,
      entryId: confirmedEntry.entryId,
      expectEntries: true,
    };

    let slotSyncSuccess = false;
    try {
      slotSyncSuccess = await syncRegistrationSlotList(
        registrationId,
        currentCycleId,
        interaction.client,
        syncContext
      );
    } catch (err) {
      console.warn(`[ConfigurableRegistration] ⚠️ Error in syncRegistrationSlotList [interactionId: ${interactionId}]:`, err.message);
      slotSyncSuccess = false;
    }

    if (slotSyncSuccess) {
      entryDoc.synchronized = true;
      entryDoc.slotSyncStatus = 'SYNCED';
      entryDoc.slotSyncedAt = new Date();
      await saveConfigurableEntry(entryDoc).catch(() => {});
      console.log(`[ConfigurableRegistration] 📊 Slot list synchronized in real-time [interactionId: ${interactionId}, regId: ${registrationId}, cycleId: ${currentCycleId}, entryId: ${confirmedEntry.entryId}]`);
    } else {
      // Do not mark registration as fully synchronized until slot-list update succeeds.
      // Preserve the successful registration and retry synchronization separately without allocating another slot.
      entryDoc.synchronized = false;
      entryDoc.slotSyncStatus = 'RETRY_PENDING';
      await saveConfigurableEntry(entryDoc).catch(() => {});
      if (interaction.client && registration.idpChannelId) {
        console.warn(`[ConfigurableRegistration] ⚠️ Initial slot-list sync did not complete for regId=${registrationId}; scheduling separate retry synchronization...`);
        retrySlotListSync(registrationId, currentCycleId, interaction.client, syncContext).catch(() => {});
      }
    }

    if (interaction.client) {
      await updateRegistrationMessage(interaction.client, registrationId).catch(() => {});
      await updateManageDashboardMessage(interaction.client, registrationId).catch(() => {});
      await refreshDashboard(interaction.client, registration.tournamentId).catch(() => {});
    }

    // Display Registration Successful response and remove Confirm Registration and Cancel buttons
    const tournamentName = tournament?.name || 'Tournament';
    const regName = registration.displayName || registration.name;
    const successPayload = {
      content:
        `🎉 **Registration Successful**\n` +
        `Your squad has been successfully registered!\n\n` +
        `🏆 **Tournament:** **${tournamentName}**\n` +
        `📝 **Registration:** **${regName}**\n` +
        `🛡️ **Team:** **${team.teamName}**\n` +
        `🎯 **Allocated Slot Number:** \`#${slotNumber}\`\n` +
        (registration.idpChannelId ? `🔒 **IDP Channel:** <#${registration.idpChannelId}>\n\n*(You have been granted access to the private IDP channel above. Room ID and Password will be posted there!)*` : ''),
      embeds: [],
      components: [],
    };

    const res = await respondToConfirmationInteraction(interaction, successPayload);
    console.log(`[ConfigurableRegistration] ✅ Final response sent via editReply [interactionId: ${interactionId}, regId: ${registrationId}, teamId: ${teamId}]`);
    return res;
  } catch (err) {
    console.error(`[ConfigurableRegistration] ❌ Error in handleConfirmRegistrationButtonClick [interactionId: ${interactionId}, regId: ${registrationId}, teamId: ${teamId}]:`, err);
    return respondToConfirmationInteraction(interaction, {
      content: `❌ Registration could not be completed. Please try again. (${err.message || 'Unknown error'})`,
      embeds: [],
      components: [],
    });
  } finally {
    inFlightConfirmations.delete(idempotencyKey);
    await releaseLock(lockKey);
  }
}

/**
 * Handles the "Manage Registrations" button from the dashboard.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} tournamentId
 */
export async function handleManageRegistrationsButton(interaction, tournamentId) {
  const registrations = await getConfigurableRegistrationsForTournament(tournamentId);

  if (registrations.length === 0) {
    return interaction.reply({
      content: 'ℹ️ No registration instances have been created yet. Click **Add Registration** to create one.',
      ephemeral: true,
    });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`md_cfg_manage_reg_select_${tournamentId}`)
    .setPlaceholder('Select a registration instance to manage...')
    .addOptions(
      registrations.map((r) => ({
        label: `${r.displayName} (${r.status})`,
        description: `Capacity: ${r.totalSlots} slots | #${r.registrationNumber}`,
        value: r.registrationId,
      }))
    );

  const row = new ActionRowBuilder().addComponents(select);

  await interaction.reply({
    content: '⚙️ **Select a registration instance to configure or manage:**',
    components: [row],
    ephemeral: true,
  });
}

/**
 * Builds the compact 1-row management dashboard payload for a registration instance.
 * Exactly 1 ActionRow with 5 buttons:
 * 1. Edit Settings
 * 2. Open / Close Registration
 * 3. View Current Slot Chart
 * 4. Refresh
 * 5. Delete Registration
 *
 * @param {object} registration
 * @param {number} filledCount
 * @returns {{ content: string, components: ActionRowBuilder[] }}
 */
export function buildManageDashboardPayload(registration, filledCount = 0) {
  const totalSlots = registration.totalSlots || 20;
  const reservedCount = parseReservedSlots(registration.reservedSlots, totalSlots);
  const maxAvailable = Math.max(0, totalSlots - reservedCount);
  const availableSlots = Math.max(0, maxAvailable - filledCount);
  const isOpen = registration.status === 'OPEN';

  const editSettingsBtn = new ButtonBuilder()
    .setCustomId(`md_cfg_edit_reg_${registration.registrationId}`)
    .setLabel('Edit Settings')
    .setEmoji('✏️')
    .setStyle(ButtonStyle.Primary);

  const toggleStatusBtn = new ButtonBuilder()
    .setCustomId(`md_cfg_toggle_status_${registration.registrationId}`)
    .setLabel(isOpen ? 'Close Registration' : 'Open Registration')
    .setEmoji(isOpen ? '🔒' : '🔓')
    .setStyle(isOpen ? ButtonStyle.Danger : ButtonStyle.Success);

  const viewSlotChartBtn = new ButtonBuilder()
    .setCustomId(`md_cfg_view_slotchart_${registration.registrationId}`)
    .setLabel('View Current Slot Chart')
    .setEmoji('📋')
    .setStyle(ButtonStyle.Secondary);

  const refreshBtn = new ButtonBuilder()
    .setCustomId(`md_cfg_refresh_reg_${registration.registrationId}`)
    .setLabel('Refresh')
    .setEmoji('🔄')
    .setStyle(ButtonStyle.Secondary);

  const deleteBtn = new ButtonBuilder()
    .setCustomId(`md_cfg_delete_reg_${registration.registrationId}`)
    .setLabel('Delete Registration')
    .setEmoji('🗑️')
    .setStyle(ButtonStyle.Danger);

  const row = new ActionRowBuilder().addComponents(
    editSettingsBtn,
    toggleStatusBtn,
    viewSlotChartBtn,
    refreshBtn,
    deleteBtn
  );

  const content =
    `🛠️ **Managing: ${registration.displayName}**\n\n` +
    `• **Name:** ${registration.displayName}\n` +
    `• **Current Cycle Status:** \`${registration.status}\` (Cycle: \`${registration.currentCycleDate || 'N/A'}\`)\n` +
    `• **Total Slots:** \`${totalSlots}\`\n` +
    `• **Reserved Slots:** \`${reservedCount}\`\n` +
    `• **Matches:** \`${registration.matches || 1}\`\n` +
    `• **Registered Teams:** \`${filledCount}/${maxAvailable}\`\n` +
    `• **Available Slots:** \`${availableSlots}\`\n` +
    `• **Daily Start Time:** \`${registration.dailyStartTime || 'N/A'}\` (${registration.timezone || 'IST'})\n` +
    `• **Daily Reset Time:** \`${registration.dailyResetTime || 'N/A'}\` (${registration.timezone || 'IST'})\n` +
    `• **Registration Channel:** <#${registration.registrationChannelId}>\n` +
    `• **IDP Channel:** <#${registration.idpChannelId}>\n`;

  return { content, components: [row] };
}

/**
 * Updates the persistent manage dashboard message in place from MongoDB.
 * Reads latest state from MongoDB and re-renders the current screen without pressing Refresh.
 * @param {import('discord.js').Client} client
 * @param {string} registrationId
 * @returns {Promise<boolean>}
 */
export async function updateManageDashboardMessage(client, registrationId) {
  try {
    if (!client || !registrationId) return false;
    const registration = await getConfigurableRegistration(registrationId);
    if (!registration || !registration.manageChannelId || !registration.manageMessageId) return false;

    const channel = await client.channels.fetch(registration.manageChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return false;

    const message = await channel.messages.fetch(registration.manageMessageId).catch(() => null);
    if (!message) return false;

    const currentCycleId = registration.currentCycleId || null;
    const filledCount = await getRegistrationEntriesCount(registrationId, currentCycleId);
    const payload = buildManageDashboardPayload(registration, filledCount);

    await message.edit(payload).catch(() => null);
    return true;
  } catch (err) {
    console.warn(`[ConfigurableRegistration] ⚠️ Could not update manage dashboard message for ${registrationId}:`, err.message);
    return false;
  }
}

/**
 * Handles selecting an instance from the manage registrations select menu.
 * Displays Name, Total Slots, Reserved Slots count, Registered Count, Available Slots,
 * Daily Start Time, Daily Reset Time, Current Cycle Status, and compact 5-button controls.
 *
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 * @param {string} tournamentId
 */
export async function handleManageSelectMenu(interaction, tournamentId) {
  const registrationId = interaction.values[0];
  const registration = await getConfigurableRegistration(registrationId);

  if (!registration) {
    return interaction.reply({ content: '❌ Registration instance not found.', ephemeral: true });
  }

  // Record manage channel and message IDs in MongoDB to enable in-place live updates
  if (interaction.channelId && interaction.message?.id) {
    registration.manageChannelId = interaction.channelId;
    registration.manageMessageId = interaction.message.id;
    await saveConfigurableRegistration(registration);
  }

  const currentCycleId = registration.currentCycleId || null;
  const filledCount = await getRegistrationEntriesCount(registrationId, currentCycleId);
  const payload = buildManageDashboardPayload(registration, filledCount);

  if (interaction.update) {
    await interaction.update(payload);
  } else {
    await interaction.reply({ ...payload, ephemeral: true });
  }
}

/**
 * Refreshes the registration management dashboard in place.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} registrationId
 */
export async function handleRefreshRegistration(interaction, registrationId) {
  const registration = await getConfigurableRegistration(registrationId);
  if (!registration) {
    return interaction.reply({ content: '❌ Registration instance not found.', ephemeral: true });
  }

  const currentCycleId = registration.currentCycleId || null;
  const filledCount = await getRegistrationEntriesCount(registrationId, currentCycleId);

  if (interaction.client) {
    await updateRegistrationMessage(interaction.client, registrationId).catch(() => {});
    await syncRegistrationSlotList(registrationId, currentCycleId, interaction.client).catch(() => {});
  }

  const payload = buildManageDashboardPayload(registration, filledCount);
  if (interaction.isButton && interaction.isButton()) {
    await interaction.update(payload);
  } else if (interaction.update) {
    await interaction.update(payload);
  } else {
    await interaction.reply({ ...payload, ephemeral: true });
  }
}

/**
 * Toggles a registration instance between OPEN and CLOSED in real time.
 * - Clicking Open Registration: Immediately starts registration (channel created/unlocked to accept registrations)
 *   and dashboard message re-renders right away: status shows "Open" and button becomes "Close Registration".
 * - Clicking Close Registration: Immediately stops registration (channel locked for sending, closing message posted)
 *   and dashboard re-renders right away: status shows "Closed" and button becomes "Open Registration".
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} registrationId
 */
export async function handleToggleStatus(interaction, registrationId) {
  const registration = await getConfigurableRegistration(registrationId);
  if (!registration) {
    return interaction.reply({ content: '❌ Registration instance not found.', ephemeral: true });
  }

  const currentCycleId = registration.currentCycleId || null;
  const filledCount = await getRegistrationEntriesCount(registrationId, currentCycleId);
  const totalSlots = registration.totalSlots || 20;
  const reservedCount = parseReservedSlots(registration.reservedSlots, totalSlots);
  const maxAvailable = Math.max(0, totalSlots - reservedCount);

  const isOpening = registration.status !== 'OPEN';
  const guild = interaction.guild;

  if (isOpening) {
    if (filledCount >= maxAvailable) {
      return interaction.reply({
        content: `❌ Cannot open registration: all available slots are filled (${filledCount}/${maxAvailable}).`,
        ephemeral: true,
      });
    }

    // Ensure registration channel exists or recreate it
    let regChannel = null;
    if (registration.registrationChannelId && guild) {
      regChannel = await guild.channels.fetch(registration.registrationChannelId).catch(() => null);
    }
    if (!regChannel && guild) {
      const tournament = await getConfigurableTournament(registration.tournamentId);
      const rawPrefix = tournament?.prefix || (tournament?.name ? buildTournamentPrefix(tournament.name) : 'md');
      const boldPrefix = tournament?.boldPrefix || toMathematicalBold(rawPrefix);
      const slug = (registration.displayName || 'reg')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 20) || `group-${registration.registrationNumber || 1}`;
      regChannel = await createTournamentChannel(guild, {
        boldPrefix,
        rawPrefix,
        fallbackSuffix: `${slug}-reg`,
        type: ChannelType.GuildText,
        parent: tournament?.categoryId || null,
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages],
            deny: TOURNAMENT_DENIED_PERMISSIONS,
          },
        ],
      });
      registration.registrationChannelId = regChannel.id;
    } else if (regChannel) {
      // Unlock registration channel for sending
      await regChannel.permissionOverwrites.edit(guild.roles.everyone.id, {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: true,
      }).catch(() => {});
    }

    registration.status = 'OPEN';
    registration.manualOverride = 'OPEN';
    registration.manualOverrideCycleDate = registration.currentCycleDate;
  } else {
    // Lock registration channel for sending
    if (registration.registrationChannelId && guild) {
      const regChannel = await guild.channels.fetch(registration.registrationChannelId).catch(() => null);
      if (regChannel) {
        await regChannel.permissionOverwrites.edit(guild.roles.everyone.id, {
          SendMessages: false,
        }).catch(() => {});
      }
    }

    registration.status = 'CLOSED';
    registration.manualOverride = 'CLOSED';
    registration.manualOverrideCycleDate = registration.currentCycleDate;
  }

  // Preserve manage channel and message IDs for live in-place updating
  if (interaction.channelId && interaction.message?.id) {
    registration.manageChannelId = interaction.channelId;
    registration.manageMessageId = interaction.message.id;
  }

  await saveConfigurableRegistration(registration);

  if (interaction.client) {
    await updateRegistrationMessage(interaction.client, registrationId).catch(() => {});
    await updateSlotChartMessage(interaction.client, registrationId).catch(() => {});
    await refreshDashboard(interaction.client, registration.tournamentId).catch(() => {});
  }

  // Re-render the dashboard message right away
  const payload = buildManageDashboardPayload(registration, filledCount);
  if (interaction.isButton && interaction.isButton()) {
    await interaction.update(payload);
    if (interaction.followUp) {
      await interaction.followUp({
        content: `✅ Registration is now **${registration.status}**.`,
        ephemeral: true,
      }).catch(() => {});
    }
  } else if (interaction.update) {
    await interaction.update(payload);
  } else {
    await interaction.reply({
      content: `✅ Registration status updated to **${registration.status}**.`,
      ephemeral: true,
    });
  }
}

/**
 * Opens modal to edit registration settings (Name, Total Slots, Reserved Slots, Number of Matches, Daily Schedule).
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} registrationId
 */
export async function handleEditRegistrationButton(interaction, registrationId) {
  const registration = await getConfigurableRegistration(registrationId);
  if (!registration) {
    return interaction.reply({ content: '❌ Registration instance not found.', ephemeral: true });
  }

  const reservedCount = parseReservedSlots(registration.reservedSlots, registration.totalSlots);
  const modal = new ModalBuilder()
    .setCustomId(`md_cfg_edit_reg_modal_${registrationId}`)
    .setTitle(`Edit ${registration.displayName}`.slice(0, 45));

  const nameInput = new TextInputBuilder()
    .setCustomId('registration_name')
    .setLabel('Registration Name')
    .setStyle(TextInputStyle.Short)
    .setValue(registration.displayName || '')
    .setRequired(true);

  const capacityInput = new TextInputBuilder()
    .setCustomId('total_slots')
    .setLabel('Total Slots')
    .setStyle(TextInputStyle.Short)
    .setValue(String(registration.totalSlots || 20))
    .setRequired(true);

  const reservedInput = new TextInputBuilder()
    .setCustomId('reserved_slots')
    .setLabel('Reserved Slots (Count from Slot 01)')
    .setStyle(TextInputStyle.Short)
    .setValue(String(reservedCount))
    .setPlaceholder('e.g. 2 (locks Slot 01 and Slot 02)')
    .setRequired(false);

  const matchesInput = new TextInputBuilder()
    .setCustomId('matches')
    .setLabel('Number of Matches')
    .setStyle(TextInputStyle.Short)
    .setValue(String(registration.matches || 1))
    .setPlaceholder('e.g. 1, 2, 3')
    .setRequired(false);

  const startVal = registration.rawDailyStartTime || registration.dailyStartTime || '10:00';
  const resetVal = registration.rawDailyResetTime || registration.dailyResetTime || '02:00';
  const startInput = new TextInputBuilder()
    .setCustomId('daily_start_time')
    .setLabel('Daily Start Time (or Start | Reset)')
    .setStyle(TextInputStyle.Short)
    .setValue(`${startVal} | ${resetVal}`)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(nameInput),
    new ActionRowBuilder().addComponents(capacityInput),
    new ActionRowBuilder().addComponents(reservedInput),
    new ActionRowBuilder().addComponents(matchesInput),
    new ActionRowBuilder().addComponents(startInput)
  );

  await interaction.showModal(modal);
}

/**
 * Handles submission of Edit Registration Settings modal.
 * Enforces capacity and reserved slot occupancy safeguards, updates MongoDB,
 * renames Discord channels, and updates persistent messages and dashboards.
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 * @param {string} registrationId
 */
export async function handleEditRegistrationModalSubmit(interaction, registrationId) {
  await interaction.deferReply({ ephemeral: true });

  const registration = await getConfigurableRegistration(registrationId);
  if (!registration) {
    return interaction.editReply({ content: '❌ Registration instance not found.' });
  }

  const newName = (getSafeFieldValue(interaction, 'registration_name') || registration.displayName || '').trim();
  const rawSlotsField = getSafeFieldValue(interaction, 'total_slots') || String(registration.totalSlots || 20);
  const slotParts = rawSlotsField.split('|').map((s) => s.trim()).filter(Boolean);
  const rawSlots = parseInt(slotParts[0], 10);
  const rawReserved = getSafeFieldValue(interaction, 'reserved_slots') ?? '0';
  const rawMatchesField = getSafeFieldValue(interaction, 'matches') || slotParts[1] || '';

  const rawStartInput = getSafeFieldValue(interaction, 'daily_start_time') || registration.dailyStartTime || '10:00';
  const startResetParts = rawStartInput.split('|').map((s) => s.trim()).filter(Boolean);
  const rawStart = startResetParts[0] || rawStartInput;
  const rawReset = getSafeFieldValue(interaction, 'daily_reset_time') || startResetParts[1] || registration.dailyResetTime || '02:00';

  if (isNaN(rawSlots) || rawSlots <= 0) {
    return interaction.editReply({ content: '❌ Total slots must be a positive integer.' });
  }

  let newMatches = Number.isInteger(registration.matches) && registration.matches > 0 ? registration.matches : 1;
  if (rawMatchesField !== '') {
    const parsedMatches = parseInt(rawMatchesField, 10);
    if (isNaN(parsedMatches) || parsedMatches <= 0) {
      return interaction.editReply({ content: '❌ Number of Matches must be a positive integer.' });
    }
    newMatches = parsedMatches;
  }

  const newReservedCount = parseReservedSlots(rawReserved, rawSlots);
  if (newReservedCount >= rawSlots) {
    return interaction.editReply({
      content: '❌ Reserved slots count cannot equal or exceed total capacity.',
    });
  }

  // Check allocated slots and check if newly reserved slots overlap with occupied slots
  const entries = await getConfigurableEntriesForRegistration(registrationId, registration.currentCycleId);
  const filledCount = entries.length;

  if (rawSlots < filledCount) {
    return interaction.editReply({
      content: `❌ Capacity cannot be reduced below already allocated slots (${filledCount} teams currently registered).`,
    });
  }

  // Safeguard: newly reserved slots occupy 1..newReservedCount.
  // Check if any existing team is assigned to slotNumber <= newReservedCount
  const conflictingEntries = entries.filter((e) => e.slotNumber <= newReservedCount);
  if (conflictingEntries.length > 0) {
    return interaction.editReply({
      content: `❌ Slot(s) ${conflictingEntries.map((e) => `#${e.slotNumber}`).join(', ')} cannot be reserved because they are already occupied by registered teams (${conflictingEntries.map((e) => e.teamName).join(', ')}).`,
    });
  }

  const parsedStart = parseTimeString(rawStart);
  if (!parsedStart) {
    return interaction.editReply({ content: `❌ Invalid daily start time "${rawStart}". Use format like "10:00 AM" or "18:00".` });
  }

  const parsedReset = parseTimeString(rawReset);
  if (!parsedReset) {
    return interaction.editReply({ content: `❌ Invalid daily reset time "${rawReset}". Use format like "02:00 AM" or "04:00".` });
  }

  // Rename Discord channels if registration name changed
  if (newName !== registration.displayName) {
    const slug = newName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 20) || `group-${registration.registrationNumber || 1}`;

    const tournament = await getConfigurableTournament(registration.tournamentId);
    const rawPrefix = tournament?.prefix || (tournament?.name ? buildTournamentPrefix(tournament.name) : 'md');
    const boldPrefix = tournament?.boldPrefix || toMathematicalBold(rawPrefix);

    const primaryRegName = `${boldPrefix}\uFF5C${slug}-reg`;
    const fallbackRegName = `${rawPrefix.toLowerCase()}-${slug}-reg`;
    const primaryIdpName = `${boldPrefix}\uFF5C${slug}-idp`;
    const fallbackIdpName = `${rawPrefix.toLowerCase()}-${slug}-idp`;

    const renameChannelSafely = async (chan, primaryName, fallbackName) => {
      if (!chan || typeof chan.setName !== 'function') return;
      try {
        await chan.setName(primaryName, 'Registration name updated');
      } catch (err) {
        console.warn(`[ConfigurableRegistration] ⚠️ Failed to rename channel to ${primaryName}: ${err.message}. Retrying with ${fallbackName}...`);
        await chan.setName(fallbackName, 'Registration name updated');
      }
    };

    try {
      if (registration.registrationChannelId && interaction.guild) {
        const regChan = await interaction.guild.channels.fetch(registration.registrationChannelId).catch(() => null);
        if (regChan && regChan.name !== primaryRegName && regChan.name !== fallbackRegName) {
          await renameChannelSafely(regChan, primaryRegName, fallbackRegName);
        }
      }
      if (registration.idpChannelId && interaction.guild) {
        const idpChan = await interaction.guild.channels.fetch(registration.idpChannelId).catch(() => null);
        if (idpChan && idpChan.name !== primaryIdpName && idpChan.name !== fallbackIdpName) {
          await renameChannelSafely(idpChan, primaryIdpName, fallbackIdpName);
        }
      }
    } catch (renameErr) {
      console.error(`[ConfigurableRegistration] ❌ Channel rename failed:`, renameErr);
      // Keep old name in MongoDB and show real error to admin
      return interaction.editReply({
        content: `❌ Could not rename registration: Discord channel rename failed (${renameErr.message || renameErr}). The old name "${registration.displayName}" was kept.`,
      });
    }

    registration.displayName = newName;
  }

  registration.totalSlots = rawSlots;
  registration.reservedSlots = newReservedCount;
  registration.matches = newMatches;
  registration.dailyStartTime = parsedStart.formatted;
  registration.rawDailyStartTime = rawStart;
  registration.dailyResetTime = parsedReset.formatted;
  registration.rawDailyResetTime = rawReset;

  await saveConfigurableRegistration(registration);

  if (interaction.client) {
    await updateRegistrationMessage(interaction.client, registrationId).catch(() => {});
    await updateSlotChartMessage(interaction.client, registrationId).catch(() => {});
    await updateManageDashboardMessage(interaction.client, registrationId).catch(() => {});
    await refreshDashboard(interaction.client, registration.tournamentId).catch(() => {});
  }

  const responseText =
    `✅ **Registration Settings Updated!**\n\n` +
    `• **Name:** ${registration.displayName}\n` +
    `• **Total Slots:** ${rawSlots}\n` +
    `• **Reserved Slots:** ${newReservedCount > 0 ? `${newReservedCount} (01-${String(newReservedCount).padStart(2, '0')})` : 'None'}\n` +
    `• **Matches:** ${newMatches}\n` +
    `• **Daily Start:** ${parsedStart.formatted}\n` +
    `• **Daily Reset:** ${parsedReset.formatted}`;

  await interaction.editReply({ content: responseText });
}

/**
 * Shows the current slot chart embed to the organiser.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} registrationId
 */
export async function handleViewCurrentSlotChart(interaction, registrationId) {
  const registration = await getConfigurableRegistration(registrationId);
  if (!registration) {
    return interaction.reply({ content: '❌ Registration instance not found.', ephemeral: true });
  }

  const tournament = registration.tournamentId ? await getConfigurableTournament(registration.tournamentId) : null;
  const entries = await getConfigurableEntriesForRegistration(registrationId, registration.currentCycleId);
  const text = buildSlotListText(tournament, registration, entries);

  await interaction.reply({ content: text, ephemeral: true });
}

/**
 * Manually deletes a registration instance, its channels, and its entries.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} registrationId
 */
export async function handleDeleteRegistration(interaction, registrationId) {
  const registration = await getConfigurableRegistration(registrationId);
  if (!registration) {
    return interaction.reply({ content: '❌ Registration instance not found.', ephemeral: true });
  }

  // Revoke IDP access for active leaders before deleting channels
  const activeEntries = await getConfigurableEntriesForRegistration(registrationId);
  if (registration.idpChannelId && interaction.guild) {
    try {
      const idpChan = await interaction.guild.channels.fetch(registration.idpChannelId).catch(() => null);
      if (idpChan && idpChan.permissionOverwrites) {
        for (const entry of activeEntries) {
          if (entry.leaderDiscordId) {
            await idpChan.permissionOverwrites.delete(entry.leaderDiscordId).catch(() => {});
          }
        }
      }
    } catch {}
  }

  try {
    if (registration.registrationChannelId) {
      const regChan = await interaction.guild.channels.fetch(registration.registrationChannelId).catch(() => null);
      if (regChan) await regChan.delete().catch(() => null);
    }
    if (registration.idpChannelId) {
      const idpChan = await interaction.guild.channels.fetch(registration.idpChannelId).catch(() => null);
      if (idpChan) await idpChan.delete().catch(() => null);
    }
  } catch (err) {
    console.warn(`[ConfigurableRegistration] ⚠️ Error cleaning up channels:`, err.message);
  }

  await deleteConfigurableRegistration(registrationId, interaction.client);

  if (interaction.client) {
    await refreshDashboard(interaction.client, registration.tournamentId).catch(() => {});
  }

  await interaction.reply({
    content: `✅ Registration instance **${registration.displayName}** and its associated channels have been deleted.`,
    ephemeral: true,
  });
}
