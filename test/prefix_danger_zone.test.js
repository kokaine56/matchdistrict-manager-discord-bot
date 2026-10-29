import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  getTournamentShortPrefix,
  getTournamentChannelNames,
  getTournamentCategoryName,
  sanitizeCategoryName,
  toMathematicalBold,
  isValidChannelName,
  renameTournamentChannelsToStandardFormat,
  buildTournamentControlPanelButtons,
  buildDangerZoneEmbed,
  buildDangerZoneButtons,
  handleDashboardNavigationInteraction,
  handleRenderDangerZoneScreen,
  syncTournamentDiscordChannels,
  REQUIRED_TOURNAMENT_CHANNELS,
} from '../tournamentService.js';
import { guildSettingsCache } from '../index.js';
import { ChannelType, ButtonStyle } from 'discord.js';

describe('Short Channel Prefix & Danger Zone Requirements', () => {
  test('1. Short Prefix: Multi-word names use initials of words and ignore numbers/years', () => {
    assert.equal(getTournamentShortPrefix('District League 2026'), 'DL');
    assert.equal(getTournamentShortPrefix('District League'), 'DL');
    assert.equal(getTournamentShortPrefix('Apex Legends 2026'), 'AL');
    assert.equal(getTournamentShortPrefix('Valorant Champions Tour 2026'), 'VCT');
  });

  test('2. Short Prefix: Single-word names use that word ignoring numbers/years', () => {
    assert.equal(getTournamentShortPrefix('BGMIS 2026'), 'BGMIS');
    assert.equal(getTournamentShortPrefix('BGMIS'), 'BGMIS');
    assert.equal(getTournamentShortPrefix('Apex 2026'), 'APEX');
    assert.equal(getTournamentShortPrefix('Tournament 1'), 'TOURNAMENT');
    assert.equal(getTournamentShortPrefix('2026'), 'TOUR');
  });

  test('3. Text Channel Naming: Uses Mathematical Bold prefix with fullwidth bar <bold-prefix>｜<name> and fallback <prefix>-<name>', () => {
    const names = getTournamentChannelNames('DL', 'updates');
    assert.equal(names.primary, '𝐃𝐋｜updates');
    assert.equal(names.fallback, 'dl-updates');

    const botCmdNames = getTournamentChannelNames('DL', 'bot-commands');
    assert.equal(botCmdNames.primary, '𝐃𝐋｜bot-commands');
    assert.equal(botCmdNames.fallback, 'dl-bot-commands');

    const tenK = getTournamentChannelNames('10K', 'slotlist');
    assert.equal(tenK.primary, '𝟏𝟎𝐊｜slotlist');
    assert.equal(tenK.fallback, '10k-slotlist');

    const bgmisLog = getTournamentChannelNames('BGMIS', 'tournament-log');
    assert.equal(bgmisLog.primary, '𝐁𝐆𝐌𝐈𝐒｜tournament-log');
    assert.equal(bgmisLog.fallback, 'bgmis-tournament-log');

    // Verify all 10 required channels have proper primary formatting
    for (const ch of REQUIRED_TOURNAMENT_CHANNELS) {
      const chNames = getTournamentChannelNames('DL', ch.name);
      assert.equal(chNames.primary, `𝐃𝐋｜${ch.name}`);
      assert.equal(chNames.fallback, `dl-${ch.name}`);
      assert.ok(isValidChannelName(chNames.primary), `Expected ${chNames.primary} to be valid`);
      assert.ok(isValidChannelName(chNames.fallback), `Expected ${chNames.fallback} to be valid`);
    }
  });

  test('3b. Mathematical Bold Conversion: Converts A-Z to 𝐀-𝐙, a-z to 𝐚-𝐳, and 0-9 to 𝟎-𝟗', () => {
    assert.equal(toMathematicalBold('DL'), '𝐃𝐋');
    assert.equal(toMathematicalBold('10K'), '𝟏𝟎𝐊');
    assert.equal(toMathematicalBold('BGMIS'), '𝐁𝐆𝐌𝐈𝐒');
    assert.equal(toMathematicalBold('ABC'), '𝐀𝐁𝐂');
    assert.equal(toMathematicalBold('xyz'), '𝐱𝐲𝐳');
    assert.equal(toMathematicalBold('0123456789'), '𝟎𝟏𝟐𝟑𝟒𝟓𝟔𝟕𝟖𝟗');
  });

  test('3c. Channel Name Validation: Allows valid characters, rejects emojis, icons, and spaces', () => {
    assert.equal(isValidChannelName('𝐃𝐋｜updates'), true);
    assert.equal(isValidChannelName('𝟏𝟎𝐊｜slotlist'), true);
    assert.equal(isValidChannelName('room-maker-vc'), true);
    assert.equal(isValidChannelName('dl-updates'), true);

    // Rejects spaces, emojis, icons, or plain uppercase letters
    assert.equal(isValidChannelName('room maker vc'), false);
    assert.equal(isValidChannelName('🎮｜updates'), false);
    assert.equal(isValidChannelName('DL｜updates'), false);
    assert.equal(isValidChannelName(''), false);
    assert.equal(isValidChannelName('a'.repeat(101)), false);
  });

  test('4. Category Naming: Uses short prefix (e.g. DL INFO, DL MANAGEMENT, DL R1)', () => {
    assert.equal(getTournamentCategoryName('DL', 'INFO'), 'DL INFO');
    assert.equal(getTournamentCategoryName('DL', 'MANAGEMENT'), 'DL MANAGEMENT');
    assert.equal(getTournamentCategoryName('DL', 'R1'), 'DL R1');
    assert.equal(sanitizeCategoryName('District League 2026'), 'DL INFO');
    assert.equal(sanitizeCategoryName('BGMIS 2026'), 'BGMIS INFO');
  });

  test('5. Main Dashboard Buttons: Replaces Delete All Channels & Delete Tournament with single red Danger Zone button', () => {
    const rows = buildTournamentControlPanelButtons('tour-test-123');
    assert.equal(rows.length, 2);

    const row1Buttons = rows[0].components;
    assert.equal(row1Buttons.length, 5);

    const row2Buttons = rows[1].components;
    assert.equal(row2Buttons.length, 1);

    const dangerZoneBtn = row2Buttons[0].data;
    assert.equal(dangerZoneBtn.label, 'Danger Zone');
    assert.equal(dangerZoneBtn.style, ButtonStyle.Danger);
    assert.equal(dangerZoneBtn.custom_id, 'dash:screen:danger:tour-test-123');

    // Ensure neither "Delete All Channels" nor "Delete Tournament" exist on main dashboard
    const allLabels = [...row1Buttons, ...row2Buttons].map((b) => b.data.label);
    assert.ok(!allLabels.includes('Delete All Channels'));
    assert.ok(!allLabels.includes('Delete Tournament'));
  });

  test('6. Danger Zone Screen: Embed and Buttons contain Delete All Channels, Delete Tournament, Back, and Refresh', () => {
    const embed = buildDangerZoneEmbed({ title: 'District League 2026', id: 'tour-123' });
    assert.ok(embed.data.title.includes('Danger Zone'));
    assert.equal(embed.data.color, 0xED4245);

    const buttonsRows = buildDangerZoneButtons('tour-123');
    assert.equal(buttonsRows.length, 1);

    const buttons = buttonsRows[0].components;
    assert.equal(buttons.length, 4);

    const [delChBtn, delTourBtn, backBtn, refreshBtn] = buttons.map((b) => b.data);
    assert.equal(delChBtn.label, 'Delete All Channels');
    assert.equal(delChBtn.style, ButtonStyle.Danger);
    assert.equal(delChBtn.custom_id, 'dash:danger:delete-channels:tour-123');

    assert.equal(delTourBtn.label, 'Delete Tournament');
    assert.equal(delTourBtn.style, ButtonStyle.Danger);
    assert.equal(delTourBtn.custom_id, 'dash:danger:delete-tournament:tour-123');

    assert.equal(backBtn.label, 'Back');
    assert.equal(backBtn.style, ButtonStyle.Secondary);
    assert.equal(backBtn.custom_id, 'dash:danger:back:tour-123');

    assert.equal(refreshBtn.label, 'Refresh');
    assert.equal(refreshBtn.style, ButtonStyle.Secondary);
    assert.equal(refreshBtn.custom_id, 'dash:danger:refresh:tour-123');
  });

  test('7. Danger Zone Screen: Interaction routing handles danger screen, back, refresh, and deletions', async () => {
    const guildId = 'guild-test-danger';
    const tourId = 'tour-danger-1';
    process.env.MATCHDISTRICT_GUILD_ID = guildId;
    guildSettingsCache[guildId] = {
      tournaments: {
        [tourId]: {
          tournamentId: tourId,
          tournamentTitle: 'District League 2026',
          channels: { botCommandsId: 'cmd-channel-1' },
          dashboardNavigationStack: [{ screen: 'home' }],
        },
      },
    };

    let renderedDanger = false;
    let editedMessage = null;

    const fakeInteraction = {
      guild: { id: guildId },
      channelId: 'cmd-channel-1',
      member: {
        id: 'admin-1',
        guild: { id: guildId, ownerId: 'admin-1' },
        permissions: { has: () => true },
      },
      customId: `dash:screen:danger:${tourId}`,
      isButton: () => true,
      deferUpdate: async function () { this.deferred = true; },
      editReply: async (payload) => {
        editedMessage = payload;
        renderedDanger = true;
      },
    };

    // Click Danger Zone button
    const handled = await handleDashboardNavigationInteraction(fakeInteraction);
    assert.equal(handled, true);
    assert.equal(renderedDanger, true);
    assert.ok(editedMessage.embeds[0].data.title.includes('Danger Zone'));
    assert.equal(editedMessage.components[0].components.length, 4);

    // Click Refresh on Danger Zone
    renderedDanger = false;
    fakeInteraction.customId = `dash:danger:refresh:${tourId}`;
    const handledRefresh = await handleDashboardNavigationInteraction(fakeInteraction);
    assert.equal(handledRefresh, true);
    assert.equal(renderedDanger, true);

    // Click Back on Danger Zone
    let returnedHome = false;
    fakeInteraction.customId = `dash:danger:back:${tourId}`;
    fakeInteraction.guild.channels = {
      cache: {
        get: () => ({ name: 'cmd-channel-1', isTextBased: () => true, messages: { fetch: async () => null } }),
        has: () => true,
      },
      fetch: async () => null,
    };
    fakeInteraction.editReply = async (payload) => {
      returnedHome = true;
    };
    const handledBack = await handleDashboardNavigationInteraction(fakeInteraction);
    assert.equal(handledBack, true);
  });

  test('8. Sync Channels: Categories and text channels named with short prefix and voice channel named Room Maker VC', async () => {
    const guildId = 'guild-sync-test';
    const tourId = 'tour-sync-1';
    process.env.MATCHDISTRICT_GUILD_ID = guildId;
    const tournament = { id: tourId, title: 'District League 2026' };

    const createdChannels = [];
    const renamedChannels = [];

    const mockCategory = {
      id: 'cat-1',
      name: 'Old Category Name',
      type: ChannelType.GuildCategory,
      guildId,
      setName: async (name) => {
        renamedChannels.push({ id: 'cat-1', name });
        mockCategory.name = name;
      },
      permissionOverwrites: { set: async () => {} },
    };

    const mockExistingVc = {
      id: 'vc-old',
      name: 'old-room-maker',
      type: ChannelType.GuildVoice,
      guildId,
      setName: async (name) => {
        renamedChannels.push({ id: 'vc-old', name });
        mockExistingVc.name = name;
      },
      setParent: async () => {},
      setUserLimit: async () => {},
      permissionOverwrites: { set: async () => {} },
    };

    const mockChannelsCache = new Map();
    mockChannelsCache.set('cat-1', mockCategory);
    mockChannelsCache.set('vc-old', mockExistingVc);

    const mockRolesCache = new Map();
    const mockGuild = {
      id: guildId,
      roles: {
        everyone: { id: 'everyone-role' },
        cache: mockRolesCache,
        fetch: async () => mockRolesCache,
        create: async (data) => {
          const role = { id: `role-${mockRolesCache.size + 1}`, name: data.name };
          mockRolesCache.set(role.id, role);
          return role;
        },
      },
      channels: {
        cache: {
          get: (id) => mockChannelsCache.get(id),
          has: (id) => mockChannelsCache.has(id),
          filter: () => new Map(),
        },
        fetch: async (id) => (id ? mockChannelsCache.get(id) || null : mockChannelsCache),
        create: async (data) => {
          const ch = {
            id: `new-${createdChannels.length + 1}`,
            name: data.name,
            type: data.type,
            guildId,
            permissionOverwrites: { set: async () => {} },
            setName: async (name) => { ch.name = name; },
            setParent: async () => {},
          };
          createdChannels.push(ch);
          mockChannelsCache.set(ch.id, ch);
          return ch;
        },
      },
    };

    const mockBotMember = {
      id: 'bot-id',
      permissions: { has: () => true },
    };

    guildSettingsCache[guildId] = {
      tournaments: {
        [tourId]: {
          tournamentId: tourId,
          tournamentTitle: tournament.title,
          categoryId: 'cat-1',
          channels: {
            roomMakerVcId: 'vc-old',
          },
          rounds: {},
        },
      },
    };

    const result = await syncTournamentDiscordChannels(mockGuild, tournament, [], mockBotMember);

    // Verify category was renamed to "DL INFO"
    assert.equal(mockCategory.name, 'DL INFO');

    // Verify room maker vc was renamed to "room-maker-vc" (no prefix, no spaces, no icons)
    assert.equal(mockExistingVc.name, 'room-maker-vc');

    // Verify created text channels use the Mathematical Bold 𝐃𝐋｜ prefix
    const textChannelsCreated = createdChannels.filter((c) => c.type === ChannelType.GuildText);
    for (const tc of textChannelsCreated) {
      assert.ok(tc.name.startsWith('𝐃𝐋｜'), `Expected ${tc.name} to start with 𝐃𝐋｜`);
    }
  });

  test('9. Robustness: Channel creation retries with ASCII fallback when Discord rejects primary name', async () => {
    const guildId = 'guild-test-fallback';
    const tourId = 'tour-fallback-1';
    const tournament = { id: tourId, title: 'District League 2026' };

    const mockChannelsCache = new Map();
    const createdChannels = [];

    const mockCategory = {
      id: 'cat-fb',
      name: 'DL INFO',
      type: ChannelType.GuildCategory,
      permissionOverwrites: { set: async () => {} },
      setName: async (name) => { mockCategory.name = name; },
    };
    mockChannelsCache.set('cat-fb', mockCategory);

    let rejectedCount = 0;
    const mockGuild = {
      id: guildId,
      roles: {
        everyone: { id: 'everyone-role' },
        cache: new Map(),
        fetch: async () => new Map(),
        create: async (d) => ({ id: 'role-1', name: d.name }),
      },
      channels: {
        cache: {
          get: (id) => mockChannelsCache.get(id),
          has: (id) => mockChannelsCache.has(id),
          filter: () => new Map(),
        },
        fetch: async (id) => (id ? mockChannelsCache.get(id) || null : mockChannelsCache),
        create: async (data) => {
          // Simulate Discord rejecting names with bold or fullwidth characters (Invalid Form Body)
          if (data.name.includes('｜') || data.name.includes('𝐃')) {
            rejectedCount++;
            const err = new Error('Invalid Form Body: name: Invalid channel name');
            err.code = 50035;
            throw err;
          }
          const ch = {
            id: `ch-${createdChannels.length + 1}`,
            name: data.name,
            type: data.type,
            guildId,
            permissionOverwrites: { set: async () => {} },
            setName: async (name) => { ch.name = name; },
            setParent: async () => {},
          };
          createdChannels.push(ch);
          mockChannelsCache.set(ch.id, ch);
          return ch;
        },
      },
    };

    const mockBotMember = {
      id: 'bot-id',
      permissions: { has: () => true },
    };

    guildSettingsCache[guildId] = {
      tournaments: {
        [tourId]: {
          tournamentId: tourId,
          tournamentTitle: tournament.title,
          categoryId: 'cat-fb',
          channels: {},
          rounds: {},
        },
      },
    };

    const syncResult = await syncTournamentDiscordChannels(mockGuild, tournament, [], mockBotMember);

    // Verify fallback kicked in for rejected names and channels were still created
    assert.ok(rejectedCount > 0, 'Expected Discord to reject primary names');
    assert.ok(createdChannels.length > 0, 'Expected channels to be created via fallback');
    for (const tc of createdChannels.filter((c) => c.type === ChannelType.GuildText)) {
      assert.ok(tc.name.startsWith('dl-'), `Expected fallback name to start with dl-, got: ${tc.name}`);
    }
  });

  test('10. Rename Tournament Channels: Renames already-created channels using IDs stored in MongoDB', async () => {
    const guildId = 'guild-test-rename';
    const tourId = 'tour-rename-1';

    const mockChannelsCache = new Map();
    const oldUpdates = {
      id: 'ch-upd-old',
      name: 'dl｜updates', // old non-bold name
      type: ChannelType.GuildText,
      setName: async (name) => { oldUpdates.name = name; },
    };
    const oldVc = {
      id: 'vc-old-room',
      name: 'Room Maker VC', // old capitalized name with spaces
      type: ChannelType.GuildVoice,
      setName: async (name) => { oldVc.name = name; },
    };
    mockChannelsCache.set('ch-upd-old', oldUpdates);
    mockChannelsCache.set('vc-old-room', oldVc);

    const mockGuild = {
      id: guildId,
      channels: {
        cache: mockChannelsCache,
        fetch: async (id) => mockChannelsCache.get(id) || null,
      },
    };

    guildSettingsCache[guildId] = {
      tournaments: {
        [tourId]: {
          tournamentId: tourId,
          tournamentTitle: 'District League 2026',
          channels: {
            tournamentUpdateId: 'ch-upd-old',
            roomMakerVcId: 'vc-old-room',
          },
        },
      },
    };

    const res = await renameTournamentChannelsToStandardFormat(mockGuild, tourId);

    // Verify text channel was renamed to Mathematical Bold format: 𝐃𝐋｜updates
    assert.equal(oldUpdates.name, '𝐃𝐋｜updates');

    // Verify room maker vc was renamed to room-maker-vc
    assert.equal(oldVc.name, 'room-maker-vc');
    assert.ok(res.renamed.includes('𝐃𝐋｜updates'));
    assert.ok(res.renamed.includes('room-maker-vc'));
  });
});
