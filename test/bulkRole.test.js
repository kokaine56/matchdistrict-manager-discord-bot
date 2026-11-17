import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import {
  canMemberManageRoles,
  canBotAssignRoles,
  getAssignableRoles,
  buildRoleSelectPayload,
  buildUserSelectPayload,
  buildConfirmationPayload,
  resolveTargetMembers,
  executeBulkRoleAssignment,
  handleBulkRoleCommand,
  handleBulkRoleInteraction,
  activeBulkRoleSessions,
  BULK_ROLE_PREFIX,
} from '../bulkRoleService.js';

function createMockGuild(options = {}) {
  const guildId = options.guildId || 'guild-test-101';
  const rolesMap = new Map();
  const membersMap = new Map();

  // @everyone role
  const everyoneRole = {
    id: guildId,
    name: '@everyone',
    position: 0,
    managed: false,
    members: new Map(),
  };
  rolesMap.set(guildId, everyoneRole);

  // Bot role
  const botRole = {
    id: 'role-bot',
    name: 'MatchDistrict Bot',
    position: options.botRolePosition ?? 50,
    managed: false,
    members: new Map(),
  };
  rolesMap.set(botRole.id, botRole);

  // Admin role
  const adminRole = {
    id: 'role-admin',
    name: 'Administrator',
    position: options.adminRolePosition ?? 60,
    managed: false,
    members: new Map(),
  };
  rolesMap.set(adminRole.id, adminRole);

  // Assignable target roles
  const vipRole = {
    id: 'role-vip',
    name: 'VIP Member',
    position: 30,
    managed: false,
    members: new Map(),
  };
  rolesMap.set(vipRole.id, vipRole);

  const gamerRole = {
    id: 'role-gamer',
    name: 'Pro Gamer',
    position: 20,
    managed: false,
    members: new Map(),
  };
  rolesMap.set(gamerRole.id, gamerRole);

  // Managed role (e.g. integration/bot role)
  const managedRole = {
    id: 'role-managed-music',
    name: 'Rythm Bot Role',
    position: 25,
    managed: true,
    members: new Map(),
  };
  rolesMap.set(managedRole.id, managedRole);

  // Role above bot (unassignable by bot)
  const ownerRole = {
    id: 'role-server-owner',
    name: 'Server Owner Role',
    position: 100,
    managed: false,
    members: new Map(),
  };
  rolesMap.set(ownerRole.id, ownerRole);

  // Bot member
  const botMember = {
    id: 'bot-101',
    user: { id: 'bot-101', username: 'MatchDistrict Bot', bot: true },
    roles: {
      cache: new Map([
        [botRole.id, botRole],
        [everyoneRole.id, everyoneRole],
      ]),
      highest: botRole,
    },
    permissions: {
      has: (perm) => options.botHasManageRoles !== false,
    },
  };
  membersMap.set(botMember.id, botMember);

  // Admin member
  const adminMember = {
    id: 'user-admin-1',
    user: { id: 'user-admin-1', username: 'ServerAdmin', bot: false },
    roles: {
      cache: new Map([
        [adminRole.id, adminRole],
        [everyoneRole.id, everyoneRole],
      ]),
      highest: adminRole,
    },
    permissions: {
      has: (perm) => {
        if (options.userHasManageRoles === false) return false;
        return perm === PermissionFlagsBits.Administrator || perm === PermissionFlagsBits.ManageRoles;
      },
    },
  };
  membersMap.set(adminMember.id, adminMember);

  // Target regular members
  const member1 = {
    id: 'user-regular-1',
    user: { id: 'user-regular-1', username: 'PlayerOne', bot: false },
    roles: {
      cache: new Map([[everyoneRole.id, everyoneRole]]),
      add: async (roleId, reason) => {
        const r = rolesMap.get(typeof roleId === 'string' ? roleId : roleId.id);
        if (r) member1.roles.cache.set(r.id, r);
        return member1;
      },
    },
  };
  membersMap.set(member1.id, member1);

  const member2 = {
    id: 'user-regular-2',
    user: { id: 'user-regular-2', username: 'PlayerTwo', bot: false },
    roles: {
      cache: new Map([
        [everyoneRole.id, everyoneRole],
        [vipRole.id, vipRole], // Already has VIP
      ]),
      add: async (roleId, reason) => {
        const r = rolesMap.get(typeof roleId === 'string' ? roleId : roleId.id);
        if (r) member2.roles.cache.set(r.id, r);
        return member2;
      },
    },
  };
  membersMap.set(member2.id, member2);

  // Bot member to skip
  const regularBotMember = {
    id: 'user-music-bot',
    user: { id: 'user-music-bot', username: 'MusicBot', bot: true },
    roles: {
      cache: new Map([[everyoneRole.id, everyoneRole]]),
      add: async () => {},
    },
  };
  membersMap.set(regularBotMember.id, regularBotMember);

  const guild = {
    id: guildId,
    name: 'Match District Testing Server',
    ownerId: options.ownerId || 'owner-999',
    roles: {
      cache: rolesMap,
    },
    members: {
      cache: membersMap,
      me: botMember,
      fetch: async (id) => {
        if (id) return membersMap.get(id) || null;
        return membersMap;
      },
    },
  };

  return { guild, adminMember, botMember, vipRole, gamerRole, ownerRole, managedRole, membersMap };
}

test('Bulk Role Assignment - Permission Guards', async (t) => {
  await t.test('canMemberManageRoles accepts admin or manage roles, rejects standard member', () => {
    const { guild, adminMember } = createMockGuild();
    assert.equal(canMemberManageRoles(adminMember, guild), true);

    const normalUser = {
      id: 'regular-user',
      permissions: { has: () => false },
    };
    assert.equal(canMemberManageRoles(normalUser, guild), false);

    // Guild owner bypasses permission check
    const guildOwner = {
      id: guild.ownerId,
      permissions: { has: () => false },
    };
    assert.equal(canMemberManageRoles(guildOwner, guild), true);
  });

  await t.test('canBotAssignRoles verifies bot ManageRoles permission', () => {
    const { guild } = createMockGuild({ botHasManageRoles: true });
    assert.equal(canBotAssignRoles(guild), true);

    const { guild: noPermGuild } = createMockGuild({ botHasManageRoles: false });
    assert.equal(canBotAssignRoles(noPermGuild), false);
  });
});

test('Bulk Role Assignment - Role Hierarchy & Filtering', async (t) => {
  await t.test('getAssignableRoles excludes @everyone, managed roles, and roles above bot', () => {
    const { guild, adminMember, vipRole, gamerRole, ownerRole, managedRole } = createMockGuild();
    const assignable = getAssignableRoles(guild, adminMember);

    // Should include VIP (pos 30) and Gamer (pos 20)
    const assignableIds = assignable.map((r) => r.id);
    assert.ok(assignableIds.includes(vipRole.id), 'VIP role should be assignable');
    assert.ok(assignableIds.includes(gamerRole.id), 'Gamer role should be assignable');

    // Should NOT include @everyone, managed role, or owner role (above bot)
    assert.ok(!assignableIds.includes(guild.id), '@everyone must be excluded');
    assert.ok(!assignableIds.includes(managedRole.id), 'Managed roles must be excluded');
    assert.ok(!assignableIds.includes(ownerRole.id), 'Roles above bot highest role must be excluded');

    // Hierarchy sort descending
    assert.equal(assignable[0].id, vipRole.id);
    assert.equal(assignable[1].id, gamerRole.id);
  });

  await t.test('getAssignableRoles respects user hierarchy for non-owner', () => {
    const { guild, adminMember, vipRole } = createMockGuild({
      botRolePosition: 80,
      adminRolePosition: 25, // Admin is position 25, VIP is position 30
    });
    const assignable = getAssignableRoles(guild, adminMember);
    const assignableIds = assignable.map((r) => r.id);

    // VIP is above admin's position (30 > 25), so non-owner admin cannot assign it
    assert.ok(!assignableIds.includes(vipRole.id), 'Roles above admin position must be excluded for non-owner');
  });
});

test('Bulk Role Assignment - Step 1: Role Selection & 25-Option Pagination', async (t) => {
  const { guild, adminMember } = createMockGuild();
  const session = { id: 'sess-1', page: 0 };

  // Create 30 mock roles to test pagination limit of 25
  const mockRoles = Array.from({ length: 30 }, (_, i) => ({
    id: `role-test-${i + 1}`,
    name: `Test Role ${i + 1}`,
    position: 30 - i,
    members: new Map(),
  }));

  await t.test('buildRoleSelectPayload limits select menu to max 25 options per page', () => {
    const payload = buildRoleSelectPayload(session, mockRoles);
    assert.equal(payload.components.length, 2);

    const selectMenu = payload.components[0].components[0];
    assert.equal(selectMenu.options.length, 25, 'First page must contain exactly 25 options');

    const buttonRow = payload.components[1];
    // Prev, Indicator, Next, Cancel
    assert.equal(buttonRow.components.length, 4);
    assert.equal(buttonRow.components[0].data.disabled, true, 'Prev button disabled on page 0');
    assert.equal(buttonRow.components[2].data.disabled, false, 'Next button enabled on page 0');
  });

  await t.test('buildRoleSelectPayload second page contains remaining 5 options', () => {
    session.page = 1;
    const payload = buildRoleSelectPayload(session, mockRoles);
    const selectMenu = payload.components[0].components[0];
    assert.equal(selectMenu.options.length, 5, 'Second page must contain remaining 5 options');

    const buttonRow = payload.components[1];
    assert.equal(buttonRow.components[0].data.disabled, false, 'Prev button enabled on page 1');
    assert.equal(buttonRow.components[2].data.disabled, true, 'Next button disabled on last page');
  });
});

test('Bulk Role Assignment - Step 2: Target Member Selection', async (t) => {
  const { vipRole } = createMockGuild();
  const session = { id: 'sess-2', selectedUserIds: [] };

  await t.test('buildUserSelectPayload defaults to All Server Members when empty', () => {
    const payload = buildUserSelectPayload(session, vipRole);
    assert.equal(payload.components.length, 2);

    const userSelect = payload.components[0].components[0];
    assert.equal(userSelect.data.min_values, 1);
    assert.equal(userSelect.data.max_values, 25);

    const field = payload.embeds[0].data.fields.find((f) => f.name.includes('Current Target Selection'));
    assert.ok(field.value.includes('All Server Members'), 'Must indicate All Server Members as default');
  });

  await t.test('buildUserSelectPayload displays specific members when selected', () => {
    session.selectedUserIds = ['user-regular-1', 'user-regular-2'];
    const payload = buildUserSelectPayload(session, vipRole);

    const field = payload.embeds[0].data.fields.find((f) => f.name.includes('Current Target Selection'));
    assert.ok(field.value.includes('2 Specific Members Selected'), 'Must display specific selected count');
    assert.ok(field.value.includes('<@user-regular-1>'));

    // Should include Reset to All Members button
    const buttons = payload.components[1].components;
    const hasReset = buttons.some((b) => b.data.label?.includes('Reset to All'));
    assert.ok(hasReset, 'Must include Reset to All Members button');
  });
});

test('Bulk Role Assignment - Step 3: Target Resolution & Pre-Execution Confirmation', async (t) => {
  const { guild, vipRole } = createMockGuild();

  await t.test('resolveTargetMembers for All Server Members filters bots and members with role', async () => {
    // guild has: admin (no VIP), member1 (no VIP), member2 (has VIP), regularBot (bot)
    const { targetMembers, alreadyHasRoleCount, botCount } = await resolveTargetMembers(guild, vipRole, []);

    // Eligible should be adminMember and member1 (2 members)
    assert.equal(targetMembers.length, 2);
    const targetIds = targetMembers.map((m) => m.id);
    assert.ok(targetIds.includes('user-admin-1'));
    assert.ok(targetIds.includes('user-regular-1'));

    // member2 already has VIP
    assert.equal(alreadyHasRoleCount, 1);
    // regularBot and botMember are bots
    assert.ok(botCount >= 1);
  });

  await t.test('resolveTargetMembers for Specific Members filters accordingly', async () => {
    // Only select member2 (who already has VIP) and regularBot (bot)
    const { targetMembers, alreadyHasRoleCount, botCount } = await resolveTargetMembers(
      guild,
      vipRole,
      ['user-regular-2', 'user-music-bot']
    );

    assert.equal(targetMembers.length, 0, 'No eligible members should remain');
    assert.equal(alreadyHasRoleCount, 1);
    assert.equal(botCount, 1);
  });

  await t.test('buildConfirmationPayload displays correct member counts before execution', () => {
    const session = { id: 'sess-3', selectedUserIds: [] };
    const dummyTargets = [{ id: 'm1' }, { id: 'm2' }];
    const payload = buildConfirmationPayload(session, vipRole, dummyTargets, 5, 2);

    assert.equal(payload.eligibleCount, 2);
    const memberField = payload.embeds[0].data.fields.find((f) => f.name.includes('Members to Receive Role'));
    assert.ok(memberField.value.includes('2'));
    assert.ok(memberField.value.includes('members'));

    const startBtn = payload.components[0].components.find((b) => b.data.custom_id.includes('execute'));
    assert.ok(startBtn, 'Must include Start Assignment button');
  });
});

test('Bulk Role Assignment - Step 4: Execution Workflow', async (t) => {
  const { guild, vipRole, membersMap } = createMockGuild();
  const targetMember = membersMap.get('user-regular-1');

  await t.test('executeBulkRoleAssignment assigns role and tracks success counts', async () => {
    assert.equal(targetMember.roles.cache.has(vipRole.id), false, 'Initially member does not have VIP');

    const result = await executeBulkRoleAssignment(guild, vipRole, [targetMember]);
    assert.equal(result.total, 1);
    assert.equal(result.successCount, 1);
    assert.equal(result.failureCount, 0);

    assert.equal(targetMember.roles.cache.has(vipRole.id), true, 'Member now has VIP role assigned');
  });
});

test('Bulk Role Assignment - Command Invocation & Interaction Routing', async (t) => {
  const { guild, adminMember } = createMockGuild();
  const channel = { id: 'ch-general-1' };

  await t.test('handleBulkRoleCommand rejects non-admin users', async () => {
    let replyContent = null;
    const normalUser = { id: 'u-norm', permissions: { has: () => false } };

    await handleBulkRoleCommand(
      guild,
      normalUser,
      channel,
      [],
      (msg) => { replyContent = msg; }
    );

    assert.match(replyContent, /permission to use this command/);
  });

  await t.test('handleBulkRoleCommand sends Step 1 role select menu for admin', async () => {
    let sentPayload = null;
    await handleBulkRoleCommand(
      guild,
      adminMember,
      channel,
      [],
      (payload) => { sentPayload = payload; }
    );

    assert.ok(sentPayload);
    assert.ok(sentPayload.embeds);
    assert.ok(sentPayload.components);

    // Verify session was registered in activeBulkRoleSessions
    const sessions = Array.from(activeBulkRoleSessions.values());
    assert.ok(sessions.length > 0);
    const session = sessions[sessions.length - 1];
    assert.equal(session.guildId, guild.id);
    assert.equal(session.userId, adminMember.id);

    // Test Cancel interaction
    let updatedPayload = null;
    const mockInteraction = {
      customId: `${BULK_ROLE_PREFIX}cancel:${session.id}`,
      user: { id: adminMember.id },
      guild,
      member: adminMember,
      update: async (data) => { updatedPayload = data; },
      reply: async () => {},
    };

    const handled = await handleBulkRoleInteraction(mockInteraction);
    assert.equal(handled, true);
    assert.ok(updatedPayload.embeds[0].data.title.includes('Cancelled'));
    assert.equal(activeBulkRoleSessions.has(session.id), false, 'Session must be cleaned up on cancel');
  });

  await t.test('handleBulkRoleInteraction rejects non-author interaction', async () => {
    const session = {
      id: 'sess-auth-test',
      guildId: guild.id,
      userId: adminMember.id,
      createdAt: Date.now(),
    };
    activeBulkRoleSessions.set(session.id, session);

    let replyData = null;
    const unauthorizedUser = {
      customId: `${BULK_ROLE_PREFIX}confirm:${session.id}`,
      user: { id: 'intruder-user' },
      guild,
      member: { id: 'intruder-user' },
      reply: async (data) => { replyData = data; },
    };

    const handled = await handleBulkRoleInteraction(unauthorizedUser);
    assert.equal(handled, true);
    assert.equal(replyData.ephemeral, true);
    assert.match(replyData.content, /Only the administrator who initiated/);

    activeBulkRoleSessions.delete(session.id);
  });
});
