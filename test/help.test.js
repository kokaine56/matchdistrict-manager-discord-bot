import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import {
  HELP_ACCENT_COLOR,
  COMMAND_CATEGORIES,
  COMMAND_DIRECTORY,
  getHelpCategories,
  getCommandsByCategory,
  getHelpPageGroups,
  buildHelpEmbed,
  buildHelpComponents,
  buildHelpText,
  getHelpResponse,
  resolveCategoryFromInput,
  handleHelpCommand,
  handleHelpInteraction,
} from '../helpService.js';

function createMockEnvironment(options = {}) {
  const guildId = 'guild-help-1';
  const roles = new Map();
  const members = new Map();

  const regularMember = {
    id: 'user-regular',
    guildId,
    displayName: 'PlayerOne',
    permissions: {
      has: () => false,
    },
    user: { id: 'user-regular', username: 'PlayerOne', bot: false },
  };
  members.set(regularMember.id, regularMember);

  const adminMember = {
    id: 'user-admin',
    guildId,
    displayName: 'AdminBoss',
    permissions: {
      has: (p) => p === PermissionFlagsBits.Administrator || p === PermissionFlagsBits.ManageGuild || p === 'Administrator' || p === 'ManageGuild',
    },
    user: { id: 'user-admin', username: 'AdminBoss', bot: false },
  };
  members.set(adminMember.id, adminMember);

  const guild = {
    id: guildId,
    name: 'Match District Community',
    ownerId: 'owner-id',
    roles: { cache: roles },
    members: { cache: members },
  };

  regularMember.guild = guild;
  adminMember.guild = guild;

  const channel = {
    id: 'ch-general',
    name: 'general',
    guild,
    send: async (msg) => msg,
  };

  return { guild, regularMember, adminMember, channel };
}

test('1. COMMAND_DIRECTORY includes all 10 categories and valid syntax/descriptions', () => {
  const allCategories = Object.values(COMMAND_CATEGORIES);
  assert.equal(allCategories.length, 10, 'Must have exactly 10 categories');

  // Verify all 10 specific categories exist
  assert.equal(COMMAND_CATEGORIES.GENERAL, 'General Commands');
  assert.equal(COMMAND_CATEGORIES.TOURNAMENT, 'Tournament Management');
  assert.equal(COMMAND_CATEGORIES.REGISTRATION_VERIFICATION, 'Registration & Verification');
  assert.equal(COMMAND_CATEGORIES.TEAM_MANAGEMENT, 'Team Management');
  assert.equal(COMMAND_CATEGORIES.ROUND_MANAGEMENT, 'Round Management');
  assert.equal(COMMAND_CATEGORIES.ORGANISER, 'Organiser Commands');
  assert.equal(COMMAND_CATEGORIES.TDM, '1V1 TDM Arena');
  assert.equal(COMMAND_CATEGORIES.INVITE_EARN, 'Invite & Earn');
  assert.equal(COMMAND_CATEGORIES.ROLE_SERVER, 'Role & Server Management');
  assert.equal(COMMAND_CATEGORIES.ADMIN_UTILITY, 'Admin & Utility Commands');

  const foundCategories = new Set(COMMAND_DIRECTORY.map((c) => c.category));
  for (const cat of allCategories) {
    assert.ok(foundCategories.has(cat), `Category "${cat}" must have registered commands`);
  }

  for (const cmd of COMMAND_DIRECTORY) {
    assert.ok(cmd.name, 'Command must have a name');
    assert.ok(cmd.description, `Command ${cmd.name} must have a description`);
    assert.ok(typeof cmd.syntax === 'function', `Command ${cmd.name} must have a syntax function`);
    const syntaxStr = cmd.syntax('.');
    assert.ok(syntaxStr.startsWith('.'), `Syntax for ${cmd.name} must start with prefix`);
  }
});

test('2. Includes newly added .add role command with Manage Roles permission badge', () => {
  const addRoleCmd = COMMAND_DIRECTORY.find((c) => c.name === 'add role');
  assert.ok(addRoleCmd, 'COMMAND_DIRECTORY must include ".add role"');
  assert.equal(addRoleCmd.category, COMMAND_CATEGORIES.ROLE_SERVER);
  assert.equal(addRoleCmd.adminOnly, true);
  assert.equal(addRoleCmd.permission, 'Admin / Manage Roles');
  assert.ok(addRoleCmd.syntax('.').includes('.add role'));
  const aliases = addRoleCmd.aliases('.');
  assert.ok(aliases.includes('.role add'));
  assert.ok(aliases.includes('.role bulk'));
});

test('3. Permission-based category visibility: Regular members vs Administrators', () => {
  // Regular member categories: General, 1V1 TDM Arena, Invite & Earn
  const regularCategories = getHelpCategories({ isAdmin: false });
  assert.ok(regularCategories.includes(COMMAND_CATEGORIES.GENERAL), 'Regular member sees General');
  assert.ok(regularCategories.includes(COMMAND_CATEGORIES.TDM), 'Regular member sees 1V1 TDM Arena');
  assert.ok(regularCategories.includes(COMMAND_CATEGORIES.INVITE_EARN), 'Regular member sees Invite & Earn');

  assert.ok(!regularCategories.includes(COMMAND_CATEGORIES.TOURNAMENT), 'Regular member must NOT see Tournament Management');
  assert.ok(!regularCategories.includes(COMMAND_CATEGORIES.REGISTRATION_VERIFICATION), 'Regular member must NOT see Registration & Verification');
  assert.ok(!regularCategories.includes(COMMAND_CATEGORIES.TEAM_MANAGEMENT), 'Regular member must NOT see Team Management');
  assert.ok(!regularCategories.includes(COMMAND_CATEGORIES.ROUND_MANAGEMENT), 'Regular member must NOT see Round Management');
  assert.ok(!regularCategories.includes(COMMAND_CATEGORIES.ORGANISER), 'Regular member must NOT see Organiser Commands');
  assert.ok(!regularCategories.includes(COMMAND_CATEGORIES.ROLE_SERVER), 'Regular member must NOT see Role & Server Management');
  assert.ok(!regularCategories.includes(COMMAND_CATEGORIES.ADMIN_UTILITY), 'Regular member must NOT see Admin & Utility Commands');

  // Admin categories: sees all 10 categories
  const adminCategories = getHelpCategories({ isAdmin: true });
  assert.equal(adminCategories.length, 10, 'Administrator must see all 10 categories');
  for (const cat of Object.values(COMMAND_CATEGORIES)) {
    assert.ok(adminCategories.includes(cat), `Admin must see ${cat}`);
  }
});

test('4. buildHelpEmbed applies correct styling, orange accent #F97316 and category structure', () => {
  const embed = buildHelpEmbed({ prefix: '.', isAdmin: true, pageIndex: 0 });
  assert.equal(embed.data.color, HELP_ACCENT_COLOR, 'Must use #F97316 accent color');
  assert.ok(embed.data.title.includes('MatchDistrict Bot Commands'));
  assert.ok(embed.data.fields.length > 0, 'Must contain category fields');

  // Verify mobile-friendly layout: fields have inline: false
  for (const field of embed.data.fields) {
    assert.equal(field.inline, false);
    assert.ok(field.value.length <= 1024, 'Field value must never exceed 1024 characters');
  }
});

test('5. .help execution for regular member: shows only accessible commands', async () => {
  const { guild, regularMember, channel } = createMockEnvironment();

  let sentPayload = null;
  const replyFn = async (payload) => {
    sentPayload = payload;
    return payload;
  };

  await handleHelpCommand(guild, regularMember, channel, [], replyFn, '.');
  assert.ok(sentPayload);
  assert.ok(sentPayload.embeds?.length > 0);

  const embed = sentPayload.embeds[0];
  const fieldNames = embed.data.fields.map((f) => f.name);

  // Check categories present in embed
  assert.ok(fieldNames.some((n) => n.includes('General Commands')));
  assert.ok(fieldNames.some((n) => n.includes('1V1 TDM Arena')));
  assert.ok(fieldNames.some((n) => n.includes('Invite & Earn')));

  // Check admin categories absent
  assert.ok(!fieldNames.some((n) => n.includes('Tournament Management')));
  assert.ok(!fieldNames.some((n) => n.includes('Role & Server Management')));
  assert.ok(!fieldNames.some((n) => n.includes('Admin & Utility Commands')));
});

test('6. .help execution for administrator: shows all categories, select menu and pagination', async () => {
  const { guild, adminMember, channel } = createMockEnvironment();

  let sentPayload = null;
  const replyFn = async (payload) => {
    sentPayload = payload;
    return payload;
  };

  await handleHelpCommand(guild, adminMember, channel, [], replyFn, '.');
  assert.ok(sentPayload);
  assert.ok(sentPayload.embeds?.length > 0);

  // Check component rows: Category Select Menu + Pagination Buttons
  assert.ok(sentPayload.components?.length >= 2, 'Admin should have category select menu and pagination buttons');
  const selectMenuRow = sentPayload.components[0];
  const selectMenu = selectMenuRow.components[0];
  const optionCount = selectMenu.options?.length ?? selectMenu.data?.options?.length ?? 0;
  assert.ok(optionCount >= 11, 'Select menu must have overview + 10 categories');

  const buttonRow = sentPayload.components[1];
  assert.equal(buttonRow.components[0].data.label, 'Previous');
  assert.ok(buttonRow.components[1].data.label.includes('Page 1 / 3'));
  assert.equal(buttonRow.components[2].data.label, 'Next');
});

test('7. .help <category> filters directly to requested category with category navigation buttons', async () => {
  const { guild, adminMember, channel } = createMockEnvironment();

  let sentPayload = null;
  const replyFn = async (payload) => {
    sentPayload = payload;
    return payload;
  };

  // Run .help tdm
  await handleHelpCommand(guild, adminMember, channel, ['tdm'], replyFn, '.');
  assert.ok(sentPayload?.embeds?.length > 0);

  const embed = sentPayload.embeds[0];
  assert.ok(embed.data.title.includes('1V1 TDM Arena'));

  const fieldNames = embed.data.fields.map((f) => f.name);
  assert.ok(fieldNames.some((n) => n.includes('1V1 TDM Arena')));
  const fieldValues = embed.data.fields.map((f) => f.value).join('\n');
  assert.ok(fieldValues.includes('.arena setup'));
  assert.ok(fieldValues.includes('.arena active'));

  // Check category navigation buttons
  assert.ok(sentPayload.components?.length >= 2);
  const buttonRow = sentPayload.components[1];
  assert.equal(buttonRow.components[0].data.label, 'Prev Category');
  assert.ok(buttonRow.components[1].data.label.includes('/ 10'));
  assert.equal(buttonRow.components[2].data.label, 'Next Category');
  assert.equal(buttonRow.components[3].data.label, 'All Categories');
});

test('8. Interactive button pagination survives restart via stateless customIds', async () => {
  const env = createMockEnvironment();

  // Next page interaction from page 0 to page 1 for admin
  let updatedPayload = null;
  const mockButtonInteraction = {
    customId: 'help:p:1:1', // page 1, admin=1
    guild: env.guild,
    member: env.adminMember,
    update: async (payload) => {
      updatedPayload = payload;
      return payload;
    },
  };

  const handled = await handleHelpInteraction(mockButtonInteraction, '.');
  assert.equal(handled, true);
  assert.ok(updatedPayload?.embeds?.length > 0);
  assert.ok(updatedPayload.embeds[0].data.title.includes('(2/3)'));
});

test('9. Interactive select menu category filter works via stateless customIds', async () => {
  const env = createMockEnvironment();

  let updatedPayload = null;
  const mockSelectInteraction = {
    customId: 'help:cat:1:0', // admin=1, page=0
    values: [COMMAND_CATEGORIES.ROLE_SERVER],
    guild: env.guild,
    member: env.adminMember,
    update: async (payload) => {
      updatedPayload = payload;
      return payload;
    },
  };

  const handled = await handleHelpInteraction(mockSelectInteraction, '.');
  assert.equal(handled, true);
  assert.ok(updatedPayload?.embeds?.length > 0);
  assert.ok(updatedPayload.embeds[0].data.title.includes('Role & Server Management'));
});

test('10. Interactive category navigation button (help:cnav) switches categories seamlessly', async () => {
  const env = createMockEnvironment();

  let updatedPayload = null;
  const mockCnavInteraction = {
    customId: 'help:cnav:1:4', // target category index 4 (Round Management)
    guild: env.guild,
    member: env.adminMember,
    update: async (payload) => {
      updatedPayload = payload;
      return payload;
    },
  };

  const handled = await handleHelpInteraction(mockCnavInteraction, '.');
  assert.equal(handled, true);
  assert.ok(updatedPayload?.embeds?.length > 0);
  assert.ok(updatedPayload.embeds[0].data.title.includes('Round Management'));
});

test('11. resolveCategoryFromInput resolves all 10 categories correctly', () => {
  assert.equal(resolveCategoryFromInput('general'), COMMAND_CATEGORIES.GENERAL);
  assert.equal(resolveCategoryFromInput('tourn'), COMMAND_CATEGORIES.TOURNAMENT);
  assert.equal(resolveCategoryFromInput('verify'), COMMAND_CATEGORIES.REGISTRATION_VERIFICATION);
  assert.equal(resolveCategoryFromInput('team'), COMMAND_CATEGORIES.TEAM_MANAGEMENT);
  assert.equal(resolveCategoryFromInput('round'), COMMAND_CATEGORIES.ROUND_MANAGEMENT);
  assert.equal(resolveCategoryFromInput('org'), COMMAND_CATEGORIES.ORGANISER);
  assert.equal(resolveCategoryFromInput('tdm'), COMMAND_CATEGORIES.TDM);
  assert.equal(resolveCategoryFromInput('invite'), COMMAND_CATEGORIES.INVITE_EARN);
  assert.equal(resolveCategoryFromInput('role'), COMMAND_CATEGORIES.ROLE_SERVER);
  assert.equal(resolveCategoryFromInput('admin'), COMMAND_CATEGORIES.ADMIN_UTILITY);
});

test('12. Dynamic command exclusion: disabled or unavailable commands are filtered out', () => {
  const testCmd = {
    name: 'test-disabled-cmd',
    category: COMMAND_CATEGORIES.GENERAL,
    syntax: (p) => `${p}testdisabled`,
    description: 'Temporary disabled command',
    aliases: () => [],
    adminOnly: false,
    permission: null,
    disabled: true,
  };

  COMMAND_DIRECTORY.push(testCmd);
  try {
    const activeGeneralCmds = getCommandsByCategory(COMMAND_CATEGORIES.GENERAL, { isAdmin: true });
    assert.ok(!activeGeneralCmds.some((c) => c.name === 'test-disabled-cmd'), 'Disabled command must be excluded');
  } finally {
    const idx = COMMAND_DIRECTORY.indexOf(testCmd);
    if (idx !== -1) COMMAND_DIRECTORY.splice(idx, 1);
  }
});

test('13. Backwards compatibility of getHelpResponse for string checks in other tests', () => {
  const helpStr = getHelpResponse('.');
  assert.equal(typeof helpStr, 'string');
  assert.ok(helpStr.includes('.remove threads'));
  assert.ok(helpStr.includes('Disable thread creation permissions in this channel'));
  assert.ok(helpStr.includes('.role pre'));
  assert.ok(helpStr.includes('.arena setup'));
  assert.ok(helpStr.includes('.roommaker profile'));
  assert.ok(helpStr.includes('.add role'));

  // Test regex match support
  assert.match(helpStr, /\.remove threads/);
  assert.match(helpStr, /Disable thread creation permissions in this channel/);
});
