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
} from '../centralVerificationService.js';
import {
  saveCentralVerificationConfig,
  getCentralVerificationConfig as getDbConfig,
  localCentralVerificationConfigs,
  localPendingVerifications,
  createPendingTournamentVerification,
  getActivePendingTournamentVerificationForUser,
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

    // Verify 3 channels created: Category, #verify-setup, #verify-here
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

    // Run first time
    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});
    const initialCount = channels.size;
    assert.strictEqual(initialCount, 3);

    const firstConfig = { ...getCentralVerificationConfig(mockGuild.id) };

    // Run second time (.verify repeated)
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

    // Pre-create category and #verify-setup only
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
  await suite.test('8. Dashboard Initialization: Displays status Enabled and default mention requirements', async () => {
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
    assert.deepStrictEqual(row1Buttons, ['cver:edit:solo', 'cver:edit:duo', 'cver:edit:squad']);

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

    // Run again
    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});
    const afterMessages = await setupChannel.messages.fetch();
    assert.strictEqual(afterMessages.size, 1, 'Still exactly one dashboard message');
    assert.strictEqual(afterMessages.keys().next().value, firstMsgId, 'Message ID preserved and edited in place');
  });

  // --------------------------------------------------------------------------
  // 10. Dashboard Modal: Edit Solo Mentions
  // --------------------------------------------------------------------------
  await suite.test('10. Dashboard Modal: Edit Solo Mentions opens modal and updates config', async () => {
    const { mockGuild } = createMockGuild();
    const admin = createMockAdminMember(mockGuild);
    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});

    // 1. Button click shows modal
    let shownModal = null;
    const btnInteraction = {
      guild: mockGuild,
      member: admin,
      customId: 'cver:edit:solo',
      showModal: async (m) => { shownModal = m; },
    };
    await handleCentralVerificationInteraction(btnInteraction);
    assert.ok(shownModal);
    assert.strictEqual(shownModal.data.custom_id, 'cver:modal:solo');

    // 2. Submit modal with value 1
    let replyMsg = null;
    const submitInteraction = {
      guild: mockGuild,
      member: admin,
      user: admin.user,
      customId: 'cver:modal:solo',
      fields: { getTextInputValue: () => '1' },
      reply: async (payload) => { replyMsg = payload; },
    };
    await handleCentralVerificationInteraction(submitInteraction);

    assert.ok(replyMsg.content.includes('Updated **SOLO** mention requirement to **1**'));
    const config = getCentralVerificationConfig(mockGuild.id);
    assert.strictEqual(config.soloMentionRequirement, 1);
  });

  // --------------------------------------------------------------------------
  // 11. Dashboard Modal: Edit Duo Mentions
  // --------------------------------------------------------------------------
  await suite.test('11. Dashboard Modal: Edit Duo Mentions updates config and dashboard in-place', async () => {
    const { mockGuild } = createMockGuild();
    const admin = createMockAdminMember(mockGuild);
    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});

    const submitInteraction = {
      guild: mockGuild,
      member: admin,
      user: admin.user,
      customId: 'cver:modal:duo',
      fields: { getTextInputValue: () => '3' },
      reply: async () => {},
    };
    await handleCentralVerificationInteraction(submitInteraction);

    const config = getCentralVerificationConfig(mockGuild.id);
    assert.strictEqual(config.duoMentionRequirement, 3);
  });

  // --------------------------------------------------------------------------
  // 12. Dashboard Modal: Edit Squad Mentions
  // --------------------------------------------------------------------------
  await suite.test('12. Dashboard Modal: Edit Squad Mentions updates config and dashboard in-place', async () => {
    const { mockGuild } = createMockGuild();
    const admin = createMockAdminMember(mockGuild);
    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});

    const submitInteraction = {
      guild: mockGuild,
      member: admin,
      user: admin.user,
      customId: 'cver:modal:squad',
      fields: { getTextInputValue: () => '5' },
      reply: async () => {},
    };
    await handleCentralVerificationInteraction(submitInteraction);

    const config = getCentralVerificationConfig(mockGuild.id);
    assert.strictEqual(config.squadMentionRequirement, 5);
  });

  // --------------------------------------------------------------------------
  // 13. Dashboard Modal Validation: Rejects invalid ranges
  // --------------------------------------------------------------------------
  await suite.test('13. Dashboard Modal Validation: Rejects out-of-range (<0 or >25) or non-numeric input', async () => {
    const { mockGuild } = createMockGuild();
    const admin = createMockAdminMember(mockGuild);
    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});

    const testInvalidInputs = ['-1', '26', 'abc', '3.5'];
    for (const invalidInput of testInvalidInputs) {
      let errorReply = null;
      const submitInteraction = {
        guild: mockGuild,
        member: admin,
        user: admin.user,
        customId: 'cver:modal:solo',
        fields: { getTextInputValue: () => invalidInput },
        reply: async (payload) => { errorReply = payload; },
      };
      await handleCentralVerificationInteraction(submitInteraction);
      assert.ok(errorReply.content.includes('integer between 0 and 25'), `Expected error for ${invalidInput}`);
    }

    const config = getCentralVerificationConfig(mockGuild.id);
    assert.strictEqual(config.soloMentionRequirement, 0, 'Config must not be modified by invalid input');
  });

  // --------------------------------------------------------------------------
  // 14. Dashboard Toggle Status: Enable / Disable
  // --------------------------------------------------------------------------
  await suite.test('14. Dashboard Toggle Status: Toggles state between Enabled and Disabled', async () => {
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

    // Toggle 1: Disable
    await handleCentralVerificationInteraction(interaction);
    assert.ok(toggleReply.content.includes('Disabled'));
    assert.strictEqual(getCentralVerificationConfig(mockGuild.id).enabled, false);

    // Toggle 2: Re-enable
    await handleCentralVerificationInteraction(interaction);
    assert.ok(toggleReply.content.includes('Enabled'));
    assert.strictEqual(getCentralVerificationConfig(mockGuild.id).enabled, true);
  });

  // --------------------------------------------------------------------------
  // 15. View Config & Refresh: Permissions and Ephemeral Display
  // --------------------------------------------------------------------------
  await suite.test('15. View Config & Refresh: Non-admins blocked; View Config provides detailed embed', async () => {
    const { mockGuild } = createMockGuild();
    const admin = createMockAdminMember(mockGuild);
    const nonAdmin = createMockNonAdminMember(mockGuild);
    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});

    // Non-admin blocked
    let deniedReply = null;
    await handleCentralVerificationInteraction({
      guild: mockGuild,
      member: nonAdmin,
      customId: 'cver:view_config',
      reply: async (payload) => { deniedReply = payload; },
    });
    assert.ok(deniedReply.content.includes('Only server administrators'));

    // Admin view_config
    let viewReply = null;
    await handleCentralVerificationInteraction({
      guild: mockGuild,
      member: admin,
      customId: 'cver:view_config',
      reply: async (payload) => { viewReply = payload; },
    });
    assert.ok(viewReply.embeds[0].data.title.includes('Configuration Details'));

    // Admin refresh
    let refreshReply = null;
    await handleCentralVerificationInteraction({
      guild: mockGuild,
      member: admin,
      customId: 'cver:refresh',
      reply: async (payload) => { refreshReply = payload; },
    });
    assert.ok(refreshReply.content.includes('Dashboard refreshed'));
  });

  // --------------------------------------------------------------------------
  // 16. Submission Privacy: Immediate Auto-Delete of Code Message
  // --------------------------------------------------------------------------
  await suite.test('16. Submission Privacy: Code message in #verify-here is deleted immediately', async () => {
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

    // Mock fetch for check-code API
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
  // 17. Guild Disabled: Rejection Notice
  // --------------------------------------------------------------------------
  await suite.test('17. Guild Disabled: Submissions rejected when verification disabled', async () => {
    const { mockGuild, channels } = createMockGuild();
    const admin = createMockAdminMember(mockGuild);
    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});

    // Disable verification
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
  // 18. Mention Count Validation: Solo (Default 0 mentions)
  // --------------------------------------------------------------------------
  await suite.test('18. Mention Count Validation - Solo: Enforces 0 mentions and rejects extra mentions', async () => {
    const { mockGuild, channels } = createMockGuild();
    const admin = createMockAdminMember(mockGuild);
    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});

    const verifyChannel = Array.from(channels.values()).find((c) => c.name === 'verify-here');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        success: true,
        tournament_id: 't-solo-01',
        tournament_title: 'Solo Championship',
        tournament_format: 'solo',
        registration_id: 'reg-solo',
        team_name: 'Lone Wolf',
      }),
    });

    try {
      // User mistakenly mentions a user for Solo format
      let rejectNotice = null;
      verifyChannel.send = async (p) => { rejectNotice = p; return { delete: async () => {} }; };

      const mockMessage = {
        guild: mockGuild,
        channel: verifyChannel,
        content: 'ABCD1234 <@player-2>',
        author: { id: 'player-1', bot: false },
        delete: async () => {},
      };

      await handleCentralVerificationMessage(mockMessage);
      assert.ok(rejectNotice.content.includes('SOLO'));
      assert.ok(rejectNotice.content.includes('No mentions are required'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // --------------------------------------------------------------------------
  // 19. Mention Count Validation: Duo (Default 2 mentions)
  // --------------------------------------------------------------------------
  await suite.test('19. Mention Count Validation - Duo: Enforces exactly 2 mentions', async () => {
    const { mockGuild, channels } = createMockGuild();
    const admin = createMockAdminMember(mockGuild);
    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});

    const verifyChannel = Array.from(channels.values()).find((c) => c.name === 'verify-here');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        success: true,
        tournament_id: 't-duo-01',
        tournament_title: 'Duo Masters',
        tournament_format: 'duo',
        registration_id: 'reg-duo',
        team_name: 'Dynamic Duo',
      }),
    });

    try {
      // User sends only 1 mention for Duo format
      let rejectNotice = null;
      verifyChannel.send = async (p) => { rejectNotice = p; return { delete: async () => {} }; };

      const mockMessage = {
        guild: mockGuild,
        channel: verifyChannel,
        content: 'ABCD1234 <@player-1>',
        author: { id: 'player-1', bot: false },
        delete: async () => {},
      };

      await handleCentralVerificationMessage(mockMessage);
      assert.ok(rejectNotice.content.includes('DUO'));
      assert.ok(rejectNotice.content.includes('requires exactly **2** mention(s)'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // --------------------------------------------------------------------------
  // 20. Mention Count Validation: Squad (Default 4 mentions)
  // --------------------------------------------------------------------------
  await suite.test('20. Mention Count Validation - Squad: Enforces exactly 4 mentions', async () => {
    const { mockGuild, channels } = createMockGuild();
    const admin = createMockAdminMember(mockGuild);
    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});

    const verifyChannel = Array.from(channels.values()).find((c) => c.name === 'verify-here');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        success: true,
        tournament_id: 't-squad-01',
        tournament_title: 'Squad Clash',
        tournament_format: 'squad',
        registration_id: 'reg-squad',
        team_name: 'Apex Squad',
      }),
    });

    try {
      // User provides only 3 mentions for Squad format
      let rejectNotice = null;
      verifyChannel.send = async (p) => { rejectNotice = p; return { delete: async () => {} }; };

      const mockMessage = {
        guild: mockGuild,
        channel: verifyChannel,
        content: 'ABCD1234 <@player-1> <@player-2> <@player-3>',
        author: { id: 'player-1', bot: false },
        delete: async () => {},
      };

      await handleCentralVerificationMessage(mockMessage);
      assert.ok(rejectNotice.content.includes('SQUAD'));
      assert.ok(rejectNotice.content.includes('requires exactly **4** mention(s)'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // --------------------------------------------------------------------------
  // 21. Self-Mention Requirement
  // --------------------------------------------------------------------------
  await suite.test('21. Self-Mention Requirement: Submitting captain must mention their own account', async () => {
    const { mockGuild, channels } = createMockGuild();
    const admin = createMockAdminMember(mockGuild);
    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});

    const verifyChannel = Array.from(channels.values()).find((c) => c.name === 'verify-here');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        success: true,
        tournament_id: 't-duo-01',
        tournament_format: 'duo',
        registration_id: 'reg-duo',
        team_name: 'Duo Team',
      }),
    });

    try {
      // Captain player-1 mentions player-2 and player-3, omitting himself
      let rejectNotice = null;
      verifyChannel.send = async (p) => { rejectNotice = p; return { delete: async () => {} }; };

      const mockMessage = {
        guild: mockGuild,
        channel: verifyChannel,
        content: 'ABCD1234 <@player-2> <@player-3>',
        author: { id: 'player-1', bot: false },
        delete: async () => {},
      };

      await handleCentralVerificationMessage(mockMessage);
      assert.ok(rejectNotice.content.includes('You must mention yourself (<@player-1>)'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // --------------------------------------------------------------------------
  // 22. Mention Quality & Exclusivity
  // --------------------------------------------------------------------------
  await suite.test('22. Mention Quality & Exclusivity: Rejects duplicates, bots, and already-verified players', async () => {
    const { mockGuild, channels } = createMockGuild();
    const admin = createMockAdminMember(mockGuild);
    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});

    const verifyChannel = Array.from(channels.values()).find((c) => c.name === 'verify-here');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        success: true,
        tournament_id: 't-squad-excl',
        tournament_format: 'squad',
        registration_id: 'reg-squad-excl',
        team_name: 'Team Beta',
      }),
    });

    try {
      // 1. Duplicate mention test
      let dupNotice = null;
      verifyChannel.send = async (p) => { dupNotice = p; return { delete: async () => {} }; };

      await handleCentralVerificationMessage({
        guild: mockGuild,
        channel: verifyChannel,
        content: 'ABCD1234 <@p-1> <@p-2> <@p-2> <@p-3>',
        author: { id: 'p-1', bot: false },
        delete: async () => {},
      });
      assert.ok(dupNotice.content.includes('Duplicate mentions detected'));

      // 2. Bot mention test
      createMockAdminMember(mockGuild, 'p-1');
      createMockAdminMember(mockGuild, 'p-2');
      createMockAdminMember(mockGuild, 'p-3');
      const botUser = { id: 'bad-bot', user: { id: 'bad-bot', bot: true }, guild: mockGuild };
      mockGuild.members.cache.set('bad-bot', botUser);

      let botNotice = null;
      verifyChannel.send = async (p) => { botNotice = p; return { delete: async () => {} }; };

      await handleCentralVerificationMessage({
        guild: mockGuild,
        channel: verifyChannel,
        content: 'ABCD1234 <@p-1> <@p-2> <@p-3> <@bad-bot>',
        author: { id: 'p-1', bot: false },
        delete: async () => {},
      });
      assert.ok(botNotice.content.includes('is a bot'));

      // 3. Exclusivity test: p-4 is already in a verified team
      createMockAdminMember(mockGuild, 'p-4');
      const { localTeams } = await import('../configurableTournamentData.js');
      localTeams.set('team-existing', {
        tournamentId: 't-squad-excl',
        teamId: 'team-existing',
        teamName: 'Team Alpha',
        status: 'CONFIRMED',
        leaderDiscordId: 'p-4',
        players: [{ discordId: 'p-4', id: 'p-4' }],
      });
      await syncTeamPlayerMemberships({
        tournamentId: 't-squad-excl',
        teamId: 'team-existing',
        teamName: 'Team Alpha',
        leaderDiscordId: 'p-4',
        players: [{ discordId: 'p-4', id: 'p-4' }],
        status: 'CONFIRMED',
      });

      let exclNotice = null;
      verifyChannel.send = async (p) => { exclNotice = p; return { delete: async () => {} }; };

      await handleCentralVerificationMessage({
        guild: mockGuild,
        channel: verifyChannel,
        content: 'ABCD1234 <@p-1> <@p-2> <@p-3> <@p-4>',
        author: { id: 'p-1', bot: false },
        delete: async () => {},
      });
      assert.ok(exclNotice.content.includes('already registered in a verified team "Team Alpha"'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // --------------------------------------------------------------------------
  // 23. Confirmation Prompt & Execution
  // --------------------------------------------------------------------------
  await suite.test('23. Confirmation Prompt & Execution: Confirm button finalizes verification and announces', async () => {
    const { mockGuild, channels } = createMockGuild();
    const admin = createMockAdminMember(mockGuild);
    await handleCentralVerificationSetupCommand(mockGuild, admin, { id: 'chan-any' }, () => {});

    const verifyChannel = Array.from(channels.values()).find((c) => c.name === 'verify-here');
    createMockAdminMember(mockGuild, 'capt-1');
    createMockAdminMember(mockGuild, 'mate-2');

    let promptMsg = null;
    verifyChannel.send = async (p) => {
      promptMsg = {
        ...p,
        delete: async () => {},
      };
      return promptMsg;
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.includes('check-code')) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            tournament_id: 't-duo-flow',
            tournament_title: 'Duo Cup',
            tournament_format: 'duo',
            registration_id: 'reg-duo-99',
            team_name: 'Duo Champions',
          }),
        };
      }
      if (url.includes('complete')) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            team_name: 'Duo Champions',
          }),
        };
      }
      return { ok: false };
    };

    try {
      // 1. Submit valid Duo code + 2 mentions (self + mate)
      await handleCentralVerificationMessage({
        guild: mockGuild,
        channel: verifyChannel,
        content: 'ABCD1234 <@capt-1> <@mate-2>',
        author: { id: 'capt-1', bot: false },
        delete: async () => {},
      });

      assert.ok(promptMsg, 'Confirmation prompt must be sent');
      assert.ok(promptMsg.embeds[0].data.title.includes('Confirm Tournament Verification'));

      const confirmButton = promptMsg.components[0].components.find((b) => b.data.custom_id.startsWith('cver:confirm:'));
      assert.ok(confirmButton, 'Confirm Verification button must exist');

      // 2. Click Confirm button
      let replyContent = null;
      let announcement = null;
      verifyChannel.send = async (p) => { announcement = p; };

      const clickInteraction = {
        guild: mockGuild,
        channel: verifyChannel,
        user: { id: 'capt-1' },
        customId: confirmButton.data.custom_id,
        reply: async () => {},
        update: async () => {},
        deferUpdate: async () => {},
        editReply: async (payload) => { replyContent = payload; },
      };

      await handleCentralVerificationInteraction(clickInteraction);
      assert.ok(replyContent.content.includes('Verification completed successfully'));
      assert.ok(announcement.content.includes('Verification Complete!'));
      assert.ok(announcement.content.includes('Duo Champions'));
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

    // 1. Simulate Bot Restart: clear memory cache and re-initialize from storage
    centralVerificationConfigsCache.clear();
    assert.strictEqual(centralVerificationConfigsCache.size, 0);

    await initCentralVerificationConfigsCache();
    assert.strictEqual(centralVerificationConfigsCache.size, 1);
    const restored = getCentralVerificationConfig(mockGuild.id);
    assert.ok(restored);
    assert.strictEqual(restored.guildId, mockGuild.id);
    assert.strictEqual(restored.enabled, true);

    // 2. Offline recovery sweep in #verify-here
    const verifyChannel = Array.from(channels.values()).find((c) => c.name === 'verify-here');
    const messages = new Map();
    let codeMsgDeleted = false;
    let instrMsgDeleted = false;

    // A leftover user message containing a code
    messages.set('msg-code', {
      id: 'msg-code',
      content: 'XY7890ZZ <@player-1>',
      author: { bot: false },
      delete: async () => { codeMsgDeleted = true; },
    });

    // An ordinary announcement / instructions message
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
