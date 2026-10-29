import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChannelType,
  PermissionFlagsBits,
} from 'discord.js';

import {
  handleTicketSetupCommand,
  handleTicketInteraction,
  TICKET_OPTIONS,
  STAFF_ROLES,
  isValidEmail,
  isValidPhoneNumber,
  buildStaffApplicationModal,
  pendingStaffDrafts,
  getTicketLogChannel,
  getStaffAppLogChannel,
} from '../ticketService.js';

import {
  saveStaffApplicationToDb,
  getStaffApplicationFromDb,
} from '../mongoService.js';

import {
  handleSetupCommand,
  REQUIRED_CHANNELS,
  guildSettingsCache,
} from '../index.js';

function createMockGuild(options = {}) {
  const channels = new Map();
  const roles = new Map();

  const guild = {
    id: options.id || 'guild-staff-test-123',
    name: options.name || 'MatchDistrict Staff Guild',
    ownerId: options.ownerId || 'owner-123456789012345678',
    roles: {
      everyone: { id: options.id || 'guild-staff-test-123' },
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
        filter: (predicate) => {
          const res = new Map();
          for (const [k, v] of channels.entries()) {
            if (predicate(v)) res.set(k, v);
          }
          return res;
        },
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
            const m = {
              id: 'msg-' + Date.now() + Math.random(),
              channelId: id,
              content: typeof msg === 'string' ? msg : msg?.content,
              embeds: msg?.embeds || [],
              components: msg?.components || [],
              edit: async (newContent) => {
                m.content = typeof newContent === 'string' ? newContent : newContent?.content;
                m.embeds = newContent?.embeds || m.embeds;
                m.components = newContent?.components || m.components;
                return m;
              },
            };
            channelMessages.push(m);
            return m;
          },
          messages: {
            fetch: async (msgId) => {
              if (typeof msgId === 'string') {
                return channelMessages.find((m) => m.id === msgId) || null;
              }
              return { values: () => channelMessages.values() };
            },
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
      username: options.username || 'tester',
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

describe('Staff Applications, Ticket Fixes & Logging', () => {
  test('1. Ticket Options: General Support panel includes "General Support" and "Apply as Staff"', () => {
    assert.ok(Array.isArray(TICKET_OPTIONS));
    const values = TICKET_OPTIONS.map((o) => o.value);
    assert.ok(values.includes('general_support'), 'Includes General Support');
    assert.ok(values.includes('apply_staff'), 'Includes Apply as Staff');

    const applyOption = TICKET_OPTIONS.find((o) => o.value === 'apply_staff');
    assert.strictEqual(applyOption.label, 'Apply as Staff');
  });

  test('2. Staff Roles: All 5 roles available for selection', () => {
    assert.ok(Array.isArray(STAFF_ROLES));
    const roleValues = STAFF_ROLES.map((r) => r.value);
    assert.ok(roleValues.includes('Mod'));
    assert.ok(roleValues.includes('Scrims Manager'));
    assert.ok(roleValues.includes('Room Maker'));
    assert.ok(roleValues.includes('Pt Making'));
    assert.ok(roleValues.includes('Poster Making'));
  });

  test('3. Field Validations: Email and Phone number formats', () => {
    // Valid emails
    assert.strictEqual(isValidEmail('admin@matchdistrict.com'), true);
    assert.strictEqual(isValidEmail('gamer123@gmail.com'), true);
    assert.strictEqual(isValidEmail('user.name+tag@sub.domain.org'), true);
    // Invalid emails
    assert.strictEqual(isValidEmail('plainaddress'), false);
    assert.strictEqual(isValidEmail('@missinguser.com'), false);
    assert.strictEqual(isValidEmail('no-tld@domain'), false);
    assert.strictEqual(isValidEmail(''), false);

    // Valid phones
    assert.strictEqual(isValidPhoneNumber('+91 9876543210'), true);
    assert.strictEqual(isValidPhoneNumber('9876543210'), true);
    assert.strictEqual(isValidPhoneNumber('+1 (555) 123-4567'), true);
    assert.strictEqual(isValidPhoneNumber('+44-20-7946-0958'), true);
    // Invalid phones
    assert.strictEqual(isValidPhoneNumber('123'), false); // too short
    assert.strictEqual(isValidPhoneNumber('abcdefghijk'), false); // letters
    assert.strictEqual(isValidPhoneNumber(''), false);
  });

  test('4. Idempotent Ticket Setup: Re-running .ticket setup updates panel in place without duplicate messages or channels', async () => {
    const guild = createMockGuild({ id: 'guild-idempotent-ticket' });
    const admin = createMockMember(guild, { isAdmin: true });

    let firstReply = '';
    await handleTicketSetupCommand(guild, admin, null, async (msg) => {
      firstReply = typeof msg === 'object' ? msg.content : msg;
    });

    assert.ok(firstReply.includes('Support ticket panel created'), 'Initial setup confirms creation');

    const panelChannels = Array.from(guild.channels.cache.values()).filter(
      (c) => c.name === 'support-ticket'
    );
    assert.strictEqual(panelChannels.length, 1, 'Only one #support-ticket channel created');
    const panelCh = panelChannels[0];
    assert.strictEqual(panelCh._messages.length, 1, 'Initial panel has 1 message');

    // Run setup second time -> must UPDATE existing panel in place
    let secondReply = '';
    await handleTicketSetupCommand(guild, admin, null, async (msg) => {
      secondReply = typeof msg === 'object' ? msg.content : msg;
    });

    assert.ok(secondReply.includes('already configured and was updated in place'), 'Informs updated in place');

    // Verify channel and message count did NOT duplicate
    const panelChannelsAfter = Array.from(guild.channels.cache.values()).filter(
      (c) => c.name === 'support-ticket'
    );
    assert.strictEqual(panelChannelsAfter.length, 1, 'No duplicate #support-ticket channel');
    assert.strictEqual(panelCh._messages.length, 1, 'No duplicate panel message created');
  });

  test('5. Apply as Staff: Choosing "Apply as Staff" triggers the modal immediately', async () => {
    const guild = createMockGuild();
    const applicant = createMockMember(guild, { id: 'applicant-1' });

    let shownModal = null;
    const mockInteraction = {
      guild,
      user: applicant.user,
      member: applicant,
      customId: 'ticket:select_category',
      values: ['apply_staff'],
      isStringSelectMenu: () => true,
      isButton: () => false,
      showModal: async (modal) => {
        shownModal = modal;
      },
    };

    const handled = await handleTicketInteraction(mockInteraction);
    assert.strictEqual(handled, true);
    assert.ok(shownModal, 'Modal was shown to applicant');
    assert.strictEqual(shownModal.data.title, 'Staff Application Form');
    assert.strictEqual(shownModal.data.custom_id, 'ticket:staff_modal');
  });

  test('6. Modal Submit: Validates fields and provides Step 2 role multi-select menu', async () => {
    const guild = createMockGuild();
    const applicant = createMockMember(guild, { id: 'applicant-2' });

    let replyPayload = null;
    const mockModalSubmit = {
      guild,
      user: applicant.user,
      member: applicant,
      customId: 'ticket:staff_modal',
      isModalSubmit: () => true,
      isStringSelectMenu: () => false,
      isButton: () => false,
      fields: {
        getTextInputValue: (field) => {
          if (field === 'staff_email') return 'applicant@example.com';
          if (field === 'staff_phone') return '+91 9988776655';
          if (field === 'staff_motivation') return 'I have managed BGMI scrims and hosted tournaments for 2 years.';
          return '';
        },
      },
      reply: async (payload) => {
        replyPayload = payload;
      },
    };

    const handled = await handleTicketInteraction(mockModalSubmit);
    assert.strictEqual(handled, true);
    assert.ok(replyPayload, 'Replied to modal submission');
    assert.strictEqual(replyPayload.ephemeral, true, 'Response is private/ephemeral');

    const selectComponent = replyPayload.components[0].components[0].data;
    assert.ok(selectComponent.custom_id.startsWith('ticket:staff_roles:'), 'Select custom_id links draft');
    assert.strictEqual(selectComponent.min_values, 1);
    assert.strictEqual(selectComponent.max_values, 5, 'Allows selecting all roles');
  });

  test('7. Modal Submit Rejection: Invalid email or phone returns clear ephemeral error', async () => {
    const guild = createMockGuild();
    const applicant = createMockMember(guild, { id: 'applicant-invalid' });

    let errorReply = null;
    const mockInvalidSubmit = {
      guild,
      user: applicant.user,
      member: applicant,
      customId: 'ticket:staff_modal',
      isModalSubmit: () => true,
      isStringSelectMenu: () => false,
      isButton: () => false,
      fields: {
        getTextInputValue: (field) => {
          if (field === 'staff_email') return 'not-an-email';
          if (field === 'staff_phone') return '123';
          if (field === 'staff_motivation') return 'short';
          return '';
        },
      },
      reply: async (payload) => {
        errorReply = payload;
      },
    };

    const handled = await handleTicketInteraction(mockInvalidSubmit);
    assert.strictEqual(handled, true);
    assert.ok(errorReply.content.includes('Invalid Email Address'), 'Rejected invalid email');
  });

  test('8. Full Submission: Submitting roles delivers embed to #staff-application-log and acknowledges applicant', async () => {
    const guild = createMockGuild({ id: 'guild-staff-log-test' });
    const applicant = createMockMember(guild, { id: 'applicant-full-1', tag: 'ProMod#1234' });

    // Pre-create staff-application-log channel
    const staffLogChannel = await guild.channels.create({
      name: 'staff-application-log',
      type: ChannelType.GuildText,
    });

    const draftId = 'draft_guild-staff-log-test_applicant-full-1_1001';
    pendingStaffDrafts.set(draftId, {
      guildId: guild.id,
      userId: applicant.user.id,
      userTag: applicant.user.tag,
      email: 'applicant@matchdistrict.com',
      phone: '+91 9123456789',
      motivation: 'Passionate about esports room making and points calculation.',
      createdAt: Date.now(),
    });

    let updatePayload = null;
    const mockRoleSubmit = {
      guild,
      user: applicant.user,
      member: applicant,
      customId: `ticket:staff_roles:${draftId}`,
      values: ['Mod', 'Room Maker', 'Pt Making'],
      isStringSelectMenu: () => true,
      isModalSubmit: () => false,
      isButton: () => false,
      update: async (payload) => {
        updatePayload = payload;
      },
    };

    const handled = await handleTicketInteraction(mockRoleSubmit);
    assert.strictEqual(handled, true);
    assert.ok(updatePayload, 'Applicant received private acknowledgement');
    assert.ok(updatePayload.content.includes('Staff Application Submitted!'));
    assert.ok(updatePayload.content.includes('Pending'));

    // Check staff-application-log received the complete application embed
    assert.strictEqual(staffLogChannel._messages.length, 1, 'Sent application to #staff-application-log');
    const logMsg = staffLogChannel._messages[0];
    const embed = logMsg.embeds[0];
    assert.strictEqual(embed.data.title, '📋 New Staff Application Received');

    const fields = embed.data.fields;
    const applicantField = fields.find((f) => f.name === 'Applicant');
    assert.ok(applicantField.value.includes(applicant.user.id));

    const emailField = fields.find((f) => f.name === 'Email Address');
    assert.strictEqual(emailField.value, '`applicant@matchdistrict.com`');

    const phoneField = fields.find((f) => f.name === 'Contact Number');
    assert.strictEqual(phoneField.value, '`+91 9123456789`');

    const rolesField = fields.find((f) => f.name === 'Selected Roles');
    assert.ok(rolesField.value.includes('Mod'));
    assert.ok(rolesField.value.includes('Room Maker'));
    assert.ok(rolesField.value.includes('Pt Making'));

    const statusField = fields.find((f) => f.name === 'Application Status');
    assert.ok(statusField.value.includes('Pending'));
  });

  test('9. Ticket Logging: Opening and closing tickets logs to #ticket-log', async () => {
    const guild = createMockGuild({ id: 'guild-ticket-log-test' });
    const user = createMockMember(guild, { id: 'opener-777', tag: 'Opener#0001' });

    // Pre-create ticket-log channel
    const ticketLogCh = await guild.channels.create({
      name: 'ticket-log',
      type: ChannelType.GuildText,
    });

    // 1. Open General Support ticket
    const mockOpenInteraction = {
      guild,
      user: user.user,
      member: user,
      customId: 'ticket:select_category',
      values: ['general_support'],
      isStringSelectMenu: () => true,
      isButton: () => false,
      deferReply: async () => {},
      editReply: async () => {},
    };

    await handleTicketInteraction(mockOpenInteraction);

    // Verify ticket_opened log sent to #ticket-log
    assert.ok(ticketLogCh._messages.length >= 1, 'Logged to #ticket-log');
    const openLog = ticketLogCh._messages[0];
    assert.ok(openLog.embeds[0].data.title.includes('Ticket Opened'));

    // Find the created ticket channel
    const ticketChannel = Array.from(guild.channels.cache.values()).find((c) =>
      c.name.endsWith('-support')
    );
    assert.ok(ticketChannel, 'Ticket channel exists');

    // 2. Close the ticket
    const mockCloseConfirmInteraction = {
      guild,
      user: user.user,
      member: user,
      channel: ticketChannel,
      channelId: ticketChannel.id,
      customId: 'ticket:confirm_close',
      isButton: () => true,
      isStringSelectMenu: () => false,
      update: async () => {},
    };

    await handleTicketInteraction(mockCloseConfirmInteraction);

    // Verify ticket_closed log sent to #ticket-log
    assert.ok(ticketLogCh._messages.length >= 2, 'Logged ticket close to #ticket-log');
    const closeLog = ticketLogCh._messages[1];
    assert.ok(closeLog.embeds[0].data.title.includes('Ticket Closed'));
  });

  test('10. .setup command: Configures ticket-log and staff-application-log idempotently', () => {
    const keys = REQUIRED_CHANNELS.map((c) => c.key);
    assert.ok(keys.includes('ticketLogId'), 'REQUIRED_CHANNELS includes ticketLogId');
    assert.ok(keys.includes('staffAppLogId'), 'REQUIRED_CHANNELS includes staffAppLogId');

    const names = REQUIRED_CHANNELS.map((c) => c.name);
    assert.ok(names.includes('ticket-log'), 'Configures #ticket-log');
    assert.ok(names.includes('staff-application-log'), 'Configures #staff-application-log');
  });
});

