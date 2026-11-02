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
  queueChannelSend,
  enqueueDiscordAction,
} from './discordQueue.js';
import {
  saveTicketPanel,
  getTicketPanel,
  deleteTicketPanel,
  getTicketsForGuild,
  deleteOpenTicketsForGuild,
  deleteTicketFromDb,
  getNextTicketNumber,
  isMongoConnected,
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
const activeTicketConfirmations = new Set();
const ticketNumberReservations = new Map();

function buildTicketConfirmationRow(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:confirm_create').setLabel('Create Ticket').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId('ticket:confirm_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  );
}

function logTicketCreationStep(step, details = {}) {
  console.log(`[Ticket Creation] ${step} ${JSON.stringify(details)}`);
}
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
  return typeof phone === 'string' && /^\d{10}$/.test(phone);
}

function buildTicketPanelSelectRow() {
  const uniqueOptions = [];
  const seenValues = new Set();
  for (const option of TICKET_OPTIONS) {
    if (!seenValues.has(option.value)) {
      seenValues.add(option.value);
      uniqueOptions.push(option);
    }
  }
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('ticket:select_category')
      .setPlaceholder('Make a selection')
      .addOptions(uniqueOptions.map((option) => ({
        label: option.label,
        value: option.value,
        description: option.description || undefined,
        emoji: option.emoji || undefined,
      })))
  );
}

async function resetTicketPanelSelection(interaction) {
  if (!interaction.message?.edit) return;
  await interaction.message.edit({ components: [buildTicketPanelSelectRow()] }).catch((error) => {
    console.warn('[Ticket Service] Could not reset support panel selection:', error.message);
  });
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
    .setLabel('Contact Number (10 digits)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('9876543210')
    .setMinLength(10)
    .setMaxLength(10)
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
    // 3. Find the existing panel before resolving its category so moving the panel moves future tickets.
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

    const panelAlreadyHasCategory = Boolean(ticketPanelChannel?.parentId);
    let helpSupportCategory = panelAlreadyHasCategory
      ? guild.channels.cache.get(ticketPanelChannel.parentId) || await guild.channels.fetch(ticketPanelChannel.parentId).catch(() => null)
      : null;
    if (panelAlreadyHasCategory && !helpSupportCategory) {
      throw new Error(`Could not load the current category for #${ticketPanelChannel.name}; leaving the panel in place.`);
    }
    if (!panelAlreadyHasCategory) {
      helpSupportCategory = Array.from(guild.channels.cache.values()).find(
        (c) => c.type === ChannelType.GuildCategory && c.name?.toLowerCase() === 'help & support'
      );
      if (!helpSupportCategory) {
        helpSupportCategory = await queueChannelCreate(guild, {
          name: 'Help & Support',
          type: ChannelType.GuildCategory,
          permissionOverwrites: [{
            id: guild.members.me.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.ManageChannels,
              PermissionFlagsBits.ManageRoles,
            ],
          }],
        });
      }
      if (!helpSupportCategory) throw new Error('Could not create or find the Help & Support category.');
      if (ticketPanelChannel) {
        await enqueueDiscordAction(
          () => ticketPanelChannel.setParent(helpSupportCategory.id, { lockPermissions: false }),
          'action'
        );
      }
    }
    if (helpSupportCategory?.name?.toLowerCase() === 'help & support') {
      await enqueueDiscordAction(
        () => helpSupportCategory.permissionOverwrites.edit(guild.members.me.id, {
          ViewChannel: true,
          ManageChannels: true,
          ManageRoles: true,
        }),
        'action'
      );
    }

    const channelOptions = {
      name: 'support-ticket',
      type: ChannelType.GuildText,
      topic: 'Official MatchDistrict Support Ticket Channel',
      parent: helpSupportCategory?.id,
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
    }
    if (panelMessage?.id) {
      await saveTicketPanel(guild.id, ticketPanelChannel.id, panelMessage.id);
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

async function deleteTicketChannelWithRetries(channel, reason, source) {
  if (!channel) return true;
  const guild = channel.guild;
  const botMember = guild?.members?.me;
  const channelCanManage = Boolean(channel.permissionsFor?.(botMember)?.has(PermissionFlagsBits.ManageChannels));
  const parent = channel.parentId ? guild.channels.cache.get(channel.parentId) : null;
  const categoryCanManage = Boolean(parent?.permissionsFor?.(botMember)?.has(PermissionFlagsBits.ManageChannels));
  let verifiedChannelCanManage = channelCanManage;
  logTicketCreationStep('checking delete permissions', {
    source,
    channelId: channel.id,
    botId: botMember?.id || null,
    channelManageChannels: channelCanManage,
    categoryId: parent?.id || null,
    categoryManageChannels: categoryCanManage,
  });
  if (!verifiedChannelCanManage && botMember?.permissions?.has(PermissionFlagsBits.ManageChannels) && channel.permissionOverwrites?.edit) {
    try {
      logTicketCreationStep('repairing bot Manage Channels permission on ticket channel', { channelId: channel.id, botId: botMember.id });
      await channel.permissionOverwrites.edit(botMember.id, {
        ViewChannel: true,
        ManageChannels: true,
      });
      verifiedChannelCanManage = Boolean(channel.permissionsFor?.(botMember)?.has(PermissionFlagsBits.ManageChannels));
      logTicketCreationStep('ticket channel Manage Channels permission repair result', { channelId: channel.id, verified: verifiedChannelCanManage });
    } catch (error) {
      console.error(`[Ticket Service] Could not repair bot channel permissions for ${channel.id}:`, error);
    }
  }

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      logTicketCreationStep('deleting ticket channel through queue', { source, channelId: channel.id, attempt });
      await queueChannelDelete(channel, reason, { maxRetries: 0, rememberRateLimitOnExhaustion: true });
      logTicketCreationStep('ticket channel deleted', { source, channelId: channel.id, attempt });
      return true;
    } catch (error) {
      lastError = error;
      console.error(`[Ticket Service] Channel delete failed (${source}, attempt ${attempt}/3, channel ${channel.id}):`, error);
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  console.error(`[Ticket Service] Channel delete exhausted retries (${source}, channel ${channel.id}):`, lastError);
  return false;
}

export async function recoverTicketChannels(client) {
  if (!isMongoConnected()) {
    console.warn('[Ticket Recovery] MongoDB is unavailable; closed ticket recovery was skipped.');
    return;
  }
  for (const guild of client.guilds.cache.values()) {
    let tickets;
    try {
      tickets = await getTicketsForGuild(guild.id);
    } catch (error) {
      console.error(`[Ticket Recovery] Could not load tickets for guild ${guild.id}:`, error);
      continue;
    }
    for (const ticket of tickets) {
      let channel = guild.channels.cache.get(ticket.channelId);
      if (!channel) {
        try {
          channel = await guild.channels.fetch(ticket.channelId);
        } catch (error) {
          if (error?.code !== 10003) {
            console.error(`[Ticket Recovery] Could not check channel ${ticket.channelId}:`, error);
            continue;
          }
          channel = null;
        }
      }
      if (!channel) {
        try {
          await deleteTicketFromDb(ticket.channelId);
          console.log(`[Ticket Recovery] Removed MongoDB ticket record for missing channel ${ticket.channelId}.`);
        } catch (error) {
          console.error(`[Ticket Recovery] Could not remove missing-channel record ${ticket.channelId}:`, error);
        }
        continue;
      }
      if (String(ticket.status).toLowerCase() !== 'closed') continue;

      const deleted = await deleteTicketChannelWithRetries(channel, 'Recover closed ticket during startup', 'startup recovery');
      if (deleted) {
        try {
          await deleteTicketFromDb(ticket.channelId);
          await logTicketEvent(guild, 'ticket_deleted', {
            ticketNumber: ticket.ticketNumber,
            channelName: channel.name,
            userId: ticket.userId,
            deletedBy: 'startup recovery',
          });
        } catch (error) {
          console.error(`[Ticket Recovery] Could not finalize closed ticket ${ticket.channelId}:`, error);
        }
      }
    }
  }
}

export async function handleTicketDeleteCommand(guild, member, replyFn) {
  if (!guild) return replyFn('❌ This command can only be used inside a server.');
  if (!isMemberAdmin(member)) {
    return replyFn('❌ **Permission Denied:** Only server Administrators or members with `Manage Server` permission can run `.ticket delete`.');
  }
  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket:delete_confirm:${member.id}`).setLabel('Confirm').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ticket:delete_cancel:${member.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  return replyFn({
    content: '⚠️ **Remove the support ticket service?** This will delete the `#support-ticket` panel channel, all open ticket channels, and the `Help & Support` category only if it is empty. Ticket log channels and non-empty categories will remain.',
    components: [confirmRow],
  });
}

async function confirmTicketServiceDelete(interaction, action, expectedAdminId) {
  if (interaction.user.id !== expectedAdminId || !isMemberAdmin(interaction.member)) {
    await interaction.reply({ content: '❌ Only the administrator who started this removal can use these buttons.', ephemeral: true });
    return true;
  }
  if (action === 'cancel') {
    await interaction.update({ content: 'Ticket service removal cancelled.', components: [] });
    return true;
  }

  const { guild } = interaction;
  await interaction.update({ content: 'Removing the support ticket service…', components: [] });
  const summary = { panel: 0, openTickets: 0, category: 0, failures: 0 };
  try {
    if (!isMongoConnected()) throw new Error('MongoDB is unavailable; ticket setup records cannot be cleared.');
    const settings = getGuildSettings(guild.id) || {};
    const panelRecord = await getTicketPanel(guild.id);
    const panelChannelId = panelRecord?.channelId || settings.channels?.supportTicketId;
    let panelChannel = panelChannelId ? guild.channels.cache.get(panelChannelId) : null;
    if (panelChannelId && !panelChannel) {
      panelChannel = await guild.channels.fetch(panelChannelId).catch((error) => {
        if (error?.code !== 10003) throw error;
        return null;
      });
    }
    if (!panelChannel) {
      panelChannel = Array.from(guild.channels.cache.values()).find(
        (item) => item.name?.toLowerCase() === 'support-ticket' && item.type === ChannelType.GuildText
      ) || null;
    }
    const panelParent = panelChannel?.parentId ? guild.channels.cache.get(panelChannel.parentId) : null;

    const tickets = await getTicketsForGuild(guild.id);
    const openTickets = tickets.filter((ticket) => String(ticket.status).toLowerCase() === 'open');
    for (const ticket of openTickets) {
      let ticketChannel = guild.channels.cache.get(ticket.channelId);
      if (!ticketChannel) {
        ticketChannel = await guild.channels.fetch(ticket.channelId).catch((error) => {
          if (error?.code !== 10003) throw error;
          return null;
        });
      }
      if (!ticketChannel) continue;
      const deleted = await deleteTicketChannelWithRetries(ticketChannel, 'Remove support ticket service', 'ticket service removal');
      if (deleted) summary.openTickets += 1;
      else summary.failures += 1;
    }

    if (panelChannel) {
      const deleted = await deleteTicketChannelWithRetries(panelChannel, 'Remove support ticket panel', 'ticket service removal');
      if (deleted) summary.panel = 1;
      else summary.failures += 1;
    }

    let helpCategory = panelParent?.name?.toLowerCase() === 'help & support'
      ? panelParent
      : Array.from(guild.channels.cache.values()).find(
        (item) => item.type === ChannelType.GuildCategory && item.name?.toLowerCase() === 'help & support'
      );
    if (helpCategory) {
      const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
      const children = Array.from(channels.values()).filter((item) => item.parentId === helpCategory.id);
      if (children.length === 0) {
        const deleted = await deleteTicketChannelWithRetries(helpCategory, 'Remove empty Help & Support category', 'ticket service removal');
        if (deleted) summary.category = 1;
        else summary.failures += 1;
      }
    }

    await deleteTicketPanel(guild.id);
    await deleteOpenTicketsForGuild(guild.id);
    const updatedSettings = { ...settings, channels: { ...(settings.channels || {}) } };
    delete updatedSettings.channels.supportTicketId;
    guildSettingsCache[guild.id] = updatedSettings;
    saveGuildSettings(guildSettingsCache);

    const result = `✅ Ticket service removal finished: deleted ${summary.panel} panel channel, ${summary.openTickets} open ticket channel(s), and ${summary.category} empty Help & Support category. ${summary.failures ? `${summary.failures} channel deletion(s) failed; check the bot logs.` : ''}`;
    await interaction.editReply({ content: result, components: [] });
  } catch (error) {
    console.error('[Ticket Service] Ticket service removal failed:', error);
    await interaction.editReply({ content: `❌ Ticket service removal failed: ${error.message}`, components: [] }).catch(() => {});
  }
  return true;
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

  const deleteServiceMatch = customId.match(/^ticket:delete_(confirm|cancel):([^:]+)$/);
  if (deleteServiceMatch) {
    return confirmTicketServiceDelete(interaction, deleteServiceMatch[1], deleteServiceMatch[2]);
  }

  if (interaction.isButton?.() && customId === 'ticket:confirm_cancel') {
    await interaction.update({ content: 'Cancelled', embeds: [], components: [] });
    return true;
  }

  if (interaction.isButton?.() && customId === 'ticket:confirm_create') {
    const confirmationKey = `${guild.id}:${interaction.message?.id || interaction.id}`;
    if (activeTicketConfirmations.has(confirmationKey)) {
      await interaction.reply({ content: 'Your ticket is already being created.', ephemeral: true }).catch(() => {});
      return true;
    }
    activeTicketConfirmations.add(confirmationKey);
    const disabledRow = buildTicketConfirmationRow(true);
    const deadline = Date.now() + 30_000;
    let timedOut = false;
    let timeoutId;
    let activeCreatedChannel = null;
    let creationTask = null;
    const timeoutPromise = new Promise((resolve) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        logTicketCreationStep('creation timed out', { guildId: guild.id, userId: user.id, timeoutMs: 30_000 });
        const timeoutResponse = {
          content: '❌ Ticket creation timed out. Please try again. If a channel was created, it will be cleaned up.',
          components: [buildTicketConfirmationRow(false)],
        };
        interaction.editReply(timeoutResponse).catch(async (error) => {
          console.error('[Ticket Creation] Could not update timed-out confirmation:', error);
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ ...timeoutResponse, ephemeral: true }).catch(() => {});
          }
        });
        if (activeCreatedChannel) {
          activeCreatedChannel.delete('Ticket creation timed out').catch((error) => {
            console.error('[Ticket Creation] Timed-out channel cleanup failed:', error);
          });
          deleteTicketFromDb(activeCreatedChannel.id).catch((error) => {
            console.error('[Ticket Creation] Timed-out MongoDB cleanup failed:', error);
          });
        }
        resolve();
      }, 30_000);
    });
    try {
      await Promise.race([
        interaction.update({ content: 'Creating your support ticket…', components: [disabledRow] }),
        timeoutPromise,
      ]);
      if (timedOut) return true;
      logTicketCreationStep('confirmation acknowledged', { guildId: guild.id, userId: user.id, interactionId: interaction.id });
      const confirmedSelection = {
        guild,
        user,
        member,
        customId: 'ticket:select_category',
        values: ['general_support'],
        ticketConfirmed: true,
        ticketDeadline: deadline,
        ticketReservationKey: confirmationKey,
        setCreatedTicketChannel: (channel) => { activeCreatedChannel = channel; },
        isTicketCreationTimedOut: () => timedOut || Date.now() >= deadline,
        isStringSelectMenu: () => true,
        deferReply: async () => {},
        editReply: (payload) => {
          if (timedOut) return Promise.resolve(null);
          return interaction.editReply(payload);
        },
        reply: (payload) => interaction.followUp(payload),
      };
      creationTask = handleTicketInteraction(confirmedSelection);
      creationTask.catch((error) => console.error('[Ticket Creation] Unhandled creation task error:', error));
      await Promise.race([creationTask, timeoutPromise]);
    } catch (error) {
      console.error('[Ticket Service] ❌ Error confirming support ticket:', error);
      const failureResponse = {
        content: `❌ Could not create your ticket: ${error.message || 'Please try again.'}`,
        components: [buildTicketConfirmationRow(false)],
      };
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(failureResponse).catch(() => {});
      } else {
        await interaction.reply({ ...failureResponse, ephemeral: true }).catch(() => {});
      }
    } finally {
      clearTimeout(timeoutId);
      if (timedOut && creationTask) {
        creationTask.then(
          () => activeTicketConfirmations.delete(confirmationKey),
          () => activeTicketConfirmations.delete(confirmationKey),
        );
      } else {
        activeTicketConfirmations.delete(confirmationKey);
      }
    }
    return true;
  }

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
        await resetTicketPanelSelection(interaction);
        return true;
      } catch (modalErr) {
        console.error('[Ticket Service] ❌ Error showing staff modal:', modalErr);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: `❌ Could not open application form: ${modalErr.message}`,
            ephemeral: true,
          }).catch(() => {});
        }
        await resetTicketPanelSelection(interaction);
        return true;
      }
    }

    if (selectedValue === 'general_support' && interaction.ticketConfirmed !== true) {
      const confirmationRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket:confirm_create').setLabel('Create Ticket').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('ticket:confirm_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      );
      await interaction.reply({ content: 'Do you want to create a support ticket?', components: [confirmationRow], ephemeral: true });
      await resetTicketPanelSelection(interaction);
      return true;
    }

    // Branch B: General Support -> Create Support Ticket Channel
    if (!interaction.ticketConfirmed) await interaction.deferReply({ ephemeral: true });

    let ticketChannel = null;
    let savedTicket = false;
    const ticketReservationKey = interaction.ticketReservationKey || `${guild.id}:${interaction.id || Date.now()}`;
    try {
      const ensureCreationActive = async () => {
        if (!interaction.isTicketCreationTimedOut?.()) return;
        throw new Error('Ticket creation exceeded 30 seconds. The ticket channel will be cleaned up.');
      };
      logTicketCreationStep('creation started', { guildId: guild.id, userId: user.id });
      const selectedOption =
        TICKET_OPTIONS.find((opt) => opt.value === selectedValue) || { label: 'General Support' };
      const botMember = guild.members.me || await guild.members.fetchMe();

      const panelRecord = await getTicketPanel(guild.id);
      const panelChannelId = panelRecord?.channelId || getGuildSettings(guild.id)?.channels?.supportTicketId;
      const panelChannel = panelChannelId
        ? guild.channels.cache.get(panelChannelId) || await guild.channels.fetch(panelChannelId).catch(() => null)
        : null;
      if (!panelChannel?.parentId) {
        throw new Error('The support-ticket panel has no category. Run `.ticket setup` before creating a ticket.');
      }
      const category = guild.channels.cache.get(panelChannel.parentId) || await guild.channels.fetch(panelChannel.parentId).catch(() => null);
      if (!category || category.type !== ChannelType.GuildCategory) {
        throw new Error('Could not find the category containing the support-ticket panel.');
      }
      logTicketCreationStep('using support panel category for ticket', { panelChannelId: panelChannel.id, categoryId: category.id, categoryName: category.name });
      await ensureCreationActive();

      // Keep the Help & Support category manageable while leaving other existing categories unchanged.
      logTicketCreationStep('checking bot category permissions', { categoryId: category.id, botId: botMember.id });
      if (category.name?.toLowerCase() === 'help & support') {
        await category.permissionOverwrites.edit(botMember.id, {
          ViewChannel: true,
          ManageChannels: true,
          ManageRoles: true,
        });
        await ensureCreationActive();
      }
      const categoryPermissions = category.permissionsFor(botMember);
      if (!categoryPermissions?.has(PermissionFlagsBits.ViewChannel)) {
        throw new Error('The bot needs View Channel access to the category containing the support-ticket panel.');
      }
      logTicketCreationStep('bot category permissions verified', { categoryId: category.id });

      // Ensure "Support Team" role exists
      const guildSettings = getGuildSettings(guild.id) || {};
      const storedSupportRoleId = guildSettings.supportTeamRoleId || guildSettings.supportRoleId;
      logTicketCreationStep('looking up Support Team role', { guildId: guild.id, storedRoleId: storedSupportRoleId || null });
      let supportRole = storedSupportRoleId ? guild.roles.cache.get(storedSupportRoleId) : null;
      if (storedSupportRoleId && !supportRole) {
        supportRole = await guild.roles.fetch(storedSupportRoleId).catch(() => null);
      }
      supportRole ||= Array.from(guild.roles.cache.values()).find(
        (r) => r.name?.toLowerCase() === 'support team'
      );

      if (!supportRole) {
        logTicketCreationStep('creating Support Team role', { guildId: guild.id });
        supportRole = await guild.roles.create({
          name: 'Support Team',
          color: 0x3498DB,
          reason: 'Role for handling support tickets',
        });
      }
      if (!supportRole?.id) throw new Error('The Support Team role could not be found or created.');
      logTicketCreationStep('Support Team role resolved', { roleId: supportRole.id, source: storedSupportRoleId ? 'stored-or-name' : 'name' });
      guildSettingsCache[guild.id] = { ...guildSettings, supportTeamRoleId: supportRole.id };
      saveGuildSettings(guildSettingsCache);
      await ensureCreationActive();

      // Fetch atomic incrementing ticket sequence from MongoDB
      let seq = ticketNumberReservations.get(ticketReservationKey);
      if (!seq) {
        logTicketCreationStep('reserving ticket number', { guildId: guild.id });
        seq = await getNextTicketNumber(guild.id);
        ticketNumberReservations.set(ticketReservationKey, seq);
      } else {
        logTicketCreationStep('reusing reserved ticket number', { guildId: guild.id, ticketNumber: seq });
      }
      const ticketNumber = String(seq).padStart(4, '0');
      const channelName = `${ticketNumber}-support`;
      await ensureCreationActive();

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
          id: botMember.id, // Bot
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ManageRoles,
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

      logTicketCreationStep('ticket permission overwrite plan', {
        everyoneId: guild.id,
        ticketUserId: user.id,
        supportRoleId: supportRole.id,
        botUserId: botMember.id,
        categoryId: category.id,
      });
      logTicketCreationStep('creating ticket channel', { guildId: guild.id, userId: user.id, channelName, categoryId: category.id });
      ticketChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: category?.id,
        topic: `Ticket #${ticketNumber} | Creator: ${user.tag || user.username} (${user.id}) | Category: ${selectedOption.label}`,
        permissionOverwrites,
      });
      interaction.setCreatedTicketChannel?.(ticketChannel);

      if (!ticketChannel) {
        logTicketCreationStep('channel creation returned no channel', { guildId: guild.id, channelName });
        await interaction.editReply({
          content: '❌ Failed to create your ticket channel. Please try again or contact a server administrator.',
          components: [buildTicketConfirmationRow(false)],
        });
        void logTicketEvent(guild, 'ticket_error', {
          userId: user.id,
          action: 'Create Ticket Channel',
          error: 'Failed to create channel via Discord API',
        }).catch((error) => console.error('[Ticket Creation] Ticket error log failed:', error));
        return true;
      }
      logTicketCreationStep('ticket channel created', { channelId: ticketChannel.id, channelName: ticketChannel.name, parentId: ticketChannel.parentId });
      await ensureCreationActive();

      if (ticketChannel.permissionsLocked) {
        logTicketCreationStep('channel permissions were synced; applying explicit ticket overwrites', { channelId: ticketChannel.id });
        await ticketChannel.permissionOverwrites.set(permissionOverwrites, 'Apply explicit private ticket access');
        await ensureCreationActive();
      }

      let userCanView = false;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const effectivePermissions = ticketChannel.permissionsFor(member);
        userCanView = Boolean(effectivePermissions?.has(PermissionFlagsBits.ViewChannel));
        logTicketCreationStep('checking ticket user access', { channelId: ticketChannel.id, userId: user.id, attempt, canView: userCanView });
        if (userCanView) break;
        logTicketCreationStep('repairing ticket user overwrite', { channelId: ticketChannel.id, userId: user.id, attempt });
        await ticketChannel.permissionOverwrites.edit(user.id, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
          AttachFiles: true,
        });
        await ensureCreationActive();
        userCanView = Boolean(ticketChannel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel));
        logTicketCreationStep('ticket user overwrite repair result', { channelId: ticketChannel.id, userId: user.id, attempt, canView: userCanView });
        if (userCanView) break;
      }
      if (!userCanView) {
        throw new Error('Discord did not grant you access to the new ticket channel. The channel will be removed; please try again.');
      }
      logTicketCreationStep('ticket user access verified', { channelId: ticketChannel.id, userId: user.id });
      await ensureCreationActive();

      // Save ticket in MongoDB
      if (!isMongoConnected()) throw new Error('Ticket storage is unavailable. Please try again shortly.');
      logTicketCreationStep('saving ticket to MongoDB', { ticketNumber, channelId: ticketChannel.id, userId: user.id });
      await saveTicketToDb({
        guildId: guild.id,
        ticketNumber,
        channelId: ticketChannel.id,
        userId: user.id,
        optionChosen: selectedOption.label,
        status: 'open',
        createdAt: new Date(),
      });
      savedTicket = true;
      logTicketCreationStep('ticket saved to MongoDB', { ticketNumber, channelId: ticketChannel.id });
      await ensureCreationActive();

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

      logTicketCreationStep('sending ticket welcome message', { channelId: ticketChannel.id, userId: user.id, supportRoleId: supportRole.id });
      await ticketChannel.send({
        content: pingContent,
        embeds: [welcomeEmbed],
        components: [actionRow],
      });
      logTicketCreationStep('ticket welcome message sent', { channelId: ticketChannel.id });
      await ensureCreationActive();

      logTicketCreationStep('replying with ticket link', { channelId: ticketChannel.id, userId: user.id });
      await interaction.editReply({
        content: `✅ Your ticket has been created: <#${ticketChannel.id}>`,
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel('Open Ticket').setStyle(ButtonStyle.Link).setURL(
            ticketChannel.url || `https://discord.com/channels/${guild.id}/${ticketChannel.id}`,
          ),
        )],
      });
      ticketNumberReservations.delete(ticketReservationKey);
      logTicketCreationStep('confirmation updated successfully', { channelId: ticketChannel.id, userId: user.id });
      void logTicketEvent(guild, 'ticket_opened', {
        ticketNumber,
        channelId: ticketChannel.id,
        channelName: ticketChannel.name,
        userId: user.id,
        optionChosen: selectedOption.label,
      }).catch((error) => console.error('[Ticket Creation] Ticket-opened log failed:', error));

      return true;
    } catch (err) {
      console.error('[Ticket Service] ❌ Error creating ticket:', err);
      await interaction.editReply({
        content: `❌ Could not create your ticket: ${err.message || 'Please try again or contact support.'}`,
        components: [buildTicketConfirmationRow(false)],
      }).catch(() => {});
      logTicketCreationStep('creation failed', { guildId: guild.id, userId: user.id, channelId: ticketChannel?.id || null, error: err?.stack || err?.message || String(err) });
      if (ticketChannel) {
        logTicketCreationStep('deleting failed ticket channel', { channelId: ticketChannel.id });
        await ticketChannel.delete('Remove incomplete ticket channel').catch((cleanupError) => {
          console.error('[Ticket Creation] Failed to clean up ticket channel:', cleanupError);
        });
      }
      if (savedTicket && ticketChannel) {
        await deleteTicketFromDb(ticketChannel.id).catch((cleanupError) => {
          console.error('[Ticket Creation] Failed to remove ticket record during cleanup:', cleanupError);
        });
      }
      void logTicketEvent(guild, 'ticket_error', {
        userId: user.id,
        action: 'Create Ticket Channel',
        error: err.message,
      }).catch((logError) => console.error('[Ticket Creation] Ticket error log failed:', logError));
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
      );

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
          content: '❌ **Invalid Contact Number:** Enter exactly 10 digits with no country code, spaces, symbols, or letters.',
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
      const updated = await updateTicketStatusInDb(interaction.channelId, 'closed');
      if (!updated) throw new Error('Ticket status could not be saved to MongoDB.');

      // 3. Acknowledge button interaction
      if (typeof interaction.update === 'function') {
        await interaction.update({
          content: '🔒 Ticket closed. This channel will be deleted in 5 seconds.',
          components: [],
        }).catch((error) => console.error('[Ticket Service] Could not update close confirmation; continuing deletion:', error));
      }

      // 4. Tell the channel it will be deleted, then wait before deleting.
      const chName = interaction.channel?.name;
      try {
        await queueChannelSend(interaction.channel, {
          content: 'Ticket closed. This channel will be deleted in 5 seconds.',
        });
      } catch (sendError) {
        console.error('[Ticket Service] Could not send the ticket-closed notice:', sendError);
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));

      const deleted = await deleteTicketChannelWithRetries(
        interaction.channel,
        `Ticket closed by ${user.tag || user.id}`,
        'confirmed close',
      );
      if (!deleted) {
        await interaction.followUp({
          content: '❌ The ticket was marked closed, but Discord did not allow the channel deletion. The bot will retry on its next startup.',
          ephemeral: true,
        }).catch((error) => console.error('[Ticket Service] Could not report ticket deletion failure:', error));
        return true;
      }

      await deleteTicketFromDb(interaction.channelId);
      void logTicketEvent(guild, 'ticket_closed', {
        ticketNumber: ticket?.ticketNumber,
        channelId: interaction.channelId,
        channelName: chName,
        closedBy: user.id,
        userId: ticket?.userId,
      }).catch((error) => console.error('[Ticket Service] Closed-ticket log failed:', error));
      void logTicketEvent(guild, 'ticket_deleted', {
        ticketNumber: ticket?.ticketNumber,
        channelName: chName,
        userId: ticket?.userId,
        deletedBy: user.tag || user.id,
      }).catch((error) => console.error('[Ticket Service] Deleted-ticket log failed:', error));

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
