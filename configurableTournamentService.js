import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import crypto from 'node:crypto';
import {
  saveConfigurableTournament,
  getConfigurableTournament,
  getConfigurableTournamentByCategory,
  getConfigurableTournamentByName,
  getConfigurableTournamentBySetupChannel,
  getAllConfigurableTournaments,
  getConfigurableRegistrationsForTournament,
  getEnrolledTeamsCount,
  getRegistrationEntriesCount,
  findConfigurableRegistrationByChannelId,
  findConfigurableRegistrationByMessageId,
  deleteConfigurableRegistration,
  deleteConfigurableTournament,
  getPendingEnrollment,
  deletePendingEnrollment,
} from './configurableTournamentData.js';
import { queueChannelDelete } from './discordQueue.js';
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
  handleConfirmRegistrationButtonClick,
  handleCancelRegistrationButtonClick,
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
 * Builds tournament prefix from category name:
 * - If first word is a short code (up to 4 chars with digit, e.g. T3), use that word;
 * - Otherwise use initials of words ignoring pure numbers and years ("Champions Trophy S01" -> CTS);
 * - If single word, use that word ("Apex" -> Apex).
 * @param {string} name
 * @returns {string}
 */
export function buildTournamentPrefix(name) {
  if (!name || typeof name !== 'string') return 'MD';
  const trimmed = name.trim();
  if (!trimmed) return 'MD';

  const rawWords = trimmed.split(/\s+/).filter(Boolean);
  if (rawWords.length === 0) return 'MD';

  const words = rawWords
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean);

  if (words.length === 0) return 'MD';

  if (words.length === 1) {
    return words[0];
  }

  const firstWord = words[0];
  if (firstWord.length <= 4 && /\d/.test(firstWord)) {
    return firstWord;
  }

  const nonNumberWords = words.filter((w) => !/^\d+$/.test(w));
  if (nonNumberWords.length === 0) {
    return firstWord;
  }

  if (nonNumberWords.length === 1) {
    return nonNumberWords[0];
  }

  const initials = nonNumberWords
    .map((w) => {
      const match = w.match(/[\p{L}\p{N}]/u);
      return match ? match[0].toUpperCase() : '';
    })
    .filter(Boolean)
    .join('');

  return initials || firstWord;
}

/**
 * Converts alphanumeric characters into Unicode Mathematical Bold:
 * A-Z -> 𝐀-𝐙 [offset 0x1D400-65], a-z -> 𝐚-𝐳 [offset 0x1D41A-97], 0-9 -> 𝟎-𝟗 [offset 0x1D7CE-48].
 * @param {string} str
 * @returns {string}
 */
export function toMathematicalBold(str) {
  if (!str || typeof str !== 'string') return '';
  let result = '';
  for (const ch of str) {
    const code = ch.charCodeAt(0);
    if (code >= 65 && code <= 90) {
      result += String.fromCodePoint(0x1D400 + (code - 65));
    } else if (code >= 97 && code <= 122) {
      result += String.fromCodePoint(0x1D41A + (code - 97));
    } else if (code >= 48 && code <= 57) {
      result += String.fromCodePoint(0x1D7CE + (code - 48));
    } else {
      result += ch;
    }
  }
  return result;
}

/**
 * Creates a Discord channel formatted with `<bold prefix>｜<fallbackSuffix>`.
 * On Discord rejection, logs exact error and retries once with plain fallback `${cleanPrefix}-${cleanSuffix}`.
 * @param {import('discord.js').Guild} guild
 * @param {object} options
 * @returns {Promise<import('discord.js').GuildChannel>}
 */
export async function createTournamentChannel(guild, {
  boldPrefix,
  rawPrefix,
  fallbackSuffix,
  type = ChannelType.GuildText,
  parent,
  permissionOverwrites = [],
  topic = '',
}) {
  const cleanSuffix = (fallbackSuffix || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const cleanPrefix = (rawPrefix || 'md').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'md';
  const plainFallback = `${cleanPrefix}-${cleanSuffix}`;
  const primaryName = `${boldPrefix}\uFF5C${cleanSuffix}`;

  try {
    return await guild.channels.create({
      name: primaryName,
      type,
      parent,
      permissionOverwrites,
      topic,
    });
  } catch (err) {
    console.warn(`[ConfigurableTournament] ⚠️ Discord rejected channel creation with name "${primaryName}": ${err.message}. Retrying once with plain fallback "${plainFallback}"...`);
    return await guild.channels.create({
      name: plainFallback,
      type,
      parent,
      permissionOverwrites,
      topic,
    });
  }
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

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`md_cfg_delete_tournament_${tournamentId}`)
      .setLabel('Delete Tournament')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger)
  );

  return [row1, row2, row3];
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
    if (err?.code === 10003 || err?.code === 50001 || err?.code === 50013) {
      // 10003: Unknown Channel, 50001: Missing Access, 50013: Missing Permissions
      return false;
    }
    console.error(`[ConfigurableTournament] ❌ Error refreshing dashboard for ${tournamentId}:`, err);
    return false;
  }
}

const activeCreationLocks = new Set();

/**
 * Handles the `.setup tournament` text command.
 * Admin-only command that can be run in any channel.
 * Step 1: Replies with a short message and an "Enter Category Name" button.
 * @param {import('discord.js').Message} message
 */
export async function handleSetupTournamentCommand(message) {
  // Check organizer / admin permissions
  const hasPerm =
    message.member?.permissions?.has?.(PermissionFlagsBits.Administrator) ||
    message.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild);

  if (!hasPerm) {
    return message.reply('❌ You need `Manage Server` or `Administrator` permissions to setup a tournament.');
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('md_cfg_btn_enter_category_name')
      .setLabel('Enter Category Name')
      .setEmoji('📝')
      .setStyle(ButtonStyle.Primary)
  );

  return message.reply({
    content: '🏆 **Tournament Setup**\nClick the button below to enter your tournament category name.',
    components: [row],
  });
}

/**
 * Handles "Enter Category Name" button click.
 * Opens the modal form asking for category name.
 * @param {import('discord.js').ButtonInteraction} interaction
 */
export async function handleEnterCategoryNameButton(interaction) {
  const hasPerm =
    interaction.member?.permissions?.has?.(PermissionFlagsBits.Administrator) ||
    interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild);

  if (!hasPerm) {
    return interaction.reply({
      content: '❌ You need `Manage Server` or `Administrator` permissions to setup a tournament.',
      ephemeral: true,
    });
  }

  const modal = new ModalBuilder()
    .setCustomId('md_cfg_modal_category_name')
    .setTitle('Tournament Setup');

  const nameInput = new TextInputBuilder()
    .setCustomId('category_name')
    .setLabel('Category Name')
    .setPlaceholder('e.g. T3 Scrims or Champions Trophy S01')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);

  modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
  return interaction.showModal(modal);
}

/**
 * Handles tournament creation modal submission (Step 2).
 * Creates Discord category, setup channel, saves tournament in MongoDB,
 * posts the central dashboard, and replies with a link to setup channel.
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 */
export async function handleCreateTournamentModalSubmit(interaction) {
  const hasPerm =
    interaction.member?.permissions?.has?.(PermissionFlagsBits.Administrator) ||
    interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild);

  if (!hasPerm) {
    return interaction.reply({
      content: '❌ You need `Manage Server` or `Administrator` permissions to setup a tournament.',
      ephemeral: true,
    });
  }

  const categoryName = interaction.fields?.getTextInputValue?.('category_name')?.trim();
  if (!categoryName) {
    return interaction.reply({
      content: '❌ Category name cannot be empty.',
      ephemeral: true,
    });
  }

  const guild = interaction.guild;
  if (!guild) {
    return interaction.reply({
      content: '❌ This command can only be used within a server.',
      ephemeral: true,
    });
  }

  // Refuse if a tournament with this category name already exists on this server
  const existingTour = await getConfigurableTournamentByName(guild.id, categoryName);
  if (existingTour) {
    return interaction.reply({
      content: `❌ A tournament with the category name "${categoryName}" already exists on this server.`,
      ephemeral: true,
    });
  }

  const lockKey = `${guild.id}:${categoryName.toLowerCase()}`;
  if (activeCreationLocks.has(lockKey)) {
    return interaction.reply({
      content: `⚠️ Tournament setup for "${categoryName}" is already in progress. Please wait.`,
      ephemeral: true,
    });
  }
  activeCreationLocks.add(lockKey);

  try {
    await interaction.deferReply({ ephemeral: true });

    // Step 2: Create category
    const category = await guild.channels.create({
      name: categoryName,
      type: ChannelType.GuildCategory,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: TOURNAMENT_DENIED_PERMISSIONS,
        },
      ],
    });

    const rawPrefix = buildTournamentPrefix(categoryName);
    const boldPrefix = toMathematicalBold(rawPrefix);

    const botId = interaction.client?.user?.id || guild.members?.me?.id;
    const overwrites = [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
    ];
    if (botId) {
      overwrites.push({
        id: botId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels,
        ],
      });
    }

    // Create private setup channel visible only to administrators and bot
    const setupChannel = await createTournamentChannel(guild, {
      boldPrefix,
      rawPrefix,
      fallbackSuffix: 'setup',
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: overwrites,
    });

    const tournament = {
      tournamentId: crypto.randomUUID(),
      guildId: guild.id,
      categoryId: category.id,
      setupChannelId: setupChannel.id,
      dashboardMessageId: null,
      name: categoryName,
      nameLower: categoryName.toLowerCase(),
      prefix: rawPrefix,
      boldPrefix,
      requiredDiscordMembers: 4,
      standardChannels: null,
      createdBy: interaction.user.id,
      createdAt: new Date(),
    };

    await saveConfigurableTournament(tournament);

    // Post persistent dashboard in setup channel
    await refreshDashboard(interaction.client, tournament.tournamentId);

    // Reply to admin with link to setup channel
    return await interaction.editReply({
      content: `✅ Tournament **${categoryName}** created successfully! Head over to <#${setupChannel.id}> to manage it.`,
    });
  } catch (err) {
    console.error(`[ConfigurableTournament] ❌ Error creating tournament "${categoryName}":`, err);
    const errorMsg = `❌ Failed to create tournament: ${err.message || err}`;
    if (interaction.deferred || interaction.replied) {
      return await interaction.editReply({ content: errorMsg });
    }
    return await interaction.reply({ content: errorMsg, ephemeral: true });
  } finally {
    activeCreationLocks.delete(lockKey);
  }
}

/**
 * Handles "Create Standard Channels" button click.
 * Creates verify, updates, and info channels in the category if they don't already exist.
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
    const rawPrefix = tournament.prefix || buildTournamentPrefix(tournament.name);
    const boldPrefix = tournament.boldPrefix || toMathematicalBold(rawPrefix);

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

    // 1. Verify channel (Shared squad enrollment)
    const verifyChannel = await createTournamentChannel(guild, {
      boldPrefix,
      rawPrefix,
      fallbackSuffix: 'verify',
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

    // 2. Updates channel (Announcements)
    const updatesChannel = await createTournamentChannel(guild, {
      boldPrefix,
      rawPrefix,
      fallbackSuffix: 'updates',
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

    // 3. Info channel (Rules & Information)
    const infoChannel = await createTournamentChannel(guild, {
      boldPrefix,
      rawPrefix,
      fallbackSuffix: 'info',
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
      prefix: rawPrefix,
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

    // Get the paired channel before deleting/clearing stored IDs
    const otherChannelId = registration.registrationChannelId === channel.id
      ? registration.idpChannelId
      : registration.registrationChannelId;

    // Delete and cleanup registration (archives entries, revokes IDP access, marks DELETED)
    await deleteConfigurableRegistration(registration.registrationId, client);

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
 * Handles "Delete Tournament" button click.
 * Displays the confirmation screen.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} tournamentId
 */
export async function handleDeleteTournamentButton(interaction, tournamentId) {
  const hasPerm =
    interaction.member?.permissions?.has?.(PermissionFlagsBits.Administrator) ||
    interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild);

  if (!hasPerm) {
    return interaction.reply({
      content: '❌ Only administrators can delete this tournament.',
      ephemeral: true,
    });
  }

  const tournament = await getConfigurableTournament(tournamentId);
  if (!tournament) {
    return interaction.reply({
      content: '❌ Tournament configuration not found or already deleted.',
      ephemeral: true,
    });
  }

  const guild = interaction.guild;
  const categoryId = tournament.categoryId;
  let channelCount = 0;
  if (guild && categoryId) {
    if (typeof guild.channels?.cache?.filter === 'function') {
      channelCount = guild.channels.cache.filter((c) => c && c.parentId === categoryId).size;
    } else if (guild.channels?.cache) {
      channelCount = Array.from(guild.channels.cache.values()).filter((c) => c && c.parentId === categoryId).length;
    }
  }

  const confirmationText = `Delete **${tournament.name}**? This permanently deletes the category and all **${channelCount}** channels inside it, including every registration channel and IDP channel. This can't be undone.`;

  const confirmEmbed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(`⚠️ Delete Tournament Confirmation`)
    .setDescription(confirmationText);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`md_cfg_del_tour_confirm_${tournamentId}`)
      .setLabel('Confirm Delete')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`md_cfg_del_tour_cancel_${tournamentId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );

  return interaction.update({
    content: `Delete ${tournament.name}? This permanently deletes the category and all ${channelCount} channels inside it, including every registration channel and IDP channel. This can't be undone.`,
    embeds: [confirmEmbed],
    components: [row],
  });
}

/**
 * Handles "Cancel" button on Delete Tournament confirmation.
 * Restores the dashboard.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} tournamentId
 */
export async function handleDeleteTournamentCancel(interaction, tournamentId) {
  const hasPerm =
    interaction.member?.permissions?.has?.(PermissionFlagsBits.Administrator) ||
    interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild);

  if (!hasPerm) {
    return interaction.reply({
      content: '❌ Only administrators can manage this tournament.',
      ephemeral: true,
    });
  }

  const tournament = await getConfigurableTournament(tournamentId);
  if (!tournament) {
    return interaction.update({
      content: '❌ Tournament not found or already deleted.',
      embeds: [],
      components: [],
    });
  }

  const registrations = await getConfigurableRegistrationsForTournament(tournamentId);
  const enrolledCount = await getEnrolledTeamsCount(tournamentId);

  const embed = buildDashboardEmbed(tournament, registrations, enrolledCount);
  const components = buildDashboardButtons(tournamentId);

  return interaction.update({ content: null, embeds: [embed], components });
}

/**
 * Handles "Confirm Delete" on Delete Tournament confirmation.
 * Deletes all channels in category (setup channel last) via queueChannelDelete,
 * deletes category, cleans MongoDB, and sends ephemeral follow-up summary.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} tournamentId
 */
export async function handleDeleteTournamentConfirm(interaction, tournamentId) {
  const hasPerm =
    interaction.member?.permissions?.has?.(PermissionFlagsBits.Administrator) ||
    interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild);

  if (!hasPerm) {
    return interaction.reply({
      content: '❌ Only administrators can delete this tournament.',
      ephemeral: true,
    });
  }

  const tournament = await getConfigurableTournament(tournamentId, true);
  if (!tournament || tournament.status === 'DELETED') {
    return interaction.reply({
      content: '❌ Tournament not found or already deleted.',
      ephemeral: true,
    });
  }

  if (!interaction.deferred && !interaction.replied) {
    if (typeof interaction.deferReply === 'function') {
      await interaction.deferReply({ ephemeral: true });
    } else if (typeof interaction.deferUpdate === 'function') {
      await interaction.deferUpdate();
    }
  }

  const guild = interaction.guild;
  const categoryId = tournament.categoryId;
  const setupChannelId = tournament.setupChannelId;

  let deletedChannelsCount = 0;
  const failures = [];

  if (guild && categoryId) {
    let childChannels = [];
    if (guild.channels?.cache) {
      childChannels = Array.from(guild.channels.cache.values()).filter((c) => c && c.parentId === categoryId);
    }
    if (childChannels.length === 0 && typeof guild.channels?.fetch === 'function') {
      try {
        const fetched = await guild.channels.fetch();
        childChannels = Array.from(fetched.values()).filter((c) => c && c.parentId === categoryId);
      } catch {}
    }

    // Setup channel deleted last
    const nonSetupChannels = childChannels.filter((c) => c.id !== setupChannelId);
    const setupChannel = childChannels.find((c) => c.id === setupChannelId) || (setupChannelId && guild.channels?.cache?.get?.(setupChannelId));

    for (const channel of nonSetupChannels) {
      try {
        await queueChannelDelete(channel, `Tournament deletion: ${tournament.name}`);
        deletedChannelsCount++;
      } catch (err) {
        console.error(`[ConfigurableTournament] ❌ Failed to delete channel ${channel.name || channel.id}:`, err);
        failures.push(channel.name || channel.id);
      }
    }

    if (setupChannel) {
      try {
        await queueChannelDelete(setupChannel, `Tournament deletion: ${tournament.name}`);
        deletedChannelsCount++;
      } catch (err) {
        console.error(`[ConfigurableTournament] ❌ Failed to delete setup channel ${setupChannel.name || setupChannel.id}:`, err);
        failures.push(setupChannel.name || setupChannel.id);
      }
    }

    // Now delete category
    const category = guild.channels?.cache?.get?.(categoryId) || (await guild.channels.fetch(categoryId).catch(() => null));
    if (category) {
      try {
        await queueChannelDelete(category, `Tournament deletion: ${tournament.name}`);
      } catch (err) {
        console.error(`[ConfigurableTournament] ❌ Failed to delete category ${category.name || categoryId}:`, err);
        failures.push(category.name || categoryId);
      }
    }
  }

  // Clean MongoDB (soft-delete tournament, soft-delete registrations, archive active entries with slots released, revoke IDP access)
  await deleteConfigurableTournament(tournamentId, interaction.client);

  const summary =
    `🗑️ **Tournament "${tournament.name}" Deleted**\n` +
    `• Successfully deleted **${deletedChannelsCount}** channel(s) and category.\n` +
    (failures.length > 0 ? `• ⚠️ Failed to delete: ${failures.join(', ')}\n` : '') +
    `• All tournament data, registrations, and slots have been safely cleaned and archived.`;

  if (typeof interaction.editReply === 'function') {
    return await interaction.editReply({ content: summary });
  } else if (typeof interaction.followUp === 'function') {
    return await interaction.followUp({ content: summary, ephemeral: true });
  } else if (typeof interaction.reply === 'function') {
    return await interaction.reply({ content: summary, ephemeral: true });
  }
}

/**
 * Main dispatcher for all md_cfg_ interactions (buttons, modals, selects).
 * @param {import('discord.js').Interaction} interaction
 * @returns {Promise<boolean>}
 */
export async function handleConfigurableTournamentInteraction(interaction) {
  const customId = interaction.customId || '';

  // 0a. Enter Category Name button (Step 1 of .setup tournament)
  if (customId === 'md_cfg_btn_enter_category_name') {
    await handleEnterCategoryNameButton(interaction);
    return true;
  }

  // 0b. Create Tournament modal submit (Step 2 of .setup tournament)
  if (customId === 'md_cfg_modal_category_name') {
    await handleCreateTournamentModalSubmit(interaction);
    return true;
  }

  // 0c. Delete Tournament button
  if (customId.startsWith('md_cfg_delete_tournament_')) {
    const tournamentId = customId.replace('md_cfg_delete_tournament_', '');
    await handleDeleteTournamentButton(interaction, tournamentId);
    return true;
  }

  // 0d. Delete Tournament Confirm
  if (customId.startsWith('md_cfg_del_tour_confirm_')) {
    const tournamentId = customId.replace('md_cfg_del_tour_confirm_', '');
    await handleDeleteTournamentConfirm(interaction, tournamentId);
    return true;
  }

  // 0e. Delete Tournament Cancel
  if (customId.startsWith('md_cfg_del_tour_cancel_')) {
    const tournamentId = customId.replace('md_cfg_del_tour_cancel_', '');
    await handleDeleteTournamentCancel(interaction, tournamentId);
    return true;
  }

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

/**
 * Resolves tournamentId from rawId or contextual fallbacks (message, channel, category, guild).
 * @param {import('discord.js').Interaction} interaction
 * @param {string} [rawId]
 * @returns {Promise<string|null>}
 */
async function resolveTournamentId(interaction, rawId) {
  const cleanRawId = (rawId || '').trim();
  if (cleanRawId) {
    const tour = await getConfigurableTournament(cleanRawId);
    if (tour && tour.status !== 'DELETED' && !tour.isDeleted) return tour.tournamentId;
  }

  // 1. Check if interaction message matches a tournament verifyMessageId or dashboard message
  if (interaction.message?.id) {
    const allTournaments = await getAllConfigurableTournaments(interaction.guildId || null);
    const matched = allTournaments.find(
      (t) =>
        t.standardChannels?.verifyMessageId === interaction.message.id ||
        t.dashboardMessageId === interaction.message.id
    );
    if (matched) return matched.tournamentId;
  }

  // 2. Check channel ID (verify channel, setup channel, etc.)
  if (interaction.channelId) {
    const allTournaments = await getAllConfigurableTournaments(interaction.guildId || null);
    const matchedChannel = allTournaments.find(
      (t) =>
        t.standardChannels?.verifyChannelId === interaction.channelId ||
        t.standardChannels?.updatesChannelId === interaction.channelId ||
        t.standardChannels?.infoChannelId === interaction.channelId ||
        t.setupChannelId === interaction.channelId
    );
    if (matchedChannel) return matchedChannel.tournamentId;
  }

  // 3. Check category / parentId
  const parentId = interaction.channel?.parentId;
  if (parentId && interaction.guildId) {
    const tourByCategory = await getConfigurableTournamentByCategory(interaction.guildId, parentId);
    if (tourByCategory) return tourByCategory.tournamentId;
  }

  // 4. If guild has only 1 active tournament, resolve to it
  if (interaction.guildId) {
    const allTournaments = await getAllConfigurableTournaments(interaction.guildId);
    const active = allTournaments.filter((t) => t.status !== 'DELETED' && !t.isDeleted);
    if (active.length === 1) {
      return active[0].tournamentId;
    }
  }

  return cleanRawId || null;
}

  // 4. Enroll Squad button (opens modal or manages squad)
  const isEnrollButton =
    (customId.startsWith('md_cfg_enroll_') &&
      !customId.startsWith('md_cfg_enroll_modal_') &&
      !customId.startsWith('md_cfg_enroll_users_')) ||
    customId === 'md_cfg_enroll' ||
    customId === 'enroll_squad' ||
    customId.startsWith('enroll_squad_') ||
    customId.startsWith('md_enroll_') ||
    customId === 'md_enroll' ||
    customId.startsWith('enroll_') ||
    customId === 'enroll';

  if (isEnrollButton) {
    let rawTournamentId = '';
    if (customId.startsWith('md_cfg_enroll_')) {
      rawTournamentId = customId.replace('md_cfg_enroll_', '');
    } else if (customId.startsWith('enroll_squad_')) {
      rawTournamentId = customId.replace('enroll_squad_', '');
    } else if (customId.startsWith('md_enroll_')) {
      rawTournamentId = customId.replace('md_enroll_', '');
    } else if (customId.startsWith('enroll_')) {
      rawTournamentId = customId.replace('enroll_', '');
    }
    const tournamentId = await resolveTournamentId(interaction, rawTournamentId);
    await handleEnrollButtonClick(interaction, tournamentId);
    return true;
  }

  // Manage Squad button
  const isManageSquadButton =
    customId.startsWith('md_cfg_my_squad_') ||
    customId === 'md_cfg_my_squad' ||
    customId === 'my_squad' ||
    customId.startsWith('my_squad_') ||
    customId === 'manage_squad' ||
    customId.startsWith('manage_squad_') ||
    customId.startsWith('md_my_squad_') ||
    customId.startsWith('md_manage_squad_');

  if (isManageSquadButton) {
    let rawTournamentId = '';
    if (customId.startsWith('md_cfg_my_squad_')) {
      rawTournamentId = customId.replace('md_cfg_my_squad_', '');
    } else if (customId.startsWith('my_squad_')) {
      rawTournamentId = customId.replace('my_squad_', '');
    } else if (customId.startsWith('manage_squad_')) {
      rawTournamentId = customId.replace('manage_squad_', '');
    } else if (customId.startsWith('md_my_squad_')) {
      rawTournamentId = customId.replace('md_my_squad_', '');
    } else if (customId.startsWith('md_manage_squad_')) {
      rawTournamentId = customId.replace('md_manage_squad_', '');
    }
    const tournamentId = await resolveTournamentId(interaction, rawTournamentId);
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
    const rawRegistrationId = customId.replace('md_cfg_reg_btn_', '');
    // Resolve the registration from the channel ID or message ID where the button was clicked
    let registration = null;
    if (interaction.channelId) {
      registration = await findConfigurableRegistrationByChannelId(interaction.channelId);
    }
    if (!registration && interaction.message?.id) {
      registration = await findConfigurableRegistrationByMessageId(interaction.message.id);
    }
    if (!registration && rawRegistrationId) {
      registration = await getConfigurableRegistration(rawRegistrationId);
    }

    if (!registration || registration.status === 'DELETED' || registration.isDeleted) {
      return interaction.reply({
        content: '❌ Registration instance not found or has been deleted.',
        ephemeral: true,
      });
    }

    await handleRegisterSquadButtonClick(interaction, registration.registrationId);
    return true;
  }

  // 9a. Confirm Registration button
  if (customId.startsWith('md_cfg_reg_confirm_')) {
    const payload = customId.replace('md_cfg_reg_confirm_', '');
    let registrationId, teamId;
    if (payload.includes(':')) {
      [registrationId, teamId] = payload.split(':');
    } else {
      const parts = payload.split('_');
      registrationId = parts[0];
      teamId = parts.slice(1).join('_');
    }
    await handleConfirmRegistrationButtonClick(interaction, registrationId, teamId);
    return true;
  }

  // 9b. Cancel Registration button
  if (customId.startsWith('md_cfg_reg_cancel_')) {
    const payload = customId.replace('md_cfg_reg_cancel_', '');
    let registrationId, teamId;
    if (payload.includes(':')) {
      [registrationId, teamId] = payload.split(':');
    } else if (payload.includes('_')) {
      const parts = payload.split('_');
      registrationId = parts[0];
      teamId = parts.slice(1).join('_');
    }
    await handleCancelRegistrationButtonClick(interaction, registrationId, teamId);
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
