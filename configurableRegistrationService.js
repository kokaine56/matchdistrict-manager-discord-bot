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
} from './configurableTournamentData.js';
import { updateSlotChartMessage } from './slotChartService.js';

/**
 * Builds the Embed for a public Registration Channel.
 * @param {object} registration
 * @param {number} filledCount
 * @returns {EmbedBuilder}
 */
export function buildRegistrationEmbed(registration, filledCount = 0) {
  const totalSlots = registration.totalSlots || 20;
  const reservedSlots = registration.reservedSlots || 0;
  const availableSlots = Math.max(0, totalSlots - reservedSlots - filledCount);
  const isOpen = registration.status === 'OPEN';

  return new EmbedBuilder()
    .setColor(isOpen ? 0x22c55e : registration.status === 'CLOSED' ? 0xef4444 : 0x3b82f6)
    .setTitle(`🎟️ Registration — ${registration.displayName}`)
    .setDescription(
      `**Status:** \`${registration.status || 'OPEN'}\`\n` +
      `**Total Capacity:** \`${totalSlots}\` slots\n` +
      `**Slots Filled:** \`${filledCount}/${totalSlots - reservedSlots}\`\n` +
      `**Remaining Slots:** \`${availableSlots}\`\n\n` +
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

    const filledCount = await getRegistrationEntriesCount(registrationId);
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
 * Displays the modal for adding a new registration instance.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} tournamentId
 */
export async function handleAddRegistrationButton(interaction, tournamentId) {
  const modal = new ModalBuilder()
    .setCustomId(`md_cfg_add_reg_modal_${tournamentId}`)
    .setTitle('Create New Registration Instance');

  const nameInput = new TextInputBuilder()
    .setCustomId('display_name')
    .setLabel('Registration Name / Group')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. Group A - 7:00 PM, Qualifier 1')
    .setMinLength(2)
    .setMaxLength(50)
    .setRequired(true);

  const capacityInput = new TextInputBuilder()
    .setCustomId('total_slots')
    .setLabel('Total Slots / Capacity')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 20 (Default: 20)')
    .setValue('20')
    .setRequired(true);

  const reservedInput = new TextInputBuilder()
    .setCustomId('reserved_slots')
    .setLabel('Reserved Slots')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 0')
    .setValue('0')
    .setRequired(false);

  const startInput = new TextInputBuilder()
    .setCustomId('starts_at')
    .setLabel('Start Time (Optional: YYYY-MM-DD HH:mm)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Leave empty for immediately OPEN')
    .setRequired(false);

  const endInput = new TextInputBuilder()
    .setCustomId('ends_at')
    .setLabel('End Time (Optional: YYYY-MM-DD HH:mm)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Leave empty for no automatic close')
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(nameInput),
    new ActionRowBuilder().addComponents(capacityInput),
    new ActionRowBuilder().addComponents(reservedInput),
    new ActionRowBuilder().addComponents(startInput),
    new ActionRowBuilder().addComponents(endInput)
  );

  await interaction.showModal(modal);
}

/**
 * Parses user-provided date string or returns null.
 * @param {string} val
 * @returns {Date|null}
 */
function parseDateTimeInput(val) {
  if (!val) return null;
  const trimmed = val.trim();
  if (!trimmed || trimmed.toLowerCase() === 'now' || trimmed.toLowerCase() === 'immediate') {
    return null;
  }
  const d = new Date(trimmed);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Handles submission of the Add Registration modal.
 * Creates registration & IDP channels, posts messages, and saves data.
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 * @param {string} tournamentId
 */
export async function handleAddRegistrationModalSubmit(interaction, tournamentId) {
  await interaction.deferReply({ ephemeral: true });

  const tournament = await getConfigurableTournament(tournamentId);
  if (!tournament) {
    return interaction.editReply({ content: '❌ Tournament configuration not found.' });
  }

  const displayName = interaction.fields.getTextInputValue('display_name').trim();
  const rawTotal = parseInt(interaction.fields.getTextInputValue('total_slots').trim(), 10);
  const totalSlots = isNaN(rawTotal) || rawTotal <= 0 ? 20 : rawTotal;
  const rawReserved = parseInt(interaction.fields.getTextInputValue('reserved_slots')?.trim() || '0', 10);
  const reservedSlots = isNaN(rawReserved) || rawReserved < 0 ? 0 : rawReserved;

  const startsAt = parseDateTimeInput(interaction.fields.getTextInputValue('starts_at'));
  const endsAt = parseDateTimeInput(interaction.fields.getTextInputValue('ends_at'));

  const now = new Date();
  const status = startsAt && startsAt > now ? 'UPCOMING' : 'OPEN';

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
          deny: [PermissionFlagsBits.SendMessages],
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
          deny: [PermissionFlagsBits.ViewChannel],
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
      reservedSlots,
      startsAt: startsAt ? startsAt.toISOString() : null,
      endsAt: endsAt ? endsAt.toISOString() : null,
      status,
      createdAt: new Date(),
    };

    await saveConfigurableRegistration(registrationDoc);

    // 3. Post Persistent Registration Message
    await updateRegistrationMessage(interaction.client, registrationId);

    // 4. Post Persistent Slot Chart Message in IDP channel
    await updateSlotChartMessage(interaction.client, registrationId);

    await interaction.editReply({
      content:
        `✅ **Registration Instance Created!**\n\n` +
        `**Name:** ${displayName}\n` +
        `**Status:** \`${status}\`\n` +
        `**Capacity:** ${totalSlots} slots (Reserved: ${reservedSlots})\n` +
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
 * Strict IDP Permissions: ONLY the Team Leader receives access to the IDP channel.
 * Multiple Registrations: Enrolled team CAN register in multiple instances of the tournament.
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
      content: `❌ Registration is currently **${registration.status || 'CLOSED'}**.`,
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

  // 2. Check if team is ALREADY registered in THIS instance
  const existingEntry = await getConfigurableEntry(registrationId, team.teamId);
  if (existingEntry) {
    return interaction.reply({
      content:
        `❌ Your team **${team.teamName}** is already registered in this instance!\n` +
        `Assigned to **Slot #${existingEntry.slotNumber}** in <#${registration.idpChannelId}>.`,
      ephemeral: true,
    });
  }

  // 3. Check capacity
  const filledCount = await getRegistrationEntriesCount(registrationId);
  const maxAvailable = registration.totalSlots - (registration.reservedSlots || 0);

  if (filledCount >= maxAvailable) {
    return interaction.reply({
      content: '❌ Sorry, all available slots for this registration instance are currently full!',
      ephemeral: true,
    });
  }

  // 4. Allocate next available slot
  const slotNumber = await getNextAvailableSlot(registrationId, registration.totalSlots);
  if (!slotNumber) {
    return interaction.reply({
      content: '❌ No available slot number could be allocated.',
      ephemeral: true,
    });
  }

  // 5. Save confirmed entry
  const entryDoc = {
    entryId: crypto.randomUUID(),
    registrationId,
    tournamentId: registration.tournamentId,
    guildId: interaction.guildId,
    teamId: team.teamId,
    teamName: team.teamName,
    leaderDiscordId: interaction.user.id,
    slotNumber,
    status: 'CONFIRMED',
    registeredAt: new Date(),
  };

  await saveConfigurableEntry(entryDoc);

  // 6. STRICT IDP PERMISSIONS: Grant ViewChannel access ONLY to the Team Leader
  try {
    const idpChannel = await interaction.guild.channels.fetch(registration.idpChannelId).catch(() => null);
    if (idpChannel) {
      await idpChannel.permissionOverwrites.edit(interaction.user.id, {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: true,
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
 * Shows select menu with existing registration instances.
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
        description: `Capacity: ${r.totalSlots} | Number: #${r.registrationNumber}`,
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
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 * @param {string} tournamentId
 */
export async function handleManageSelectMenu(interaction, tournamentId) {
  const registrationId = interaction.values[0];
  const registration = await getConfigurableRegistration(registrationId);

  if (!registration) {
    return interaction.reply({ content: '❌ Registration instance not found.', ephemeral: true });
  }

  const filledCount = await getRegistrationEntriesCount(registrationId);

  const toggleStatusBtn = new ButtonBuilder()
    .setCustomId(`md_cfg_toggle_status_${registrationId}`)
    .setLabel(registration.status === 'OPEN' ? 'Close Registration' : 'Open Registration')
    .setEmoji(registration.status === 'OPEN' ? '🔒' : '🔓')
    .setStyle(registration.status === 'OPEN' ? ButtonStyle.Danger : ButtonStyle.Success);

  const refreshSlotChartBtn = new ButtonBuilder()
    .setCustomId(`md_cfg_refresh_slotchart_${registrationId}`)
    .setLabel('Refresh Slot Chart')
    .setEmoji('🔄')
    .setStyle(ButtonStyle.Secondary);

  const deleteBtn = new ButtonBuilder()
    .setCustomId(`md_cfg_delete_reg_${registrationId}`)
    .setLabel('Delete Registration')
    .setEmoji('🗑️')
    .setStyle(ButtonStyle.Danger);

  const row = new ActionRowBuilder().addComponents(toggleStatusBtn, refreshSlotChartBtn, deleteBtn);

  await interaction.update({
    content:
      `🛠️ **Managing: ${registration.displayName}**\n\n` +
      `• **Status:** \`${registration.status}\`\n` +
      `• **Slots:** ${filledCount}/${registration.totalSlots} filled\n` +
      `• **Registration Channel:** <#${registration.registrationChannelId}>\n` +
      `• **IDP Channel:** <#${registration.idpChannelId}>\n`,
    components: [row],
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

