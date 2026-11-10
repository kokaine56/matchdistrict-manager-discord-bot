import crypto from 'crypto';
import {
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
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
    const announcementId = crypto.randomUUID?.() || `annc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    await savePendingAnnouncement({
      announcementId,
      guildId: message.guild.id,
      channelId: message.channel.id,
      authorId: message.author.id,
      authorTag: message.author.tag || message.author.username,
      content: message.content,
      originalContent: message.content,
      deliveryType: 'channel',
      files: message.attachments && message.attachments.size > 0 ? Array.from(message.attachments.values()).map((a) => a.url) : [],
      createdAt: new Date(),
    });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`annc:method:channel:${announcementId}`)
        .setLabel('Send to Channels')
        .setEmoji('📢')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`annc:cancel:${announcementId}`)
        .setLabel('Cancel')
        .setEmoji('❌')
        .setStyle(ButtonStyle.Danger)
    );

    await message.reply({
      content:
        '⚠️ **Notice:** You must mention a role (e.g. `@role`) or `@everyone` in your message to choose who receives this announcement DM.\n\n' +
        '💡 *Want to broadcast this message to Discord channels instead? Click **Send to Channels** below.*',
      components: [row],
    });
    return true;
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
 * Fetches and filters available text channels in the guild where the bot can send messages.
 * @param {import('discord.js').Guild} guild
 * @returns {Array<import('discord.js').GuildTextBasedChannel>}
 */
export function fetchAvailableTextChannels(guild) {
  if (!guild || !guild.channels?.cache) return [];
  const channels = Array.from(guild.channels.cache.values());
  const me = guild.members?.me || guild.me || null;

  return channels
    .filter((ch) => {
      // Must be text-based guild channel (GuildText = 0, GuildAnnouncement = 5)
      const isTextType =
        ch.type === ChannelType.GuildText ||
        ch.type === ChannelType.GuildAnnouncement ||
        ch.type === 0 ||
        ch.type === 5;
      if (!isTextType) return false;

      // Check bot permissions if permissionsFor is available
      if (typeof ch.permissionsFor === 'function' && me) {
        const perms = ch.permissionsFor(me);
        if (perms && typeof perms.has === 'function') {
          const canView = perms.has(PermissionFlagsBits.ViewChannel) || perms.has('ViewChannel');
          const canSend = perms.has(PermissionFlagsBits.SendMessages) || perms.has('SendMessages');
          if (!canView || !canSend) return false;
        }
      }
      return true;
    })
    .sort((a, b) => {
      const posA = typeof a.position === 'number' ? a.position : 0;
      const posB = typeof b.position === 'number' ? b.position : 0;
      if (posA !== posB) return posA - posB;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
}

/**
 * Builds the delivery method selection payload (Channel Announcement vs Member DM).
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildMember} member
 * @param {string} announcementId
 * @returns {{ embeds: Array<EmbedBuilder>, components: Array<ActionRowBuilder> }}
 */
export function buildDeliveryMethodPayload(guild, member, announcementId) {
  const embed = new EmbedBuilder()
    .setTitle('📢 Match District Announcement Manager')
    .setColor(0x5865F2)
    .setDescription(
      `Welcome to the Announcement Manager! Please select how you want to deliver your announcement:\n\n` +
      `**1️⃣ Channel Announcement** 📢\n` +
      `Broadcast your announcement directly to one or multiple server text channels with an interactive channel selector.\n\n` +
      `**2️⃣ Member DM Announcement** 📩\n` +
      `Deliver direct messages to server members based on assigned roles via the dedicated announcement DM channel.\n\n` +
      `*Choose an option below to proceed:*`
    )
    .setFooter({ text: `ID: ${announcementId}` })
    .setTimestamp();

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`annc:method:channel:${announcementId}`)
      .setLabel('Channel Announcement')
      .setEmoji('📢')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`annc:method:dm:${announcementId}`)
      .setLabel('Member DM Announcement')
      .setEmoji('📩')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`annc:cancel:${announcementId}`)
      .setLabel('Cancel')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger)
  );

  return {
    embeds: [embed],
    components: [actionRow],
  };
}

/**
 * Builds the channel selection dropdown payload.
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildMember} member
 * @param {string} announcementId
 * @returns {{ embeds: Array<EmbedBuilder>, components: Array<ActionRowBuilder> }}
 */
export function buildChannelSelectionPayload(guild, member, announcementId) {
  const availableChannels = fetchAvailableTextChannels(guild);

  if (!availableChannels || availableChannels.length === 0) {
    const errorEmbed = new EmbedBuilder()
      .setTitle('📢 Channel Announcement — No Eligible Channels')
      .setColor(0xED4245)
      .setDescription(
        '⚠️ No eligible text channels were found where the bot has permission to view and send messages.\n\n' +
        'Please ensure the bot has **View Channel** and **Send Messages** permissions in your server channels.'
      );

    const cancelRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`annc:cancel:${announcementId}`)
        .setLabel('Dismiss')
        .setStyle(ButtonStyle.Secondary)
    );

    return {
      embeds: [errorEmbed],
      components: [cancelRow],
    };
  }

  const maxSelectable = Math.min(availableChannels.length, 25);
  const options = availableChannels.slice(0, 25).map((ch) => ({
    label: `#${ch.name || 'channel'}`.slice(0, 100),
    value: String(ch.id),
    description: (ch.topic ? ch.topic.slice(0, 95) : `Channel ID: ${ch.id}`).slice(0, 100),
    emoji: ch.type === ChannelType.GuildAnnouncement || ch.type === 5 ? '📢' : '💬',
  }));

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`annc:select_channels:${announcementId}`)
    .setPlaceholder('Select channel(s) for the announcement...')
    .setMinValues(1)
    .setMaxValues(maxSelectable)
    .addOptions(options);

  const menuRow = new ActionRowBuilder().addComponents(selectMenu);

  const cancelRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`annc:cancel:${announcementId}`)
      .setLabel('Cancel')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger)
  );

  const embed = new EmbedBuilder()
    .setTitle('📢 Select Target Channels')
    .setColor(0x5865F2)
    .setDescription(
      `Select one or more channels from the dropdown below where you want to send this announcement.\n\n` +
      `• **Available Channels:** ${availableChannels.length} channel(s) found.\n` +
      `• **Selection Range:** Select between 1 and **${maxSelectable}** channel(s).\n\n` +
      `*After choosing channels, you will be prompted to compose/confirm your message.*`
    )
    .setFooter({ text: `ID: ${announcementId}` })
    .setTimestamp();

  return {
    embeds: [embed],
    components: [menuRow, cancelRow],
  };
}

/**
 * Builds the announcement composition modal.
 * @param {string} announcementId
 * @param {string} initialContent
 * @returns {ModalBuilder}
 */
export function buildComposeModal(announcementId, initialContent = '') {
  const modal = new ModalBuilder()
    .setCustomId(`annc:modal:${announcementId}`)
    .setTitle('Compose Announcement');

  const titleInput = new TextInputBuilder()
    .setCustomId('annc_title')
    .setLabel('Title / Header (Optional)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 🏆 TOURNAMENT REGISTRATIONS OPEN!')
    .setRequired(false)
    .setMaxLength(256);

  const contentInput = new TextInputBuilder()
    .setCustomId('annc_content')
    .setLabel('Announcement Message')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Type your announcement message here. Markdown formatting is supported.')
    .setRequired(true)
    .setMaxLength(4000);

  if (initialContent) {
    contentInput.setValue(initialContent.slice(0, 4000));
  }

  modal.addComponents(
    new ActionRowBuilder().addComponents(titleInput),
    new ActionRowBuilder().addComponents(contentInput)
  );

  return modal;
}

/**
 * Builds the confirmation preview payload for a channel announcement.
 * @param {object} pending
 * @param {import('discord.js').Guild} guild
 * @returns {{ embeds: Array<EmbedBuilder>, components: Array<ActionRowBuilder> }}
 */
export function buildChannelPreviewPayload(pending, guild) {
  const targetChannels = (pending.targetChannelIds || [])
    .map((id) => {
      const ch = guild?.channels?.cache?.get(id);
      return ch ? `<#${id}> (#${ch.name})` : `<#${id}>`;
    })
    .join(', ') || 'No channels selected';

  const previewEmbed = new EmbedBuilder()
    .setTitle('📢 Channel Announcement Preview')
    .setColor(0x5865F2)
    .setDescription(
      `**Target Channels:** ${targetChannels}\n` +
      `**Total Channels:** **${pending.targetChannelIds?.length || 0}** channel(s)\n\n` +
      `────────────────────────────────────────\n` +
      `**Announcement Preview:**\n\n` +
      `${pending.content || '_No content entered yet._'}\n\n` +
      `────────────────────────────────────────\n` +
      `*Review the announcement above. Click **Confirm & Send** to publish, **Edit Message** to modify content, or **Cancel** to abort.*`
    )
    .setFooter({
      text: `Author: ${pending.authorTag || pending.authorId} • ID: ${pending.announcementId}`,
    })
    .setTimestamp();

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`annc:confirm_channel:${pending.announcementId}`)
      .setLabel('Confirm & Send')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`annc:compose:${pending.announcementId}`)
      .setLabel('Edit Message')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`annc:cancel:${pending.announcementId}`)
      .setLabel('Cancel')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger)
  );

  return {
    embeds: [previewEmbed],
    components: [actionRow],
  };
}

/**
 * Handles .annc menu and .annc channel commands.
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildMember} member
 * @param {import('discord.js').TextChannel} channel
 * @param {Function} replyFn
 * @param {string} subCmd
 * @param {string[]} args
 */
export async function handleAnncMenuCommand(guild, member, channel, replyFn, subCmd, args = []) {
  if (!guild || !member) return;

  if (!isAdmin(member)) {
    await replyFn('🚫 **Permission Denied:** Only administrators can configure or send announcements.');
    return;
  }

  const announcementId = crypto.randomUUID?.() || `annc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  let initialContent = '';
  if (subCmd === 'channel' && args.length > 1) {
    initialContent = args.slice(1).join(' ').trim();
  }

  await savePendingAnnouncement({
    announcementId,
    guildId: guild.id,
    channelId: channel?.id || null,
    authorId: member.user?.id || member.id,
    authorTag: member.user?.tag || member.user?.username || member.displayName || 'Administrator',
    deliveryType: 'channel',
    content: initialContent,
    createdAt: new Date(),
  });

  if (subCmd === 'channel') {
    const payload = buildChannelSelectionPayload(guild, member, announcementId);
    await replyFn(payload);
    return;
  }

  const payload = buildDeliveryMethodPayload(guild, member, announcementId);
  await replyFn(payload);
}

/**
 * Handles Confirm and Cancel button, select menu, and modal interactions for pending announcements.
 * @param {import('discord.js').Interaction} interaction
 * @returns {Promise<boolean>}
 */
export async function handleAnnouncementInteraction(interaction) {
  if (
    !interaction ||
    (!interaction.isButton?.() &&
      !interaction.isStringSelectMenu?.() &&
      !interaction.isSelectMenu?.() &&
      !interaction.isModalSubmit?.())
  ) {
    return false;
  }

  const customId = String(interaction.customId || '');
  if (!customId.startsWith('annc:')) return false;

  const idParts = customId.split(':');
  const action = idParts[1];
  let announcementId;
  let methodType = null;

  if (action === 'method') {
    methodType = idParts[2];
    announcementId = idParts[3];
  } else {
    announcementId = idParts[2];
  }

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

  // Authorization check: Only the administrator who created the announcement can use the controls
  if (interaction.user.id !== pending.authorId) {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: '🚫 **Permission Denied:** Only the administrator who posted this announcement can use these buttons.',
        ephemeral: true,
      }).catch(() => {});
    }
    return true;
  }

  // Build disabled buttons row matching the interaction type
  const isChannelFlow =
    pending.deliveryType === 'channel' ||
    (Array.isArray(pending.targetChannelIds) && pending.targetChannelIds.length > 0);

  const disabledRow = isChannelFlow
    ? new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`annc:confirm_channel:${announcementId}`)
          .setLabel('Confirm & Send')
          .setEmoji('✅')
          .setStyle(ButtonStyle.Success)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(`annc:compose:${announcementId}`)
          .setLabel('Edit Message')
          .setEmoji('✏️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(`annc:cancel:${announcementId}`)
          .setLabel('Cancel')
          .setEmoji('❌')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(true)
      )
    : new ActionRowBuilder().addComponents(
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

  // 1. Delivery method switch
  if (action === 'method') {
    if (methodType === 'channel') {
      pending.deliveryType = 'channel';
      await savePendingAnnouncement(pending);
      const payload = buildChannelSelectionPayload(interaction.guild, interaction.member, announcementId);
      if (typeof interaction.update === 'function') {
        await interaction.update(payload).catch(() => {});
      } else if (typeof interaction.editReply === 'function') {
        await interaction.editReply(payload).catch(() => {});
      }
      return true;
    }

    if (methodType === 'dm') {
      const anncChId = await getAnnouncementChannelId(interaction.guild?.id);
      const dmGuideEmbed = new EmbedBuilder()
        .setTitle('📩 Member DM Announcements Guide')
        .setColor(0x5865F2)
        .setDescription(
          `Member DM announcements are sent through the dedicated announcement DM channel.\n\n` +
          `**How to use:**\n` +
          `1. Go to ${anncChId ? `<#${anncChId}>` : 'the designated `#announcement-dm` channel (run `.annc setup` to create it)'}.\n` +
          `2. Post your announcement message and mention the target role(s) (e.g. \`@role\`) or \`@everyone\`.\n` +
          `3. The bot will automatically display a preview with recipient counts and Confirm / Cancel buttons.\n` +
          `4. Click **Confirm** to start DM delivery in the background.`
        )
        .setFooter({ text: `ID: ${announcementId}` });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`annc:method:channel:${announcementId}`)
          .setLabel('Switch to Channel Announcement')
          .setEmoji('📢')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`annc:cancel:${announcementId}`)
          .setLabel('Dismiss')
          .setStyle(ButtonStyle.Secondary)
      );

      if (typeof interaction.update === 'function') {
        await interaction.update({ embeds: [dmGuideEmbed], components: [row] }).catch(() => {});
      }
      return true;
    }
  }

  // 2. Select target channels from dropdown
  if (action === 'select_channels') {
    const selectedChannelIds = Array.isArray(interaction.values) ? interaction.values : [];
    if (selectedChannelIds.length === 0) {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '⚠️ Please select at least one channel.', ephemeral: true }).catch(() => {});
      }
      return true;
    }

    pending.targetChannelIds = selectedChannelIds;
    pending.deliveryType = 'channel';
    await savePendingAnnouncement(pending);

    if (pending.content && pending.content.trim().length > 0) {
      const previewPayload = buildChannelPreviewPayload(pending, interaction.guild);
      if (typeof interaction.update === 'function') {
        await interaction.update(previewPayload).catch(() => {});
      } else if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
        await interaction.reply(previewPayload).catch(() => {});
      }
    } else {
      const composePromptEmbed = new EmbedBuilder()
        .setTitle('📢 Target Channels Selected')
        .setColor(0x5865F2)
        .setDescription(
          `**Selected Channels:** ${selectedChannelIds.map((id) => `<#${id}>`).join(', ')}\n` +
          `**Total Channels:** **${selectedChannelIds.length}**\n\n` +
          `Now, click **Compose Announcement** below to write your message, or click **Cancel** to abort.`
        )
        .setFooter({ text: `ID: ${announcementId}` });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`annc:compose:${announcementId}`)
          .setLabel('Compose Announcement')
          .setEmoji('✏️')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`annc:cancel:${announcementId}`)
          .setLabel('Cancel')
          .setEmoji('❌')
          .setStyle(ButtonStyle.Danger)
      );

      if (typeof interaction.update === 'function') {
        await interaction.update({ embeds: [composePromptEmbed], components: [row] }).catch(() => {});
      } else if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ embeds: [composePromptEmbed], components: [row] }).catch(() => {});
      }
    }
    return true;
  }

  // 3. Open compose modal
  if (action === 'compose') {
    const modal = buildComposeModal(announcementId, pending.content);
    if (typeof interaction.showModal === 'function') {
      await interaction.showModal(modal).catch((err) => {
        console.error('[Announcement Modal Error]', err);
      });
    }
    return true;
  }

  // 4. Modal submit
  if (action === 'modal') {
    const title = interaction.fields?.getTextInputValue?.('annc_title')?.trim() || '';
    const content = interaction.fields?.getTextInputValue?.('annc_content')?.trim() || '';

    if (!content) {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '⚠️ Announcement message content cannot be empty.', ephemeral: true }).catch(() => {});
      }
      return true;
    }

    const fullContent = title ? `**${title}**\n\n${content}` : content;
    pending.content = fullContent;
    await savePendingAnnouncement(pending);

    const previewPayload = buildChannelPreviewPayload(pending, interaction.guild);
    if (typeof interaction.update === 'function') {
      await interaction.update(previewPayload).catch(async () => {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply(previewPayload).catch(() => {});
        }
      });
    } else if (!interaction.replied && !interaction.deferred) {
      await interaction.reply(previewPayload).catch(() => {});
    }
    return true;
  }

  // 5. Cancel action
  if (action === 'cancel') {
    // Delete pending record straight away
    await deletePendingAnnouncement(announcementId);

    const cancelMsg = isChannelFlow
      ? `❌ **Cancelled:** This announcement was cancelled by <@${interaction.user.id}>. No messages were sent.`
      : `❌ **Cancelled:** This announcement was cancelled by <@${interaction.user.id}>. No DMs were sent.`;

    const cancelledEmbed = EmbedBuilder.from(interaction.message?.embeds?.[0] || {})
      .setTitle('📢 Announcement Cancelled')
      .setColor(0xED4245)
      .setDescription(cancelMsg);

    if (typeof interaction.update === 'function') {
      await interaction.update({ embeds: [cancelledEmbed], components: [disabledRow] }).catch(() => {});
    } else if (typeof interaction.editReply === 'function') {
      await interaction.editReply({ embeds: [cancelledEmbed], components: [disabledRow] }).catch(() => {});
    }
    return true;
  }

  // 6. Confirm Channel Announcement
  if (action === 'confirm_channel') {
    // Delete pending record from MongoDB straight away to prevent double-confirmation
    await deletePendingAnnouncement(announcementId);

    const sendingEmbed = EmbedBuilder.from(interaction.message?.embeds?.[0] || {})
      .setTitle('📢 Channel Announcement Sending...')
      .setColor(0xFEE75C)
      .setDescription(
        `⏳ **Sending...** Delivering announcement to **${pending.targetChannelIds?.length || 0}** channel(s) in the background...`
      );

    if (typeof interaction.update === 'function') {
      await interaction.update({ embeds: [sendingEmbed], components: [disabledRow] }).catch(() => {});
    } else if (typeof interaction.editReply === 'function') {
      await interaction.editReply({ embeds: [sendingEmbed], components: [disabledRow] }).catch(() => {});
    }

    // Start background delivery to selected channels
    (async () => {
      const guild = interaction.guild;
      const targetChannelIds = pending.targetChannelIds || [];
      const channelPayload = {
        content: pending.content,
        ...(Array.isArray(pending.files) && pending.files.length > 0 ? { files: pending.files } : {}),
      };

      const successfulChannels = [];
      const failedChannels = [];
      const skippedChannels = [];

      const me = guild?.members?.me || guild?.me || null;

      for (const channelId of targetChannelIds) {
        let channel = guild?.channels?.cache?.get(channelId);
        if (!channel && typeof guild?.channels?.fetch === 'function') {
          channel = await guild.channels.fetch(channelId).catch(() => null);
        }
        if (!channel && typeof interaction.client?.channels?.fetch === 'function') {
          channel = await interaction.client.channels.fetch(channelId).catch(() => null);
        }

        if (!channel) {
          failedChannels.push({ id: channelId, reason: 'Channel not found or deleted' });
          continue;
        }

        // Check bot permissions: must have ViewChannel and SendMessages
        if (typeof channel.permissionsFor === 'function' && me) {
          const perms = channel.permissionsFor(me);
          if (perms && typeof perms.has === 'function') {
            const canView = perms.has(PermissionFlagsBits.ViewChannel) || perms.has('ViewChannel');
            const canSend = perms.has(PermissionFlagsBits.SendMessages) || perms.has('SendMessages');
            if (!canView || !canSend) {
              skippedChannels.push({
                id: channelId,
                name: channel.name,
                reason: !canView ? 'Bot lacks View Channel permission' : 'Bot lacks Send Messages permission',
              });
              continue;
            }
          }
        }

        try {
          await queueChannelSend(channel, channelPayload);
          successfulChannels.push({ id: channelId, name: channel.name });
        } catch (err) {
          failedChannels.push({ id: channelId, name: channel.name, reason: err?.message || 'Send error' });
        }
      }

      // Build summary embed
      const isAllFailed = successfulChannels.length === 0 && (failedChannels.length > 0 || skippedChannels.length > 0);
      const summaryEmbed = new EmbedBuilder()
        .setTitle('📢 Channel Announcement Summary')
        .setColor(isAllFailed ? 0xED4245 : 0x57F287)
        .setDescription(
          `**Delivery Results:**\n` +
          `• **Sent Successfully:** **${successfulChannels.length}**\n` +
          `• **Skipped (Missing Permissions):** **${skippedChannels.length}**\n` +
          `• **Failed:** **${failedChannels.length}**\n` +
          `• **Total Channels:** **${targetChannelIds.length}**\n\n` +
          (successfulChannels.length > 0
            ? `**Sent To:**\n${successfulChannels.map((c) => `• <#${c.id}>`).join('\n')}\n\n`
            : '') +
          (skippedChannels.length > 0
            ? `**Skipped Channels (Permissions):**\n${skippedChannels.map((c) => `• <#${c.id}> — _${c.reason}_`).join('\n')}\n\n`
            : '') +
          (failedChannels.length > 0
            ? `**Failed Channels:**\n${failedChannels.map((c) => `• <#${c.id}> — _${c.reason}_`).join('\n')}`
            : '')
        )
        .setFooter({ text: `ID: ${announcementId}` })
        .setTimestamp();

      await queueChannelSend(interaction.channel, {
        embeds: [summaryEmbed],
      });
    })().catch((err) => {
      console.error(`[Announcement Channel Delivery Error] for ${announcementId}:`, err);
    });

    return true;
  }

  // 7. Confirm DM Announcement (preserved)
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
