import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PermissionFlagsBits,
  ChannelType,
} from 'discord.js';

import {
  handleTicketSetupCommand,
  handleTicketInteraction,
  TICKET_OPTIONS,
  isMemberAdmin,
} from '../ticketService.js';

import {
  saveTicketPanel,
  getTicketPanel,
  getNextTicketNumber,
  saveTicketToDb,
  getTicketFromDb,
  updateTicketStatusInDb,
} from '../mongoService.js';

// Helper mock builders
function createMockGuild(options = {}) {
  const channels = new Map();
  const roles = new Map();

  const guild = {
    id: options.id || 'guild-ticket-test-123',
    name: options.name || 'MatchDistrict Ticket Guild',
    ownerId: options.ownerId || 'owner-123456789012345678',
    roles: {
      cache: {
        get: (id) => roles.get(id),
        find: (predicate) => {
          for (const r of roles.values()) {
            if (predicate(r)) return r;
          }
          return null;
        },
        values: () => roles.values(),
      },
      create: async (data) => {
        const id = 'role-' + Math.random().toString(36).substring(2, 9);
        const role = {
          id,
          name: data.name,
          color: data.color,
          guild,
          deleted: false,
        };
        roles.set(id, role);
        return role;
      },
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
      create: async (data) => {
        const id = 'ch-' + Math.random().toString(36).substring(2, 9);
        const channelMessages = [];
        const newChannel = {
          id,
          name: data.name,
          type: data.type,
          parent: data.parent ? { id: data.parent } : null,
          parentId: data.parent || null,
          topic: data.topic,
          guildId: guild.id,
          guild,
          deleted: false,
          permissionOverwrites: {
            overwrites: data.permissionOverwrites || [],
            set: async (overwrites) => {
              newChannel.permissionOverwrites.overwrites = overwrites;
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
              components: msg?.components || [],
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
      me: {
        id: 'bot-123456789',
        permissions: {
          has: (perm) => true,
        },
      },
    },
  };

  return guild;
}

function createMockMember(guild, options = {}) {
  const roleList = options.roles || [];
  return {
    id: options.id || 'user-123',
    user: {
      id: options.id || 'user-123',
      tag: options.tag || 'Tester#0001',
    },
    guild,
    permissions: {
      has: (perm) => {
        if (options.isAdmin) return true;
        if (options.permissions) return options.permissions.includes(perm);
        return false;
      },
    },
    roles: {
      cache: {
        some: (fn) => roleList.some(fn),
        has: (id) => roleList.some((r) => r.id === id),
      },
    },
  };
}

test('Support Ticket System: Configuration', () => {
  assert.ok(Array.isArray(TICKET_OPTIONS), 'TICKET_OPTIONS is an array');
  assert.ok(TICKET_OPTIONS.length >= 1, 'TICKET_OPTIONS has at least 1 option');
  assert.strictEqual(TICKET_OPTIONS[0].label, 'General Support', 'Default option is General Support');
});

test('Support Ticket System: .ticket setup permissions', async () => {
  const guild = createMockGuild();
  const regularMember = createMockMember(guild, { isAdmin: false });
  let replyMsg = '';

  await handleTicketSetupCommand(guild, regularMember, null, async (msg) => {
    replyMsg = typeof msg === 'object' ? msg.content : msg;
  });

  assert.ok(replyMsg.includes('Permission Denied'), 'Rejects non-administrator');
});

test('Support Ticket System: .ticket setup creates #support-ticket channel and panel', async () => {
  const guild = createMockGuild();
  const adminMember = createMockMember(guild, { isAdmin: true });
  let replyMsg = '';

  await handleTicketSetupCommand(guild, adminMember, null, async (msg) => {
    replyMsg = typeof msg === 'object' ? msg.content : msg;
  });

  assert.ok(replyMsg.includes('Support ticket panel created'), 'Confirms panel creation');

  const panelChannel = Array.from(guild.channels.cache.values()).find(
    (c) => c.name === 'support-ticket'
  );
  assert.ok(panelChannel, '#support-ticket channel created');
  assert.strictEqual(panelChannel._messages.length, 1, 'Posted 1 panel message');

  const panelMsg = panelChannel._messages[0];
  assert.strictEqual(panelMsg.embeds[0].data.title, 'Support');
  assert.strictEqual(
    panelMsg.embeds[0].data.description,
    'To create a ticket, make a selection below'
  );
  assert.strictEqual(panelMsg.components[0].components[0].data.placeholder, 'Make a selection');
});

test('Support Ticket System: .ticket setup reuses existing #support-ticket channel', async () => {
  const guild = createMockGuild();
  const adminMember = createMockMember(guild, { isAdmin: true });

  // Pre-create support-ticket channel
  const existingChannel = await guild.channels.create({
    name: 'support-ticket',
    type: ChannelType.GuildText,
  });

  await handleTicketSetupCommand(guild, adminMember, null, async () => {});

  const channelsWithName = Array.from(guild.channels.cache.values()).filter(
    (c) => c.name === 'support-ticket'
  );
  assert.strictEqual(channelsWithName.length, 1, 'Did not duplicate #support-ticket');
  assert.strictEqual(channelsWithName[0].id, existingChannel.id, 'Reused the existing channel');
});

test('Support Ticket System: Creating a ticket from select menu', async () => {
  const guild = createMockGuild();
  const ticketUser = createMockMember(guild, { id: 'user-opener-456' });

  let deferred = false;
  let replyText = '';

  const mockInteraction = {
    guild,
    user: ticketUser.user,
    member: ticketUser,
    customId: 'ticket:select_category',
    values: ['general_support'],
    isStringSelectMenu: () => true,
    isButton: () => false,
    deferReply: async ({ ephemeral }) => {
      deferred = true;
      assert.strictEqual(ephemeral, true, 'Defers reply ephemerally');
    },
    editReply: async (payload) => {
      replyText = payload.content;
    },
  };

  const handled = await handleTicketInteraction(mockInteraction);
  assert.strictEqual(handled, true, 'Handled select menu interaction');
  assert.strictEqual(deferred, true, 'Deferred interaction reply');
  assert.ok(replyText.includes('Your ticket has been created'), 'Replied with ticket created link');

  // Verify category "SUPPORT TICKETS" created
  const category = Array.from(guild.channels.cache.values()).find(
    (c) => c.name === 'SUPPORT TICKETS' && c.type === ChannelType.GuildCategory
  );
  assert.ok(category, 'SUPPORT TICKETS category created');

  // Verify "Support Team" role created
  const supportRole = Array.from(guild.roles.cache.values()).find(
    (r) => r.name === 'Support Team'
  );
  assert.ok(supportRole, 'Support Team role created');

  // Verify ticket channel created with format 0001-support
  const ticketChannel = Array.from(guild.channels.cache.values()).find(
    (c) => c.name.endsWith('-support') && c.type === ChannelType.GuildText
  );
  assert.ok(ticketChannel, 'Ticket channel created');
  assert.match(ticketChannel.name, /^\d{4}-support$/, 'Channel name formatted like 0001-support');
  assert.strictEqual(ticketChannel.parentId, category.id, 'Channel placed in SUPPORT TICKETS category');

  // Check channel welcome message
  assert.strictEqual(ticketChannel._messages.length, 1, 'Welcome message posted in ticket channel');
  const welcomeMsg = ticketChannel._messages[0];
  assert.ok(welcomeMsg.content.includes(`<@${ticketUser.user.id}>`), 'Mentions ticket creator');
  assert.ok(welcomeMsg.content.includes(`<@&${supportRole.id}>`), 'Pings Support Team role');
  assert.strictEqual(welcomeMsg.embeds[0].data.title, 'Support');
  assert.strictEqual(welcomeMsg.components[0].components[0].data.custom_id, 'ticket:close');
});

test('Support Ticket System: Close Ticket prompt authorization', async () => {
  const guild = createMockGuild();
  const ticketUser = createMockMember(guild, { id: 'user-opener-456' });
  const otherUser = createMockMember(guild, { id: 'random-user-789' });

  // Simulate existing ticket with creator in topic & permissions
  const ticketChannel = await guild.channels.create({
    name: '0001-support',
    type: ChannelType.GuildText,
    topic: `Ticket #0001 | Creator: ${ticketUser.user.tag} (${ticketUser.user.id})`,
    permissionOverwrites: [{ id: ticketUser.user.id, allow: [] }],
  });

  // Unauthorized user tries to close
  let unauthorizedReply = '';
  const unauthorizedInteraction = {
    guild,
    channel: ticketChannel,
    channelId: ticketChannel.id,
    user: otherUser.user,
    member: otherUser,
    customId: 'ticket:close',
    isButton: () => true,
    isStringSelectMenu: () => false,
    reply: async (msg) => {
      unauthorizedReply = msg.content;
    },
  };

  await handleTicketInteraction(unauthorizedInteraction);
  assert.ok(
    unauthorizedReply.includes('Only the ticket creator or the Support Team can close'),
    'Unauthorized user rejected'
  );

  // Authorized user (ticket creator) clicks close -> gets confirmation prompt
  let confirmPrompt = null;
  const authorizedInteraction = {
    guild,
    channel: ticketChannel,
    channelId: ticketChannel.id,
    user: ticketUser.user,
    member: ticketUser,
    customId: 'ticket:close',
    isButton: () => true,
    isStringSelectMenu: () => false,
    reply: async (msg) => {
      confirmPrompt = msg;
    },
  };

  await handleTicketInteraction(authorizedInteraction);
  assert.ok(confirmPrompt, 'Confirmation prompt shown');
  assert.ok(confirmPrompt.content.includes('Are you sure you want to close this ticket?'));
  assert.strictEqual(confirmPrompt.components[0].components[0].data.custom_id, 'ticket:confirm_close');
  assert.strictEqual(confirmPrompt.components[0].components[1].data.custom_id, 'ticket:cancel_close');
});

test('Support Ticket System: Confirm close deletes channel', async () => {
  const guild = createMockGuild();
  const ticketUser = createMockMember(guild, { id: 'user-opener-456' });

  const ticketChannel = await guild.channels.create({
    name: '0001-support',
    type: ChannelType.GuildText,
    topic: `Ticket #0001 | Creator: ${ticketUser.user.tag} (${ticketUser.user.id})`,
    permissionOverwrites: [{ id: ticketUser.user.id, allow: [] }],
  });

  let updateCalled = false;
  const confirmInteraction = {
    guild,
    channel: ticketChannel,
    channelId: ticketChannel.id,
    user: ticketUser.user,
    member: ticketUser,
    customId: 'ticket:confirm_close',
    isButton: () => true,
    isStringSelectMenu: () => false,
    update: async () => {
      updateCalled = true;
    },
    reply: async () => {},
  };

  await handleTicketInteraction(confirmInteraction);
  assert.strictEqual(updateCalled, true, 'Updated button interaction');

  // Verify notification message in channel
  const closingMsg = ticketChannel._messages.find((m) =>
    (typeof m === 'string' ? m : m.content || '').includes('Ticket closed by')
  );
  assert.ok(closingMsg, 'Notified channel that ticket is closing');
});
