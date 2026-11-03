import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
} from 'discord.js';
import crypto from 'node:crypto';
import {
  saveConfigurableTournament,
  getConfigurableTournament,
  getConfigurableTournamentByCategory,
  getConfigurableTournamentBySetupChannel,
  getConfigurableRegistrationsForTournament,
  getEnrolledTeamsCount,
  getRegistrationEntriesCount,
  findConfigurableRegistrationByChannelId,
} from './configurableTournamentData.js';
import {
  sendOrUpdateEnrollmentMessage,
  handleEnrollButtonClick,
  handleEnrollModalSubmit,
  handleEnrollUserSelect,
} from './teamEnrollmentService.js';
import {
  handleAddRegistrationButton,
  handleAddRegistrationModalSubmit,
  handleRegisterSquadButtonClick,
  handleManageRegistrationsButton,
  handleManageSelectMenu,
  handleToggleStatus,
  handleDeleteRegistration,
} from './configurableRegistrationService.js';
import { updateSlotChartMessage } from './slotChartService.js';

/**
 * Builds the persistent dashboard embed for the private setup channel.
 * @param {object} tournament
 * @param {Array<object>} registrations
 * @param {number} enrolledCount
 * @returns {EmbedBuilder}
 */
export function buildDashboardEmbed(tournament, registrations = [], enrolledCount = 0) {
  const std = tournament.standardChannels;

  const channelsText = std
    ? `• **Verify:** <#${std.verifyChannelId}>\n• **Updates:** <#${std.updatesChannelId}>\n• **Info:** <#${std.infoChannelId}>`
    : `⚠️ *Standard channels not created yet. Click "Create Standard Channels" below.*`;

  let regsText = 'ℹ️ *No active registration instances.*';
  if (registrations.length > 0) {
    regsText = registrations
      .map(
        (r) =>
          `• **${r.displayName}** (\`${r.status}\`) — Capacity: \`${r.totalSlots}\` | Reg: <#${r.registrationChannelId}> | IDP: <#${r.idpChannelId}>`
      )
      .join('\n');
  }

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🏆 Tournament Management Dashboard`)
    .setDescription(
      `**Tournament:** \`${tournament.name}\`\n` +
      `**Category ID:** \`${tournament.categoryId}\`\n` +
      `**Enrolled Squads:** \`${enrolledCount}\`\n` +
      `**Active Registrations:** \`${registrations.length}\`\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📁 **Standard Channels:**\n${channelsText}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🎟️ **Registration Instances:**\n${regsText}`
    )
    .setFooter({ text: 'Match District Tournament Manager' })
    .setTimestamp();
}

/**
 * Builds the dashboard interactive button rows.
 * @param {string} tournamentId
 * @returns {Array<ActionRowBuilder>}
 */
export function buildDashboardButtons(tournamentId) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`md_cfg_create_channels_${tournamentId}`)
      .setLabel('Create Standard Channels')
      .setEmoji('📁')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`md_cfg_view_channels_${tournamentId}`)
      .setLabel('View Channels')
      .setEmoji('👁️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`md_cfg_refresh_dash_${tournamentId}`)
      .setLabel('Refresh')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`md_cfg_add_reg_${tournamentId}`)
      .setLabel('Add Registration')
      .setEmoji('➕')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`md_cfg_manage_regs_${tournamentId}`)
      .setLabel('Manage Registrations')
      .setEmoji('⚙️')
      .setStyle(ButtonStyle.Primary)
  );

  return [row1, row2];
}

/**
 * Refreshes or creates the persistent dashboard message in the setup channel.
 * @param {import('discord.js').Client} client
 * @param {string} tournamentId
 * @returns {Promise<boolean>}
 */
export async function refreshDashboard(client, tournamentId) {
  try {
    const tournament = await getConfigurableTournament(tournamentId);
    if (!tournament || !tournament.setupChannelId) return false;

    const channel = await client.channels.fetch(tournament.setupChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return false;

    const registrations = await getConfigurableRegistrationsForTournament(tournamentId);
    const enrolledCount = await getEnrolledTeamsCount(tournamentId);

    const embed = buildDashboardEmbed(tournament, registrations, enrolledCount);
    const components = buildDashboardButtons(tournamentId);

    if (tournament.dashboardMessageId) {
      try {
        const existing = await channel.messages.fetch(tournament.dashboardMessageId).catch(() => null);
        if (existing) {
          await existing.edit({ embeds: [embed], components });
          return true;
        }
      } catch {
        // Fall through to send new
      }
    }

    const msg = await channel.send({ embeds: [embed], components });
    tournament.dashboardMessageId = msg.id;
    await saveConfigurableTournament(tournament);
    return true;
  } catch (err) {
    console.error(`[ConfigurableTournament] ❌ Error refreshing dashboard for ${tournamentId}:`, err);
    return false;
  }
}

/**
 * Handles the `.setup tournament` text command.
 * Must be executed in a setup channel located within a Discord category.
 * Idempotently initializes the tournament and generates the persistent dashboard.
 * @param {import('discord.js').Message} message
 */
export async function handleSetupTournamentCommand(message) {
  // Check organizer / admin permissions
  const hasPerm =
    message.member?.permissions.has(PermissionFlagsBits.Administrator) ||
    message.member?.permissions.has(PermissionFlagsBits.ManageGuild);

  if (!hasPerm) {
    return message.reply('❌ You need `Manage Server` or `Administrator` permissions to setup a tournament.');
  }

  const category = message.channel.parent;
  if (!category || category.type !== ChannelType.GuildCategory) {
    return message.reply(
      '❌ **Invalid Location:** The `.setup tournament` command must be executed within a setup channel inside a **Discord Category**.'
    );
  }

  const guildId = message.guild.id;
  const categoryId = category.id;
  const setupChannelId = message.channel.id;

  // Retrieve existing tournament or create a new record
  let tournament = await getConfigurableTournamentByCategory(guildId, categoryId);

  if (!tournament) {
    tournament = {
      tournamentId: crypto.randomUUID(),
      guildId,
      categoryId,
      setupChannelId,
      dashboardMessageId: null,
      name: category.name,
      standardChannels: null,
      createdBy: message.author.id,
      createdAt: new Date(),
    };
  } else {
    // Update setup channel to current channel if changed
    tournament.setupChannelId = setupChannelId;
    tournament.name = category.name;
  }

  await saveConfigurableTournament(tournament);

  // Send or update the persistent dashboard
  await refreshDashboard(message.client, tournament.tournamentId);

  // Delete triggering user command to keep setup channel clean
  try {
    await message.delete().catch(() => {});
  } catch {
    // Ignore deletion errors
  }
}

/**
 * Handles "Create Standard Channels" button click.
 * Creates T3-Verify, T3-Updates, T3-Info in the category if they don't already exist.
 * The setup channel itself is NEVER deleted or recreated.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} tournamentId
 */
export async function handleCreateStandardChannels(interaction, tournamentId) {
  await interaction.deferReply({ ephemeral: true });

  const tournament = await getConfigurableTournament(tournamentId);
  if (!tournament) {
    return interaction.editReply({ content: '❌ Tournament configuration not found.' });
  }

  const guild = interaction.guild;
  const categoryId = tournament.categoryId;

  if (tournament.standardChannels?.verifyChannelId) {
    // Channels already created
    return interaction.editReply({
      content:
        `ℹ️ Standard channels already exist for this tournament:\n` +
        `• **Verify:** <#${tournament.standardChannels.verifyChannelId}>\n` +
        `• **Updates:** <#${tournament.standardChannels.updatesChannelId}>\n` +
        `• **Info:** <#${tournament.standardChannels.infoChannelId}>`,
    });
  }

  try {
    const prefix = 'T3';

    // 1. T3-Verify (Shared squad enrollment)
    const verifyChannel = await guild.channels.create({
      name: `${prefix}-verify`,
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

    // 2. T3-Updates (Announcements)
    const updatesChannel = await guild.channels.create({
      name: `${prefix}-updates`,
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

    // 3. T3-Info (Rules & Information)
    const infoChannel = await guild.channels.create({
      name: `${prefix}-info`,
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

    tournament.standardChannels = {
      verifyChannelId: verifyChannel.id,
      updatesChannelId: updatesChannel.id,
      infoChannelId: infoChannel.id,
      verifyMessageId: null,
      prefix,
    };

    await saveConfigurableTournament(tournament);

    // Post persistent squad enrollment message in verify channel
    await sendOrUpdateEnrollmentMessage(interaction.client, tournament);

    // Post informational messages in updates and info channels
    const updateEmbed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`📢 Announcements — ${tournament.name}`)
      .setDescription('Official announcements and schedules will be posted here.')
      .setTimestamp();
    await updatesChannel.send({ embeds: [updateEmbed] }).catch(() => {});

    const infoEmbed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`ℹ️ Tournament Information & Rules — ${tournament.name}`)
      .setDescription(
        `**Tournament Rules & Guidelines:**\n` +
        `• All squad members must be verified in <#${verifyChannel.id}>.\n` +
        `• IDP credentials will be posted exclusively in the private IDP channels to registered team leaders.\n` +
        `• Fair play and sportsmanship are strictly enforced.`
      )
      .setTimestamp();
    await infoChannel.send({ embeds: [infoEmbed] }).catch(() => {});

    // Refresh dashboard in setup channel
    await refreshDashboard(interaction.client, tournamentId);

    await interaction.editReply({
      content:
        `✅ **Standard channels created successfully!**\n\n` +
        `• **Verify:** <#${verifyChannel.id}>\n` +
        `• **Updates:** <#${updatesChannel.id}>\n` +
        `• **Info:** <#${infoChannel.id}>`,
    });
  } catch (err) {
    console.error('[ConfigurableTournament] ❌ Error creating standard channels:', err);
    await interaction.editReply({
      content: `❌ Failed to create standard channels: ${err.message}`,
    });
  }
}

/**
 * Handles "View Channels" button.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} tournamentId
 */
export async function handleViewChannels(interaction, tournamentId) {
  const tournament = await getConfigurableTournament(tournamentId);
  if (!tournament) {
    return interaction.reply({ content: '❌ Tournament not found.', ephemeral: true });
  }

  const std = tournament.standardChannels;
  const registrations = await getConfigurableRegistrationsForTournament(tournamentId);

  const lines = [
    `📁 **Setup Channel:** <#${tournament.setupChannelId}>`,
    `🛡️ **Verify Channel:** ${std ? `<#${std.verifyChannelId}>` : '*None*'}`,
    `📢 **Updates Channel:** ${std ? `<#${std.updatesChannelId}>` : '*None*'}`,
    `ℹ️ **Info Channel:** ${std ? `<#${std.infoChannelId}>` : '*None*'}`,
  ];

  if (registrations.length > 0) {
    lines.push('\n🎟️ **Registration Instances:**');
    for (const r of registrations) {
      lines.push(`• **${r.displayName}:** Reg: <#${r.registrationChannelId}> | IDP: <#${r.idpChannelId}>`);
    }
  }

  await interaction.reply({
    content: lines.join('\n'),
    ephemeral: true,
  });
}

/**
 * Synchronizes channel renames.
 * When a registration channel is renamed, automatically renames the linked IDP channel.
 * Prevents rename loops; renaming an IDP channel does NOT rename the registration channel.
 * @param {import('discord.js').GuildChannel} oldChannel
 * @param {import('discord.js').GuildChannel} newChannel
 */
export async function handleConfigurableChannelUpdate(oldChannel, newChannel) {
  if (oldChannel.name === newChannel.name) return;

  const registration = await findConfigurableRegistrationByChannelId(newChannel.id);
  if (!registration) return;

  // Only trigger when the REGISTRATION channel is renamed
  if (registration.registrationChannelId !== newChannel.id) {
    return;
  }

  // Determine target IDP channel name
  let targetIdpName;
  if (newChannel.name.endsWith('-reg')) {
    targetIdpName = newChannel.name.slice(0, -4) + '-idp';
  } else {
    targetIdpName = `${newChannel.name}-idp`;
  }

  try {
    const idpChannel = await newChannel.guild.channels.fetch(registration.idpChannelId).catch(() => null);
    if (idpChannel && idpChannel.name !== targetIdpName) {
      await idpChannel.setName(targetIdpName, 'Sync with renamed registration channel');
    }
  } catch (err) {
    console.warn(`[ConfigurableTournament] ⚠️ Failed to rename linked IDP channel:`, err.message);
  }
}

/**
 * Main dispatcher for all md_cfg_ interactions (buttons, modals, selects).
 * @param {import('discord.js').Interaction} interaction
 * @returns {Promise<boolean>}
 */
export async function handleConfigurableTournamentInteraction(interaction) {
  const customId = interaction.customId || '';

  // 1. Create standard channels
  if (customId.startsWith('md_cfg_create_channels_')) {
    const tournamentId = customId.replace('md_cfg_create_channels_', '');
    await handleCreateStandardChannels(interaction, tournamentId);
    return true;
  }

  // 2. View channels
  if (customId.startsWith('md_cfg_view_channels_')) {
    const tournamentId = customId.replace('md_cfg_view_channels_', '');
    await handleViewChannels(interaction, tournamentId);
    return true;
  }

  // 3. Refresh dashboard
  if (customId.startsWith('md_cfg_refresh_dash_')) {
    const tournamentId = customId.replace('md_cfg_refresh_dash_', '');
    await refreshDashboard(interaction.client, tournamentId);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '✅ Dashboard refreshed.', ephemeral: true });
    }
    return true;
  }

  // 4. Enroll Squad button (opens modal)
  if (
    customId.startsWith('md_cfg_enroll_') &&
    !customId.startsWith('md_cfg_enroll_modal_') &&
    !customId.startsWith('md_cfg_enroll_users_')
  ) {
    const tournamentId = customId.replace('md_cfg_enroll_', '');
    await handleEnrollButtonClick(interaction, tournamentId);
    return true;
  }

  // 5. Enroll Squad modal submit
  if (customId.startsWith('md_cfg_enroll_modal_')) {
    const tournamentId = customId.replace('md_cfg_enroll_modal_', '');
    await handleEnrollModalSubmit(interaction, tournamentId);
    return true;
  }

  // 6. Enroll Squad user select menu
  if (customId.startsWith('md_cfg_enroll_users_')) {
    const tournamentId = customId.replace('md_cfg_enroll_users_', '');
    await handleEnrollUserSelect(interaction, tournamentId);
    return true;
  }

  // 7. Add Registration button (opens modal)
  if (customId.startsWith('md_cfg_add_reg_') && !customId.startsWith('md_cfg_add_reg_modal_')) {
    const tournamentId = customId.replace('md_cfg_add_reg_', '');
    await handleAddRegistrationButton(interaction, tournamentId);
    return true;
  }

  // 8. Add Registration modal submit
  if (customId.startsWith('md_cfg_add_reg_modal_')) {
    const tournamentId = customId.replace('md_cfg_add_reg_modal_', '');
    await handleAddRegistrationModalSubmit(interaction, tournamentId);
    return true;
  }

  // 9. Register button in registration channel
  if (customId.startsWith('md_cfg_reg_btn_')) {
    const registrationId = customId.replace('md_cfg_reg_btn_', '');
    await handleRegisterSquadButtonClick(interaction, registrationId);
    return true;
  }

  // 10. Manage Registrations button
  if (customId.startsWith('md_cfg_manage_regs_')) {
    const tournamentId = customId.replace('md_cfg_manage_regs_', '');
    await handleManageRegistrationsButton(interaction, tournamentId);
    return true;
  }

  // 11. Manage registration select menu
  if (customId.startsWith('md_cfg_manage_reg_select_')) {
    const tournamentId = customId.replace('md_cfg_manage_reg_select_', '');
    await handleManageSelectMenu(interaction, tournamentId);
    return true;
  }

  // 12. Toggle registration status
  if (customId.startsWith('md_cfg_toggle_status_')) {
    const registrationId = customId.replace('md_cfg_toggle_status_', '');
    await handleToggleStatus(interaction, registrationId);
    return true;
  }

  // 13. Refresh slot chart
  if (customId.startsWith('md_cfg_refresh_slotchart_')) {
    const registrationId = customId.replace('md_cfg_refresh_slotchart_', '');
    await updateSlotChartMessage(interaction.client, registrationId);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '✅ Slot chart refreshed.', ephemeral: true });
    }
    return true;
  }

  // 14. Delete registration
  if (customId.startsWith('md_cfg_delete_reg_')) {
    const registrationId = customId.replace('md_cfg_delete_reg_', '');
    await handleDeleteRegistration(interaction, registrationId);
    return true;
  }

  return false;
}
