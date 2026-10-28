import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PermissionFlagsBits,
  ChannelType,
} from 'discord.js';

import {
  PREFIX,
  REQUIRED_CHANNELS,
  redactSecrets,
  isAuditOrLogChannel,
  isAdmin,
  isSetupActive,
  isWelcomeEnabled,
  setWelcomeEnabled,
  getGuildChannelId,
  getGuildChannels,
  guildSettingsCache,
  loadGuildSettings,
  recentBans,
  recentJoins,
  pendingSetupRemovals,
  handleSetupCommand,
  handleSetupRemoveCommand,
  handleSetupConfirmCommand,
  handleSetupCancelCommand,
  handleDmCommand,
  handleBanCommand,
  handleClearCommand,
  handleStatusCommand,
  handleMessageCreateLog,
  handleMessageUpdateLog,
  handleMessageDeleteLog,
  handleGuildBanAdd,
  handleGuildBanRemove,
  handleGuildMemberAdd,
  getHelpResponse,
} from '../index.js';

// Helper mock builders
function createMockGuild(options = {}) {
  const channels = new Map();
  const members = new Map();
  const bans = new Map();

  const guild = {
    id: options.id || 'guild-123456789012345678',
    name: options.name || 'MatchDistrict Test Guild',
    ownerId: options.ownerId || 'owner-123456789012345678',
    roles: {
      everyone: { id: options.id || 'guild-123456789012345678' },
    },
    channels: {
      cache: {
        get: (id) => channels.get(id),
        find: (predicate) => {
          for (const ch of channels.values()) {
            if (predicate(ch)) return ch;
          }
          return null;
        },
        values: () => channels.values(),
      },
      create: async (data) => {
        const id = data.id || 'ch-' + Math.random().toString(36).substring(2, 9);
        const channelMessages = [];
        const newChannel = {
          id,
          name: data.name,
          type: data.type,
          topic: data.topic,
          guildId: guild.id,
          guild: { id: guild.id },
          deleted: false,
          permissionOverwrites: {
            set: async (overwrites) => {
              newChannel._overwrites = overwrites;
              return newChannel;
            },
          },
          permissionsFor: (target) => ({
            has: (perm) => true,
          }),
          send: async (msg) => {
            channelMessages.push(typeof msg === 'object' ? msg.content : msg);
            return { id: 'msg-' + Date.now(), content: msg, delete: async () => {} };
          },
          bulkDelete: async (amount, filterOld) => {
            return { size: amount };
          },
          delete: async (reason) => {
            if (data.failDelete) {
              throw new Error('Missing Permissions to delete channel');
            }
            newChannel.deleted = true;
            channels.delete(id);
            return newChannel;
          },
          messages: channelMessages,
        };
        channels.set(id, newChannel);
        return newChannel;
      },
    },
    members: {
      cache: members,
      me: {
        id: 'bot-999999999999999999',
        permissions: {
          has: (perm) => (options.botMissingPerms ? false : true),
        },
        roles: {
          highest: { position: 50 },
        },
      },
      fetch: async (id) => {
        if (members.has(id)) return members.get(id);
        throw new Error('Member not found');
      },
    },
    client: {
      user: {
        id: 'bot-999999999999999999',
        tag: 'MatchDistrictBot#0001',
      },
      users: {
        fetch: async (id) => ({
          id,
          tag: `User_${id}#0000`,
          username: `User_${id}`,
        }),
      },
    },
    bans: {
      create: async (userId, banOpts) => {
        bans.set(userId, banOpts);
        return { user: { id: userId }, reason: banOpts?.reason };
      },
    },
    fetchAuditLogs: async (opts) => {
      return {
        entries: options.auditLogEntries || {
          first: () => null,
          find: () => null,
        },
      };
    },
  };

  return { guild, channels, members, bans };
}

function createMockMember(options = {}) {
  return {
    id: options.id || 'mem-111111111111111111',
    user: {
      id: options.id || 'mem-111111111111111111',
      tag: options.tag || 'Tester#1234',
      bot: Boolean(options.bot),
      createdTimestamp: Date.now() - 10000000,
    },
    displayName: options.displayName || 'Tester',
    permissions: {
      has: (perm) => Boolean(options.isAdmin || (options.perms && options.perms.includes(perm))),
    },
    roles: {
      highest: { position: options.rolePos !== undefined ? options.rolePos : 10 },
    },
    bannable: options.bannable !== undefined ? options.bannable : true,
    send: async (msg) => {
      if (options.failDM) {
        const err = new Error('Cannot send messages to this user');
        err.code = 50007;
        throw err;
      }
      return { id: 'dm-' + Date.now(), content: msg };
    },
  };
}

// ------------------- TESTS -------------------

test('1. Security & Redaction: redactSecrets removes bot tokens and secrets', () => {
  const sample = 'Here is a token: MTA2MDExMTIyMjMzMzQ0NDU1NQ.GaBcDe.1234567890abcdef1234567890a and password=SuperSecretPassword123!';
  const sanitized = redactSecrets(sample);
  assert.ok(!sanitized.includes('MTA2MDExMTIyMjMzMzQ0NDU1NQ'));
  assert.ok(!sanitized.includes('SuperSecretPassword123!'));
  assert.ok(sanitized.includes('[REDACTED_TOKEN]'));
  assert.ok(sanitized.includes('[REDACTED_SECRET]'));
});

test('2. Authorization: isAdmin detects Administrator and ManageGuild', () => {
  const adminMember = createMockMember({ isAdmin: true });
  const nonAdminMember = createMockMember({ isAdmin: false, perms: [] });
  const manageGuildMember = createMockMember({ perms: [PermissionFlagsBits.ManageGuild] });

  assert.strictEqual(isAdmin(adminMember), true);
  assert.strictEqual(isAdmin(nonAdminMember), false);
  assert.strictEqual(isAdmin(manageGuildMember), true);
});

test('3. .setup: rejects unauthorized members', async () => {
  const { guild } = createMockGuild();
  const nonAdmin = createMockMember({ isAdmin: false });
  let reply = '';

  await handleSetupCommand(guild, nonAdmin, async (msg) => {
    reply = msg;
  });

  assert.ok(reply.includes('Permission Denied'));
});

test('4. .setup: rejects when bot lacks Manage Channels permission', async () => {
  const { guild } = createMockGuild({ botMissingPerms: true });
  const admin = createMockMember({ isAdmin: true });
  let reply = '';

  await handleSetupCommand(guild, admin, async (msg) => {
    reply = msg;
  });

  assert.ok(reply.includes('Bot Permission Missing'));
});

test('5. .setup: creates all 4 required channels idempotently', async () => {
  const { guild, channels } = createMockGuild();
  const admin = createMockMember({ isAdmin: true });
  let reply1 = '';

  // First execution -> creates 4 channels
  await handleSetupCommand(guild, admin, async (msg) => {
    reply1 = msg;
  });

  assert.ok(reply1.includes('Setup Complete'));
  assert.ok(reply1.includes('Created Channels'));
  assert.strictEqual(channels.size, 4);
  assert.strictEqual(isSetupActive(guild.id), true);

  // Check channel names
  const channelNames = Array.from(channels.values()).map((c) => c.name);
  assert.ok(channelNames.includes('bot-preview'));
  assert.ok(channelNames.includes('dm-log'));
  assert.ok(channelNames.includes('msg-log'));
  assert.ok(channelNames.includes('ban-unban-log'));

  // Check that #bot-preview received the initial dashboard message
  const botPreviewCh = Array.from(channels.values()).find((c) => c.name === 'bot-preview');
  assert.ok(botPreviewCh.messages.length >= 1);
  assert.ok(botPreviewCh.messages[0].includes('Management Dashboard'));

  // Second execution -> must REUSE existing channels, no new channels created
  let reply2 = '';
  await handleSetupCommand(guild, admin, async (msg) => {
    reply2 = msg;
  });

  assert.ok(reply2.includes('Setup Complete'));
  assert.ok(reply2.includes('Reused Channels'));
  assert.strictEqual(channels.size, 4, 'Channel count must not increase on re-running .setup');
});

test('6. .dm welcome on/off: controls welcome DMs and persists setting per guild', async () => {
  const { guild } = createMockGuild({ id: 'guild-test-dm' });
  const admin = createMockMember({ isAdmin: true });
  const nonAdmin = createMockMember({ isAdmin: false });

  // Non-admin rejected
  let reply = '';
  await handleDmCommand(guild, nonAdmin, ['welcome', 'on'], async (msg) => {
    reply = msg;
  });
  assert.ok(reply.includes('Permission Denied'));

  // Admin enables welcome
  await handleDmCommand(guild, admin, ['welcome', 'on'], async (msg) => {
    reply = msg;
  });
  assert.ok(reply.includes('Welcome DMs Enabled'));
  assert.strictEqual(isWelcomeEnabled('guild-test-dm'), true);

  // Admin disables welcome
  await handleDmCommand(guild, admin, ['welcome', 'off'], async (msg) => {
    reply = msg;
  });
  assert.ok(reply.includes('Welcome DMs Disabled'));
  assert.strictEqual(isWelcomeEnabled('guild-test-dm'), false);

  // Guild isolation: check another guild is unchanged
  assert.strictEqual(isWelcomeEnabled('other-guild-id'), false);
});

test('7. Welcome DM flow: sends DM when enabled and logs to #dm-log', async () => {
  const { guild } = createMockGuild({ id: 'guild-welcome-flow' });
  setWelcomeEnabled(guild.id, true);

  // Run setup so setup is active
  const admin = createMockMember({ isAdmin: true });
  await handleSetupCommand(guild, admin, async () => {});

  const dmLogId = getGuildChannelId(guild.id, 'dmLogId');
  const dmLog = guild.channels.cache.get(dmLogId);

  const newMember = createMockMember({ id: 'new-user-123', tag: 'NewGamer#0001' });
  newMember.guild = guild;

  // Process join
  await handleGuildMemberAdd(newMember);

  assert.ok(dmLog.messages.length > 0);
  assert.ok(dmLog.messages[0].includes('Welcome DM Delivered'));
  assert.ok(dmLog.messages[0].includes('NewGamer#0001'));
});

test('8. Welcome DM flow: handles closed DMs (50007) gracefully without crashing', async () => {
  const { guild } = createMockGuild({ id: 'guild-welcome-fail' });
  setWelcomeEnabled(guild.id, true);

  const admin = createMockMember({ isAdmin: true });
  await handleSetupCommand(guild, admin, async () => {});

  const dmLogId = getGuildChannelId(guild.id, 'dmLogId');
  const dmLog = guild.channels.cache.get(dmLogId);

  // User with failDM = true throws error 50007
  const closedDmMember = createMockMember({ id: 'blocked-user-999', tag: 'PrivateUser#9999', failDM: true });
  closedDmMember.guild = guild;

  // Must not throw
  await handleGuildMemberAdd(closedDmMember);

  assert.ok(dmLog.messages.length > 0);
  assert.ok(dmLog.messages[0].includes('Welcome DM Delivery Failed'));
  assert.ok(dmLog.messages[0].includes('PrivateUser#9999'));
});

test('9. Welcome DM flow: skips when welcome DMs are disabled', async () => {
  const { guild } = createMockGuild({ id: 'guild-welcome-disabled' });
  setWelcomeEnabled(guild.id, false);

  const admin = createMockMember({ isAdmin: true });
  await handleSetupCommand(guild, admin, async () => {});

  const dmLogId = getGuildChannelId(guild.id, 'dmLogId');
  const dmLog = guild.channels.cache.get(dmLogId);

  const member = createMockMember({ id: 'user-no-dm' });
  member.guild = guild;

  await handleGuildMemberAdd(member);
  assert.strictEqual(dmLog.messages.length, 0);
});

test('10. .ban: enforces permissions and role hierarchy', async () => {
  const { guild, members, bans } = createMockGuild();
  const mod = createMockMember({
    id: 'mod-1',
    perms: [PermissionFlagsBits.BanMembers],
    rolePos: 20,
  });

  // Target higher role than mod
  const higherAdmin = createMockMember({
    id: 'higher-admin-2',
    rolePos: 30,
  });
  members.set(higherAdmin.id, higherAdmin);

  let reply = '';
  await handleBanCommand(guild, mod, [higherAdmin.id, 'Test Reason'], async (msg) => {
    reply = msg;
  });
  assert.ok(reply.includes('Role Hierarchy Restriction'));
  assert.strictEqual(bans.size, 0);

  // Target cannot ban self
  await handleBanCommand(guild, mod, [mod.id], async (msg) => {
    reply = msg;
  });
  assert.ok(reply.includes('cannot ban yourself'));

  // Target cannot ban server owner
  await handleBanCommand(guild, mod, [guild.ownerId], async (msg) => {
    reply = msg;
  });
  assert.ok(reply.includes('Cannot ban the server owner'));

  // Target cannot ban bot
  await handleBanCommand(guild, mod, [guild.client.user.id], async (msg) => {
    reply = msg;
  });
  assert.ok(reply.includes('cannot ban myself'));
});

test('11. .ban: successfully bans valid member and logs to #ban-unban-log with duplicate prevention', async () => {
  const { guild, members, bans } = createMockGuild();
  const admin = createMockMember({ isAdmin: true });
  await handleSetupCommand(guild, admin, async () => {});

  const banLogId = getGuildChannelId(guild.id, 'banUnbanLogId');
  const banLog = guild.channels.cache.get(banLogId);

  const mod = createMockMember({
    id: 'mod-exec',
    perms: [PermissionFlagsBits.BanMembers],
    rolePos: 40,
  });

  const target = createMockMember({
    id: 'target-to-ban',
    rolePos: 5,
  });
  members.set(target.id, target);

  let reply = '';
  await handleBanCommand(guild, mod, [`<@${target.id}>`, 'Violating terms'], async (msg) => {
    reply = msg;
  });

  assert.ok(reply.includes('Successfully banned'));
  assert.strictEqual(bans.has(target.id), true);
  assert.ok(banLog.messages.length > 0);
  assert.ok(banLog.messages[0].includes('Member Banned'));
  assert.ok(banLog.messages[0].includes('Violating terms'));

  // Check recentBans cache marked logged = true
  const cacheKey = `${guild.id}:${target.id}`;
  const cached = recentBans.get(cacheKey);
  assert.ok(cached !== undefined);
  assert.strictEqual(cached.logged, true);

  // Subsequent GuildBanAdd event must NOT log duplicate
  const initialLogCount = banLog.messages.length;
  await handleGuildBanAdd({
    guild,
    user: { id: target.id, tag: 'target#0001' },
    reason: 'Violating terms',
  });
  assert.strictEqual(banLog.messages.length, initialLogCount, 'GuildBanAdd must not duplicate log when command already logged');
});

test('12. Native ban & unban: logs external actions to #ban-unban-log', async () => {
  const { guild } = createMockGuild();
  const admin = createMockMember({ isAdmin: true });
  await handleSetupCommand(guild, admin, async () => {});

  const banLogId = getGuildChannelId(guild.id, 'banUnbanLogId');
  const banLog = guild.channels.cache.get(banLogId);

  // External ban not present in recentBans
  await handleGuildBanAdd({
    guild,
    user: { id: 'ext-user-123', tag: 'ExtUser#0001' },
    reason: 'Discord native UI ban',
  });

  assert.ok(banLog.messages.some((m) => m.includes('Member Banned') && m.includes('ext-user-123')));

  // Unban event
  await handleGuildBanRemove({
    guild,
    user: { id: 'ext-user-123', tag: 'ExtUser#0001' },
  });

  assert.ok(banLog.messages.some((m) => m.includes('Member Unbanned') && m.includes('ext-user-123')));
});

test('13. .clear: validates input and prevents deletion in audit channels', async () => {
  const { guild } = createMockGuild();
  const admin = createMockMember({ isAdmin: true });
  await handleSetupCommand(guild, admin, async () => {});

  const mod = createMockMember({
    perms: [PermissionFlagsBits.ManageMessages],
  });

  const generalCh = await guild.channels.create({
    name: 'general',
    type: ChannelType.GuildText,
  });

  const msgLogId = getGuildChannelId(guild.id, 'msgLogId');
  const auditCh = guild.channels.cache.get(msgLogId);

  // Attempt clear in audit channel -> prohibited
  let reply = '';
  await handleClearCommand(guild, mod, auditCh, ['20'], async (msg) => {
    reply = msg;
  });
  assert.ok(reply.includes('Safety Restriction'));

  // Attempt invalid clear amount
  await handleClearCommand(guild, mod, generalCh, ['invalid'], async (msg) => {
    reply = msg;
  });
  assert.ok(reply.includes('Invalid Argument'));

  // Attempt out of range amount (> 100)
  await handleClearCommand(guild, mod, generalCh, ['150'], async (msg) => {
    reply = msg;
  });
  assert.ok(reply.includes('between 1 and 100'));

  // Valid clear
  await handleClearCommand(guild, mod, generalCh, ['25'], async (msg) => {
    reply = msg;
  });
  assert.ok(generalCh.messages.some((m) => m.includes('Deleted **25** message(s)')));
});

test('14. Message logging: excludes bots, admins, and audit channels', async () => {
  const { guild } = createMockGuild();
  const admin = createMockMember({ isAdmin: true });
  await handleSetupCommand(guild, admin, async () => {});

  const msgLogId = getGuildChannelId(guild.id, 'msgLogId');
  const msgLog = guild.channels.cache.get(msgLogId);

  const generalCh = await guild.channels.create({
    name: 'general',
    type: ChannelType.GuildText,
  });

  // Bot message -> ignored
  await handleMessageCreateLog({
    guild,
    channel: generalCh,
    author: { id: 'bot-1', bot: true },
    content: 'Bot output',
  });
  assert.strictEqual(msgLog.messages.length, 0);

  // Admin message -> ignored
  const adminMember = createMockMember({ isAdmin: true });
  await handleMessageCreateLog({
    guild,
    channel: generalCh,
    member: adminMember,
    author: adminMember.user,
    content: 'Admin secret',
  });
  assert.strictEqual(msgLog.messages.length, 0);

  // Message inside audit channel -> ignored
  const regularMember = createMockMember({ isAdmin: false });
  await handleMessageCreateLog({
    guild,
    channel: msgLog,
    member: regularMember,
    author: regularMember.user,
    content: 'Chatting in audit channel',
  });
  assert.strictEqual(msgLog.messages.length, 0);

  // Regular member message in general channel -> logged with secret redaction
  await handleMessageCreateLog({
    guild,
    channel: generalCh,
    member: regularMember,
    author: regularMember.user,
    id: 'msg-abc-123',
    createdTimestamp: Date.now(),
    content: 'Hello everyone! My api_key = "123456789abcdef"',
  });

  assert.strictEqual(msgLog.messages.length, 1);
  assert.ok(msgLog.messages[0].includes('Message Sent'));
  assert.ok(!msgLog.messages[0].includes('123456789abcdef'));
  assert.ok(msgLog.messages[0].includes('[REDACTED_SECRET]'));
});

test('15. Message edit and delete logging: records changes in #msg-log', async () => {
  const { guild } = createMockGuild();
  const admin = createMockMember({ isAdmin: true });
  await handleSetupCommand(guild, admin, async () => {});

  const msgLogId = getGuildChannelId(guild.id, 'msgLogId');
  const msgLog = guild.channels.cache.get(msgLogId);

  const generalCh = await guild.channels.create({
    name: 'general',
    type: ChannelType.GuildText,
  });

  const regularMember = createMockMember({ isAdmin: false });

  // Edit
  await handleMessageUpdateLog(
    { content: 'Original message text' },
    {
      guild,
      channel: generalCh,
      member: regularMember,
      author: regularMember.user,
      id: 'edited-msg-id',
      content: 'Updated message text',
    }
  );

  assert.ok(msgLog.messages.some((m) => m.includes('Message Edited') && m.includes('Original message text') && m.includes('Updated message text')));

  // Delete
  await handleMessageDeleteLog({
    guild,
    channel: generalCh,
    member: regularMember,
    author: regularMember.user,
    id: 'deleted-msg-id',
    content: 'Message about to disappear',
  });

  assert.ok(msgLog.messages.some((m) => m.includes('Message Deleted') && m.includes('Message about to disappear')));
});

test('16. Help command: lists all management and member commands', () => {
  const help = getHelpResponse(PREFIX);
  assert.ok(help.includes('.setup'));
  assert.ok(help.includes('.setup remove'));
  assert.ok(help.includes('.dm welcome on'));
  assert.ok(help.includes('.dm welcome off'));
  assert.ok(help.includes('.ban'));
  assert.ok(help.includes('.clear'));
  assert.ok(help.includes('.status'));
  assert.ok(help.includes('.ping'));
  assert.ok(help.includes('.help'));
  assert.ok(help.includes('.website'));
});

test('17. Resiliency: operates safely when log channels are missing', async () => {
  const { guild, members, bans } = createMockGuild({ id: 'guild-no-channels' });
  const mod = createMockMember({ perms: [PermissionFlagsBits.BanMembers], rolePos: 30 });
  const target = createMockMember({ id: 'target-no-log-ch', rolePos: 5 });
  members.set(target.id, target);

  // 1. Ban when no log channel exists
  let reply = '';
  await handleBanCommand(guild, mod, [target.id, 'No log channel test'], async (msg) => {
    reply = msg;
  });
  assert.ok(reply.includes('Successfully banned'));
  assert.strictEqual(bans.has(target.id), true);

  // 2. Native ban/unban when no log channel exists
  await handleGuildBanAdd({ guild, user: { id: 'some-user', tag: 'user#1' }, reason: 'Test' });
  await handleGuildBanRemove({ guild, user: { id: 'some-user', tag: 'user#1' } });

  // 3. Message logging when no msg-log channel exists
  const generalCh = await guild.channels.create({ name: 'general', type: ChannelType.GuildText });
  const regular = createMockMember({ isAdmin: false });
  await handleMessageCreateLog({
    guild,
    channel: generalCh,
    member: regular,
    author: regular.user,
    id: 'msg-no-ch',
    content: 'Message with no log channel',
  });

  // 4. Welcome DM when no dm-log channel exists
  setWelcomeEnabled(guild.id, true);
  const joiner = createMockMember({ id: 'joiner-no-dm-log' });
  joiner.guild = guild;
  await handleGuildMemberAdd(joiner);
});

test('18. Error Handling: reports missing bot permissions on .clear and .ban', async () => {
  const { guild } = createMockGuild({ id: 'guild-bot-noperms', botMissingPerms: true });
  const mod = createMockMember({ perms: [PermissionFlagsBits.BanMembers, PermissionFlagsBits.ManageMessages], rolePos: 30 });
  const generalCh = await guild.channels.create({ name: 'general', type: ChannelType.GuildText });
  generalCh.permissionsFor = () => ({ has: () => false });

  // Clear when bot lacks permissions in channel
  let clearReply = '';
  await handleClearCommand(guild, mod, generalCh, ['10'], async (msg) => {
    clearReply = msg;
  });
  assert.ok(clearReply.includes('Bot Permission Missing'));

  // Ban when bot lacks Ban Members
  let banReply = '';
  await handleBanCommand(guild, mod, ['123456789012345678', 'Test'], async (msg) => {
    banReply = msg;
  });
  assert.ok(banReply.includes('Bot Permission Missing'));
});

test('19. Persistence: settings persist across simulation of bot restart', () => {
  const testGuildId = 'guild-restart-test-' + Date.now();
  setWelcomeEnabled(testGuildId, true);
  guildSettingsCache[testGuildId] = {
    ...guildSettingsCache[testGuildId],
    channels: {
      botPreviewId: 'ch-preview-999',
      dmLogId: 'ch-dm-999',
      msgLogId: 'ch-msg-999',
      banUnbanLogId: 'ch-ban-999',
    },
  };
  setWelcomeEnabled(testGuildId, false);

  const reloaded = loadGuildSettings();
  assert.strictEqual(reloaded[testGuildId]?.welcomeEnabled, false);
});

// ------------------- NEW .setup remove TESTS -------------------

test('20. .setup remove: rejects non-administrators', async () => {
  const { guild } = createMockGuild({ id: 'guild-remove-auth' });
  const nonAdmin = createMockMember({ isAdmin: false });
  let reply = '';

  await handleSetupRemoveCommand(guild, nonAdmin, async (msg) => {
    reply = typeof msg === 'object' ? msg.content : msg;
  });

  assert.ok(reply.includes('Permission Denied'));
  assert.strictEqual(pendingSetupRemovals.has(guild.id), false);
});

test('21. .setup remove: idempotent when setup is already removed or inactive', async () => {
  const { guild } = createMockGuild({ id: 'guild-remove-idempotent' });
  const admin = createMockMember({ isAdmin: true });
  let reply = '';

  // Setup was never run on this guild
  await handleSetupRemoveCommand(guild, admin, async (msg) => {
    reply = typeof msg === 'object' ? msg.content : msg;
  });

  assert.ok(reply.includes('Setup Already Removed'));
  assert.strictEqual(pendingSetupRemovals.has(guild.id), false);
});

test('22. .setup remove: prompts for confirmation and does not delete immediately', async () => {
  const { guild, channels } = createMockGuild({ id: 'guild-remove-prompt' });
  const admin = createMockMember({ isAdmin: true });

  // First run setup
  await handleSetupCommand(guild, admin, async () => {});
  assert.strictEqual(channels.size, 4);

  let promptReply = '';
  await handleSetupRemoveCommand(guild, admin, async (msg) => {
    promptReply = typeof msg === 'object' ? msg.content : msg;
  });

  assert.ok(promptReply.includes('Confirmation Required'));
  assert.ok(promptReply.includes('.setup confirm'));
  // Channels must NOT be deleted yet!
  assert.strictEqual(channels.size, 4);
  assert.strictEqual(pendingSetupRemovals.has(guild.id), true);
  assert.strictEqual(pendingSetupRemovals.get(guild.id).adminId, admin.id);
});

test('23. .setup remove: prevents unauthorized users from confirming another admin request', async () => {
  const { guild } = createMockGuild({ id: 'guild-confirm-unauth' });
  const admin1 = createMockMember({ id: 'admin-1', isAdmin: true });
  const admin2 = createMockMember({ id: 'admin-2', isAdmin: true });

  await handleSetupCommand(guild, admin1, async () => {});
  await handleSetupRemoveCommand(guild, admin1, async () => {});

  let reply = '';
  await handleSetupConfirmCommand(guild, admin2, async (msg) => {
    reply = msg;
  });

  assert.ok(reply.includes('Unauthorized'));
  assert.ok(reply.includes(admin1.id));
  assert.strictEqual(pendingSetupRemovals.has(guild.id), true);
});

test('24. .setup cancel: aborts pending removal without deleting channels', async () => {
  const { guild, channels } = createMockGuild({ id: 'guild-cancel-remove' });
  const admin = createMockMember({ isAdmin: true });

  await handleSetupCommand(guild, admin, async () => {});
  await handleSetupRemoveCommand(guild, admin, async () => {});

  let reply = '';
  await handleSetupCancelCommand(guild, admin, async (msg) => {
    reply = msg;
  });

  assert.ok(reply.includes('Setup Removal Cancelled'));
  assert.strictEqual(pendingSetupRemovals.has(guild.id), false);
  assert.strictEqual(channels.size, 4, 'Channels must be intact after cancellation');
});

test('25. .setup confirm: deletes only bot-managed channels, clears IDs, and marks inactive', async () => {
  const { guild, channels } = createMockGuild({ id: 'guild-full-remove' });
  const admin = createMockMember({ isAdmin: true });

  // Create an unrelated channel to test that it is NOT deleted
  const unrelatedCh = await guild.channels.create({
    id: 'ch-unrelated-general',
    name: 'general',
    type: ChannelType.GuildText,
  });

  // Run setup to create official channels
  await handleSetupCommand(guild, admin, async () => {});
  // Now there should be 1 unrelated + 4 managed channels = 5 channels
  assert.strictEqual(channels.size, 5);

  // Request removal
  await handleSetupRemoveCommand(guild, admin, async () => {});

  // Confirm removal
  let confirmReply = '';
  await handleSetupConfirmCommand(guild, admin, async (msg) => {
    confirmReply = msg;
  });

  assert.ok(confirmReply.includes('Setup Removal Complete'));
  assert.ok(confirmReply.includes('Deleted Channels'));
  assert.ok(confirmReply.includes('Inactive'));

  // Stored channel IDs must be null
  const saved = getGuildChannels(guild.id);
  assert.strictEqual(saved.botPreviewId, null);
  assert.strictEqual(saved.dmLogId, null);
  assert.strictEqual(saved.msgLogId, null);
  assert.strictEqual(saved.banUnbanLogId, null);
  assert.strictEqual(isSetupActive(guild.id), false);

  // Unrelated channel must NOT have been deleted
  assert.strictEqual(channels.has('ch-unrelated-general'), true);
  assert.strictEqual(channels.size, 1);
});

test('26. Post-removal behavior: logging disabled safely and welcome DM preserved', async () => {
  const { guild } = createMockGuild({ id: 'guild-post-remove' });
  const admin = createMockMember({ isAdmin: true });

  setWelcomeEnabled(guild.id, true);
  await handleSetupCommand(guild, admin, async () => {});
  await handleSetupRemoveCommand(guild, admin, async () => {});
  await handleSetupConfirmCommand(guild, admin, async () => {});

  // 1. Welcome DM still sends to joining member without crashing
  const newMember = createMockMember({ id: 'joiner-post-remove' });
  newMember.guild = guild;
  await handleGuildMemberAdd(newMember);

  // 2. Message logging does not crash or log
  const generalCh = await guild.channels.create({ name: 'general', type: ChannelType.GuildText });
  const regular = createMockMember({ isAdmin: false });
  await handleMessageCreateLog({
    guild,
    channel: generalCh,
    member: regular,
    author: regular.user,
    content: 'Regular post-remove message',
  });

  // 3. Status command shows Inactive / Removed
  let statusReply = '';
  await handleStatusCommand(guild, async (msg) => {
    statusReply = msg;
  });
  assert.ok(statusReply.includes('Inactive / Removed'));
  assert.ok(statusReply.includes('Welcome DMs:** 🟢 **Active / Enabled**'));

  // 4. Running .setup remove again returns idempotent already removed message
  let reRemoveReply = '';
  await handleSetupRemoveCommand(guild, admin, async (msg) => {
    reRemoveReply = typeof msg === 'object' ? msg.content : msg;
  });
  assert.ok(reRemoveReply.includes('Setup Already Removed'));
});
