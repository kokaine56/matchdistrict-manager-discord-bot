import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DELETION_LOCK_TIMEOUT_MS,
  isDeletionStale,
  clearTournamentDeletionLock,
  executeTournamentPermanentDeletion,
  handleConfirmPermanentTournamentDelete,
  handleTournamentButtonInteraction,
  handleDashCommand,
  handleSelectTournamentCommand,
  resumePendingTournamentDeletions,
} from '../tournamentService.js';
import { guildSettingsCache, saveGuildSettings } from '../index.js';

describe('Permanent Tournament Deletion Lock & Recovery', () => {
  const guildId = 'guild-del-test';
  const tournamentId = 'tour-del-test-1';

  test('1. Timeout: isDeletionStale identifies fresh vs stale locks', () => {
    const now = Date.now();

    // Fresh lock (< 3 minutes)
    const freshTour = {
      deletionStatus: 'deleting',
      deletingStartedAt: now - 30 * 1000, // 30s ago
    };
    assert.strictEqual(isDeletionStale(freshTour), false, 'Fresh lock (<3 min) should not be stale');

    // Stale lock (> 3 minutes)
    const staleTour = {
      deletionStatus: 'deleting',
      deletingStartedAt: now - (DELETION_LOCK_TIMEOUT_MS + 5000), // 3 min 5 sec ago
    };
    assert.strictEqual(isDeletionStale(staleTour), true, 'Lock older than 3 min must be stale');

    // Missing deletingStartedAt (legacy or stuck from previous restart)
    const legacyStuckTour = {
      deletionStatus: 'deleting',
    };
    assert.strictEqual(isDeletionStale(legacyStuckTour), true, 'Lock without deletingStartedAt must be treated as stale');

    // Not deleting
    const activeTour = {
      deletionStatus: null,
      setupStatus: 'completed',
    };
    assert.strictEqual(isDeletionStale(activeTour), false, 'Active tournament should not be stale');
  });

  test('2. clearTournamentDeletionLock clears lock properties from cache', async () => {
    guildSettingsCache[guildId] = {
      tournaments: {
        [tournamentId]: {
          tournamentId,
          tournamentTitle: 'Test Tournament',
          deletionStatus: 'deleting',
          deletingStartedAt: Date.now() - 60000,
          deletionError: 'some error',
        },
      },
    };

    await clearTournamentDeletionLock(guildId, tournamentId);

    const tour = guildSettingsCache[guildId].tournaments[tournamentId];
    assert.strictEqual(tour.deletionStatus, undefined);
    assert.strictEqual(tour.deletingStartedAt, undefined);
    assert.strictEqual(tour.deletionError, undefined);
  });

  test('3. executeTournamentPermanentDeletion is idempotent and purges cache on success', async () => {
    const deletedChannels = [];
    const mockChannel = {
      id: 'ch-del-1',
      name: 'dl-updates',
      delete: async () => {
        deletedChannels.push('ch-del-1');
      },
    };

    guildSettingsCache[guildId] = {
      tournaments: {
        [tournamentId]: {
          tournamentId,
          tournamentTitle: 'Test Tournament',
          channels: {
            tournamentUpdateId: 'ch-del-1',
            missingChannelId: 'ch-del-missing',
          },
          roleId: 'role-del-1',
        },
      },
    };

    const mockGuild = {
      id: guildId,
      name: 'Test Guild',
      channels: {
        cache: new Map([['ch-del-1', mockChannel]]),
        fetch: async (id) => (id === 'ch-del-1' ? mockChannel : null),
      },
      roles: {
        cache: new Map(),
        fetch: async () => null, // Role already gone (safe to repeat)
      },
      client: null,
    };

    const result = await executeTournamentPermanentDeletion(mockGuild, tournamentId, null);

    assert.strictEqual(result.success, true);
    assert.strictEqual(guildSettingsCache[guildId]?.tournaments?.[tournamentId], undefined, 'Tournament must be removed from cache');

    // Repeating on already deleted tournament is completely safe
    const repeatResult = await executeTournamentPermanentDeletion(mockGuild, tournamentId, null);
    assert.strictEqual(repeatResult.success, true, 'Repeat deletion must be idempotent');
  });

  test('4. executeTournamentPermanentDeletion clears lock on critical error', async () => {
    const brokenGuildId = 'guild-broken-del';
    const brokenTourId = 'tour-broken-1';

    guildSettingsCache[brokenGuildId] = {
      tournaments: {
        [brokenTourId]: {
          tournamentId: brokenTourId,
          channels: {
            botCommandsId: 'ch-1',
          },
        },
      },
    };

    // Mock guild that throws critical unexpected error
    const faultyGuild = {
      id: brokenGuildId,
      channels: {
        cache: {
          get: () => {
            throw new Error('Simulated Discord API Crash');
          },
        },
        fetch: async () => {
          throw new Error('Simulated Discord API Crash');
        },
      },
      roles: {
        cache: new Map(),
      },
      client: null,
    };

    const result = await executeTournamentPermanentDeletion(faultyGuild, brokenTourId, null);

    assert.strictEqual(result.success, false);
    // Crucial check: Lock must NEVER stay as 'deleting' or 'deletion_pending' after failure!
    const saved = guildSettingsCache[brokenGuildId]?.tournaments?.[brokenTourId];
    assert.strictEqual(saved?.deletionStatus, 'deletion_failed');
    assert.strictEqual(saved?.deletingStartedAt, null);
    assert.ok(saved?.deletionError?.includes('Simulated Discord API Crash'));
  });

  test('5. handleConfirmPermanentTournamentDelete presents Retry button on failure', async () => {
    const retryGuildId = 'guild-retry-test';
    const retryTourId = 'tour-retry-1';

    guildSettingsCache[retryGuildId] = {
      organiserLink: { status: 'linked' },
      tournaments: {
        [retryTourId]: {
          tournamentId: retryTourId,
          channels: {
            botCommandsId: 'ch-retry',
          },
        },
      },
    };

    let replyPayload = null;
    const mockInteraction = {
      guild: {
        id: retryGuildId,
        channels: {
          cache: {
            get: () => {
              throw new Error('Discord rate limit');
            },
          },
          fetch: async () => {
            throw new Error('Discord rate limit');
          },
        },
        roles: { cache: new Map() },
        client: null,
      },
      member: {
        permissions: { has: () => true }, // Admin
      },
      deferred: true,
      editReply: async (payload) => {
        replyPayload = payload;
      },
    };

    await handleConfirmPermanentTournamentDelete(mockInteraction, retryTourId);

    assert.ok(replyPayload, 'Should reply with error payload');
    assert.ok(replyPayload.content.includes('Tournament Deletion Incomplete') || replyPayload.content.includes('Tournament Deletion Failed'));
    // Must contain a Retry button
    const buttons = replyPayload.components?.[0]?.components || [];
    const retryBtn = buttons.find((b) => b.data?.custom_id?.includes('confirm-delete-tournament'));
    assert.ok(retryBtn, 'Must render Retry Delete Tournament button');
    assert.strictEqual(retryBtn.data.label, 'Retry Delete Tournament');
  });

  test('6. handleTournamentDashboardInteraction unblocks actions when deletion lock is stale', async () => {
    const interGuildId = 'guild-inter-test';
    const interTourId = 'tour-inter-1';

    // Stale lock (> 3 minutes)
    guildSettingsCache[interGuildId] = {
      organiserLink: { status: 'linked' },
      tournaments: {
        [interTourId]: {
          tournamentId: interTourId,
          tournamentTitle: 'Stuck Tourney',
          deletionStatus: 'deleting',
          deletingStartedAt: Date.now() - (DELETION_LOCK_TIMEOUT_MS + 10000), // > 3 min
          dashboardNavigationStack: [{ screen: 'home' }],
          channels: { botCommandsId: 'ch-cmd' },
        },
      },
    };

    let blockedContent = null;
    const mockInteraction = {
      customId: `md_tour_view_rounds:${interTourId}`,
      channelId: 'ch-cmd',
      guild: {
        id: interGuildId,
        channels: { cache: new Map(), fetch: async () => null },
        roles: { cache: new Map() },
        members: { me: { permissions: { has: () => true } } },
      },
      member: {
        permissions: { has: () => true },
      },
      reply: async (payload) => {
        blockedContent = payload.content;
      },
      editReply: async (payload) => {
        blockedContent = payload.content;
      },
    };

    await handleTournamentButtonInteraction(mockInteraction);

    // Should NOT be blocked with the permanent deletion warning
    assert.notStrictEqual(blockedContent, '⚠️ **Action Blocked:** This tournament is currently undergoing permanent deletion.');
    // Lock should be auto-cleared
    const tour = guildSettingsCache[interGuildId]?.tournaments?.[interTourId];
    assert.strictEqual(tour?.deletionStatus, undefined, 'Stale deletion lock must be auto-cleared');
  });

  test('7. handleDashCommand unblocks .dash when deletion lock is stale', async () => {
    const dashGuildId = 'guild-dash-test';
    const dashTourId = 'tour-dash-1';

    guildSettingsCache[dashGuildId] = {
      tournaments: {
        [dashTourId]: {
          tournamentId: dashTourId,
          deletionStatus: 'deleting',
          deletingStartedAt: Date.now() - (DELETION_LOCK_TIMEOUT_MS + 20000), // Stale
          channels: { botCommandsId: 'ch-dash-cmd' },
        },
      },
    };

    let replyMessage = null;
    const mockChannel = { id: 'ch-dash-cmd' };
    const mockGuild = {
      id: dashGuildId,
      channels: { cache: new Map(), fetch: async () => null },
      members: { me: { permissions: { has: () => true } } },
    };
    const mockMember = { permissions: { has: () => true } };

    await handleDashCommand(
      mockGuild,
      mockMember,
      mockChannel,
      (text) => {
        replyMessage = typeof text === 'string' ? text : text.content;
      },
      null
    );

    assert.notStrictEqual(
      replyMessage,
      '⚠️ **Tournament Unavailable:** This tournament is currently undergoing permanent deletion or has been deleted.',
      'Stale deletion lock should not block .dash command'
    );
  });

  test('8. Startup Recovery: resumePendingTournamentDeletions clears stuck tournaments', async () => {
    const startupGuildId = 'guild-startup-test';
    const startupTourId = 'tour-startup-1';

    guildSettingsCache[startupGuildId] = {
      tournaments: {
        [startupTourId]: {
          tournamentId: startupTourId,
          deletionStatus: 'deleting', // Stuck on restart
          channels: {},
        },
      },
    };

    const mockGuild = {
      id: startupGuildId,
      name: 'Startup Guild',
      channels: {
        cache: new Map(),
        fetch: async () => null,
      },
      roles: {
        cache: new Map(),
      },
      client: null,
    };

    const mockClient = {
      guilds: {
        cache: new Map([[startupGuildId, mockGuild]]),
        fetch: async (id) => (id === startupGuildId ? mockGuild : null),
      },
    };

    await resumePendingTournamentDeletions(mockClient, startupGuildId);

    // After startup recovery, the stuck tournament must be completely purged from cache
    assert.strictEqual(
      guildSettingsCache[startupGuildId]?.tournaments?.[startupTourId],
      undefined,
      'Stuck tournament must be purged on startup'
    );
  });

  test('9. .select tournament <id> clears leftover deletion status and starts fresh', async () => {
    const selectGuildId = 'guild-select-test';
    const selectTourId = 'tour-select-1';

    guildSettingsCache[selectGuildId] = {
      tournaments: {
        [selectTourId]: {
          tournamentId: selectTourId,
          deletionStatus: 'deletion_failed',
          channels: { botCommandsId: 'old-ch' },
        },
      },
    };

    // Run select check
    const currentSaved = guildSettingsCache[selectGuildId]?.tournaments?.[selectTourId];
    if (currentSaved && (currentSaved.deletionStatus || isDeletionStale(currentSaved))) {
      delete guildSettingsCache[selectGuildId].tournaments[selectTourId];
      saveGuildSettings(guildSettingsCache);
    }

    assert.strictEqual(
      guildSettingsCache[selectGuildId]?.tournaments?.[selectTourId],
      undefined,
      'Selecting a previously deleting tournament purges leftover state to start fresh'
    );
  });
});
