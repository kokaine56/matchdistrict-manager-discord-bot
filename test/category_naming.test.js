import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTournamentCategoryName,
  sanitizeCategoryName,
  syncTournamentDiscordChannels,
  REQUIRED_TOURNAMENT_CHANNELS,
} from '../tournamentService.js';
import { ChannelType } from 'discord.js';

describe('Discord Tournament Category Naming Requirements', () => {
  test('1. Dynamic Category Naming: Formats as 🏆 | <Tournament Name> without hardcoding', () => {
    assert.equal(buildTournamentCategoryName('District League 2026'), '🏆 | District League 2026');
    assert.equal(buildTournamentCategoryName('BGMI Championship'), '🏆 | BGMI Championship');
    assert.equal(buildTournamentCategoryName('Winter Showdown'), '🏆 | Winter Showdown');
    assert.equal(buildTournamentCategoryName('Apex Legends Masters 2026'), '🏆 | Apex Legends Masters 2026');
    // Fallback if missing
    assert.equal(buildTournamentCategoryName(''), '🏆 | Tournament');
    assert.equal(buildTournamentCategoryName(null), '🏆 | Tournament');
    // Avoid double trophy prefix
    assert.equal(buildTournamentCategoryName('🏆 | District League 2026'), '🏆 | District League 2026');
  });

  test('2. Single Parent Category: syncTournamentDiscordChannels creates single category 🏆 | <Name> and houses all channels', async () => {
    const guildId = 'guild-cat-test-1';
    const tourId = 'tour-cat-1';
    const tournament = { id: tourId, title: 'District League 2026' };

    const mockChannelsCache = new Map();
    const createdChannels = [];

    const mockBotMember = {
      id: 'bot-123',
      permissions: { has: () => true },
    };

    const mockGuild = {
      id: guildId,
      channels: {
        cache: mockChannelsCache,
        create: async (options) => {
          const ch = {
            id: `ch-created-${createdChannels.length + 1}`,
            name: options.name,
            type: options.type,
            parentId: options.parent || null,
            parent: options.parent ? mockChannelsCache.get(options.parent) : null,
            guildId,
            permissionOverwrites: {
              set: async () => {},
            },
            setParent: async (parentId) => {
              ch.parentId = parentId;
            },
            setName: async (name) => {
              ch.name = name;
            },
            setUserLimit: async () => {},
            send: async () => ({ id: 'msg-1', pin: async () => {} }),
          };
          createdChannels.push(ch);
          mockChannelsCache.set(ch.id, ch);
          return ch;
        },
        fetch: async (id) => mockChannelsCache.get(id) || null,
      },
      roles: {
        cache: new Map([
          ['role-everyone', { id: 'role-everyone', name: '@everyone' }],
        ]),
        everyone: { id: 'role-everyone' },
        create: async (opts) => ({ id: `role-${Date.now()}`, name: opts.name }),
        fetch: async () => null,
      },
      members: {
        me: mockBotMember,
        fetch: async () => mockBotMember,
      },
    };

    const result = await syncTournamentDiscordChannels(mockGuild, tournament, [], mockBotMember);

    // Verify exactly one category was created
    const categoriesCreated = createdChannels.filter((c) => c.type === ChannelType.GuildCategory);
    assert.equal(categoriesCreated.length, 1);
    assert.equal(categoriesCreated[0].name, '🏆 | District League 2026');

    // Verify NO generic categories like "DL INFO" or "DL MANAGEMENT" were created
    for (const cat of categoriesCreated) {
      assert.notEqual(cat.name, 'DL INFO');
      assert.notEqual(cat.name, 'DL MANAGEMENT');
      assert.ok(!cat.name.endsWith('INFO'));
      assert.ok(!cat.name.endsWith('MANAGEMENT'));
    }

    // Verify all text channels and voice channel are parented directly under this single category
    const parentCategory = categoriesCreated[0];
    const nonCategoryChannels = createdChannels.filter((c) => c.type !== ChannelType.GuildCategory);
    assert.ok(nonCategoryChannels.length > 0);

    for (const channel of nonCategoryChannels) {
      assert.equal(
        channel.parentId,
        parentCategory.id,
        `Expected channel ${channel.name} to have parent ${parentCategory.id}, but got ${channel.parentId}`
      );
    }
  });

  test('3. Category Reuse & Rename: Existing category named "DL INFO" is reused and renamed to 🏆 | District League 2026', async () => {
    const guildId = 'guild-cat-test-2';
    const tourId = 'tour-cat-2';
    const tournament = { id: tourId, title: 'District League 2026' };

    const mockChannelsCache = new Map();
    const createdChannels = [];

    const mockExistingCategory = {
      id: 'cat-old-info',
      name: 'DL INFO',
      type: ChannelType.GuildCategory,
      guildId,
      permissionOverwrites: { set: async () => {} },
      setName: async (name) => {
        mockExistingCategory.name = name;
      },
    };
    mockChannelsCache.set('cat-old-info', mockExistingCategory);

    const mockBotMember = {
      id: 'bot-123',
      permissions: { has: () => true },
    };

    const mockGuild = {
      id: guildId,
      channels: {
        cache: mockChannelsCache,
        create: async (options) => {
          const ch = {
            id: `ch-created-${createdChannels.length + 1}`,
            name: options.name,
            type: options.type,
            parentId: options.parent || null,
            guildId,
            permissionOverwrites: { set: async () => {} },
            setParent: async (parentId) => { ch.parentId = parentId; },
            setName: async (name) => { ch.name = name; },
            setUserLimit: async () => {},
            send: async () => ({ id: 'msg-1', pin: async () => {} }),
          };
          createdChannels.push(ch);
          mockChannelsCache.set(ch.id, ch);
          return ch;
        },
        fetch: async (id) => mockChannelsCache.get(id) || null,
      },
      roles: {
        cache: new Map([
          ['role-everyone', { id: 'role-everyone', name: '@everyone' }],
        ]),
        everyone: { id: 'role-everyone' },
        create: async (opts) => ({ id: `role-${Date.now()}`, name: opts.name }),
        fetch: async () => null,
      },
      members: {
        me: mockBotMember,
        fetch: async () => mockBotMember,
      },
    };

    const result = await syncTournamentDiscordChannels(mockGuild, tournament, [], mockBotMember);

    // Verify existing category was reused and renamed to "🏆 | District League 2026"
    assert.equal(result.categoryAction, 'reused');
    assert.equal(mockExistingCategory.name, '🏆 | District League 2026');

    // Verify NO new categories were created
    const newCategories = createdChannels.filter((c) => c.type === ChannelType.GuildCategory);
    assert.equal(newCategories.length, 0);

    // Verify all created channels belong directly to the reused category
    for (const channel of createdChannels) {
      assert.equal(channel.parentId, mockExistingCategory.id);
    }
  });

  test('4. Dynamic Naming for different tournament titles: "BGMI Championship" and "Winter Showdown"', async () => {
    const titles = ['BGMI Championship', 'Winter Showdown'];

    for (const title of titles) {
      const guildId = `guild-${title}`;
      const mockChannelsCache = new Map();
      const createdChannels = [];
      const mockBotMember = { id: 'bot-123', permissions: { has: () => true } };

      const mockGuild = {
        id: guildId,
        channels: {
          cache: mockChannelsCache,
          create: async (options) => {
            const ch = {
              id: `ch-${createdChannels.length + 1}`,
              name: options.name,
              type: options.type,
              parentId: options.parent || null,
              guildId,
              permissionOverwrites: { set: async () => {} },
              setParent: async (parentId) => { ch.parentId = parentId; },
              setName: async (name) => { ch.name = name; },
              setUserLimit: async () => {},
              send: async () => ({ id: 'msg-1', pin: async () => {} }),
            };
            createdChannels.push(ch);
            mockChannelsCache.set(ch.id, ch);
            return ch;
          },
          fetch: async (id) => mockChannelsCache.get(id) || null,
        },
        roles: {
          cache: new Map([['role-everyone', { id: 'role-everyone', name: '@everyone' }]]),
          everyone: { id: 'role-everyone' },
          create: async (opts) => ({ id: `role-${Date.now()}`, name: opts.name }),
          fetch: async () => null,
        },
        members: { me: mockBotMember, fetch: async () => mockBotMember },
      };

      await syncTournamentDiscordChannels(mockGuild, { id: `tour-${title}`, title }, [], mockBotMember);

      const category = createdChannels.find((c) => c.type === ChannelType.GuildCategory);
      assert.ok(category, `Category should be created for ${title}`);
      assert.equal(category.name, `🏆 | ${title}`);
    }
  });
});

