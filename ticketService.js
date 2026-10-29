import {
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
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
} from './mongoService.js';

/**
 * Single configuration list for ticket category options.
 * Can be easily extended with more categories in the future.
 */
export const TICKET_OPTIONS = [
  {
    label: 'General Support',
    value: 'general_support',
    description: 'Get help with general inquiries or issues',
    emoji: '📩',
  },
];

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
 * Authorized if:
 * 1. They are the ticket's creator (verified via MongoDB or channel overwrites/topic fallback).
 * 2. They possess the "Support Team" role.
 * 3. They are a server administrator.
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
 * Handles the admin-only `.ticket setup` command.
 * Creates (or reuses) the "support-ticket" channel with read-only permissions for @everyone,
 * posts the Support ticket panel, and stores channel ID & message ID in MongoDB.
 *
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildMember} member
 * @param {import('discord.js').TextChannel} channel
 * @param {(msg: string|object) => Promise<any>} replyFn
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

  try {
    const channelOptions = {
      name: 'support-ticket',
      type: ChannelType.GuildText,
      topic: 'Official MatchDistrict Support Ticket Channel',
      permissionOverwrites: [
        {
          id: guild.id, // @everyone can read but not send messages
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

    // 3. Find or create the "support-ticket" channel
    let ticketPanelChannel = Array.from(guild.channels.cache.values()).find(
      (c) => c.name?.toLowerCase() === 'support-ticket' && (c.type === ChannelType.GuildText || c.type === 0)
    );

    if (!ticketPanelChannel) {
      ticketPanelChannel = await queueChannelCreate(guild, channelOptions);
    } else {
      // Reusing channel: ensure permission overwrites are updated
      await enqueueDiscordAction(
        () => ticketPanelChannel.permissionOverwrites.set(channelOptions.permissionOverwrites),
        'action'
      ).catch(() => {});
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

    // 5. Build Select Menu from configuration list
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('ticket:select_category')
      .setPlaceholder('Make a selection')
      .addOptions(
        TICKET_OPTIONS.map((opt) => ({
          label: opt.label,
          value: opt.value,
          description: opt.description || undefined,
          emoji: opt.emoji || undefined,
        }))
      );

    const row = new ActionRowBuilder().addComponents(selectMenu);

    // 6. Post panel into #support-ticket
    const panelMessage = await queueChannelSend(ticketPanelChannel, {
      embeds: [panelEmbed],
      components: [row],
    });

    if (panelMessage?.id) {
      // 7. Store channel ID and panel message ID in MongoDB
      await saveTicketPanel(guild.id, ticketPanelChannel.id, panelMessage.id);
    }

    await replyFn(`✅ **Support ticket panel created successfully in <#${ticketPanelChannel.id}>.**`);
  } catch (err) {
    console.error('[Ticket Service] ❌ Error in handleTicketSetupCommand:', err);
    await replyFn(`❌ **Error setting up ticket panel:** ${err.message}`);
  }
}

/**
 * Global interaction handler for all ticket-related select menus and buttons.
 * Fixed custom IDs ensure full reliability across bot restarts.
 *
 * @param {import('discord.js').Interaction} interaction
 * @returns {Promise<boolean>} True if handled, false otherwise
 */
export async function handleTicketInteraction(interaction) {
  const customId = interaction.customId || '';
  if (!customId.startsWith('ticket:')) {
    return false;
  }

  const { guild, user, member } = interaction;
  if (!guild) return false;

  // ---------------------------------------------------------
  // 1. SELECT MENU: CREATE TICKET
  // ---------------------------------------------------------
  if (interaction.isStringSelectMenu() && customId === 'ticket:select_category') {
    // Acknowledge immediately (ephemeral)
    await interaction.deferReply({ ephemeral: true });

    try {
      const selectedValue = interaction.values[0];
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
              id: guild.id,
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

      // Permissions:
      // @everyone cannot view.
      // User can View Channel, Send Messages, Read Message History, and Attach Files.
      // Support Team role can view and manage all ticket channels.
      // Bot has full access.
      const permissionOverwrites = [
        {
          id: guild.id, // @everyone
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
        topic: `Ticket #${ticketNumber} | Creator: ${user.tag} (${user.id}) | Category: ${selectedOption.label}`,
        permissionOverwrites,
      });

      if (!ticketChannel) {
        await interaction.editReply({
          content: '❌ Failed to create your ticket channel. Please try again or contact a server administrator.',
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

      // Reply to the user (visible only to them) with a link to their new ticket channel
      await interaction.editReply({
        content: `✅ Your ticket has been created: <#${ticketChannel.id}>`,
      });

      // In the new channel: welcome embed with user mention + red "Close Ticket" button + Support Team ping
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
      return true;
    }
  }

  // ---------------------------------------------------------
  // 2. BUTTON: CLOSE TICKET (PROMPT CONFIRMATION)
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
  // 3. BUTTON: CONFIRM CLOSE
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

      // 1. Mark ticket closed in MongoDB
      await updateTicketStatusInDb(interaction.channelId, 'closed');

      // 2. Acknowledge button interaction
      if (typeof interaction.update === 'function') {
        await interaction.update({
          content: '🔒 Ticket closing confirmed. Channel will be deleted shortly.',
          components: [],
        }).catch(() => {});
      }

      // 3. Tell the channel that the ticket is closing
      await queueChannelSend(interaction.channel, {
        content: `🔒 **Ticket closed by <@${user.id}>. This channel will be deleted in 5 seconds...**`,
      });

      // 4. Delete the channel after a few seconds (5 seconds)
      setTimeout(async () => {
        try {
          await queueChannelDelete(interaction.channel, `Ticket closed by ${user.tag}`);
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
  // 4. BUTTON: CANCEL CLOSE
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
