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

test('1. COMMAND_DIRECTORY includes all 8 categories and valid syntax/descriptions', () => {
  const allCategories = Object.values(COMMAND_CATEGORIES);
  assert.equal(allCategories.length, 8);

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

test('2. Permission-based category visibility: Regular members vs Administrators', () => {
  // Regular member categories
  const regularCategories = getHelpCategories({ isAdmin: false });
  assert.ok(regularCategories.includes(COMMAND_CATEGORIES.GENERAL), 'Regular member sees General');
  assert.ok(regularCategories.includes(COMMAND_CATEGORIES.ROOM_MAKER), 'Regular member sees Room Maker');
  assert.ok(regularCategories.includes(COMMAND_CATEGORIES.UTILITY), 'Regular member sees Utility');
  assert.ok(!regularCategories.includes(COMMAND_CATEGORIES.ADMINISTRATION), 'Regular member must NOT see Administration');
  assert.ok(!regularCategories.includes(COMMAND_CATEGORIES.MODERATION), 'Regular member must NOT see Moderation');
  assert.ok(!regularCategories.includes(COMMAND_CATEGORIES.CONFIGURATION), 'Regular member must NOT see Configuration');

  // Admin categories: sees all categories containing commands
  const adminCategories = getHelpCategories({ isAdmin: true });
  assert.equal(adminCategories.length, 8, 'Administrator must see all 8 categories');
  for (const cat of Object.values(COMMAND_CATEGORIES)) {
    assert.ok(adminCategories.includes(cat), `Admin must see ${cat}`);
  }
});

test('3. buildHelpEmbed applies correct styling, orange accent #F97316 and category structure', () => {
  const embed = buildHelpEmbed({ prefix: '.', isAdmin: true, pageIndex: 0 });
  assert.equal(embed.data.color, HELP_ACCENT_COLOR, 'Must use #F97316 accent color');
  assert.ok(embed.data.title.includes('MatchDistrict Bot Commands'));
  assert.ok(embed.data.fields.length > 0, 'Must contain category fields');

  // Verify mobile friendly layout: fields have inline: false
  for (const field of embed.data.fields) {
    assert.equal(field.inline, false);
    assert.ok(field.value.length <= 1024, 'Field value must never exceed 1024 characters');
  }
});

test('4. .help execution for regular member: shows only accessible commands', async () => {
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
  assert.ok(fieldNames.some((n) => n.includes('Room Maker Commands')));
  assert.ok(fieldNames.some((n) => n.includes('Utility Commands')));

  // Check admin categories absent
  assert.ok(!fieldNames.some((n) => n.includes('Administration Commands')));
  assert.ok(!fieldNames.some((n) => n.includes('Configuration Commands')));
});

test('5. .help execution for administrator: shows all categories and pagination', async () => {
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
  assert.ok(optionCount > 0, 'Select menu must have options');

  const buttonRow = sentPayload.components[1];
  assert.equal(buttonRow.components[0].data.label, 'Previous');
  assert.equal(buttonRow.components[1].data.label, 'Next');
});

test('6. .help <category> filters directly to requested category', async () => {
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
  assert.ok(embed.data.title.includes('1V1 TDM Commands'));

  const fieldNames = embed.data.fields.map((f) => f.name);
  assert.ok(fieldNames.some((n) => n.includes('1V1 TDM Commands')));
  const fieldValues = embed.data.fields.map((f) => f.value).join('\n');
  assert.ok(fieldValues.includes('.arena setup'));
  assert.ok(fieldValues.includes('.arena active'));
});

test('7. Interactive button pagination survives restart via stateless customIds', async () => {
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

test('8. Interactive select menu category filter works via stateless customIds', async () => {
  const env = createMockEnvironment();

  let updatedPayload = null;
  const mockSelectInteraction = {
    customId: 'help:cat:1:0', // admin=1, page=0
    values: [COMMAND_CATEGORIES.MODERATION],
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
  assert.ok(updatedPayload.embeds[0].data.title.includes('Moderation Commands'));
});

test('9. Backwards compatibility of getHelpResponse for string checks in other tests', () => {
  const helpStr = getHelpResponse('.');
  assert.equal(typeof helpStr, 'string');
  assert.ok(helpStr.includes('.remove threads'));
  assert.ok(helpStr.includes('Disable thread creation permissions in this channel'));
  assert.ok(helpStr.includes('.role pre'));
  assert.ok(helpStr.includes('.arena setup'));
  assert.ok(helpStr.includes('.roommaker profile'));

  // Test regex match support
  assert.match(helpStr, /\.remove threads/);
  assert.match(helpStr, /Disable thread creation permissions in this channel/);
});
