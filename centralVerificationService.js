import {
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import crypto from 'crypto';
import {
  saveCentralVerificationConfig as saveConfigToDb,
  getCentralVerificationConfig as getConfigFromDb,
  loadAllCentralVerificationConfigs,
  getPermanentDiscordIdentityByDiscordId,
  getPermanentDiscordIdentityByMatchDistrictId,
  savePermanentDiscordIdentity,
  createPendingTournamentVerification,
  getPendingTournamentVerification,
  getActivePendingTournamentVerificationForUser,
  finishPendingTournamentVerification,
  expirePendingTournamentVerificationById,
  releasePendingTournamentVerificationClaim,
  saveTournamentToDb,
} from './mongoService.js';
import {
  checkTournamentPlayerExclusivity,
  syncTeamPlayerMemberships,
} from './configurableTournamentData.js';
import { queueRoleAdd } from './discordQueue.js';
import {
  getBackendApiUrl,
  getBackendBotSecret,
  fetchTournamentRegistrationsFromBackend,
  updateTeamsRosterMessages,
  sendTournamentManagementLog,
} from './tournamentService.js';
import { guildSettingsCache } from './index.js';

/**
 * In-memory cache of central verification configurations:
 * Map<guildId, {
 *   guildId: string,
 *   categoryId: string|null,
 *   setupChannelId: string|null,
 *   verifyChannelId: string|null,
 *   dashboardMessageId: string|null,
 *   enabled: boolean,
 *   soloMentionRequirement: number,
 *   duoMentionRequirement: number,
 *   squadMentionRequirement: number,
 *   updatedBy: string|null,
 *   updatedAt: string,
 * }>
 */
export const centralVerificationConfigsCache = new Map();

/**
 * Tracks transient prompt auto-delete timers for confirmation prompts:
 * Map<pendingId, NodeJS.Timeout>
 */
const pendingPromptTimers = new Map();

/**
 * User rate limits for verification submissions in #verify-here:
 * Map<userId, { attempts: number[], blockedUntil: number }>
 */
export const centralVerificationRateLimits = new Map();

/**
 * Checks whether a guild member has administrative authority.
 * @param {import('discord.js').GuildMember} member
 * @returns {boolean}
 */
export function isMemberAdmin(member) {
  if (!member) return false;
  return (
    member.permissions?.has(PermissionFlagsBits.Administrator) ||
    member.permissions?.has(PermissionFlagsBits.ManageGuild) ||
    member.guild?.ownerId === member.id
  );
}

/**
 * Initializes the central verification configuration cache on bot startup.
 */
export async function initCentralVerificationConfigsCache() {
  try {
    const configs = await loadAllCentralVerificationConfigs();
    centralVerificationConfigsCache.clear();
    for (const cfg of configs) {
      if (cfg && cfg.guildId) {
        centralVerificationConfigsCache.set(cfg.guildId, cfg);
      }
    }
    console.log(`[CentralVerification] 🚀 Loaded ${centralVerificationConfigsCache.size} guild verification configs into cache.`);
  } catch (err) {
    console.warn('[CentralVerification] ⚠️ Error loading verification configs cache:', err.message);
  }
}

/**
 * Retrieves the verification config for a guild (cache first, fallback to DB or defaults).
 * @param {string} guildId
 * @returns {object}
 */
export function getCentralVerificationConfig(guildId) {
  if (!guildId) return null;
  const cached = centralVerificationConfigsCache.get(guildId);
  if (cached) return cached;

  return {
    guildId,
    categoryId: null,
    setupChannelId: null,
    verifyChannelId: null,
    dashboardMessageId: null,
    enabled: true,
    soloMentionRequirement: 0,
    duoMentionRequirement: 2,
    squadMentionRequirement: 4,
    updatedBy: null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Builds the administration dashboard embed and components.
 * @param {object} config
 * @param {import('discord.js').Guild} guild
 * @returns {{ embeds: EmbedBuilder[], components: ActionRowBuilder[] }}
 */
export function buildDashboardPayload(config, guild) {
  const isEnabled = config.enabled !== false;
  const statusText = isEnabled ? '🟢 **Enabled**' : '🔴 **Disabled**';
  const updatedByText = config.updatedBy ? `<@${config.updatedBy}>` : 'System';
  const updatedAtText = config.updatedAt ? new Date(config.updatedAt).toUTCString() : 'N/A';

  const embed = new EmbedBuilder()
    .setTitle('🛡️ Central Tournament Verification Dashboard')
    .setColor(isEnabled ? 0x22c55e : 0xef4444)
    .setDescription(
      'Configure the central tournament verification system and set mention requirements for different tournament formats.\n\n' +
      'Players submit their 8-character verification code along with required team mentions in the submissions channel.'
    )
    .addFields(
      { name: 'System Status', value: statusText, inline: true },
      { name: 'Last Updated By', value: updatedByText, inline: true },
      { name: 'Last Updated At', value: updatedAtText, inline: false },
      {
        name: 'Mention Requirements',
        value: [
          `• **Solo:** \`${config.soloMentionRequirement ?? 0}\` mention(s) *(0 = self only, no mentions)*`,
          `• **Duo:** \`${config.duoMentionRequirement ?? 2}\` mention(s) *(verifying user + 1 teammate)*`,
          `• **Squad:** \`${config.squadMentionRequirement ?? 4}\` mention(s) *(verifying user + 3 teammates)*`,
        ].join('\n'),
        inline: false,
      },
      {
        name: 'Connected Channels',
        value: [
          `• **Admin Dashboard:** ${config.setupChannelId ? `<#${config.setupChannelId}>` : '_None_'}`,
          `• **User Submissions:** ${config.verifyChannelId ? `<#${config.verifyChannelId}>` : '_None_'}`,
        ].join('\n'),
        inline: false,
      }
    )
    .setFooter({ text: 'Match District • Tournament Verification Management' })
    .setTimestamp();

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('cver:edit:solo')
      .setLabel('Edit Solo Mentions')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('👤'),
    new ButtonBuilder()
      .setCustomId('cver:edit:duo')
      .setLabel('Edit Duo Mentions')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('👥'),
    new ButtonBuilder()
      .setCustomId('cver:edit:squad')
      .setLabel('Edit Squad Mentions')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🧑‍🤝‍🧑')
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('cver:toggle_status')
      .setLabel(isEnabled ? 'Disable Verification' : 'Enable Verification')
      .setStyle(isEnabled ? ButtonStyle.Danger : ButtonStyle.Success)
      .setEmoji(isEnabled ? '🛑' : '▶️'),
    new ButtonBuilder()
      .setCustomId('cver:view_config')
      .setLabel('View Config')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('📋'),
    new ButtonBuilder()
      .setCustomId('cver:refresh')
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🔄')
  );

  return { embeds: [embed], components: [row1, row2] };
}

/**
 * Updates the existing dashboard message in #verify-setup in-place.
 * @param {import('discord.js').Guild} guild
 * @param {object} config
 * @returns {Promise<boolean>}
 */
export async function updateDashboardMessage(guild, config) {
  if (!guild || !config?.setupChannelId || !config?.dashboardMessageId) return false;
  try {
    let setupChannel = guild.channels?.cache?.get(config.setupChannelId);
    if (!setupChannel && guild.channels?.fetch) {
      setupChannel = await guild.channels.fetch(config.setupChannelId).catch(() => null);
    }
    if (!setupChannel || !setupChannel.messages?.fetch) return false;

    const msg = await setupChannel.messages.fetch(config.dashboardMessageId).catch(() => null);
    if (!msg) return false;

    const payload = buildDashboardPayload(config, guild);
    await msg.edit(payload).catch(() => null);
    return true;
  } catch (err) {
    console.warn('[CentralVerification] Failed updating dashboard message:', err.message);
    return false;
  }
}

/**
 * Executes the .verify command to create or reuse category and channels idempotently.
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildMember} member
 * @param {import('discord.js').TextChannel} channel
 * @param {Function} replyFn
 */
export async function handleCentralVerificationSetupCommand(guild, member, channel, replyFn) {
  if (!guild || !member) return;

  // 1. Check Administrator permissions
  if (!isMemberAdmin(member)) {
    const errorEmbed = new EmbedBuilder()
      .setTitle('⛔ Permission Denied')
      .setColor(0xef4444)
      .setDescription('You must have Administrator or Manage Server permissions to configure Central Tournament Verification.');
    await replyFn({ embeds: [errorEmbed] });
    return;
  }

  // 2. Check Bot Permissions (requires Manage Channels)
  const botMember = guild.members.me || (guild.members.fetchMe ? await guild.members.fetchMe().catch(() => null) : null);
  if (botMember && !botMember.permissions?.has(PermissionFlagsBits.ManageChannels)) {
    const permEmbed = new EmbedBuilder()
      .setTitle('⛔ Missing Permissions')
      .setColor(0xef4444)
      .setDescription('DistrictManager requires the **Manage Channels** permission to create and configure the verification structure.');
    await replyFn({ embeds: [permEmbed] });
    return;
  }

  const existingConfig = getCentralVerificationConfig(guild.id);
  const channelsList = typeof guild.channels?.cache?.values === 'function'
    ? Array.from(guild.channels.cache.values())
    : [];

  // 3. Find or Create VERIFICATION category
  let category = null;
  if (existingConfig.categoryId) {
    category = guild.channels.cache.get(existingConfig.categoryId) ||
      (guild.channels.fetch ? await guild.channels.fetch(existingConfig.categoryId).catch(() => null) : null);
  }
  if (!category) {
    category = channelsList.find(
      (c) => c.type === ChannelType.GuildCategory && c.name?.toUpperCase() === 'VERIFICATION'
    );
  }
  if (!category && guild.channels.create) {
    category = await guild.channels.create({
      name: 'VERIFICATION',
      type: ChannelType.GuildCategory,
    });
  }

  const everyoneRole = guild.roles.everyone;
  const botId = botMember?.id || guild.client?.user?.id;

  // Define permissions for #verify-setup:
  // Admin/Manage server can view/manage; @everyone denied ViewChannel; Bot has full access.
  const setupOverwrites = [
    {
      id: everyoneRole.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
  ];
  if (botId) {
    setupOverwrites.push({
      id: botId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.UseExternalEmojis,
      ],
    });
  }

  // Define permissions for #verify-here:
  // @everyone can view and send messages; THREADS STRICTLY DENIED; Bot has full access.
  const verifyHereOverwrites = [
    {
      id: everyoneRole.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
      ],
      deny: [
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.CreatePrivateThreads,
        PermissionFlagsBits.SendMessagesInThreads,
      ],
    },
  ];
  if (botId) {
    verifyHereOverwrites.push({
      id: botId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    });
  }

  // 4. Find or Create #verify-setup
  let setupChannel = null;
  if (existingConfig.setupChannelId) {
    setupChannel = guild.channels.cache.get(existingConfig.setupChannelId) ||
      (guild.channels.fetch ? await guild.channels.fetch(existingConfig.setupChannelId).catch(() => null) : null);
  }
  if (!setupChannel) {
    setupChannel = channelsList.find(
      (c) => c.type === ChannelType.GuildText && c.name?.toLowerCase() === 'verify-setup'
    );
  }
  if (!setupChannel && guild.channels.create) {
    setupChannel = await guild.channels.create({
      name: 'verify-setup',
      type: ChannelType.GuildText,
      parent: category?.id,
      permissionOverwrites: setupOverwrites,
    });
  } else if (setupChannel) {
    // Ensure parent and permissions are consistent
    if (category?.id && setupChannel.parentId !== category.id && setupChannel.setParent) {
      await setupChannel.setParent(category.id).catch(() => {});
    }
    if (setupChannel.permissionOverwrites?.set) {
      await setupChannel.permissionOverwrites.set(setupOverwrites).catch(() => {});
    }
  }

  // 5. Find or Create #verify-here
  let verifyChannel = null;
  if (existingConfig.verifyChannelId) {
    verifyChannel = guild.channels.cache.get(existingConfig.verifyChannelId) ||
      (guild.channels.fetch ? await guild.channels.fetch(existingConfig.verifyChannelId).catch(() => null) : null);
  }
  if (!verifyChannel) {
    verifyChannel = channelsList.find(
      (c) => c.type === ChannelType.GuildText && c.name?.toLowerCase() === 'verify-here'
    );
  }
  if (!verifyChannel && guild.channels.create) {
    verifyChannel = await guild.channels.create({
      name: 'verify-here',
      type: ChannelType.GuildText,
      parent: category?.id,
      permissionOverwrites: verifyHereOverwrites,
    });
  } else if (verifyChannel) {
    // Ensure parent and permissions are consistent
    if (category?.id && verifyChannel.parentId !== category.id && verifyChannel.setParent) {
      await verifyChannel.setParent(category.id).catch(() => {});
    }
    if (verifyChannel.permissionOverwrites?.set) {
      await verifyChannel.permissionOverwrites.set(verifyHereOverwrites).catch(() => {});
    }
  }

  // 6. Build and Post/Update Dashboard Message in #verify-setup
  const updatedConfig = {
    guildId: guild.id,
    categoryId: category?.id || null,
    setupChannelId: setupChannel?.id || null,
    verifyChannelId: verifyChannel?.id || null,
    dashboardMessageId: existingConfig.dashboardMessageId || null,
    enabled: existingConfig.enabled !== undefined ? existingConfig.enabled : true,
    soloMentionRequirement: existingConfig.soloMentionRequirement ?? 0,
    duoMentionRequirement: existingConfig.duoMentionRequirement ?? 2,
    squadMentionRequirement: existingConfig.squadMentionRequirement ?? 4,
    updatedBy: member.id,
    updatedAt: new Date().toISOString(),
  };

  const payload = buildDashboardPayload(updatedConfig, guild);

  let dashboardMsg = null;
  if (setupChannel?.messages) {
    if (updatedConfig.dashboardMessageId) {
      dashboardMsg = await setupChannel.messages.fetch(updatedConfig.dashboardMessageId).catch(() => null);
    }
    if (dashboardMsg) {
      await dashboardMsg.edit(payload).catch(() => null);
    } else if (setupChannel.send) {
      dashboardMsg = await setupChannel.send(payload);
      updatedConfig.dashboardMessageId = dashboardMsg.id;
    }
  }

  // 7. Persist to MongoDB and memory cache
  await saveConfigToDb(guild.id, updatedConfig);
  centralVerificationConfigsCache.set(guild.id, updatedConfig);

  // 8. Confirm in the channel where .verify was run
  const successEmbed = new EmbedBuilder()
    .setTitle('✅ Central Verification Setup Complete')
    .setColor(0x22c55e)
    .setDescription(
      `Central tournament verification structure is ready:\n\n` +
      `• **Category:** \`${category?.name || 'VERIFICATION'}\`\n` +
      `• **Dashboard:** ${setupChannel ? `<#${setupChannel.id}>` : '_None_'}\n` +
      `• **Submissions:** ${verifyChannel ? `<#${verifyChannel.id}>` : '_None_'}\n\n` +
      `Administrators can customize mention requirements in ${setupChannel ? `<#${setupChannel.id}>` : '#verify-setup'}.`
    );

  await replyFn({ embeds: [successEmbed] });
}

/**
 * Handles all interaction components (buttons, modals) for central verification (prefix `cver:`).
 * @param {import('discord.js').Interaction} interaction
 * @returns {Promise<boolean>}
 */
export async function handleCentralVerificationInteraction(interaction) {
  const customId = interaction.customId || '';
  if (!customId.startsWith('cver:')) return false;

  const guild = interaction.guild;
  if (!guild) return false;

  const config = getCentralVerificationConfig(guild.id);

  // -------------------------------------------------------------
  // Admin Management Actions: cver:edit:*, cver:toggle_status, cver:view_config, cver:refresh, cver:modal:*
  // -------------------------------------------------------------
  if (
    customId.startsWith('cver:edit:') ||
    customId === 'cver:toggle_status' ||
    customId === 'cver:view_config' ||
    customId === 'cver:refresh' ||
    customId.startsWith('cver:modal:')
  ) {
    if (!isMemberAdmin(interaction.member)) {
      await interaction.reply({
        content: '⛔ Only server administrators can manage the tournament verification configuration.',
        ephemeral: true,
      });
      return true;
    }

    // Modal Display: Edit Solo / Duo / Squad Mentions
    if (customId.startsWith('cver:edit:')) {
      const format = customId.split(':')[2]; // 'solo' | 'duo' | 'squad'
      let currentVal = 0;
      if (format === 'solo') currentVal = config.soloMentionRequirement ?? 0;
      else if (format === 'duo') currentVal = config.duoMentionRequirement ?? 2;
      else if (format === 'squad') currentVal = config.squadMentionRequirement ?? 4;

      const modal = new ModalBuilder()
        .setCustomId(`cver:modal:${format}`)
        .setTitle(`Edit ${format.toUpperCase()} Mentions`);

      const input = new TextInputBuilder()
        .setCustomId('cver:input:mentions')
        .setLabel(`Required mentions for ${format} (0-25)`)
        .setStyle(TextInputStyle.Short)
        .setMinLength(1)
        .setMaxLength(2)
        .setRequired(true)
        .setValue(String(currentVal));

      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return true;
    }

    // Modal Submission: Process Mention Requirement Update
    if (customId.startsWith('cver:modal:')) {
      const format = customId.split(':')[2]; // 'solo' | 'duo' | 'squad'
      const rawVal = interaction.fields?.getTextInputValue('cver:input:mentions')?.trim() || '';
      const num = parseInt(rawVal, 10);

      if (isNaN(num) || num < 0 || num > 25 || String(num) !== rawVal) {
        await interaction.reply({
          content: '❌ Invalid input: Mentions requirement must be an integer between 0 and 25.',
          ephemeral: true,
        });
        return true;
      }

      if (format === 'solo') config.soloMentionRequirement = num;
      else if (format === 'duo') config.duoMentionRequirement = num;
      else if (format === 'squad') config.squadMentionRequirement = num;

      config.updatedBy = interaction.user.id;
      config.updatedAt = new Date().toISOString();

      await saveConfigToDb(guild.id, config);
      centralVerificationConfigsCache.set(guild.id, config);
      await updateDashboardMessage(guild, config);

      await interaction.reply({
        content: `✅ Updated **${format.toUpperCase()}** mention requirement to **${num}**.`,
        ephemeral: true,
      });
      return true;
    }

    // Toggle Enable / Disable
    if (customId === 'cver:toggle_status') {
      config.enabled = config.enabled === false ? true : false;
      config.updatedBy = interaction.user.id;
      config.updatedAt = new Date().toISOString();

      await saveConfigToDb(guild.id, config);
      centralVerificationConfigsCache.set(guild.id, config);
      await updateDashboardMessage(guild, config);

      await interaction.reply({
        content: `✅ Central Tournament Verification is now **${config.enabled ? 'Enabled' : 'Disabled'}**.`,
        ephemeral: true,
      });
      return true;
    }

    // View Config
    if (customId === 'cver:view_config') {
      const viewEmbed = new EmbedBuilder()
        .setTitle('⚙️ Central Verification Configuration Details')
        .setColor(0x3b82f6)
        .addFields(
          { name: 'Guild ID', value: `\`${config.guildId || guild.id}\``, inline: true },
          { name: 'Status', value: config.enabled !== false ? '🟢 Enabled' : '🔴 Disabled', inline: true },
          { name: 'Category ID', value: config.categoryId ? `\`${config.categoryId}\`` : '_None_', inline: true },
          { name: 'Setup Channel', value: config.setupChannelId ? `<#${config.setupChannelId}>` : '_None_', inline: true },
          { name: 'Verify Channel', value: config.verifyChannelId ? `<#${config.verifyChannelId}>` : '_None_', inline: true },
          { name: 'Dashboard Msg ID', value: config.dashboardMessageId ? `\`${config.dashboardMessageId}\`` : '_None_', inline: true },
          { name: 'Solo Mentions', value: `\`${config.soloMentionRequirement ?? 0}\``, inline: true },
          { name: 'Duo Mentions', value: `\`${config.duoMentionRequirement ?? 2}\``, inline: true },
          { name: 'Squad Mentions', value: `\`${config.squadMentionRequirement ?? 4}\``, inline: true },
          { name: 'Last Updated By', value: config.updatedBy ? `<@${config.updatedBy}>` : 'System', inline: true },
          { name: 'Last Updated At', value: config.updatedAt ? new Date(config.updatedAt).toUTCString() : 'N/A', inline: false }
        )
        .setTimestamp();

      await interaction.reply({ embeds: [viewEmbed], ephemeral: true });
      return true;
    }

    // Refresh Dashboard In-Place
    if (customId === 'cver:refresh') {
      await updateDashboardMessage(guild, config);
      await interaction.reply({ content: '✅ Dashboard refreshed.', ephemeral: true });
      return true;
    }
  }

  // -------------------------------------------------------------
  // User Verification Confirmation Flow: cver:confirm:* and cver:cancel:*
  // -------------------------------------------------------------
  if (customId.startsWith('cver:confirm:') || customId.startsWith('cver:cancel:')) {
    const action = customId.startsWith('cver:confirm:') ? 'confirm' : 'cancel';
    const pendingId = customId.split(':')[2];

    const pending = await getPendingTournamentVerification(pendingId);
    if (!pending || pending.status !== 'active') {
      const replyFn = interaction.reply || interaction.update;
      if (replyFn) {
        await replyFn.call(interaction, {
          content: '⚠️ This verification session has expired or has already been completed.',
          ephemeral: true,
        });
      }
      return true;
    }

    // Ensure only the user who started this verification can click Confirm or Cancel
    if (String(pending.starterDiscordId) !== String(interaction.user.id)) {
      const replyFn = interaction.reply || interaction.update;
      if (replyFn) {
        await replyFn.call(interaction, {
          content: `⛔ Only <@${pending.starterDiscordId}> can confirm or cancel this verification.`,
          ephemeral: true,
        });
      }
      return true;
    }

    // Clear auto-delete timer
    if (pendingPromptTimers.has(pendingId)) {
      clearTimeout(pendingPromptTimers.get(pendingId));
      pendingPromptTimers.delete(pendingId);
    }

    // Cancel Action
    if (action === 'cancel') {
      await releasePendingTournamentVerificationClaim(pendingId, interaction.user.id);
      await interaction.update({
        content: `<@${interaction.user.id}> ❌ Verification has been cancelled.`,
        embeds: [],
        components: [],
      });
      return true;
    }

    // Confirm Action: Execute verification!
    await interaction.deferUpdate().catch(() => {});

    const tournamentId = pending.tournamentId;
    const registrationId = pending.registrationId;
    const captainId = pending.starterDiscordId;
    const teammateIds = pending.teammateDiscordIds || [];
    const allParticipantIds = [captainId, ...teammateIds];

    // Re-verify exclusivity before final execution
    const exclCheck = await checkTournamentPlayerExclusivity(tournamentId, allParticipantIds, registrationId);
    if (!exclCheck.ok) {
      const conflict = exclCheck.conflicts?.[0];
      await releasePendingTournamentVerificationClaim(pendingId, captainId);
      await interaction.editReply({
        content: `❌ Verification aborted: <@${conflict?.discordId}> is already registered in a verified team for this tournament.`,
        embeds: [],
        components: [],
      });
      return true;
    }

    // Call Website API to complete verification
    let backendVerified = false;
    try {
      const apiUrl = getBackendApiUrl();
      const secret = getBackendBotSecret();
      const response = await fetch(`${apiUrl}/api/bot/verification/complete`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(secret ? { Authorization: `Bearer ${secret}`, 'x-bot-secret': secret } : {}),
          'x-guild-id': guild.id,
        },
        body: JSON.stringify({
          registration_id: registrationId,
          captain_discord_id: captainId,
          teammate_discord_ids: teammateIds,
          guild_id: guild.id,
        }),
      });

      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) {
        if (result.error === 'ALREADY_USED' || result.reason === 'already_used') {
          await finishPendingTournamentVerification(pendingId, captainId, 'completed');
        } else {
          await releasePendingTournamentVerificationClaim(pendingId, captainId);
        }
        await interaction.editReply({
          content: `❌ Verification failed: ${result.message || result.error || 'Server error'}.`,
          embeds: [],
          components: [],
        });
        return true;
      }

      backendVerified = true;
      await finishPendingTournamentVerification(pendingId, captainId, 'completed');

      const resolvedTeamName = result.team_name || pending.teamName || 'Your team';
      const verifiedAt = new Date().toISOString();

      // Update tournament data in cache and MongoDB
      const savedTournament = guildSettingsCache?.[guild.id]?.tournaments?.[tournamentId] || {};
      savedTournament.verifiedRegistrations ||= {};
      savedTournament.verifiedRegistrations[String(registrationId)] = {
        registrationId: String(registrationId),
        teamId: String(registrationId),
        teamName: resolvedTeamName,
        status: 'CONFIRMED',
        discordId: String(captainId),
        verifiedAt,
        mentionedMemberIds: teammateIds,
        captain: {
          ign: result.captain_name || pending.captainName || '',
          uid: result.captain_uid || pending.captainUid || '',
          discord_id: String(captainId),
        },
        squad: Array.isArray(result.squad) ? result.squad : pending.squad,
        substitutes: Array.isArray(result.substitutes) ? result.substitutes : pending.substitutes,
        discordMemberIds: allParticipantIds.map(String),
      };

      if (guildSettingsCache?.[guild.id]) {
        guildSettingsCache[guild.id].tournaments ||= {};
        guildSettingsCache[guild.id].tournaments[tournamentId] = savedTournament;
      }
      await saveTournamentToDb(guild.id, tournamentId, savedTournament);

      // Sync player memberships for exclusivity
      await syncTeamPlayerMemberships({
        tournamentId,
        teamId: String(registrationId),
        teamName: resolvedTeamName,
        leaderDiscordId: String(captainId),
        players: teammateIds.map((id) => ({ discordId: String(id), id: String(id) })),
        status: 'CONFIRMED',
      }).catch((err) => console.warn('[CentralVerification] Warning syncing player memberships:', err.message));

      // Save permanent Match District identity if UID is present
      const captainUid = result.captain_uid || pending.captainUid || result.captain_user_id;
      if (captainUid) {
        await savePermanentDiscordIdentity({
          matchDistrictUserId: captainUid,
          discordUserId: String(captainId),
          discordUsername: interaction.user.tag || interaction.user.username || '',
        }).catch((err) => console.warn('[CentralVerification] Warning saving permanent identity:', err.message));
      }

      // Assign tournament role to all verified members
      if (savedTournament.roleId) {
        for (const uid of allParticipantIds) {
          const m = guild.members.cache.get(uid) || (await guild.members.fetch(uid).catch(() => null));
          if (m) {
            await queueRoleAdd(
              m,
              savedTournament.roleId,
              `Verified participant for ${savedTournament.tournamentTitle || 'tournament'}`
            ).catch(() => {});
          }
        }
      }

      // Send public confirmation announcement in #verify-here
      const allMentionsText = allParticipantIds.map((id) => `<@${id}>`).join(', ');
      if (interaction.channel?.send) {
        await interaction.channel.send({
          content: `🎉 **Verification Complete!**\nTeam **${resolvedTeamName}** is now confirmed for **${savedTournament.tournamentTitle || 'the tournament'}**!\n**Roster:** ${allMentionsText}`,
          allowedMentions: { users: allParticipantIds },
        }).catch(() => {});
      }

      // Update prompt message in-place
      await interaction.editReply({
        content: `✅ Verification completed successfully for **${resolvedTeamName}**.`,
        embeds: [],
        components: [],
      });

      // Send tournament management audit log
      if (typeof sendTournamentManagementLog === 'function') {
        await sendTournamentManagementLog(
          guild,
          { id: tournamentId, title: savedTournament.tournamentTitle },
          null,
          'Team Verified & Confirmed (Central Verification)',
          interaction.user,
          [
            { name: 'Team Name', value: resolvedTeamName },
            { name: 'Team Leader', value: `<@${captainId}>` },
            ...(teammateIds.length ? [{ name: 'Squad', value: teammateIds.map((id) => `<@${id}>`).join(', ') }] : []),
            { name: 'Registration ID', value: String(registrationId) },
          ]
        ).catch(() => {});
      }

      // Update #registered-team roster message
      try {
        if (typeof fetchTournamentRegistrationsFromBackend === 'function' && typeof updateTeamsRosterMessages === 'function') {
          const backendData = await fetchTournamentRegistrationsFromBackend(tournamentId).catch(() => null);
          if (backendData?.teams && savedTournament.channels?.tournamentTeamsId) {
            const teamsChannel = guild.channels.cache.get(savedTournament.channels.tournamentTeamsId) ||
              await guild.channels.fetch(savedTournament.channels.tournamentTeamsId).catch(() => null);
            if (teamsChannel) {
              await updateTeamsRosterMessages(
                guild,
                backendData.tournament || { id: tournamentId, title: savedTournament.tournamentTitle },
                backendData.teams,
                teamsChannel,
                savedTournament
              );
            }
          }
        }
      } catch (rosterErr) {
        console.warn('[CentralVerification] Squad refresh after verification error:', rosterErr.message);
      }

      return true;
    } catch (error) {
      if (!backendVerified) await releasePendingTournamentVerificationClaim(pendingId, captainId).catch(() => {});
      console.error('[CentralVerification] Verification completion error:', error);
      await interaction.editReply({
        content: '❌ Verification could not be completed due to an unexpected error. Please try again.',
        embeds: [],
        components: [],
      });
      return true;
    }
  }

  return false;
}

/**
 * Handles incoming messages in #verify-here for tournament code verification.
 * @param {import('discord.js').Message} message
 * @returns {Promise<boolean>} True if the message was handled as a verification submission.
 */
export async function handleCentralVerificationMessage(message) {
  if (!message?.guild || !message.channel || message.author?.bot) return false;

  const guild = message.guild;
  const config = getCentralVerificationConfig(guild.id);

  // Check if message is in the designated verification channel (#verify-here)
  const isVerifyChannel =
    (config.verifyChannelId && message.channel.id === config.verifyChannelId) ||
    message.channel.name?.toLowerCase() === 'verify-here';

  if (!isVerifyChannel) return false;

  // Extract candidate 8-character verification code
  const tokens = String(message.content || '').trim().split(/\s+/);
  const code = tokens.find((t) => /^[A-Za-z0-9]{8}$/.test(t))?.toUpperCase();

  // If no 8-character code exists, ignore message (preserves normal messages or non-code chat)
  if (!code) return false;

  // 1. Message Privacy: Immediately delete the user's message so the verification code is never public
  try {
    await message.delete();
  } catch (delErr) {
    if (delErr.code === 50013 || delErr.message?.toLowerCase().includes('missing permissions')) {
      console.warn(`[CentralVerification] ⚠️ Missing 'Manage Messages' permission to delete code in #${message.channel.name}.`);
    } else {
      console.warn('[CentralVerification] Could not delete verification code message:', delErr.message);
    }
  }

  // Temporary notice helper
  const sendTemporaryNotice = async (text, seconds = 15) => {
    const notice = await message.channel.send({
      content: `<@${message.author.id}> ${text}`,
      allowedMentions: { users: [message.author.id] },
    }).catch(() => null);
    if (notice) {
      const timer = setTimeout(() => notice.delete().catch(() => {}), seconds * 1000);
      timer.unref?.();
    }
    return notice;
  };

  // 2. Check if the verification system is enabled
  if (config.enabled === false) {
    await sendTemporaryNotice('⛔ Tournament verification is currently disabled by administrators.');
    return true;
  }

  // 3. Rate limiting check
  const now = Date.now();
  let userRate = centralVerificationRateLimits.get(message.author.id);
  if (!userRate) {
    userRate = { attempts: [], blockedUntil: 0 };
    centralVerificationRateLimits.set(message.author.id, userRate);
  }
  if (userRate.blockedUntil > now) {
    const remainingMins = Math.ceil((userRate.blockedUntil - now) / 60000);
    await sendTemporaryNotice(`⛔ Too many attempts. Please try again in ${remainingMins} minute(s).`);
    return true;
  }
  userRate.attempts = userRate.attempts.filter((ts) => now - ts < 60000);
  if (userRate.attempts.length >= 5) {
    userRate.blockedUntil = now + 10 * 60000;
    await sendTemporaryNotice('⛔ Rate limit reached (too many attempts). Please try again in 10 minutes.');
    return true;
  }
  userRate.attempts.push(now);

  // 4. Check for active existing verification session for this user
  const activeExistingSession = await getActivePendingTournamentVerificationForUser({
    starterDiscordId: message.author.id,
  });
  if (activeExistingSession) {
    await sendTemporaryNotice(
      '⚠️ A verification session is already in progress for your account. Please complete or cancel your active prompt.'
    );
    return true;
  }

  // 5. Extract mentions from raw message content (supports Discord snowflake IDs and alphanumeric IDs)
  const mentionMatches = [...(message.content || '').matchAll(/<@!?([a-zA-Z0-9_\-]{2,32})>/g)];
  const rawMentionIds = mentionMatches.map((m) => m[1]);
  const uniqueMentionIds = Array.from(new Set(rawMentionIds));

  // Reject duplicate mentions
  if (rawMentionIds.length !== uniqueMentionIds.length) {
    await sendTemporaryNotice('❌ Duplicate mentions detected. Each team member must be mentioned only once.');
    return true;
  }

  // 6. Query website backend to validate verification code and retrieve tournament format
  let checkResult;
  try {
    const apiUrl = getBackendApiUrl();
    const secret = getBackendBotSecret();
    const response = await fetch(`${apiUrl}/api/bot/verification/check-code`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(secret ? { Authorization: `Bearer ${secret}`, 'x-bot-secret': secret } : {}),
        'x-guild-id': guild.id,
      },
      body: JSON.stringify({ code, guild_id: guild.id }),
    });

    checkResult = await response.json().catch(() => ({}));
    if (!response.ok || !checkResult.success) {
      const reason = checkResult.reason || checkResult.error || '';
      let errorMsg = 'That verification code is invalid.';
      if (reason === 'already_used') errorMsg = 'That verification code has already been used.';
      else if (reason === 'not_approved_yet') errorMsg = 'This team registration has not been approved yet.';
      else if (reason === 'registration_rejected') errorMsg = 'This team registration was rejected by tournament staff.';
      else if (reason === 'not_found') errorMsg = 'Verification code not found. Please double-check your code from the website.';
      await sendTemporaryNotice(`❌ Verification check failed: ${errorMsg}`);
      return true;
    }
  } catch (apiErr) {
    console.error('[CentralVerification] Backend code check failed:', apiErr);
    await sendTemporaryNotice('❌ Tournament verification backend is temporarily unreachable. Please try again shortly.');
    return true;
  }

  const tournamentId = checkResult.tournament_id;
  const registrationId = checkResult.registration_id;
  const format = String(checkResult.tournament_format || checkResult.format || 'squad').toLowerCase();

  // 7. Enforce mention requirements based on detected tournament format
  let requiredMentions = 0;
  if (format === 'solo') {
    requiredMentions = config.soloMentionRequirement ?? 0;
  } else if (format === 'duo') {
    requiredMentions = config.duoMentionRequirement ?? 2;
  } else {
    // Squad / team format
    requiredMentions = config.squadMentionRequirement ?? 4;
  }

  if (uniqueMentionIds.length !== requiredMentions) {
    if (requiredMentions === 0) {
      await sendTemporaryNotice(
        `❌ This is a **SOLO** tournament. No mentions are required (submit only your 8-character code). You provided ${uniqueMentionIds.length} mention(s).`
      );
    } else {
      await sendTemporaryNotice(
        `❌ This is a **${format.toUpperCase()}** tournament which requires exactly **${requiredMentions}** mention(s) (including yourself). You provided ${uniqueMentionIds.length} mention(s).`
      );
    }
    return true;
  }

  // 8. When required mentions > 0, verifying user must explicitly mention themselves
  if (requiredMentions > 0 && !uniqueMentionIds.includes(message.author.id)) {
    await sendTemporaryNotice(
      `❌ You must mention yourself (<@${message.author.id}>) as part of your team's ${requiredMentions} mentions.`
    );
    return true;
  }

  // 9. Validate all mentioned users are distinct, valid, non-bot server members
  for (const uid of uniqueMentionIds) {
    let member = guild.members.cache.get(uid);
    if (!member && guild.members.fetch) {
      member = await guild.members.fetch(uid).catch(() => null);
    }
    if (!member) {
      await sendTemporaryNotice(`❌ Mentioned user <@${uid}> is not present in this Discord server.`);
      return true;
    }
    if (member.user?.bot) {
      await sendTemporaryNotice(`❌ Mentioned user <@${uid}> is a bot. Discord bots cannot be added to tournament rosters.`);
      return true;
    }
  }

  // 10. Captain identity and permanent identity check
  if (checkResult.captain_discord_id && String(checkResult.captain_discord_id) !== String(message.author.id)) {
    await sendTemporaryNotice('❌ That verification code was issued to a different team captain Discord account.');
    return true;
  }

  const registeredCaptainUserId = String(
    checkResult.match_district_user_id || checkResult.captain_user_id || checkResult.user_id || checkResult.captain_uid || ''
  ).trim();

  let linkedIdentity = await getPermanentDiscordIdentityByDiscordId(message.author.id);
  if (linkedIdentity && registeredCaptainUserId && String(linkedIdentity.matchDistrictUserId) !== registeredCaptainUserId) {
    await sendTemporaryNotice('❌ This verification code belongs to a different Match District user account.');
    return true;
  }

  if (registeredCaptainUserId) {
    const existingIdentityByMD = await getPermanentDiscordIdentityByMatchDistrictId(registeredCaptainUserId);
    if (existingIdentityByMD && String(existingIdentityByMD.discordUserId) !== String(message.author.id)) {
      await sendTemporaryNotice('❌ This Match District account is already linked to a different Discord account.');
      return true;
    }
  }

  if (!linkedIdentity && registeredCaptainUserId) {
    try {
      linkedIdentity = await savePermanentDiscordIdentity({
        matchDistrictUserId: registeredCaptainUserId,
        discordUserId: message.author.id,
        discordUsername: message.author.tag || message.author.username,
      });
    } catch (identErr) {
      if (identErr.code === 'DISCORD_ACCOUNT_ALREADY_LINKED' || identErr.code === 'USER_ALREADY_LINKED') {
        await sendTemporaryNotice(identErr.message);
        return true;
      }
    }
  }

  // 11. Exclusivity check across ALL participants
  const candidateIdsToCheck = uniqueMentionIds.length > 0 ? uniqueMentionIds : [message.author.id];
  const exclCheck = await checkTournamentPlayerExclusivity(tournamentId, candidateIdsToCheck, registrationId);
  if (!exclCheck.ok) {
    const conflict = exclCheck.conflicts?.[0];
    const teamName = conflict?.teamName ? ` "${conflict.teamName}"` : '';
    await sendTemporaryNotice(`❌ <@${conflict?.discordId}> is already registered in a verified team${teamName} for this tournament.`);
    return true;
  }

  // 12. Create pending verification session and post Confirmation Prompt
  const teammateIds = uniqueMentionIds.filter((id) => id !== message.author.id);
  const pendingId = crypto.randomUUID();

  await createPendingTournamentVerification({
    pendingId,
    registrationId: String(registrationId),
    starterDiscordId: message.author.id,
    tournamentId,
    guildId: guild.id,
    channelId: message.channel.id,
    status: 'active',
    teamName: String(checkResult.team_name || 'Your team'),
    captainName: String(checkResult.captain_name || ''),
    captainUid: String(checkResult.captain_uid || ''),
    squad: Array.isArray(checkResult.squad) ? checkResult.squad : [],
    players: Array.isArray(checkResult.players) ? checkResult.players : [],
    substitutes: Array.isArray(checkResult.substitutes) ? checkResult.substitutes : [],
    teammatesNeeded: teammateIds.length,
    teammateDiscordIds: teammateIds,
    uniqueMentionIds: candidateIdsToCheck,
    expiresAt: new Date(Date.now() + 2 * 60 * 1000), // 2 minutes expiration
  });

  const confirmEmbed = new EmbedBuilder()
    .setTitle('📋 Confirm Tournament Verification')
    .setColor(0x3b82f6)
    .setDescription(`Please review your team registration details for **${checkResult.tournament_title || 'Tournament'}**:`)
    .addFields(
      { name: 'Team Name', value: `**${checkResult.team_name || 'Your Team'}**`, inline: true },
      { name: 'Format', value: `\`${format.toUpperCase()}\``, inline: true },
      { name: 'Team Leader', value: `<@${message.author.id}>`, inline: true },
      {
        name: 'Squad Members',
        value: candidateIdsToCheck.length > 0
          ? candidateIdsToCheck.map((id) => `• <@${id}>`).join('\n')
          : `• <@${message.author.id}> (Solo)`,
        inline: false,
      }
    )
    .setFooter({ text: 'Click Confirm Verification within 2 minutes to finalize. Only you can confirm.' });

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`cver:confirm:${pendingId}`)
      .setLabel('Confirm Verification')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('✅'),
    new ButtonBuilder()
      .setCustomId(`cver:cancel:${pendingId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('✖️')
  );

  const promptMsg = await message.channel.send({
    content: `<@${message.author.id}>`,
    embeds: [confirmEmbed],
    components: [actionRow],
    allowedMentions: { users: [message.author.id] },
  });

  // Schedule auto-expiration / prompt cleanup after 2 minutes
  const timer = setTimeout(async () => {
    pendingPromptTimers.delete(pendingId);
    await promptMsg.delete().catch(() => {});
    await expirePendingTournamentVerificationById(pendingId, message.author.id).catch(() => {});
  }, 2 * 60 * 1000);
  timer.unref?.();
  pendingPromptTimers.set(pendingId, timer);

  return true;
}

/**
 * Sweeps #verify-here channel upon bot restart/reconnect to clean up leftover user verification codes.
 * Ordinary instruction and announcement messages are strictly preserved.
 * @param {import('discord.js').Guild} guild
 */
export async function cleanupCentralVerificationOfflineMessages(guild) {
  if (!guild) return;
  const config = getCentralVerificationConfig(guild.id);
  let channel = null;
  if (config?.verifyChannelId) {
    channel = guild.channels?.cache?.get(config.verifyChannelId) ||
      (guild.channels?.fetch ? await guild.channels.fetch(config.verifyChannelId).catch(() => null) : null);
  }
  if (!channel && guild.channels?.cache) {
    const list = typeof guild.channels.cache.values === 'function'
      ? Array.from(guild.channels.cache.values())
      : [];
    channel = list.find((c) => c.name?.toLowerCase() === 'verify-here' && c.type === ChannelType.GuildText);
  }
  if (!channel?.messages?.fetch) return;

  try {
    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!messages?.size) return;

    for (const msg of messages.values()) {
      if (msg.author?.bot) {
        // Remove stale confirmation prompts older than 2 minutes
        const hasPrompt = msg.components?.some((row) =>
          row.components?.some((comp) => comp.customId?.startsWith('cver:confirm:'))
        );
        if (hasPrompt && Date.now() - (msg.createdTimestamp || 0) > 2 * 60 * 1000) {
          await msg.delete().catch(() => {});
        }
        continue;
      }

      // Check if user message contains an 8-character verification code
      const tokens = String(msg.content || '').trim().split(/\s+/);
      const hasCode = tokens.some((t) => /^[A-Za-z0-9]{8}$/.test(t));
      if (hasCode) {
        await msg.delete().catch(() => {});
      }
    }
  } catch (err) {
    console.warn(`[CentralVerification] Error during offline cleanup in #${channel.name}:`, err.message);
  }
}
