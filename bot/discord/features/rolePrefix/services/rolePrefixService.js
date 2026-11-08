import crypto from 'node:crypto';
import {
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
} from 'discord.js';
import {
  saveRolePrefix,
  deleteRolePrefix,
  getGuildRolePrefixes,
  getGuildRolePrefixesFromCache,
  findPrefixInGuild,
} from '../models/rolePrefixModels.js';
import { queueMemberNickname } from '../../../../../discordQueue.js';

// Ephemeral wizard sessions: Map<sessionId, SessionData>
const activeSessions = new Map();

// In-flight nickname updates to prevent circular updates in GuildMemberUpdate
// Key: `${guildId}:${memberId}:${targetNickname}`
const inFlightNicknameUpdates = new Set();

/**
 * Checks if a member has administrator or manage server permissions.
 * @param {import('discord.js').GuildMember} member
 * @param {import('discord.js').Guild} [guild]
 * @returns {boolean}
 */
export function isRoleAdmin(member, guild = null) {
  if (!member) return false;
  const effectiveGuild = guild || member.guild;
  if (effectiveGuild?.ownerId === member.id) return true;
  if (member.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;
  if (member.permissions?.has?.(PermissionFlagsBits.ManageGuild)) return true;
  if (typeof member.permissions?.has === 'function') {
    if (member.permissions.has('Administrator') || member.permissions.has('ManageGuild')) return true;
  }
  return false;
}

/**
 * Checks if the bot has permission to manage nicknames in the guild.
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').Client} [client]
 * @returns {{ canManage: boolean, reason?: string }}
 */
export function canBotManageNicknames(guild, client = null) {
  if (!guild) return { canManage: false, reason: 'Invalid guild.' };
  const botMember = guild.members?.me || (client?.user?.id ? guild.members?.cache?.get(client.user.id) : null);
  if (!botMember) {
    return { canManage: false, reason: 'Bot member could not be resolved in this server.' };
  }
  const perms = botMember.permissions;
  const hasPerm =
    perms?.has?.(PermissionFlagsBits.ManageNicknames) ||
    perms?.has?.(PermissionFlagsBits.Administrator) ||
    (typeof perms?.has === 'function' && (perms.has('ManageNicknames') || perms.has('Administrator')));

  if (!hasPerm) {
    return {
      canManage: false,
      reason: 'I do not have the **Manage Nicknames** permission in this server.',
    };
  }
  return { canManage: true };
}

/**
 * Checks if the bot can edit a specific member's nickname under Discord hierarchy rules.
 * @param {import('discord.js').GuildMember} botMember
 * @param {import('discord.js').GuildMember} targetMember
 * @returns {{ manageable: boolean, reason?: string }}
 */
export function isMemberManageable(botMember, targetMember) {
  if (!targetMember || !targetMember.guild) {
    return { manageable: false, reason: 'Invalid member' };
  }
  if (targetMember.id === targetMember.guild.ownerId) {
    return { manageable: false, reason: 'Server Owner (Discord restriction: bot cannot edit server owner nickname)' };
  }
  if (botMember && targetMember.id === botMember.id) {
    return { manageable: false, reason: 'Bot cannot edit own role prefix' };
  }

  // Use discord.js native check if available
  if (targetMember.manageable === false) {
    return { manageable: false, reason: 'Role Hierarchy (member role is equal or higher than bot role)' };
  }

  if (botMember?.roles?.highest && targetMember?.roles?.highest) {
    if (botMember.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0) {
      return { manageable: false, reason: 'Role Hierarchy (member role is equal or higher than bot role)' };
    }
  }

  return { manageable: true };
}

/**
 * Strips all managed guild prefixes from a nickname.
 * @param {string} currentName
 * @param {Array<string>} managedPrefixes
 * @returns {string}
 */
export function stripManagedPrefix(currentName, managedPrefixes = []) {
  if (!currentName) return '';
  let result = String(currentName).trim();
  for (const prefix of managedPrefixes) {
    if (!prefix) continue;
    const cleanPfx = prefix.trim();
    const pfxWithSpace = `${cleanPfx} `;
    if (result.startsWith(pfxWithSpace)) {
      result = result.slice(pfxWithSpace.length).trim();
      break;
    }
  }
  return result;
}

/**
 * Formats a nickname with a prefix ensuring Discord 32-character maximum.
 * Never adds duplicate prefix.
 * @param {string} prefix
 * @param {string} baseName
 * @returns {string}
 */
export function formatPrefixedNickname(prefix, baseName) {
  const cleanPrefix = (prefix || '').trim();
  let cleanBase = (baseName || '').trim();
  if (!cleanPrefix) return cleanBase.slice(0, 32);
  if (!cleanBase) return cleanPrefix.slice(0, 32);

  const prefixWithSpace = `${cleanPrefix} `;
  if (cleanBase.startsWith(prefixWithSpace)) {
    cleanBase = cleanBase.slice(prefixWithSpace.length).trim();
  }

  const candidate = `${prefixWithSpace}${cleanBase}`;
  if (candidate.length <= 32) {
    return candidate;
  }

  const available = Math.max(1, 32 - prefixWithSpace.length);
  return `${prefixWithSpace}${cleanBase.slice(0, available)}`.slice(0, 32);
}

/**
 * Resolves the deterministic active prefix configuration for a member
 * based on role hierarchy and configuration priority.
 *
 * @param {import('discord.js').GuildMember} member
 * @param {Array<object>} guildConfigs
 * @returns {object|null}
 */
export function resolveActivePrefixConfig(member, guildConfigs = []) {
  if (!member || !guildConfigs || guildConfigs.length === 0) return null;

  const memberRoleIds = new Set(
    member.roles?.cache
      ? Array.from(member.roles.cache.keys())
      : Array.isArray(member.roles)
      ? member.roles.map((r) => r.id || r)
      : []
  );

  const matched = guildConfigs.filter((c) => memberRoleIds.has(c.roleId));
  if (matched.length === 0) return null;
  if (matched.length === 1) return matched[0];

  // Sort by role hierarchy position descending, then creation date
  return matched.sort((a, b) => {
    const aRole = member.guild?.roles?.cache?.get?.(a.roleId);
    const bRole = member.guild?.roles?.cache?.get?.(b.roleId);
    const aPos = aRole?.position ?? a.rolePosition ?? 0;
    const bPos = bRole?.position ?? b.rolePosition ?? 0;
    if (bPos !== aPos) return bPos - aPos;
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return aTime - bTime;
  })[0];
}

/**
 * Computes the target nickname for a member given the guild configs.
 * @param {import('discord.js').GuildMember} member
 * @param {Array<object>} guildConfigs
 * @returns {string|null} The target nickname string, or null if it should reset to default username
 */
export function computeTargetNickname(member, guildConfigs = []) {
  if (!member) return null;
  const allPrefixes = guildConfigs.map((c) => c.prefix).filter(Boolean);
  const activeConfig = resolveActivePrefixConfig(member, guildConfigs);

  const currentDisplayName = member.displayName || member.user?.displayName || member.user?.username || '';
  const cleanBase = stripManagedPrefix(currentDisplayName, allPrefixes) || member.user?.username || '';

  if (activeConfig && activeConfig.prefix) {
    return formatPrefixedNickname(activeConfig.prefix, cleanBase);
  }

  // No active prefix: revert managed prefix if present
  if (cleanBase && cleanBase !== currentDisplayName) {
    return cleanBase;
  }

  return member.nickname ?? null;
}

/**
 * Applies a configured prefix to all current members holding that role.
 * Uses the shared rate-limited queue for Discord API safety.
 *
 * @param {import('discord.js').Guild} guild
 * @param {string} roleId
 * @param {string} prefix
 * @returns {Promise<{ total: number, updated: number, alreadyPrefixed: number, skipped: number, errors: number }>}
 */
export async function applyRolePrefixToGuildMembers(guild, roleId, prefix) {
  const stats = { total: 0, updated: 0, alreadyPrefixed: 0, skipped: 0, errors: 0 };
  if (!guild) return stats;

  const botMember = guild.members?.me;
  const role = guild.roles?.cache?.get?.(roleId);
  if (!role) return stats;

  const guildConfigs = getGuildRolePrefixesFromCache(guild.id);
  const prefixWithSpace = `${prefix.trim()} `;

  // Ensure members cache is populated
  const members = Array.from(role.members?.values?.() || []);
  stats.total = members.length;

  for (const member of members) {
    if (member.user?.bot) {
      stats.skipped++;
      continue;
    }

    const { manageable } = isMemberManageable(botMember, member);
    if (!manageable) {
      stats.skipped++;
      continue;
    }

    // Check active config: if another higher role takes precedence, honor that
    const activeConfig = resolveActivePrefixConfig(member, guildConfigs);
    const targetPrefix = activeConfig?.prefix || prefix;
    const targetPrefixWithSpace = `${targetPrefix.trim()} `;

    if (member.displayName?.startsWith(targetPrefixWithSpace)) {
      stats.alreadyPrefixed++;
      continue;
    }

    const targetNick = computeTargetNickname(member, guildConfigs);
    if (targetNick === member.nickname) {
      stats.alreadyPrefixed++;
      continue;
    }

    try {
      const updateKey = `${guild.id}:${member.id}:${targetNick}`;
      inFlightNicknameUpdates.add(updateKey);
      setTimeout(() => inFlightNicknameUpdates.delete(updateKey), 10000);

      await queueMemberNickname(member, targetNick, `Role prefix configuration: ${targetPrefix}`);
      stats.updated++;
    } catch (err) {
      console.warn(`[RolePrefix] Failed to update nickname for member ${member.id}:`, err?.message || err);
      stats.errors++;
    }
  }

  return stats;
}

/**
 * Removes a managed prefix from members with that role when configuration is deleted.
 *
 * @param {import('discord.js').Guild} guild
 * @param {string} roleId
 * @param {string} prefix
 * @returns {Promise<{ total: number, reverted: number, skipped: number }>}
 */
export async function removeRolePrefixFromGuildMembers(guild, roleId, prefix) {
  const stats = { total: 0, reverted: 0, skipped: 0 };
  if (!guild) return stats;

  const botMember = guild.members?.me;
  const role = guild.roles?.cache?.get?.(roleId);
  const members = role?.members ? Array.from(role.members.values()) : Array.from(guild.members?.cache?.values() || []);
  const guildConfigs = getGuildRolePrefixesFromCache(guild.id);

  for (const member of members) {
    if (member.user?.bot) continue;

    // Check if member has that role
    const hasRole = member.roles?.cache ? member.roles.cache.has(roleId) : true;
    if (!hasRole) continue;
    stats.total++;

    const { manageable } = isMemberManageable(botMember, member);
    if (!manageable) {
      stats.skipped++;
      continue;
    }

    // Recompute target without this configuration
    const targetNick = computeTargetNickname(member, guildConfigs);
    if (targetNick !== member.nickname) {
      try {
        const updateKey = `${guild.id}:${member.id}:${targetNick}`;
        inFlightNicknameUpdates.add(updateKey);
        setTimeout(() => inFlightNicknameUpdates.delete(updateKey), 10000);

        await queueMemberNickname(member, targetNick, `Role prefix removal for role: ${role?.name || roleId}`);
        stats.reverted++;
      } catch (err) {
        console.warn(`[RolePrefix] Failed to revert nickname for member ${member.id}:`, err?.message || err);
        stats.skipped++;
      }
    } else {
      stats.skipped++;
    }
  }

  return stats;
}

/**
 * Primary Message Command Router: `.role`
 *
 * Subcommands:
 * - `.role pre <prefix>`: Configure role nickname prefix.
 * - `.role pre list`: List configured role prefixes.
 * - `.role pre remove [role]`: Remove configured role prefix.
 * - `.role pre refresh`: Reapply prefixes to all eligible members.
 *
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildMember} member
 * @param {import('discord.js').TextChannel} channel
 * @param {string[]} args
 * @param {(text: string | object, opts?: object) => Promise<any>} replyFn
 * @param {import('discord.js').Client} [client]
 * @param {import('discord.js').Message} [message]
 */
export async function handleRoleCommand(guild, member, channel, args, replyFn, client = null, message = null) {
  if (!guild || !channel) {
    return replyFn('❌ This command can only be used inside a Discord server text channel.');
  }

  // 1. Check administrator permission
  if (!isRoleAdmin(member, guild)) {
    return replyFn("❌ You don't have permission to use this command. Only administrators can configure role prefixes.");
  }

  const sub = (args[0] || '').toLowerCase();
  if (sub !== 'pre' && sub !== 'prefix') {
    return replyFn(
      `🏷️ **Role Nickname Prefix Commands**\n` +
      `• \`.role pre <prefix>\` — Configure a nickname prefix for a role (e.g. \`.role pre DSx\`).\n` +
      `• \`.role pre list\` — Show configured role prefixes for this server.\n` +
      `• \`.role pre remove\` — Remove a role's prefix configuration.\n` +
      `• \`.role pre refresh\` — Reapply configured prefixes to all eligible server members.`
    );
  }

  const action = (args[1] || '').trim();

  // Case 1: .role pre list
  if (action.toLowerCase() === 'list') {
    return handleRolePreList(guild, replyFn);
  }

  // Case 2: .role pre remove
  if (action.toLowerCase() === 'remove') {
    const roleArg = args.slice(2).join(' ').trim();
    return handleRolePreRemove(guild, member, channel, roleArg, replyFn, message);
  }

  // Case 3: .role pre refresh
  if (action.toLowerCase() === 'refresh') {
    return handleRolePreRefresh(guild, replyFn);
  }

  // Case 4: .role pre <prefix>
  if (!action) {
    return replyFn(
      `ℹ️ **Usage:** \`.role pre <prefix>\`\n` +
      `**Example:** \`.role pre DSx\`\n` +
      `• \`.role pre list\` — Show all configured role prefixes.\n` +
      `• \`.role pre remove\` — Remove a role's prefix configuration.\n` +
      `• \`.role pre refresh\` — Reapply configured prefixes.`
    );
  }

  return handleRolePreSetup(guild, member, channel, action, args.slice(2), replyFn, client, message);
}

/**
 * Handles `.role pre <prefix>` wizard initiation.
 */
async function handleRolePreSetup(guild, member, channel, prefix, extraArgs, replyFn, client, message) {
  // 1. Check Bot permissions
  const { canManage, reason } = canBotManageNicknames(guild, client);
  if (!canManage) {
    return replyFn(`❌ ${reason}`);
  }

  const cleanPrefix = prefix.trim();
  if (cleanPrefix.length > 10) {
    return replyFn('❌ Prefix must be between 1 and 10 characters long.');
  }

  // Check if this prefix is already assigned to another role in this guild
  const existingPrefixConfig = findPrefixInGuild(guild.id, cleanPrefix);

  // Check if role was passed directly on the command line: .role pre DSx @Role
  let targetRole = null;
  if (message?.mentions?.roles?.first()) {
    targetRole = message.mentions.roles.first();
  } else if (extraArgs.length > 0) {
    const rawRole = extraArgs.join(' ').replace(/[<@&>]/g, '').trim();
    targetRole = guild.roles?.cache?.get?.(rawRole) ||
      guild.roles?.cache?.find?.((r) => r.name.toLowerCase() === rawRole.toLowerCase()) || null;
  }

  if (targetRole) {
    // If prefix is assigned to a different role
    if (existingPrefixConfig && existingPrefixConfig.roleId !== targetRole.id) {
      return replyFn(
        `⚠️ Prefix **${cleanPrefix}** is already configured for role <@&${existingPrefixConfig.roleId}>. Each role must have a distinct prefix.`
      );
    }
    return displayPrefixConfirmation(guild, member, channel, cleanPrefix, targetRole, replyFn);
  }

  // Interactive flow: Ask "Which role should receive this prefix?"
  const sessionId = `rp_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  activeSessions.set(sessionId, {
    sessionId,
    guildId: guild.id,
    channelId: channel.id,
    userId: member.id,
    prefix: cleanPrefix,
    existingPrefixConfig,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });

  const roleSelectMenu = new RoleSelectMenuBuilder()
    .setCustomId(`role_pre:select_role:${sessionId}`)
    .setPlaceholder('Select a role to receive this prefix')
    .setMinValues(1)
    .setMaxValues(1);

  const cancelBtn = new ButtonBuilder()
    .setCustomId(`role_pre:cancel:${sessionId}`)
    .setLabel('Cancel')
    .setStyle(ButtonStyle.Secondary);

  const row1 = new ActionRowBuilder().addComponents(roleSelectMenu);
  const row2 = new ActionRowBuilder().addComponents(cancelBtn);

  const embed = new EmbedBuilder()
    .setTitle('🏷️ Role Nickname Prefix Setup')
    .setColor(0x5865F2)
    .setDescription(
      `**Prefix:** \`${cleanPrefix}\`\n\n` +
      `Which role should receive this prefix?\n` +
      `Please select a role from the dropdown menu below.`
    );

  return replyFn({ embeds: [embed], components: [row1, row2] });
}

/**
 * Displays the confirmation screen for role prefix configuration.
 */
async function displayPrefixConfirmation(guild, member, channel, prefix, role, replyFn, interaction = null) {
  const sessionId = `rp_cnf_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  activeSessions.set(sessionId, {
    sessionId,
    guildId: guild.id,
    channelId: channel.id,
    userId: member.id,
    prefix: prefix.trim(),
    roleId: role.id,
    roleName: role.name,
    rolePosition: role.position,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });

  const confirmBtn = new ButtonBuilder()
    .setCustomId(`role_pre:confirm:${sessionId}`)
    .setLabel('Confirm')
    .setEmoji('✅')
    .setStyle(ButtonStyle.Success);

  const cancelBtn = new ButtonBuilder()
    .setCustomId(`role_pre:cancel:${sessionId}`)
    .setLabel('Cancel')
    .setEmoji('❌')
    .setStyle(ButtonStyle.Danger);

  const row = new ActionRowBuilder().addComponents(confirmBtn, cancelBtn);

  const embed = new EmbedBuilder()
    .setTitle('Prefix Configuration')
    .setColor(0x5865F2)
    .setDescription(
      `**Server:** ${guild.name}\n` +
      `**Role:** <@&${role.id}>\n` +
      `**Prefix:** ${prefix.trim()}\n\n` +
      `*Click **Confirm** to save and apply this prefix to all existing members with this role.*`
    );

  const payload = { embeds: [embed], components: [row] };
  if (interaction) {
    return interaction.update(payload);
  }
  return replyFn(payload);
}

/**
 * Handles `.role pre list` command.
 */
async function handleRolePreList(guild, replyFn) {
  const configs = await getGuildRolePrefixes(guild.id);
  if (!configs || configs.length === 0) {
    return replyFn('ℹ️ No role prefixes configured for this server. Use `.role pre <prefix>` to configure one.');
  }

  // Sort by role hierarchy position
  const sorted = [...configs].sort((a, b) => {
    const aRole = guild.roles?.cache?.get?.(a.roleId);
    const bRole = guild.roles?.cache?.get?.(b.roleId);
    const aPos = aRole?.position ?? a.rolePosition ?? 0;
    const bPos = bRole?.position ?? b.rolePosition ?? 0;
    return bPos - aPos;
  });

  const lines = sorted.map((c, i) => {
    const role = guild.roles?.cache?.get?.(c.roleId);
    const memberCount = role?.members?.size ?? '—';
    return `**${i + 1}.** <@&${c.roleId}> (\`${role?.name || c.roleName || c.roleId}\`)\n` +
           `   • Prefix: \`${c.prefix}\`\n` +
           `   • Eligible Members: **${memberCount}**\n` +
           `   • Status: ${c.enabled !== false ? '🟢 Active' : '🔴 Disabled'}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`🏷️ Configured Role Prefixes (${guild.name})`)
    .setColor(0x5865F2)
    .setDescription(lines.join('\n\n'))
    .setFooter({ text: 'Use .role pre <prefix> to add/update • .role pre remove to delete • .role pre refresh to sync' })
    .setTimestamp();

  return replyFn({ embeds: [embed] });
}

/**
 * Handles `.role pre remove` command.
 */
async function handleRolePreRemove(guild, member, channel, roleArg, replyFn, message) {
  const configs = await getGuildRolePrefixes(guild.id);
  if (!configs || configs.length === 0) {
    return replyFn('ℹ️ No role prefixes configured to remove in this server.');
  }

  let targetRole = null;
  if (roleArg) {
    const cleanId = roleArg.replace(/[<@&>]/g, '').trim();
    targetRole = guild.roles?.cache?.get?.(cleanId) ||
      guild.roles?.cache?.find?.((r) => r.name.toLowerCase() === cleanId.toLowerCase()) || null;
  }

  if (targetRole) {
    const config = configs.find((c) => c.roleId === targetRole.id);
    if (!config) {
      return replyFn(`⚠️ Role <@&${targetRole.id}> does not have an active prefix configuration.`);
    }

    await deleteRolePrefix(guild.id, targetRole.id);
    const revertStats = await removeRolePrefixFromGuildMembers(guild, targetRole.id, config.prefix);

    return replyFn(
      `✅ **Role Prefix Removed**\n` +
      `• Role: <@&${targetRole.id}>\n` +
      `• Prefix: \`${config.prefix}\`\n` +
      `• Reverted Nicknames: **${revertStats.reverted}** member(s) (total checked: ${revertStats.total}).`
    );
  }

  // Interactive selection if no role specified
  const sessionId = `rp_rm_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  activeSessions.set(sessionId, {
    sessionId,
    guildId: guild.id,
    userId: member.id,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });

  const options = configs.slice(0, 25).map((c) => {
    const role = guild.roles?.cache?.get?.(c.roleId);
    return {
      label: role?.name || c.roleName || c.roleId,
      description: `Prefix: ${c.prefix}`,
      value: c.roleId,
    };
  });

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`role_pre:remove_select:${sessionId}`)
    .setPlaceholder('Choose a role prefix configuration to remove')
    .addOptions(options);

  const cancelBtn = new ButtonBuilder()
    .setCustomId(`role_pre:cancel:${sessionId}`)
    .setLabel('Cancel')
    .setStyle(ButtonStyle.Secondary);

  const row1 = new ActionRowBuilder().addComponents(selectMenu);
  const row2 = new ActionRowBuilder().addComponents(cancelBtn);

  const embed = new EmbedBuilder()
    .setTitle('🗑️ Remove Role Prefix')
    .setColor(0xED4245)
    .setDescription('Select the role prefix configuration you want to remove:');

  return replyFn({ embeds: [embed], components: [row1, row2] });
}

/**
 * Handles `.role pre refresh` command.
 */
async function handleRolePreRefresh(guild, replyFn) {
  const configs = await getGuildRolePrefixes(guild.id);
  if (!configs || configs.length === 0) {
    return replyFn('ℹ️ No role prefixes configured in this server. Use `.role pre <prefix>` first.');
  }

  const statusMsg = await replyFn('🔄 **Refreshing role prefixes...** Processing server members...');

  let totalMembers = 0;
  let updatedCount = 0;
  let alreadyPrefixedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const config of configs) {
    const stats = await applyRolePrefixToGuildMembers(guild, config.roleId, config.prefix);
    totalMembers += stats.total;
    updatedCount += stats.updated;
    alreadyPrefixedCount += stats.alreadyPrefixed;
    skippedCount += stats.skipped;
    errorCount += stats.errors;
  }

  const resultText =
    `✅ **Role Prefix Refresh Completed!**\n\n` +
    `• **Active Role Configurations:** ${configs.length}\n` +
    `• **Total Eligible Members:** ${totalMembers}\n` +
    `• **Nicknames Updated:** ${updatedCount}\n` +
    `• **Already Prefixed:** ${alreadyPrefixedCount}\n` +
    `• **Skipped (Hierarchy / Owner):** ${skippedCount}\n` +
    (errorCount > 0 ? `• **Errors:** ${errorCount}\n` : '');

  if (statusMsg && typeof statusMsg.edit === 'function') {
    return statusMsg.edit(resultText);
  }
  return replyFn(resultText);
}

/**
 * Handles role prefix interaction components (select menus, buttons).
 * @param {import('discord.js').Interaction} interaction
 * @returns {Promise<boolean>} True if handled
 */
export async function handleRolePrefixInteraction(interaction) {
  const customId = interaction.customId || '';
  if (!customId.startsWith('role_pre:')) return false;

  const parts = customId.split(':');
  const action = parts[1];
  const sessionId = parts[2];

  const session = activeSessions.get(sessionId);
  if (!session && action !== 'cancel') {
    await interaction.reply({
      content: '⚠️ This prefix configuration session has expired. Please run `.role pre` again.',
      ephemeral: true,
    }).catch(() => {});
    return true;
  }

  // Verify permission
  if (session && session.userId && session.userId !== interaction.user.id) {
    await interaction.reply({
      content: '❌ Only the administrator who initiated this setup can use these controls.',
      ephemeral: true,
    }).catch(() => {});
    return true;
  }

  // 1. Cancel button
  if (action === 'cancel') {
    if (sessionId) activeSessions.delete(sessionId);
    await interaction.update({
      content: '❌ Role prefix configuration cancelled.',
      embeds: [],
      components: [],
    }).catch(() => {});
    return true;
  }

  // 2. Select role from RoleSelectMenu
  if (action === 'select_role') {
    const selectedRoleId = interaction.values?.[0];
    const role = interaction.guild?.roles?.cache?.get?.(selectedRoleId);
    if (!role) {
      await interaction.reply({ content: '❌ Selected role could not be found.', ephemeral: true });
      return true;
    }

    // Check if prefix already exists on a different role
    const existing = findPrefixInGuild(interaction.guild.id, session.prefix, role.id);
    if (existing) {
      await interaction.reply({
        content: `⚠️ Prefix **${session.prefix}** is already configured for role <@&${existing.roleId}>. Each role must have a distinct prefix.`,
        ephemeral: true,
      });
      return true;
    }

    session.roleId = role.id;
    session.roleName = role.name;
    session.rolePosition = role.position;

    await displayPrefixConfirmation(
      interaction.guild,
      interaction.member,
      interaction.channel,
      session.prefix,
      role,
      (payload) => interaction.update(payload),
      interaction
    );
    return true;
  }

  // 3. Confirm button
  if (action === 'confirm') {
    const { guild, member } = interaction;
    const { prefix, roleId, roleName, rolePosition } = session;
    activeSessions.delete(sessionId);

    await interaction.deferUpdate().catch(() => {});

    // Save in DB and cache
    await saveRolePrefix({
      guildId: guild.id,
      roleId,
      roleName,
      prefix,
      enabled: true,
      createdBy: member.id,
      rolePosition,
    });

    // Apply to existing members
    const stats = await applyRolePrefixToGuildMembers(guild, roleId, prefix);

    const embed = new EmbedBuilder()
      .setTitle('Prefix Configuration Saved')
      .setColor(0x57F287)
      .setDescription(
        `**Server:** ${guild.name}\n` +
        `**Role:** <@&${roleId}>\n` +
        `**Prefix:** ${prefix}\n\n` +
        `**Application Summary:**\n` +
        `• **Total Members with Role:** ${stats.total}\n` +
        `• **Nicknames Updated:** ${stats.updated}\n` +
        `• **Already Prefixed:** ${stats.alreadyPrefixed}\n` +
        `• **Skipped (Server Owner / Hierarchy):** ${stats.skipped}\n` +
        (stats.errors > 0 ? `• **Errors:** ${stats.errors}\n` : '')
      )
      .setFooter({ text: 'Prefix will be automatically applied to future role members.' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed], components: [] }).catch(() => {});
    return true;
  }

  // 4. Remove select
  if (action === 'remove_select') {
    const selectedRoleId = interaction.values?.[0];
    const role = interaction.guild?.roles?.cache?.get?.(selectedRoleId);
    const configs = getGuildRolePrefixesFromCache(interaction.guild.id);
    const config = configs.find((c) => c.roleId === selectedRoleId);

    activeSessions.delete(sessionId);

    if (!config) {
      await interaction.update({
        content: '⚠️ That role prefix configuration was not found.',
        embeds: [],
        components: [],
      }).catch(() => {});
      return true;
    }

    await interaction.deferUpdate().catch(() => {});
    await deleteRolePrefix(interaction.guild.id, selectedRoleId);
    const revertStats = await removeRolePrefixFromGuildMembers(interaction.guild, selectedRoleId, config.prefix);

    const embed = new EmbedBuilder()
      .setTitle('Role Prefix Removed')
      .setColor(0xED4245)
      .setDescription(
        `• **Role:** <@&${selectedRoleId}>\n` +
        `• **Prefix:** \`${config.prefix}\`\n` +
        `• **Reverted Nicknames:** ${revertStats.reverted} member(s) (total checked: ${revertStats.total})\n` +
        (revertStats.skipped > 0 ? `• **Skipped (Hierarchy / Owner):** ${revertStats.skipped}\n` : '')
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed], components: [] }).catch(() => {});
    return true;
  }

  return false;
}

/**
 * Handles Discord GuildMemberUpdate event for automatic role prefixing:
 * - When member receives a configured role -> automatically apply prefix.
 * - When member loses a configured role -> remove or revert prefix.
 * - When member changes their nickname -> preserve the configured prefix.
 * - Prevents infinite loops and avoids duplicate prefixes.
 *
 * @param {import('discord.js').GuildMember} oldMember
 * @param {import('discord.js').GuildMember} newMember
 */
export async function handleRolePrefixMemberUpdate(oldMember, newMember) {
  if (!newMember || !newMember.guild) return;
  if (newMember.user?.bot) return;

  const guild = newMember.guild;
  const guildConfigs = getGuildRolePrefixesFromCache(guild.id);
  if (!guildConfigs || guildConfigs.length === 0) return;

  const oldRoles = oldMember?.roles?.cache;
  const newRoles = newMember.roles?.cache;

  let rolesChanged = false;
  if (oldRoles && newRoles) {
    if (oldRoles.size !== newRoles.size) {
      rolesChanged = true;
    } else {
      for (const id of newRoles.keys()) {
        if (!oldRoles.has(id)) {
          rolesChanged = true;
          break;
        }
      }
    }
  }

  const nicknameChanged = oldMember?.nickname !== newMember.nickname;

  if (!rolesChanged && !nicknameChanged) {
    return;
  }

  const botMember = guild.members?.me;
  const { manageable } = isMemberManageable(botMember, newMember);
  if (!manageable) {
    return;
  }

  // Calculate target nickname for newMember
  const targetNick = computeTargetNickname(newMember, guildConfigs);

  // If nickname already matches target, nothing to do
  if (targetNick === newMember.nickname) {
    return;
  }

  // Prevent circular loop if an update for this target nickname was initiated
  const updateKey = `${guild.id}:${newMember.id}:${targetNick}`;
  if (inFlightNicknameUpdates.has(updateKey)) {
    return;
  }

  try {
    inFlightNicknameUpdates.add(updateKey);
    setTimeout(() => inFlightNicknameUpdates.delete(updateKey), 10000);

    await queueMemberNickname(newMember, targetNick, 'Role prefix automated sync');
  } catch (err) {
    console.warn(`[RolePrefix] Automated update failed for member ${newMember.id}:`, err?.message || err);
  }
}
