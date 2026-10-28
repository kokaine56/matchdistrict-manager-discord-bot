/**
 * MatchDistrict Discord Bot — Unified Clean Audit Log System
 * Standardizes all audit logs across roles, channels, members, messages, and tournaments
 * using compact, readable Discord Embeds with consistent palette, layout, and deduplication.
 */

import {
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
} from 'discord.js';
import { getGuildChannelId, isSetupActive, isOfficialGuild, redactSecrets, formatChannelTypeName } from './index.js';
import { isMongoConnected, getDb } from './mongoService.js';

/**
 * Standard audit color palette based on action semantics.
 */
export const AUDIT_COLORS = {
  CREATE: 0x22C55E, // Emerald Green (Creation, addition, connection, qualification, opening)
  DELETE: 0xEF4444, // Coral Red (Deletion, banning, removal, unlinking, closure)
  UPDATE: 0x3B82F6, // Electric Blue (Edits, modifications, role synchronization)
  GRANT: 0x10B981,  // Deep Green (Roles granted, unbanned)
  REVOKE: 0xF43F5E, // Rose Red (Roles revoked, permissions removed)
  WARN: 0xF59E0B,   // Amber (Welcome DM failed, warning)
  INFO: 0x06B6D4,   // Cyan (Messages sent, informational actions)
  NEUTRAL: 0x64748B,// Slate Gray (Fallbacks)
};

export const AUDIT_FOOTER_TEXT = 'MatchDistrict Audit Log';

/**
 * In-memory deduplication cache.
 * Key: dedupKey (string), Value: timestamp (number)
 */
const memoryDedup = new Map();

/**
 * Role batch queue for debouncing rapid role-create events (e.g. tournament group roles).
 * Key: guildId (string), Value: { roles: Array, executor: Object, source: string, timer: Timeout }
 */
const roleBatchQueues = new Map();

/**
 * Checks and records deduplication keys across memory and MongoDB.
 * @param {string} dedupKey
 * @param {number} [windowMs=45000]
 * @returns {Promise<boolean>} True if action was already logged within the window
 */
export async function isAuditDeduplicated(dedupKey, windowMs = 45000) {
  if (!dedupKey) return false;
  const now = Date.now();

  // 1. In-memory fast check
  if (memoryDedup.has(dedupKey) && now - memoryDedup.get(dedupKey) < windowMs) {
    return true;
  }
  memoryDedup.set(dedupKey, now);

  // Prune memory cache if it grows large
  if (memoryDedup.size > 2000) {
    for (const [k, v] of memoryDedup.entries()) {
      if (now - v > windowMs) memoryDedup.delete(k);
    }
  }

  // 2. MongoDB persistent check if connected
  if (isMongoConnected()) {
    try {
      const db = getDb();
      if (db) {
        const col = db.collection('discord_audit_dedup');
        const existing = await col.findOne({ _id: dedupKey });
        if (existing && now - new Date(existing.createdAt).getTime() < windowMs) {
          return true;
        }
        await col.updateOne(
          { _id: dedupKey },
          { $set: { createdAt: new Date() } },
          { upsert: true }
        );
      }
    } catch {
      // Non-fatal MongoDB dedup error fallback
    }
  }

  return false;
}

/**
 * Sanitizes user-controlled text to prevent broken embeds, mass mentions, and leaked secrets.
 * @param {string} text
 * @returns {string}
 */
export function sanitizeText(text) {
  if (!text || typeof text !== 'string') return '';
  let cleaned = redactSecrets(text);
  // Neutralize mass mentions
  cleaned = cleaned.replace(/@everyone/g, '@\u200beveryone').replace(/@here/g, '@\u200bhere');
  return cleaned;
}

/**
 * Format a list of member IDs or objects into a compact mention list.
 * Splits into chunks or limits length safely to avoid overflowing Discord's 1024-character field limit.
 * @param {Array<string|object>} members
 * @param {number} [maxChars=950]
 * @returns {string}
 */
export function formatMemberList(members, maxChars = 950) {
  if (!Array.isArray(members) || members.length === 0) return '*None*';

  const mentions = members.map((m) => {
    const id = typeof m === 'string' ? m : (m.id || m.discord_id || m.discordId);
    return id ? `<@${id}>` : (m.tag || m.username || 'Unknown');
  }).filter(Boolean);

  let result = '';
  let count = 0;
  for (let i = 0; i < mentions.length; i++) {
    const next = (count === 0 ? '' : ', ') + mentions[i];
    if ((result + next).length > maxChars) {
      const remaining = mentions.length - count;
      result += `, ...and **${remaining}** more`;
      break;
    }
    result += next;
    count++;
  }

  return result || '*None*';
}

/**
 * Creates a unified, clean Discord Embed for audit logs.
 * @param {object} options
 * @param {string} options.title - Short, descriptive title
 * @param {string} [options.description] - Action summary
 * @param {Array<{ name: string, value: string, inline?: boolean }>} [options.fields]
 * @param {number} [options.color] - Color code from AUDIT_COLORS
 * @param {string} [options.footerText] - Footer text
 * @param {Date|number} [options.timestamp] - Timestamp
 * @returns {EmbedBuilder}
 */
export function createAuditEmbed({
  title,
  description = null,
  fields = [],
  color = AUDIT_COLORS.UPDATE,
  footerText = AUDIT_FOOTER_TEXT,
  timestamp = new Date(),
}) {
  const embed = new EmbedBuilder()
    .setTitle(String(title || 'Audit Log').slice(0, 256))
    .setColor(color)
    .setFooter({ text: footerText })
    .setTimestamp(timestamp instanceof Date ? timestamp : new Date(timestamp));

  if (description) {
    embed.setDescription(String(description).slice(0, 4096));
  }

  if (Array.isArray(fields)) {
    for (const field of fields) {
      if (!field || !field.name || field.value === undefined || field.value === null) continue;
      const strVal = String(field.value).trim();
      if (!strVal) continue;
      embed.addFields({
        name: String(field.name).slice(0, 256),
        value: strVal.slice(0, 1024),
        inline: field.inline !== false, // default inline to true for compact scanning
      });
      if (embed.data.fields && embed.data.fields.length >= 25) break;
    }
  }

  return embed;
}

/**
 * Resolves the appropriate audit log channel in a guild for a given category.
 * @param {import('discord.js').Guild} guild
 * @param {string} category - 'roleCreate'|'roleDelete'|'channelCreate'|'channelDelete'|'banUnban'|'msg'|'dm'|'tournament'|'admin'
 * @returns {import('discord.js').TextChannel|null}
 */
export function resolveAuditChannel(guild, category) {
  if (!guild || !guild.channels) return null;

  const keyMap = {
    roleCreate: ['roleCreateLogId', 'botPreviewId'],
    roleDelete: ['roleDeleteLogId', 'roleCreateLogId', 'botPreviewId'],
    channelCreate: ['channelCreateLogId', 'botPreviewId'],
    channelDelete: ['channelDeleteLogId', 'channelCreateLogId', 'botPreviewId'],
    banUnban: ['banUnbanLogId', 'botPreviewId'],
    msg: ['msgLogId'],
    dm: ['dmLogId'],
    tournament: ['botPreviewId', 'channelCreateLogId', 'roleCreateLogId'],
    admin: ['botPreviewId', 'channelCreateLogId', 'roleCreateLogId'],
  };

  const nameFallbackMap = {
    roleCreate: ['role-create-log', 'role-log', 'matchdistrict-logs', 'bot-preview'],
    roleDelete: ['role-delete-log', 'role-create-log', 'matchdistrict-logs', 'bot-preview'],
    channelCreate: ['channel-create-log', 'matchdistrict-logs', 'bot-preview'],
    channelDelete: ['channel-delete-log', 'channel-create-log', 'matchdistrict-logs', 'bot-preview'],
    banUnban: ['ban-unban-log', 'matchdistrict-logs', 'bot-preview'],
    msg: ['msg-log', 'matchdistrict-logs'],
    dm: ['dm-log', 'matchdistrict-logs'],
    tournament: ['bot-preview', 'matchdistrict-logs', 'tournament-update'],
    admin: ['bot-preview', 'matchdistrict-logs', 'tournament-update'],
  };

  const candidateKeys = keyMap[category] || ['botPreviewId'];
  for (const k of candidateKeys) {
    const chId = getGuildChannelId(guild.id, k);
    if (chId) {
      const ch = guild.channels.cache.get(chId);
      if (ch) return ch;
    }
  }

  // Fallback by channel name
  const candidateNames = nameFallbackMap[category] || ['matchdistrict-logs', 'bot-preview'];
  if (guild.channels.cache && typeof guild.channels.cache.find === 'function') {
    const ch = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildText && candidateNames.includes(c.name)
    );
    if (ch) return ch;
  }

  return null;
}

/**
 * Safely dispatches an audit log embed to the appropriate guild channel.
 * @param {import('discord.js').Guild} guild
 * @param {string|import('discord.js').TextChannel} targetCategoryOrChannel
 * @param {EmbedBuilder|object} embedOrOptions
 * @param {object} [options={}]
 * @param {string} [options.dedupKey]
 * @param {boolean} [options.allowMentions=false]
 * @returns {Promise<boolean>}
 */
export async function sendAuditLog(guild, targetCategoryOrChannel, embedOrOptions, options = {}) {
  try {
    if (!guild) return false;

    // Deduplication check
    if (options.dedupKey) {
      const isDupe = await isAuditDeduplicated(options.dedupKey, options.dedupWindowMs || 45000);
      if (isDupe) return false;
    }

    let targetChannel = null;
    if (typeof targetCategoryOrChannel === 'string') {
      targetChannel = resolveAuditChannel(guild, targetCategoryOrChannel);
    } else if (targetCategoryOrChannel && typeof targetCategoryOrChannel.send === 'function') {
      targetChannel = targetCategoryOrChannel;
    }

    if (!targetChannel) return false;

    // Permission check
    const botMember = guild.members.me;
    if (botMember && typeof targetChannel.permissionsFor === 'function') {
      const perms = targetChannel.permissionsFor(botMember);
      if (!perms?.has(PermissionFlagsBits.SendMessages) || !perms?.has(PermissionFlagsBits.EmbedLinks)) {
        return false;
      }
    }

    let embed = embedOrOptions instanceof EmbedBuilder
      ? embedOrOptions
      : createAuditEmbed(embedOrOptions);

    await targetChannel.send({
      embeds: [embed],
      allowedMentions: { parse: [] }, // Strict: prevents accidental mass mentions
    });

    return true;
  } catch (err) {
    console.warn('[Audit Logger] ⚠️ Failed to send audit embed:', err.message);
    return false;
  }
}

// =========================================================================
// ROLE AUDIT LOGS
// =========================================================================

/**
 * Logs a single role creation.
 */
export async function logRoleCreated(role, executor = null, source = null) {
  if (!role || !role.guild) return;
  const guild = role.guild;

  const isBot = executor?.id === role.client?.user?.id || (role.client?.user?.id && executor?.bot);
  const sourceDisplay = source || (isBot
    ? 'Bot Operation'
    : (executor ? 'Moderator Action' : 'External / Discord Native'));

  const creatorDisplay = executor ? `<@${executor.id}>` : '*Unknown / System*';
  const color = role.hexColor && role.hexColor !== '#000000' ? role.hexColor : 'Default';
  const mentionable = role.mentionable ? 'Yes' : 'No';

  const embed = createAuditEmbed({
    title: 'Role Created',
    color: AUDIT_COLORS.CREATE,
    fields: [
      { name: 'Role', value: `<@&${role.id}>`, inline: true },
      { name: 'Role ID', value: `\`${role.id}\``, inline: true },
      { name: 'Color', value: `\`${color}\``, inline: true },
      { name: 'Mentionable', value: mentionable, inline: true },
      { name: 'Created By', value: creatorDisplay, inline: true },
      { name: 'Source', value: sourceDisplay, inline: true },
    ],
  });

  await sendAuditLog(guild, 'roleCreate', embed, {
    dedupKey: `roleCreate:${role.id}`,
  });
}

/**
 * Logs a batch of roles created together (e.g., tournament round groups).
 */
export async function logRoleBatchCreated(guild, roles, executor = null, source = null, context = 'Batch Operation') {
  if (!guild || !Array.isArray(roles) || roles.length === 0) return;

  const isBot = executor?.id === guild.client?.user?.id || (guild.client?.user?.id && executor?.bot);
  const sourceDisplay = source || (isBot ? 'Bot Operation' : 'Moderator Action');
  const creatorDisplay = executor ? `<@${executor.id}>` : '*Unknown / System*';

  const roleMentions = roles.map((r) => `<@&${r.id}>`).join(', ');

  const fields = [
    { name: 'Created By', value: creatorDisplay, inline: true },
    { name: 'Source', value: sourceDisplay, inline: true },
    { name: 'Context', value: String(context).slice(0, 100), inline: true },
    { name: 'Total Roles', value: `**${roles.length}** role(s)`, inline: true },
  ];

  if (roleMentions.length <= 1000) {
    fields.push({ name: 'Roles Created', value: roleMentions, inline: false });
  } else {
    // Split into chunks if many roles
    let chunk = '';
    let chunkIdx = 1;
    for (const r of roles) {
      const mention = `<@&${r.id}>, `;
      if ((chunk + mention).length > 950) {
        fields.push({ name: `Roles Created (Part ${chunkIdx})`, value: chunk.slice(0, -2), inline: false });
        chunk = mention;
        chunkIdx++;
      } else {
        chunk += mention;
      }
    }
    if (chunk) {
      fields.push({ name: `Roles Created (Part ${chunkIdx})`, value: chunk.slice(0, -2), inline: false });
    }
  }

  const embed = createAuditEmbed({
    title: 'Roles Created (Batch)',
    color: AUDIT_COLORS.CREATE,
    fields,
  });

  await sendAuditLog(guild, 'roleCreate', embed);
}

/**
 * Debounced role creation handler to batch rapid role creations automatically.
 */
export async function handleRoleCreateWithBatching(role, executor = null, source = null) {
  if (!role || !role.guild) return;
  const guild = role.guild;

  let queue = roleBatchQueues.get(guild.id);
  if (!queue) {
    queue = {
      roles: [],
      executor,
      source,
      timer: null,
    };
    roleBatchQueues.set(guild.id, queue);
  }

  queue.roles.push(role);
  if (executor && !queue.executor) queue.executor = executor;
  if (source && !queue.source) queue.source = source;

  if (queue.timer) clearTimeout(queue.timer);

  queue.timer = setTimeout(async () => {
    roleBatchQueues.delete(guild.id);
    if (queue.roles.length === 1) {
      await logRoleCreated(queue.roles[0], queue.executor, queue.source);
    } else if (queue.roles.length > 1) {
      await logRoleBatchCreated(guild, queue.roles, queue.executor, queue.source, 'Tournament / Group Setup');
    }
  }, 1200);
}

/**
 * Logs role deletion.
 */
export async function logRoleDeleted(role, executor = null, reason = null, source = null) {
  if (!role || !role.guild) return;
  const guild = role.guild;

  const isBot = executor?.id === role.client?.user?.id || (role.client?.user?.id && executor?.bot);
  const sourceDisplay = source || (isBot ? 'Bot Operation' : (executor ? 'Moderator Action' : 'External / Discord Native'));
  const actorDisplay = executor ? `<@${executor.id}>` : '*Unavailable / External*';

  const embed = createAuditEmbed({
    title: 'Role Deleted',
    color: AUDIT_COLORS.DELETE,
    fields: [
      { name: 'Role', value: `\`@${role.name || 'Unknown Role'}\``, inline: true },
      { name: 'Role ID', value: `\`${role.id}\``, inline: true },
      { name: 'Deleted By', value: actorDisplay, inline: true },
      { name: 'Reason', value: sanitizeText(reason || 'No reason provided'), inline: true },
      { name: 'Source', value: sourceDisplay, inline: true },
    ],
  });

  await sendAuditLog(guild, 'roleDelete', embed, {
    dedupKey: `roleDelete:${role.id}`,
  });
}

/**
 * Logs role updates (e.g. name, color, permissions changed).
 */
export async function logRoleUpdated(oldRole, newRole, executor = null) {
  if (!newRole || !newRole.guild) return;
  const guild = newRole.guild;

  const changes = [];
  if (oldRole.name !== newRole.name) {
    changes.push(`**Name:** \`@${oldRole.name}\` ➔ \`@${newRole.name}\``);
  }
  if (oldRole.hexColor !== newRole.hexColor) {
    changes.push(`**Color:** \`${oldRole.hexColor}\` ➔ \`${newRole.hexColor}\``);
  }
  if (oldRole.mentionable !== newRole.mentionable) {
    changes.push(`**Mentionable:** \`${oldRole.mentionable}\` ➔ \`${newRole.mentionable}\``);
  }
  if (oldRole.hoist !== newRole.hoist) {
    changes.push(`**Displayed Separately:** \`${oldRole.hoist}\` ➔ \`${newRole.hoist}\``);
  }

  if (changes.length === 0) return;

  const actorDisplay = executor ? `<@${executor.id}>` : '*System / Moderator*';

  const embed = createAuditEmbed({
    title: 'Role Updated',
    color: AUDIT_COLORS.UPDATE,
    fields: [
      { name: 'Role', value: `<@&${newRole.id}>`, inline: true },
      { name: 'Role ID', value: `\`${newRole.id}\``, inline: true },
      { name: 'Updated By', value: actorDisplay, inline: true },
      { name: 'Changes', value: changes.join('\n'), inline: false },
    ],
  });

  await sendAuditLog(guild, 'roleCreate', embed);
}

/**
 * Logs roles given/assigned to members.
 */
export async function logRolesGiven(guild, role, affectedMembers, actor = null, context = null) {
  if (!guild || !role || !Array.isArray(affectedMembers) || affectedMembers.length === 0) return;

  const actorDisplay = actor ? `<@${actor.id}>` : '`@DistrictManager`';
  const roleDisplay = `<@&${role.id || role}>`;
  const membersFormatted = formatMemberList(affectedMembers);
  const nowTs = Math.floor(Date.now() / 1000);

  const fields = [
    { name: 'Performed By', value: actorDisplay, inline: true },
    { name: 'Role Added', value: roleDisplay, inline: true },
    { name: 'Members Count', value: `**${affectedMembers.length}** member(s)`, inline: true },
  ];

  if (context) {
    fields.push({ name: 'Context', value: String(context).slice(0, 100), inline: true });
  }

  fields.push(
    { name: `Members Affected (${affectedMembers.length})`, value: membersFormatted, inline: false },
    { name: 'Time', value: `<t:${nowTs}:F>`, inline: false }
  );

  const embed = createAuditEmbed({
    title: 'Roles Given',
    color: AUDIT_COLORS.GRANT,
    fields,
  });

  await sendAuditLog(guild, 'roleCreate', embed);
}

/**
 * Logs roles removed from members.
 */
export async function logRolesRemoved(guild, role, affectedMembers, actor = null, context = null) {
  if (!guild || !role || !Array.isArray(affectedMembers) || affectedMembers.length === 0) return;

  const actorDisplay = actor ? `<@${actor.id}>` : '`@DistrictManager`';
  const roleDisplay = `<@&${role.id || role}>`;
  const membersFormatted = formatMemberList(affectedMembers);
  const nowTs = Math.floor(Date.now() / 1000);

  const fields = [
    { name: 'Performed By', value: actorDisplay, inline: true },
    { name: 'Role Removed', value: roleDisplay, inline: true },
    { name: 'Members Count', value: `**${affectedMembers.length}** member(s)`, inline: true },
  ];

  if (context) {
    fields.push({ name: 'Context', value: String(context).slice(0, 100), inline: true });
  }

  fields.push(
    { name: `Members Affected (${affectedMembers.length})`, value: membersFormatted, inline: false },
    { name: 'Time', value: `<t:${nowTs}:F>`, inline: false }
  );

  const embed = createAuditEmbed({
    title: 'Roles Removed',
    color: AUDIT_COLORS.REVOKE,
    fields,
  });

  await sendAuditLog(guild, 'roleDelete', embed);
}

// =========================================================================
// CHANNEL AUDIT LOGS
// =========================================================================

/**
 * Logs channel creation.
 */
export async function logChannelCreated(channel, creator = null, source = null) {
  if (!channel || !channel.guild) return;
  const guild = channel.guild;

  const isBot = creator?.id === channel.client?.user?.id || (channel.client?.user?.id && creator?.bot);
  const sourceDisplay = source || (isBot ? 'Bot Operation' : (creator ? 'Moderator Action' : 'External / Discord Native'));
  const creatorDisplay = creator ? `<@${creator.id}>` : '*Unavailable / Missing Audit Entry*';

  let parentDisplay = 'None (Top-Level)';
  if (channel.parentId) {
    const parentCat = channel.parent || guild.channels.cache?.get(channel.parentId);
    parentDisplay = parentCat ? `📁 **${parentCat.name}**` : `ID: \`${channel.parentId}\``;
  }

  const channelDisplay = channel.type === ChannelType.GuildCategory
    ? `📁 **${channel.name}**`
    : `<#${channel.id}>`;

  const embed = createAuditEmbed({
    title: 'Channel Created',
    color: AUDIT_COLORS.CREATE,
    fields: [
      { name: 'Channel', value: channelDisplay, inline: true },
      { name: 'Channel ID', value: `\`${channel.id}\``, inline: true },
      { name: 'Type', value: formatChannelTypeName(channel.type), inline: true },
      { name: 'Parent Category', value: parentDisplay, inline: true },
      { name: 'Created By', value: creatorDisplay, inline: true },
      { name: 'Source', value: sourceDisplay, inline: true },
    ],
  });

  await sendAuditLog(guild, 'channelCreate', embed, {
    dedupKey: `channelCreate:${channel.id}`,
  });
}

/**
 * Logs channel deletion.
 */
export async function logChannelDeleted(channel, actor = null, reason = null, source = null) {
  if (!channel || !channel.guild) return;
  const guild = channel.guild;

  const isBot = actor?.id === channel.client?.user?.id || (channel.client?.user?.id && actor?.bot);
  const sourceDisplay = source || (isBot ? 'Bot Operation' : (actor ? 'Moderator Action' : 'External / Discord Native'));
  const actorDisplay = actor ? `<@${actor.id}>` : '*Unavailable / Missing Audit Entry*';

  let parentDisplay = 'None (Top-Level)';
  if (channel.parentId) {
    const parentCat = channel.parent || guild.channels.cache?.get(channel.parentId);
    parentDisplay = parentCat ? `📁 **${parentCat.name}**` : `ID: \`${channel.parentId}\``;
  }

  const embed = createAuditEmbed({
    title: 'Channel Deleted',
    color: AUDIT_COLORS.DELETE,
    fields: [
      { name: 'Channel', value: `\`#${channel.name || 'Unknown'}\``, inline: true },
      { name: 'Channel ID', value: `\`${channel.id}\``, inline: true },
      { name: 'Type', value: formatChannelTypeName(channel.type), inline: true },
      { name: 'Parent Category', value: parentDisplay, inline: true },
      { name: 'Deleted By', value: actorDisplay, inline: true },
      { name: 'Reason', value: sanitizeText(reason || 'No reason provided'), inline: true },
      { name: 'Source', value: sourceDisplay, inline: true },
    ],
  });

  await sendAuditLog(guild, 'channelDelete', embed, {
    dedupKey: `channelDelete:${channel.id}`,
  });
}

/**
 * Logs channel updates.
 */
export async function logChannelUpdated(oldChannel, newChannel, executor = null) {
  if (!newChannel || !newChannel.guild) return;
  const guild = newChannel.guild;

  const changes = [];
  if (oldChannel.name !== newChannel.name) {
    changes.push(`**Name:** \`#${oldChannel.name}\` ➔ \`#${newChannel.name}\``);
  }
  if (oldChannel.topic !== newChannel.topic) {
    changes.push(`**Topic Changed**`);
  }
  if (oldChannel.parentId !== newChannel.parentId) {
    changes.push(`**Category Changed**`);
  }

  if (changes.length === 0) return;

  const actorDisplay = executor ? `<@${executor.id}>` : '*Moderator / System*';

  const embed = createAuditEmbed({
    title: 'Channel Updated',
    color: AUDIT_COLORS.UPDATE,
    fields: [
      { name: 'Channel', value: `<#${newChannel.id}>`, inline: true },
      { name: 'Type', value: formatChannelTypeName(newChannel.type), inline: true },
      { name: 'Updated By', value: actorDisplay, inline: true },
      { name: 'Changes', value: changes.join('\n'), inline: false },
    ],
  });

  await sendAuditLog(guild, 'channelCreate', embed);
}

// =========================================================================
// MEMBER AUDIT LOGS (JOIN, LEAVE, BAN, UNBAN, DM)
// =========================================================================

/**
 * Logs member join and welcome DM delivery attempt.
 */
export async function logMemberJoined(member, dmStatus = null) {
  if (!member || !member.guild) return;
  const guild = member.guild;

  const accountAgeTs = Math.floor(member.user.createdTimestamp / 1000);
  const nowTs = Math.floor(Date.now() / 1000);

  let title = 'Member Joined';
  let color = AUDIT_COLORS.INFO;
  let statusText = 'Joined Server';

  if (dmStatus) {
    if (dmStatus.delivered) {
      title = 'Welcome DM Delivered';
      color = AUDIT_COLORS.CREATE;
      statusText = 'Delivered via Direct Message';
    } else {
      title = 'Welcome DM Delivery Failed';
      color = AUDIT_COLORS.WARN;
      statusText = `Failed (${dmStatus.reason || 'DMs Disabled'})`;
    }
  }

  const fields = [
    { name: 'Member', value: `<@${member.id}>`, inline: true },
    { name: 'User ID', value: `\`${member.id}\``, inline: true },
    { name: 'Status', value: statusText, inline: true },
    { name: 'Account Created', value: `<t:${accountAgeTs}:R>`, inline: true },
    { name: 'Time', value: `<t:${nowTs}:F>`, inline: true },
  ];

  const embed = createAuditEmbed({
    title,
    color,
    fields,
  });

  await sendAuditLog(guild, 'dm', embed);
}

/**
 * Logs member departure from server.
 */
export async function logMemberLeft(member) {
  if (!member || !member.guild) return;
  const guild = member.guild;

  const joinedTs = member.joinedTimestamp ? Math.floor(member.joinedTimestamp / 1000) : null;
  const nowTs = Math.floor(Date.now() / 1000);

  const roles = member.roles?.cache
    ? Array.from(member.roles.cache.values()).filter((r) => r.id !== guild.id).map((r) => `<@&${r.id}>`)
    : [];

  const fields = [
    { name: 'Member', value: `\`${member.user?.tag || member.id}\``, inline: true },
    { name: 'User ID', value: `\`${member.id}\``, inline: true },
    { name: 'Joined Server', value: joinedTs ? `<t:${joinedTs}:R>` : '*Unknown*', inline: true },
  ];

  if (roles.length > 0) {
    fields.push({ name: 'Roles Held', value: roles.slice(0, 15).join(', '), inline: false });
  }

  fields.push({ name: 'Time', value: `<t:${nowTs}:F>`, inline: false });

  const embed = createAuditEmbed({
    title: 'Member Left',
    color: AUDIT_COLORS.DELETE,
    fields,
  });

  await sendAuditLog(guild, 'dm', embed);
}

/**
 * Logs member ban.
 */
export async function logMemberBanned(guild, user, moderator = null, reason = null, source = null) {
  if (!guild || !user) return;

  const modDisplay = moderator ? `<@${moderator.id}>` : '*External / Native*';
  const sourceDisplay = source || (moderator?.id === guild.client?.user?.id ? 'Bot Operation' : 'Moderator Command');
  const nowTs = Math.floor(Date.now() / 1000);

  const embed = createAuditEmbed({
    title: 'Member Banned',
    color: AUDIT_COLORS.DELETE,
    fields: [
      { name: 'Target User', value: `<@${user.id}>`, inline: true },
      { name: 'User ID', value: `\`${user.id}\``, inline: true },
      { name: 'Moderator', value: modDisplay, inline: true },
      { name: 'Reason', value: sanitizeText(reason || 'No reason provided'), inline: true },
      { name: 'Initiated Via', value: sourceDisplay, inline: true },
      { name: 'Time', value: `<t:${nowTs}:F>`, inline: true },
    ],
  });

  await sendAuditLog(guild, 'banUnban', embed, {
    dedupKey: `ban:${guild.id}:${user.id}`,
  });
}

/**
 * Logs member unban.
 */
export async function logMemberUnbanned(guild, user, moderator = null, reason = null) {
  if (!guild || !user) return;

  const modDisplay = moderator ? `<@${moderator.id}>` : '*External / Native*';
  const nowTs = Math.floor(Date.now() / 1000);

  const embed = createAuditEmbed({
    title: 'Member Unbanned',
    color: AUDIT_COLORS.GRANT,
    fields: [
      { name: 'Target User', value: `<@${user.id}>`, inline: true },
      { name: 'User ID', value: `\`${user.id}\``, inline: true },
      { name: 'Moderator', value: modDisplay, inline: true },
      { name: 'Reason', value: sanitizeText(reason || 'No reason provided'), inline: true },
      { name: 'Time', value: `<t:${nowTs}:F>`, inline: true },
    ],
  });

  await sendAuditLog(guild, 'banUnban', embed, {
    dedupKey: `unban:${guild.id}:${user.id}`,
  });
}

// =========================================================================
// MESSAGE AUDIT LOGS (SENT, EDITED, DELETED)
// =========================================================================

/**
 * Logs message send event into message logs.
 */
export async function logMessageSent(message) {
  if (!message || !message.guild) return;
  const guild = message.guild;

  const content = sanitizeText(message.content || '');
  const nowTs = Math.floor(message.createdTimestamp / 1000);

  const fields = [
    { name: 'Author', value: `<@${message.author.id}>`, inline: true },
    { name: 'Channel', value: `<#${message.channel.id}>`, inline: true },
    { name: 'Message ID', value: `\`${message.id}\``, inline: true },
  ];

  if (content) {
    fields.push({ name: 'Content', value: content.slice(0, 1000), inline: false });
  }

  if (message.attachments?.size > 0) {
    const attachList = message.attachments.map((a) => `[${a.name || 'file'}](${a.url})`).join(', ');
    fields.push({ name: 'Attachments', value: attachList.slice(0, 500), inline: false });
  }

  fields.push({ name: 'Time', value: `<t:${nowTs}:F>`, inline: true });

  const embed = createAuditEmbed({
    title: 'Message Sent',
    color: AUDIT_COLORS.INFO,
    fields,
  });

  await sendAuditLog(guild, 'msg', embed);
}

/**
 * Logs message edit.
 */
export async function logMessageEdited(oldMessage, newMessage) {
  if (!newMessage || !newMessage.guild) return;
  const guild = newMessage.guild;

  const oldContent = sanitizeText(oldMessage.content || '[Content unavailable or uncached]');
  const newContent = sanitizeText(newMessage.content || '[Empty message]');
  const nowTs = Math.floor(Date.now() / 1000);

  const embed = createAuditEmbed({
    title: 'Message Edited',
    color: AUDIT_COLORS.UPDATE,
    fields: [
      { name: 'Author', value: `<@${newMessage.author?.id}>`, inline: true },
      { name: 'Channel', value: `<#${newMessage.channel.id}>`, inline: true },
      { name: 'Message ID', value: `\`${newMessage.id}\``, inline: true },
      { name: 'Before', value: oldContent.slice(0, 500), inline: false },
      { name: 'After', value: newContent.slice(0, 500), inline: false },
      { name: 'Time', value: `<t:${nowTs}:F>`, inline: true },
    ],
  });

  await sendAuditLog(guild, 'msg', embed);
}

/**
 * Logs message deletion.
 */
export async function logMessageDeleted(message) {
  if (!message || !message.guild) return;
  const guild = message.guild;

  const content = message.content ? sanitizeText(message.content) : '[Content unavailable or uncached]';
  const nowTs = Math.floor(Date.now() / 1000);

  const embed = createAuditEmbed({
    title: 'Message Deleted',
    color: AUDIT_COLORS.DELETE,
    fields: [
      { name: 'Author', value: message.author ? `<@${message.author.id}>` : '*Unknown User*', inline: true },
      { name: 'Channel', value: `<#${message.channel.id}>`, inline: true },
      { name: 'Message ID', value: `\`${message.id}\``, inline: true },
      { name: 'Content', value: content.slice(0, 950), inline: false },
      { name: 'Time', value: `<t:${nowTs}:F>`, inline: true },
    ],
  });

  await sendAuditLog(guild, 'msg', embed);
}

// =========================================================================
// TOURNAMENT AUDIT LOGS
// =========================================================================

/**
 * Formats and dispatches tournament operations into clean audit embeds.
 * @param {import('discord.js').Guild} guild
 * @param {string} actionType
 * @param {object} details
 */
export async function logTournamentAction(guild, actionType, details = {}) {
  if (!guild) return;

  const nowTs = Math.floor(Date.now() / 1000);
  const adminDisplay = details.adminId ? `<@${details.adminId}>` : (details.adminTag ? `\`${details.adminTag}\`` : '`@DistrictManager`');

  let title = 'Tournament Operation';
  let color = AUDIT_COLORS.INFO;
  let fields = [];

  switch (actionType) {
    case 'TOURNAMENT_CHANNELS_CREATED':
      title = 'Tournament Channels Created';
      color = AUDIT_COLORS.CREATE;
      fields = [
        { name: 'Tournament', value: details.tournamentTitle || details.tournamentId || 'Tournament', inline: true },
        { name: 'Tournament ID', value: `\`${details.tournamentId}\``, inline: true },
        { name: 'Performed By', value: adminDisplay, inline: true },
        { name: 'Category', value: details.categoryName || 'Created', inline: true },
        { name: 'Channels', value: `${details.channelCount || 5} channel(s)`, inline: true },
        { name: 'Time', value: `<t:${nowTs}:F>`, inline: true },
      ];
      break;

    case 'DELETE_ALL_CHANNELS':
      title = 'Tournament Channels Deleted';
      color = AUDIT_COLORS.DELETE;
      fields = [
        { name: 'Tournament ID', value: `\`${details.tournamentId}\``, inline: true },
        { name: 'Performed By', value: adminDisplay, inline: true },
        { name: 'Channels Deleted', value: `**${details.totalDeleted || details.deletedChannelsCount || 0}** channel(s)`, inline: true },
        { name: 'Scope', value: 'All Tournament & ID/PWD Channels', inline: true },
        { name: 'Time', value: `<t:${nowTs}:F>`, inline: true },
      ];
      break;

    case 'ROLES_SYNCED':
      title = 'Tournament Roles Synchronized';
      color = AUDIT_COLORS.UPDATE;
      fields = [
        { name: 'Tournament', value: details.tournamentTitle || details.tournamentId, inline: true },
        { name: 'Role', value: details.roleId ? `<@&${details.roleId}>` : (details.roleName || 'Tournament Role'), inline: true },
        { name: 'Assigned', value: `+${details.assigned || 0}`, inline: true },
        { name: 'Removed', value: `-${details.removed || 0}`, inline: true },
        { name: 'Total Holding', value: `**${details.membersWithRole || 0}** member(s)`, inline: true },
        { name: 'Time', value: `<t:${nowTs}:F>`, inline: true },
      ];
      break;

    case 'ROUND_STARTED':
      title = 'Round Started';
      color = AUDIT_COLORS.CREATE;
      fields = [
        { name: 'Tournament', value: details.tournamentTitle || details.tournamentId, inline: true },
        { name: 'Round', value: details.roundName || details.roundId, inline: true },
        { name: 'Performed By', value: adminDisplay, inline: true },
        { name: 'Groups', value: `**${details.groupsCount || 0}** group(s)`, inline: true },
        { name: 'Teams Allocated', value: `**${details.teamsAllocatedCount || 0}** team(s)`, inline: true },
        { name: 'Time', value: `<t:${nowTs}:F>`, inline: true },
      ];
      break;

    case 'ROUND_DELETED':
      title = 'Round Deleted';
      color = AUDIT_COLORS.DELETE;
      fields = [
        { name: 'Tournament', value: details.tournamentTitle || details.tournamentId, inline: true },
        { name: 'Round', value: details.roundName || details.roundId, inline: true },
        { name: 'Performed By', value: adminDisplay, inline: true },
        { name: 'Time', value: `<t:${nowTs}:F>`, inline: true },
      ];
      break;

    case 'QUALIFY_TEAMS':
      title = 'Teams Qualified';
      color = AUDIT_COLORS.CREATE;
      fields = [
        { name: 'Tournament ID', value: `\`${details.tournamentId}\``, inline: true },
        { name: 'Round', value: String(details.roundId), inline: true },
        { name: 'Group', value: String(details.groupId), inline: true },
        { name: 'Teams Qualified', value: `**${details.qualifiedTeamsCount || details.teams?.length || 0}** team(s)`, inline: true },
        { name: 'Performed By', value: adminDisplay, inline: true },
        { name: 'Time', value: `<t:${nowTs}:F>`, inline: true },
      ];
      break;

    case 'OPEN_GLOBAL_SUBMISSIONS':
      title = 'Submissions Opened';
      color = AUDIT_COLORS.CREATE;
      fields = [
        { name: 'Tournament ID', value: `\`${details.tournamentId}\``, inline: true },
        { name: 'Round', value: String(details.roundId), inline: true },
        { name: 'Scope', value: 'All Groups in Round', inline: true },
        { name: 'Performed By', value: adminDisplay, inline: true },
        { name: 'Time', value: `<t:${nowTs}:F>`, inline: true },
      ];
      break;

    case 'CLOSE_GLOBAL_SUBMISSIONS':
      title = 'Submissions Closed';
      color = AUDIT_COLORS.DELETE;
      fields = [
        { name: 'Tournament ID', value: `\`${details.tournamentId}\``, inline: true },
        { name: 'Round', value: String(details.roundId), inline: true },
        { name: 'Scope', value: 'All Groups in Round', inline: true },
        { name: 'Performed By', value: adminDisplay, inline: true },
        { name: 'Time', value: `<t:${nowTs}:F>`, inline: true },
      ];
      break;

    case 'LINK_ORGANISER':
      title = 'Organiser Linked';
      color = AUDIT_COLORS.CREATE;
      fields = [
        { name: 'Organiser Name', value: details.organiserName || 'Verified Organiser', inline: true },
        { name: 'Organiser ID', value: `\`${details.organiserId}\``, inline: true },
        { name: 'Discord Server', value: details.guildName || `\`${details.guildId}\``, inline: true },
        { name: 'Linked By', value: adminDisplay, inline: true },
        { name: 'Time', value: `<t:${nowTs}:F>`, inline: true },
      ];
      break;

    case 'UNLINK_ORGANISER':
      title = 'Organiser Unlinked';
      color = AUDIT_COLORS.DELETE;
      fields = [
        { name: 'Discord Server', value: `\`${details.guildId}\``, inline: true },
        { name: 'Unlinked By', value: adminDisplay, inline: true },
        { name: 'Preserved State', value: 'Website Tournaments & Channels', inline: true },
        { name: 'Time', value: `<t:${nowTs}:F>`, inline: true },
      ];
      break;

    case 'DELETE_MANAGED_MESSAGES':
      title = 'Bot Messages Cleaned';
      color = AUDIT_COLORS.DELETE;
      fields = [
        { name: 'Filter', value: `\`${JSON.stringify(details.filter || {})}\``, inline: true },
        { name: 'Deleted Messages', value: `**${details.deletedCount || 0}** message(s)`, inline: true },
        { name: 'Admin', value: adminDisplay, inline: true },
        { name: 'Time', value: `<t:${nowTs}:F>`, inline: true },
      ];
      break;

    default:
      title = String(actionType).replace(/_/g, ' ');
      color = AUDIT_COLORS.INFO;
      fields = [
        { name: 'Action', value: actionType, inline: true },
        { name: 'Performed By', value: adminDisplay, inline: true },
        { name: 'Time', value: `<t:${nowTs}:F>`, inline: true },
      ];
      break;
  }

  const embed = createAuditEmbed({
    title,
    color,
    fields,
  });

  await sendAuditLog(guild, 'tournament', embed);
}

