import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
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
  deleteConfigurableRegistration,
  getPendingEnrollment,
  deletePendingEnrollment,
} from './configurableTournamentData.js';
import {
  sendOrUpdateEnrollmentMessage,
  handleEnrollButtonClick,
  showStep1Modal,
  handleStep1ModalSubmit,
  showStep2Modal,
  handleStep2ModalSubmit,
  showStep3Modal,
  handleStep3ModalSubmit,
  handleSkipSubstitutes,
  showStep5DiscordSelection,
  handleStep5UserSelect,
  handleManageMySquadButton,
  handleEditSquadButtonClick,
  handleDeleteSquadPrompt,
  handleDeleteSquadConfirm,
  handleDeleteSquadCancel,
} from './teamEnrollmentService.js';

export const TOURNAMENT_DENIED_PERMISSIONS = [
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
];
import {
  handleAddRegistrationButton,
  handleAddRegistrationModalSubmit,
  handleRegisterSquadButtonClick,
  handleManageRegistrationsButton,
  handleManageSelectMenu,
  handleToggleStatus,
  handleDeleteRegistration,
  handleEditRegistrationButton,
  handleEditRegistrationModalSubmit,
  handleViewCurrentSlotChart,
  handleRefreshRegistration,
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

  const reqMembers = tournament.requiredDiscordMembers ?? 4;
  const reqMembersText = reqMembers === 1
    ? '`1 Member` *(Leader only)*'
    : `\`${reqMembers} Members\` *(Leader + ${reqMembers - 1} teammate${reqMembers > 2 ? 's' : ''})*`;

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🏆 Tournament Management Dashboard`)
    .setDescription(
      `**Tournament:** \`${tournament.name}\`\n` +
      `**Category ID:** \`${tournament.categoryId}\`\n` +
      `**Enrolled Squads:** \`${enrolledCount}\`\n` +
      `**Active Registrations:** \`${registrations.length}\`\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `⚙️ **Tournament Settings:**\n` +
      `• **Required Discord Members:** ${reqMembersText}\n\n` +
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
      .setEmoji('📋')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`md_cfg_settings_${tournamentId}`)
      .setLabel('Tournament Settings')
      .setEmoji('⚙️')
      .setStyle(ButtonStyle.Secondary)
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

  // Deny thread creation at category level
  if (typeof category.permissionOverwrites?.edit === 'function') {
    await category.permissionOverwrites.edit(message.guild.roles.everyone.id, {
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      SendMessagesInThreads: false,
      ManageThreads: false,
      ManageChannels: false,
      ManageRoles: false,
    }).catch(() => {});
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

    // Deny thread permissions at category level
    const category = interaction.channel?.parent || (await guild.channels.fetch(categoryId).catch(() => null));
    if (category && typeof category.permissionOverwrites?.edit === 'function') {
      await category.permissionOverwrites.edit(guild.roles.everyone.id, {
        CreatePublicThreads: false,
        CreatePrivateThreads: false,
        SendMessagesInThreads: false,
        ManageThreads: false,
        ManageChannels: false,
        ManageRoles: false,
      }).catch(() => {});
    }

    // 1. T3-Verify (Shared squad enrollment)
    const verifyChannel = await guild.channels.create({
      name: `${prefix}-verify`,
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

    // 2. T3-Updates (Announcements)
    const updatesChannel = await guild.channels.create({
      name: `${prefix}-updates`,
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

    // 3. T3-Info (Rules & Information)
    const infoChannel = await guild.channels.create({
      name: `${prefix}-info`,
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
 * Handles automatic cleanup when a configurable tournament registration channel
 * or linked IDP channel is deleted directly in Discord.
 * - Marks registration as DELETED (status = 'DELETED', isDeleted = true)
 * - Archives current cycle entries (status = 'ARCHIVED', releases slots, never hard deletes)
 * - Revokes IDP access for that registration only
 * - Removes persistent message stored IDs
 * - Updates central dashboard
 * - Ensures nothing from the deleted registration counts in allocations or counters
 * @param {import('discord.js').GuildChannel} channel
 */
export async function handleConfigurableChannelDelete(channel) {
  if (!channel || !channel.id) return;
  try {
    const registration = await findConfigurableRegistrationByChannelId(channel.id, false);
    if (!registration) return;

    console.log(`[ConfigurableTournament] 🗑️ Detected deletion of channel #${channel.name || channel.id} for registration "${registration.displayName}" (${registration.registrationId}). Cleaning up...`);

    const client = channel.client;

    // Delete and cleanup registration (archives entries, revokes IDP access, marks DELETED)
    await deleteConfigurableRegistration(registration.registrationId, client);

    // Also delete the paired channel if it still exists in the guild
    const otherChannelId = registration.registrationChannelId === channel.id
      ? registration.idpChannelId
      : registration.registrationChannelId;

    if (otherChannelId && channel.guild) {
      try {
        const otherChan = channel.guild.channels.cache?.get?.(otherChannelId) ||
          await channel.guild.channels.fetch(otherChannelId).catch(() => null);
        if (otherChan) {
          await otherChan.delete('Configurable tournament paired channel cleanup').catch(() => null);
        }
      } catch (err) {
        console.warn(`[ConfigurableTournament] ⚠️ Error cleaning up paired channel ${otherChannelId}:`, err.message);
      }
    }

    // Refresh central dashboard
    if (client && registration.tournamentId) {
      await refreshDashboard(client, registration.tournamentId).catch(() => {});
    }
  } catch (err) {
    console.warn(`[ConfigurableTournament] ⚠️ Error handling channel deletion for #${channel.id}:`, err.message);
  }
}

/**
 * Displays the Tournament Settings configuration panel.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} tournamentId
 */
export async function handleTournamentSettingsButton(interaction, tournamentId) {
  const tournament = await getConfigurableTournament(tournamentId);
  if (!tournament) {
    return interaction.reply({ content: '❌ Tournament configuration not found.', ephemeral: true });
  }

  const reqMembers = tournament.requiredDiscordMembers ?? 4;

  const select = new StringSelectMenuBuilder()
    .setCustomId(`md_cfg_set_req_members_${tournamentId}`)
    .setPlaceholder('Choose Required Discord Members...')
    .addOptions([
      {
        label: '1 Member',
        description: 'Leader only',
        value: '1',
        default: reqMembers === 1,
      },
      {
        label: '2 Members',
        description: 'Leader + 1 teammate',
        value: '2',
        default: reqMembers === 2,
      },
      {
        label: '3 Members',
        description: 'Leader + 2 teammates',
        value: '3',
        default: reqMembers === 3,
      },
      {
        label: '4 Members',
        description: 'Leader + 3 teammates',
        value: '4',
        default: reqMembers === 4,
      },
    ]);

  const row = new ActionRowBuilder().addComponents(select);

  await interaction.reply({
    content:
      `⚙️ **Tournament Settings — ${tournament.name}**\n\n` +
      `**Required Discord Members**\n` +
      `Choose how many Discord server members must be associated with a team during enrollment. The team leader is always included.\n\n` +
      `📌 *Current Setting:* **${reqMembers} Member${reqMembers > 1 ? 's' : ''}** (${reqMembers === 1 ? 'Leader only' : `Leader + ${reqMembers - 1} teammate(s)`})\n\n` +
      `Select a new value below to modify:`,
    components: [row],
    ephemeral: true,
  });
}

/**
 * Handles changing the Required Discord Members setting.
 * Saves to MongoDB and edits the persistent dashboard in-place without creating a new message.
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 * @param {string} tournamentId
 */
export async function handleSetRequiredMembers(interaction, tournamentId) {
  const tournament = await getConfigurableTournament(tournamentId);
  if (!tournament) {
    return interaction.reply({ content: '❌ Tournament configuration not found.', ephemeral: true });
  }

  const selectedVal = parseInt(interaction.values[0], 10);
  if (isNaN(selectedVal) || selectedVal < 1 || selectedVal > 4) {
    return interaction.reply({
      content: '❌ Invalid setting value. Allowed values are 1, 2, 3, or 4.',
      ephemeral: true,
    });
  }

  tournament.requiredDiscordMembers = selectedVal;
  await saveConfigurableTournament(tournament);

  // Edit existing persistent dashboard in place
  await refreshDashboard(interaction.client, tournamentId);

  const desc = selectedVal === 1
    ? 'Leader only'
    : `Leader + ${selectedVal - 1} teammate${selectedVal > 2 ? 's' : ''}`;

  await interaction.update({
    content:
      `✅ **Required Discord Members updated to ${selectedVal} Member${selectedVal > 1 ? 's' : ''}** (${desc})!\n\n` +
      `Persistent tournament dashboard has been updated in-place.`,
    components: [],
  });
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

  // 4. Enroll Squad button (opens modal or manages squad)
  if (
    customId.startsWith('md_cfg_enroll_') &&
    !customId.startsWith('md_cfg_enroll_modal_') &&
    !customId.startsWith('md_cfg_enroll_users_')
  ) {
    const tournamentId = customId.replace('md_cfg_enroll_', '');
    await handleEnrollButtonClick(interaction, tournamentId);
    return true;
  }

  // Manage Squad button
  if (customId.startsWith('md_cfg_my_squad_')) {
    const tournamentId = customId.replace('md_cfg_my_squad_', '');
    await handleManageMySquadButton(interaction, tournamentId);
    return true;
  }

  // Step 1 modal submit (or legacy enroll modal)
  if (customId.startsWith('md_cfg_step1_modal_') || customId.startsWith('md_cfg_enroll_modal_')) {
    const tournamentId = customId.startsWith('md_cfg_step1_modal_')
      ? customId.replace('md_cfg_step1_modal_', '')
      : customId.replace('md_cfg_enroll_modal_', '');
    await handleStep1ModalSubmit(interaction, tournamentId);
    return true;
  }

  // Navigation to Step 2
  if (customId.startsWith('md_cfg_goto_step2_')) {
    const tournamentId = customId.replace('md_cfg_goto_step2_', '');
    await showStep2Modal(interaction, tournamentId);
    return true;
  }

  // Step 2 modal submit
  if (customId.startsWith('md_cfg_step2_modal_')) {
    const tournamentId = customId.replace('md_cfg_step2_modal_', '');
    await handleStep2ModalSubmit(interaction, tournamentId);
    return true;
  }

  // Navigation back to Step 1
  if (customId.startsWith('md_cfg_back_to_step1_')) {
    const tournamentId = customId.replace('md_cfg_back_to_step1_', '');
    const session = await getPendingEnrollment(tournamentId, interaction.user.id);
    await showStep1Modal(interaction, tournamentId, session);
    return true;
  }

  // Navigation to Step 3 (Substitutes)
  if (customId.startsWith('md_cfg_goto_step3_')) {
    const tournamentId = customId.replace('md_cfg_goto_step3_', '');
    await showStep3Modal(interaction, tournamentId);
    return true;
  }

  // Skip Step 3 (Substitutes)
  if (customId.startsWith('md_cfg_skip_step3_')) {
    const tournamentId = customId.replace('md_cfg_skip_step3_', '');
    await handleSkipSubstitutes(interaction, tournamentId);
    return true;
  }

  // Step 3 modal submit
  if (customId.startsWith('md_cfg_step3_modal_')) {
    const tournamentId = customId.replace('md_cfg_step3_modal_', '');
    await handleStep3ModalSubmit(interaction, tournamentId);
    return true;
  }

  // Navigation back to Step 2
  if (customId.startsWith('md_cfg_back_to_step2_')) {
    const tournamentId = customId.replace('md_cfg_back_to_step2_', '');
    await showStep2Modal(interaction, tournamentId);
    return true;
  }

  // Navigation to Step 5 (Discord Member Mentions)
  if (customId.startsWith('md_cfg_goto_step5_')) {
    const tournamentId = customId.replace('md_cfg_goto_step5_', '');
    await showStep5DiscordSelection(interaction, tournamentId);
    return true;
  }

  // Step 5 user select menu submit (or legacy enroll users)
  if (customId.startsWith('md_cfg_step5_users_') || customId.startsWith('md_cfg_enroll_users_')) {
    const tournamentId = customId.startsWith('md_cfg_step5_users_')
      ? customId.replace('md_cfg_step5_users_', '')
      : customId.replace('md_cfg_enroll_users_', '');
    await handleStep5UserSelect(interaction, tournamentId);
    return true;
  }

  // Cancel enrollment
  if (customId.startsWith('md_cfg_cancel_enroll_')) {
    const tournamentId = customId.replace('md_cfg_cancel_enroll_', '');
    await deletePendingEnrollment(tournamentId, interaction.user.id);
    await interaction.update({ content: '❌ Enrollment cancelled.', embeds: [], components: [] });
    return true;
  }

  // Edit Squad button
  if (customId.startsWith('md_cfg_edit_squad_btn_')) {
    const teamId = customId.replace('md_cfg_edit_squad_btn_', '');
    await handleEditSquadButtonClick(interaction, teamId);
    return true;
  }

  // Delete Squad prompt
  if (customId.startsWith('md_cfg_del_squad_prompt_')) {
    const teamId = customId.replace('md_cfg_del_squad_prompt_', '');
    await handleDeleteSquadPrompt(interaction, teamId);
    return true;
  }

  // Delete Squad confirm
  if (customId.startsWith('md_cfg_del_squad_confirm_')) {
    const teamId = customId.replace('md_cfg_del_squad_confirm_', '');
    await handleDeleteSquadConfirm(interaction, teamId);
    return true;
  }

  // Delete Squad cancel
  if (customId.startsWith('md_cfg_del_squad_cancel_')) {
    await handleDeleteSquadCancel(interaction);
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

  // 12a. Edit/Rename Registration Settings button & modal
  if (customId.startsWith('md_cfg_edit_reg_modal_') || customId.startsWith('md_cfg_rename_reg_modal_')) {
    const registrationId = customId.startsWith('md_cfg_edit_reg_modal_')
      ? customId.replace('md_cfg_edit_reg_modal_', '')
      : customId.replace('md_cfg_rename_reg_modal_', '');
    await handleEditRegistrationModalSubmit(interaction, registrationId);
    return true;
  }
  if (customId.startsWith('md_cfg_edit_reg_') || customId.startsWith('md_cfg_rename_reg_')) {
    const registrationId = customId.startsWith('md_cfg_edit_reg_')
      ? customId.replace('md_cfg_edit_reg_', '')
      : customId.replace('md_cfg_rename_reg_', '');
    await handleEditRegistrationButton(interaction, registrationId);
    return true;
  }

  // 12b. View Current Slot Chart
  if (customId.startsWith('md_cfg_view_slotchart_')) {
    const registrationId = customId.replace('md_cfg_view_slotchart_', '');
    await handleViewCurrentSlotChart(interaction, registrationId);
    return true;
  }

  // 13. Refresh registration management dashboard or slot chart
  if (customId.startsWith('md_cfg_refresh_reg_')) {
    const registrationId = customId.replace('md_cfg_refresh_reg_', '');
    await handleRefreshRegistration(interaction, registrationId);
    return true;
  }
  if (customId.startsWith('md_cfg_refresh_slotchart_')) {
    const registrationId = customId.replace('md_cfg_refresh_slotchart_', '');
    await handleRefreshRegistration(interaction, registrationId);
    return true;
  }

  // 14. Delete registration
  if (customId.startsWith('md_cfg_delete_reg_')) {
    const registrationId = customId.replace('md_cfg_delete_reg_', '');
    await handleDeleteRegistration(interaction, registrationId);
    return true;
  }

  // 15. Tournament Settings button
  if (customId.startsWith('md_cfg_settings_')) {
    const tournamentId = customId.replace('md_cfg_settings_', '');
    await handleTournamentSettingsButton(interaction, tournamentId);
    return true;
  }

  // 16. Required Discord Members select menu
  if (customId.startsWith('md_cfg_set_req_members_')) {
    const tournamentId = customId.replace('md_cfg_set_req_members_', '');
    await handleSetRequiredMembers(interaction, tournamentId);
    return true;
  }

  return false;
}
