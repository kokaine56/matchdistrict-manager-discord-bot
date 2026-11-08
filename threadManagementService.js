import { PermissionFlagsBits } from 'discord.js';

/**
 * Checks if a member has administrator or manage server permissions.
 * @param {import('discord.js').GuildMember} member
 * @param {import('discord.js').Guild} [guild]
 * @returns {boolean}
 */
export function isThreadAdmin(member, guild = null) {
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
 * Handles the .remove threads command to disable thread creation in a channel
 * independently of ordinary message permissions.
 *
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildMember} member
 * @param {import('discord.js').TextChannel} channel
 * @param {string[]} args
 * @param {(text: string | object, opts?: object) => Promise<any>} replyFn
 * @param {import('discord.js').Client} [client]
 * @param {import('discord.js').Message} [message]
 */
export async function handleRemoveThreadsCommand(guild, member, channel, args, replyFn, client = null, message = null) {
  if (!guild || !channel) {
    return replyFn('❌ This command can only be used inside a Discord server text channel.');
  }

  // 1. Check if user is an administrator (Administrator or Manage Server)
  if (!isThreadAdmin(member, guild)) {
    return replyFn("❌ You don't have permission to use this command.");
  }

  // Target channel (if invoked inside a thread, operate on the parent channel where thread permissions reside)
  const targetChannel = (typeof channel.isThread === 'function' && channel.isThread() && channel.parent)
    ? channel.parent
    : channel;

  // 2. Check if the bot has permission to update channel overwrites (ManageChannels or Administrator)
  const botMember = guild.members?.me || (client?.user?.id ? guild.members?.cache?.get(client.user.id) : null);
  const botPermissions = targetChannel.permissionsFor ? targetChannel.permissionsFor(botMember) : botMember?.permissions;
  const hasManageChannels = botPermissions?.has?.(PermissionFlagsBits.ManageChannels) ||
                            botPermissions?.has?.(PermissionFlagsBits.Administrator) ||
                            (typeof botPermissions?.has === 'function' && (botPermissions.has('ManageChannels') || botPermissions.has('Administrator')));

  if (!hasManageChannels) {
    return replyFn("❌ I cannot update this channel's permissions. Please check my Manage Channels permission.");
  }

  if (!targetChannel.permissionOverwrites || typeof targetChannel.permissionOverwrites.edit !== 'function') {
    return replyFn("❌ I cannot update this channel's permissions. Please check my Manage Channels permission.");
  }

  // 3. Update permissions
  try {
    const everyoneId = guild.roles?.everyone?.id || guild.id;

    // Apply explicit permission denies for @everyone
    // Preserves existing permissions (SendMessages, ViewChannel, ReadMessageHistory, etc.)
    await targetChannel.permissionOverwrites.edit(everyoneId, {
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
    });

    // Update applicable ordinary member roles and members with existing channel overwrites
    if (targetChannel.permissionOverwrites?.cache) {
      for (const [targetId, overwrite] of targetChannel.permissionOverwrites.cache.entries()) {
        if (targetId === everyoneId) continue;

        // Do not modify permissions for the bot
        if (targetId === client?.user?.id || targetId === botMember?.id) continue;

        // Check if overwrite is a role
        const role = guild.roles?.cache?.get(targetId);
        if (role) {
          // Do not modify managed integration roles
          if (role.managed) continue;

          // Do not modify administrator roles
          const isRoleAdmin = role.permissions?.has?.(PermissionFlagsBits.Administrator) ||
                              role.permissions?.has?.(PermissionFlagsBits.ManageGuild) ||
                              (typeof role.permissions?.has === 'function' && (role.permissions.has('Administrator') || role.permissions.has('ManageGuild'))) ||
                              role.name?.toLowerCase() === 'administrator' ||
                              role.name?.toLowerCase() === 'admin';
          if (isRoleAdmin) continue;

          // Applicable ordinary member role: explicitly deny thread creation
          await targetChannel.permissionOverwrites.edit(targetId, {
            CreatePublicThreads: false,
            CreatePrivateThreads: false,
          });
          continue;
        }

        // Check if overwrite is a member
        const memberTarget = guild.members?.cache?.get(targetId);
        if (memberTarget) {
          // Do not modify bot or administrator members
          if (memberTarget.user?.bot || memberTarget.id === client?.user?.id) continue;
          if (isThreadAdmin(memberTarget, guild)) continue;

          // Ordinary member overwrite: explicitly deny thread creation
          await targetChannel.permissionOverwrites.edit(targetId, {
            CreatePublicThreads: false,
            CreatePrivateThreads: false,
          });
        }
      }
    }

    // 4. Log administrator, channel ID, and timestamp
    const adminIdentifier = member?.user?.tag || member?.displayName || member?.id || 'Unknown Admin';
    const timestamp = new Date().toISOString();
    console.log(`[RemoveThreads] Thread creation permissions disabled by administrator ${adminIdentifier} (ID: ${member.id}) in channel ID ${targetChannel.id} at ${timestamp}`);

    return replyFn('✅ Thread creation permissions have been disabled in this channel.');
  } catch (err) {
    console.error(`[RemoveThreads] ❌ Error updating channel permissions in channel ${targetChannel.id}:`, err);
    return replyFn("❌ I cannot update this channel's permissions. Please check my Manage Channels permission.");
  }
}

