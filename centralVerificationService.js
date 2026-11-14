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
  UserSelectMenuBuilder,
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
  cancelPendingTournamentVerification,
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
 * Map<guildId, configDoc>
 */
export const centralVerificationConfigsCache = new Map();

/**
 * Tracks transient prompt auto-delete timers for verification prompts:
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
 * Resolves the official Match District Discord server invite link.
 * Priority:
 * 1. Admin-configured `serverInviteUrl` in guild verification config
 * 2. Environment variable `DISCORD_SERVER_INVITE` / `DISCORD_INVITE_URL` / `MATCHDISTRICT_DISCORD_INVITE`
 * 3. Guild vanity URL code (`https://discord.gg/${guild.vanityURLCode}`)
 * 4. Existing active guild invites (`guild.invites.fetch()`)
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} config
 * @returns {Promise<string|null>}
 */
export async function resolveGuildInviteUrl(guild, config = {}) {
  // 1. Configured invite in central verification settings
  if (config.serverInviteUrl && typeof config.serverInviteUrl === 'string' && config.serverInviteUrl.trim()) {
    return config.serverInviteUrl.trim();
  }

  // 2. Global environment variable
  const envInvite = process.env.DISCORD_SERVER_INVITE ||
    process.env.DISCORD_INVITE_URL ||
    process.env.MATCHDISTRICT_DISCORD_INVITE;
  if (envInvite && typeof envInvite === 'string' && envInvite.trim()) {
    return envInvite.trim();
  }

  // 3. Guild vanity URL
  if (guild?.vanityURLCode) {
    return `https://discord.gg/${guild.vanityURLCode}`;
  }

  // 4. Existing guild invites
  if (guild?.invites?.fetch) {
    try {
      const invites = await guild.invites.fetch().catch(() => null);
      if (invites?.size > 0) {
        const first = typeof invites.first === 'function' ? invites.first() : Array.from(invites.values())[0];
        if (first?.url) return first.url;
      }
    } catch {}
  }

  return null;
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
    serverInviteUrl: null,
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
  const inviteText = config.serverInviteUrl ? `\`${config.serverInviteUrl}\`` : '_Auto-detected / Not set_';

  const embed = new EmbedBuilder()
    .setTitle('🛡️ Central Tournament Verification Dashboard')
    .setColor(isEnabled ? 0x22c55e : 0xef4444)
    .setDescription(
      'Configure the central tournament verification system and team invitation settings.\n\n' +
      'Captains submit their 8-character verification code in the submissions channel. If teammates have not joined Discord yet, the captain can send them the official server invite and continue verification once they join.'
    )
    .addFields(
      { name: 'System Status', value: statusText, inline: true },
      { name: 'Last Updated By', value: updatedByText, inline: true },
      { name: 'Last Updated At', value: updatedAtText, inline: false },
      {
        name: 'Mention Requirements',
        value: [
          `• **Solo:** \`${config.soloMentionRequirement ?? 0}\` mention(s)`,
          `• **Duo:** \`${config.duoMentionRequirement ?? 2}\` mention(s)`,
          `• **Squad:** \`${config.squadMentionRequirement ?? 4}\` mention(s)`,
        ].join('\n'),
        inline: false,
      },
      {
        name: 'Official Server Invite Link',
        value: inviteText,
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
      .setEmoji('🧑‍🤝‍🧑'),
    new ButtonBuilder()
      .setCustomId('cver:edit:invite')
      .setLabel('Edit Server Invite')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🔗')
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
 * Builds the interactive teammate selection prompt for Duo or Squad verification.
 * @param {object} pending
 * @returns {{ embeds: EmbedBuilder[], components: ActionRowBuilder[] }}
 */
export function buildTeammateSelectionPrompt(pending) {
  const needed = Number(pending.teammatesNeeded) || (pending.tournamentFormat === 'duo' ? 1 : 3);
  const formatUpper = String(pending.tournamentFormat || 'team').toUpperCase();
  const teamName = pending.teamName || 'Your Team';

  const embed = new EmbedBuilder()
    .setTitle(`📋 Tournament Verification — ${teamName}`)
    .setColor(0x3b82f6)
    .setDescription(
      `Verification for **${pending.tournamentTitle || 'Tournament'}** (\`${formatUpper}\`).\n\n` +
      `• **Team Captain:** <@${pending.starterDiscordId}>\n` +
      `• **Teammates Required:** **${needed}** teammate${needed === 1 ? '' : 's'}\n\n` +
      `Use the dropdown menu below to select your teammate${needed === 1 ? '' : 's'}.\n` +
      `If your teammates have not joined this Discord server yet, click **Invite Teammates** to get an invitation message to share with them.`
    )
    .addFields(
      { name: 'Team Name', value: `**${teamName}**`, inline: true },
      { name: 'Format', value: `\`${formatUpper}\``, inline: true },
      { name: 'Status', value: `⏳ Awaiting Teammates (${needed} required)`, inline: true }
    )
    .setFooter({ text: 'Match District Tournament Verification • Only the captain can select teammates' });

  const selectRow = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(`cver:select:${pending.pendingId}`)
      .setPlaceholder(`Select ${needed} teammate${needed === 1 ? '' : 's'}...`)
      .setMinValues(needed)
      .setMaxValues(needed)
  );

  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`cver:invite:${pending.pendingId}`)
      .setLabel('Invite Teammates')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('📨'),
    new ButtonBuilder()
      .setCustomId(`cver:continue:${pending.pendingId}`)
      .setLabel('Continue Verification')
      .setStyle(ButtonStyle.Success)
      .setEmoji('🔄'),
    new ButtonBuilder()
      .setCustomId(`cver:cancel:${pending.pendingId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('✖️')
  );

  return { embeds: [embed], components: [selectRow, buttonRow] };
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

  // Permissions for #verify-setup:
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

  // Permissions for #verify-here:
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
    serverInviteUrl: existingConfig.serverInviteUrl || null,
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

  // 8. Confirm in invoking channel
  const successEmbed = new EmbedBuilder()
    .setTitle('✅ Central Verification Setup Complete')
    .setColor(0x22c55e)
    .setDescription(
      `Central tournament verification structure is ready:\n\n` +
      `• **Category:** \`${category?.name || 'VERIFICATION'}\`\n` +
      `• **Dashboard:** ${setupChannel ? `<#${setupChannel.id}>` : '_None_'}\n` +
      `• **Submissions:** ${verifyChannel ? `<#${verifyChannel.id}>` : '_None_'}\n\n` +
      `Administrators can customize mention requirements and server invite link in ${setupChannel ? `<#${setupChannel.id}>` : '#verify-setup'}.`
    );

  await replyFn({ embeds: [successEmbed] });
}

/**
 * Handles all interaction components (buttons, modals, user select menus) for central verification (prefix `cver:`).
 * @param {import('discord.js').Interaction} interaction
 * @returns {Promise<boolean>}
 */
export async function handleCentralVerificationInteraction(interaction) {
  const customId = interaction.customId || '';
  if (!customId.startsWith('cver:')) return false;

  const guild = interaction.guild;
  if (!guild) return false;

  const config = getCentralVerificationConfig(guild.id);

  // Safe private reply helper
  const replyPrivate = async (target, payload) => {
    const opts = typeof payload === 'string' ? { content: payload, ephemeral: true } : { ...payload, ephemeral: true };
    if (target.replied || target.deferred) {
      if (typeof target.followUp === 'function') {
        return target.followUp(opts).catch(async () => {
          if (typeof target.editReply === 'function') return target.editReply(payload).catch(() => {});
        });
      }
      if (typeof target.editReply === 'function') {
        return target.editReply(payload).catch(() => {});
      }
    }
    if (typeof target.reply === 'function') {
      return target.reply(opts).catch(() => {});
    }
  };

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
      await replyPrivate(interaction, '⛔ Only server administrators can manage the tournament verification configuration.');
      return true;
    }

    // Modal Display: Edit Server Invite Link
    if (customId === 'cver:edit:invite') {
      const modal = new ModalBuilder()
        .setCustomId('cver:modal:invite')
        .setTitle('Edit Server Invite URL');

      const input = new TextInputBuilder()
        .setCustomId('cver:input:invite')
        .setLabel('Official Discord Server Invite URL')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setPlaceholder('https://discord.gg/your-invite or leave empty')
        .setValue(String(config.serverInviteUrl || ''));

      modal.addComponents(new ActionRowBuilder().addComponents(input));
      if (interaction.showModal) await interaction.showModal(modal);
      return true;
    }

    // Modal Submission: Edit Server Invite Link
    if (customId === 'cver:modal:invite') {
      const rawUrl = interaction.fields?.getTextInputValue('cver:input:invite')?.trim() || '';
      config.serverInviteUrl = rawUrl || null;
      config.updatedBy = interaction.user.id;
      config.updatedAt = new Date().toISOString();

      await saveConfigToDb(guild.id, config);
      centralVerificationConfigsCache.set(guild.id, config);
      await updateDashboardMessage(guild, config);

      await replyPrivate(interaction, `✅ Official server invite URL has been ${config.serverInviteUrl ? `set to \`${config.serverInviteUrl}\`` : 'cleared (auto-detection enabled)'}.`);
      return true;
    }

    // Modal Display: Edit Solo / Duo / Squad Mentions
    if (customId.startsWith('cver:edit:')) {
      const format = customId.split(':')[2];
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
      if (interaction.showModal) await interaction.showModal(modal);
      return true;
    }

    // Modal Submission: Process Mention Requirement Update
    if (customId.startsWith('cver:modal:')) {
      const format = customId.split(':')[2];
      const rawVal = interaction.fields?.getTextInputValue('cver:input:mentions')?.trim() || '';
      const num = parseInt(rawVal, 10);

      if (isNaN(num) || num < 0 || num > 25 || String(num) !== rawVal) {
        await replyPrivate(interaction, '❌ Invalid input: Mentions requirement must be an integer between 0 and 25.');
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

      await replyPrivate(interaction, `✅ Updated **${format.toUpperCase()}** mention requirement to **${num}**.`);
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

      await replyPrivate(interaction, `✅ Central Tournament Verification is now **${config.enabled ? 'Enabled' : 'Disabled'}**.`);
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
          { name: 'Server Invite URL', value: config.serverInviteUrl ? `\`${config.serverInviteUrl}\`` : '_Auto-detected / Not set_', inline: false },
          { name: 'Solo Mentions', value: `\`${config.soloMentionRequirement ?? 0}\``, inline: true },
          { name: 'Duo Mentions', value: `\`${config.duoMentionRequirement ?? 2}\``, inline: true },
          { name: 'Squad Mentions', value: `\`${config.squadMentionRequirement ?? 4}\``, inline: true },
          { name: 'Last Updated By', value: config.updatedBy ? `<@${config.updatedBy}>` : 'System', inline: true },
          { name: 'Last Updated At', value: config.updatedAt ? new Date(config.updatedAt).toUTCString() : 'N/A', inline: false }
        )
        .setTimestamp();

      await replyPrivate(interaction, { embeds: [viewEmbed] });
      return true;
    }

    // Refresh Dashboard In-Place
    if (customId === 'cver:refresh') {
      await updateDashboardMessage(guild, config);
      await replyPrivate(interaction, '✅ Dashboard refreshed.');
      return true;
    }
  }

  // -------------------------------------------------------------
  // Teammates Verification Actions: cver:invite:*, cver:continue:*, cver:select:*, cver:cancel:*
  // -------------------------------------------------------------
  if (
    customId.startsWith('cver:invite:') ||
    customId.startsWith('cver:continue:') ||
    customId.startsWith('cver:select:') ||
    customId.startsWith('cver:cancel:') ||
    customId.startsWith('cver:confirm:')
  ) {
    const parts = customId.split(':');
    const action = parts[1];
    const pendingId = parts[2];

    const pending = await getPendingTournamentVerification(pendingId);
    const now = Date.now();
    const isExpired = pending?.expiresAt && new Date(pending.expiresAt).getTime() <= now;

    if (!pending || isExpired || !['active', 'awaiting_continue', 'awaiting_teammates', 'awaiting_selection'].includes(pending.status)) {
      if (pendingId && isExpired) {
        await expirePendingTournamentVerificationById(pendingId, interaction.user.id).catch(() => {});
      }
      await replyPrivate(interaction, '⚠️ This verification session has expired or has already been completed. Please submit your verification code in #verify-here to start a fresh session.');
      return true;
    }

    // Only the captain who submitted the code may use these controls
    if (String(pending.starterDiscordId) !== String(interaction.user.id)) {
      await replyPrivate(interaction, `⛔ Only the team captain (<@${pending.starterDiscordId}>) who submitted this verification code can operate these controls.`);
      return true;
    }

    // --- Action: Invite Teammates (Step 3) ---
    if (action === 'invite') {
      const inviteUrl = await resolveGuildInviteUrl(guild, config);
      if (!inviteUrl) {
        console.warn(`[CentralVerification] ⚠️ Guild ${guild.name} (${guild.id}) has no valid server invite link configured.`);
        await replyPrivate(
          interaction,
          '⚠️ The official Match District server invite link is currently unavailable. Please ask a server administrator to configure the server invite URL in #verify-setup.'
        );
        return true;
      }

      let inviteMessageText = '';
      if (pending.tournamentFormat === 'duo') {
        inviteMessageText = `Join our Match District Discord server so we can complete tournament verification:\n${inviteUrl}\n\nAfter joining, tell me your Discord username so I can select you during verification.`;
      } else if (pending.tournamentFormat === 'squad') {
        inviteMessageText = `Join our Match District Discord server so we can complete our tournament verification:\n${inviteUrl}\n\nAll squad members must join the server before the captain can complete verification.`;
      } else {
        inviteMessageText = `Join our Match District Discord server to complete tournament verification:\n${inviteUrl}\n\nPlease join and let your captain know once you are inside.`;
      }

      await replyPrivate(
        interaction,
        `📋 **Copy and share this invitation with your teammates:**\n\`\`\`\n${inviteMessageText}\n\`\`\``
      );
      return true;
    }

    // --- Action: Continue Verification (Step 4) ---
    if (action === 'continue') {
      const promptData = buildTeammateSelectionPrompt(pending);
      if (interaction.message?.edit) {
        await interaction.message.edit(promptData).catch(() => {});
      }
      await replyPrivate(interaction, `ℹ️ Please select your **${pending.teammatesNeeded}** teammate(s) from the dropdown menu above once they have joined.`);
      return true;
    }

    // --- Action: Cancel Verification ---
    if (action === 'cancel') {
      if (pendingPromptTimers.has(pendingId)) {
        clearTimeout(pendingPromptTimers.get(pendingId));
        pendingPromptTimers.delete(pendingId);
      }
      await cancelPendingTournamentVerification(pendingId, interaction.user.id);
      if (interaction.update) {
        await interaction.update({
          content: `<@${interaction.user.id}> ❌ Verification cancelled. Your registration code remains unused and can be submitted again.`,
          embeds: [],
          components: [],
        });
      } else {
        await replyPrivate(interaction, '❌ Verification cancelled. Your registration code remains unused.');
      }
      return true;
    }

    // --- Action: Teammate Selection Menu (Step 5) ---
    if (action === 'select') {
      const selectedIds = Array.isArray(interaction.values) ? interaction.values.map(String) : [];
      const needed = Number(pending.teammatesNeeded) || (pending.tournamentFormat === 'duo' ? 1 : 3);

      if (selectedIds.length !== needed) {
        await replyPrivate(interaction, `❌ Please select exactly ${needed} teammate${needed === 1 ? '' : 's'}. You selected ${selectedIds.length}.`);
        return true;
      }

      if (new Set(selectedIds).size !== selectedIds.length) {
        await replyPrivate(interaction, '❌ Duplicate teammates selected. Each teammate must be unique.');
        return true;
      }

      if (selectedIds.includes(interaction.user.id)) {
        await replyPrivate(interaction, '❌ You cannot select yourself as a teammate. The team captain is already included automatically.');
        return true;
      }

      // Verify every selected user is a present server member and not a bot
      for (const uid of selectedIds) {
        let member = guild.members.cache.get(uid);
        if (!member && guild.members.fetch) {
          member = await guild.members.fetch(uid).catch(() => null);
        }
        if (!member) {
          await replyPrivate(
            interaction,
            `❌ <@${uid}> has not joined this Discord server yet. Click **Invite Teammates** to copy the server invite and send it to them, then try again once they join.`
          );
          return true;
        }
        if (member.user?.bot) {
          await replyPrivate(interaction, `❌ <@${uid}> is a Discord bot. Discord bots cannot be added as teammates.`);
          return true;
        }
      }

      // Tournament player exclusivity check across all roster members
      const allRosterIds = [interaction.user.id, ...selectedIds];
      const exclCheck = await checkTournamentPlayerExclusivity(pending.tournamentId, allRosterIds, pending.registrationId);
      if (!exclCheck.ok) {
        const conflict = exclCheck.conflicts?.[0];
        const teamName = conflict?.teamName ? ` "${conflict.teamName}"` : '';
        await replyPrivate(
          interaction,
          `❌ <@${conflict?.discordId}> is already registered in a verified team${teamName} for this tournament.`
        );
        return true;
      }

      if (interaction.deferUpdate) await interaction.deferUpdate().catch(() => {});

      // Call Website API to complete verification
      let backendVerified = false;
      const tournamentId = pending.tournamentId;
      const registrationId = pending.registrationId;
      const captainId = pending.starterDiscordId;

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
            teammate_discord_ids: selectedIds,
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
          await replyPrivate(interaction, `❌ Verification failed: ${result.message || result.error || 'Server error'}.`);
          return true;
        }

        backendVerified = true;
        await finishPendingTournamentVerification(pendingId, captainId, 'completed');

        const resolvedTeamName = result.team_name || pending.teamName || 'Your team';
        const verifiedAt = new Date().toISOString();

        // Update tournament record in cache and MongoDB
        const savedTournament = guildSettingsCache?.[guild.id]?.tournaments?.[tournamentId] || {};
        savedTournament.verifiedRegistrations ||= {};
        savedTournament.verifiedRegistrations[String(registrationId)] = {
          registrationId: String(registrationId),
          teamId: String(registrationId),
          teamName: resolvedTeamName,
          status: 'CONFIRMED',
          discordId: String(captainId),
          verifiedAt,
          mentionedMemberIds: selectedIds,
          captain: {
            ign: result.captain_name || pending.captainName || '',
            uid: result.captain_uid || pending.captainUid || '',
            discord_id: String(captainId),
          },
          squad: Array.isArray(result.squad) ? result.squad : pending.squad,
          substitutes: Array.isArray(result.substitutes) ? result.substitutes : pending.substitutes,
          discordMemberIds: allRosterIds.map(String),
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
          players: selectedIds.map((id) => ({ discordId: String(id), id: String(id) })),
          status: 'CONFIRMED',
        }).catch((err) => console.warn('[CentralVerification] Warning syncing player memberships:', err.message));

        // Save permanent Match District identity if user ID is present
        const mdUserId = result.match_district_user_id || pending.matchDistrictUserId || result.captain_user_id || result.user_id;
        if (mdUserId) {
          await savePermanentDiscordIdentity({
            matchDistrictUserId: String(mdUserId).trim(),
            discordUserId: String(captainId),
            discordUsername: interaction.user?.tag || interaction.user?.username || '',
          }).catch((err) => console.warn('[CentralVerification] Warning saving permanent identity:', err.message));
        }

        // Assign tournament role to all verified members
        if (savedTournament.roleId) {
          for (const uid of allRosterIds) {
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

        // Public confirmation announcement in #verify-here
        const allMentionsText = allRosterIds.map((id) => `<@${id}>`).join(', ');
        if (interaction.channel?.send) {
          await interaction.channel.send({
            content: `🎉 **Verification Complete!**\nTeam **${resolvedTeamName}** is now confirmed for **${savedTournament.tournamentTitle || 'the tournament'}**!\n**Roster:** ${allMentionsText}`,
            allowedMentions: { users: allRosterIds },
          }).catch(() => {});
        }

        // Update prompt message in-place
        if (interaction.editReply) {
          await interaction.editReply({
            content: `✅ Verification completed successfully for **${resolvedTeamName}**.`,
            embeds: [],
            components: [],
          }).catch(() => {});
        } else if (interaction.message?.edit) {
          await interaction.message.edit({
            content: `✅ Verification completed successfully for **${resolvedTeamName}**.`,
            embeds: [],
            components: [],
          }).catch(() => {});
        }

        // Tournament management audit log
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
              { name: 'Squad', value: selectedIds.map((id) => `<@${id}>`).join(', ') },
              { name: 'Registration ID', value: String(registrationId) },
            ]
          ).catch(() => {});
        }

        // Update #registered-team roster display
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
        await replyPrivate(interaction, '❌ Verification could not be completed due to an unexpected server error. Please try again.');
        return true;
      }
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

  // 5. Query website backend to validate verification code and retrieve tournament format
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
      body: JSON.stringify({
        code,
        guild_id: guild.id,
        discord_user_id: message.author.id,
        discord_username: message.author.tag || message.author.username,
      }),
    });

    checkResult = await response.json().catch(() => ({}));
    if (!response.ok || !checkResult.success) {
      const errCode = checkResult.error || checkResult.reason || '';
      let errorMsg = checkResult.message || 'That verification code is invalid.';
      if (errCode === 'CODE_ALREADY_VERIFIED' || errCode === 'already_used') {
        errorMsg = '❌ This tournament registration has already been verified on Discord.';
      } else if (errCode === 'DISCORD_IDENTITY_CONFLICT') {
        errorMsg = checkResult.message || '❌ This Discord account is already linked to a different Match District account.';
      } else if (errCode === 'IDENTITY_DATA_CONFLICT') {
        errorMsg = '❌ Identity database conflict detected. Please contact tournament support.';
      } else if (errCode === 'CODE_INVALID' || errCode === 'not_found') {
        errorMsg = '❌ Verification check failed: Verification code not found. Please double-check your code from the website.';
      } else if (errCode === 'CODE_NOT_ELIGIBLE') {
        errorMsg = `❌ Verification check failed: ${checkResult.message || 'Registration is not eligible for verification.'}`;
      } else {
        errorMsg = `❌ Verification check failed: ${errorMsg}`;
      }
      await sendTemporaryNotice(errorMsg);
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
  const teamName = checkResult.team_name || 'Your Team';
  const tournamentTitle = checkResult.tournament_title || 'Tournament';

  // 6. Captain identity and permanent identity check
  if (checkResult.captain_discord_id && String(checkResult.captain_discord_id) !== String(message.author.id)) {
    await sendTemporaryNotice('❌ That verification code was issued to a different team captain Discord account.');
    return true;
  }

  const registeredCaptainUserId = String(
    checkResult.match_district_user_id || checkResult.captain_user_id || checkResult.user_id || ''
  ).trim();

  let linkedIdentity = await getPermanentDiscordIdentityByDiscordId(message.author.id);
  if (linkedIdentity && registeredCaptainUserId && String(linkedIdentity.matchDistrictUserId).trim() !== registeredCaptainUserId) {
    await sendTemporaryNotice('❌ This Discord account is already linked to a different Match District account.');
    return true;
  }

  if (registeredCaptainUserId) {
    const existingIdentityByMD = await getPermanentDiscordIdentityByMatchDistrictId(registeredCaptainUserId);
    if (existingIdentityByMD && String(existingIdentityByMD.discordUserId).trim() !== String(message.author.id)) {
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
      if (identErr.code === 'DISCORD_IDENTITY_CONFLICT' || identErr.code === 'DISCORD_ACCOUNT_ALREADY_LINKED' || identErr.code === 'USER_ALREADY_LINKED') {
        await sendTemporaryNotice(identErr.message);
        return true;
      }
    }
  }

  // 7. Exclusivity check for captain
  const captainExcl = await checkTournamentPlayerExclusivity(tournamentId, [message.author.id], registrationId);
  if (!captainExcl.ok) {
    const conflict = captainExcl.conflicts?.[0];
    const conflictTeamName = conflict?.teamName ? ` "${conflict.teamName}"` : '';
    await sendTemporaryNotice(`❌ You are already registered in a verified team${conflictTeamName} for this tournament.`);
    return true;
  }

  // -------------------------------------------------------------
  // Step 2A: SOLO Tournaments — Direct Completion (No Teammates Required)
  // -------------------------------------------------------------
  if (format === 'solo') {
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
          captain_discord_id: message.author.id,
          teammate_discord_ids: [],
          guild_id: guild.id,
        }),
      });

      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) {
        await sendTemporaryNotice(`❌ Solo verification failed: ${result.message || result.error || 'Server error'}.`);
        return true;
      }

      backendVerified = true;
      const resolvedTeamName = result.team_name || teamName;
      const verifiedAt = new Date().toISOString();

      const savedTournament = guildSettingsCache?.[guild.id]?.tournaments?.[tournamentId] || {};
      savedTournament.verifiedRegistrations ||= {};
      savedTournament.verifiedRegistrations[String(registrationId)] = {
        registrationId: String(registrationId),
        teamId: String(registrationId),
        teamName: resolvedTeamName,
        status: 'CONFIRMED',
        discordId: String(message.author.id),
        verifiedAt,
        mentionedMemberIds: [],
        captain: {
          ign: result.captain_name || checkResult.captain_name || '',
          uid: result.captain_uid || checkResult.captain_uid || '',
          discord_id: String(message.author.id),
        },
        squad: Array.isArray(result.squad) ? result.squad : checkResult.squad,
        substitutes: Array.isArray(result.substitutes) ? result.substitutes : checkResult.substitutes,
        discordMemberIds: [String(message.author.id)],
      };

      if (guildSettingsCache?.[guild.id]) {
        guildSettingsCache[guild.id].tournaments ||= {};
        guildSettingsCache[guild.id].tournaments[tournamentId] = savedTournament;
      }
      await saveTournamentToDb(guild.id, tournamentId, savedTournament);

      await syncTeamPlayerMemberships({
        tournamentId,
        teamId: String(registrationId),
        teamName: resolvedTeamName,
        leaderDiscordId: String(message.author.id),
        players: [],
        status: 'CONFIRMED',
      }).catch((err) => console.warn('[CentralVerification] Warning syncing solo membership:', err.message));

      if (savedTournament.roleId) {
        const m = guild.members.cache.get(message.author.id) || (await guild.members.fetch(message.author.id).catch(() => null));
        if (m) {
          await queueRoleAdd(
            m,
            savedTournament.roleId,
            `Verified solo participant for ${savedTournament.tournamentTitle || 'tournament'}`
          ).catch(() => {});
        }
      }

      await message.channel.send({
        content: `🎉 **Verification Complete!**\nSolo Player **${resolvedTeamName}** (<@${message.author.id}>) is now confirmed for **${tournamentTitle}**!`,
        allowedMentions: { users: [message.author.id] },
      }).catch(() => {});

      if (typeof sendTournamentManagementLog === 'function') {
        await sendTournamentManagementLog(
          guild,
          { id: tournamentId, title: savedTournament.tournamentTitle || tournamentTitle },
          null,
          'Solo Verified & Confirmed',
          message.author,
          [
            { name: 'Player Name', value: resolvedTeamName },
            { name: 'Discord ID', value: `<@${message.author.id}>` },
            { name: 'Registration ID', value: String(registrationId) },
          ]
        ).catch(() => {});
      }

      try {
        if (typeof fetchTournamentRegistrationsFromBackend === 'function' && typeof updateTeamsRosterMessages === 'function') {
          const backendData = await fetchTournamentRegistrationsFromBackend(tournamentId).catch(() => null);
          if (backendData?.teams && savedTournament.channels?.tournamentTeamsId) {
            const teamsChannel = guild.channels.cache.get(savedTournament.channels.tournamentTeamsId) ||
              await guild.channels.fetch(savedTournament.channels.tournamentTeamsId).catch(() => null);
            if (teamsChannel) {
              await updateTeamsRosterMessages(
                guild,
                backendData.tournament || { id: tournamentId, title: savedTournament.tournamentTitle || tournamentTitle },
                backendData.teams,
                teamsChannel,
                savedTournament
              );
            }
          }
        }
      } catch (rosterErr) {
        console.warn('[CentralVerification] Solo roster refresh error:', rosterErr.message);
      }

      return true;
    } catch (soloErr) {
      console.error('[CentralVerification] Solo verification error:', soloErr);
      await sendTemporaryNotice('❌ Solo verification could not be completed due to a server error. Please try again.');
      return true;
    }
  }

  // -------------------------------------------------------------
  // Step 2B: DUO / SQUAD Tournaments — Deferred Teammate Selection & Invitation Prompt
  // -------------------------------------------------------------
  const teammatesNeeded = format === 'duo' ? 1 : 3;
  const pendingId = crypto.randomUUID();

  const pendingDoc = {
    pendingId,
    registrationId: String(registrationId),
    starterDiscordId: message.author.id,
    tournamentId,
    guildId: guild.id,
    channelId: message.channel.id,
    status: 'awaiting_teammates',
    teamName: String(teamName),
    captainName: String(checkResult.captain_name || ''),
    captainUid: String(checkResult.captain_uid || ''),
    matchDistrictUserId: String(registeredCaptainUserId || ''),
    tournamentFormat: format,
    tournamentTitle: String(tournamentTitle),
    teammatesNeeded,
    selectedTeammateIds: [],
    expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes session
    createdAt: new Date().toISOString(),
  };

  await createPendingTournamentVerification(pendingDoc);

  const promptPayload = buildTeammateSelectionPrompt(pendingDoc);

  const promptMsg = await message.channel.send({
    content: `<@${message.author.id}>`,
    ...promptPayload,
    allowedMentions: { users: [message.author.id] },
  });

  if (promptMsg?.id) {
    pendingDoc.promptMessageId = promptMsg.id;
  }

  // Schedule auto-expiration after 15 minutes
  const timer = setTimeout(async () => {
    pendingPromptTimers.delete(pendingId);
    await promptMsg.delete().catch(() => {});
    await expirePendingTournamentVerificationById(pendingId, message.author.id).catch(() => {});
  }, 15 * 60 * 1000);
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
        // Remove stale verification prompts older than 15 minutes
        const hasPrompt = msg.components?.some((row) =>
          row.components?.some((comp) => comp.customId?.startsWith('cver:select:') || comp.customId?.startsWith('cver:invite:'))
        );
        if (hasPrompt && Date.now() - (msg.createdTimestamp || 0) > 15 * 60 * 1000) {
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
