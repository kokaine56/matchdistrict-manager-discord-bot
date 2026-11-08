import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits, ChannelType } from 'discord.js';
import { handleRemoveThreadsCommand, isThreadAdmin } from '../threadManagementService.js';

function createMockEnvironment(options = {}) {
  const overwrites = new Map();
  const roles = new Map();
  const members = new Map();
  const guildId = options.guildId || 'guild-threads-123';

  const everyoneRole = {
    id: guildId,
    name: '@everyone',
    permissions: {
      has: () => false,
    },
  };
  roles.set(guildId, everyoneRole);

  const adminRole = {
    id: 'role-admin-1',
    name: 'Administrator',
    permissions: {
      has: (p) => p === PermissionFlagsBits.Administrator || p === 'Administrator',
    },
  };
  roles.set(adminRole.id, adminRole);

  const memberRole = {
    id: 'role-member-1',
    name: 'Member',
    permissions: {
      has: () => false,
    },
  };
  roles.set(memberRole.id, memberRole);

  const botRole = {
    id: 'role-bot-1',
    name: 'BotRole',
    managed: true,
    permissions: {
      has: () => false,
    },
  };
  roles.set(botRole.id, botRole);

  const botMember = {
    id: 'bot-123',
    user: { id: 'bot-123', username: 'MatchDistrictBot', bot: true },
    permissions: {
      has: (p) => options.botHasManageChannels !== false,
    },
  };
  members.set(botMember.id, botMember);

  const channel = {
    id: 'ch-announcements-123',
    name: 'announcements',
    type: ChannelType.GuildText,
    guildId,
    permissionsFor: (target) => {
      if (target?.id === botMember.id) {
        return {
          has: (p) => options.botHasManageChannels !== false,
        };
      }
      return {
        has: () => true,
      };
    },
    permissionOverwrites: {
      cache: overwrites,
      edit: async (targetId, perms) => {
        if (options.throwOnEdit) {
          const err = new Error('Missing Permissions');
          err.code = 50013;
          throw err;
        }
        const existing = overwrites.get(targetId) || { id: targetId, allow: {}, deny: {} };
        const allow = { ...(existing.allow || {}) };
        const deny = { ...(existing.deny || {}) };

        for (const [key, val] of Object.entries(perms)) {
          if (val === true) {
            allow[key] = true;
            delete deny[key];
          } else if (val === false) {
            deny[key] = true;
            delete allow[key];
          }
        }
        const updated = { id: targetId, allow, deny };
        overwrites.set(targetId, updated);
        return channel;
      },
      delete: async (targetId) => {
        overwrites.delete(targetId);
        return channel;
      },
    },
  };

  const guild = {
    id: guildId,
    name: 'MatchDistrict Community',
    ownerId: options.ownerId || 'owner-123',
    roles: {
      everyone: everyoneRole,
      cache: roles,
    },
    members: {
      cache: members,
      me: botMember,
    },
    channels: {
      cache: new Map([[channel.id, channel]]),
    },
  };

  const addMember = (id, username, permissions = {}) => {
    const mem = {
      id,
      guild,
      user: { id, username, bot: Boolean(permissions.bot) },
      displayName: username,
      permissions: {
        has: (p) => {
          if (permissions.isAdmin && (p === PermissionFlagsBits.Administrator || p === 'Administrator')) return true;
          if (permissions.isManageGuild && (p === PermissionFlagsBits.ManageGuild || p === 'ManageGuild')) return true;
          return false;
        },
      },
    };
    members.set(id, mem);
    return mem;
  };

  return { guild, channel, overwrites, roles, members, addMember, botMember };
}

test.describe('.remove threads Command Test Suite', () => {
  test('1. Administrator executes .remove threads: disables thread creation for @everyone while preserving existing message permissions', async () => {
    const env = createMockEnvironment();
    const admin = env.addMember('admin-user', 'AdminUser', { isAdmin: true });

    // Pre-populate @everyone with ViewChannel and SendMessages allowed
    await env.channel.permissionOverwrites.edit(env.guild.roles.everyone.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      AttachFiles: true,
      EmbedLinks: true,
      UseApplicationCommands: true,
    });

    let reply = '';
    await handleRemoveThreadsCommand(env.guild, admin, env.channel, ['threads'], (text) => {
      reply = typeof text === 'string' ? text : text.content;
    });

    assert.equal(reply, '✅ Thread creation permissions have been disabled in this channel.');

    // Verify @everyone has CreatePublicThreads and CreatePrivateThreads explicitly DENIED
    const everyoneOverwrites = env.overwrites.get(env.guild.roles.everyone.id);
    assert.ok(everyoneOverwrites, '@everyone overwrite must exist');
    assert.equal(everyoneOverwrites.deny.CreatePublicThreads, true, 'CreatePublicThreads must be denied');
    assert.equal(everyoneOverwrites.deny.CreatePrivateThreads, true, 'CreatePrivateThreads must be denied');

    // Verify existing permissions were PRESERVED
    assert.equal(everyoneOverwrites.allow.ViewChannel, true, 'ViewChannel must be preserved');
    assert.equal(everyoneOverwrites.allow.SendMessages, true, 'SendMessages must be preserved');
    assert.equal(everyoneOverwrites.allow.ReadMessageHistory, true, 'ReadMessageHistory must be preserved');
    assert.equal(everyoneOverwrites.allow.AttachFiles, true, 'AttachFiles must be preserved');
    assert.equal(everyoneOverwrites.allow.EmbedLinks, true, 'EmbedLinks must be preserved');
    assert.equal(everyoneOverwrites.allow.UseApplicationCommands, true, 'UseApplicationCommands must be preserved');
  });

  test('2. Non-administrator (ordinary member) is rejected with exact permission error', async () => {
    const env = createMockEnvironment();
    const member = env.addMember('regular-user', 'RegularUser', { isAdmin: false });

    let reply = '';
    await handleRemoveThreadsCommand(env.guild, member, env.channel, ['threads'], (text) => {
      reply = typeof text === 'string' ? text : text.content;
    });

    assert.equal(reply, "❌ You don't have permission to use this command.");
    assert.equal(env.overwrites.size, 0, 'No overwrites should be created or modified');
  });

  test('3. Member with Manage Server (ManageGuild) permission can execute the command', async () => {
    const env = createMockEnvironment();
    const manager = env.addMember('manager-user', 'ManagerUser', { isManageGuild: true });

    let reply = '';
    await handleRemoveThreadsCommand(env.guild, manager, env.channel, ['threads'], (text) => {
      reply = typeof text === 'string' ? text : text.content;
    });

    assert.equal(reply, '✅ Thread creation permissions have been disabled in this channel.');
    const everyoneOverwrites = env.overwrites.get(env.guild.roles.everyone.id);
    assert.equal(everyoneOverwrites.deny.CreatePublicThreads, true);
    assert.equal(everyoneOverwrites.deny.CreatePrivateThreads, true);
  });

  test('4. Guild owner can execute the command without explicit Administrator flag', async () => {
    const env = createMockEnvironment({ ownerId: 'owner-special-id' });
    const owner = env.addMember('owner-special-id', 'ServerOwner', { isAdmin: false });

    let reply = '';
    await handleRemoveThreadsCommand(env.guild, owner, env.channel, ['threads'], (text) => {
      reply = typeof text === 'string' ? text : text.content;
    });

    assert.equal(reply, '✅ Thread creation permissions have been disabled in this channel.');
  });

  test('5. Bot lacking Manage Channels permission returns exact bot permission error', async () => {
    const env = createMockEnvironment({ botHasManageChannels: false });
    const admin = env.addMember('admin-user', 'AdminUser', { isAdmin: true });

    let reply = '';
    await handleRemoveThreadsCommand(env.guild, admin, env.channel, ['threads'], (text) => {
      reply = typeof text === 'string' ? text : text.content;
    });

    assert.equal(reply, "❌ I cannot update this channel's permissions. Please check my Manage Channels permission.");
    assert.equal(env.overwrites.size, 0, 'No overwrites should be modified');
  });

  test('6. Discord API permission error during execution returns graceful error message', async () => {
    const env = createMockEnvironment({ throwOnEdit: true });
    const admin = env.addMember('admin-user', 'AdminUser', { isAdmin: true });

    let reply = '';
    await handleRemoveThreadsCommand(env.guild, admin, env.channel, ['threads'], (text) => {
      reply = typeof text === 'string' ? text : text.content;
    });

    assert.equal(reply, "❌ I cannot update this channel's permissions. Please check my Manage Channels permission.");
  });

  test('7. Applicable ordinary member role overwrites have thread creation denied while preserving message & media permissions', async () => {
    const env = createMockEnvironment();
    const admin = env.addMember('admin-user', 'AdminUser', { isAdmin: true });

    // Pre-populate an ordinary member role overwrite with SendMessages and AttachFiles
    await env.channel.permissionOverwrites.edit('role-member-1', {
      ViewChannel: true,
      SendMessages: true,
      AttachFiles: true,
      SendMessagesInThreads: true,
    });

    await handleRemoveThreadsCommand(env.guild, admin, env.channel, ['threads'], () => {});

    const memberRoleOverwrite = env.overwrites.get('role-member-1');
    assert.ok(memberRoleOverwrite, 'Role overwrite must still exist');
    assert.equal(memberRoleOverwrite.deny.CreatePublicThreads, true, 'Ordinary role must have CreatePublicThreads denied');
    assert.equal(memberRoleOverwrite.deny.CreatePrivateThreads, true, 'Ordinary role must have CreatePrivateThreads denied');
    assert.equal(memberRoleOverwrite.allow.SendMessages, true, 'Ordinary role SendMessages must remain allowed');
    assert.equal(memberRoleOverwrite.allow.AttachFiles, true, 'Ordinary role AttachFiles must remain allowed');
    assert.equal(memberRoleOverwrite.allow.SendMessagesInThreads, true, 'SendMessagesInThreads must NOT be removed');
  });

  test('8. Administrator roles and Bot integration roles are NOT modified', async () => {
    const env = createMockEnvironment();
    const admin = env.addMember('admin-user', 'AdminUser', { isAdmin: true });

    // Pre-populate Administrator role and Bot role with allowed thread creation
    await env.channel.permissionOverwrites.edit('role-admin-1', {
      CreatePublicThreads: true,
      CreatePrivateThreads: true,
      ManageChannels: true,
    });

    await env.channel.permissionOverwrites.edit('role-bot-1', {
      CreatePublicThreads: true,
      CreatePrivateThreads: true,
      ManageMessages: true,
    });

    await handleRemoveThreadsCommand(env.guild, admin, env.channel, ['threads'], () => {});

    // Administrator role must NOT have been modified
    const adminOverwrite = env.overwrites.get('role-admin-1');
    assert.equal(adminOverwrite.allow.CreatePublicThreads, true, 'Admin role CreatePublicThreads must NOT be denied');
    assert.equal(adminOverwrite.allow.CreatePrivateThreads, true, 'Admin role CreatePrivateThreads must NOT be denied');
    assert.equal(adminOverwrite.deny.CreatePublicThreads, undefined);

    // Bot role must NOT have been modified
    const botOverwrite = env.overwrites.get('role-bot-1');
    assert.equal(botOverwrite.allow.CreatePublicThreads, true, 'Bot role CreatePublicThreads must NOT be denied');
    assert.equal(botOverwrite.allow.CreatePrivateThreads, true, 'Bot role CreatePrivateThreads must NOT be denied');
  });

  test('9. Safe to execute multiple times (idempotency)', async () => {
    const env = createMockEnvironment();
    const admin = env.addMember('admin-user', 'AdminUser', { isAdmin: true });

    let reply1 = '';
    await handleRemoveThreadsCommand(env.guild, admin, env.channel, ['threads'], (text) => {
      reply1 = typeof text === 'string' ? text : text.content;
    });
    assert.equal(reply1, '✅ Thread creation permissions have been disabled in this channel.');

    let reply2 = '';
    await handleRemoveThreadsCommand(env.guild, admin, env.channel, ['threads'], (text) => {
      reply2 = typeof text === 'string' ? text : text.content;
    });
    assert.equal(reply2, '✅ Thread creation permissions have been disabled in this channel.');

    const everyoneOverwrites = env.overwrites.get(env.guild.roles.everyone.id);
    assert.equal(everyoneOverwrites.deny.CreatePublicThreads, true);
    assert.equal(everyoneOverwrites.deny.CreatePrivateThreads, true);
  });

  test('10. Executed inside a thread targets parent channel where thread permissions reside', async () => {
    const env = createMockEnvironment();
    const admin = env.addMember('admin-user', 'AdminUser', { isAdmin: true });

    // Mock thread channel whose parent is env.channel
    const threadChannel = {
      id: 'thread-456',
      name: 'Discussion Thread',
      type: ChannelType.PublicThread,
      parent: env.channel,
      isThread: () => true,
      guildId: env.guild.id,
      permissionsFor: env.channel.permissionsFor,
    };

    let reply = '';
    await handleRemoveThreadsCommand(env.guild, admin, threadChannel, ['threads'], (text) => {
      reply = typeof text === 'string' ? text : text.content;
    });

    assert.equal(reply, '✅ Thread creation permissions have been disabled in this channel.');
    const everyoneOverwrites = env.overwrites.get(env.guild.roles.everyone.id);
    assert.equal(everyoneOverwrites.deny.CreatePublicThreads, true, 'Parent channel @everyone must have CreatePublicThreads denied');
    assert.equal(everyoneOverwrites.deny.CreatePrivateThreads, true, 'Parent channel @everyone must have CreatePrivateThreads denied');
  });

  test('11. Ordinary member-specific overwrite has thread creation denied while admin member overwrite is preserved', async () => {
    const env = createMockEnvironment();
    const admin = env.addMember('admin-user', 'AdminUser', { isAdmin: true });
    const regularMember = env.addMember('reg-target', 'RegularTarget', { isAdmin: false });
    const adminMember = env.addMember('admin-target', 'AdminTarget', { isAdmin: true });

    // Pre-populate overwrites for both members
    await env.channel.permissionOverwrites.edit(regularMember.id, {
      ViewChannel: true,
      SendMessages: true,
      CreatePublicThreads: true,
    });
    await env.channel.permissionOverwrites.edit(adminMember.id, {
      ViewChannel: true,
      SendMessages: true,
      CreatePublicThreads: true,
    });

    await handleRemoveThreadsCommand(env.guild, admin, env.channel, ['threads'], () => {});

    // Regular member must have CreatePublicThreads and CreatePrivateThreads denied, SendMessages allowed
    const regOverwrite = env.overwrites.get(regularMember.id);
    assert.equal(regOverwrite.deny.CreatePublicThreads, true);
    assert.equal(regOverwrite.deny.CreatePrivateThreads, true);
    assert.equal(regOverwrite.allow.SendMessages, true);

    // Admin member must NOT be modified
    const adminTargetOverwrite = env.overwrites.get(adminMember.id);
    assert.equal(adminTargetOverwrite.allow.CreatePublicThreads, true);
    assert.equal(adminTargetOverwrite.deny.CreatePublicThreads, undefined);
  });

  test('12. Help command includes .remove threads in administrator section', async () => {
    const { getHelpResponse } = await import('../index.js');
    const help = getHelpResponse('.');
    assert.match(help, /\.remove threads/);
    assert.match(help, /Disable thread creation permissions in this channel/);
  });
});
