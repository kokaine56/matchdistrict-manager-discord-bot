import {
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import {
  queueChannelCreate,
  queueChannelDelete,
  queueRoleCreate,
  queueChannelSend,
  enqueueDiscordAction,
} from './discordQueue.js';
import {
  saveTicketPanel,
  getTicketPanel,
  getNextTicketNumber,
  saveTicketToDb,
  getTicketFromDb,
  updateTicketStatusInDb,
  saveStaffApplicationToDb,
  getStaffApplicationFromDb,
} from './mongoService.js';
import {
  getGuildSettings,
  saveGuildSettings,
  guildSettingsCache,
} from './index.js';

/**
 * Configuration list for ticket category options.
 * Now includes "General Support" and "Apply as Staff".
 */
export const TICKET_OPTIONS = [
  {
    label: 'General Support',
    value: 'general_support',
    description: 'Get help with general inquiries or issues',
    emoji: '📩',
  },
  {
    label: 'Apply as Staff',
    value: 'apply_staff',
    description: 'Apply to join the MatchDistrict staff team',
    emoji: '💼',
  },
];

/**
 * Available roles for Staff Applications.
 */
export const STAFF_ROLES = [
  {
    label: 'Mod',
    value: 'Mod',
    description: 'Community moderation & rule enforcement',
    emoji: '🛡️',
  },
  {
    label: 'Scrims Manager',
    value: 'Scrims Manager',
    description: 'Organizing and managing scrim matches',
    emoji: '⚔️',
  },
  {
    label: 'Room Maker',
    value: 'Room Maker',
    description: 'Creating in-game custom rooms & distributing credentials',
    emoji: '🎮',
  },
  {
    label: 'Pt Making',
    value: 'Pt Making',
    description: 'Points table calculation and scoreboard preparation',
    emoji: '📊',
  },
  {
    label: 'Poster Making',
    value: 'Poster Making',
    description: 'Graphics, posters, banners and promotional designs',
    emoji: '🎨',
  },
];

// In-memory mutex and draft cache
const ticketSetupInProgress = new Set();
export const pendingStaffDrafts = new Map(); // draftId -> draft data
const activeStaffSubmissions = new Set(); // userId

/**
 * Validates basic email address format.
 * @param {string} email
 * @returns {boolean}
 */
export function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;
  return re.test(email.trim());
}

/**
 * Validates contact number (supports country codes, common formats, reasonable length).
 * @param {string} phone
 * @returns {boolean}
 */
export function isValidPhoneNumber(phone) {
  if (!phone || typeof phone !== 'string') return false;
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 18) return false;
  const re = /^[\+]?[0-9\s\-\.\(\)]{7,25}$/;
  return re.test(trimmed);
}

/**
 * Checks if a member has administrator or manage server permissions.
 * @param {import('discord.js').GuildMember} member
 * @returns {boolean}
 */
export function isMemberAdmin(member) {
  if (!member) return false;
  if (member.guild && member.guild.ownerId === member.id) return true;
  return (
    Boolean(member.permissions?.has(PermissionFlagsBits.Administrator)) ||
    Boolean(member.permissions?.has(PermissionFlagsBits.ManageGuild)) ||
    false
  );
}

/**
 * Helper to determine if a member is allowed to close a ticket channel.
 */
async function canMemberCloseTicket(member, channelId, channel) {
  if (!member) return false;
  if (isMemberAdmin(member)) return true;

  const hasSupportRole = member.roles?.cache?.some(
    (r) => r.name?.toLowerCase() === 'support team'
  );
  if (hasSupportRole) return true;

  const ticket = await getTicketFromDb(channelId);
  if (ticket && ticket.userId === member.id) return true;

  // Fallback check if MongoDB is in offline mode or mock test
  if (channel?.topic && channel.topic.includes(member.id)) return true;
  if (channel?.permissionOverwrites?.overwrites) {
    const userOverwrite = channel.permissionOverwrites.overwrites.find(
      (o) => o.id === member.id
    );
    if (userOverwrite) return true;
  }

  return false;
}

/**
 * Resolves or creates a private log channel with idempotent reuse.
 */
async function ensurePrivateLogChannel(guild, savedId, name, topic) {
  if (!guild) return null;
  const botMember = guild.members.me;
  const overwrites = [
    {
      id: guild.roles?.everyone?.id || guild.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    ...(botMember ? [{
      id: botMember.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
      ],
    }] : []),
  ];

  let channel = null;
  if (savedId) {
    channel = guild.channels.cache.get(savedId) ||
      (typeof guild.channels?.fetch === 'function' ? await guild.channels.fetch(savedId).catch(() => null) : null);
  }
  if (!channel) {
    channel = Array.from(guild.channels.cache.values()).find(
      (c) => c.name?.toLowerCase() === name.toLowerCase() && (c.type === ChannelType.GuildText || c.type === 0)
    );
  }
  if (!channel) {
    channel = await queueChannelCreate(guild, {
      name,
      type: ChannelType.GuildText,
      topic,
      permissionOverwrites: overwrites,
    }).catch(() => null);
  } else {
    if (typeof channel.permissionOverwrites?.set === 'function') {
      await channel.permissionOverwrites.set(overwrites).catch(() => {});
    }
  }
  return channel;
}

/**
 * Resolves the dedicated ticket-log channel for a guild.
 */
export async function getTicketLogChannel(guild) {
  if (!guild) return null;
  const currentSettings = getGuildSettings(guild.id) || {};
  const savedId = currentSettings.channels?.ticketLogId;
  let channel = null;
  if (savedId) {
    channel = guild.channels.cache.get(savedId) ||
      (typeof guild.channels?.fetch === 'function' ? await guild.channels.fetch(savedId).catch(() => null) : null);
  }
  if (!channel) {
    channel = Array.from(guild.channels.cache.values()).find(
      (c) => c.name?.toLowerCase() === 'ticket-log' && (c.type === ChannelType.GuildText || c.type === 0)
    );
  }
  return channel;
}

/**
 * Resolves the dedicated staff-application-log channel for a guild.
 */
export async function getStaffAppLogChannel(guild) {
  if (!guild) return null;
  const currentSettings = getGuildSettings(guild.id) || {};
  const savedId = currentSettings.channels?.staffAppLogId;
  let channel = null;
  if (savedId) {
    channel = guild.channels.cache.get(savedId) ||
      (typeof guild.channels?.fetch === 'function' ? await guild.channels.fetch(savedId).catch(() => null) : null);
  }
  if (!channel) {
    channel = Array.from(guild.channels.cache.values()).find(
      (c) => c.name?.toLowerCase() === 'staff-application-log' && (c.type === ChannelType.GuildText || c.type === 0)
    );
  }
  return channel;
}

/**
 * Sends a structured ticket event embed to ticket-log.
 */
export async function logTicketEvent(guild, eventType, data = {}) {
  try {
    const logChannel = await getTicketLogChannel(guild);
    if (!logChannel) return;

    let embed = null;
    if (eventType === 'ticket_opened') {
      embed = new EmbedBuilder()
        .setTitle(`🎫 Ticket Opened: #${data.ticketNumber}`)
        .setColor(0x2ECC71) // Green
        .addFields(
          { name: 'Ticket Channel', value: `<#${data.channelId}> (\`${data.channelName || data.channelId}\`)`, inline: true },
          { name: 'Opened By', value: `<@${data.userId}> (\`${data.userId}\`)`, inline: true },
          { name: 'Category', value: data.optionChosen || 'General Support', inline: true },
          { name: 'Action', value: 'Ticket Created', inline: false }
        )
        .setTimestamp();
    } else if (eventType === 'ticket_closed') {
      embed = new EmbedBuilder()
        .setTitle(`🔒 Ticket Closed: #${data.ticketNumber || 'Ticket'}`)
        .setColor(0xE67E22) // Orange
        .addFields(
          { name: 'Ticket Channel', value: data.channelName ? `#${data.channelName}` : `<#${data.channelId}>`, inline: true },
          { name: 'Closed By', value: `<@${data.closedBy}> (\`${data.closedBy}\`)`, inline: true },
          { name: 'Ticket Creator', value: data.userId ? `<@${data.userId}> (\`${data.userId}\`)` : 'Unknown', inline: true },
          { name: 'Action', value: 'Ticket Closed', inline: false }
        )
        .setTimestamp();
    } else if (eventType === 'ticket_deleted') {
      embed = new EmbedBuilder()
        .setTitle(`🗑️ Ticket Channel Deleted: #${data.ticketNumber || 'Ticket'}`)
        .setColor(0x95A5A6) // Gray
        .addFields(
          { name: 'Channel Name', value: data.channelName ? `#${data.channelName}` : 'Unknown', inline: true },
          { name: 'Action', value: 'Channel Deleted', inline: true },
          { name: 'Ticket Creator', value: data.userId ? `<@${data.userId}>` : 'Unknown', inline: true }
        )
        .setTimestamp();
    } else if (eventType === 'ticket_error') {
      embed = new EmbedBuilder()
        .setTitle('⚠️ Ticket Action Error')
        .setColor(0xED4245) // Red
        .addFields(
          { name: 'User', value: data.userId ? `<@${data.userId}>` : 'Unknown', inline: true },
          { name: 'Action', value: data.action || 'Ticket Operation', inline: true },
          { name: 'Error', value: String(data.error || 'Unknown error'), inline: false }
        )
        .setTimestamp();
    }

    if (embed) {
      await queueChannelSend(logChannel, { embeds: [embed] }).catch((err) => {
        console.warn('[Ticket Service] ⚠️ Could not send to ticket-log:', err.message);
      });
    }
  } catch (err) {
    console.warn('[Ticket Service] ⚠️ Error logging ticket event:', err.message);
  }
}

/**
 * Builds the native Discord Modal for Staff Applications (Step 1).
 */
export function buildStaffApplicationModal() {
  const modal = new ModalBuilder()
    .setCustomId('ticket:staff_modal')
    .setTitle('Staff Application Form');

  const emailInput = new TextInputBuilder()
    .setCustomId('staff_email')
    .setLabel('Email Address')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('name@example.com')
    .setMinLength(5)
    .setMaxLength(100)
    .setRequired(true);

  const phoneInput = new TextInputBuilder()
    .setCustomId('staff_phone')
    .setLabel('Contact Number (with Country Code)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('+91 9876543210')
    .setMinLength(7)
    .setMaxLength(25)
    .setRequired(true);

  const motivationInput = new TextInputBuilder()
    .setCustomId('staff_motivation')
    .setLabel('Why do you want to join our staff team?')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Tell us about your motivation and experience...')
    .setMinLength(10)
    .setMaxLength(1000)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(emailInput),
    new ActionRowBuilder().addComponents(phoneInput),
    new ActionRowBuilder().addComponents(motivationInput)
  );

  return modal;
}

/**
 * Handles the admin-only `.ticket setup` command.
 * Idempotent: reuses existing channels, updates panel in place, avoids duplicates.
 */
export async function handleTicketSetupCommand(guild, member, channel, replyFn) {
  if (!guild) {
    return replyFn('❌ This command can only be used inside a server.');
  }

  // 1. Admin permission check
  if (!isMemberAdmin(member)) {
    return replyFn(
      '❌ **Permission Denied:** Only server Administrators or members with `Manage Server` permission can run `.ticket setup`.'
    );
  }

  // 2. Check bot permissions
  if (!guild.members.me?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
    return replyFn(
      '❌ **Bot Missing Permissions:** I need the `Manage Channels` permission to create and configure support ticket channels.'
    );
  }

  // Prevent concurrent setups
  if (ticketSetupInProgress.has(guild.id)) {
    return replyFn('⏳ A ticket setup operation is already in progress. Please wait a moment.');
  }
  ticketSetupInProgress.add(guild.id);

  try {
    const currentSettings = getGuildSettings(guild.id) || {};
    const savedChannels = currentSettings.channels || {};
    const panelRecord = await getTicketPanel(guild.id);

    const channelOptions = {
      name: 'support-ticket',
      type: ChannelType.GuildText,
      topic: 'Official MatchDistrict Support Ticket Channel',
      permissionOverwrites: [
        {
          id: guild.roles?.everyone?.id || guild.id, // @everyone can read but not send messages
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.ReadMessageHistory,
          ],
          deny: [
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.AddReactions,
            PermissionFlagsBits.CreatePublicThreads,
            PermissionFlagsBits.CreatePrivateThreads,
            PermissionFlagsBits.SendMessagesInThreads,
          ],
        },
        {
          id: guild.members.me.id, // Bot has full send/embed permissions
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ManageMessages,
          ],
        },
      ],
    };

    // 3. Find or create the "support-ticket" channel idempotently
    let ticketPanelChannel = null;
    const existingChannelId = panelRecord?.channelId || savedChannels.supportTicketId;
    if (existingChannelId) {
      ticketPanelChannel = guild.channels.cache.get(existingChannelId) ||
        (typeof guild.channels?.fetch === 'function' ? await guild.channels.fetch(existingChannelId).catch(() => null) : null);
    }
    if (!ticketPanelChannel) {
      ticketPanelChannel = Array.from(guild.channels.cache.values()).find(
        (c) => c.name?.toLowerCase() === 'support-ticket' && (c.type === ChannelType.GuildText || c.type === 0)
      );
    }

    if (!ticketPanelChannel) {
      ticketPanelChannel = await queueChannelCreate(guild, channelOptions);
    } else {
      // Reusing channel: ensure permission overwrites are updated
      if (typeof ticketPanelChannel.permissionOverwrites?.set === 'function') {
        await enqueueDiscordAction(
          () => ticketPanelChannel.permissionOverwrites.set(channelOptions.permissionOverwrites),
          'action'
        ).catch(() => {});
      }
    }

    if (!ticketPanelChannel) {
      return replyFn('❌ Failed to create or access the `#support-ticket` channel.');
    }

    // 4. Build the Support Ticket Panel Embed
    const panelEmbed = new EmbedBuilder()
      .setTitle('Support')
      .setDescription('To create a ticket, make a selection below')
      .setColor(0x5865F2)
      .setFooter({ text: 'MatchDistrict Support' });

    // 5. Build Select Menu with deduplication to prevent duplicate options
    const uniqueOptions = [];
    const seenValues = new Set();
    for (const opt of TICKET_OPTIONS) {
      if (!seenValues.has(opt.value)) {
        seenValues.add(opt.value);
        uniqueOptions.push(opt);
      }
    }

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('ticket:select_category')
      .setPlaceholder('Make a selection')
      .addOptions(
        uniqueOptions.map((opt) => ({
          label: opt.label,
          value: opt.value,
          description: opt.description || undefined,
          emoji: opt.emoji || undefined,
        }))
      );

    const row = new ActionRowBuilder().addComponents(selectMenu);

    // 6. Check if panel message already exists; update in place if possible
    let existingMsg = null;
    if (panelRecord?.messageId && typeof ticketPanelChannel.messages?.fetch === 'function') {
      existingMsg = await ticketPanelChannel.messages.fetch(panelRecord.messageId).catch(() => null);
    }
    if (!existingMsg && Array.isArray(ticketPanelChannel._messages)) {
      existingMsg = ticketPanelChannel._messages.find(
        (m) => m?.embeds?.[0]?.data?.title === 'Support' || m?.embeds?.[0]?.title === 'Support'
      );
    }

    let isUpdate = false;
    let panelMessage = existingMsg;

    if (existingMsg && typeof existingMsg.edit === 'function') {
      try {
        await enqueueDiscordAction(
          () => existingMsg.edit({ embeds: [panelEmbed], components: [row] }),
          'action'
        );
        isUpdate = true;
      } catch {
        panelMessage = null;
      }
    }

    if (!isUpdate || !panelMessage) {
      panelMessage = await queueChannelSend(ticketPanelChannel, {
        embeds: [panelEmbed],
        components: [row],
      });
      if (panelMessage?.id) {
        await saveTicketPanel(guild.id, ticketPanelChannel.id, panelMessage.id);
      }
    }

    // 7. Ensure shared logging channels (ticket-log and staff-application-log) exist idempotently
    const ticketLogCh = await ensurePrivateLogChannel(
      guild,
      savedChannels.ticketLogId,
      'ticket-log',
      'Private MatchDistrict Ticket Event Logs (Opened, Closed, Deleted, Errors)'
    );
    const staffAppLogCh = await ensurePrivateLogChannel(
      guild,
      savedChannels.staffAppLogId,
      'staff-application-log',
      'Private MatchDistrict Staff Application Logs (Applications & Statuses)'
    );

    // Save channels to guildSettings
    guildSettingsCache[guild.id] = {
      ...currentSettings,
      channels: {
        ...savedChannels,
        supportTicketId: ticketPanelChannel.id,
        ...(ticketLogCh ? { ticketLogId: ticketLogCh.id } : {}),
        ...(staffAppLogCh ? { staffAppLogId: staffAppLogCh.id } : {}),
      },
    };
    saveGuildSettings(guildSettingsCache);

    if (isUpdate) {
      await replyFn(
        `ℹ️ **Support ticket panel is already configured and was updated in place in <#${ticketPanelChannel.id}>.**`
      );
    } else {
      await replyFn(
        `✅ **Support ticket panel created successfully in <#${ticketPanelChannel.id}>.**`
      );
    }
  } catch (err) {
    console.error('[Ticket Service] ❌ Error in handleTicketSetupCommand:', err);
    await replyFn(`❌ **Error setting up ticket panel:** ${err.message}`);
  } finally {
    ticketSetupInProgress.delete(guild.id);
  }
}

/**
 * Global interaction handler for all ticket-related interactions:
 * - Category select menu (General Support vs Apply as Staff)
 * - Staff application modal submit
 * - Staff roles multi-select menu
 * - Close Ticket & confirmation buttons
 */
export async function handleTicketInteraction(interaction) {
  const customId = interaction.customId || '';
  if (!customId.startsWith('ticket:')) {
    return false;
  }

  const { guild, user, member } = interaction;
  if (!guild) return false;

  // ---------------------------------------------------------
  // 1. SELECT MENU: CATEGORY SELECTION
  // ---------------------------------------------------------
  if (interaction.isStringSelectMenu() && customId === 'ticket:select_category') {
    const selectedValue = interaction.values?.[0];

    // Branch A: Apply as Staff -> Open Discord Native Modal immediately
    if (selectedValue === 'apply_staff') {
      try {
        const modal = buildStaffApplicationModal();
        await interaction.showModal(modal);
        return true;
      } catch (modalErr) {
        console.error('[Ticket Service] ❌ Error showing staff modal:', modalErr);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: `❌ Could not open application form: ${modalErr.message}`,
            ephemeral: true,
          }).catch(() => {});
        }
        return true;
      }
    }

    // Branch B: General Support -> Create Support Ticket Channel
    await interaction.deferReply({ ephemeral: true });

    try {
      const selectedOption =
        TICKET_OPTIONS.find((opt) => opt.value === selectedValue) || { label: 'General Support' };

      // Ensure "SUPPORT TICKETS" category exists
      let category = Array.from(guild.channels.cache.values()).find(
        (c) => c.type === ChannelType.GuildCategory && c.name?.toUpperCase() === 'SUPPORT TICKETS'
      );

      if (!category) {
        category = await queueChannelCreate(guild, {
          name: 'SUPPORT TICKETS',
          type: ChannelType.GuildCategory,
          permissionOverwrites: [
            {
              id: guild.roles?.everyone?.id || guild.id,
              deny: [PermissionFlagsBits.ViewChannel],
            },
            {
              id: guild.members.me.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.ManageMessages,
              ],
            },
          ],
        });
      }

      // Ensure "Support Team" role exists
      let supportRole = Array.from(guild.roles.cache.values()).find(
        (r) => r.name?.toLowerCase() === 'support team'
      );

      if (!supportRole) {
        supportRole = await queueRoleCreate(guild, {
          name: 'Support Team',
          color: 0x3498DB,
          reason: 'Role for handling support tickets',
        });
      }

      // Fetch atomic incrementing ticket sequence from MongoDB
      const seq = await getNextTicketNumber(guild.id);
      const ticketNumber = String(seq).padStart(4, '0');
      const channelName = `${ticketNumber}-support`;

      const permissionOverwrites = [
        {
          id: guild.roles?.everyone?.id || guild.id, // @everyone
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: user.id, // Ticket opener
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks,
          ],
        },
        {
          id: guild.members.me.id, // Bot
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ManageMessages,
          ],
        },
      ];

      if (supportRole?.id) {
        permissionOverwrites.push({
          id: supportRole.id, // Support Team
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ManageMessages,
          ],
        });
      }

      // Create ticket channel via rate-limited queue
      const ticketChannel = await queueChannelCreate(guild, {
        name: channelName,
        type: ChannelType.GuildText,
        parent: category?.id,
        topic: `Ticket #${ticketNumber} | Creator: ${user.tag || user.username} (${user.id}) | Category: ${selectedOption.label}`,
        permissionOverwrites,
      });

      if (!ticketChannel) {
        await interaction.editReply({
          content: '❌ Failed to create your ticket channel. Please try again or contact a server administrator.',
        });
        await logTicketEvent(guild, 'ticket_error', {
          userId: user.id,
          action: 'Create Ticket Channel',
          error: 'Failed to create channel via Discord API',
        });
        return true;
      }

      // Save ticket in MongoDB
      await saveTicketToDb({
        guildId: guild.id,
        ticketNumber,
        channelId: ticketChannel.id,
        userId: user.id,
        optionChosen: selectedOption.label,
        status: 'open',
        createdAt: new Date(),
      });

      // Log ticket opened event to ticket-log
      await logTicketEvent(guild, 'ticket_opened', {
        ticketNumber,
        channelId: ticketChannel.id,
        channelName: ticketChannel.name,
        userId: user.id,
        optionChosen: selectedOption.label,
      });

      // Reply to user ephemerally with link to ticket channel
      await interaction.editReply({
        content: `✅ Your ticket has been created: <#${ticketChannel.id}>`,
      });

      // In ticket channel: welcome embed + Close Ticket button + Support ping
      const welcomeEmbed = new EmbedBuilder()
        .setTitle('Support')
        .setDescription(
          `Hello <@${user.id}>, thank you for reaching out!\nThe support team will help you soon.\n\n` +
          `**Category:** ${selectedOption.label}\n\n` +
          `To close this ticket, click the button below.`
        )
        .setColor(0x5865F2)
        .setTimestamp();

      const closeButton = new ButtonBuilder()
        .setCustomId('ticket:close')
        .setLabel('Close Ticket')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🔒');

      const actionRow = new ActionRowBuilder().addComponents(closeButton);

      const pingContent = supportRole
        ? `<@&${supportRole.id}> <@${user.id}>`
        : `<@${user.id}>`;

      await queueChannelSend(ticketChannel, {
        content: pingContent,
        embeds: [welcomeEmbed],
        components: [actionRow],
      });

      return true;
    } catch (err) {
      console.error('[Ticket Service] ❌ Error creating ticket:', err);
      await interaction.editReply({
        content: `❌ An error occurred while creating your ticket: ${err.message}`,
      }).catch(() => {});
      await logTicketEvent(guild, 'ticket_error', {
        userId: user.id,
        action: 'Create Ticket Channel',
        error: err.message,
      });
      return true;
    }
  }

  // ---------------------------------------------------------
  // 2. MODAL SUBMIT: STAFF APPLICATION FORM (STEP 1)
  // ---------------------------------------------------------
  const isModal = typeof interaction.isModalSubmit === 'function' ? interaction.isModalSubmit() : interaction.type === 5;
  if (isModal && customId === 'ticket:staff_modal') {
    try {
      const email = (
        typeof interaction.fields?.getTextInputValue === 'function'
          ? interaction.fields.getTextInputValue('staff_email')
          : interaction.fields?.staff_email || ''
      ).trim();

      const phone = (
        typeof interaction.fields?.getTextInputValue === 'function'
          ? interaction.fields.getTextInputValue('staff_phone')
          : interaction.fields?.staff_phone || ''
      ).trim();

      const motivation = (
        typeof interaction.fields?.getTextInputValue === 'function'
          ? interaction.fields.getTextInputValue('staff_motivation')
          : interaction.fields?.staff_motivation || ''
      ).trim();

      // Field validation: Email
      if (!isValidEmail(email)) {
        await interaction.reply({
          content: '❌ **Invalid Email Address:** Please enter a valid email format (e.g. `name@example.com`).',
          ephemeral: true,
        });
        return true;
      }

      // Field validation: Phone
      if (!isValidPhoneNumber(phone)) {
        await interaction.reply({
          content: '❌ **Invalid Contact Number:** Please enter a valid phone number (7 to 18 digits, country codes accepted, e.g. `+91 9876543210`).',
          ephemeral: true,
        });
        return true;
      }

      // Field validation: Motivation
      if (motivation.length < 10) {
        await interaction.reply({
          content: '❌ **Motivation Required:** Please provide at least 10 characters explaining why you want to join our staff team.',
          ephemeral: true,
        });
        return true;
      }

      // Store draft in memory
      const draftId = `draft_${guild.id}_${user.id}_${Date.now()}`;
      pendingStaffDrafts.set(draftId, {
        guildId: guild.id,
        userId: user.id,
        userTag: user.tag || user.username,
        email,
        phone,
        motivation,
        createdAt: Date.now(),
      });

      // Step 2: Multi-select role menu
      const roleMenu = new StringSelectMenuBuilder()
        .setCustomId(`ticket:staff_roles:${draftId}`)
        .setPlaceholder('What can you do? (Select one or more roles)')
        .setMinValues(1)
        .setMaxValues(STAFF_ROLES.length)
        .addOptions(
          STAFF_ROLES.map((r) => ({
            label: r.label,
            value: r.value,
            description: r.description,
            emoji: r.emoji,
          }))
        );

      const step2Embed = new EmbedBuilder()
        .setTitle('📋 Staff Application — Step 2: What can you do?')
        .setDescription(
          'Please select **one or more staff roles** you are applying for from the dropdown below to complete your application.\n\n' +
          '*(You may select multiple roles)*'
        )
        .setColor(0x5865F2)
        .setFooter({ text: 'MatchDistrict Staff Application' });

      await interaction.reply({
        embeds: [step2Embed],
        components: [new ActionRowBuilder().addComponents(roleMenu)],
        ephemeral: true,
      });

      return true;
    } catch (err) {
      console.error('[Ticket Service] ❌ Error handling staff modal submit:', err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: `❌ An error occurred processing your application: ${err.message}`,
          ephemeral: true,
        }).catch(() => {});
      }
      return true;
    }
  }

  // ---------------------------------------------------------
  // 3. SELECT MENU: STAFF ROLES SELECTION (STEP 2 SUBMISSION)
  // ---------------------------------------------------------
  if (interaction.isStringSelectMenu() && customId.startsWith('ticket:staff_roles:')) {
    const draftId = customId.replace('ticket:staff_roles:', '');
    const draft = pendingStaffDrafts.get(draftId);

    if (!draft) {
      if (typeof interaction.update === 'function') {
        await interaction.update({
          content: '❌ **Session Expired:** Your application draft has expired. Please start again from #support-ticket.',
          embeds: [],
          components: [],
        });
      }
      return true;
    }

    // Prevent duplicate concurrent submission
    if (activeStaffSubmissions.has(draft.userId)) {
      if (typeof interaction.update === 'function') {
        await interaction.update({
          content: '⏳ Your application is already being submitted. Please wait...',
          embeds: [],
          components: [],
        });
      }
      return true;
    }
    activeStaffSubmissions.add(draft.userId);

    try {
      const selectedRoles = interaction.values || [];
      if (selectedRoles.length === 0) {
        activeStaffSubmissions.delete(draft.userId);
        if (typeof interaction.update === 'function') {
          await interaction.update({
            content: '❌ Please select at least one role to submit your application.',
            embeds: [],
            components: [],
          });
        }
        return true;
      }

      const applicationId = `app_${guild.id}_${draft.userId}_${Date.now()}`;

      // 1. Save application to MongoDB
      await saveStaffApplicationToDb({
        applicationId,
        guildId: guild.id,
        userId: draft.userId,
        userTag: draft.userTag,
        email: draft.email,
        phone: draft.phone,
        motivation: draft.motivation,
        roles: selectedRoles,
        status: 'Pending',
        createdAt: new Date(),
      });

      // 2. Deliver to staff-application-log channel
      const staffLogChannel = await getStaffAppLogChannel(guild);
      if (staffLogChannel) {
        const appEmbed = new EmbedBuilder()
          .setTitle('📋 New Staff Application Received')
          .setColor(0xF1C40F) // Gold / Pending
          .addFields(
            {
              name: 'Applicant',
              value: `<@${draft.userId}>\n**Username:** ${draft.userTag}\n**ID:** \`${draft.userId}\``,
              inline: false,
            },
            { name: 'Email Address', value: `\`${draft.email}\``, inline: true },
            { name: 'Contact Number', value: `\`${draft.phone}\``, inline: true },
            { name: 'Selected Roles', value: selectedRoles.map((r) => `• **${r}**`).join('\n'), inline: false },
            { name: 'Why do you want to join our staff team?', value: draft.motivation, inline: false },
            { name: 'Application Status', value: '⏳ **Pending**', inline: true }
          )
          .setFooter({ text: `Application ID: ${applicationId} • MatchDistrict Staff` })
          .setTimestamp();

        await queueChannelSend(staffLogChannel, { embeds: [appEmbed] }).catch((err) => {
          console.warn('[Ticket Service] ⚠️ Could not send to staff-application-log:', err.message);
        });
      } else {
        console.warn(`[Ticket Service] ⚠️ No staff-application-log found in guild ${guild.id}`);
      }

      // 3. Acknowledge applicant privately
      if (typeof interaction.update === 'function') {
        await interaction.update({
          content:
            `✅ **Staff Application Submitted!**\n\n` +
            `Thank you, <@${draft.userId}>! Your application for **${selectedRoles.join(', ')}** has been received and is currently **Pending** manual review by the administration team.\n\n` +
            `*(Reference ID: \`${applicationId}\`)*`,
          embeds: [],
          components: [],
        });
      }

      // Cleanup
      pendingStaffDrafts.delete(draftId);
      return true;
    } catch (err) {
      console.error('[Ticket Service] ❌ Error saving staff application:', err);
      if (typeof interaction.update === 'function') {
        await interaction.update({
          content: `❌ **Failed to submit application:** ${err.message}. You can try again safely.`,
          embeds: [],
          components: [],
        }).catch(() => {});
      }
      return true;
    } finally {
      activeStaffSubmissions.delete(draft.userId);
    }
  }

  // ---------------------------------------------------------
  // 4. BUTTON: CLOSE TICKET (PROMPT CONFIRMATION)
  // ---------------------------------------------------------
  if (interaction.isButton() && customId === 'ticket:close') {
    try {
      const allowed = await canMemberCloseTicket(member, interaction.channelId, interaction.channel);

      if (!allowed) {
        await interaction.reply({
          content: '❌ Only the ticket creator or the Support Team can close this ticket.',
          ephemeral: true,
        });
        return true;
      }

      // Show confirmation with Confirm and Cancel buttons
      const confirmButton = new ButtonBuilder()
        .setCustomId('ticket:confirm_close')
        .setLabel('Close')
        .setStyle(ButtonStyle.Danger);

      const cancelButton = new ButtonBuilder()
        .setCustomId('ticket:cancel_close')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary);

      const row = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

      await interaction.reply({
        content: '⚠️ **Are you sure you want to close this ticket?**',
        components: [row],
        ephemeral: true,
      });

      return true;
    } catch (err) {
      console.error('[Ticket Service] ❌ Error prompting close confirmation:', err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: `❌ Error: ${err.message}`,
          ephemeral: true,
        }).catch(() => {});
      }
      return true;
    }
  }

  // ---------------------------------------------------------
  // 5. BUTTON: CONFIRM CLOSE
  // ---------------------------------------------------------
  if (interaction.isButton() && customId === 'ticket:confirm_close') {
    try {
      const allowed = await canMemberCloseTicket(member, interaction.channelId, interaction.channel);

      if (!allowed) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: '❌ Only the ticket creator or the Support Team can close this ticket.',
            ephemeral: true,
          });
        }
        return true;
      }

      const ticket = await getTicketFromDb(interaction.channelId);

      // 1. Mark ticket closed in MongoDB
      await updateTicketStatusInDb(interaction.channelId, 'closed');

      // 2. Log ticket closed event to ticket-log
      await logTicketEvent(guild, 'ticket_closed', {
        ticketNumber: ticket?.ticketNumber,
        channelId: interaction.channelId,
        channelName: interaction.channel?.name,
        closedBy: user.id,
        userId: ticket?.userId,
      });

      // 3. Acknowledge button interaction
      if (typeof interaction.update === 'function') {
        await interaction.update({
          content: '🔒 Ticket closing confirmed. Channel will be deleted shortly.',
          components: [],
        }).catch(() => {});
      }

      // 4. Tell the channel that the ticket is closing
      const chName = interaction.channel?.name;
      await queueChannelSend(interaction.channel, {
        content: `🔒 **Ticket closed by <@${user.id}>. This channel will be deleted in 5 seconds...**`,
      });

      // 5. Delete the channel after a few seconds (5 seconds)
      setTimeout(async () => {
        try {
          await queueChannelDelete(interaction.channel, `Ticket closed by ${user.tag}`);
          await logTicketEvent(guild, 'ticket_deleted', {
            ticketNumber: ticket?.ticketNumber,
            channelName: chName,
            userId: ticket?.userId,
            deletedBy: user.tag,
          });
        } catch (delErr) {
          console.warn('[Ticket Service] ⚠️ Error deleting ticket channel:', delErr.message);
        }
      }, 5000);

      return true;
    } catch (err) {
      console.error('[Ticket Service] ❌ Error confirming ticket close:', err);
      if (!interaction.replied && !interaction.deferred && typeof interaction.reply === 'function') {
        await interaction.reply({
          content: `❌ Failed to close ticket: ${err.message}`,
          ephemeral: true,
        }).catch(() => {});
      }
      return true;
    }
  }

  // ---------------------------------------------------------
  // 6. BUTTON: CANCEL CLOSE
  // ---------------------------------------------------------
  if (interaction.isButton() && customId === 'ticket:cancel_close') {
    if (typeof interaction.update === 'function') {
      await interaction.update({
        content: '❌ Ticket closure cancelled.',
        components: [],
      }).catch(() => {});
    }
    return true;
  }

  return false;
}
