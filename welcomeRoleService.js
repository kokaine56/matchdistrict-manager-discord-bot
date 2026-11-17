// matchdistrict-manager-discord-bot/welcomeRoleService.js
/**
 * Automatic Welcome Role Service (.welcome role & .welcome role remove)
 *
 * Provides an interactive Discord workflow for administrators to configure
 * automatic role assignment for newly joined members:
 *
 * Commands:
 * 1. .welcome role
 *    - Opens a multi-select dropdown of available server roles (with 25-item pagination).
 *    - Admins select multiple roles to assign to new members.
 *    - Saves all selected role IDs in MongoDB per server.
 *    - When a new member joins, automatically assigns every configured role silently.
 *    - Sends NO welcome message in any channel.
 *
 * 2. .welcome role remove
 *    - Displays all currently configured welcome roles.
 *    - Allows admins to multi-select roles to remove via dropdown.
 *    - Includes "Remove Selected", "Remove All", and "Cancel" buttons.
 *    - "Remove All" prompts for confirmation before clearing all configured roles.
 *    - Removing roles only stops automatic assignment; never removes roles from existing members.
 *
 * 3. .welcome role status
 *    - Shows all currently configured welcome roles and their active status.
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} from 'discord.js';
import crypto from 'crypto';
import { getMongoDb, isMongoConnected } from './mongoService.js';
import { queueRoleAdd } from './discordQueue.js';

export const WELCOME_ROLE_PREFIX = 'welc_role:';
export const ROLES_PER_PAGE = 25;
const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes
export const WELCOME_ACCENT_COLOR = 0xF97316; // Match District Orange accent

// In-memory active wizard sessions: sessionId -> SessionData
export const activeWelcomeRoleSessions = new Map();

// In-memory guild welcome configuration cache: guildId -> Config
export const welcomeConfigCache = new Map();

/**
 * Checks and cleans timed-out wizard sessions.
 */
function cleanExpiredSessions() {
  const now = Date.now();
  for (const [id, session] of activeWelcomeRoleSessions.entries()) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      activeWelcomeRoleSessions.delete(id);
    }
  }
}

/**
 * Verifies whether a member has permission to configure or remove welcome roles.
 * Only administrators or members with Manage Server permission can configure/remove.
 *
 * @param {import('discord.js').GuildMember} member
 * @param {import('discord.js').Guild} [guild]
 * @returns {boolean}
 */
export function canMemberManageWelcomeRole(member, guild = null) {
  if (!member) return false;
  const effectiveGuild = guild || member.guild;
  if (effectiveGuild && effectiveGuild.ownerId === member.id) return true;
  if (!member.permissions) return false;

  if (typeof member.permissions.has === 'function') {
    return (
      member.permissions.has(PermissionFlagsBits.Administrator) ||
      member.permissions.has(PermissionFlagsBits.ManageGuild) ||
      member.permissions.has('Administrator') ||
      member.permissions.has('ManageGuild')
    );
  }
  return false;
}

/**
 * Verifies whether the bot has permission to assign roles in the guild.
 *
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').Client} [client]
 * @returns {boolean}
 */
export function canBotAssignRoles(guild, client = null) {
  if (!guild) return false;
  const botMember = guild.members?.me || (client?.user?.id ? guild.members?.cache?.get(client.user.id) : null);
  if (!botMember || !botMember.permissions) return false;

  if (typeof botMember.permissions.has === 'function') {
    return (
      botMember.permissions.has(PermissionFlagsBits.Administrator) ||
      botMember.permissions.has(PermissionFlagsBits.ManageRoles) ||
      botMember.permissions.has('Administrator') ||
      botMember.permissions.has('ManageRoles')
    );
  }
  return false;
}

/**
 * Returns all roles in the guild that can be assigned by the bot and the executing admin,
 * sorted descending by role hierarchy position.
 *
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildMember} [member]
 * @returns {Array<import('discord.js').Role>}
 */
export function getAssignableRoles(guild, member = null) {
  if (!guild || !guild.roles?.cache) return [];

  const botMember = guild.members?.me;
  const botHighest = botMember?.roles?.highest?.position ?? -1;
  const memberHighest =
    member && guild.ownerId !== member.id
      ? (member.roles?.highest?.position ?? -1)
      : Infinity;

  const roles = Array.from(guild.roles.cache.values()).filter((role) => {
    // 1. Cannot assign @everyone
    if (role.id === guild.id) return false;
    // 2. Cannot assign bot-managed / integration roles
    if (role.managed) return false;
    // 3. Must be strictly below bot's highest role
    if (botHighest !== -1 && role.position >= botHighest) return false;
    // 4. Must be strictly below executor's highest role (unless server owner)
    if (memberHighest !== Infinity && role.position >= memberHighest) return false;
    return true;
  });

  return roles.sort((a, b) => b.position - a.position);
}

/**
 * Normalizes welcome configuration document into consistent structure.
 */
function normalizeConfig(doc, guildId) {
  if (!doc) return null;
  const strId = String(guildId || doc.guildId);

  let roleIds = [];
  if (Array.isArray(doc.roleIds)) {
    roleIds = doc.roleIds.filter(Boolean);
  } else if (doc.roleId) {
    roleIds = [doc.roleId];
  }

  return {
    guildId: strId,
    roleIds,
    enabled: doc.enabled !== false && roleIds.length > 0,
    updatedAt: doc.updatedAt || new Date(),
    updatedBy: doc.updatedBy || null,
  };
}

/**
 * Creates MongoDB indexes for welcome configs collection.
 */
export async function ensureWelcomeRoleIndexes(db) {
  if (!db) return;
  try {
    const col = db.collection('discord_welcome_configs');
    await col.createIndex({ guildId: 1 }, { unique: true });
  } catch (err) {
    console.warn('[WelcomeRole] ⚠️ Error creating welcome configs index:', err.message);
  }
}

/**
 * Loads all welcome configurations from MongoDB into memory cache.
 */
export async function loadAllWelcomeConfigsFromDb(db = null) {
  const effectiveDb = db || (isMongoConnected() ? getMongoDb() : null);
  if (!effectiveDb) return;

  try {
    const col = effectiveDb.collection('discord_welcome_configs');
    const records = await col.find({}).toArray();
    for (const record of records) {
      if (record?.guildId) {
        welcomeConfigCache.set(record.guildId, normalizeConfig(record, record.guildId));
      }
    }
  } catch (err) {
    console.warn('[WelcomeRole] ⚠️ Error loading welcome configs from DB:', err.message);
  }
}

/**
 * Retrieves the welcome configuration for a guild (from cache or MongoDB).
 *
 * @param {string} guildId
 * @returns {Promise<object|null>}
 */
export async function getWelcomeConfig(guildId) {
  if (!guildId) return null;
  const strId = String(guildId);

  if (welcomeConfigCache.has(strId)) {
    return welcomeConfigCache.get(strId);
  }

  if (isMongoConnected()) {
    try {
      const db = getMongoDb();
      const col = db.collection('discord_welcome_configs');
      const doc = await col.findOne({ guildId: strId });
      if (doc) {
        const normalized = normalizeConfig(doc, strId);
        welcomeConfigCache.set(strId, normalized);
        return normalized;
      }
    } catch (err) {
      console.warn(`[WelcomeRole] ⚠️ Error fetching welcome config for ${strId}:`, err.message);
    }
  }

  return null;
}

/**
 * Persists welcome configuration to MongoDB and updates in-memory cache.
 *
 * @param {string} guildId
 * @param {object} config
 * @returns {Promise<boolean>}
 */
export async function saveWelcomeConfig(guildId, config) {
  if (!guildId || !config) return false;
  const strId = String(guildId);

  const rawRoleIds = Array.isArray(config.roleIds)
    ? config.roleIds
    : config.roleId
    ? [config.roleId]
    : [];

  const roleIds = Array.from(new Set(rawRoleIds.filter(Boolean)));

  const payload = {
    guildId: strId,
    roleIds,
    enabled: config.enabled !== false && roleIds.length > 0,
    updatedAt: new Date(),
    updatedBy: config.updatedBy || null,
  };

  welcomeConfigCache.set(strId, payload);

  if (isMongoConnected()) {
    try {
      const db = getMongoDb();
      const col = db.collection('discord_welcome_configs');
      await col.updateOne({ guildId: strId }, { $set: payload }, { upsert: true });
      return true;
    } catch (err) {
      console.warn(`[WelcomeRole] ⚠️ Error saving welcome config to DB for ${strId}:`, err.message);
    }
  }

  return true;
}

/**
 * Disables welcome role configuration for a guild.
 *
 * @param {string} guildId
 * @returns {Promise<boolean>}
 */
export async function disableWelcomeConfig(guildId) {
  if (!guildId) return false;
  const strId = String(guildId);

  const existing = (await getWelcomeConfig(strId)) || { guildId: strId, roleIds: [] };
  existing.enabled = false;
  existing.updatedAt = new Date();

  welcomeConfigCache.set(strId, existing);

  if (isMongoConnected()) {
    try {
      const db = getMongoDb();
      const col = db.collection('discord_welcome_configs');
      await col.updateOne({ guildId: strId }, { $set: { enabled: false, updatedAt: new Date() } }, { upsert: true });
      return true;
    } catch (err) {
      console.warn(`[WelcomeRole] ⚠️ Error disabling welcome config for ${strId}:`, err.message);
    }
  }

  return true;
}

/**
 * Builds Role Selection Payload: Select Role(s) (Multi-Select)
 */
export function buildRoleSelectPayload(session, assignableRoles) {
  const totalRoles = assignableRoles.length;
  const totalPages = Math.max(1, Math.ceil(totalRoles / ROLES_PER_PAGE));
  const currentPage = Math.min(Math.max(0, session.page || 0), totalPages - 1);
  session.page = currentPage;

  const startIdx = currentPage * ROLES_PER_PAGE;
  const pageRoles = assignableRoles.slice(startIdx, startIdx + ROLES_PER_PAGE);

  const selectedCount = session.selectedRoleIds?.length || 0;
  const selectedText =
    selectedCount > 0
      ? `\n\n**Selected Roles (${selectedCount}):**\n` +
        session.selectedRoleIds.map((id) => `• <@&${id}>`).join('\n')
      : '';

  const embed = new EmbedBuilder()
    .setTitle('⚙️ Automatic Welcome Roles — Select Roles')
    .setColor(WELCOME_ACCENT_COLOR)
    .setDescription(
      `Select one or more roles from the dropdown below to automatically assign to new members when they join the server.\n\n` +
      `**Assignable Roles Found:** ${totalRoles}\n` +
      (totalPages > 1 ? `**Showing Page:** ${currentPage + 1} of ${totalPages} (${pageRoles.length} roles on this page)\n` : '') +
      `*Only roles positioned below the bot's highest role are assignable.*` +
      selectedText
    )
    .setFooter({
      text: totalPages > 1
        ? `Page ${currentPage + 1} of ${totalPages} • Match District Welcome Role Manager`
        : 'Match District Welcome Role Manager',
    })
    .setTimestamp();

  const options = pageRoles.map((role) => ({
    label: role.name.slice(0, 100),
    value: role.id,
    description: `Position: ${role.position} | ID: ${role.id}`.slice(0, 100),
    default: session.selectedRoleIds?.includes(role.id) || false,
  }));

  const maxSelectable = Math.min(pageRoles.length, 25);
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`${WELCOME_ROLE_PREFIX}role_sel:${session.id}`)
    .setPlaceholder('Choose welcome role(s) for new members...')
    .setMinValues(1)
    .setMaxValues(maxSelectable)
    .addOptions(options);

  const menuRow = new ActionRowBuilder().addComponents(selectMenu);
  const buttonRows = [];

  const actionButtons = [];
  if (selectedCount > 0) {
    actionButtons.push(
      new ButtonBuilder()
        .setCustomId(`${WELCOME_ROLE_PREFIX}save_roles:${session.id}`)
        .setLabel(`Save Roles (${selectedCount})`)
        .setEmoji('💾')
        .setStyle(ButtonStyle.Success)
    );
  }

  // Pagination buttons if > 25 roles
  if (totalPages > 1) {
    const prevBtn = new ButtonBuilder()
      .setCustomId(`${WELCOME_ROLE_PREFIX}role_page:${session.id}:${currentPage - 1}`)
      .setLabel('Previous')
      .setEmoji('◀️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage <= 0);

    const pageIndicator = new ButtonBuilder()
      .setCustomId(`${WELCOME_ROLE_PREFIX}role_ind:${currentPage}`)
      .setLabel(`${currentPage + 1} / ${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true);

    const nextBtn = new ButtonBuilder()
      .setCustomId(`${WELCOME_ROLE_PREFIX}role_page:${session.id}:${currentPage + 1}`)
      .setLabel('Next')
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage >= totalPages - 1);

    actionButtons.push(prevBtn, pageIndicator, nextBtn);
  }

  actionButtons.push(
    new ButtonBuilder()
      .setCustomId(`${WELCOME_ROLE_PREFIX}cancel:${session.id}`)
      .setLabel('Cancel')
      .setEmoji('✖️')
      .setStyle(ButtonStyle.Danger)
  );

  buttonRows.push(new ActionRowBuilder().addComponents(actionButtons.slice(0, 5)));

  return { embeds: [embed], components: [menuRow, ...buttonRows] };
}

/**
 * Builds Role Removal Payload: Select Role(s) to Remove
 */
export function buildRoleRemovePayload(session, guild, configuredRoleIds) {
  const configuredRoles = configuredRoleIds.map((id) => {
    const role = guild.roles.cache.get(id);
    return {
      id,
      name: role?.name || `Deleted Role (${id})`,
    };
  });

  const selectedCount = session.roleIdsToRemove?.length || 0;
  const selectedText =
    selectedCount > 0
      ? `\n\n**Selected to Remove (${selectedCount}):**\n` +
        session.roleIdsToRemove.map((id) => `• <@&${id}>`).join('\n')
      : '';

  const embed = new EmbedBuilder()
    .setTitle('🗑️ Remove Automatic Welcome Roles')
    .setColor(WELCOME_ACCENT_COLOR)
    .setDescription(
      `Select which welcome roles to remove from automatic assignment, or click **Remove All** to clear every welcome role.\n\n` +
      `**Currently Configured Roles (${configuredRoles.length}):**\n` +
      configuredRoles.map((r) => `• <@&${r.id}> (\`${r.name}\`)`).join('\n') +
      `\n\nℹ️ *Note: Removing roles only stops automatic assignment to new members. Existing members will keep their current roles.*` +
      selectedText
    )
    .setFooter({ text: 'Match District Welcome Role Manager' })
    .setTimestamp();

  const options = configuredRoles.slice(0, 25).map((r) => ({
    label: r.name.slice(0, 100),
    value: r.id,
    description: `ID: ${r.id}`.slice(0, 100),
    default: session.roleIdsToRemove?.includes(r.id) || false,
  }));

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`${WELCOME_ROLE_PREFIX}rem_sel:${session.id}`)
    .setPlaceholder('Select welcome role(s) to remove...')
    .setMinValues(1)
    .setMaxValues(options.length)
    .addOptions(options);

  const menuRow = new ActionRowBuilder().addComponents(selectMenu);

  const remSelectedBtn = new ButtonBuilder()
    .setCustomId(`${WELCOME_ROLE_PREFIX}rem_selected:${session.id}`)
    .setLabel(selectedCount > 0 ? `Remove Selected (${selectedCount})` : 'Remove Selected')
    .setEmoji('🗑️')
    .setStyle(ButtonStyle.Danger)
    .setDisabled(selectedCount === 0);

  const remAllBtn = new ButtonBuilder()
    .setCustomId(`${WELCOME_ROLE_PREFIX}rem_all_prompt:${session.id}`)
    .setLabel('Remove All')
    .setEmoji('⚠️')
    .setStyle(ButtonStyle.Danger);

  const cancelBtn = new ButtonBuilder()
    .setCustomId(`${WELCOME_ROLE_PREFIX}cancel:${session.id}`)
    .setLabel('Cancel')
    .setEmoji('✖️')
    .setStyle(ButtonStyle.Secondary);

  const buttonRow = new ActionRowBuilder().addComponents(remSelectedBtn, remAllBtn, cancelBtn);

  return { embeds: [embed], components: [menuRow, buttonRow] };
}

/**
 * Primary Message Command Router: `.welcome role` & `.welcome role remove`
 *
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildMember} member
 * @param {import('discord.js').TextChannel} channel
 * @param {string[]} args
 * @param {(text: string | object, opts?: object) => Promise<any>} replyFn
 * @param {import('discord.js').Client} [client]
 * @param {import('discord.js').Message} [message]
 */
export async function handleWelcomeRoleCommand(
  guild,
  member,
  channel,
  args,
  replyFn,
  client = null,
  message = null
) {
  if (!guild || !channel) {
    return replyFn('❌ This command can only be used inside a Discord server text channel.');
  }

  // 1. Permission check: Administrator or Manage Server
  if (!canMemberManageWelcomeRole(member, guild)) {
    return replyFn('❌ **Permission Denied:** Only Administrators or members with `Manage Server` permission can configure or remove welcome roles.');
  }

  cleanExpiredSessions();

  const sub = (args[0] || '').toLowerCase();
  const sub2 = (args[1] || '').toLowerCase();

  // Status check: `.welcome status` or `.welcome role status`
  if (sub === 'status' || sub2 === 'status') {
    const config = await getWelcomeConfig(guild.id);
    const activeRoles = config?.roleIds || [];
    if (!config || !config.enabled || activeRoles.length === 0) {
      return replyFn(
        `ℹ️ **Welcome Roles Status:** Disabled\n` +
        `• No active automatic welcome roles configured.\n` +
        `• Run \`.welcome role\` to choose roles to automatically assign to new members.`
      );
    }
    return replyFn({
      embeds: [
        new EmbedBuilder()
          .setTitle('⚙️ Active Welcome Roles')
          .setColor(WELCOME_ACCENT_COLOR)
          .setDescription(
            `• **Status:** Active ✅\n` +
            `• **Configured Roles (${activeRoles.length}):**\n` +
            activeRoles.map((id) => `• <@&${id}> (\`${guild.roles.cache.get(id)?.name || id}\`)`).join('\n') +
            `\n\n*New members joining the server will automatically receive all of these roles silently.*`
          )
          .setFooter({ text: 'Match District Welcome Role Manager' })
          .setTimestamp(),
      ],
    });
  }

  // Removal Workflow: `.welcome role remove` or `.welcome remove`
  if (sub === 'remove' || sub2 === 'remove') {
    const config = await getWelcomeConfig(guild.id);
    const activeRoles = config?.roleIds || [];
    if (!config || !config.enabled || activeRoles.length === 0) {
      return replyFn('ℹ️ **No welcome roles configured:** There are currently no automatic welcome roles configured in this server.');
    }

    const sessionId = crypto.randomUUID();
    const session = {
      id: sessionId,
      guildId: guild.id,
      authorId: member.id,
      roleIdsToRemove: [],
      createdAt: Date.now(),
    };
    activeWelcomeRoleSessions.set(sessionId, session);

    const payload = buildRoleRemovePayload(session, guild, activeRoles);
    return replyFn(payload);
  }

  // Disable check: `.welcome disable` or `.welcome role disable`
  if (sub === 'disable' || sub2 === 'disable') {
    await disableWelcomeConfig(guild.id);
    return replyFn('✅ **Welcome Roles Disabled.** Automatic role assignments for new members have been turned off.');
  }

  // 2. Bot permission check: Manage Roles
  if (!canBotAssignRoles(guild, client)) {
    return replyFn('❌ **Missing Bot Permission:** I need the **Manage Roles** permission to assign roles to new members. Please grant this permission and try again.');
  }

  // 3. Collect assignable server roles
  const assignableRoles = getAssignableRoles(guild, member);
  if (assignableRoles.length === 0) {
    return replyFn(
      '❌ **No assignable roles found.**\n' +
      'Please ensure:\n' +
      '1. The server has created roles to assign.\n' +
      "2. The bot's highest role is positioned **above** the roles you want to assign in Server Settings > Roles."
    );
  }

  // 4. Create new wizard session
  const existingConfig = await getWelcomeConfig(guild.id);
  const sessionId = crypto.randomUUID();
  const session = {
    id: sessionId,
    guildId: guild.id,
    authorId: member.id,
    page: 0,
    selectedRoleIds: existingConfig?.enabled ? [...(existingConfig.roleIds || [])] : [],
    createdAt: Date.now(),
  };

  activeWelcomeRoleSessions.set(sessionId, session);

  const payload = buildRoleSelectPayload(session, assignableRoles);
  return replyFn(payload);
}

/**
 * Handles all interactive select menu and button interactions for `.welcome role`.
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {import('discord.js').Client} [client]
 * @returns {Promise<boolean>}
 */
export async function handleWelcomeRoleInteraction(interaction, client = null) {
  const customId = interaction.customId || '';
  if (!customId.startsWith(WELCOME_ROLE_PREFIX)) return false;

  cleanExpiredSessions();

  const parts = customId.slice(WELCOME_ROLE_PREFIX.length).split(':');
  const action = parts[0];
  const sessionId = parts[1];

  const session = activeWelcomeRoleSessions.get(sessionId);
  if (!session) {
    await interaction.reply({
      content: '❌ **This configuration session has expired or is invalid.** Please run `.welcome role` again.',
      ephemeral: true,
    }).catch(() => {});
    return true;
  }

  // Security check: Only the executing administrator can interact
  if (interaction.user.id !== session.authorId) {
    await interaction.reply({
      content: '❌ Only the administrator who initiated this configuration can interact with it.',
      ephemeral: true,
    }).catch(() => {});
    return true;
  }

  const guild = interaction.guild;
  if (!guild) return false;

  // 1. Role Selection Menu (Multi-Select)
  if (action === 'role_sel') {
    const selectedIds = interaction.values || [];
    if (selectedIds.length === 0) return true;

    session.selectedRoleIds = selectedIds;
    const assignableRoles = getAssignableRoles(guild, interaction.member);
    const payload = buildRoleSelectPayload(session, assignableRoles);
    await interaction.update(payload).catch(() => {});
    return true;
  }

  // 2. Save Selected Roles Button
  if (action === 'save_roles') {
    const selectedIds = session.selectedRoleIds || [];
    if (selectedIds.length === 0) {
      await interaction.reply({ content: '❌ Please select at least one role from the dropdown first.', ephemeral: true });
      return true;
    }

    // Save to MongoDB and in-memory cache
    await saveWelcomeConfig(guild.id, {
      roleIds: selectedIds,
      enabled: true,
      updatedBy: session.authorId,
    });

    activeWelcomeRoleSessions.delete(sessionId);

    const successEmbed = new EmbedBuilder()
      .setTitle('✅ Automatic Welcome Roles Saved!')
      .setColor(WELCOME_ACCENT_COLOR)
      .setDescription(
        `Automatic welcome role assignment is now active.\n\n` +
        `• **Configured Welcome Roles (${selectedIds.length}):**\n` +
        selectedIds.map((id) => `• <@&${id}> (\`${guild.roles.cache.get(id)?.name || id}\`)`).join('\n') +
        `\n\nWhen a new member joins the server, they will automatically receive all of these roles.`
      )
      .setFooter({ text: 'Match District Welcome Role Manager' })
      .setTimestamp();

    await interaction.update({ embeds: [successEmbed], components: [] }).catch(() => {});
    return true;
  }

  // 3. Role Pagination Buttons
  if (action === 'role_page') {
    const targetPage = parseInt(parts[2], 10) || 0;
    session.page = targetPage;
    const assignableRoles = getAssignableRoles(guild, interaction.member);
    const payload = buildRoleSelectPayload(session, assignableRoles);
    await interaction.update(payload).catch(() => {});
    return true;
  }

  // 4. Removal Dropdown Selection
  if (action === 'rem_sel') {
    const selectedToRemove = interaction.values || [];
    session.roleIdsToRemove = selectedToRemove;

    const config = await getWelcomeConfig(guild.id);
    const payload = buildRoleRemovePayload(session, guild, config?.roleIds || []);
    await interaction.update(payload).catch(() => {});
    return true;
  }

  // 5. Remove Selected Button
  if (action === 'rem_selected') {
    const toRemove = session.roleIdsToRemove || [];
    if (toRemove.length === 0) {
      await interaction.reply({ content: '❌ Please select at least one role from the dropdown to remove.', ephemeral: true });
      return true;
    }

    const config = await getWelcomeConfig(guild.id);
    const currentRoles = config?.roleIds || [];
    const toRemoveSet = new Set(toRemove);
    const remainingRoles = currentRoles.filter((id) => !toRemoveSet.has(id));

    await saveWelcomeConfig(guild.id, {
      roleIds: remainingRoles,
      enabled: remainingRoles.length > 0,
      updatedBy: session.authorId,
    });

    activeWelcomeRoleSessions.delete(sessionId);

    const embed = new EmbedBuilder()
      .setTitle('✅ Welcome Roles Removed')
      .setColor(WELCOME_ACCENT_COLOR)
      .setDescription(
        `Removed **${toRemove.length}** role(s) from automatic welcome assignment:\n` +
        toRemove.map((id) => `• <@&${id}> (\`${guild.roles.cache.get(id)?.name || id}\`)`).join('\n') +
        `\n\n` +
        (remainingRoles.length > 0
          ? `**Remaining Welcome Roles (${remainingRoles.length}):**\n` +
            remainingRoles.map((id) => `• <@&${id}> (\`${guild.roles.cache.get(id)?.name || id}\`)`).join('\n')
          : `*No welcome roles remaining. Automatic welcome role assignment is now disabled.*`) +
        `\n\nℹ️ *Note: Existing server members were not modified.*`
      )
      .setFooter({ text: 'Match District Welcome Role Manager' })
      .setTimestamp();

    await interaction.update({ embeds: [embed], components: [] }).catch(() => {});
    return true;
  }

  // 6. Remove All Confirmation Prompt
  if (action === 'rem_all_prompt') {
    const config = await getWelcomeConfig(guild.id);
    const count = config?.roleIds?.length || 0;

    const confirmEmbed = new EmbedBuilder()
      .setTitle('⚠️ Confirm Removal of All Welcome Roles')
      .setColor(0xEF4444) // Red danger
      .setDescription(
        `Are you sure you want to remove **ALL ${count}** welcome roles from automatic assignment?\n\n` +
        `• Automatic welcome role assignment will be disabled.\n` +
        `• **Existing server members will keep their roles.** Only future new members will stop receiving them.`
      )
      .setFooter({ text: 'Match District Welcome Role Manager' });

    const confirmBtn = new ButtonBuilder()
      .setCustomId(`${WELCOME_ROLE_PREFIX}rem_all_confirm:${session.id}`)
      .setLabel('Yes, Remove All Roles')
      .setEmoji('⚠️')
      .setStyle(ButtonStyle.Danger);

    const cancelBtn = new ButtonBuilder()
      .setCustomId(`${WELCOME_ROLE_PREFIX}cancel:${session.id}`)
      .setLabel('Cancel')
      .setEmoji('✖️')
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(confirmBtn, cancelBtn);
    await interaction.update({ embeds: [confirmEmbed], components: [row] }).catch(() => {});
    return true;
  }

  // 7. Remove All Confirmed Execution
  if (action === 'rem_all_confirm') {
    await saveWelcomeConfig(guild.id, {
      roleIds: [],
      enabled: false,
      updatedBy: session.authorId,
    });

    activeWelcomeRoleSessions.delete(sessionId);

    const embed = new EmbedBuilder()
      .setTitle('✅ All Welcome Roles Removed')
      .setColor(WELCOME_ACCENT_COLOR)
      .setDescription(
        `All welcome roles have been removed from automatic assignment.\n` +
        `Automatic welcome role assignment is now disabled for this server.\n\n` +
        `ℹ️ *Existing server members will keep their current roles.*`
      )
      .setFooter({ text: 'Match District Welcome Role Manager' })
      .setTimestamp();

    await interaction.update({ embeds: [embed], components: [] }).catch(() => {});
    return true;
  }

  // 8. Cancel Button
  if (action === 'cancel') {
    activeWelcomeRoleSessions.delete(sessionId);
    await interaction.update({
      content: '❌ **Welcome role operation cancelled.**',
      embeds: [],
      components: [],
    }).catch(() => {});
    return true;
  }

  return false;
}

/**
 * Automatically assigns every configured welcome role when a new member joins the server (guildMemberAdd event).
 * Silently assigns roles. Sends NO welcome message in any channel.
 *
 * @param {import('discord.js').GuildMember} member
 * @param {import('discord.js').Client} [client]
 */
export async function handleWelcomeRoleOnMemberJoin(member, client = null) {
  if (!member || member.user?.bot || !member.guild) return;

  const guild = member.guild;
  const config = await getWelcomeConfig(guild.id);
  if (!config || !config.enabled || !config.roleIds || config.roleIds.length === 0) return;

  const botMember = guild.members?.me || (client?.user?.id ? guild.members?.cache?.get(client.user.id) : null);
  const botHighest = botMember?.roles?.highest?.position ?? -1;

  for (const roleId of config.roleIds) {
    if (!roleId) continue;

    try {
      // Prevent duplicate role assignments
      const alreadyHasRole = member.roles?.cache?.has?.(roleId);
      if (alreadyHasRole) continue;

      const role = guild.roles.cache.get(roleId) || (await guild.roles.fetch(roleId).catch(() => null));
      if (!role) {
        console.warn(`[WelcomeRole] ⚠️ Configured welcome role ${roleId} not found in guild ${guild.id}.`);
        continue;
      }

      // Check bot hierarchy
      if (botHighest !== -1 && role.position >= botHighest) {
        console.warn(`[WelcomeRole] ⚠️ Cannot assign role "${role.name}": positioned equal to or higher than bot's highest role.`);
        continue;
      }

      // Silently assign the role
      await queueRoleAdd(member, role.id, 'Automatic Welcome Role on join');
      console.log(`[WelcomeRole] ✅ Assigned welcome role "${role.name}" to member ${member.user?.tag || member.id}`);
    } catch (roleErr) {
      console.warn(`[WelcomeRole] ⚠️ Error assigning welcome role ${roleId} to member ${member.id}:`, roleErr.message);
    }
  }
}
