// matchdistrict-manager-discord-bot/bulkRoleService.js
/**
 * Bulk Role Assignment Service (.add role)
 *
 * Provides an interactive Discord workflow for administrators to safely bulk-assign
 * server roles to either selected members or all eligible server members.
 *
 * Workflow:
 * .add role -> Select Role (String Select Menu with 25-item pagination)
 *           -> Select Users (User Select Menu: multi-select or leave empty for All)
 *           -> Confirmation review (Target count, skipped count, Confirm / Cancel)
 *           -> Bulk Assignment execution (Rate-limited, skipping bots and members with role)
 *           -> Completion summary (Success, failure, skipped counts)
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} from 'discord.js';
import crypto from 'crypto';
import { queueRoleAdd } from './discordQueue.js';

export const BULK_ROLE_PREFIX = 'bulk_role:';
export const ROLES_PER_PAGE = 25;
const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes

// In-memory active wizard sessions: sessionId -> SessionData
export const activeBulkRoleSessions = new Map();

/**
 * Checks if a session has timed out.
 */
function cleanExpiredSessions() {
  const now = Date.now();
  for (const [id, session] of activeBulkRoleSessions.entries()) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      activeBulkRoleSessions.delete(id);
    }
  }
}

/**
 * Verifies whether the member has permission to use .add role (Administrator or Manage Roles).
 */
export function canMemberManageRoles(member, guild) {
  if (!member) return false;
  if (guild && guild.ownerId === member.id) return true;
  if (!member.permissions) return false;
  return (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageRoles)
  );
}

/**
 * Verifies whether the bot has permission to assign roles in the guild.
 */
export function canBotAssignRoles(guild) {
  if (!guild || !guild.members?.me) return false;
  const botMember = guild.members.me;
  if (!botMember.permissions) return false;
  return (
    botMember.permissions.has(PermissionFlagsBits.Administrator) ||
    botMember.permissions.has(PermissionFlagsBits.ManageRoles)
  );
}

/**
 * Returns all roles in the guild that can be assigned by the bot and the executing admin,
 * sorted descending by role hierarchy position.
 */
export function getAssignableRoles(guild, member = null) {
  if (!guild || !guild.roles?.cache) return [];

  const botMember = guild.members?.me;
  const botHighest = botMember?.roles?.highest?.position ?? -1;
  const memberHighest = (member && guild.ownerId !== member.id)
    ? (member.roles?.highest?.position ?? -1)
    : Infinity;

  const roles = Array.from(guild.roles.cache.values()).filter((role) => {
    // 1. Cannot assign @everyone
    if (role.id === guild.id) return false;
    // 2. Cannot assign bot-managed / integration roles
    if (role.managed) return false;
    // 3. Must be strictly below bot's highest role
    if (role.position >= botHighest) return false;
    // 4. Must be strictly below executor's highest role (unless server owner)
    if (role.position >= memberHighest) return false;
    return true;
  });

  // Sort descending by position (highest hierarchy first)
  return roles.sort((a, b) => b.position - a.position);
}

/**
 * Builds the Step 1 payload: String Select Menu with assignable roles (paginated if > 25).
 */
export function buildRoleSelectPayload(session, assignableRoles) {
  const totalRoles = assignableRoles.length;
  const totalPages = Math.max(1, Math.ceil(totalRoles / ROLES_PER_PAGE));
  const currentPage = Math.min(Math.max(0, session.page || 0), totalPages - 1);
  session.page = currentPage;

  const startIdx = currentPage * ROLES_PER_PAGE;
  const pageRoles = assignableRoles.slice(startIdx, startIdx + ROLES_PER_PAGE);

  const embed = new EmbedBuilder()
    .setTitle('🏷️ Bulk Role Assignment — Step 1: Select Role')
    .setColor(0xF97316)
    .setDescription(
      `Select the role you want to assign to server members using the dropdown menu below.\n\n` +
      `**Assignable Roles Found:** ${totalRoles}\n` +
      (totalPages > 1 ? `**Showing:** Page ${currentPage + 1} of ${totalPages} (${pageRoles.length} roles on this page)\n` : '') +
      `\n*Only roles positioned below the bot's highest role and your highest role are shown.*`
    )
    .setFooter({
      text: totalPages > 1
        ? `Page ${currentPage + 1} of ${totalPages} • Match District Role Manager`
        : 'Match District Role Manager'
    })
    .setTimestamp();

  // 1. Role Select Menu
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`${BULK_ROLE_PREFIX}select_role:${session.id}`)
    .setPlaceholder(
      totalPages > 1
        ? `Choose a role to assign (Page ${currentPage + 1}/${totalPages})...`
        : 'Choose a role to assign...'
    )
    .setMinValues(1)
    .setMaxValues(1);

  pageRoles.forEach((r) => {
    const memberCount = r.members?.size ?? 0;
    selectMenu.addOptions({
      label: (r.name || 'Unnamed Role').slice(0, 100),
      value: r.id,
      description: `${memberCount} current member${memberCount === 1 ? '' : 's'} • Pos ${r.position}`.slice(0, 100),
    });
  });

  const row1 = new ActionRowBuilder().addComponents(selectMenu);
  const rows = [row1];

  // 2. Pagination / Cancel Buttons
  const buttonsRow = new ActionRowBuilder();

  if (totalPages > 1) {
    buttonsRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`${BULK_ROLE_PREFIX}page_prev:${session.id}`)
        .setLabel('◀ Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage === 0),
      new ButtonBuilder()
        .setCustomId(`${BULK_ROLE_PREFIX}page_indicator:${session.id}`)
        .setLabel(`${currentPage + 1} / ${totalPages}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`${BULK_ROLE_PREFIX}page_next:${session.id}`)
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage >= totalPages - 1)
    );
  }

  buttonsRow.addComponents(
    new ButtonBuilder()
      .setCustomId(`${BULK_ROLE_PREFIX}cancel:${session.id}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger)
  );

  rows.push(buttonsRow);

  return { embeds: [embed], components: rows };
}

/**
 * Builds the Step 2 payload: User Selection Menu (multi-select) or All Members default.
 */
export function buildUserSelectPayload(session, role) {
  const selectedCount = session.selectedUserIds?.length || 0;
  const isAllMembers = selectedCount === 0;

  const embed = new EmbedBuilder()
    .setTitle('👥 Bulk Role Assignment — Step 2: Target Members')
    .setColor(0xF97316)
    .setDescription(
      `Role to Assign: **@${role.name}** (<@&${role.id}>)\n\n` +
      `**Choose specific members** using the user dropdown menu below (multi-select).\n` +
      `**Default behaviour:** If no specific members are selected, the role will be assigned to **ALL eligible members** of the server upon confirmation.`
    )
    .addFields(
      {
        name: '🎯 Current Target Selection',
        value: isAllMembers
          ? '🌐 **All Server Members** (Default: Every eligible member will receive this role)'
          : `👥 **${selectedCount} Specific Member${selectedCount === 1 ? '' : 's'} Selected:**\n${session.selectedUserIds.map((id) => `<@${id}>`).slice(0, 15).join(', ')}${selectedCount > 15 ? `\n...and ${selectedCount - 15} more` : ''}`,
        inline: false,
      },
      {
        name: '🛡️ Safety Guard',
        value: 'Bots and members who already have this role will be automatically skipped.',
        inline: false,
      }
    )
    .setFooter({ text: 'Match District Role Manager • Step 2 of 3' })
    .setTimestamp();

  // 1. User Select Menu (Multi-select)
  const userSelect = new UserSelectMenuBuilder()
    .setCustomId(`${BULK_ROLE_PREFIX}select_users:${session.id}`)
    .setPlaceholder('Select specific members (leave empty for All Members)...')
    .setMinValues(1)
    .setMaxValues(25);

  const row1 = new ActionRowBuilder().addComponents(userSelect);

  // 2. Action Buttons (Change Role, Reset to All, Confirm, Cancel)
  const buttonsRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${BULK_ROLE_PREFIX}back_role:${session.id}`)
      .setLabel('⬅ Change Role')
      .setStyle(ButtonStyle.Secondary)
  );

  if (!isAllMembers) {
    buttonsRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`${BULK_ROLE_PREFIX}reset_all:${session.id}`)
        .setLabel('🌐 Reset to All Members')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  buttonsRow.addComponents(
    new ButtonBuilder()
      .setCustomId(`${BULK_ROLE_PREFIX}confirm:${session.id}`)
      .setLabel(isAllMembers ? 'Confirm for All Members ▶' : `Confirm for ${selectedCount} Member${selectedCount === 1 ? '' : 's'} ▶`)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${BULK_ROLE_PREFIX}cancel:${session.id}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [row1, buttonsRow] };
}

/**
 * Builds the Step 3 Confirmation payload before bulk execution.
 */
export function buildConfirmationPayload(session, role, targetMembers, alreadyHasRoleCount, botCount) {
  const isAllMembers = (session.selectedUserIds?.length || 0) === 0;
  const eligibleCount = targetMembers.length;

  if (eligibleCount === 0) {
    const embed = new EmbedBuilder()
      .setTitle('ℹ️ No Role Assignments Needed')
      .setColor(0x3B82F6)
      .setDescription(
        `All checked members in the target scope already possess the **@${role.name}** role or are bots.\n\n` +
        `• **Target Scope:** ${isAllMembers ? 'All Server Members' : `${session.selectedUserIds.length} Selected Members`}\n` +
        `• **Already have role:** ${alreadyHasRoleCount}\n` +
        `• **Bots skipped:** ${botCount}\n\n` +
        `No new role assignments are required.`
      )
      .setFooter({ text: 'Match District Role Manager' })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${BULK_ROLE_PREFIX}back_users:${session.id}`)
        .setLabel('⬅ Back to Selection')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`${BULK_ROLE_PREFIX}cancel:${session.id}`)
        .setLabel('Close')
        .setStyle(ButtonStyle.Danger)
    );

    return { embeds: [embed], components: [row], eligibleCount: 0 };
  }

  const embed = new EmbedBuilder()
    .setTitle('⚠️ Confirm Bulk Role Assignment')
    .setColor(0xF59E0B)
    .setDescription(
      `Please review the details below before starting the bulk assignment.\n` +
      `Once confirmed, the bot will safely assign the role respecting Discord rate limits.`
    )
    .addFields(
      {
        name: '🏷️ Role to Assign',
        value: `<@&${role.id}> (\`${role.name}\`)`,
        inline: true,
      },
      {
        name: '🎯 Target Scope',
        value: isAllMembers ? '🌐 **Entire Server** (All Members)' : `🎯 **${session.selectedUserIds.length} Selected Members**`,
        inline: true,
      },
      {
        name: '👥 Members to Receive Role',
        value: `**${eligibleCount}** member${eligibleCount === 1 ? '' : 's'}`,
        inline: true,
      },
      {
        name: '⏭️ Automatically Skipped',
        value: `• **${alreadyHasRoleCount}** already have this role\n• **${botCount}** bots excluded`,
        inline: false,
      }
    )
    .setFooter({ text: 'Click "Start Assignment" to proceed or "Cancel" to abort.' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${BULK_ROLE_PREFIX}execute:${session.id}`)
      .setLabel(`🚀 Start Assignment (${eligibleCount} users)`)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${BULK_ROLE_PREFIX}back_users:${session.id}`)
      .setLabel('⬅ Back')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${BULK_ROLE_PREFIX}cancel:${session.id}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [row], eligibleCount };
}

/**
 * Resolves the target member objects from the guild, filtering out bots and members who already have the role.
 */
export async function resolveTargetMembers(guild, role, selectedUserIds = []) {
  if (!guild || !role) {
    return { targetMembers: [], alreadyHasRoleCount: 0, botCount: 0 };
  }

  let candidates = [];
  if (selectedUserIds && selectedUserIds.length > 0) {
    // Selected members only
    for (const uid of selectedUserIds) {
      let m = guild.members.cache.get(uid);
      if (!m) {
        m = await guild.members.fetch(uid).catch(() => null);
      }
      if (m) candidates.push(m);
    }
  } else {
    // All guild members
    const allMembers = await guild.members.fetch().catch(() => guild.members.cache);
    candidates = Array.from(allMembers.values());
  }

  const targetMembers = [];
  let alreadyHasRoleCount = 0;
  let botCount = 0;

  for (const member of candidates) {
    // Skip bots
    if (member.user?.bot) {
      botCount++;
      continue;
    }
    // Skip members who already have the role
    if (member.roles?.cache?.has(role.id)) {
      alreadyHasRoleCount++;
      continue;
    }
    targetMembers.push(member);
  }

  return { targetMembers, alreadyHasRoleCount, botCount };
}

/**
 * Safely executes bulk role assignment across target members with rate-limiting and progress tracking.
 */
export async function executeBulkRoleAssignment(guild, role, targetMembers, onProgress = null) {
  let successCount = 0;
  let failureCount = 0;
  const total = targetMembers.length;

  for (let i = 0; i < total; i++) {
    const member = targetMembers[i];
    try {
      const added = await queueRoleAdd(member, role.id, `Bulk role assignment via .add role`);
      if (added !== false) {
        successCount++;
      } else {
        // already had role or skipped
        successCount++;
      }
    } catch (err) {
      failureCount++;
      console.warn(`[Bulk Role] Failed to add role ${role.name} to member ${member?.id}:`, err?.message || err);
    }

    // Call progress callback periodically (every 10 members or at completion)
    if (onProgress && ((i + 1) % 10 === 0 || i === total - 1)) {
      try {
        await onProgress({
          current: i + 1,
          total,
          successCount,
          failureCount,
        });
      } catch {
        // Ignore progress update failures
      }
    }
  }

  return {
    total,
    successCount,
    failureCount,
  };
}

/**
 * Primary command handler: called when admin invokes `.add role`.
 */
export async function handleBulkRoleCommand(guild, member, channel, args, replyFn, client = null, message = null) {
  cleanExpiredSessions();

  if (!guild || !channel) {
    return replyFn('❌ This command can only be used inside a Discord server text channel.');
  }

  // 1. Check user permissions
  if (!canMemberManageRoles(member, guild)) {
    return replyFn('❌ You need **Administrator** or **Manage Roles** permission to use this command.');
  }

  // 2. Check bot permissions
  if (!canBotAssignRoles(guild)) {
    return replyFn('❌ I do not have the **Manage Roles** permission in this server. Please grant me this permission in Server Settings.');
  }

  // 3. Retrieve assignable roles
  const assignableRoles = getAssignableRoles(guild, member);
  if (assignableRoles.length === 0) {
    return replyFn(
      '❌ No assignable roles found.\n' +
      'Ensure the bot\'s highest role is positioned above the roles you want to assign, and that the roles are not bot-managed.'
    );
  }

  // 4. Create new wizard session
  const sessionId = crypto.randomBytes(6).toString('hex');
  const session = {
    id: sessionId,
    guildId: guild.id,
    userId: member.id,
    channelId: channel.id,
    createdAt: Date.now(),
    roleId: null,
    roleName: null,
    selectedUserIds: [], // Empty array = all server members
    page: 0,
  };

  activeBulkRoleSessions.set(sessionId, session);

  // 5. Send Step 1: Role Selection Screen
  const payload = buildRoleSelectPayload(session, assignableRoles);
  return replyFn(payload);
}

/**
 * Central Interaction Handler for all `bulk_role:` customId events.
 * Returns true if handled, false otherwise.
 */
export async function handleBulkRoleInteraction(interaction) {
  if (!interaction || !interaction.customId || !interaction.customId.startsWith(BULK_ROLE_PREFIX)) {
    return false;
  }

  cleanExpiredSessions();

  const customId = interaction.customId;
  const parts = customId.slice(BULK_ROLE_PREFIX.length).split(':');
  const action = parts[0];
  const sessionId = parts[1];

  const session = activeBulkRoleSessions.get(sessionId);
  if (!session) {
    await interaction.reply({
      content: '⚠️ This bulk role assignment session has expired or is no longer valid. Run `.add role` to start a new one.',
      ephemeral: true,
    }).catch(() => {});
    return true;
  }

  // Security: Only the user who ran the command can interact with the session
  if (interaction.user.id !== session.userId) {
    await interaction.reply({
      content: '❌ Only the administrator who initiated this `.add role` command can use these controls.',
      ephemeral: true,
    }).catch(() => {});
    return true;
  }

  const { guild, member } = interaction;
  if (!guild || !member) return true;

  // 1. Cancel Action
  if (action === 'cancel') {
    activeBulkRoleSessions.delete(sessionId);
    const cancelEmbed = new EmbedBuilder()
      .setTitle('❌ Bulk Role Assignment Cancelled')
      .setColor(0xEF4444)
      .setDescription('The bulk role assignment workflow was cancelled. No roles were modified.')
      .setTimestamp();

    await interaction.update({ embeds: [cancelEmbed], components: [] }).catch(() => {});
    return true;
  }

  // 2. Pagination Actions (Roles)
  if (action === 'page_prev' || action === 'page_next') {
    const assignableRoles = getAssignableRoles(guild, member);
    const totalPages = Math.max(1, Math.ceil(assignableRoles.length / ROLES_PER_PAGE));
    if (action === 'page_prev') {
      session.page = Math.max(0, (session.page || 0) - 1);
    } else {
      session.page = Math.min(totalPages - 1, (session.page || 0) + 1);
    }

    const payload = buildRoleSelectPayload(session, assignableRoles);
    await interaction.update(payload).catch(() => {});
    return true;
  }

  // 3. Role Selected from Dropdown
  if (action === 'select_role') {
    const selectedRoleId = interaction.values?.[0];
    const role = guild.roles.cache.get(selectedRoleId);
    if (!role) {
      await interaction.reply({
        content: '❌ The selected role could not be found. It may have been deleted.',
        ephemeral: true,
      }).catch(() => {});
      return true;
    }

    session.roleId = role.id;
    session.roleName = role.name;

    const payload = buildUserSelectPayload(session, role);
    await interaction.update(payload).catch(() => {});
    return true;
  }

  // 4. Back to Role Selection
  if (action === 'back_role') {
    const assignableRoles = getAssignableRoles(guild, member);
    const payload = buildRoleSelectPayload(session, assignableRoles);
    await interaction.update(payload).catch(() => {});
    return true;
  }

  // 5. User Selection from Dropdown (Multi-select)
  if (action === 'select_users') {
    const selectedUsers = interaction.values || [];
    session.selectedUserIds = selectedUsers;

    const role = guild.roles.cache.get(session.roleId);
    if (!role) {
      await interaction.reply({ content: '❌ Target role no longer exists.', ephemeral: true }).catch(() => {});
      return true;
    }

    const payload = buildUserSelectPayload(session, role);
    await interaction.update(payload).catch(() => {});
    return true;
  }

  // 6. Reset to All Members
  if (action === 'reset_all') {
    session.selectedUserIds = [];

    const role = guild.roles.cache.get(session.roleId);
    if (!role) {
      await interaction.reply({ content: '❌ Target role no longer exists.', ephemeral: true }).catch(() => {});
      return true;
    }

    const payload = buildUserSelectPayload(session, role);
    await interaction.update(payload).catch(() => {});
    return true;
  }

  // 7. Back to User Selection from Confirmation screen
  if (action === 'back_users') {
    const role = guild.roles.cache.get(session.roleId);
    if (!role) {
      await interaction.reply({ content: '❌ Target role no longer exists.', ephemeral: true }).catch(() => {});
      return true;
    }

    const payload = buildUserSelectPayload(session, role);
    await interaction.update(payload).catch(() => {});
    return true;
  }

  // 8. Confirm -> Show Pre-Execution Review
  if (action === 'confirm') {
    const role = guild.roles.cache.get(session.roleId);
    if (!role) {
      await interaction.reply({ content: '❌ Target role no longer exists.', ephemeral: true }).catch(() => {});
      return true;
    }

    // Acknowledge interaction while resolving members
    await interaction.deferUpdate().catch(() => {});

    const { targetMembers, alreadyHasRoleCount, botCount } = await resolveTargetMembers(
      guild,
      role,
      session.selectedUserIds
    );

    // Cache resolved members in session for execution
    session.targetMembers = targetMembers;
    session.alreadyHasRoleCount = alreadyHasRoleCount;
    session.botCount = botCount;

    const payload = buildConfirmationPayload(
      session,
      role,
      targetMembers,
      alreadyHasRoleCount,
      botCount
    );

    await interaction.editReply(payload).catch(() => {});
    return true;
  }

  // 9. Execute Bulk Role Assignment
  if (action === 'execute') {
    const role = guild.roles.cache.get(session.roleId);
    if (!role) {
      await interaction.reply({ content: '❌ Target role no longer exists.', ephemeral: true }).catch(() => {});
      return true;
    }

    const targetMembers = session.targetMembers || [];
    const alreadyHasRoleCount = session.alreadyHasRoleCount || 0;
    const botCount = session.botCount || 0;
    const isAllMembers = (session.selectedUserIds?.length || 0) === 0;

    // Delete session so duplicate clicks cannot trigger re-execution
    activeBulkRoleSessions.delete(sessionId);

    // Initial Progress embed
    const inProgressEmbed = new EmbedBuilder()
      .setTitle('⏳ Bulk Role Assignment in Progress...')
      .setColor(0x3B82F6)
      .setDescription(
        `Assigning **@${role.name}** (<@&${role.id}>) to **${targetMembers.length}** members.\n\n` +
        `• Progress: **0 / ${targetMembers.length}** (0%)\n` +
        `• Rate-Limit Pacing: Active\n\n` +
        `*Please wait while the bot assigns the role safely.*`
      )
      .setFooter({ text: 'Match District Role Manager • In Progress' })
      .setTimestamp();

    await interaction.update({ embeds: [inProgressEmbed], components: [] }).catch(() => {});

    // Periodic progress updates
    const onProgress = async ({ current, total, successCount, failureCount }) => {
      const pct = Math.round((current / total) * 100);
      const updateEmbed = new EmbedBuilder()
        .setTitle('⏳ Bulk Role Assignment in Progress...')
        .setColor(0x3B82F6)
        .setDescription(
          `Assigning **@${role.name}** (<@&${role.id}>) to **${total}** members.\n\n` +
          `• Progress: **${current} / ${total}** (${pct}%)\n` +
          `• Successful: **${successCount}**\n` +
          (failureCount > 0 ? `• Failed: **${failureCount}**\n` : '') +
          `\n*Please wait while the bot assigns the role safely.*`
        )
        .setFooter({ text: 'Match District Role Manager • In Progress' })
        .setTimestamp();

      await interaction.editReply({ embeds: [updateEmbed], components: [] }).catch(() => {});
    };

    // Execute bulk assignment
    const { successCount, failureCount } = await executeBulkRoleAssignment(
      guild,
      role,
      targetMembers,
      targetMembers.length > 20 ? onProgress : null
    );

    // Final Completion Embed
    const completeEmbed = new EmbedBuilder()
      .setTitle('✅ Bulk Role Assignment Complete')
      .setColor(0x10B981)
      .setDescription(
        `Successfully processed bulk role assignment for **@${role.name}** (<@&${role.id}>).`
      )
      .addFields(
        {
          name: '🎯 Target Scope',
          value: isAllMembers ? '🌐 All Server Members' : `🎯 Specific Members (${session.selectedUserIds?.length || targetMembers.length})`,
          inline: true,
        },
        {
          name: '✅ Successfully Assigned',
          value: `**${successCount}** member${successCount === 1 ? '' : 's'}`,
          inline: true,
        },
        {
          name: '❌ Failed',
          value: `**${failureCount}** member${failureCount === 1 ? '' : 's'}`,
          inline: true,
        },
        {
          name: '⏭️ Skipped',
          value: `• **${alreadyHasRoleCount}** already had role\n• **${botCount}** bots excluded`,
          inline: false,
        },
        {
          name: '👤 Admin',
          value: `<@${member.id}>`,
          inline: true,
        }
      )
      .setFooter({ text: 'Match District Role Manager' })
      .setTimestamp();

    await interaction.editReply({ embeds: [completeEmbed], components: [] }).catch(() => {});
    return true;
  }

  return false;
}
