import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getGuildVerificationConfig,
  setGuildVerificationConfig,
  handleOrganiserVerificationSetupCommand,
  handleOrganiserVerificationInteraction,
  handleOrganiserActivationMessage,
} from '../organiserVerificationService.js';
import {
  saveOrganiserVerificationConfig,
  getOrganiserVerificationConfig,
  recordOrganiserVerification,
} from '../mongoService.js';
import { PermissionFlagsBits, ChannelType } from 'discord.js';

test('Discord Bot - Organiser Verification Service Tests', async (t) => {
  await t.test('1. saveOrganiserVerificationConfig and getOrganiserVerificationConfig persist in memory', async () => {
    const guildId = 'test-guild-123456';
    const config = {
      verificationChannelId: 'chan-verify-789',
      organiserRoleId: 'role-org-987',
      updatedBy: 'admin-user-111',
    };

    const saved = await saveOrganiserVerificationConfig(guildId, config);
    assert.strictEqual(saved, true);

    const fetched = await getOrganiserVerificationConfig(guildId);
    assert.ok(fetched);
    assert.strictEqual(fetched.guildId, guildId);
    assert.strictEqual(fetched.verificationChannelId, 'chan-verify-789');
    assert.strictEqual(fetched.organiserRoleId, 'role-org-987');
  });

  await t.test('2. recordOrganiserVerification records verification attempts in memory', async () => {
    const record = {
      guildId: 'test-guild-123456',
      discordUserId: 'user-disc-123',
      discordUsername: 'TournamentHost#1234',
      organiserId: 'ORG-REQ-999',
      organiserName: 'Apex Tournaments',
      status: 'verified',
    };

    const recorded = await recordOrganiserVerification(record);
    assert.strictEqual(recorded, true);
  });

  await t.test('3. Non-admin member cannot execute .setup org verification', async () => {
    let replyPayload = null;
    const mockGuild = { id: 'test-guild-123456', ownerId: 'owner-999' };
    const nonAdminMember = {
      id: 'member-user-1',
      permissions: {
        has: (flag) => false,
      },
      guild: mockGuild,
    };

    await handleOrganiserVerificationSetupCommand(
      mockGuild,
      nonAdminMember,
      { id: 'chan-1' },
      (payload) => { replyPayload = payload; }
    );

    assert.ok(replyPayload);
    assert.ok(replyPayload.embeds && replyPayload.embeds.length > 0);
    assert.strictEqual(replyPayload.embeds[0].data.title, '⛔ Permission Denied');
  });

  await t.test('4. Admin member receives interactive configuration panel with channel & role select menus', async () => {
    let replyPayload = null;
    const mockGuild = {
      id: 'test-guild-admin-1',
      ownerId: 'admin-user-1',
      channels: {
        cache: new Map([
          ['c1', { id: 'c1', name: 'organiser-verify', type: ChannelType.GuildText }],
        ]),
      },
      roles: {
        cache: new Map([
          ['r1', { id: 'r1', name: 'Organisers' }],
        ]),
      },
    };
    const adminMember = {
      id: 'admin-user-1',
      permissions: {
        has: (flag) => flag === PermissionFlagsBits.Administrator,
      },
      guild: mockGuild,
    };

    await handleOrganiserVerificationSetupCommand(
      mockGuild,
      adminMember,
      { id: 'chan-1' },
      (payload) => { replyPayload = payload; }
    );

    assert.ok(replyPayload);
    assert.ok(replyPayload.embeds && replyPayload.embeds.length > 0);
    assert.match(replyPayload.embeds[0].data.title, /Organiser Verification Setup/);
    assert.strictEqual(replyPayload.components.length, 3, 'Should contain channel menu, role menu, and button row');
  });

  await t.test('5. Message listener ignores messages in non-configured channels', async () => {
    setGuildVerificationConfig('guild-test-5', {
      verificationChannelId: 'chan-configured-verify',
      organiserRoleId: 'role-org-5',
    });

    let deleteCalled = false;
    const mockMessage = {
      content: 'MD-ORG-8X72KQ',
      channelId: 'different-channel-id',
      author: { bot: false, id: 'user-1' },
      guild: { id: 'guild-test-5' },
      delete: async () => { deleteCalled = true; },
    };

    await handleOrganiserActivationMessage(mockMessage);
    assert.strictEqual(deleteCalled, false, 'Message outside verification channel must not be processed');
  });

  await t.test('6. Message listener ignores bot messages and non-code messages', async () => {
    setGuildVerificationConfig('guild-test-6', {
      verificationChannelId: 'chan-verify-6',
      organiserRoleId: 'role-org-6',
    });

    let deleteCalled = false;
    const botMessage = {
      content: 'MD-ORG-8X72KQ',
      channelId: 'chan-verify-6',
      author: { bot: true, id: 'bot-1' },
      guild: { id: 'guild-test-6' },
      delete: async () => { deleteCalled = true; },
    };

    await handleOrganiserActivationMessage(botMessage);
    assert.strictEqual(deleteCalled, false, 'Bot message must be ignored');

    const regularChat = {
      content: 'Hello everyone how are you doing?',
      channelId: 'chan-verify-6',
      author: { bot: false, id: 'user-2' },
      guild: { id: 'guild-test-6' },
      delete: async () => { deleteCalled = true; },
    };

    await handleOrganiserActivationMessage(regularChat);
    assert.strictEqual(deleteCalled, false, 'Non-code message must be ignored');
  });

  await t.test('7. Interaction handler routes claim role button properly', async () => {
    setGuildVerificationConfig('guild-test-7', {
      verificationChannelId: 'chan-verify-7',
      organiserRoleId: 'role-org-7',
    });

    let repliedContent = null;
    let rolesAdded = [];

    const mockInteraction = {
      isMessageComponent: () => true,
      customId: 'org_claim_role:user-verified-7',
      user: { id: 'user-verified-7' },
      guildId: 'guild-test-7',
      guild: {
        id: 'guild-test-7',
        members: {
          fetch: async (id) => ({
            id,
            roles: {
              add: async (roleId) => { rolesAdded.push(roleId); },
            },
          }),
        },
      },
      reply: async (opts) => { repliedContent = opts.content; },
    };

    const handled = await handleOrganiserVerificationInteraction(mockInteraction);
    assert.strictEqual(handled, true);
    assert.strictEqual(rolesAdded.includes('role-org-7'), true, 'Configured role must be added to user');
    assert.match(repliedContent, /successfully assigned/);
  });
});

