// matchdistrict-manager-discord-bot/test/welcomeRole.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits, ChannelType } from 'discord.js';
import {
  canMemberManageWelcomeRole,
  canBotAssignRoles,
  getAssignableRoles,
  buildRoleSelectPayload,
  buildRoleRemovePayload,
  handleWelcomeRoleCommand,
  handleWelcomeRoleInteraction,
  handleWelcomeRoleOnMemberJoin,
  saveWelcomeConfig,
  getWelcomeConfig,
  disableWelcomeConfig,
  welcomeConfigCache,
  activeWelcomeRoleSessions,
  WELCOME_ROLE_PREFIX,
} from '../welcomeRoleService.js';

function createMockEnvironment() {
  const guildId = 'guild-welc-multirole';
  const roles = new Map();
  const channels = new Map();
  const members = new Map();

  // Roles setup
  const everyoneRole = { id: guildId, name: '@everyone', position: 0, managed: false };
  const memberRole = { id: 'role-member', name: 'Member', position: 10, managed: false };
  const gamerRole = { id: 'role-gamer', name: 'Verified Gamer', position: 15, managed: false };
  const esportsRole = { id: 'role-esports', name: 'Esports Athlete', position: 18, managed: false };
  const botRole = { id: 'role-bot', name: 'MatchDistrict Bot', position: 20, managed: true };
  const adminRole = { id: 'role-admin', name: 'Admin', position: 30, managed: false };

  roles.set(everyoneRole.id, everyoneRole);
  roles.set(memberRole.id, memberRole);
  roles.set(gamerRole.id, gamerRole);
  roles.set(esportsRole.id, esportsRole);
  roles.set(botRole.id, botRole);
  roles.set(adminRole.id, adminRole);

  // Bot member
  const botMember = {
    id: 'bot-id',
    user: { id: 'bot-id', bot: true },
    roles: {
      cache: new Map([[botRole.id, botRole]]),
      highest: botRole,
    },
    permissions: {
      has: (p) => p === PermissionFlagsBits.ManageRoles || p === PermissionFlagsBits.Administrator || p === 'ManageRoles' || p === 'Administrator',
    },
  };

  // Channels setup (to verify NO messages are ever sent)
  const generalChannel = {
    id: 'ch-general',
    name: 'general',
    type: ChannelType.GuildText,
    messages: [],
    send: async function(payload) {
      this.messages.push(payload);
      return { id: `msg-${Date.now()}`, ...payload };
    },
  };
  channels.set(generalChannel.id, generalChannel);

  // Guild setup
  const guild = {
    id: guildId,
    name: 'Match District Community',
    ownerId: 'owner-user',
    memberCount: 50,
    roles: { cache: roles, fetch: async (id) => roles.get(id) || null },
    channels: { cache: channels, fetch: async (id) => channels.get(id) || null },
    members: {
      cache: members,
      me: botMember,
      fetch: async (id) => members.get(id) || null,
    },
  };

  // Admin member
  const adminMember = {
    id: 'user-admin',
    user: { id: 'user-admin', tag: 'Admin#0001', username: 'Admin' },
    guild,
    roles: {
      cache: new Map([[adminRole.id, adminRole]]),
      highest: adminRole,
    },
    permissions: {
      has: (p) => p === PermissionFlagsBits.Administrator || p === PermissionFlagsBits.ManageGuild || p === 'Administrator' || p === 'ManageGuild',
    },
  };
  members.set(adminMember.id, adminMember);

  // Regular member
  const regularMember = {
    id: 'user-regular',
    user: { id: 'user-regular', tag: 'Player#1234', username: 'Player' },
    guild,
    roles: {
      cache: new Map([[everyoneRole.id, everyoneRole]]),
      highest: everyoneRole,
      add: async function(roleId, reason) {
        const r = roles.get(typeof roleId === 'string' ? roleId : roleId?.id);
        if (r) this.cache.set(r.id, r);
        return this;
      },
      remove: async function(roleId, reason) {
        const r = roles.get(typeof roleId === 'string' ? roleId : roleId?.id);
        if (r) this.cache.delete(r.id);
        return this;
      },
    },
    permissions: {
      has: () => false,
    },
  };
  members.set(regularMember.id, regularMember);

  return { guild, roles, channels, members, botMember, adminMember, regularMember, generalChannel };
}

test('1. Permission Guards & Role Hierarchy Filtering for Multiple Roles', () => {
  const { guild, adminMember, regularMember } = createMockEnvironment();

  assert.equal(canMemberManageWelcomeRole(adminMember, guild), true, 'Admin can manage welcome roles');
  assert.equal(canMemberManageWelcomeRole(regularMember, guild), false, 'Regular member cannot manage welcome roles');

  const assignable = getAssignableRoles(guild, adminMember);
  assert.equal(assignable.length, 3, 'Must find 3 assignable roles');
  assert.equal(assignable[0].name, 'Esports Athlete');
  assert.equal(assignable[1].name, 'Verified Gamer');
  assert.equal(assignable[2].name, 'Member');

  // Must exclude @everyone and bot managed role
  assert.ok(!assignable.some((r) => r.name === '@everyone'));
  assert.ok(!assignable.some((r) => r.name === 'MatchDistrict Bot'));
  assert.ok(!assignable.some((r) => r.name === 'Admin'));
});

test('2. Multi-Role Selection: Admin selects multiple roles and saves to MongoDB/cache', async () => {
  const env = createMockEnvironment();

  // 1. Launch command
  let replyPayload = null;
  await handleWelcomeRoleCommand(env.guild, env.adminMember, env.generalChannel, ['role'], async (p) => {
    replyPayload = p;
  });
  assert.ok(replyPayload);
  assert.ok(replyPayload.embeds[0].data.title.includes('Select Roles'));

  // Get session
  const session = Array.from(activeWelcomeRoleSessions.values())[0];
  assert.ok(session);

  // 2. Select multiple roles via dropdown: 'role-member' AND 'role-gamer'
  let selectUpdatedPayload = null;
  const mockSelectInteraction = {
    customId: `${WELCOME_ROLE_PREFIX}role_sel:${session.id}`,
    values: ['role-member', 'role-gamer'],
    guild: env.guild,
    member: env.adminMember,
    user: env.adminMember.user,
    update: async (payload) => {
      selectUpdatedPayload = payload;
      return payload;
    },
    reply: async () => {},
  };

  const selectHandled = await handleWelcomeRoleInteraction(mockSelectInteraction);
  assert.equal(selectHandled, true);
  assert.ok(selectUpdatedPayload);
  assert.equal(session.selectedRoleIds.length, 2);

  // Verify save button appears with count
  const buttonRow = selectUpdatedPayload.components[1];
  const saveBtn = buttonRow.components.find((b) => b.data.label.includes('Save Roles (2)'));
  assert.ok(saveBtn, 'Save button must display selected count');

  // 3. Click Save Roles
  let saveUpdatedPayload = null;
  const mockSaveInteraction = {
    customId: `${WELCOME_ROLE_PREFIX}save_roles:${session.id}`,
    guild: env.guild,
    member: env.adminMember,
    user: env.adminMember.user,
    update: async (payload) => {
      saveUpdatedPayload = payload;
      return payload;
    },
    reply: async () => {},
  };

  const saveHandled = await handleWelcomeRoleInteraction(mockSaveInteraction);
  assert.equal(saveHandled, true);
  assert.ok(saveUpdatedPayload);
  assert.ok(saveUpdatedPayload.embeds[0].data.title.includes('Welcome Roles Saved'));

  // Session must be cleared
  assert.equal(activeWelcomeRoleSessions.has(session.id), false);

  // Configuration must store both roles in cache & DB
  const config = await getWelcomeConfig(env.guild.id);
  assert.ok(config);
  assert.equal(config.enabled, true);
  assert.equal(config.roleIds.length, 2);
  assert.ok(config.roleIds.includes('role-member'));
  assert.ok(config.roleIds.includes('role-gamer'));
});

test('3. Member Join: Automatically assigns ALL configured welcome roles silently with zero messages', async () => {
  const env = createMockEnvironment();

  // Save 2 roles: Member and Verified Gamer
  await saveWelcomeConfig(env.guild.id, {
    roleIds: ['role-member', 'role-gamer'],
    enabled: true,
  });

  const newMember = {
    id: 'user-multirole-newbie',
    user: { id: 'user-multirole-newbie', tag: 'ProNewbie#9999', username: 'ProNewbie', bot: false },
    guild: env.guild,
    roles: {
      cache: new Map(),
      add: async function(roleId, reason) {
        const r = env.roles.get(typeof roleId === 'string' ? roleId : roleId?.id);
        if (r) this.cache.set(r.id, r);
        return this;
      },
    },
  };
  env.members.set(newMember.id, newMember);

  await handleWelcomeRoleOnMemberJoin(newMember);

  // Both roles must be assigned
  assert.equal(newMember.roles.cache.has('role-member'), true, 'Must have received role-member');
  assert.equal(newMember.roles.cache.has('role-gamer'), true, 'Must have received role-gamer');
  assert.equal(newMember.roles.cache.size, 2);

  // ABSOLUTELY ZERO messages in any channel
  for (const ch of env.guild.channels.cache.values()) {
    assert.equal(ch.messages?.length ?? 0, 0, `No message must be sent in channel ${ch.name}`);
  }
});

test('4. Duplicate Role Prevention on Multi-Role Join', async () => {
  const env = createMockEnvironment();

  await saveWelcomeConfig(env.guild.id, {
    roleIds: ['role-member', 'role-gamer'],
    enabled: true,
  });

  // Member already has 'role-member', missing 'role-gamer'
  const memberWithExistingRole = {
    id: 'user-partial-roles',
    user: { id: 'user-partial-roles', tag: 'Partial#2222', username: 'Partial', bot: false },
    guild: env.guild,
    roles: {
      cache: new Map([['role-member', env.roles.get('role-member')]]),
      add: async function(roleId, reason) {
        const r = env.roles.get(typeof roleId === 'string' ? roleId : roleId?.id);
        if (r) this.cache.set(r.id, r);
        return this;
      },
    },
  };

  let addCalls = [];
  const origAdd = memberWithExistingRole.roles.add;
  memberWithExistingRole.roles.add = async function(roleId, reason) {
    addCalls.push(roleId);
    return origAdd.apply(this, [roleId, reason]);
  };

  await handleWelcomeRoleOnMemberJoin(memberWithExistingRole);

  // Only role-gamer should be assigned; role-member must be skipped
  assert.equal(addCalls.length, 1);
  assert.equal(addCalls[0], 'role-gamer');
  assert.equal(memberWithExistingRole.roles.cache.has('role-gamer'), true);
});

test('5. Deleted Role Resilience: Skips nonexistent role and assigns remaining valid roles', async () => {
  const env = createMockEnvironment();

  // One nonexistent role and one valid role
  await saveWelcomeConfig(env.guild.id, {
    roleIds: ['deleted-role-xyz', 'role-esports'],
    enabled: true,
  });

  const newMember = {
    id: 'user-resilient',
    user: { id: 'user-resilient', bot: false },
    guild: env.guild,
    roles: {
      cache: new Map(),
      add: async function(roleId) {
        const r = env.roles.get(roleId);
        if (r) this.cache.set(r.id, r);
      },
    },
  };

  await assert.doesNotReject(async () => {
    await handleWelcomeRoleOnMemberJoin(newMember);
  });

  // Must have successfully assigned the valid role
  assert.equal(newMember.roles.cache.has('role-esports'), true);
});

test('6. .welcome role remove: Displays configured roles with Remove Selected, Remove All, and Cancel', async () => {
  const env = createMockEnvironment();

  await saveWelcomeConfig(env.guild.id, {
    roleIds: ['role-member', 'role-gamer', 'role-esports'],
    enabled: true,
  });

  let replyPayload = null;
  await handleWelcomeRoleCommand(env.guild, env.adminMember, env.generalChannel, ['remove'], async (p) => {
    replyPayload = p;
  });

  assert.ok(replyPayload);
  assert.ok(replyPayload.embeds[0].data.title.includes('Remove Automatic Welcome Roles'));

  // Verify dropdown menu options
  const selectMenu = replyPayload.components[0].components[0];
  assert.equal(selectMenu.options.length, 3);

  // Verify buttons: Remove Selected, Remove All, Cancel
  const buttonRow = replyPayload.components[1];
  const removeSelectedBtn = buttonRow.components.find((b) => b.data.label.includes('Remove Selected'));
  const removeAllBtn = buttonRow.components.find((b) => b.data.label === 'Remove All');
  const cancelBtn = buttonRow.components.find((b) => b.data.label === 'Cancel');

  assert.ok(removeSelectedBtn);
  assert.ok(removeAllBtn);
  assert.ok(cancelBtn);
});

test('7. .welcome role remove: Remove Selected removes chosen roles and updates config', async () => {
  const env = createMockEnvironment();

  await saveWelcomeConfig(env.guild.id, {
    roleIds: ['role-member', 'role-gamer', 'role-esports'],
    enabled: true,
  });

  // Start removal command
  await handleWelcomeRoleCommand(env.guild, env.adminMember, env.generalChannel, ['remove'], async () => {});
  const session = Array.from(activeWelcomeRoleSessions.values())[0];
  assert.ok(session);

  // Select 'role-gamer' to remove
  const mockSelect = {
    customId: `${WELCOME_ROLE_PREFIX}rem_sel:${session.id}`,
    values: ['role-gamer'],
    guild: env.guild,
    member: env.adminMember,
    user: env.adminMember.user,
    update: async () => {},
    reply: async () => {},
  };
  await handleWelcomeRoleInteraction(mockSelect);

  // Click Remove Selected
  let updatedPayload = null;
  const mockRemoveSelected = {
    customId: `${WELCOME_ROLE_PREFIX}rem_selected:${session.id}`,
    guild: env.guild,
    member: env.adminMember,
    user: env.adminMember.user,
    update: async (p) => {
      updatedPayload = p;
    },
    reply: async () => {},
  };

  const handled = await handleWelcomeRoleInteraction(mockRemoveSelected);
  assert.equal(handled, true);
  assert.ok(updatedPayload);
  assert.ok(updatedPayload.embeds[0].data.title.includes('Welcome Roles Removed'));

  // Config should now only contain role-member and role-esports
  const updatedConfig = await getWelcomeConfig(env.guild.id);
  assert.equal(updatedConfig.roleIds.length, 2);
  assert.ok(!updatedConfig.roleIds.includes('role-gamer'));
  assert.ok(updatedConfig.roleIds.includes('role-member'));
  assert.ok(updatedConfig.roleIds.includes('role-esports'));
});

test('8. .welcome role remove: Remove All prompts confirmation and clears all configured roles', async () => {
  const env = createMockEnvironment();

  await saveWelcomeConfig(env.guild.id, {
    roleIds: ['role-member', 'role-esports'],
    enabled: true,
  });

  // Start removal
  await handleWelcomeRoleCommand(env.guild, env.adminMember, env.generalChannel, ['remove'], async () => {});
  const session = Array.from(activeWelcomeRoleSessions.values())[0];

  // 1. Click Remove All -> Must show confirmation prompt
  let promptPayload = null;
  const mockPromptInteraction = {
    customId: `${WELCOME_ROLE_PREFIX}rem_all_prompt:${session.id}`,
    guild: env.guild,
    member: env.adminMember,
    user: env.adminMember.user,
    update: async (p) => {
      promptPayload = p;
    },
    reply: async () => {},
  };

  await handleWelcomeRoleInteraction(mockPromptInteraction);
  assert.ok(promptPayload);
  assert.ok(promptPayload.embeds[0].data.title.includes('Confirm Removal of All Welcome Roles'));
  const confirmBtn = promptPayload.components[0].components.find((b) => b.data.label.includes('Yes, Remove All'));
  assert.ok(confirmBtn, 'Must require confirmation button');

  // 2. Click Confirm Remove All
  let confirmPayload = null;
  const mockConfirmInteraction = {
    customId: `${WELCOME_ROLE_PREFIX}rem_all_confirm:${session.id}`,
    guild: env.guild,
    member: env.adminMember,
    user: env.adminMember.user,
    update: async (p) => {
      confirmPayload = p;
    },
    reply: async () => {},
  };

  await handleWelcomeRoleInteraction(mockConfirmInteraction);
  assert.ok(confirmPayload);
  assert.ok(confirmPayload.embeds[0].data.title.includes('All Welcome Roles Removed'));

  // Configuration must be cleared and disabled
  const clearedConfig = await getWelcomeConfig(env.guild.id);
  assert.equal(clearedConfig.roleIds.length, 0);
  assert.equal(clearedConfig.enabled, false);
});

test('9. CRITICAL SAFETY: Removing welcome roles does NOT remove roles from existing server members', async () => {
  const env = createMockEnvironment();

  // Existing member has 'role-member' and 'role-gamer'
  const existingMember = {
    id: 'user-veteran',
    user: { id: 'user-veteran', tag: 'Veteran#0001', username: 'Veteran', bot: false },
    guild: env.guild,
    roles: {
      cache: new Map([
        ['role-member', env.roles.get('role-member')],
        ['role-gamer', env.roles.get('role-gamer')],
      ]),
      remove: async function(roleId) {
        assert.fail(`Must NEVER remove role ${roleId} from existing members when removing welcome role config!`);
      },
    },
  };
  env.members.set(existingMember.id, existingMember);

  // Configure both roles as welcome roles
  await saveWelcomeConfig(env.guild.id, {
    roleIds: ['role-member', 'role-gamer'],
    enabled: true,
  });

  // Start and execute Remove All
  await handleWelcomeRoleCommand(env.guild, env.adminMember, env.generalChannel, ['remove'], async () => {});
  const session = Array.from(activeWelcomeRoleSessions.values())[0];

  const mockConfirmAll = {
    customId: `${WELCOME_ROLE_PREFIX}rem_all_confirm:${session.id}`,
    guild: env.guild,
    member: env.adminMember,
    user: env.adminMember.user,
    update: async () => {},
    reply: async () => {},
  };

  await handleWelcomeRoleInteraction(mockConfirmAll);

  // Existing member still has both roles untouched
  assert.equal(existingMember.roles.cache.has('role-member'), true);
  assert.equal(existingMember.roles.cache.has('role-gamer'), true);
  assert.equal(existingMember.roles.cache.size, 2);
});

test('10. Status and Empty Checks', async () => {
  const env = createMockEnvironment();

  // 1. Status with multiple roles
  await saveWelcomeConfig(env.guild.id, {
    roleIds: ['role-member', 'role-esports'],
    enabled: true,
  });

  let statusPayload = null;
  await handleWelcomeRoleCommand(env.guild, env.adminMember, env.generalChannel, ['status'], async (p) => {
    statusPayload = p;
  });
  assert.ok(statusPayload.embeds[0].data.description.includes('Active'));
  assert.ok(statusPayload.embeds[0].data.description.includes('role-member'));
  assert.ok(statusPayload.embeds[0].data.description.includes('role-esports'));

  // 2. Remove when no roles configured
  await disableWelcomeConfig(env.guild.id);
  let removeEmptyPayload = null;
  await handleWelcomeRoleCommand(env.guild, env.adminMember, env.generalChannel, ['remove'], async (p) => {
    removeEmptyPayload = p;
  });
  assert.ok(removeEmptyPayload.includes('No welcome roles configured'));
});
