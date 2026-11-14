import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleCentralVerificationSetupCommand,
  handleCentralVerificationInteraction,
  handleCentralVerificationMessage,
  cleanupCentralVerificationOfflineMessages,
  getCentralVerificationConfig,
  centralVerificationConfigsCache,
  initCentralVerificationConfigsCache,
  buildDashboardPayload,
  centralVerificationRateLimits,
  resolveGuildInviteUrl,
} from '../centralVerificationService.js';
import {
  saveCentralVerificationConfig,
  getCentralVerificationConfig as getDbConfig,
  localCentralVerificationConfigs,
  localPendingVerifications,
  createPendingTournamentVerification,
  getActivePendingTournamentVerificationForUser,
  getPendingTournamentVerification,
} from '../mongoService.js';
import {
  syncTeamPlayerMemberships,
  checkTournamentPlayerExclusivity,
  clearInMemoryData,
} from '../configurableTournamentData.js';
import { PermissionFlagsBits, ChannelType } from 'discord.js';

// Setup Mock Guild and Discord Environment Helpers
function createMockGuild(options = {}) {
  const guildId = options.id || `guild-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const channels = new Map();
  const members = new Map();
  const roles = new Map();

  const everyoneRole = {
    id: `role-everyone-${guildId}`,
    name: '@everyone',
  };
  roles.set(everyoneRole.id, everyoneRole);

  const botMember = {
    id: 'bot-district-manager',
    user: { id: 'bot-district-manager', bot: true },
    permissions: {
      has: (perm) => {
        if (options.botMissingManageChannels && perm === PermissionFlagsBits.ManageChannels) return false;
        return true;
      },
    },
  };
  members.set(botMember.id, botMember);

  const mockGuild = {
    id: guildId,
    name: 'Test Esports Arena',
    ownerId: 'owner-user-999',
    vanityURLCode: options.vanityURLCode || null,
    roles: {
      everyone: everyoneRole,
      cache: roles,
    },
    members: {
      me: botMember,
      cache: members,
      fetch: async (id) => members.get(id) || null,
      fetchMe: async () => botMember,
    },
    invites: {
      fetch: async () => {
        if (options.invites) return options.invites;
        return new Map();
      },
    },
    channels: {
      cache: channels,
      create: async ({ name, type, parent, permissionOverwrites }) => {
        const chanId = `chan-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const messages = new Map();
        const overwritesMap = new Map();

        const channelObj = {
          id: chanId,
          name,
          type,
          parentId: parent || null,
          guild: mockGuild,
          permissionOverwrites: {
            set: async (overwrites) => {
              overwritesMap.clear();
              for (const ow of overwrites) overwritesMap.set(ow.id, ow);
            },
            get: (id) => overwritesMap.get(id),
            cache: overwritesMap,
          },
          setParent: async (pid) => {
            channelObj.parentId = pid;
          },
          messages: {
            fetch: async (query) => {
              if (typeof query === 'string') {
                return messages.get(query) || null;
              }
              return messages;
            },
          },
          send: async (payload) => {
            const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            const msgObj = {
              id: msgId,
              channel: channelObj,
              content: typeof payload === 'string' ? payload : payload.content || '',
              embeds: payload.embeds || [],
              components: payload.components || [],
              author: { id: 'bot-district-manager', bot: true },
              createdTimestamp: Date.now(),
              deleted: false,
              delete: async () => {
                msgObj.deleted = true;
                messages.delete(msgId);
              },
              edit: async (updatePayload) => {
                msgObj.content = typeof updatePayload === 'string' ? updatePayload : updatePayload.content || msgObj.content;
                msgObj.embeds = updatePayload.embeds || msgObj.embeds;
                msgObj.components = updatePayload.components || msgObj.components;
                return msgObj;
              },
            };
            messages.set(msgId, msgObj);
            return msgObj;
          },
        };

        if (permissionOverwrites) {
          await channelObj.permissionOverwrites.set(permissionOverwrites);
        }

        channels.set(chanId, channelObj);
        return channelObj;
      },
      fetch: async (id) => channels.get(id) || null,
    },
  };

  return { mockGuild, channels, members, roles, botMember };
}

function createMockAdminMember(guild, id = 'admin-user-001') {
  const member = {
    id,
    user: { id, bot: false, tag: `AdminUser#${id.slice(-4)}` },
    guild,
    permissions: {
      has: () => true,
    },
  };
  guild.members.cache.set(id, member);
  return member;
}

function createMockNonAdminMember(guild, id = 'player-user-002') {
  const member = {
    id,
    user: { id, bot: false, tag: `PlayerUser#${id.slice(-4)}` },
    guild,
    permissions: {
      has: () => false,
    },
  };
  guild.members.cache.set(id, member);
  return member;
}

test('Central Tournament Verification Suite', async (suite) => {
  suite.beforeEach(() => {
    centralVerificationConfigsCache.clear();
    localCentralVerificationConfigs.clear();
    centralVerificationRateLimits.clear();
    localPendingVerifications.clear();
    clearInMemoryData();
  });

  // --------------------------------------------------------------------------
  // 1. Setup Command: Non-admin authorization check
  // --------------------------------------------------------------------------
  await suite.test('1. Setup Command: Non-admin execution is rejected with Permission Denied embed', async () => {
    const { mockGuild, channels } = createMockGuild();
    const nonAdmin = createMockNonAdminMember(mockGuild);

    let replyPayload = null;
    await handleCentralVerificationSetupCommand(
      mockGuild,
      nonAdmin,
      { id: 'chan-any' },
      (payload) => { replyPayload = payload; }
    );

    assert.ok(replyPayload);
    assert.strictEqual(replyPayload.embeds[0].data.title, '⛔ Permission Denied');
    assert.strictEqual(channels.size, 0, 'No channels should be created');
  });

  // --------------------------------------------------------------------------
  // 2. Setup Command: Missing bot permissions
  // --------------------------------------------------------------------------
  await suite.test('2. Setup Command: Bot missing Manage Channels permission returns error', async () => {
    const { mockGuild, channels } = createMockGuild({ botMissingManageChannels: true });
    const admin = createMockAdminMember(mockGuild);

    let replyPayload = null;
    await handleCentralVerificationSetupCommand(
      mockGuild,
      admin,
      { id: 'chan-any' },
      (payload) => { replyPayload = payload; }
    );

    assert.ok(replyPayload);
    assert.strictEqual(replyPayload.embeds[0].data.title, '⛔ Missing Permissions');
    assert.strictEqual(channels.size, 0, 'No channels should be created');
  });

  // --------------------------------------------------------------------------
  // 3. Setup Command: Creates category, #verify-setup, and #verify-here
  // --------------------------------------------------------------------------
  await suite.test('3. Setup Command: Creates category, #verify-setup, and #verify-here when none exist', async () => {
    const { mockGuild, channels } = createMockGuild();
    const admin = createMockAdminMember(mockGuild);

    let replyPayload = null;
    await handleCentralVerificationSetupCommand(
      mockGuild,
      admin,
      { id: 'chan-any' },
      (payload) => { replyPayload = payload; }
    );

    assert.ok(replyPayload);
    assert.strictEqual(replyPayload.embeds[0].data.title, '✅ Central Verification Setup Complete');

    assert.strictEqual(channels.size, 3);
    const category = Array.from(channels.values()).find((c) => c.type === ChannelType.GuildCategory);
    const setupChannel = Array.from(channels.values()).find((c) => c.name === 'verify-setup');
    const verifyChannel = Array.from(channels.values()).find((c) => c.name === 'verify-here');

    assert.ok(category, 'Category must be created');
    assert.strictEqual(category.name, 'VERIFICATION');
    assert.ok(setupChannel, '#verify-setup must be created');
    assert.strictEqual(setupChannel.parentId, category.id);
    assert.ok(verifyChannel, '#verify-here must be created');
    assert.strictEqual(verifyChannel.parentId, category.id);

    const config = getCentralVerificationConfig(mockGuild.id);
    assert.strictEqual(config.categoryId, category.id);
    assert.strictEqual(config.setupChannelId, setupChannel.id);
    assert.strictEqual(config.verifyChannelId, verifyChannel.id);
    assert.ok(config.dashboardMessageId, 'Dashboard message ID must be stored');
  });

  // --------------------------------------------------------------------------
  // 4. Setup Command: Idempotency reuses existing channels
  // --------------------------------------------------------------------------
  await suite.test('4. Setup Command: Idempotency reuses existing channels with zero duplicates', async () => {
    const { mockGuild, channels } = createMockGuild();
    const admin = createMockAdminMember(mockGuild);

    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});
    const initialCount = channels.size;
    assert.strictEqual(initialCount, 3);

    const firstConfig = { ...getCentralVerificationConfig(mockGuild.id) };

    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});
    assert.strictEqual(channels.size, 3, 'Zero new channels created on repeated execution');

    const secondConfig = getCentralVerificationConfig(mockGuild.id);
    assert.strictEqual(secondConfig.categoryId, firstConfig.categoryId);
    assert.strictEqual(secondConfig.setupChannelId, firstConfig.setupChannelId);
    assert.strictEqual(secondConfig.verifyChannelId, firstConfig.verifyChannelId);
  });

  // --------------------------------------------------------------------------
  // 5. Setup Command: Partial existence creates only missing channel
  // --------------------------------------------------------------------------
  await suite.test('5. Setup Command: Partial existence creates only the missing channel', async () => {
    const { mockGuild, channels } = createMockGuild();
    const admin = createMockAdminMember(mockGuild);

    const category = await mockGuild.channels.create({ name: 'VERIFICATION', type: ChannelType.GuildCategory });
    const setupChannel = await mockGuild.channels.create({ name: 'verify-setup', type: ChannelType.GuildText, parent: category.id });
    assert.strictEqual(channels.size, 2);

    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});

    assert.strictEqual(channels.size, 3, 'Only 1 additional channel (#verify-here) should be created');
    const verifyChannel = Array.from(channels.values()).find((c) => c.name === 'verify-here');
    assert.ok(verifyChannel);
    assert.strictEqual(verifyChannel.parentId, category.id);
  });

  // --------------------------------------------------------------------------
  // 6. Channel Permissions: #verify-setup
  // --------------------------------------------------------------------------
  await suite.test('6. Channel Permissions: #verify-setup denies @everyone ViewChannel and grants bot full access', async () => {
    const { mockGuild, channels, botMember } = createMockGuild();
    const admin = createMockAdminMember(mockGuild);

    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});
    const setupChannel = Array.from(channels.values()).find((c) => c.name === 'verify-setup');
    assert.ok(setupChannel);

    const everyonePerms = setupChannel.permissionOverwrites.get(mockGuild.roles.everyone.id);
    assert.ok(everyonePerms);
    assert.ok(everyonePerms.deny.includes(PermissionFlagsBits.ViewChannel), '@everyone denied ViewChannel');

    const botPerms = setupChannel.permissionOverwrites.get(botMember.id);
    assert.ok(botPerms);
    assert.ok(botPerms.allow.includes(PermissionFlagsBits.ViewChannel));
    assert.ok(botPerms.allow.includes(PermissionFlagsBits.ManageChannels));
    assert.ok(botPerms.allow.includes(PermissionFlagsBits.SendMessages));
    assert.ok(botPerms.allow.includes(PermissionFlagsBits.EmbedLinks));
    assert.ok(botPerms.allow.includes(PermissionFlagsBits.AttachFiles));
    assert.ok(botPerms.allow.includes(PermissionFlagsBits.ManageMessages));
    assert.ok(botPerms.allow.includes(PermissionFlagsBits.UseExternalEmojis));
  });

  // --------------------------------------------------------------------------
  // 7. Channel Permissions: #verify-here
  // --------------------------------------------------------------------------
  await suite.test('7. Channel Permissions: #verify-here allows View/Send but strictly denies Threads', async () => {
    const { mockGuild, channels, botMember } = createMockGuild();
    const admin = createMockAdminMember(mockGuild);

    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});
    const verifyChannel = Array.from(channels.values()).find((c) => c.name === 'verify-here');
    assert.ok(verifyChannel);

    const everyonePerms = verifyChannel.permissionOverwrites.get(mockGuild.roles.everyone.id);
    assert.ok(everyonePerms);
    assert.ok(everyonePerms.allow.includes(PermissionFlagsBits.ViewChannel));
    assert.ok(everyonePerms.allow.includes(PermissionFlagsBits.SendMessages));
    // STRICT THREAD DENIAL
    assert.ok(everyonePerms.deny.includes(PermissionFlagsBits.CreatePublicThreads));
    assert.ok(everyonePerms.deny.includes(PermissionFlagsBits.CreatePrivateThreads));
    assert.ok(everyonePerms.deny.includes(PermissionFlagsBits.SendMessagesInThreads));

    const botPerms = verifyChannel.permissionOverwrites.get(botMember.id);
    assert.ok(botPerms);
    assert.ok(botPerms.allow.includes(PermissionFlagsBits.ViewChannel));
    assert.ok(botPerms.allow.includes(PermissionFlagsBits.SendMessages));
    assert.ok(botPerms.allow.includes(PermissionFlagsBits.ManageMessages));
    assert.ok(botPerms.allow.includes(PermissionFlagsBits.EmbedLinks));
    assert.ok(botPerms.allow.includes(PermissionFlagsBits.AttachFiles));
    assert.ok(botPerms.allow.includes(PermissionFlagsBits.ReadMessageHistory));
  });

  // --------------------------------------------------------------------------
  // 8. Dashboard Initialization: Correct status & default values
  // --------------------------------------------------------------------------
  await suite.test('8. Dashboard Initialization: Displays status Enabled, mention requirements, and invite controls', async () => {
    const { mockGuild, channels } = createMockGuild();
    const admin = createMockAdminMember(mockGuild);

    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});
    const setupChannel = Array.from(channels.values()).find((c) => c.name === 'verify-setup');
    const config = getCentralVerificationConfig(mockGuild.id);

    const dashMsg = await setupChannel.messages.fetch(config.dashboardMessageId);
    assert.ok(dashMsg, 'Dashboard message must exist');
    assert.strictEqual(dashMsg.embeds[0].data.title, '🛡️ Central Tournament Verification Dashboard');

    const statusField = dashMsg.embeds[0].data.fields.find((f) => f.name === 'System Status');
    assert.ok(statusField.value.includes('Enabled'));

    const mentionField = dashMsg.embeds[0].data.fields.find((f) => f.name === 'Mention Requirements');
    assert.ok(mentionField.value.includes('Solo:') && mentionField.value.includes('`0`'));
    assert.ok(mentionField.value.includes('Duo:') && mentionField.value.includes('`2`'));
    assert.ok(mentionField.value.includes('Squad:') && mentionField.value.includes('`4`'));

    // Check action rows and buttons
    assert.strictEqual(dashMsg.components.length, 2);
    const row1Buttons = dashMsg.components[0].components.map((c) => c.data.custom_id);
    assert.deepStrictEqual(row1Buttons, ['cver:edit:solo', 'cver:edit:duo', 'cver:edit:squad', 'cver:edit:invite']);

    const row2Buttons = dashMsg.components[1].components.map((c) => c.data.custom_id);
    assert.deepStrictEqual(row2Buttons, ['cver:toggle_status', 'cver:view_config', 'cver:refresh']);
  });

  // --------------------------------------------------------------------------
  // 9. Dashboard Idempotency: Edits in place without duplicate messages
  // --------------------------------------------------------------------------
  await suite.test('9. Dashboard Idempotency: Re-running .verify updates existing dashboard message in place', async () => {
    const { mockGuild, channels } = createMockGuild();
    const admin = createMockAdminMember(mockGuild);

    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});
    const setupChannel = Array.from(channels.values()).find((c) => c.name === 'verify-setup');
    const initialMessages = await setupChannel.messages.fetch();
    assert.strictEqual(initialMessages.size, 1);
    const firstMsgId = initialMessages.keys().next().value;

    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});
    const afterMessages = await setupChannel.messages.fetch();
    assert.strictEqual(afterMessages.size, 1, 'Still exactly one dashboard message');
    assert.strictEqual(afterMessages.keys().next().value, firstMsgId, 'Message ID preserved and edited in place');
  });

  // --------------------------------------------------------------------------
  // 10. Dashboard Modal: Edit Server Invite Link
  // --------------------------------------------------------------------------
  await suite.test('10. Dashboard Modal: Edit Server Invite saves URL and updates dashboard in-place', async () => {
    const { mockGuild } = createMockGuild();
    const admin = createMockAdminMember(mockGuild);
    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});

    // 1. Button click opens modal
    let shownModal = null;
    await handleCentralVerificationInteraction({
      guild: mockGuild,
      member: admin,
      customId: 'cver:edit:invite',
      showModal: async (m) => { shownModal = m; },
    });
    assert.ok(shownModal);
    assert.strictEqual(shownModal.data.custom_id, 'cver:modal:invite');

    // 2. Submit modal with official invite link
    let replyMsg = null;
    await handleCentralVerificationInteraction({
      guild: mockGuild,
      member: admin,
      user: admin.user,
      customId: 'cver:modal:invite',
      fields: { getTextInputValue: () => 'https://discord.gg/matchdistrict' },
      reply: async (payload) => { replyMsg = payload; },
    });

    assert.ok(replyMsg.content.includes('https://discord.gg/matchdistrict'));
    const config = getCentralVerificationConfig(mockGuild.id);
    assert.strictEqual(config.serverInviteUrl, 'https://discord.gg/matchdistrict');
  });

  // --------------------------------------------------------------------------
  // 11. Dashboard Toggle Status: Enable / Disable
  // --------------------------------------------------------------------------
  await suite.test('11. Dashboard Toggle Status: Toggles state between Enabled and Disabled', async () => {
    const { mockGuild } = createMockGuild();
    const admin = createMockAdminMember(mockGuild);
    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});

    let toggleReply = null;
    const interaction = {
      guild: mockGuild,
      member: admin,
      user: admin.user,
      customId: 'cver:toggle_status',
      reply: async (payload) => { toggleReply = payload; },
    };

    // Disable
    await handleCentralVerificationInteraction(interaction);
    assert.ok(toggleReply.content.includes('Disabled'));
    assert.strictEqual(getCentralVerificationConfig(mockGuild.id).enabled, false);

    // Re-enable
    await handleCentralVerificationInteraction(interaction);
    assert.ok(toggleReply.content.includes('Enabled'));
    assert.strictEqual(getCentralVerificationConfig(mockGuild.id).enabled, true);
  });

  // --------------------------------------------------------------------------
  // 12. View Config & Refresh: Permissions and Ephemeral Display
  // --------------------------------------------------------------------------
  await suite.test('12. View Config & Refresh: Non-admins blocked; View Config provides detailed embed', async () => {
    const { mockGuild } = createMockGuild();
    const admin = createMockAdminMember(mockGuild);
    const nonAdmin = createMockNonAdminMember(mockGuild);
    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});

    let deniedReply = null;
    await handleCentralVerificationInteraction({
      guild: mockGuild,
      member: nonAdmin,
      customId: 'cver:view_config',
      reply: async (payload) => { deniedReply = payload; },
    });
    assert.ok(deniedReply.content.includes('Only server administrators'));

    let viewReply = null;
    await handleCentralVerificationInteraction({
      guild: mockGuild,
      member: admin,
      customId: 'cver:view_config',
      reply: async (payload) => { viewReply = payload; },
    });
    assert.ok(viewReply.embeds[0].data.title.includes('Configuration Details'));
  });

  // --------------------------------------------------------------------------
  // 13. Submission Privacy: Immediate Auto-Delete of Code Message
  // --------------------------------------------------------------------------
  await suite.test('13. Submission Privacy: Code message in #verify-here is deleted immediately', async () => {
    const { mockGuild, channels } = createMockGuild();
    const admin = createMockAdminMember(mockGuild);
    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});

    const verifyChannel = Array.from(channels.values()).find((c) => c.name === 'verify-here');
    let messageDeleted = false;
    const mockMessage = {
      guild: mockGuild,
      channel: verifyChannel,
      content: 'ABCD1234',
      author: { id: 'player-1', bot: false },
      delete: async () => { messageDeleted = true; },
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        success: true,
        tournament_id: 't-solo-01',
        tournament_title: 'Solo Championship',
        tournament_format: 'solo',
        registration_id: 'reg-01',
        team_name: 'Solo Warrior',
      }),
    });

    try {
      await handleCentralVerificationMessage(mockMessage);
      assert.strictEqual(messageDeleted, true, 'User verification message must be deleted immediately');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // --------------------------------------------------------------------------
  // 14. Guild Disabled: Rejection Notice
  // --------------------------------------------------------------------------
  await suite.test('14. Guild Disabled: Submissions rejected when verification disabled', async () => {
    const { mockGuild, channels } = createMockGuild();
    const admin = createMockAdminMember(mockGuild);
    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});

    const cfg = getCentralVerificationConfig(mockGuild.id);
    cfg.enabled = false;
    await saveCentralVerificationConfig(mockGuild.id, cfg);

    const verifyChannel = Array.from(channels.values()).find((c) => c.name === 'verify-here');
    let sentNotice = null;
    verifyChannel.send = async (p) => { sentNotice = p; return { delete: async () => {} }; };

    const mockMessage = {
      guild: mockGuild,
      channel: verifyChannel,
      content: 'ABCD1234',
      author: { id: 'player-1', bot: false },
      delete: async () => {},
    };

    const handled = await handleCentralVerificationMessage(mockMessage);
    assert.strictEqual(handled, true);
    assert.ok(sentNotice.content.includes('currently disabled by administrators'));
  });

  // --------------------------------------------------------------------------
  // 15. Solo Tournament: Direct Verification Without Teammate Selection
  // --------------------------------------------------------------------------
  await suite.test('15. Solo Flow: Captain submits valid solo code and gets verified without teammate selection', async () => {
    const { mockGuild, channels } = createMockGuild();
    const admin = createMockAdminMember(mockGuild);
    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});

    const verifyChannel = Array.from(channels.values()).find((c) => c.name === 'verify-here');
    createMockAdminMember(mockGuild, 'solo-cap');

    let completedPayload = null;
    let announcement = null;
    verifyChannel.send = async (p) => { announcement = p; };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (url.includes('check-code')) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            tournament_id: 't-solo-cup',
            tournament_title: 'Solo Champions',
            tournament_format: 'solo',
            registration_id: 'reg-solo-88',
            team_name: 'Solo King',
          }),
        };
      }
      if (url.includes('complete')) {
        completedPayload = JSON.parse(opts.body);
        return {
          ok: true,
          json: async () => ({
            success: true,
            team_name: 'Solo King',
          }),
        };
      }
      return { ok: false };
    };

    try {
      const mockMessage = {
        guild: mockGuild,
        channel: verifyChannel,
        content: 'SOLO1234',
        author: { id: 'solo-cap', bot: false },
        delete: async () => {},
      };

      const handled = await handleCentralVerificationMessage(mockMessage);
      assert.strictEqual(handled, true);
      assert.ok(completedPayload, 'Backend complete must be called directly');
      assert.strictEqual(completedPayload.captain_discord_id, 'solo-cap');
      assert.deepStrictEqual(completedPayload.teammate_discord_ids, []);
      assert.ok(announcement.content.includes('Verification Complete!'));
      assert.ok(announcement.content.includes('Solo King'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // --------------------------------------------------------------------------
  // 16. Duo Flow: Teammate Not in Server & UserSelectMenu Prompt
  // --------------------------------------------------------------------------
  await suite.test('16. Duo Flow: Captain submits duo code without mentions; prompt displays 1 teammate required', async () => {
    const { mockGuild, channels } = createMockGuild();
    const admin = createMockAdminMember(mockGuild);
    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});

    const verifyChannel = Array.from(channels.values()).find((c) => c.name === 'verify-here');
    createMockAdminMember(mockGuild, 'duo-cap');

    let promptMsg = null;
    verifyChannel.send = async (p) => { promptMsg = p; return { id: 'prompt-1', ...p, delete: async () => {} }; };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        success: true,
        tournament_id: 't-duo-cup',
        tournament_title: 'Duo Masters',
        tournament_format: 'duo',
        registration_id: 'reg-duo-101',
        team_name: 'Double Trouble',
      }),
    });

    try {
      // Submitting code WITHOUT mentions works smoothly!
      await handleCentralVerificationMessage({
        guild: mockGuild,
        channel: verifyChannel,
        content: 'DUO12345',
        author: { id: 'duo-cap', bot: false },
        delete: async () => {},
      });

      assert.ok(promptMsg, 'Prompt must be sent');
      assert.ok(promptMsg.embeds[0].data.title.includes('Double Trouble'));

      // Check UserSelectMenu with 1 teammate
      const selectRow = promptMsg.components[0];
      const selectMenu = selectRow.components[0];
      assert.ok(selectMenu.data.custom_id.startsWith('cver:select:'));
      assert.strictEqual(selectMenu.data.min_values, 1);
      assert.strictEqual(selectMenu.data.max_values, 1);

      // Check Buttons: Invite Teammates, Continue Verification, Cancel
      const buttonRow = promptMsg.components[1];
      const btnIds = buttonRow.components.map((b) => b.data.custom_id);
      assert.ok(btnIds.some((id) => id.startsWith('cver:invite:')), 'Invite button must exist');
      assert.ok(btnIds.some((id) => id.startsWith('cver:continue:')), 'Continue button must exist');
      assert.ok(btnIds.some((id) => id.startsWith('cver:cancel:')), 'Cancel button must exist');

      // Check pending session persisted in MongoDB
      const pending = await getActivePendingTournamentVerificationForUser({ starterDiscordId: 'duo-cap' });
      assert.ok(pending);
      assert.strictEqual(pending.registrationId, 'reg-duo-101');
      assert.strictEqual(pending.tournamentFormat, 'duo');
      assert.strictEqual(pending.teammatesNeeded, 1);
      assert.strictEqual(pending.status, 'awaiting_teammates');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // --------------------------------------------------------------------------
  // 17. Invite Teammates: Copyable Code Block With Real Server Invite
  // --------------------------------------------------------------------------
  await suite.test('17. Invite Teammates: Displays copyable code block containing official invite link', async () => {
    const { mockGuild, channels } = createMockGuild({ vanityURLCode: 'matchdistrict-official' });
    const admin = createMockAdminMember(mockGuild);
    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});

    // Save official server invite URL
    const cfg = getCentralVerificationConfig(mockGuild.id);
    cfg.serverInviteUrl = 'https://discord.gg/matchdistrictofficial';
    await saveCentralVerificationConfig(mockGuild.id, cfg);

    const pendingId = 'pending-duo-invite';
    await createPendingTournamentVerification({
      pendingId,
      registrationId: 'reg-inv-1',
      starterDiscordId: 'capt-invite',
      tournamentId: 't-duo-inv',
      guildId: mockGuild.id,
      tournamentFormat: 'duo',
      teammatesNeeded: 1,
      status: 'awaiting_teammates',
      expiresAt: new Date(Date.now() + 600000),
    });

    let inviteReply = null;
    await handleCentralVerificationInteraction({
      guild: mockGuild,
      user: { id: 'capt-invite' },
      customId: `cver:invite:${pendingId}`,
      reply: async (p) => { inviteReply = p; },
    });

    assert.ok(inviteReply);
    assert.ok(inviteReply.content.includes('```'), 'Must be enclosed in a code block');
    assert.ok(inviteReply.content.includes('https://discord.gg/matchdistrictofficial'), 'Must contain the real official invite');
    assert.ok(inviteReply.content.includes('tell me your Discord username'));
  });

  // --------------------------------------------------------------------------
  // 18. Missing Server Invite Handled Safely Without Fake URL
  // --------------------------------------------------------------------------
  await suite.test('18. Missing Server Invite: Displays administrative configuration error with no fake URL', async () => {
    const { mockGuild } = createMockGuild(); // No vanity, no configured URL
    const admin = createMockAdminMember(mockGuild);
    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});

    const pendingId = 'pending-no-invite';
    await createPendingTournamentVerification({
      pendingId,
      registrationId: 'reg-no-inv',
      starterDiscordId: 'capt-no-inv',
      tournamentId: 't-duo-no-inv',
      guildId: mockGuild.id,
      tournamentFormat: 'duo',
      teammatesNeeded: 1,
      status: 'awaiting_teammates',
      expiresAt: new Date(Date.now() + 600000),
    });

    let errorReply = null;
    await handleCentralVerificationInteraction({
      guild: mockGuild,
      user: { id: 'capt-no-inv' },
      customId: `cver:invite:${pendingId}`,
      reply: async (p) => { errorReply = p; },
    });

    assert.ok(errorReply);
    assert.ok(errorReply.content.includes('invite link is currently unavailable'));
    assert.ok(errorReply.content.includes('ask a server administrator to configure'));
    assert.strictEqual(errorReply.content.includes('http'), false, 'Never invent a fake URL');
  });

  // --------------------------------------------------------------------------
  // 19. Teammate Joins Server -> Captain Selects Teammate -> Completion
  // --------------------------------------------------------------------------
  await suite.test('19. Duo Completion: Teammate joins, captain selects from menu, roles assigned & verified', async () => {
    const { mockGuild, channels } = createMockGuild();
    const admin = createMockAdminMember(mockGuild);
    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});

    const verifyChannel = Array.from(channels.values()).find((c) => c.name === 'verify-here');
    createMockAdminMember(mockGuild, 'capt-flow');

    // 1. Submit Duo code
    let promptMsg = null;
    verifyChannel.send = async (p) => { promptMsg = { ...p, delete: async () => {} }; return promptMsg; };

    let completedPayload = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (url.includes('check-code')) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            tournament_id: 't-duo-flow',
            tournament_title: 'Duo Masters',
            tournament_format: 'duo',
            registration_id: 'reg-flow-99',
            team_name: 'Flow Warriors',
          }),
        };
      }
      if (url.includes('complete')) {
        completedPayload = JSON.parse(opts.body);
        return {
          ok: true,
          json: async () => ({
            success: true,
            team_name: 'Flow Warriors',
          }),
        };
      }
      return { ok: false };
    };

    try {
      await handleCentralVerificationMessage({
        guild: mockGuild,
        channel: verifyChannel,
        content: 'CODEFL01',
        author: { id: 'capt-flow', bot: false },
        delete: async () => {},
      });

      const pending = await getActivePendingTournamentVerificationForUser({ starterDiscordId: 'capt-flow' });
      assert.ok(pending);

      // 2. Teammate joins server
      createMockAdminMember(mockGuild, 'teammate-new');

      // 3. Captain selects teammate-new from UserSelectMenu
      let announcement = null;
      verifyChannel.send = async (p) => { announcement = p; };

      const selectInteraction = {
        guild: mockGuild,
        channel: verifyChannel,
        user: { id: 'capt-flow' },
        customId: `cver:select:${pending.pendingId}`,
        values: ['teammate-new'],
        isUserSelectMenu: () => true,
        deferUpdate: async () => {},
        reply: async () => {},
        update: async () => {},
      };

      await handleCentralVerificationInteraction(selectInteraction);

      assert.ok(completedPayload, 'Backend complete must be called');
      assert.strictEqual(completedPayload.captain_discord_id, 'capt-flow');
      assert.deepStrictEqual(completedPayload.teammate_discord_ids, ['teammate-new']);

      // Pending session marked completed
      const updatedPending = await getPendingTournamentVerification(pending.pendingId);
      assert.strictEqual(updatedPending.status, 'completed');

      assert.ok(announcement.content.includes('Verification Complete!'));
      assert.ok(announcement.content.includes('Flow Warriors'));
      assert.ok(announcement.content.includes('<@capt-flow>'));
      assert.ok(announcement.content.includes('<@teammate-new>'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // --------------------------------------------------------------------------
  // 20. Squad Flow: 3 Teammates Needed
  // --------------------------------------------------------------------------
  await suite.test('20. Squad Flow: Requires 3 teammates and verifies complete roster', async () => {
    const { mockGuild, channels } = createMockGuild();
    const admin = createMockAdminMember(mockGuild);
    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});

    const verifyChannel = Array.from(channels.values()).find((c) => c.name === 'verify-here');
    createMockAdminMember(mockGuild, 'sq-cap');
    createMockAdminMember(mockGuild, 'sq-m1');
    createMockAdminMember(mockGuild, 'sq-m2');
    createMockAdminMember(mockGuild, 'sq-m3');

    let completedPayload = null;
    let announcement = null;
    verifyChannel.send = async (p) => { announcement = p; return { ...p, delete: async () => {} }; };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (url.includes('check-code')) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            tournament_id: 't-squad-4x',
            tournament_title: 'Squad Mayhem',
            tournament_format: 'squad',
            registration_id: 'reg-sq-44',
            team_name: 'Squad Four',
          }),
        };
      }
      if (url.includes('complete')) {
        completedPayload = JSON.parse(opts.body);
        return {
          ok: true,
          json: async () => ({
            success: true,
            team_name: 'Squad Four',
          }),
        };
      }
      return { ok: false };
    };

    try {
      await handleCentralVerificationMessage({
        guild: mockGuild,
        channel: verifyChannel,
        content: 'SQUAD123',
        author: { id: 'sq-cap', bot: false },
        delete: async () => {},
      });

      const pending = await getActivePendingTournamentVerificationForUser({ starterDiscordId: 'sq-cap' });
      assert.strictEqual(pending.teammatesNeeded, 3);

      await handleCentralVerificationInteraction({
        guild: mockGuild,
        channel: verifyChannel,
        user: { id: 'sq-cap' },
        customId: `cver:select:${pending.pendingId}`,
        values: ['sq-m1', 'sq-m2', 'sq-m3'],
        isUserSelectMenu: () => true,
        deferUpdate: async () => {},
        reply: async () => {},
        update: async () => {},
      });

      assert.ok(completedPayload);
      assert.deepStrictEqual(completedPayload.teammate_discord_ids, ['sq-m1', 'sq-m2', 'sq-m3']);
      assert.ok(announcement.content.includes('Squad Four'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // --------------------------------------------------------------------------
  // 21. Validation: Rejects Self-Selection, Bots, and Non-Server Members
  // --------------------------------------------------------------------------
  await suite.test('21. Teammate Validation: Rejects self-selection, bots, and non-server members', async () => {
    const { mockGuild, channels } = createMockGuild();
    const admin = createMockAdminMember(mockGuild);
    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});

    createMockAdminMember(mockGuild, 'cap-valid');
    const botUser = { id: 'bot-tm', user: { id: 'bot-tm', bot: true }, guild: mockGuild };
    mockGuild.members.cache.set('bot-tm', botUser);

    const pendingId = 'pending-val-test';
    await createPendingTournamentVerification({
      pendingId,
      registrationId: 'reg-val-1',
      starterDiscordId: 'cap-valid',
      tournamentId: 't-val-1',
      guildId: mockGuild.id,
      tournamentFormat: 'duo',
      teammatesNeeded: 1,
      status: 'awaiting_teammates',
      expiresAt: new Date(Date.now() + 600000),
    });

    // 1. Captain selects himself
    let selfReply = null;
    await handleCentralVerificationInteraction({
      guild: mockGuild,
      user: { id: 'cap-valid' },
      customId: `cver:select:${pendingId}`,
      values: ['cap-valid'],
      isUserSelectMenu: () => true,
      reply: async (p) => { selfReply = p; },
    });
    assert.ok(selfReply.content.includes('cannot select yourself as a teammate'));

    // 2. Captain selects user not in server
    let notInServerReply = null;
    await handleCentralVerificationInteraction({
      guild: mockGuild,
      user: { id: 'cap-valid' },
      customId: `cver:select:${pendingId}`,
      values: ['stranger-user-99'],
      isUserSelectMenu: () => true,
      reply: async (p) => { notInServerReply = p; },
    });
    assert.ok(notInServerReply.content.includes('has not joined this Discord server yet'));

    // 3. Captain selects a bot
    let botReply = null;
    await handleCentralVerificationInteraction({
      guild: mockGuild,
      user: { id: 'cap-valid' },
      customId: `cver:select:${pendingId}`,
      values: ['bot-tm'],
      isUserSelectMenu: () => true,
      reply: async (p) => { botReply = p; },
    });
    assert.ok(botReply.content.includes('is a Discord bot'));
  });

  // --------------------------------------------------------------------------
  // 22. Authorization Isolation: Other Users Cannot Control Someone Else's Session
  // --------------------------------------------------------------------------
  await suite.test('22. Authorization Isolation: Non-captain users cannot click prompt controls', async () => {
    const { mockGuild } = createMockGuild();
    const admin = createMockAdminMember(mockGuild);
    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});

    createMockAdminMember(mockGuild, 'real-cap');
    createMockAdminMember(mockGuild, 'intruder-user');

    const pendingId = 'pending-iso-test';
    await createPendingTournamentVerification({
      pendingId,
      registrationId: 'reg-iso',
      starterDiscordId: 'real-cap',
      tournamentId: 't-iso',
      guildId: mockGuild.id,
      tournamentFormat: 'duo',
      teammatesNeeded: 1,
      status: 'awaiting_teammates',
      expiresAt: new Date(Date.now() + 600000),
    });

    let deniedReply = null;
    await handleCentralVerificationInteraction({
      guild: mockGuild,
      user: { id: 'intruder-user' },
      customId: `cver:invite:${pendingId}`,
      reply: async (p) => { deniedReply = p; },
    });

    assert.ok(deniedReply);
    assert.ok(deniedReply.content.includes('Only the team captain'));
  });

  // --------------------------------------------------------------------------
  // 23. Duplicate Submissions Prevention
  // --------------------------------------------------------------------------
  await suite.test('23. Duplicate Submissions: Rapid submissions do not create duplicate sessions', async () => {
    const { mockGuild, channels } = createMockGuild();
    const admin = createMockAdminMember(mockGuild);
    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});

    const verifyChannel = Array.from(channels.values()).find((c) => c.name === 'verify-here');
    createMockAdminMember(mockGuild, 'cap-dup');

    let promptCount = 0;
    let duplicateNotice = null;
    verifyChannel.send = async (p) => {
      if (p.embeds) promptCount++;
      else duplicateNotice = p;
      return { ...p, delete: async () => {} };
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        success: true,
        tournament_id: 't-dup-test',
        tournament_title: 'Dup Tournament',
        tournament_format: 'duo',
        registration_id: 'reg-dup-1',
        team_name: 'Team Dup',
      }),
    });

    try {
      // First submission
      await handleCentralVerificationMessage({
        guild: mockGuild,
        channel: verifyChannel,
        content: 'DUPCODE1',
        author: { id: 'cap-dup', bot: false },
        delete: async () => {},
      });

      assert.strictEqual(promptCount, 1);

      // Immediate second submission for same captain
      await handleCentralVerificationMessage({
        guild: mockGuild,
        channel: verifyChannel,
        content: 'DUPCODE1',
        author: { id: 'cap-dup', bot: false },
        delete: async () => {},
      });

      assert.strictEqual(promptCount, 1, 'Zero duplicate prompt messages');
      assert.ok(duplicateNotice.content.includes('already in progress'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // --------------------------------------------------------------------------
  // 24. Bot Restart & Offline Recovery
  // --------------------------------------------------------------------------
  await suite.test('24. Bot Restart & Offline Recovery: Configs persist and offline codes are purged', async () => {
    const { mockGuild, channels } = createMockGuild();
    const admin = createMockAdminMember(mockGuild);
    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});

    centralVerificationConfigsCache.clear();
    assert.strictEqual(centralVerificationConfigsCache.size, 0);

    await initCentralVerificationConfigsCache();
    assert.strictEqual(centralVerificationConfigsCache.size, 1);
    const restored = getCentralVerificationConfig(mockGuild.id);
    assert.ok(restored);
    assert.strictEqual(restored.guildId, mockGuild.id);
    assert.strictEqual(restored.enabled, true);

    const verifyChannel = Array.from(channels.values()).find((c) => c.name === 'verify-here');
    const messages = new Map();
    let codeMsgDeleted = false;
    let instrMsgDeleted = false;

    messages.set('msg-code', {
      id: 'msg-code',
      content: 'XY7890ZZ',
      author: { bot: false },
      delete: async () => { codeMsgDeleted = true; },
    });

    messages.set('msg-instructions', {
      id: 'msg-instructions',
      content: 'Welcome to tournament verification! Type your code here.',
      author: { bot: true },
      components: [],
      delete: async () => { instrMsgDeleted = true; },
    });

    verifyChannel.messages.fetch = async () => messages;

    await cleanupCentralVerificationOfflineMessages(mockGuild);
    assert.strictEqual(codeMsgDeleted, true, 'Leftover verification code message must be purged');
    assert.strictEqual(instrMsgDeleted, false, 'Announcement/instruction message must be preserved');
  });
});
