import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import {
  handleAnncSetupCommand,
  handleAnncMenuCommand,
  handleAnnouncementChannelMessage,
  handleAnnouncementInteraction,
  formatAnnouncementDm,
  extractTargetMentions,
  getAnnouncementChannelId,
  fetchAvailableTextChannels,
  buildDeliveryMethodPayload,
  buildChannelSelectionPayload,
  buildComposeModal,
  buildChannelPreviewPayload,
} from '../announcementService.js';
import { getPendingAnnouncement } from '../mongoService.js';
import { guildSettingsCache } from '../index.js';
import { QUEUE_CONFIG } from '../discordQueue.js';

describe('Announcement DM Feature', () => {
  test('1. Setup Command: Rejects non-administrators', async () => {
    let replyContent = '';
    const mockMember = {
      permissions: { has: () => false },
      guild: { ownerId: 'other-id' },
      id: 'user-1',
    };
    const mockGuild = {
      id: 'guild-annc-1',
      members: { me: { permissions: { has: () => true } } },
    };

    await handleAnncSetupCommand(mockGuild, mockMember, null, (msg) => {
      replyContent = typeof msg === 'string' ? msg : msg.content;
    });

    assert.ok(replyContent.includes('Permission Denied'));
  });

  test('2. Setup Command: Rejects when bot lacks Manage Channels permission', async () => {
    let replyContent = '';
    const mockMember = {
      permissions: { has: () => true },
      guild: { ownerId: 'user-1' },
      id: 'user-1',
    };
    const mockGuild = {
      id: 'guild-annc-2',
      members: { me: { permissions: { has: () => false } } },
    };

    await handleAnncSetupCommand(mockGuild, mockMember, null, (msg) => {
      replyContent = typeof msg === 'string' ? msg : msg.content;
    });

    assert.ok(replyContent.includes('Missing Bot Permissions'));
  });

  test('3. Setup Command: Creates announcement-dm private channel and stores ID', async () => {
    let replyContent = '';
    const guildId = 'guild-annc-3';
    let createdChannelData = null;

    const mockChannel = {
      id: 'ch-annc-123',
      name: 'announcement-dm',
      type: ChannelType.GuildText,
      permissionOverwrites: { set: async () => {} },
    };

    const mockChannelsCache = new Map();
    const mockGuild = {
      id: guildId,
      roles: {
        everyone: { id: 'everyone-role' },
      },
      members: {
        me: { id: 'bot-id', permissions: { has: () => true } },
      },
      channels: {
        cache: mockChannelsCache,
        fetch: async (id) => mockChannelsCache.get(id) || null,
        create: async (data) => {
          createdChannelData = data;
          mockChannelsCache.set(mockChannel.id, mockChannel);
          return mockChannel;
        },
      },
    };

    const mockMember = {
      id: 'admin-id',
      guild: { ownerId: 'admin-id' },
      permissions: { has: () => true },
    };

    await handleAnncSetupCommand(mockGuild, mockMember, null, (msg) => {
      replyContent = typeof msg === 'string' ? msg : msg.content;
    });

    assert.ok(replyContent.includes('Announcement DM Channel Configured'));
    assert.equal(createdChannelData.name, 'announcement-dm');
    assert.equal(createdChannelData.type, ChannelType.GuildText);

    // Verify @everyone is denied ViewChannel and SendMessages
    const everyoneOverwrite = createdChannelData.permissionOverwrites.find(
      (o) => o.id === 'everyone-role'
    );
    assert.ok(everyoneOverwrite.deny.includes(PermissionFlagsBits.ViewChannel));
    assert.ok(everyoneOverwrite.deny.includes(PermissionFlagsBits.SendMessages));

    // Verify channel ID is saved in cache/MongoDB
    const storedId = await getAnnouncementChannelId(guildId);
    assert.equal(storedId, 'ch-annc-123');
  });

  test('4. Setup Command: Reuses existing channel found by stored ID', async () => {
    const guildId = 'guild-annc-4';
    guildSettingsCache[guildId] = {
      announcementDmChannelId: 'ch-existing-999',
    };

    let permissionUpdated = false;
    const mockExistingChannel = {
      id: 'ch-existing-999',
      name: 'announcement-dm',
      type: ChannelType.GuildText,
      permissionOverwrites: {
        set: async () => { permissionUpdated = true; },
      },
    };

    const mockChannelsCache = new Map();
    mockChannelsCache.set('ch-existing-999', mockExistingChannel);

    let createdCalled = false;
    const mockGuild = {
      id: guildId,
      roles: { everyone: { id: 'everyone-role' } },
      members: { me: { id: 'bot-id', permissions: { has: () => true } } },
      channels: {
        cache: mockChannelsCache,
        fetch: async (id) => mockChannelsCache.get(id) || null,
        create: async () => { createdCalled = true; },
      },
    };

    const mockMember = {
      id: 'admin-id',
      guild: { ownerId: 'admin-id' },
      permissions: { has: () => true },
    };

    let replyContent = '';
    await handleAnncSetupCommand(mockGuild, mockMember, null, (msg) => {
      replyContent = typeof msg === 'string' ? msg : msg.content;
    });

    assert.equal(createdCalled, false);
    assert.equal(permissionUpdated, true);
    assert.ok(replyContent.includes('Announcement DM Channel Configured'));
    assert.ok(replyContent.includes('ch-existing-999'));
  });

  test('5. Mentions Extraction: Identifies @everyone and roles correctly', () => {
    const rolesMap = new Map();
    rolesMap.set('role-mods', { id: 'role-mods', name: 'mods' });

    const msgWithEveryone = {
      content: 'Hey @everyone this is an update!',
      mentions: { everyone: true, roles: new Map() },
    };
    const target1 = extractTargetMentions(msgWithEveryone);
    assert.equal(target1.hasEveryone, true);
    assert.equal(target1.hasTarget, true);

    const msgWithRole = {
      content: 'Hello <@&role-mods> check this out',
      mentions: { everyone: false, roles: rolesMap },
    };
    const target2 = extractTargetMentions(msgWithRole);
    assert.equal(target2.hasEveryone, false);
    assert.equal(target2.roles.length, 1);
    assert.equal(target2.roles[0].name, 'mods');
    assert.equal(target2.hasTarget, true);

    const msgWithoutMentions = {
      content: 'Just a casual message with no target mentions',
      mentions: { everyone: false, roles: new Map() },
    };
    const target3 = extractTargetMentions(msgWithoutMentions);
    assert.equal(target3.hasTarget, false);
  });

  test('6. DM Formatting: Removes role mentions and @everyone while keeping formatting and adding header line', () => {
    const roles = [{ id: '111', name: 'participants' }, { id: '222', name: 'vip' }];
    const originalText = `@everyone <@&111>
Welcome to the tournament!

Match starts at 5:00 PM.
Rules:
1. No cheats
2. Join VC

Good luck!`;

    const formatted = formatAnnouncementDm(originalText, roles, 'MatchDistrict League');
    const lines = formatted.split('\n');

    assert.equal(lines[0], '📢 Announcement from MatchDistrict League');
    assert.ok(!formatted.includes('@everyone'));
    assert.ok(!formatted.includes('<@&111>'));
    assert.ok(formatted.includes('Welcome to the tournament!'));
    assert.ok(formatted.includes('Match starts at 5:00 PM.'));
    assert.ok(formatted.includes('1. No cheats'));
  });

  test('7. Announcement Handling: Rejects message with no role or @everyone mention', async () => {
    const guildId = 'guild-annc-7';
    const channelId = 'ch-annc-7';
    guildSettingsCache[guildId] = { announcementDmChannelId: channelId };

    let replyText = '';
    const mockMessage = {
      channel: { id: channelId },
      guild: { id: guildId, name: 'Test Guild' },
      author: { bot: false, id: 'admin-1' },
      member: {
        id: 'admin-1',
        guild: { ownerId: 'admin-1' },
        permissions: { has: () => true },
      },
      content: 'This message has no target mentions.',
      mentions: { everyone: false, roles: new Map() },
      reply: async (text) => { replyText = typeof text === 'string' ? text : text.content; },
    };

    const handled = await handleAnnouncementChannelMessage(mockMessage);
    assert.equal(handled, true);
    assert.ok(replyText.includes('You must mention a role'));
  });

  test('8. Confirmation Flow: Message generates preview with Confirm/Cancel buttons and does NOT send DMs immediately', async () => {
    const guildId = 'guild-annc-8';
    const channelId = 'ch-annc-8';
    guildSettingsCache[guildId] = { announcementDmChannelId: channelId };

    const sentDMs = [];
    const createMockMember = (id, isBot = false, failsDm = false, roleIds = []) => ({
      id,
      user: { id, bot: isBot, tag: `User#${id}` },
      roles: { cache: new Map(roleIds.map((rId) => [rId, { id: rId }])) },
      send: async (payload) => {
        if (failsDm) {
          const err = new Error('Cannot send messages to this user');
          err.code = 50007;
          throw err;
        }
        sentDMs.push({ memberId: id, payload });
      },
    });

    const membersCache = new Map();
    membersCache.set('m1', createMockMember('m1', false, false, ['role-A', 'role-B']));
    membersCache.set('m2', createMockMember('m2', false, false, ['role-B']));
    membersCache.set('m3', createMockMember('m3', false, true, ['role-A']));
    membersCache.set('m4', createMockMember('m4', true, false, ['role-A']));

    const rolesMap = new Map();
    rolesMap.set('role-A', { id: 'role-A', name: 'Role A' });
    rolesMap.set('role-B', { id: 'role-B', name: 'Role B' });

    let previewPayload = null;
    let channelReplies = [];
    const mockChannel = {
      id: channelId,
      send: async (payload) => {
        channelReplies.push(typeof payload === 'string' ? payload : payload.content);
      },
    };

    const mockMessage = {
      id: 'orig-msg-8',
      channel: mockChannel,
      guild: {
        id: guildId,
        name: 'MD Championship',
        members: {
          cache: membersCache,
          fetch: async () => membersCache,
        },
      },
      author: { bot: false, id: 'admin-1', tag: 'Admin#0001' },
      member: {
        id: 'admin-1',
        guild: { ownerId: 'admin-1' },
        permissions: { has: () => true },
      },
      content: '<@&role-A> <@&role-B> Announcement: Match starts now!',
      mentions: { everyone: false, roles: rolesMap },
      reply: async (payload) => {
        previewPayload = payload;
        return {
          id: 'preview-msg-8',
          embeds: payload.embeds,
          components: payload.components,
        };
      },
    };

    const handled = await handleAnnouncementChannelMessage(mockMessage);
    assert.equal(handled, true);

    // Verify preview embed was generated
    assert.ok(previewPayload);
    const embed = previewPayload.embeds[0];
    const embedData = embed.toJSON ? embed.toJSON() : embed;
    assert.equal(embedData.title, '📢 Announcement Preview');
    assert.ok(embedData.description.includes('**3** member(s)'));
    assert.ok(embedData.description.includes('📢 Announcement from MD Championship'));
    assert.ok(embedData.description.includes('Announcement: Match starts now!'));
    assert.ok(!embedData.description.includes('<@&role-A>'));

    // Verify buttons (Confirm and Cancel)
    const components = previewPayload.components[0];
    const buttons = components.components || [];
    assert.equal(buttons.length, 2);
    const confirmBtn = buttons[0].toJSON ? buttons[0].toJSON() : buttons[0];
    const cancelBtn = buttons[1].toJSON ? buttons[1].toJSON() : buttons[1];
    assert.ok(confirmBtn.custom_id.startsWith('annc:confirm:'));
    assert.ok(cancelBtn.custom_id.startsWith('annc:cancel:'));

    // Critical: NO DMs should have been sent yet
    assert.equal(sentDMs.length, 0);

    // Extract announcementId from customId
    const announcementId = confirmBtn.custom_id.split(':')[2];
    const saved = await getPendingAnnouncement(announcementId);
    assert.ok(saved);
    assert.equal(saved.authorId, 'admin-1');
    assert.equal(saved.recipientCount, 3);

    // Now test Confirm button execution:
    let updatePayload = null;
    const confirmInteraction = {
      isButton: () => true,
      customId: confirmBtn.custom_id,
      user: { id: 'admin-1' },
      guild: mockMessage.guild,
      channel: mockChannel,
      message: { embeds: [embed] },
      update: async (payload) => {
        updatePayload = payload;
      },
    };

    const interactionResult = await handleAnnouncementInteraction(confirmInteraction);
    assert.equal(interactionResult, true);

    // Verify preview changed to "Sending..." and buttons disabled
    assert.ok(updatePayload);
    const sendingEmbed = updatePayload.embeds[0].toJSON ? updatePayload.embeds[0].toJSON() : updatePayload.embeds[0];
    assert.equal(sendingEmbed.title, '📢 Announcement Sending...');
    assert.ok(sendingEmbed.description.includes('Sending...'));
    const disabledButtons = updatePayload.components[0].components.map((b) => (b.toJSON ? b.toJSON() : b));
    assert.equal(disabledButtons[0].disabled, true);
    assert.equal(disabledButtons[1].disabled, true);

    // Verify pending announcement was deleted straight away
    const afterConfirm = await getPendingAnnouncement(announcementId);
    assert.equal(afterConfirm, null);

    // Wait for DM delivery and summary
    for (let i = 0; i < 40; i++) {
      if (channelReplies.some((r) => r && r.includes('Announcement DM Summary'))) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    // Verify DMs sent:
    // m1 received 1 DM (deduplicated across role-A and role-B)
    // m2 received 1 DM
    // m3 failed (DMs closed)
    // m4 skipped (bot)
    assert.equal(sentDMs.length, 2);
    assert.equal(sentDMs.filter((d) => d.memberId === 'm1').length, 1);
    assert.equal(sentDMs.filter((d) => d.memberId === 'm2').length, 1);

    // Verify DM content
    const dm = sentDMs[0].payload.content;
    assert.ok(dm.startsWith('📢 Announcement from MD Championship'));
    assert.ok(dm.includes('Announcement: Match starts now!'));

    // Verify summary posted in channel
    const summaryMsg = channelReplies.find((r) => r.includes('Announcement DM Summary'));
    assert.ok(summaryMsg);
    assert.ok(summaryMsg.includes('Sent Successfully') && summaryMsg.includes('2'));
    assert.ok(summaryMsg.includes('Failed / DMs Closed') && summaryMsg.includes('1'));
    assert.ok(summaryMsg.includes('Total Recipients') && summaryMsg.includes('3'));
  });

  test('9. Cancel Action: Disables buttons, updates preview to Cancelled, deletes record, and sends 0 DMs', async () => {
    const guildId = 'guild-annc-9';
    const channelId = 'ch-annc-9';
    guildSettingsCache[guildId] = { announcementDmChannelId: channelId };

    const sentDMs = [];
    const membersCache = new Map();
    membersCache.set('u1', {
      id: 'u1',
      user: { id: 'u1', bot: false },
      roles: { cache: new Map([['role-x', { id: 'role-x' }]]) },
      send: async (p) => { sentDMs.push(p); },
    });

    const rolesMap = new Map([['role-x', { id: 'role-x', name: 'Role X' }]]);
    let previewPayload = null;

    const mockMessage = {
      id: 'orig-msg-9',
      channel: { id: channelId, send: async () => {} },
      guild: {
        id: guildId,
        name: 'Guild 9',
        members: { cache: membersCache, fetch: async () => membersCache },
      },
      author: { bot: false, id: 'admin-9', tag: 'Admin9#0009' },
      member: { id: 'admin-9', guild: { ownerId: 'admin-9' }, permissions: { has: () => true } },
      content: '<@&role-x> Important update',
      mentions: { everyone: false, roles: rolesMap },
      reply: async (payload) => {
        previewPayload = payload;
        return { id: 'preview-9', embeds: payload.embeds, components: payload.components };
      },
    };

    await handleAnnouncementChannelMessage(mockMessage);
    const cancelBtn = previewPayload.components[0].components[1].toJSON();
    const announcementId = cancelBtn.custom_id.split(':')[2];

    let updatePayload = null;
    const cancelInteraction = {
      isButton: () => true,
      customId: cancelBtn.custom_id,
      user: { id: 'admin-9' },
      guild: mockMessage.guild,
      channel: mockMessage.channel,
      message: { embeds: previewPayload.embeds },
      update: async (payload) => {
        updatePayload = payload;
      },
    };

    const handled = await handleAnnouncementInteraction(cancelInteraction);
    assert.equal(handled, true);

    // Verify preview updated to Cancelled
    assert.ok(updatePayload);
    const cancelledEmbed = updatePayload.embeds[0].toJSON ? updatePayload.embeds[0].toJSON() : updatePayload.embeds[0];
    assert.equal(cancelledEmbed.title, '📢 Announcement Cancelled');
    assert.ok(cancelledEmbed.description.includes('Cancelled'));

    // Verify buttons are disabled
    const disabledButtons = updatePayload.components[0].components.map((b) => (b.toJSON ? b.toJSON() : b));
    assert.equal(disabledButtons[0].disabled, true);
    assert.equal(disabledButtons[1].disabled, true);

    // Verify record deleted from database and NO DMs were sent
    assert.equal(await getPendingAnnouncement(announcementId), null);
    assert.equal(sentDMs.length, 0);
  });

  test('10. Authorization Check: Only author administrator can click Confirm/Cancel', async () => {
    const guildId = 'guild-annc-10';
    const channelId = 'ch-annc-10';
    guildSettingsCache[guildId] = { announcementDmChannelId: channelId };

    const membersCache = new Map([
      ['u1', { id: 'u1', user: { id: 'u1', bot: false }, roles: { cache: new Map([['r1', { id: 'r1' }]]) } }],
    ]);
    const rolesMap = new Map([['r1', { id: 'r1', name: 'R1' }]]);

    let previewPayload = null;
    const mockMessage = {
      id: 'orig-msg-10',
      channel: { id: channelId, send: async () => {} },
      guild: { id: guildId, name: 'Guild 10', members: { cache: membersCache, fetch: async () => membersCache } },
      author: { bot: false, id: 'original-admin', tag: 'OrigAdmin#0001' },
      member: { id: 'original-admin', guild: { ownerId: 'owner' }, permissions: { has: () => true } },
      content: '<@&r1> Test auth',
      mentions: { everyone: false, roles: rolesMap },
      reply: async (payload) => {
        previewPayload = payload;
        return { id: 'preview-10', embeds: payload.embeds, components: payload.components };
      },
    };

    await handleAnnouncementChannelMessage(mockMessage);
    const confirmBtn = previewPayload.components[0].components[0].toJSON();
    const announcementId = confirmBtn.custom_id.split(':')[2];

    let replyPayload = null;
    let updateCalled = false;
    const intruderInteraction = {
      isButton: () => true,
      customId: confirmBtn.custom_id,
      user: { id: 'different-admin' },
      message: { embeds: previewPayload.embeds },
      reply: async (payload) => { replyPayload = payload; },
      update: async () => { updateCalled = true; },
    };

    await handleAnnouncementInteraction(intruderInteraction);

    assert.equal(updateCalled, false);
    assert.ok(replyPayload);
    assert.equal(replyPayload.ephemeral, true);
    assert.ok(replyPayload.content.includes('Permission Denied'));

    // Record remains pending
    const stillPending = await getPendingAnnouncement(announcementId);
    assert.ok(stillPending);
  });

  test('11. Already Handled: Replying to an already handled announcement returns notice', async () => {
    let replyPayload = null;
    const interaction = {
      isButton: () => true,
      customId: 'annc:confirm:non-existent-annc-id',
      user: { id: 'admin-1' },
      reply: async (payload) => { replyPayload = payload; },
    };

    const handled = await handleAnnouncementInteraction(interaction);
    assert.equal(handled, true);
    assert.ok(replyPayload);
    assert.equal(replyPayload.ephemeral, true);
    assert.ok(replyPayload.content.includes('already been handled'));
  });

  test('12. Security & Access: Ignores messages from bots and non-administrators', async () => {
    const guildId = 'guild-annc-12';
    const channelId = 'ch-annc-12';
    guildSettingsCache[guildId] = { announcementDmChannelId: channelId };

    let replyCalled = false;
    const botMessage = {
      channel: { id: channelId },
      guild: { id: guildId },
      author: { bot: true },
      content: '@everyone spam',
      reply: async () => { replyCalled = true; },
    };
    const handledBot = await handleAnnouncementChannelMessage(botMessage);
    assert.equal(handledBot, false);
    assert.equal(replyCalled, false);

    const nonAdminMessage = {
      channel: { id: channelId },
      guild: { id: guildId },
      author: { bot: false, id: 'user-regular' },
      member: {
        id: 'user-regular',
        guild: { ownerId: 'server-owner' },
        permissions: { has: () => false },
      },
      content: '@everyone unauthorized',
      reply: async () => { replyCalled = true; },
    };
    const handledNonAdmin = await handleAnnouncementChannelMessage(nonAdminMessage);
    assert.equal(handledNonAdmin, true); // consumed but ignored
    assert.equal(replyCalled, false);
  });

  test('13. Menu Command: Rejects non-administrators from .annc', async () => {
    let replyText = '';
    const nonAdminMember = {
      id: 'user-regular',
      guild: { ownerId: 'server-owner' },
      permissions: { has: () => false },
    };
    const mockGuild = { id: 'g13', channels: { cache: new Map() } };

    await handleAnncMenuCommand(
      mockGuild,
      nonAdminMember,
      { id: 'ch13' },
      (msg) => { replyText = typeof msg === 'string' ? msg : msg.content; },
      ''
    );

    assert.ok(replyText.includes('Permission Denied'));
  });

  test('14. Menu Command: Displays Delivery Method Selector with Channel and DM options', async () => {
    let replyPayload = null;
    const adminMember = {
      id: 'admin-14',
      user: { id: 'admin-14', tag: 'Admin#0001' },
      guild: { ownerId: 'admin-14' },
      permissions: { has: () => true },
    };
    const mockGuild = { id: 'g14', channels: { cache: new Map() } };

    await handleAnncMenuCommand(
      mockGuild,
      adminMember,
      { id: 'ch14' },
      (msg) => { replyPayload = msg; },
      ''
    );

    assert.ok(replyPayload);
    assert.ok(replyPayload.embeds?.[0]?.data?.title.includes('Announcement Manager'));
    const buttons = replyPayload.components[0].components;
    assert.equal(buttons.length, 3);
    assert.ok(buttons[0].data.label.includes('Channel Announcement'));
    assert.ok(buttons[1].data.label.includes('Member DM Announcement'));
    assert.ok(buttons[2].data.label.includes('Cancel'));
  });

  test('15. Menu Command (.annc channel): Opens Channel Selection dropdown directly', async () => {
    let replyPayload = null;
    const adminMember = {
      id: 'admin-15',
      user: { id: 'admin-15', tag: 'Admin#0001' },
      guild: { ownerId: 'admin-15' },
      permissions: { has: () => true },
    };
    const channelsMap = new Map([
      ['ch-1', { id: 'ch-1', name: 'general', type: ChannelType.GuildText, position: 0, permissionsFor: () => ({ has: () => true }) }],
      ['ch-2', { id: 'ch-2', name: 'announcements', type: ChannelType.GuildAnnouncement, position: 1, permissionsFor: () => ({ has: () => true }) }],
    ]);
    const mockGuild = { id: 'g15', channels: { cache: channelsMap }, members: { me: { id: 'bot-1' } } };

    await handleAnncMenuCommand(
      mockGuild,
      adminMember,
      { id: 'ch15' },
      (msg) => { replyPayload = msg; },
      'channel',
      ['channel', 'Important update for everyone!']
    );

    assert.ok(replyPayload);
    assert.ok(replyPayload.embeds?.[0]?.data?.title.includes('Select Target Channels'));
    const selectMenu = replyPayload.components[0].components[0];
    assert.ok(selectMenu.data.custom_id.startsWith('annc:select_channels:'));
    assert.equal(selectMenu.options.length, 2);
    assert.equal(selectMenu.data.min_values, 1);
    assert.equal(selectMenu.data.max_values, 2);
  });

  test('16. Channel Filter: fetchAvailableTextChannels filters text types and checks bot permissions', () => {
    const mockBot = { id: 'bot-id' };
    const channelsMap = new Map([
      ['voice-1', { id: 'v1', name: 'General Voice', type: ChannelType.GuildVoice, position: 1 }],
      ['category-1', { id: 'c1', name: 'Category', type: ChannelType.GuildCategory, position: 0 }],
      [
        'text-valid',
        {
          id: 't1',
          name: 'general-chat',
          type: ChannelType.GuildText,
          position: 2,
          permissionsFor: (me) => ({ has: (flag) => flag === PermissionFlagsBits.ViewChannel || flag === PermissionFlagsBits.SendMessages }),
        },
      ],
      [
        'text-no-send',
        {
          id: 't2',
          name: 'read-only',
          type: ChannelType.GuildText,
          position: 3,
          permissionsFor: (me) => ({ has: (flag) => flag === PermissionFlagsBits.ViewChannel }), // lacks SendMessages
        },
      ],
      [
        'news-valid',
        {
          id: 'n1',
          name: 'news',
          type: ChannelType.GuildAnnouncement,
          position: 4,
          permissionsFor: (me) => ({ has: () => true }),
        },
      ],
    ]);

    const mockGuild = {
      channels: { cache: channelsMap },
      members: { me: mockBot },
    };

    const eligible = fetchAvailableTextChannels(mockGuild);
    assert.equal(eligible.length, 2);
    assert.equal(eligible[0].id, 't1');
    assert.equal(eligible[1].id, 'n1');
  });

  test('17. Interaction: Selecting channels transitions to confirmation preview when content exists', async () => {
    const adminId = 'admin-17';
    const announcementId = 'annc-flow-17';
    const channelsMap = new Map([
      ['ch-general', { id: 'ch-general', name: 'general', type: ChannelType.GuildText }],
      ['ch-updates', { id: 'ch-updates', name: 'updates', type: ChannelType.GuildText }],
    ]);
    const mockGuild = { id: 'g17', channels: { cache: channelsMap } };

    // Seed pending announcement with pre-existing content
    const { savePendingAnnouncement } = await import('../mongoService.js');
    await savePendingAnnouncement({
      announcementId,
      guildId: 'g17',
      channelId: 'ch-cmd',
      authorId: adminId,
      content: 'Server maintenance scheduled for tonight at 11 PM IST.',
      createdAt: new Date(),
    });

    let updatedPayload = null;
    const selectInteraction = {
      isStringSelectMenu: () => true,
      customId: `annc:select_channels:${announcementId}`,
      values: ['ch-general', 'ch-updates'],
      user: { id: adminId },
      member: { id: adminId, permissions: { has: () => true }, guild: { ownerId: adminId } },
      guild: mockGuild,
      update: async (payload) => { updatedPayload = payload; },
    };

    await handleAnnouncementInteraction(selectInteraction);

    assert.ok(updatedPayload);
    assert.ok(updatedPayload.embeds?.[0]?.data?.title.includes('Channel Announcement Preview'));
    assert.ok(updatedPayload.embeds[0].data.description.includes('ch-general'));
    assert.ok(updatedPayload.embeds[0].data.description.includes('ch-updates'));
    assert.ok(updatedPayload.embeds[0].data.description.includes('Server maintenance scheduled'));

    const actionRow = updatedPayload.components[0];
    const buttons = actionRow.components;
    assert.equal(buttons.length, 3);
    assert.ok(buttons[0].data.label.includes('Confirm & Send'));
    assert.ok(buttons[1].data.label.includes('Edit Message'));
    assert.ok(buttons[2].data.label.includes('Cancel'));

    const pendingAfter = await getPendingAnnouncement(announcementId);
    assert.deepEqual(pendingAfter.targetChannelIds, ['ch-general', 'ch-updates']);
  });

  test('18. Modal Interaction: Submitting modal saves content and renders confirmation preview', async () => {
    const adminId = 'admin-18';
    const announcementId = 'annc-flow-18';
    const channelsMap = new Map([
      ['ch-annc', { id: 'ch-annc', name: 'official-announcements', type: ChannelType.GuildText }],
    ]);
    const mockGuild = { id: 'g18', channels: { cache: channelsMap } };

    const { savePendingAnnouncement } = await import('../mongoService.js');
    await savePendingAnnouncement({
      announcementId,
      guildId: 'g18',
      channelId: 'ch-origin',
      authorId: adminId,
      targetChannelIds: ['ch-annc'],
      content: '',
      createdAt: new Date(),
    });

    let previewPayload = null;
    const modalInteraction = {
      isModalSubmit: () => true,
      customId: `annc:modal:${announcementId}`,
      user: { id: adminId },
      member: { id: adminId, permissions: { has: () => true }, guild: { ownerId: adminId } },
      guild: mockGuild,
      fields: {
        getTextInputValue: (field) => {
          if (field === 'annc_title') return '🏆 GRAND TOURNAMENT FINALS';
          if (field === 'annc_content') return 'Matches begin this Sunday at 6 PM. Good luck to all squads!';
          return '';
        },
      },
      update: async (payload) => { previewPayload = payload; },
    };

    await handleAnnouncementInteraction(modalInteraction);

    assert.ok(previewPayload);
    assert.ok(previewPayload.embeds?.[0]?.data?.title.includes('Channel Announcement Preview'));
    assert.ok(previewPayload.embeds[0].data.description.includes('GRAND TOURNAMENT FINALS'));
    assert.ok(previewPayload.embeds[0].data.description.includes('Matches begin this Sunday'));

    const pendingAfter = await getPendingAnnouncement(announcementId);
    assert.ok(pendingAfter.content.includes('GRAND TOURNAMENT FINALS'));
  });

  test('19. Channel Confirm: Immediately deletes pending record, sends messages, skips missing permissions, and posts delivery summary', async () => {
    const adminId = 'admin-19';
    const announcementId = 'annc-confirm-19';

    const sentInChannel1 = [];
    const channel1 = {
      id: 'target-ch-1',
      name: 'tournament-announcements',
      permissionsFor: () => ({ has: () => true }),
      send: async (msg) => {
        sentInChannel1.push(msg);
        return { id: 'sent-msg-1' };
      },
    };

    const channel2Restricted = {
      id: 'target-ch-2',
      name: 'admin-only',
      permissionsFor: () => ({
        has: (flag) => flag === PermissionFlagsBits.ViewChannel, // has View, but lacks Send
      }),
      send: async () => { throw new Error('Missing permissions'); },
    };

    const originChannelMessages = [];
    const originChannel = {
      id: 'origin-ch',
      send: async (msg) => {
        originChannelMessages.push(msg);
        return { id: 'summary-msg' };
      },
    };

    const channelsMap = new Map([
      ['target-ch-1', channel1],
      ['target-ch-2', channel2Restricted],
      ['origin-ch', originChannel],
    ]);

    const mockGuild = {
      id: 'g19',
      channels: { cache: channelsMap },
      members: { me: { id: 'bot-19' } },
    };

    const { savePendingAnnouncement } = await import('../mongoService.js');
    await savePendingAnnouncement({
      announcementId,
      guildId: 'g19',
      channelId: 'origin-ch',
      authorId: adminId,
      targetChannelIds: ['target-ch-1', 'target-ch-2'],
      content: '🚨 Registration deadline extended by 24 hours!',
      deliveryType: 'channel',
      createdAt: new Date(),
    });

    let updatePayload = null;
    const confirmInteraction = {
      isButton: () => true,
      customId: `annc:confirm_channel:${announcementId}`,
      user: { id: adminId },
      member: { id: adminId, permissions: { has: () => true }, guild: { ownerId: adminId } },
      channel: originChannel,
      guild: mockGuild,
      message: { embeds: [{ data: { title: '📢 Channel Announcement Preview' } }] },
      update: async (payload) => { updatePayload = payload; },
    };

    await handleAnnouncementInteraction(confirmInteraction);

    // 1. Pending announcement deleted immediately to prevent double sending
    const pendingAfter = await getPendingAnnouncement(announcementId);
    assert.equal(pendingAfter, null);

    // 2. Buttons in preview message are disabled
    assert.ok(updatePayload);
    const disabledButtons = updatePayload.components[0].components;
    assert.ok(disabledButtons.every((btn) => btn.data.disabled === true));

    // 3. Wait for background delivery queue
    await new Promise((resolve) => setTimeout(resolve, 80));

    // 4. Sent successfully to channel 1
    assert.equal(sentInChannel1.length, 1);
    assert.ok(sentInChannel1[0].content.includes('Registration deadline extended'));

    // 5. Summary embed posted with successful & skipped details
    assert.equal(originChannelMessages.length, 1);
    const summaryEmbed = originChannelMessages[0].embeds[0];
    assert.ok(summaryEmbed.data.title.includes('Channel Announcement Summary'));
    assert.ok(summaryEmbed.data.description.includes('Sent Successfully:** **1**'));
    assert.ok(summaryEmbed.data.description.includes('Skipped (Missing Permissions):** **1**'));
    assert.ok(summaryEmbed.data.description.includes('target-ch-1'));
    assert.ok(summaryEmbed.data.description.includes('target-ch-2'));
  });

  test('20. Channel Cancel: Disables preview buttons, deletes pending record, sends 0 messages', async () => {
    const adminId = 'admin-20';
    const announcementId = 'annc-cancel-20';
    let sendCount = 0;

    const channel1 = {
      id: 'ch-target-20',
      send: async () => { sendCount++; },
    };
    const channelsMap = new Map([['ch-target-20', channel1]]);
    const mockGuild = { id: 'g20', channels: { cache: channelsMap } };

    const { savePendingAnnouncement } = await import('../mongoService.js');
    await savePendingAnnouncement({
      announcementId,
      guildId: 'g20',
      channelId: 'ch-origin-20',
      authorId: adminId,
      targetChannelIds: ['ch-target-20'],
      content: 'This announcement will be cancelled.',
      deliveryType: 'channel',
      createdAt: new Date(),
    });

    let updatePayload = null;
    const cancelInteraction = {
      isButton: () => true,
      customId: `annc:cancel:${announcementId}`,
      user: { id: adminId },
      member: { id: adminId, permissions: { has: () => true }, guild: { ownerId: adminId } },
      guild: mockGuild,
      message: { embeds: [{ data: { title: '📢 Channel Announcement Preview' } }] },
      update: async (payload) => { updatePayload = payload; },
    };

    await handleAnnouncementInteraction(cancelInteraction);

    // Record deleted
    const pendingAfter = await getPendingAnnouncement(announcementId);
    assert.equal(pendingAfter, null);

    // Embed updated to cancelled
    assert.ok(updatePayload);
    assert.ok(updatePayload.embeds[0].data.title.includes('Cancelled'));
    assert.ok(updatePayload.embeds[0].data.description.includes('No messages were sent'));
    const buttons = updatePayload.components[0].components;
    assert.ok(buttons.every((b) => b.data.disabled === true));

    // Zero messages sent
    assert.equal(sendCount, 0);
  });

  test('21. Channel Authorization: Non-author administrator cannot confirm, edit, or cancel channel announcement', async () => {
    const authorAdminId = 'author-admin-21';
    const intruderAdminId = 'intruder-admin-21';
    const announcementId = 'annc-auth-21';

    const { savePendingAnnouncement } = await import('../mongoService.js');
    await savePendingAnnouncement({
      announcementId,
      guildId: 'g21',
      channelId: 'ch-21',
      authorId: authorAdminId,
      targetChannelIds: ['ch-21'],
      content: 'Strict authorization test',
      deliveryType: 'channel',
      createdAt: new Date(),
    });

    let replyPayload = null;
    let updateCalled = false;
    const intruderInteraction = {
      isButton: () => true,
      customId: `annc:confirm_channel:${announcementId}`,
      user: { id: intruderAdminId },
      member: { id: intruderAdminId, permissions: { has: () => true }, guild: { ownerId: 'owner-21' } },
      message: { embeds: [{ data: { title: 'Preview' } }] },
      reply: async (payload) => { replyPayload = payload; },
      update: async () => { updateCalled = true; },
    };

    await handleAnnouncementInteraction(intruderInteraction);

    assert.equal(updateCalled, false);
    assert.ok(replyPayload);
    assert.equal(replyPayload.ephemeral, true);
    assert.ok(replyPayload.content.includes('Permission Denied'));

    // Record remains pending
    const stillPending = await getPendingAnnouncement(announcementId);
    assert.ok(stillPending);
  });
});
