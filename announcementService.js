import crypto from 'crypto';
import {
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import {
  queueChannelCreate,
  queueChannelSend,
  queueDirectMessage,
} from './discordQueue.js';
import {
  saveAnnouncementChannel,
  getAnnouncementChannel,
  saveGuildSettingsToDb,
  savePendingAnnouncement,
  getPendingAnnouncement,
  deletePendingAnnouncement,
} from './mongoService.js';
import {
  isAdmin,
  guildSettingsCache,
  saveGuildSettings,
} from './index.js';

/**
 * Extracts target mentions (@everyone or roles) from a message.
 * @param {import('discord.js').Message} message
 * @returns {{ hasEveryone: boolean, roles: Array<import('discord.js').Role>, hasTarget: boolean }}
 */
export function extractTargetMentions(message) {
  const content = String(message?.content || '');
  const hasEveryone = Boolean(
    message?.mentions?.everyone ||
    content.includes('@everyone') ||
    content.includes('@here')
  );

  const rolesMap = new Map();
  if (message?.mentions?.roles) {
    for (const role of message.mentions.roles.values()) {
      rolesMap.set(role.id, role);
    }
  }

  // Also parse <@&roleId> tokens in message content
  const roleMentionRegex = /<@&([^>]+)>/g;
  let match;
  while ((match = roleMentionRegex.exec(content)) !== null) {
    const roleId = match[1];
    if (!rolesMap.has(roleId)) {
      const role = message.guild?.roles?.cache?.get(roleId);
      if (role) {
        rolesMap.set(role.id, role);
      } else {
        rolesMap.set(roleId, { id: roleId, name: '' });
      }
    }
  }

  const roles = Array.from(rolesMap.values());
  return {
    hasEveryone,
    roles,
    hasTarget: hasEveryone || roles.length > 0,
  };
}

/**
 * Formats the announcement DM text with role mentions removed, keeping formatting intact.
 * First line: "📢 Announcement from <server name>"
 * @param {string} content
 * @param {Array<import('discord.js').Role>} roles
 * @param {string} serverName
 * @returns {string}
 */
export function formatAnnouncementDm(content, roles = [], serverName = '') {
  let text = String(content || '');

  // Remove @everyone and @here mentions
  text = text.replace(/@everyone\b/g, '');
  text = text.replace(/@here\b/g, '');

  // Remove role mention syntax: <@&id>
  text = text.replace(/<@&[^>]+>/g, '');

  // Remove literal role name mentions: @RoleName
  if (Array.isArray(roles)) {
    for (const role of roles) {
      if (role?.name) {
        const escaped = role.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp(`@${escaped}\\b`, 'gi'), '');
      }
    }
  }

  // Clean up any double spaces left by removed mentions on the same line
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trimEnd())
    .join('\n');

  // Trim leading/trailing blank lines while preserving inner paragraph breaks
  text = text.replace(/^\s*\n+/, '').replace(/\n+\s*$/, '');

  const header = `📢 Announcement from ${serverName || 'the server'}`;
  return text ? `${header}\n\n${text}` : header;
}

/**
 * Resolves the configured announcement DM channel ID for a guild.
 * Finds the channel strictly by ID stored in MongoDB / cache, never by name.
 * @param {string} guildId
 * @returns {Promise<string|null>}
 */
export async function getAnnouncementChannelId(guildId) {
  if (!guildId) return null;
  const cachedId = guildSettingsCache[guildId]?.announcementDmChannelId;
  if (cachedId) return cachedId;

  const mongoId = await getAnnouncementChannel(guildId).catch(() => null);
  if (mongoId) {
    if (!guildSettingsCache[guildId]) guildSettingsCache[guildId] = {};
    guildSettingsCache[guildId].announcementDmChannelId = mongoId;
    return mongoId;
  }
  return null;
}

/**
 * Handles the admin-only `.annc setup` command.
 * Creates (or reuses) a private text channel named "announcement-dm",
 * visible and usable only by administrators and the bot, hidden from @everyone.
 * Stores its ID in MongoDB and guild settings cache.
 *
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildMember} member
 * @param {import('discord.js').TextChannel} commandChannel
 * @param {(msg: string|object) => Promise<any>} replyFn
 */
export async function handleAnncSetupCommand(guild, member, commandChannel, replyFn) {
  if (!guild) {
    return replyFn('❌ This command can only be used inside a Discord server.');
  }

  // 1. Admin permission check
  if (!isAdmin(member)) {
    return replyFn(
      '🚫 **Permission Denied:** You must be a server Administrator or have `Manage Server` permissions to use this command.'
    );
  }

  // 2. Bot Manage Channels permission check
  const botMember = guild.members.me;
  if (!botMember?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
    return replyFn(
      '❌ **Missing Bot Permissions:** The bot requires the **Manage Channels** permission in this server to configure the announcement channel.'
    );
  }

  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
    },
    {
      id: botMember.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
  ];

  let channel = null;

  // Check if already configured by stored ID
  const existingStoredId = await getAnnouncementChannelId(guild.id);
  if (existingStoredId) {
    channel =
      guild.channels.cache.get(existingStoredId) ||
      (typeof guild.channels.fetch === 'function'
        ? await guild.channels.fetch(existingStoredId).catch(() => null)
        : null);

    if (channel && channel.type === ChannelType.GuildText) {
      if (typeof channel.permissionOverwrites?.set === 'function') {
        await channel.permissionOverwrites.set(overwrites).catch(() => {});
      }
    } else {
      channel = null;
    }
  }

  // If not found by stored ID, search for existing "announcement-dm" channel to adopt
  if (!channel) {
    const existingByName = Array.from(guild.channels?.cache?.values?.() || []).find(
      (c) => c.name?.toLowerCase() === 'announcement-dm' && c.type === ChannelType.GuildText
    );
    if (existingByName) {
      channel = existingByName;
      if (typeof channel.permissionOverwrites?.set === 'function') {
        await channel.permissionOverwrites.set(overwrites).catch(() => {});
      }
    }
  }

  // If still not found, create a new private text channel
  if (!channel) {
    try {
      channel = await queueChannelCreate(guild, {
        name: 'announcement-dm',
        type: ChannelType.GuildText,
        topic: 'Admin Announcement DM Dispatch — Post announcements here mentioning target roles or @everyone',
        permissionOverwrites: overwrites,
      });
    } catch (err) {
      console.error(`[Announcement DM] Could not create announcement-dm channel in guild ${guild.id}:`, err);
      return replyFn(`❌ **Channel Creation Failed:** Could not create \`announcement-dm\`. ${err.message}`);
    }
  }

  // Store ID in MongoDB & cache
  await saveAnnouncementChannel(guild.id, channel.id);
  if (!guildSettingsCache[guild.id]) guildSettingsCache[guild.id] = {};
  guildSettingsCache[guild.id].announcementDmChannelId = channel.id;
  saveGuildSettings(guildSettingsCache);
  await saveGuildSettingsToDb(guild.id, guildSettingsCache[guild.id]);

  return replyFn(
    `✅ **Announcement DM Channel Configured:** <#${channel.id}> (\`announcement-dm\`).\n` +
    `• Write your announcement here and mention target roles (e.g. \`@role\`) or \`@everyone\`.\n` +
    `• The bot will deliver the message directly by DM to all targeted members (one by one, no duplicates).\n` +
    `• Only server administrators can post in this channel.`
  );
}

/**
 * Handles messages sent inside the designated announcement-dm channel.
 * Reads the announcement, strips mentions, resolves recipients, and dispatches DMs.
 *
 * @param {import('discord.js').Message} message
 * @returns {Promise<boolean>} True if the message was handled as an announcement message.
 */
export async function handleAnnouncementChannelMessage(message) {
  // Ignore bots
  if (!message || message.author?.bot) return false;
  if (!message.guild) return false;

  // Find announcement channel strictly by ID
  const announcementChannelId = await getAnnouncementChannelId(message.guild.id);
  if (!announcementChannelId || message.channel?.id !== announcementChannelId) {
    return false;
  }

  // Only messages from administrators are processed
  if (!isAdmin(message.member)) {
    return true; // Consume message; ignore unauthorized users
  }

  // Skip commands (e.g. .annc setup)
  const trimmed = message.content.trim();
  if (trimmed.startsWith('.annc')) {
    return false;
  }

  // Check for target mentions (@everyone or roles)
  const targetInfo = extractTargetMentions(message);
  if (!targetInfo.hasTarget) {
    await message.reply(
      '⚠️ **Notice:** You must mention a role (e.g. `@role`) or `@everyone` in your message to choose who receives this announcement DM.'
    );
    return true;
  }

  // Fetch all members from the API using Server Members Intent
  if (typeof message.guild.members?.fetch === 'function') {
    await message.guild.members.fetch().catch((err) => {
      console.warn(`[Announcement DM] Could not fetch all members from API in guild ${message.guild.id}:`, err.message);
    });
  }

  // Resolve target members (excluding bots, no duplicates)
  const targetMembersMap = new Map();

  if (targetInfo.hasEveryone) {
    // @everyone: all non-bot members
    for (const member of message.guild.members.cache.values()) {
      if (member.user && !member.user.bot) {
        targetMembersMap.set(member.id, member);
      }
    }
  } else {
    // Target specific roles
    const targetRoleIds = new Set(targetInfo.roles.map((r) => r.id));
    for (const member of message.guild.members.cache.values()) {
      if (member.user && !member.user.bot) {
        const roleItems = member.roles?.cache
          ? (typeof member.roles.cache.values === 'function' ? Array.from(member.roles.cache.values()) : [])
          : [];
        const hasRole = roleItems.some((r) => targetRoleIds.has(r.id || r));
        if (hasRole) {
          targetMembersMap.set(member.id, member);
        }
      }
    }
  }

  const targetMembers = Array.from(targetMembersMap.values());
  if (targetMembers.length === 0) {
    await message.reply(
      '⚠️ **No Recipients Found:** No eligible server members found with the specified role(s). No DMs sent.'
    );
    return true;
  }

  // Format DM content
  const dmContent = formatAnnouncementDm(message.content, targetInfo.roles, message.guild.name);
  const announcementId = crypto.randomUUID?.() || `annc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  const targetDescription = targetInfo.hasEveryone
    ? '@everyone (All server members)'
    : targetInfo.roles.map((r) => (r.name ? `@${r.name}` : `<@&${r.id}>`)).join(', ');

  const previewEmbed = new EmbedBuilder()
    .setTitle('📢 Announcement Preview')
    .setColor(0x5865F2)
    .setDescription(
      `**Targeted Roles:** ${targetDescription}\n` +
      `**Recipients:** **${targetMembers.length}** member(s) (duplicates & bots removed)\n\n` +
      `────────────────────────────────────────\n` +
      `**Announcement Text (as will be sent in DM):**\n\n` +
      `${dmContent}\n\n` +
      `────────────────────────────────────────\n` +
      `*Click **Confirm** to start DM delivery or **Cancel** to abort.*`
    )
    .setFooter({ text: `Author: ${message.author.tag || message.author.username} • ID: ${announcementId}` })
    .setTimestamp();

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`annc:confirm:${announcementId}`)
      .setLabel('Confirm')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`annc:cancel:${announcementId}`)
      .setLabel('Cancel')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger)
  );

  const previewMessage = await message.reply({
    embeds: [previewEmbed],
    components: [actionRow],
  });

  // Save pending announcement to MongoDB & local cache
  await savePendingAnnouncement({
    announcementId,
    guildId: message.guild.id,
    channelId: message.channel.id,
    messageId: previewMessage?.id || null,
    authorId: message.author.id,
    authorTag: message.author.tag || message.author.username,
    content: dmContent,
    originalContent: message.content,
    hasEveryone: targetInfo.hasEveryone,
    targetRoleIds: targetInfo.roles.map((r) => r.id),
    targetRoleNames: targetInfo.roles.map((r) => r.name),
    recipientIds: targetMembers.map((m) => m.id),
    recipientCount: targetMembers.length,
    files: message.attachments && message.attachments.size > 0 ? Array.from(message.attachments.values()).map((a) => a.url) : [],
    createdAt: new Date(),
  });

  return true;
}

/**
 * Handles Confirm and Cancel button interactions for pending announcement DMs.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @returns {Promise<boolean>}
 */
export async function handleAnnouncementInteraction(interaction) {
  if (!interaction || !interaction.isButton?.()) return false;
  const customId = String(interaction.customId || '');
  if (!customId.startsWith('annc:')) return false;

  const idParts = customId.split(':');
  const [, action, announcementId] = idParts;

  // Retrieve pending announcement from MongoDB / cache
  const pending = await getPendingAnnouncement(announcementId);
  if (!pending) {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: '⚠️ This announcement has already been handled (already sent or cancelled).',
        ephemeral: true,
      }).catch(() => {});
    }
    return true;
  }

  // Authorization check: Only the administrator who posted the announcement can use the buttons
  if (interaction.user.id !== pending.authorId) {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: '🚫 **Permission Denied:** Only the administrator who posted this announcement can use these buttons.',
        ephemeral: true,
      }).catch(() => {});
    }
    return true;
  }

  // Build disabled buttons row
  const disabledRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`annc:confirm:${announcementId}`)
      .setLabel('Confirm')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`annc:cancel:${announcementId}`)
      .setLabel('Cancel')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(true)
  );

  if (action === 'cancel') {
    // Delete pending record from MongoDB straight away
    await deletePendingAnnouncement(announcementId);

    const cancelledEmbed = EmbedBuilder.from(interaction.message?.embeds?.[0] || {})
      .setTitle('📢 Announcement Cancelled')
      .setColor(0xED4245)
      .setDescription(`❌ **Cancelled:** This announcement was cancelled by <@${interaction.user.id}>. No DMs were sent.`);

    if (typeof interaction.update === 'function') {
      await interaction.update({ embeds: [cancelledEmbed], components: [disabledRow] }).catch(() => {});
    } else if (typeof interaction.editReply === 'function') {
      await interaction.editReply({ embeds: [cancelledEmbed], components: [disabledRow] }).catch(() => {});
    }
    return true;
  }

  if (action === 'confirm') {
    // Delete pending record from MongoDB straight away to prevent double-confirmation
    await deletePendingAnnouncement(announcementId);

    const sendingEmbed = EmbedBuilder.from(interaction.message?.embeds?.[0] || {})
      .setTitle('📢 Announcement Sending...')
      .setColor(0xFEE75C)
      .setDescription(
        `⏳ **Sending...** Delivering announcement DMs to **${pending.recipientCount || pending.recipientIds?.length || 0}** member(s) in the background...`
      );

    if (typeof interaction.update === 'function') {
      await interaction.update({ embeds: [sendingEmbed], components: [disabledRow] }).catch(() => {});
    } else if (typeof interaction.editReply === 'function') {
      await interaction.editReply({ embeds: [sendingEmbed], components: [disabledRow] }).catch(() => {});
    }

    // Start background delivery
    (async () => {
      const guild = interaction.guild;
      const recipientIds = pending.recipientIds || [];
      const dmPayload = {
        content: pending.content,
        ...(Array.isArray(pending.files) && pending.files.length > 0 ? { files: pending.files } : {}),
      };

      let sentCount = 0;
      let failedCount = 0;

      for (const memberId of recipientIds) {
        let target = guild?.members?.cache?.get(memberId);
        if (!target && typeof guild?.members?.fetch === 'function') {
          target = await guild.members.fetch(memberId).catch(() => null);
        }
        if (!target && typeof interaction.client?.users?.fetch === 'function') {
          target = await interaction.client.users.fetch(memberId).catch(() => null);
        }

        if (!target) {
          failedCount++;
          continue;
        }

        try {
          await queueDirectMessage(target, dmPayload);
          sentCount++;
        } catch {
          failedCount++;
          // Skip closed DMs / failures without aborting the delivery run
        }
      }

      // Post final delivery summary to the channel
      await queueChannelSend(interaction.channel, {
        content:
          `📢 **Announcement DM Summary:**\n` +
          `• **Sent Successfully:** ${sentCount}\n` +
          `• **Failed / DMs Closed:** ${failedCount}\n` +
          `• **Total Recipients:** ${recipientIds.length}`,
      });
    })().catch((err) => {
      console.error(`[Announcement DM] Unhandled delivery error for ${announcementId}:`, err);
    });

    return true;
  }

  return false;
}
