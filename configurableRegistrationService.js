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
  saveConfigurableRegistration,
  deleteConfigurableRegistration,
  getConfigurableTeamsForUser,
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
import { updateSlotChartMessage, buildSlotChartEmbed, buildSlotListText } from './slotChartService.js';
import { TOURNAMENT_DENIED_PERMISSIONS, refreshDashboard } from './configurableTournamentService.js';

/**
 * Builds the Embed for a public Registration Channel.
 * @param {object} registration
 * @param {number} filledCount
 * @returns {EmbedBuilder}
 */
export function buildRegistrationEmbed(registration, filledCount = 0) {
  const totalSlots = registration.totalSlots || 20;
  const reservedCount = parseReservedSlots(registration.reservedSlots, totalSlots);
  const maxAvailable = Math.max(0, totalSlots - reservedCount);
  const availableSlots = Math.max(0, maxAvailable - filledCount);
  const isOpen = registration.status === 'OPEN';

  const reservedSummary = reservedCount > 0
    ? `${reservedCount} (01-${String(reservedCount).padStart(2, '0')})`
    : 'None';
  const scheduleLine = (registration.dailyStartTime || registration.dailyResetTime)
    ? `\n**Daily Schedule:** Opens at \`${registration.dailyStartTime || 'N/A'}\` | Resets at \`${registration.dailyResetTime || 'N/A'}\``
    : '';

  return new EmbedBuilder()
    .setColor(isOpen ? 0x22c55e : registration.status === 'CLOSED' ? 0xef4444 : 0x3b82f6)
    .setTitle(`🎟️ Registration — ${registration.displayName}`)
    .setDescription(
      `**Status:** \`${registration.status || 'OPEN'}\`\n` +
      `**Total Capacity:** \`${totalSlots}\` slots\n` +
      `**Reserved / Locked:** \`${reservedSummary}\`\n` +
      `**Slots Filled:** \`${filledCount}/${maxAvailable}\`\n` +
      `**Remaining Slots:** \`${availableSlots}\`${scheduleLine}\n\n` +
      `📌 *Only verified **Team Leaders** can register their squad.*\n` +
      `📌 *Upon successful registration, the Team Leader will automatically receive access to the private IDP channel!*`
    )
    .setFooter({ text: 'Match District Tournament System' })
    .setTimestamp();
}

/**
 * Builds the register button component row.
 * @param {object} registration
 * @returns {ActionRowBuilder}
 */
export function buildRegistrationComponents(registration) {
  const isOpen = registration.status === 'OPEN';
  const button = new ButtonBuilder()
    .setCustomId(`md_cfg_reg_btn_${registration.registrationId}`)
    .setLabel(isOpen ? 'Register Squad' : `Registration ${registration.status || 'Closed'}`)
    .setEmoji(isOpen ? '⚡' : '🔒')
    .setStyle(isOpen ? ButtonStyle.Success : ButtonStyle.Secondary)
    .setDisabled(!isOpen);

  return new ActionRowBuilder().addComponents(button);
}

/**
 * Updates or posts the persistent registration message in the registration channel.
 * @param {import('discord.js').Client} client
 * @param {string} registrationId
 * @returns {Promise<boolean>}
 */
export async function updateRegistrationMessage(client, registrationId) {
  try {
    const registration = await getConfigurableRegistration(registrationId);
    if (!registration || !registration.registrationChannelId) return false;

    const channel = await client.channels.fetch(registration.registrationChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return false;

    const currentCycleId = registration.currentCycleId || null;
    const filledCount = await getRegistrationEntriesCount(registrationId, currentCycleId);
    const embed = buildRegistrationEmbed(registration, filledCount);
    const row = buildRegistrationComponents(registration);

    if (registration.registrationMessageId) {
      try {
        const existing = await channel.messages.fetch(registration.registrationMessageId).catch(() => null);
        if (existing) {
          await existing.edit({ embeds: [embed], components: [row] });
          return true;
        }
      } catch {
        // Fall through to send new
      }
    }

    const msg = await channel.send({ embeds: [embed], components: [row] });
    registration.registrationMessageId = msg.id;
    await saveConfigurableRegistration(registration);
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
    interaction.fields.getTextInputValue('registration_name') ||
    interaction.fields.getTextInputValue('display_name') ||
    ''
  ).trim();

  if (!displayName || displayName.length < 2) {
    return interaction.editReply({ content: '❌ Registration Name must be at least 2 characters long.' });
  }

  const rawTotal = parseInt(interaction.fields.getTextInputValue('total_slots')?.trim(), 10);
  if (isNaN(rawTotal) || rawTotal <= 0) {
    return interaction.editReply({ content: '❌ Total Slots must be a positive integer (e.g. 16, 25, 32, 64).' });
  }
  const totalSlots = rawTotal;

  const rawReserved = interaction.fields.getTextInputValue('reserved_slots')?.trim() || '';
  const reservedSlots = parseReservedSlots(rawReserved, totalSlots);

  if (reservedSlots >= totalSlots) {
    return interaction.editReply({ content: '❌ Reserved slots count cannot equal or exceed total capacity.' });
  }

  // Daily Start Time (or fallback starts_at)
  const rawStart = (
    interaction.fields.getTextInputValue('daily_start_time') ||
    interaction.fields.getTextInputValue('starts_at') ||
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
    interaction.fields.getTextInputValue('daily_reset_time') ||
    interaction.fields.getTextInputValue('ends_at') ||
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

  const regChannelName = `${slug}-reg`;
  const idpChannelName = `${slug}-idp`;

  const guild = interaction.guild;
  const categoryId = tournament.categoryId;

  try {
    // 1. Create Public Registration Channel (Viewable by everyone, SendMessages disabled)
    const regChannel = await guild.channels.create({
      name: regChannelName,
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
    const idpChannel = await guild.channels.create({
      name: idpChannelName,
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
    const currentCycleId = `${registrationId}:cycle-${crypto.randomUUID()}`;
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
      dailyStartTime: parsedStart.formatted,
      rawDailyStartTime: rawStart,
      dailyResetTime: parsedReset.formatted,
      rawDailyResetTime: rawReset,
      timezone,
      currentCycleId,
      currentCycleDate,
      currentCycleStartedAt: cycleEval.isOpen ? now : null,
      lastResetAt: null,
      lastResetCycleDate: null,
      status,
      createdAt: now,
    };

    await saveConfigurableRegistration(registrationDoc);

    // 3. Post Persistent Registration Message
    await updateRegistrationMessage(interaction.client, registrationId);

    // 4. Post Persistent Slot Chart Message in IDP channel
    await updateSlotChartMessage(interaction.client, registrationId);

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
 * Handles the "Register Squad" button click in a registration channel.
 * - Strict IDP Permissions: ONLY the Team Leader receives access to the IDP channel.
 * - Multiple Registrations: Enrolled team CAN register in multiple instances of the tournament.
 * - Daily Reset Cycle: Teams can re-register in subsequent cycles.
 * - Locked Slots: Lowest non-reserved, non-occupied slot number is allocated.
 * - Auto-close: Closes automatically when all available slots are filled.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} registrationId
 */
export async function handleRegisterSquadButtonClick(interaction, registrationId) {
  const registration = await getConfigurableRegistration(registrationId);
  if (!registration) {
    return interaction.reply({
      content: '❌ Registration instance not found.',
      ephemeral: true,
    });
  }

  if (registration.status !== 'OPEN') {
    return interaction.reply({
      content:
        `❌ Registration is currently **${registration.status || 'CLOSED'}**.\n` +
        `Daily Schedule: Opens at \`${registration.dailyStartTime || 'N/A'}\` | Resets at \`${registration.dailyResetTime || 'N/A'}\`.`,
      ephemeral: true,
    });
  }

  // 1. Check if user is an enrolled Team Leader for this tournament
  const userTeams = await getConfigurableTeamsForUser(registration.tournamentId, interaction.user.id);
  const leaderTeams = userTeams.filter((t) => t.leaderDiscordId === interaction.user.id);

  if (leaderTeams.length === 0) {
    return interaction.reply({
      content:
        `❌ **Enrollment Required:** You are not a verified Team Leader for this tournament.\n` +
        `Please enroll your squad first in the tournament verification channel.`,
      ephemeral: true,
    });
  }

  const team = leaderTeams[0]; // Leader's enrolled team
  if (!registration.currentCycleId) {
    registration.currentCycleId = `${registrationId}:cycle-${crypto.randomUUID()}`;
    await saveConfigurableRegistration(registration);
  }
  const currentCycleId = registration.currentCycleId;

  // 2. Check if team is ALREADY registered in THIS registration cycle
  // Strictly matches: registrationId + currentCycleId + teamId with active status
  const existingEntry = await getConfigurableEntry(registrationId, team.teamId, currentCycleId);
  if (existingEntry && existingEntry.registrationId === registrationId) {
    return interaction.reply({
      content:
        `❌ Your team **${team.teamName}** is already registered in this daily cycle!\n` +
        `Assigned to **Slot #${existingEntry.slotNumber}** in <#${registration.idpChannelId}>.`,
      ephemeral: true,
    });
  }

  // 3. Check capacity against non-reserved slots
  const activeEntries = await getConfigurableEntriesForRegistration(registrationId, currentCycleId);
  const filledCount = activeEntries.length;
  const reservedCount = parseReservedSlots(registration.reservedSlots, registration.totalSlots);
  const maxAvailable = Math.max(0, registration.totalSlots - reservedCount);

  if (filledCount >= maxAvailable) {
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
      content: '❌ Sorry, all available slots for this registration instance are currently full!',
      ephemeral: true,
    });
  }

  // 4. Allocate lowest non-reserved, non-occupied slot number (starting from reservedCount + 1)
  const slotNumber = await getNextAvailableSlot(registrationId, registration.totalSlots, reservedCount, currentCycleId);
  if (!slotNumber) {
    return interaction.reply({
      content: '❌ No available slot number could be allocated.',
      ephemeral: true,
    });
  }

  // 5. Save confirmed entry with cycleId
  const now = new Date();
  const entryDoc = {
    entryId: crypto.randomUUID(),
    registrationId,
    cycleId: currentCycleId,
    cycleDate: registration.currentCycleDate || getCurrentTimeInTimezone(registration.timezone || 'Asia/Kolkata', now).dateString,
    tournamentId: registration.tournamentId,
    guildId: interaction.guildId,
    teamId: team.teamId,
    teamName: team.teamName,
    leaderDiscordId: interaction.user.id,
    slotNumber,
    status: 'CONFIRMED',
    registeredAt: now,
  };

  await saveConfigurableEntry(entryDoc);

  // If this filled the last available slot, auto-close
  if (filledCount + 1 >= maxAvailable) {
    registration.status = 'CLOSED';
    await saveConfigurableRegistration(registration);

    // Lock registration channel for sending and post closing message
    try {
      const regChannel = await interaction.guild.channels.fetch(registration.registrationChannelId).catch(() => null);
      if (regChannel) {
        await regChannel.permissionOverwrites.edit(interaction.guild.roles.everyone.id, {
          SendMessages: false,
        }).catch(() => {});
        await regChannel.send('🔒 **Registration is now closed (All available slots are filled).**').catch(() => {});
      }
    } catch {}

    // Auto-update dashboard messages in place from MongoDB without pressing Refresh
    await updateManageDashboardMessage(interaction.client, registrationId).catch(() => {});
    if (interaction.client) {
      await refreshDashboard(interaction.client, registration.tournamentId).catch(() => {});
    }
  }

  // 6. STRICT IDP PERMISSIONS: Grant ViewChannel access ONLY to the Team Leader
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
    }
  } catch (err) {
    console.warn(`[ConfigurableRegistration] ⚠️ Failed to update IDP overwrite for leader ${interaction.user.id}:`, err.message);
  }

  // 7. Update Slot Chart & Registration Message
  await updateSlotChartMessage(interaction.client, registrationId);
  await updateRegistrationMessage(interaction.client, registrationId);

  await interaction.reply({
    content:
      `🎉 **Registration Confirmed!**\n\n` +
      `**Team:** **${team.teamName}**\n` +
      `**Slot Number:** \`#${slotNumber}\`\n` +
      `**IDP Channel:** <#${registration.idpChannelId}>\n\n` +
      `🔒 *You (<@${interaction.user.id}>) have been granted access to the private IDP channel above. Room ID and Password will be posted there prior to match start!*`,
    ephemeral: true,
  });
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
    await updateSlotChartMessage(interaction.client, registrationId).catch(() => {});
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
      const slug = (registration.displayName || 'reg')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 20) || `group-${registration.registrationNumber || 1}`;
      regChannel = await guild.channels.create({
        name: `${slug}-reg`,
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
    // Lock registration channel for sending and post closing message
    if (registration.registrationChannelId && guild) {
      const regChannel = await guild.channels.fetch(registration.registrationChannelId).catch(() => null);
      if (regChannel) {
        await regChannel.permissionOverwrites.edit(guild.roles.everyone.id, {
          SendMessages: false,
        }).catch(() => {});
        await regChannel.send('🔒 **Registration is now closed.**').catch(() => {});
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
 * Opens modal to edit registration settings (Name, Total Slots, Reserved Slots, Daily Start Time, Daily Reset Time).
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

  const startInput = new TextInputBuilder()
    .setCustomId('daily_start_time')
    .setLabel('Daily Start Time')
    .setStyle(TextInputStyle.Short)
    .setValue(registration.dailyStartTime || registration.rawDailyStartTime || '10:00')
    .setRequired(true);

  const resetInput = new TextInputBuilder()
    .setCustomId('daily_reset_time')
    .setLabel('Daily Reset Time')
    .setStyle(TextInputStyle.Short)
    .setValue(registration.dailyResetTime || registration.rawDailyResetTime || '02:00')
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

  const newName = interaction.fields.getTextInputValue('registration_name').trim();
  const rawSlots = parseInt(interaction.fields.getTextInputValue('total_slots').trim(), 10);
  const rawReserved = interaction.fields.getTextInputValue('reserved_slots')?.trim() || '0';
  const rawStart = interaction.fields.getTextInputValue('daily_start_time').trim();
  const rawReset = interaction.fields.getTextInputValue('daily_reset_time').trim();

  if (isNaN(rawSlots) || rawSlots <= 0) {
    return interaction.editReply({ content: '❌ Total slots must be a positive integer.' });
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

    const newRegChannelName = `${slug}-reg`;
    const newIdpChannelName = `${slug}-idp`;

    try {
      if (registration.registrationChannelId && interaction.guild) {
        const regChan = await interaction.guild.channels.fetch(registration.registrationChannelId).catch(() => null);
        if (regChan && regChan.name !== newRegChannelName && typeof regChan.setName === 'function') {
          await regChan.setName(newRegChannelName, 'Registration name updated');
        }
      }
      if (registration.idpChannelId && interaction.guild) {
        const idpChan = await interaction.guild.channels.fetch(registration.idpChannelId).catch(() => null);
        if (idpChan && idpChan.name !== newIdpChannelName && typeof idpChan.setName === 'function') {
          await idpChan.setName(newIdpChannelName, 'Registration name updated');
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
  registration.dailyStartTime = parsedStart.formatted;
  registration.dailyResetTime = parsedReset.formatted;

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
