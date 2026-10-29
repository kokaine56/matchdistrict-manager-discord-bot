import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PermissionFlagsBits,
  ChannelType,
} from 'discord.js';

import {
  handleSetupCommand,
  guildSettingsCache,
  isModerationEnabled,
} from '../index.js';

import {
  containsLink,
  handleMessageModeration,
  handleMessageUpdateModeration,
  handleUnmuteCommand,
  handleUnbanCommand,
  verifyBotModerationPermissions,
  extractUserId,
} from '../moderationService.js';

import {
  STARTER_BAD_WORDS,
  checkAbusiveWord,
} from '../badWordsConfig.js';

function createMockGuild(options = {}) {
  const channels = new Map();
  const members = new Map();
  const bans = new Map();

  const guild = {
    id: options.id || 'guild-mod-test-123',
    name: options.name || 'MatchDistrict Mod Test Guild',
    ownerId: options.ownerId || 'owner-123',
    roles: {
      everyone: { id: options.id || 'guild-mod-test-123' },
    },
    bans: {
      fetch: async (id) => {
        if (bans.has(id)) return bans.get(id);
        return null;
      },
      remove: async (id, reason) => {
        if (!bans.has(id)) throw new Error('Unknown Ban');
        bans.delete(id);
        return true;
      },
      _bans: bans,
    },
    channels: {
      cache: {
        get: (id) => channels.get(id),
        has: (id) => channels.has(id),
        find: (predicate) => {
          for (const ch of channels.values()) {
            if (predicate(ch)) return ch;
          }
          return null;
        },
        values: () => channels.values(),
      },
      fetch: async (id) => channels.get(id) || null,
      create: async (data) => {
        const id = 'ch-' + Math.random().toString(36).substring(2, 9);
        const channelMessages = [];
        const newChannel = {
          id,
          name: data.name,
          type: data.type,
          guildId: guild.id,
          guild,
          deleted: false,
          permissionOverwrites: {
            set: async (overwrites) => {
              newChannel._overwrites = overwrites;
              return newChannel;
            },
          },
          send: async (msg) => {
            channelMessages.push(msg);
            return {
              id: 'msg-' + Date.now() + Math.random(),
              channelId: id,
              content: typeof msg === 'string' ? msg : msg?.content,
              embeds: msg?.embeds || [],
            };
          },
          delete: async () => {
            newChannel.deleted = true;
            channels.delete(id);
            return newChannel;
          },
          _messages: channelMessages,
        };
        channels.set(id, newChannel);
        return newChannel;
      },
    },
    members: {
      cache: members,
      fetch: async (id) => members.get(id) || null,
      me: {
        id: 'bot-123',
        permissions: {
          has: (perm) => true,
        },
      },
    },
  };

  return guild;
}

function createMockMember(guild, options = {}) {
  let timedOutUntil = options.timedOutUntil || null;

  const member = {
    id: options.id || 'user-123',
    user: {
      id: options.id || 'user-123',
      tag: options.tag || 'Tester#0001',
      username: options.username || 'Tester',
      bot: Boolean(options.bot),
    },
    guild,
    communicationDisabledUntilTimestamp: timedOutUntil,
    isCommunicationDisabled: () => Boolean(timedOutUntil && timedOutUntil > Date.now()),
    timeout: async (ms, reason) => {
      if (ms === null) {
        timedOutUntil = null;
        member.communicationDisabledUntilTimestamp = null;
      } else {
        timedOutUntil = Date.now() + ms;
        member.communicationDisabledUntilTimestamp = timedOutUntil;
      }
      return member;
    },
    permissions: {
      has: (perm) => {
        if (options.isAdmin) return true;
        if (options.permissions) return options.permissions.includes(perm);
        return false;
      },
    },
  };

  guild.members.cache.set(member.id, member);
  return member;
}

function createMockMessage(guild, member, channel, content) {
  let deleted = false;
  return {
    id: 'msg-' + Math.random().toString(36).substring(2, 9),
    guild,
    member,
    author: member.user,
    channel,
    content,
    delete: async () => {
      deleted = true;
      return true;
    },
    isDeleted: () => deleted,
  };
}

test('Moderation: Starts disabled before .setup runs', async () => {
  const guild = createMockGuild({ id: 'guild-uninit' });
  assert.strictEqual(isModerationEnabled(guild.id), false, 'Moderation is disabled before .setup');

  const member = createMockMember(guild, { id: 'user-link-1' });
  const channel = await guild.channels.create({ name: 'general', type: ChannelType.GuildText });
  const msg = createMockMessage(guild, member, channel, 'Check out https://example.com');

  const handled = await handleMessageModeration(msg);
  assert.strictEqual(handled, false, 'Does nothing before .setup');
  assert.strictEqual(msg.isDeleted(), false, 'Message was not deleted before .setup');
});

test('Moderation: .setup enables moderation and creates #mod-log', async () => {
  const guild = createMockGuild({ id: 'guild-init' });
  const adminMember = createMockMember(guild, { id: 'admin-1', isAdmin: true });

  await handleSetupCommand(guild, adminMember, async () => {});

  assert.strictEqual(isModerationEnabled(guild.id), true, 'Moderation is enabled after .setup');
  assert.strictEqual(guildSettingsCache[guild.id]?.moderationEnabled, true, 'moderationEnabled flag is true');

  const modLogId = guildSettingsCache[guild.id]?.channels?.modLogId;
  assert.ok(modLogId, 'modLogId is stored in settings');

  const modLogChannel = guild.channels.cache.get(modLogId);
  assert.ok(modLogChannel, '#mod-log channel was created');
  assert.strictEqual(modLogChannel.name, 'mod-log');
});

test('Moderation: Link detection helper handles all required URL types', () => {
  assert.strictEqual(containsLink('visit https://matchdistrict.in today'), true, 'https:// link detected');
  assert.strictEqual(containsLink('check http://test.com'), true, 'http:// link detected');
  assert.strictEqual(containsLink('go to www.google.com'), true, 'www. link detected');
  assert.strictEqual(containsLink('join discord.gg/esports'), true, 'discord.gg invite detected');
  assert.strictEqual(containsLink('invite at discord.com/invite/esports'), true, 'discord.com/invite detected');
  assert.strictEqual(containsLink('my site is coolgames.xyz/play'), true, 'domain with .xyz detected');
  assert.strictEqual(containsLink('website is matchdistrict.in'), true, 'domain with .in detected');
  assert.strictEqual(containsLink('hello world, how are you?'), false, 'normal sentence not detected');
});

test('Moderation: Link blocking deletes message, times out user for 2 min, and logs to #mod-log', async () => {
  const guild = createMockGuild({ id: 'guild-link-test' });
  const adminMember = createMockMember(guild, { id: 'admin-2', isAdmin: true });
  await handleSetupCommand(guild, adminMember, async () => {});

  const regularMember = createMockMember(guild, { id: 'user-spammer' });
  const textChannel = await guild.channels.create({ name: 'chat', type: ChannelType.GuildText });

  const msg = createMockMessage(guild, regularMember, textChannel, 'Free prizes here: https://free-prizes.com');
  const handled = await handleMessageModeration(msg);

  assert.strictEqual(handled, true, 'Handled by link moderation');
  assert.strictEqual(msg.isDeleted(), true, 'Message was deleted');
  assert.strictEqual(regularMember.isCommunicationDisabled(), true, 'User was timed out');

  // Verify log in #mod-log
  const modLogId = guildSettingsCache[guild.id]?.channels?.modLogId;
  const modLogChannel = guild.channels.cache.get(modLogId);
  assert.ok(modLogChannel._messages.length >= 1, 'Moderation action logged to #mod-log');
  const logEmbed = modLogChannel._messages[0].embeds[0];
  assert.ok(logEmbed.data.title.includes('Link Blocked'), 'Log title specifies Link Blocked');
});

test('Moderation: Link blocking handles server owner & admins without timing out', async () => {
  const guild = createMockGuild({ id: 'guild-admin-link', ownerId: 'owner-special' });
  const ownerMember = createMockMember(guild, { id: 'owner-special', isAdmin: true });
  await handleSetupCommand(guild, ownerMember, async () => {});

  const textChannel = await guild.channels.create({ name: 'chat', type: ChannelType.GuildText });
  const msg = createMockMessage(guild, ownerMember, textChannel, 'Check my link https://github.com');

  const handled = await handleMessageModeration(msg);
  assert.strictEqual(handled, true, 'Message was moderated');
  assert.strictEqual(msg.isDeleted(), true, 'Message was deleted even for owner');
  assert.strictEqual(ownerMember.isCommunicationDisabled(), false, 'Owner was not timed out');

  // Verify log mentions timeout not possible
  const modLogId = guildSettingsCache[guild.id]?.channels?.modLogId;
  const modLogChannel = guild.channels.cache.get(modLogId);
  const logMsg = modLogChannel._messages[0];
  const fields = logMsg.embeds[0].data.fields;
  const statusField = fields.find((f) => f.name.includes('Status Note'));
  assert.ok(statusField.value.includes('Timeout not possible'), 'Log explains timeout not possible');
});

test('Moderation: Abusive words detection matches whole words and obfuscations', () => {
  // Whole words
  assert.strictEqual(checkAbusiveWord('shut the fuck up'), 'fuck');
  assert.strictEqual(checkAbusiveWord('teri bsdk'), 'bsdk');
  assert.strictEqual(checkAbusiveWord('you chutiya'), 'chutiya');
  assert.strictEqual(checkAbusiveWord('tu mc hai'), 'mc');
  assert.strictEqual(checkAbusiveWord('tu bc hai'), 'bc');

  // Obfuscations & spaces
  assert.strictEqual(checkAbusiveWord('f u c k'), 'fuck');
  assert.strictEqual(checkAbusiveWord('m.c'), 'mc');
  assert.strictEqual(checkAbusiveWord('b.s.d.k'), 'bsdk');
  assert.strictEqual(checkAbusiveWord('f@ck'), 'fuck');
  assert.strictEqual(checkAbusiveWord('fuuuuck'), 'fuck');

  // Must NOT match words containing letters
  assert.strictEqual(checkAbusiveWord('mcdonalds burger'), null, 'Does not match mcdonalds');
  assert.strictEqual(checkAbusiveWord('because we said so'), null, 'Does not match because');
  assert.strictEqual(checkAbusiveWord('abc company'), null, 'Does not match abc');
  assert.strictEqual(checkAbusiveWord('broadcast match'), null, 'Does not match broadcast');
});

test('Moderation: Abusive words deletes message and logs to #mod-log', async () => {
  const guild = createMockGuild({ id: 'guild-bad-word' });
  const adminMember = createMockMember(guild, { id: 'admin-3', isAdmin: true });
  await handleSetupCommand(guild, adminMember, async () => {});

  const member = createMockMember(guild, { id: 'user-toxic' });
  const textChannel = await guild.channels.create({ name: 'chat', type: ChannelType.GuildText });

  const msg = createMockMessage(guild, member, textChannel, 'You are a chutiya');
  const handled = await handleMessageModeration(msg);

  assert.strictEqual(handled, true, 'Handled by abusive word filter');
  assert.strictEqual(msg.isDeleted(), true, 'Abusive message was deleted');

  const modLogId = guildSettingsCache[guild.id]?.channels?.modLogId;
  const modLogChannel = guild.channels.cache.get(modLogId);
  const logMsg = modLogChannel._messages[0];
  assert.ok(logMsg.embeds[0].data.title.includes('Abusive Word Blocked'), 'Logged to #mod-log');
});

test('Moderation: Edited messages are moderated for links and bad words', async () => {
  const guild = createMockGuild({ id: 'guild-edit-test' });
  const adminMember = createMockMember(guild, { id: 'admin-4', isAdmin: true });
  await handleSetupCommand(guild, adminMember, async () => {});

  const member = createMockMember(guild, { id: 'user-sneaky' });
  const textChannel = await guild.channels.create({ name: 'chat', type: ChannelType.GuildText });

  const oldMsg = createMockMessage(guild, member, textChannel, 'Hello friends');
  const newMsg = createMockMessage(guild, member, textChannel, 'Hello friends https://scam.xyz');

  const handled = await handleMessageUpdateModeration(oldMsg, newMsg);
  assert.strictEqual(handled, true, 'Handled edited message moderation');
  assert.strictEqual(newMsg.isDeleted(), true, 'Edited message with link was deleted');
  assert.strictEqual(member.isCommunicationDisabled(), true, 'User was timed out on edit');
});

test('Moderation: .unmute command removes timeout and logs', async () => {
  const guild = createMockGuild({ id: 'guild-unmute-test' });
  const adminMember = createMockMember(guild, { id: 'mod-admin', isAdmin: true });
  await handleSetupCommand(guild, adminMember, async () => {});

  const timedOutMember = createMockMember(guild, {
    id: 'user-timed-out',
    timedOutUntil: Date.now() + 120000,
  });

  const textChannel = await guild.channels.create({ name: 'bot-commands', type: ChannelType.GuildText });

  let replyText = '';
  await handleUnmuteCommand(
    guild,
    adminMember,
    textChannel,
    [`<@${timedOutMember.id}>`],
    async (msg) => {
      replyText = typeof msg === 'object' ? msg.content : msg;
    }
  );

  assert.ok(replyText.includes('Successfully unmuted'), 'Unmute confirmation replied');
  assert.strictEqual(timedOutMember.isCommunicationDisabled(), false, 'Timeout removed');

  // Verify mod log
  const modLogId = guildSettingsCache[guild.id]?.channels?.modLogId;
  const modLogChannel = guild.channels.cache.get(modLogId);
  const logMsg = modLogChannel._messages[modLogChannel._messages.length - 1];
  assert.ok(logMsg.embeds[0].data.title.includes('Member Unmuted'), 'Logged to #mod-log');
});

test('Moderation: .unban command unbans user and logs', async () => {
  const guild = createMockGuild({ id: 'guild-unban-test' });
  const adminMember = createMockMember(guild, { id: 'mod-admin-2', isAdmin: true });
  await handleSetupCommand(guild, adminMember, async () => {});

  // Pre-ban user
  const bannedId = 'banned-user-999';
  guild.bans._bans.set(bannedId, {
    user: { id: bannedId, tag: 'BannedUser#9999' },
    reason: 'Violated rules',
  });

  const textChannel = await guild.channels.create({ name: 'bot-commands', type: ChannelType.GuildText });

  let replyText = '';
  await handleUnbanCommand(
    guild,
    adminMember,
    textChannel,
    [bannedId],
    async (msg) => {
      replyText = typeof msg === 'object' ? msg.content : msg;
    }
  );

  assert.ok(replyText.includes('Successfully unbanned'), 'Unban confirmation replied');
  assert.strictEqual(guild.bans._bans.has(bannedId), false, 'Ban was removed from guild');

  // Verify mod log
  const modLogId = guildSettingsCache[guild.id]?.channels?.modLogId;
  const modLogChannel = guild.channels.cache.get(modLogId);
  const logMsg = modLogChannel._messages[modLogChannel._messages.length - 1];
  assert.ok(logMsg.embeds[0].data.title.includes('Member Unbanned'), 'Logged to #mod-log');
});

test('Moderation: Permissions validation helper', () => {
  const guild = createMockGuild();
  const perms = verifyBotModerationPermissions(guild);
  assert.strictEqual(perms.valid, true, 'Bot has required permissions');
  assert.strictEqual(perms.missing.length, 0, 'No permissions missing');
});

