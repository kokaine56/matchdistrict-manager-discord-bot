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
import { updateSlotChartMessage, buildSlotChartEmbed } from './slotChartService.js';
import { TOURNAMENT_DENIED_PERMISSIONS } from './configurableTournamentService.js';

/**
 * Builds the Embed for a public Registration Channel.
 * @param {object} registration
 * @param {number} filledCount
 * @returns {EmbedBuilder}
 */
export function buildRegistrationEmbed(registration, filledCount = 0) {
  const totalSlots = registration.totalSlots || 20;
  const reservedSlotsList = parseReservedSlots(registration.reservedSlots, totalSlots);
  const reservedCount = reservedSlotsList.length;
  const maxAvailable = Math.max(0, totalSlots - reservedCount);
  const availableSlots = Math.max(0, maxAvailable - filledCount);
  const isOpen = registration.status === 'OPEN';

  const reservedSummary = reservedSlotsList.length > 0 ? reservedSlotsList.join(', ') : 'None';
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
    .setLabel('Reserved Slots')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 1, 4, 10 (or leave empty)')
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

  if (reservedSlots.length >= totalSlots) {
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

  const existingRegs = await getConfigurableRegistrationsForTournament(tournamentId);
  const regNumber = existingRegs.length + 1;

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
      reservedSlots, // Array<number>
      dailyStartTime: parsedStart.formatted,
      rawDailyStartTime: rawStart,
      dailyResetTime: parsedReset.formatted,
      rawDailyResetTime: rawReset,
      timezone,
      currentCycleId: `${registrationId}:${currentCycleDate}`,
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

    const reservedDisplay = reservedSlots.length > 0 ? reservedSlots.join(', ') : 'None';

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
  const currentCycleId = registration.currentCycleId || `${registrationId}:${registration.currentCycleDate || 'default'}`;

  // 2. Check if team is ALREADY registered in THIS registration cycle
  const existingEntry = await getConfigurableEntry(registrationId, team.teamId, currentCycleId);
  if (existingEntry) {
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
  const reservedSlotsList = parseReservedSlots(registration.reservedSlots, registration.totalSlots);
  const maxAvailable = Math.max(0, registration.totalSlots - reservedSlotsList.length);

  if (filledCount >= maxAvailable) {
    if (registration.status === 'OPEN') {
      registration.status = 'CLOSED';
      await saveConfigurableRegistration(registration);
      await updateRegistrationMessage(interaction.client, registrationId).catch(() => {});
      await updateSlotChartMessage(interaction.client, registrationId).catch(() => {});
    }
    return interaction.reply({
      content: '❌ Sorry, all available slots for this registration instance are currently full!',
      ephemeral: true,
    });
  }

  // 4. Allocate lowest non-reserved, non-occupied slot number
  const slotNumber = await getNextAvailableSlot(registrationId, registration.totalSlots, reservedSlotsList, currentCycleId);
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
 * Handles selecting an instance from the manage registrations select menu.
 * Displays Name, Total Slots, Reserved Slots list, Registered Count, Available Slots,
 * Daily Start Time, Daily Reset Time, Current Cycle Status, and full management controls.
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

  const currentCycleId = registration.currentCycleId || null;
  const filledCount = await getRegistrationEntriesCount(registrationId, currentCycleId);
  const reservedSlotsList = parseReservedSlots(registration.reservedSlots, registration.totalSlots);
  const maxAvailable = Math.max(0, registration.totalSlots - reservedSlotsList.length);
  const availableSlots = Math.max(0, maxAvailable - filledCount);
  const reservedDisplay = reservedSlotsList.length > 0 ? reservedSlotsList.join(', ') : 'None';

  // Controls row 1: Edit Settings, Manage Reserved Slots, Open/Close, View Current Slot Chart
  const editSettingsBtn = new ButtonBuilder()
    .setCustomId(`md_cfg_edit_reg_${registrationId}`)
    .setLabel('Edit Settings')
    .setEmoji('✏️')
    .setStyle(ButtonStyle.Primary);

  const manageReservedBtn = new ButtonBuilder()
    .setCustomId(`md_cfg_manage_res_${registrationId}`)
    .setLabel('Manage Reserved Slots')
    .setEmoji('🔒')
    .setStyle(ButtonStyle.Secondary);

  const toggleStatusBtn = new ButtonBuilder()
    .setCustomId(`md_cfg_toggle_status_${registrationId}`)
    .setLabel(registration.status === 'OPEN' ? 'Close Registration' : 'Open Registration')
    .setEmoji(registration.status === 'OPEN' ? '🔒' : '🔓')
    .setStyle(registration.status === 'OPEN' ? ButtonStyle.Danger : ButtonStyle.Success);

  const viewSlotChartBtn = new ButtonBuilder()
    .setCustomId(`md_cfg_view_slotchart_${registrationId}`)
    .setLabel('View Current Slot Chart')
    .setEmoji('📋')
    .setStyle(ButtonStyle.Secondary);

  const row1 = new ActionRowBuilder().addComponents(editSettingsBtn, manageReservedBtn, toggleStatusBtn, viewSlotChartBtn);

  // Controls row 2: View Previous Cycles, Refresh, Delete
  const viewCyclesBtn = new ButtonBuilder()
    .setCustomId(`md_cfg_view_cycles_${registrationId}`)
    .setLabel('View Previous Cycles')
    .setEmoji('📜')
    .setStyle(ButtonStyle.Secondary);

  const refreshSlotChartBtn = new ButtonBuilder()
    .setCustomId(`md_cfg_refresh_slotchart_${registrationId}`)
    .setLabel('Refresh')
    .setEmoji('🔄')
    .setStyle(ButtonStyle.Secondary);

  const deleteBtn = new ButtonBuilder()
    .setCustomId(`md_cfg_delete_reg_${registrationId}`)
    .setLabel('Delete Registration')
    .setEmoji('🗑️')
    .setStyle(ButtonStyle.Danger);

  const row2 = new ActionRowBuilder().addComponents(viewCyclesBtn, refreshSlotChartBtn, deleteBtn);

  const content =
    `🛠️ **Managing: ${registration.displayName}**\n\n` +
    `• **Name:** ${registration.displayName}\n` +
    `• **Current Cycle Status:** \`${registration.status}\` (Cycle: \`${registration.currentCycleDate || 'N/A'}\`)\n` +
    `• **Total Slots:** \`${registration.totalSlots}\`\n` +
    `• **Reserved Slots:** \`${reservedDisplay}\`\n` +
    `• **Registered Teams:** \`${filledCount}/${maxAvailable}\`\n` +
    `• **Available Slots:** \`${availableSlots}\`\n` +
    `• **Daily Start Time:** \`${registration.dailyStartTime || 'N/A'}\` (${registration.timezone || 'IST'})\n` +
    `• **Daily Reset Time:** \`${registration.dailyResetTime || 'N/A'}\` (${registration.timezone || 'IST'})\n` +
    `• **Registration Channel:** <#${registration.registrationChannelId}>\n` +
    `• **IDP Channel:** <#${registration.idpChannelId}>\n`;

  await interaction.update({
    content,
    components: [row1, row2],
  });
}

/**
 * Toggles a registration instance between OPEN and CLOSED.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} registrationId
 */
export async function handleToggleStatus(interaction, registrationId) {
  const registration = await getConfigurableRegistration(registrationId);
  if (!registration) {
    return interaction.reply({ content: '❌ Registration instance not found.', ephemeral: true });
  }

  registration.status = registration.status === 'OPEN' ? 'CLOSED' : 'OPEN';
  await saveConfigurableRegistration(registration);

  await updateRegistrationMessage(interaction.client, registrationId);
  await updateSlotChartMessage(interaction.client, registrationId);

  await interaction.reply({
    content: `✅ Registration status updated to **${registration.status}**.`,
    ephemeral: true,
  });
}

/**
 * Opens modal to edit registration settings (Name, Total Slots, Daily Start Time, Daily Reset Time).
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} registrationId
 */
export async function handleEditRegistrationButton(interaction, registrationId) {
  const registration = await getConfigurableRegistration(registrationId);
  if (!registration) {
    return interaction.reply({ content: '❌ Registration instance not found.', ephemeral: true });
  }

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
    new ActionRowBuilder().addComponents(startInput),
    new ActionRowBuilder().addComponents(resetInput)
  );

  await interaction.showModal(modal);
}

/**
 * Handles submission of Edit Registration Settings modal.
 * Enforces rule: "Do not allow capacity to be reduced below already allocated slots."
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
  const rawStart = interaction.fields.getTextInputValue('daily_start_time').trim();
  const rawReset = interaction.fields.getTextInputValue('daily_reset_time').trim();

  if (isNaN(rawSlots) || rawSlots <= 0) {
    return interaction.editReply({ content: '❌ Total slots must be a positive integer.' });
  }

  // Check allocated slots: do not allow capacity to be reduced below already allocated slots
  const filledCount = await getRegistrationEntriesCount(registrationId, registration.currentCycleId);
  if (rawSlots < filledCount) {
    return interaction.editReply({
      content: `❌ Capacity cannot be reduced below already allocated slots (${filledCount} teams currently registered).`,
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

  registration.displayName = newName;
  registration.totalSlots = rawSlots;
  registration.dailyStartTime = parsedStart.formatted;
  registration.dailyResetTime = parsedReset.formatted;
  registration.reservedSlots = parseReservedSlots(registration.reservedSlots, rawSlots);

  await saveConfigurableRegistration(registration);

  await updateRegistrationMessage(interaction.client, registrationId);
  await updateSlotChartMessage(interaction.client, registrationId);

  await interaction.editReply({
    content:
      `✅ **Registration Settings Updated!**\n\n` +
      `• **Name:** ${newName}\n` +
      `• **Total Slots:** ${rawSlots}\n` +
      `• **Daily Start:** ${parsedStart.formatted}\n` +
      `• **Daily Reset:** ${parsedReset.formatted}`,
  });
}

/**
 * Opens modal to manage reserved slot numbers for a registration instance.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} registrationId
 */
export async function handleManageReservedButton(interaction, registrationId) {
  const registration = await getConfigurableRegistration(registrationId);
  if (!registration) {
    return interaction.reply({ content: '❌ Registration instance not found.', ephemeral: true });
  }

  const reservedList = parseReservedSlots(registration.reservedSlots, registration.totalSlots);
  const modal = new ModalBuilder()
    .setCustomId(`md_cfg_manage_res_modal_${registrationId}`)
    .setTitle('Manage Reserved Slots');

  const reservedInput = new TextInputBuilder()
    .setCustomId('reserved_slots')
    .setLabel('Reserved Slot Numbers (comma/space-separated)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 1, 4, 10')
    .setValue(reservedList.join(', '))
    .setRequired(false);

  modal.addComponents(new ActionRowBuilder().addComponents(reservedInput));
  await interaction.showModal(modal);
}

/**
 * Handles submission of Manage Reserved Slots modal.
 * Ensures newly reserved slots are not already occupied by an active registered team.
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 * @param {string} registrationId
 */
export async function handleManageReservedModalSubmit(interaction, registrationId) {
  await interaction.deferReply({ ephemeral: true });

  const registration = await getConfigurableRegistration(registrationId);
  if (!registration) {
    return interaction.editReply({ content: '❌ Registration instance not found.' });
  }

  const rawReserved = interaction.fields.getTextInputValue('reserved_slots')?.trim() || '';
  const newReservedList = parseReservedSlots(rawReserved, registration.totalSlots);

  // Check if any newly reserved slot is occupied by an active registered team
  const entries = await getConfigurableEntriesForRegistration(registrationId, registration.currentCycleId);
  const occupiedSlots = new Set(entries.map((e) => e.slotNumber));
  const conflictingSlots = newReservedList.filter((s) => occupiedSlots.has(s));

  if (conflictingSlots.length > 0) {
    return interaction.editReply({
      content: `❌ Slot(s) ${conflictingSlots.join(', ')} cannot be reserved because they are already occupied by registered teams in the current cycle.`,
    });
  }

  if (newReservedList.length >= registration.totalSlots) {
    return interaction.editReply({
      content: '❌ Reserved slots cannot equal or exceed total capacity.',
    });
  }

  registration.reservedSlots = newReservedList;
  await saveConfigurableRegistration(registration);

  await updateSlotChartMessage(interaction.client, registrationId);
  await updateRegistrationMessage(interaction.client, registrationId);

  await interaction.editReply({
    content: `✅ Reserved slots updated to: \`${newReservedList.length > 0 ? newReservedList.join(', ') : 'None'}\`.`,
  });
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

  const entries = await getConfigurableEntriesForRegistration(registrationId, registration.currentCycleId);
  const embed = buildSlotChartEmbed(registration, entries);

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

/**
 * Shows archived previous cycles for a registration instance.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} registrationId
 */
export async function handleViewPreviousCycles(interaction, registrationId) {
  const registration = await getConfigurableRegistration(registrationId);
  if (!registration) {
    return interaction.reply({ content: '❌ Registration instance not found.', ephemeral: true });
  }

  const cycles = await getDailyCyclesForRegistration(registrationId, 10);
  if (cycles.length === 0) {
    return interaction.reply({
      content: `ℹ️ No archived cycles found yet for **${registration.displayName}**. Cycles are archived daily at ${registration.dailyResetTime || 'scheduled reset time'}.`,
      ephemeral: true,
    });
  }

  const embed = new EmbedBuilder()
    .setColor(0x3b82f6)
    .setTitle(`📜 Previous Cycles — ${registration.displayName}`)
    .setDescription(`Showing the last ${cycles.length} completed daily registration cycles:\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
    .setTimestamp();

  for (const c of cycles) {
    const teamCount = (c.entries || []).length;
    const endedAtStr = c.endedAt ? new Date(c.endedAt).toLocaleString('en-US', { timeZone: registration.timezone || 'Asia/Kolkata' }) : 'N/A';
    embed.addFields({
      name: `Cycle: ${c.cycleDate || c.cycleId}`,
      value: `• **Teams Registered:** ${teamCount}/${c.totalSlots}\n• **Status:** \`${c.status || 'COMPLETED'}\`\n• **Archived:** ${endedAtStr}`,
      inline: false,
    });
  }

  await interaction.reply({ embeds: [embed], ephemeral: true });
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

  await deleteConfigurableRegistration(registrationId);

  await interaction.reply({
    content: `✅ Registration instance **${registration.displayName}** and its associated channels have been deleted.`,
    ephemeral: true,
  });
}
