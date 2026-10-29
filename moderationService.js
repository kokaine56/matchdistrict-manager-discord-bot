import {
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { queueChannelSend, queueMessageDelete } from './discordQueue.js';
import { checkAbusiveWord } from './badWordsConfig.js';
import { getGuildChannelId, isModerationEnabled, isAdmin } from './index.js';

/**
 * Regex detecting:
 * - http:// and https:// URLs
 * - www. URLs
 * - Discord invite links (discord.gg, discord.com/invite, discordapp.com/invite)
 * - Domain-style links with common extensions
 */
export const LINK_REGEX = /(?:https?:\/\/|www\.)[^\s]+|discord(?:\.gg|(?:app)?\.com\/invite)\/[^\s]+|\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|in|io|co|xyz|gg|me|dev|app|info|biz|link|site|top|online|tech|club|live|pro|agency|tv|to|is|ru|uk|de|us|ca)(?::\d+)?(?:\/[^\s]*)?/i;

/**
 * Checks if a string contains any prohibited link.
 * @param {string} text
 * @returns {boolean}
 */
export function containsLink(text) {
  if (!text || typeof text !== 'string') return false;
  return LINK_REGEX.test(text);
}

/**
 * Extracts a numeric user ID or user identifier from a raw string or mention (<@123456> or <@!123456>).
 * @param {string} input
 * @returns {string|null}
 */
export function extractUserId(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  const mentionMatch = trimmed.match(/^<@!?([^\s>]+)>$/);
  if (mentionMatch) return mentionMatch[1];
  const snowflakeMatch = trimmed.match(/^\d{15,22}$/);
  if (snowflakeMatch) return snowflakeMatch[0];
  return trimmed.replace(/^@/, '') || null;
}

/**
 * Verifies that the bot possesses the necessary permissions for moderation.
 * Logs a clear warning/error if any required permissions are missing.
 *
 * @param {import('discord.js').Guild} guild
 * @returns {{ valid: boolean, missing: string[] }}
 */
export function verifyBotModerationPermissions(guild) {
  if (!guild?.members?.me) return { valid: false, missing: ['Bot Member Unavailable'] };

  const botPermissions = guild.members.me.permissions;
  const missing = [];

  if (!botPermissions.has(PermissionFlagsBits.ManageMessages)) {
    missing.push('Manage Messages');
  }
  if (!botPermissions.has(PermissionFlagsBits.ModerateMembers)) {
    missing.push('Moderate Members');
  }
  if (!botPermissions.has(PermissionFlagsBits.BanMembers)) {
    missing.push('Ban Members');
  }

  if (missing.length > 0) {
    console.error(
      `[Discord Bot] ❌ [Moderation] Missing permissions in server "${guild.name}" (${guild.id}): ${missing.join(', ')}. Some moderation features may fail.`
    );
  }

  return {
    valid: missing.length === 0,
    missing,
  };
}

/**
 * Dispatches a formatted moderation log embed to the server's #mod-log channel.
 * Looks up the channel by ID stored in MongoDB.
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} options
 * @param {string} options.action
 * @param {object} options.user
 * @param {object} [options.channel]
 * @param {string} options.reason
 * @param {string} [options.content]
 * @param {object} [options.moderator]
 * @param {string} [options.extraNote]
 * @param {number} [options.color]
 */
export async function sendModLog(guild, options) {
  if (!guild) return null;

  try {
    const modLogChannelId = getGuildChannelId(guild.id, 'modLogId');
    if (!modLogChannelId) {
      return null;
    }

    const modLogChannel =
      guild.channels.cache.get(modLogChannelId) ||
      (typeof guild.channels?.fetch === 'function'
        ? await guild.channels.fetch(modLogChannelId).catch(() => null)
        : null);

    if (!modLogChannel) {
      return null;
    }

    const embed = new EmbedBuilder()
      .setTitle(`🛡️ Moderation: ${options.action}`)
      .setColor(options.color || 0xed4245)
      .setTimestamp(new Date());

    if (options.user) {
      embed.addFields({
        name: '👤 Target User',
        value: `<@${options.user.id}> (${options.user.tag || options.user.username || options.user.id})\nID: \`${options.user.id}\``,
        inline: true,
      });
    }

    if (options.moderator) {
      embed.addFields({
        name: '👮 Moderator',
        value: `<@${options.moderator.id}> (${options.moderator.tag || options.moderator.username || options.moderator.id})`,
        inline: true,
      });
    }

    if (options.channel) {
      embed.addFields({
        name: '📍 Channel',
        value: `<#${options.channel.id}> (\`#${options.channel.name || 'channel'}\`)`,
        inline: true,
      });
    }

    if (options.reason) {
      embed.addFields({
        name: '📋 Reason',
        value: String(options.reason),
        inline: false,
      });
    }

    if (options.extraNote) {
      embed.addFields({
        name: 'ℹ️ Status Note',
        value: String(options.extraNote),
        inline: false,
      });
    }

    if (options.content) {
      const sanitized = String(options.content).slice(0, 1000);
      embed.addFields({
        name: '💬 Message Content',
        value: `\`\`\`\n${sanitized}\n\`\`\``,
        inline: false,
      });
    }

    embed.setFooter({ text: 'MatchDistrict Server Moderation' });

    return await queueChannelSend(modLogChannel, { embeds: [embed] });
  } catch (err) {
    console.warn(`[Discord Bot] ⚠️ Error sending to mod-log in guild ${guild.id}:`, err.message);
    return null;
  }
}

/**
 * Handles link blocking and abusive word filtering on message create.
 *
 * @param {import('discord.js').Message} message
 * @returns {Promise<boolean>} True if message was moderated and handled
 */
export async function handleMessageModeration(message) {
  if (!message || !message.guild || message.author?.bot) {
    return false;
  }

  // Before .setup runs, moderation does nothing
  if (!isModerationEnabled(message.guild.id)) {
    return false;
  }

  const content = message.content || '';

  // 1. LINK BLOCKING CHECK
  if (containsLink(content)) {
    // Delete message
    await queueMessageDelete(message).catch((delErr) => {
      console.warn('[Moderation] ⚠️ Failed to delete link message:', delErr.message);
    });

    // Timeout user for 2 minutes (120,000 ms)
    let timeoutNote = '';
    const isOwner = message.guild.ownerId === message.author.id;
    const isAdministrator = isAdmin(message.member);

    if (isOwner) {
      timeoutNote = 'Timeout not possible: User is server owner';
    } else if (isAdministrator) {
      timeoutNote = 'Timeout not possible: User is an administrator';
    } else {
      try {
        if (typeof message.member?.timeout === 'function') {
          await message.member.timeout(120 * 1000, 'Sending prohibited links in server');
          timeoutNote = 'User timed out for 2 minutes';
        } else {
          timeoutNote = 'Timeout not supported on member object';
        }
      } catch (timeoutErr) {
        timeoutNote = `Timeout not possible: ${timeoutErr.message}`;
      }
    }

    await sendModLog(message.guild, {
      action: 'Link Blocked & Timeout',
      user: message.author,
      channel: message.channel,
      reason: 'Everyone is blocked from sending links in the server.',
      content,
      extraNote: timeoutNote,
      color: 0xed4245,
    });

    return true;
  }

  // 2. ABUSIVE WORDS CHECK
  const matchedBadWord = checkAbusiveWord(content);
  if (matchedBadWord) {
    // Delete message
    await queueMessageDelete(message).catch((delErr) => {
      console.warn('[Moderation] ⚠️ Failed to delete abusive message:', delErr.message);
    });

    await sendModLog(message.guild, {
      action: 'Abusive Word Blocked',
      user: message.author,
      channel: message.channel,
      reason: `Prohibited abusive word detected: "${matchedBadWord}"`,
      content,
      color: 0xe74c3c,
    });

    return true;
  }

  return false;
}

/**
 * Handles link blocking and abusive word filtering on message edits.
 *
 * @param {import('discord.js').Message} oldMessage
 * @param {import('discord.js').Message} newMessage
 * @returns {Promise<boolean>} True if edited message was moderated and handled
 */
export async function handleMessageUpdateModeration(oldMessage, newMessage) {
  if (!newMessage || !newMessage.guild || newMessage.author?.bot) {
    return false;
  }

  if (!isModerationEnabled(newMessage.guild.id)) {
    return false;
  }

  const content = newMessage.content || '';

  // Check link blocking on edited content
  if (containsLink(content)) {
    await queueMessageDelete(newMessage).catch(() => {});

    let timeoutNote = '';
    const isOwner = newMessage.guild.ownerId === newMessage.author.id;
    const isAdministrator = isAdmin(newMessage.member);

    if (isOwner) {
      timeoutNote = 'Timeout not possible: User is server owner';
    } else if (isAdministrator) {
      timeoutNote = 'Timeout not possible: User is an administrator';
    } else {
      try {
        if (typeof newMessage.member?.timeout === 'function') {
          await newMessage.member.timeout(120 * 1000, 'Sending prohibited links in edited message');
          timeoutNote = 'User timed out for 2 minutes';
        }
      } catch (timeoutErr) {
        timeoutNote = `Timeout not possible: ${timeoutErr.message}`;
      }
    }

    await sendModLog(newMessage.guild, {
      action: 'Link Blocked in Edited Message',
      user: newMessage.author,
      channel: newMessage.channel,
      reason: 'Prohibited link added in edited message.',
      content,
      extraNote: timeoutNote,
      color: 0xed4245,
    });

    return true;
  }

  // Check abusive words on edited content
  const matchedBadWord = checkAbusiveWord(content);
  if (matchedBadWord) {
    await queueMessageDelete(newMessage).catch(() => {});

    await sendModLog(newMessage.guild, {
      action: 'Abusive Word Blocked in Edited Message',
      user: newMessage.author,
      channel: newMessage.channel,
      reason: `Prohibited abusive word detected in edited message: "${matchedBadWord}"`,
      content,
      color: 0xe74c3c,
    });

    return true;
  }

  return false;
}

/**
 * Handles the .unmute command.
 * Removes timeout from a user.
 *
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildMember} member
 * @param {import('discord.js').TextChannel} channel
 * @param {string[]} args
 * @param {(msg: string|object) => Promise<any>} replyFn
 */
export async function handleUnmuteCommand(guild, member, channel, args, replyFn) {
  if (!guild) {
    return replyFn('❌ This command can only be executed within a server.');
  }

  // 1. Permission check: Administrator or Moderate Members
  const hasPerm =
    member?.permissions?.has(PermissionFlagsBits.Administrator) ||
    member?.permissions?.has(PermissionFlagsBits.ModerateMembers);

  if (!hasPerm) {
    return replyFn(
      '❌ **Permission Denied:** You need `Administrator` or `Moderate Members` permission to unmute users.'
    );
  }

  // 2. Check bot permission
  if (!guild.members.me?.permissions?.has(PermissionFlagsBits.ModerateMembers)) {
    console.error(`[Moderation] ❌ Missing "Moderate Members" permission in guild ${guild.id}`);
    return replyFn(
      '❌ **Bot Missing Permission:** I need the `Moderate Members` permission to remove timeouts.'
    );
  }

  // 3. Parse target user
  const targetId = extractUserId(args[0]);
  if (!targetId) {
    return replyFn('ℹ️ **Usage:** `.unmute <@user|userId>` — Remove timeout from a user.');
  }

  const targetMember = await guild.members.fetch(targetId).catch(() => null);
  if (!targetMember) {
    return replyFn(`❌ Could not find member with ID \`${targetId}\` in this server.`);
  }

  // 4. Check if currently timed out
  const isTimedOut = Boolean(
    (typeof targetMember.isCommunicationDisabled === 'function' &&
      targetMember.isCommunicationDisabled()) ||
      (targetMember.communicationDisabledUntilTimestamp &&
        targetMember.communicationDisabledUntilTimestamp > Date.now())
  );

  if (!isTimedOut) {
    return replyFn(`ℹ️ **<@${targetMember.id}> is not currently timed out.**`);
  }

  // 5. Remove timeout
  try {
    await targetMember.timeout(null, `Unmuted by ${member.user?.tag || member.id}`);
  } catch (err) {
    console.error(`[Moderation] ❌ Failed to unmute member ${targetMember.id}:`, err);
    return replyFn(`❌ Failed to remove timeout: ${err.message}`);
  }

  // 6. Confirm and log
  await replyFn(`✅ **Successfully unmuted <@${targetMember.id}>.**`);

  await sendModLog(guild, {
    action: 'Member Unmuted',
    user: targetMember.user,
    moderator: member.user,
    channel,
    reason: `Timeout removed via .unmute by ${member.user?.tag || member.id}`,
    color: 0x2ecc71,
  });
}

/**
 * Handles the .unban command.
 * Unbans a user by ID or mention.
 *
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildMember} member
 * @param {import('discord.js').TextChannel} channel
 * @param {string[]} args
 * @param {(msg: string|object) => Promise<any>} replyFn
 */
export async function handleUnbanCommand(guild, member, channel, args, replyFn) {
  if (!guild) {
    return replyFn('❌ This command can only be executed within a server.');
  }

  // 1. Permission check: Administrator or Ban Members
  const hasPerm =
    member?.permissions?.has(PermissionFlagsBits.Administrator) ||
    member?.permissions?.has(PermissionFlagsBits.BanMembers);

  if (!hasPerm) {
    return replyFn(
      '❌ **Permission Denied:** You need `Administrator` or `Ban Members` permission to unban users.'
    );
  }

  // 2. Check bot permission
  if (!guild.members.me?.permissions?.has(PermissionFlagsBits.BanMembers)) {
    console.error(`[Moderation] ❌ Missing "Ban Members" permission in guild ${guild.id}`);
    return replyFn(
      '❌ **Bot Missing Permission:** I need the `Ban Members` permission to unban members.'
    );
  }

  // 3. Parse target user
  const targetId = extractUserId(args[0]);
  if (!targetId) {
    return replyFn('ℹ️ **Usage:** `.unban <@user|userId>` — Unban a user from the server.');
  }

  // 4. Check if currently banned
  let banInfo = null;
  try {
    banInfo = await guild.bans.fetch(targetId).catch(() => null);
  } catch (banErr) {
    banInfo = null;
  }

  if (!banInfo) {
    return replyFn(`ℹ️ **User with ID \`${targetId}\` is not currently banned.**`);
  }

  // 5. Unban user
  try {
    await guild.bans.remove(targetId, `Unbanned by ${member.user?.tag || member.id}`);
  } catch (err) {
    console.error(`[Moderation] ❌ Failed to unban user ${targetId}:`, err);
    return replyFn(`❌ Failed to unban user: ${err.message}`);
  }

  // 6. Confirm and log
  await replyFn(`✅ **Successfully unbanned <@${targetId}> (\`${targetId}\`).**`);

  await sendModLog(guild, {
    action: 'Member Unbanned',
    user: banInfo.user || { id: targetId, tag: `User#${targetId.slice(-4)}` },
    moderator: member.user,
    channel,
    reason: `Ban removed via .unban by ${member.user?.tag || member.id}`,
    color: 0x2ecc71,
  });
}
