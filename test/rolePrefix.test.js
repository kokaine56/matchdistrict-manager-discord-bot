import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import {
  clearRolePrefixMemoryCache,
  getGuildRolePrefixes,
  getGuildRolePrefixesFromCache,
  saveRolePrefix,
  deleteRolePrefix,
  findPrefixInGuild,
  isRoleAdmin,
  canBotManageNicknames,
  isMemberManageable,
  formatPrefixedNickname,
  stripManagedPrefix,
  resolveActivePrefixConfig,
  computeTargetNickname,
  applyRolePrefixToGuildMembers,
  removeRolePrefixFromGuildMembers,
  handleRoleCommand,
  handleRolePrefixInteraction,
  handleRolePrefixMemberUpdate,
} from '../bot/discord/features/rolePrefix/index.js';

function createMockEnvironment(options = {}) {
  const guildId = options.guildId || 'guild-prefix-1';
  const roles = new Map();
  const members = new Map();

  const botRole = {
    id: 'role-bot',
    name: 'BotRole',
    position: 50,
    comparePositionTo: (other) => 50 - (other?.position ?? 0),
  };
  roles.set(botRole.id, botRole);

  const dsxRole = {
    id: 'role-dsx',
    name: 'DSx Members',
    position: 20,
    comparePositionTo: (other) => 20 - (other?.position ?? 0),
    members: new Map(),
  };
  roles.set(dsxRole.id, dsxRole);

  const staffRole = {
    id: 'role-staff',
    name: 'Staff',
    position: 30,
    comparePositionTo: (other) => 30 - (other?.position ?? 0),
    members: new Map(),
  };
  roles.set(staffRole.id, staffRole);

  const adminRole = {
    id: 'role-admin',
    name: 'AdminRole',
    position: 60, // Higher than bot
    comparePositionTo: (other) => 60 - (other?.position ?? 0),
    members: new Map(),
  };
  roles.set(adminRole.id, adminRole);

  const botMember = {
    id: 'bot-id',
    guildId,
    roles: {
      cache: new Map([[botRole.id, botRole]]),
      highest: botRole,
    },
    permissions: {
      has: (p) => options.botHasManageNicknames !== false,
    },
    user: { id: 'bot-id', username: 'MatchDistrictBot', bot: true },
  };
  members.set(botMember.id, botMember);

  const ownerMember = {
    id: 'owner-id',
    guildId,
    displayName: 'ServerOwner',
    nickname: 'ServerOwner',
    roles: {
      cache: new Map([[dsxRole.id, dsxRole]]),
      highest: { position: 100, comparePositionTo: () => 50 },
    },
    manageable: false,
    setNickname: async function(n) { this.nickname = n; this.displayName = n || 'ServerOwner'; },
    user: { id: 'owner-id', username: 'ServerOwner', bot: false },
  };
  members.set(ownerMember.id, ownerMember);
  dsxRole.members.set(ownerMember.id, ownerMember);

  const adminMember = {
    id: 'admin-id',
    guildId,
    displayName: 'AdminGuy',
    nickname: 'AdminGuy',
    roles: {
      cache: new Map([[adminRole.id, adminRole], [dsxRole.id, dsxRole]]),
      highest: adminRole,
    },
    manageable: false,
    permissions: {
      has: (p) => p === PermissionFlagsBits.Administrator || p === PermissionFlagsBits.ManageGuild,
    },
    setNickname: async function(n) { this.nickname = n; this.displayName = n || 'AdminGuy'; },
    user: { id: 'admin-id', username: 'AdminGuy', bot: false },
  };
  members.set(adminMember.id, adminMember);
  dsxRole.members.set(adminMember.id, adminMember);

  const player1 = {
    id: 'player-1',
    guildId,
    displayName: 'KOKAINE',
    nickname: 'KOKAINE',
    roles: {
      cache: new Map([[dsxRole.id, dsxRole]]),
      highest: dsxRole,
    },
    manageable: true,
    setNickname: async function(n) { this.nickname = n; this.displayName = n || 'KOKAINE'; },
    user: { id: 'player-1', username: 'KOKAINE', bot: false },
  };
  members.set(player1.id, player1);
  dsxRole.members.set(player1.id, player1);

  const player2 = {
    id: 'player-2',
    guildId,
    displayName: 'Player123',
    nickname: null,
    roles: {
      cache: new Map([[dsxRole.id, dsxRole]]),
      highest: dsxRole,
    },
    manageable: true,
    setNickname: async function(n) { this.nickname = n; this.displayName = n || 'Player123'; },
    user: { id: 'player-2', username: 'Player123', bot: false },
  };
  members.set(player2.id, player2);
  dsxRole.members.set(player2.id, player2);

  const player3 = {
    id: 'player-3',
    guildId,
    displayName: 'DSx IGxShanaya',
    nickname: 'DSx IGxShanaya',
    roles: {
      cache: new Map([[dsxRole.id, dsxRole]]),
      highest: dsxRole,
    },
    manageable: true,
    setNickname: async function(n) { this.nickname = n; this.displayName = n || 'IGxShanaya'; },
    user: { id: 'player-3', username: 'IGxShanaya', bot: false },
  };
  members.set(player3.id, player3);
  dsxRole.members.set(player3.id, player3);

  const guild = {
    id: guildId,
    name: options.guildName || 'Match District Esports',
    ownerId: ownerMember.id,
    roles: {
      cache: roles,
    },
    members: {
      cache: members,
      me: botMember,
      fetch: async () => members,
    },
  };

  // Cross-reference guild on members
  for (const m of members.values()) {
    m.guild = guild;
  }

  const channel = {
    id: 'ch-bot-commands',
    name: 'bot-commands',
    guild,
    send: async (msg) => msg,
  };

  return {
    guild,
    roles,
    members,
    botMember,
    adminMember,
    player1,
    player2,
    player3,
    ownerMember,
    channel,
    dsxRole,
    staffRole,
    adminRole,
    botRole,
  };
}

test('1. formatPrefixedNickname and stripManagedPrefix format correctly and observe 32-character limit', () => {
  assert.equal(formatPrefixedNickname('DSx', 'KOKAINE'), 'DSx KOKAINE');
  assert.equal(formatPrefixedNickname('DSx', 'Player123'), 'DSx Player123');
  assert.equal(formatPrefixedNickname('DSx', 'DSx IGxShanaya'), 'DSx IGxShanaya', 'Never double prefixes');

  // 32-character limit truncation
  const longName = 'VeryVeryLongUsernameThatExceedsThirtyTwoChars';
  const formatted = formatPrefixedNickname('DSx', longName);
  assert.ok(formatted.length <= 32, `Length should be <= 32, was ${formatted.length}`);
  assert.ok(formatted.startsWith('DSx '), 'Starts with prefix');

  // Stripping
  assert.equal(stripManagedPrefix('DSx KOKAINE', ['DSx']), 'KOKAINE');
  assert.equal(stripManagedPrefix('MD StaffMember', ['DSx', 'MD']), 'StaffMember');
  assert.equal(stripManagedPrefix('KOKAINE', ['DSx']), 'KOKAINE');
});

test('2. Permissions and Bot Capability Verification', () => {
  const { guild, adminMember, player1, botMember, ownerMember } = createMockEnvironment();

  // Admin check
  assert.equal(isRoleAdmin(adminMember, guild), true, 'Admin member should pass');
  assert.equal(isRoleAdmin(ownerMember, guild), true, 'Owner member should pass');
  assert.equal(isRoleAdmin(player1, guild), false, 'Regular member should fail');

  // Bot manage nicknames permission
  const botOk = canBotManageNicknames(guild);
  assert.equal(botOk.canManage, true);

  const { guild: noPermGuild } = createMockEnvironment({ botHasManageNicknames: false });
  const botFail = canBotManageNicknames(noPermGuild);
  assert.equal(botFail.canManage, false);

  // Manageability under hierarchy
  assert.equal(isMemberManageable(botMember, player1).manageable, true, 'Regular player should be manageable');
  assert.equal(isMemberManageable(botMember, ownerMember).manageable, false, 'Server owner cannot be managed');
  assert.equal(isMemberManageable(botMember, adminMember).manageable, false, 'Higher role cannot be managed');
});

test('3. Configure DSx for a role: Wizard flow with role selection and confirmation', async () => {
  clearRolePrefixMemoryCache();
  const env = createMockEnvironment();
  const { guild, adminMember, channel, roles } = env;

  let wizardReply = null;
  const replyFn = async (payload) => {
    wizardReply = payload;
    return payload;
  };

  // Step 1: Admin runs .role pre DSx
  await handleRoleCommand(guild, adminMember, channel, ['pre', 'DSx'], replyFn);
  assert.ok(wizardReply?.embeds?.length > 0, 'Embed prompt should be sent');
  assert.ok(wizardReply.embeds[0].data.description.includes('Which role should receive this prefix?'));

  // Extract session ID from select menu component
  const selectMenu = wizardReply.components[0].components[0];
  const selectMenuId = selectMenu.data.custom_id;
  const sessionId = selectMenuId.split(':')[2];
  assert.ok(sessionId, 'Session ID should be generated');

  // Step 2: Role selection interaction
  let confirmationPayload = null;
  const mockSelectInteraction = {
    customId: `role_pre:select_role:${sessionId}`,
    values: ['role-dsx'],
    guild,
    member: adminMember,
    channel,
    user: adminMember.user,
    update: async (payload) => {
      confirmationPayload = payload;
      return payload;
    },
    reply: async () => {},
  };

  const handledSelect = await handleRolePrefixInteraction(mockSelectInteraction);
  assert.equal(handledSelect, true);
  assert.ok(confirmationPayload?.embeds?.length > 0);
  assert.equal(confirmationPayload.embeds[0].data.title, 'Prefix Configuration');
  assert.ok(confirmationPayload.embeds[0].data.description.includes('Server:'));
  assert.ok(confirmationPayload.embeds[0].data.description.includes('Match District Esports'));
  assert.ok(confirmationPayload.embeds[0].data.description.includes('role-dsx'));
  assert.ok(confirmationPayload.embeds[0].data.description.includes('DSx'));

  // Step 3: Admin confirms configuration
  const confirmCustomId = confirmationPayload.components[0].components[0].data.custom_id;
  let finalEdit = null;
  const mockConfirmInteraction = {
    customId: confirmCustomId,
    guild,
    member: adminMember,
    user: adminMember.user,
    deferUpdate: async () => {},
    editReply: async (payload) => {
      finalEdit = payload;
      return payload;
    },
  };

  const handledConfirm = await handleRolePrefixInteraction(mockConfirmInteraction);
  assert.equal(handledConfirm, true);
  assert.ok(finalEdit?.embeds?.length > 0);
  assert.equal(finalEdit.embeds[0].data.title, 'Prefix Configuration Saved');

  // Verify stored in memory / MongoDB
  const saved = getGuildRolePrefixesFromCache(guild.id);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].prefix, 'DSx');
  assert.equal(saved[0].roleId, 'role-dsx');

  // Existing members verification:
  // player1 had "KOKAINE" -> should become "DSx KOKAINE"
  assert.equal(env.player1.nickname, 'DSx KOKAINE');
  // player2 had null -> should become "DSx Player123"
  assert.equal(env.player2.nickname, 'DSx Player123');
  // player3 had "DSx IGxShanaya" -> already prefixed, unchanged
  assert.equal(env.player3.nickname, 'DSx IGxShanaya');
  // owner and admin were skipped due to hierarchy
  assert.equal(env.ownerMember.nickname, 'ServerOwner');
  assert.equal(env.adminMember.nickname, 'AdminGuy');
});

test('4. Newly assigned role members receive DSx automatically via GuildMemberUpdate', async () => {
  clearRolePrefixMemoryCache();
  const env = createMockEnvironment();
  const { guild, dsxRole } = env;

  await saveRolePrefix({
    guildId: guild.id,
    roleId: dsxRole.id,
    roleName: dsxRole.name,
    prefix: 'DSx',
    rolePosition: 20,
  });

  const newPlayer = {
    id: 'new-player-4',
    guildId: guild.id,
    guild,
    displayName: 'ShadowHunter',
    nickname: 'ShadowHunter',
    roles: {
      cache: new Map([[dsxRole.id, dsxRole]]),
      highest: dsxRole,
    },
    manageable: true,
    setNickname: async function(n) { this.nickname = n; this.displayName = n || 'ShadowHunter'; },
    user: { id: 'new-player-4', username: 'ShadowHunter', bot: false },
  };

  const oldMember = {
    ...newPlayer,
    roles: { cache: new Map() }, // Didn't have the role before
  };

  await handleRolePrefixMemberUpdate(oldMember, newPlayer);
  assert.equal(newPlayer.nickname, 'DSx ShadowHunter', 'Newly added role member should automatically get prefix');
});

test('5. Removing the role removes only the managed prefix and preserves the rest of the nickname', async () => {
  clearRolePrefixMemoryCache();
  const env = createMockEnvironment();
  const { guild, dsxRole } = env;

  await saveRolePrefix({
    guildId: guild.id,
    roleId: dsxRole.id,
    roleName: dsxRole.name,
    prefix: 'DSx',
    rolePosition: 20,
  });

  const memberLosingRole = {
    id: 'leaving-player-5',
    guildId: guild.id,
    guild,
    displayName: 'DSx ProGamer',
    nickname: 'DSx ProGamer',
    roles: {
      cache: new Map(), // Role was removed
      highest: { position: 1 },
    },
    manageable: true,
    setNickname: async function(n) { this.nickname = n; this.displayName = n || 'ProGamer'; },
    user: { id: 'leaving-player-5', username: 'ProGamer', bot: false },
  };

  const oldMember = {
    ...memberLosingRole,
    roles: { cache: new Map([[dsxRole.id, dsxRole]]) },
  };

  await handleRolePrefixMemberUpdate(oldMember, memberLosingRole);
  assert.equal(memberLosingRole.nickname, 'ProGamer', 'Managed prefix should be stripped, leaving base nickname');
});

test('6. Member nickname changes preserve the configured prefix and prevent infinite update loops', async () => {
  clearRolePrefixMemoryCache();
  const env = createMockEnvironment();
  const { guild, dsxRole } = env;

  await saveRolePrefix({
    guildId: guild.id,
    roleId: dsxRole.id,
    roleName: dsxRole.name,
    prefix: 'DSx',
    rolePosition: 20,
  });

  let updateCalls = 0;
  const memberChangingNick = {
    id: 'changing-nick-player',
    guildId: guild.id,
    guild,
    displayName: 'NewCustomNick', // User changed nickname without prefix
    nickname: 'NewCustomNick',
    roles: {
      cache: new Map([[dsxRole.id, dsxRole]]),
      highest: dsxRole,
    },
    manageable: true,
    setNickname: async function(n) {
      updateCalls++;
      this.nickname = n;
      this.displayName = n;
    },
    user: { id: 'changing-nick-player', username: 'OriginalUsername', bot: false },
  };

  const oldMember = {
    ...memberChangingNick,
    displayName: 'DSx OldCustomNick',
    nickname: 'DSx OldCustomNick',
  };

  await handleRolePrefixMemberUpdate(oldMember, memberChangingNick);
  assert.equal(memberChangingNick.nickname, 'DSx NewCustomNick', 'Prefix must be preserved when user changes nickname');
  assert.equal(updateCalls, 1);

  // If another event arrives with the already-prefixed nickname, it should be a no-op
  const updatedOldMember = { ...memberChangingNick };
  await handleRolePrefixMemberUpdate(updatedOldMember, memberChangingNick);
  assert.equal(updateCalls, 1, 'Duplicate / infinite updates must be prevented');
});

test('7. Multiple role configurations with deterministic priority based on role hierarchy', async () => {
  clearRolePrefixMemoryCache();
  const env = createMockEnvironment();
  const { guild, dsxRole, staffRole } = env;

  // Configure DSx for dsxRole (position 20)
  await saveRolePrefix({
    guildId: guild.id,
    roleId: dsxRole.id,
    roleName: dsxRole.name,
    prefix: 'DSx',
    rolePosition: 20,
  });

  // Configure MD for staffRole (position 30 - higher than dsxRole)
  await saveRolePrefix({
    guildId: guild.id,
    roleId: staffRole.id,
    roleName: staffRole.name,
    prefix: 'MD',
    rolePosition: 30,
  });

  const configs = getGuildRolePrefixesFromCache(guild.id);
  assert.equal(configs.length, 2);

  // Member has BOTH roles: staffRole (position 30) should win over dsxRole (position 20)
  const dualRoleMember = {
    id: 'dual-role-player',
    guildId: guild.id,
    guild,
    displayName: 'DualMember',
    nickname: 'DualMember',
    roles: {
      cache: new Map([[dsxRole.id, dsxRole], [staffRole.id, staffRole]]),
      highest: staffRole,
    },
    manageable: true,
    setNickname: async function(n) { this.nickname = n; this.displayName = n; },
    user: { id: 'dual-role-player', username: 'DualMember', bot: false },
  };

  const target = computeTargetNickname(dualRoleMember, configs);
  assert.equal(target, 'MD DualMember', 'Higher role prefix (MD) should take precedence');

  // When staffRole is removed and member only has dsxRole, prefix smoothly transitions to DSx
  dualRoleMember.roles.cache.delete(staffRole.id);
  dualRoleMember.displayName = 'MD DualMember';
  dualRoleMember.nickname = 'MD DualMember';

  const newTarget = computeTargetNickname(dualRoleMember, configs);
  assert.equal(newTarget, 'DSx DualMember', 'Prefix should transition to lower role without stacking prefixes');
});

test('8. Different servers maintain independent configurations', async () => {
  clearRolePrefixMemoryCache();

  // Guild 1
  await saveRolePrefix({
    guildId: 'guild-server-1',
    roleId: 'role-1',
    prefix: 'G1',
    rolePosition: 10,
  });

  // Guild 2
  await saveRolePrefix({
    guildId: 'guild-server-2',
    roleId: 'role-2',
    prefix: 'G2',
    rolePosition: 10,
  });

  const g1Configs = getGuildRolePrefixesFromCache('guild-server-1');
  const g2Configs = getGuildRolePrefixesFromCache('guild-server-2');

  assert.equal(g1Configs.length, 1);
  assert.equal(g1Configs[0].prefix, 'G1');

  assert.equal(g2Configs.length, 1);
  assert.equal(g2Configs[0].prefix, 'G2');
});

test('9. .role pre list and .role pre remove commands', async () => {
  clearRolePrefixMemoryCache();
  const env = createMockEnvironment();
  const { guild, adminMember, channel, dsxRole } = env;

  await saveRolePrefix({
    guildId: guild.id,
    roleId: dsxRole.id,
    roleName: dsxRole.name,
    prefix: 'DSx',
    rolePosition: 20,
  });

  // Test .role pre list
  let listReply = null;
  await handleRoleCommand(guild, adminMember, channel, ['pre', 'list'], async (payload) => {
    listReply = payload;
    return payload;
  });
  assert.ok(listReply?.embeds?.length > 0);
  assert.ok(listReply.embeds[0].data.description.includes('Prefix: `DSx`'));

  // Test .role pre remove with role mention
  let removeReply = null;
  await handleRoleCommand(guild, adminMember, channel, ['pre', 'remove', `<@&${dsxRole.id}>`], async (payload) => {
    removeReply = payload;
    return payload;
  });
  assert.ok(removeReply.includes('Role Prefix Removed'));

  // Verify removed from cache
  const afterRemove = getGuildRolePrefixesFromCache(guild.id);
  assert.equal(afterRemove.length, 0);
});

test('10. .role pre refresh command reapplies prefixes', async () => {
  clearRolePrefixMemoryCache();
  const env = createMockEnvironment();
  const { guild, adminMember, channel, dsxRole, player1 } = env;

  await saveRolePrefix({
    guildId: guild.id,
    roleId: dsxRole.id,
    roleName: dsxRole.name,
    prefix: 'DSx',
    rolePosition: 20,
  });

  // Temporarily reset player1's nickname
  player1.nickname = 'KOKAINE';
  player1.displayName = 'KOKAINE';

  let refreshReply = null;
  await handleRoleCommand(guild, adminMember, channel, ['pre', 'refresh'], async (payload) => {
    refreshReply = payload;
    return payload;
  });

  assert.ok(refreshReply.includes('Role Prefix Refresh Completed!'));
  assert.equal(player1.nickname, 'DSx KOKAINE', 'player1 nickname should be refreshed to prefixed version');
});
