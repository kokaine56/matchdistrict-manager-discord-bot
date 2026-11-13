import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  guildSettingsCache,
} from '../index.js';
import {
  handleTournamentVerificationMessage,
  cleanupLegacyPublicVerificationPrompts,
} from '../tournamentService.js';
import {
  localTeams,
  localEntries,
  localPlayerMemberships,
  deleteTournamentRegistrationComplete,
  clearInMemoryData,
  setExternalGuildSettingsGetter,
} from '../configurableTournamentData.js';
import {
  localPendingVerifications,
  localPermanentIdentitiesByDiscordId,
  localPermanentIdentitiesByMDId,
  getActivePendingTournamentVerificationForUser,
  savePermanentDiscordIdentity,
  getPermanentDiscordIdentityByDiscordId,
} from '../mongoService.js';

const TEST_GUILD_ID = 'guild-privacy-spam-test';
const TEST_TOUR_ID = 'tour-privacy-spam';
const VERIF_CHANNEL_ID = 'chan-verif-privacy';

describe('Verification Privacy, Anti-Spam, Offline Recovery & Permanent Identity', () => {
  let channelMessages = [];
  let deletedMessageIds = new Set();
  let mockChannel;
  let mockGuild;

  beforeEach(() => {
    setExternalGuildSettingsGetter(() => guildSettingsCache);
    clearInMemoryData();
    localPendingVerifications.clear();
    localPermanentIdentitiesByDiscordId.clear();
    localPermanentIdentitiesByMDId.clear();
    channelMessages = [];
    deletedMessageIds.clear();

    mockChannel = {
      id: VERIF_CHANNEL_ID,
      name: 'tournament-verification',
      permissionsFor: () => ({
        has: () => true,
      }),
      messages: {
        fetch: async ({ limit, before }) => {
          let pool = [...channelMessages];
          if (before) {
            const idx = pool.findIndex(m => m.id === before);
            if (idx > 0) pool = pool.slice(0, idx);
          }
          const slice = pool.slice(-limit);
          const map = new Map();
          for (const m of slice) map.set(m.id, m);
          return map;
        },
      },
      send: async (payload) => {
        const msgId = 'bot-msg-' + Math.random().toString(36).substring(2, 9);
        const msg = {
          id: msgId,
          content: payload.content || '',
          components: payload.components || [],
          author: { bot: true, id: 'bot-123' },
          delete: async () => {
            deletedMessageIds.add(msgId);
          },
        };
        channelMessages.push(msg);
        return msg;
      },
    };

    mockGuild = {
      id: TEST_GUILD_ID,
      name: 'Test Esports Server',
      channels: {
        cache: new Map([[VERIF_CHANNEL_ID, mockChannel]]),
        fetch: async (id) => (id === VERIF_CHANNEL_ID ? mockChannel : null),
      },
      members: {
        me: { id: 'bot-123' },
        fetchMe: async () => ({ id: 'bot-123' }),
        fetch: async (id) => ({
          id,
          user: { id, bot: false },
          roles: { add: async () => {}, remove: async () => {} },
          send: async () => {},
        }),
      },
      client: {},
    };

    guildSettingsCache[TEST_GUILD_ID] = {
      tournaments: {
        [TEST_TOUR_ID]: {
          tournamentId: TEST_TOUR_ID,
          tournamentTitle: 'Spring Cup 2026',
          roleId: 'role-participant',
          channels: {
            tournamentVerificationId: VERIF_CHANNEL_ID,
          },
          verifiedRegistrations: {},
        },
      },
      api: {
        backendUrl: 'http://127.0.0.1:4000',
        botSecret: 'test-bot-secret',
        organiserCode: 'ORG_PRIVACY',
      },
    };
  });

  test('Test 1: Verification code auto-delete — Code message deleted immediately and prompt appears', async () => {
    let originalMessageDeleted = false;
    const userMessageId = 'user-msg-code-1';

    // Mock fetch for requestVerificationCheck
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.includes('/verification/check-code')) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            registration_id: 'reg-001',
            team_name: 'Team Vortex',
            captain_name: 'VortexLeader',
            captain_uid: 'vortex-uid-1',
            match_district_user_id: 'md-user-vortex',
            captain_user_id: 'md-user-vortex',
            squad: [{ ign: 'VortexLeader', uid: 'vortex-uid-1' }],
            players: [],
            teammates_needed: 0,
          }),
        };
      }
      return origFetch(url);
    };

    try {
      const userMessage = {
        id: userMessageId,
        guild: mockGuild,
        channel: mockChannel,
        author: { id: 'discord-user-vortex', bot: false, tag: 'VortexLeader#0001' },
        content: 'ABC12345',
        delete: async () => {
          originalMessageDeleted = true;
          deletedMessageIds.add(userMessageId);
        },
      };

      const handled = await handleTournamentVerificationMessage(userMessage);
      assert.equal(handled, true);
      assert.equal(originalMessageDeleted, true, 'User verification code message must be deleted immediately');

      // Verify prompt was sent with Continue button
      const prompt = channelMessages.find(m => m.content.includes('Code accepted. Press **Continue**'));
      assert.ok(prompt, 'A prompt message must be sent to the channel');
      assert.ok(prompt.components?.length > 0, 'Prompt must contain components');

      const continueBtn = prompt.components[0].components?.find(c => c.data?.label === 'Continue' || c.label === 'Continue');
      assert.ok(continueBtn, 'Prompt must contain the Continue button');

      // Verify active session was stored
      const active = await getActivePendingTournamentVerificationForUser({
        tournamentId: TEST_TOUR_ID,
        starterDiscordId: 'discord-user-vortex',
      });
      assert.ok(active, 'Active pending session must exist');
      assert.equal(active.registrationId, 'reg-001');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('Test 2: Anti-spam / duplicate prevention — Rapid submissions create exactly 1 session & 1 Continue prompt', async () => {
    let deleteCount = 0;

    const origFetch = globalThis.fetch;
    let apiCallCount = 0;
    globalThis.fetch = async (url) => {
      if (url.includes('/verification/check-code')) {
        apiCallCount++;
        return {
          ok: true,
          json: async () => ({
            success: true,
            registration_id: 'reg-002',
            team_name: 'Team Velocity',
            captain_name: 'Velociraptor',
            match_district_user_id: 'md-user-velocity',
            squad: [{ ign: 'Velociraptor', uid: 'vel-1' }],
            players: [],
            teammates_needed: 0,
          }),
        };
      }
      return origFetch(url);
    };

    try {
      const makeMsg = (id) => ({
        id,
        guild: mockGuild,
        channel: mockChannel,
        author: { id: 'discord-user-spammer', bot: false, tag: 'SpamUser#1234' },
        content: 'VELO1234',
        delete: async () => {
          deleteCount++;
          deletedMessageIds.add(id);
        },
      });

      // Submit 3 times rapidly
      const res1 = await handleTournamentVerificationMessage(makeMsg('msg-1'));
      const res2 = await handleTournamentVerificationMessage(makeMsg('msg-2'));
      const res3 = await handleTournamentVerificationMessage(makeMsg('msg-3'));

      assert.equal(res1, true);
      assert.equal(res2, true);
      assert.equal(res3, true);

      // All 3 user messages must be auto-deleted
      assert.equal(deleteCount, 3, 'All 3 user messages should be deleted immediately');

      // API should only be called once because subsequent checks detect an active session
      assert.equal(apiCallCount, 1, 'Verification API should only be called once');

      // Exactly 1 Continue prompt should exist
      const continuePrompts = channelMessages.filter(m => m.content.includes('Code accepted. Press **Continue**'));
      assert.equal(continuePrompts.length, 1, 'Exactly one Continue prompt must be posted');

      // The other responses must inform the user that a session is in progress
      const duplicateNotices = channelMessages.filter(m => m.content.includes('verification session is already in progress'));
      assert.equal(duplicateNotices.length, 2, 'Subsequent submissions must notify the user of the active session');

      // Exactly 1 active session in memory/DB
      const activeSessions = Array.from(localPendingVerifications.values()).filter(
        s => s.tournamentId === TEST_TOUR_ID && s.starterDiscordId === 'discord-user-spammer' && ['active', 'awaiting_continue'].includes(s.status)
      );
      assert.equal(activeSessions.length, 1, 'Exactly 1 active session must exist in data store');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('Test 3: Offline recovery — Leftover verification codes deleted upon startup, instructions preserved', async () => {
    // Populate channel with messages sent while bot was offline
    const codeMsg1 = {
      id: 'offline-code-1',
      content: 'WXYZ9876',
      author: { bot: false, id: 'user-offline-1' },
      delete: async () => { deletedMessageIds.add('offline-code-1'); },
    };
    const codeMsg2 = {
      id: 'offline-code-2',
      content: '  ABCD1234  ',
      author: { bot: false, id: 'user-offline-2' },
      delete: async () => { deletedMessageIds.add('offline-code-2'); },
    };
    const announcementMsg = {
      id: 'announcement-1',
      content: 'Welcome to Spring Cup 2026! Read the rules before verifying.',
      author: { bot: true, id: 'bot-123' },
      delete: async () => { deletedMessageIds.add('announcement-1'); },
    };
    const regularChatMsg = {
      id: 'chat-1',
      content: 'Can an admin help me with tournament rules?',
      author: { bot: false, id: 'user-chat-1' },
      delete: async () => { deletedMessageIds.add('chat-1'); },
    };

    channelMessages.push(codeMsg1, codeMsg2, announcementMsg, regularChatMsg);

    // Run offline recovery
    await cleanupLegacyPublicVerificationPrompts(mockGuild);

    // Verify leftover codes are deleted
    assert.ok(deletedMessageIds.has('offline-code-1'), 'Offline user code 1 must be deleted');
    assert.ok(deletedMessageIds.has('offline-code-2'), 'Offline user code 2 must be deleted');

    // Verify announcements and regular chat messages are preserved
    assert.equal(deletedMessageIds.has('announcement-1'), false, 'Bot announcements must NOT be deleted');
    assert.equal(deletedMessageIds.has('chat-1'), false, 'Non-code user messages must NOT be deleted');
  });

  test('Test 4: Permanent account link — Verification succeeds after team deletion without account error or re-prompt', async () => {
    const mdUserId = 'md-permanent-user-404';
    const discordUserId = 'discord-user-404';
    const username = 'ApexLegend';

    // 1. Link permanent identity initially
    await savePermanentDiscordIdentity({
      matchDistrictUserId: mdUserId,
      discordUserId,
      discordUsername: username,
    });

    const verifyCheck = await getPermanentDiscordIdentityByDiscordId(discordUserId);
    assert.equal(verifyCheck.matchDistrictUserId, mdUserId);

    // 2. Setup existing team
    const teamDoc = {
      tournamentId: TEST_TOUR_ID,
      teamId: 'team-apex',
      teamName: 'Team Apex',
      leaderDiscordId: discordUserId,
      players: [],
      status: 'CONFIRMED',
    };
    localTeams.set('team-apex', teamDoc);

    // 3. Admin deletes registration completely
    await deleteTournamentRegistrationComplete({
      tournamentId: TEST_TOUR_ID,
      teamId: 'team-apex',
      reason: 'Host cancelled team',
      savedTournament: guildSettingsCache[TEST_GUILD_ID].tournaments[TEST_TOUR_ID],
      purgeRegistration: true,
    });

    // Verify permanent link remains untouched
    const stillLinked = await getPermanentDiscordIdentityByDiscordId(discordUserId);
    assert.ok(stillLinked, 'Permanent link must remain intact after team deletion');
    assert.equal(stillLinked.matchDistrictUserId, mdUserId);

    // 4. Same user registers again with new registration ID
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.includes('/verification/check-code')) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            registration_id: 'reg-apex-fresh-02',
            team_name: 'Team Apex Reborn',
            captain_name: 'ApexLegend',
            match_district_user_id: mdUserId,
            user_id: mdUserId,
            squad: [{ ign: 'ApexLegend', uid: 'apex-uid-1' }],
            players: [],
            teammates_needed: 0,
          }),
        };
      }
      return origFetch(url);
    };

    try {
      const freshMessage = {
        id: 'user-msg-fresh-apex',
        guild: mockGuild,
        channel: mockChannel,
        author: { id: discordUserId, bot: false, tag: `${username}#0001` },
        content: 'APEX9999',
        delete: async () => {
          deletedMessageIds.add('user-msg-fresh-apex');
        },
      };

      const handled = await handleTournamentVerificationMessage(freshMessage);
      assert.equal(handled, true);

      // Verify no "different Match District user account" error was thrown
      const errorMsg = channelMessages.find(m => m.content.includes('different Match District user account'));
      assert.equal(errorMsg, undefined, 'Must NOT reject re-registration with different account error');

      // Verify prompt was sent successfully
      const prompt = channelMessages.find(m => m.content.includes('Code accepted. Press **Continue**'));
      assert.ok(prompt, 'Fresh verification prompt must appear');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

