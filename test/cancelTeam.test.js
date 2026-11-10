import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import {
  canManageTournament,
  getConfirmedTeamsFromDb,
  buildTournamentControlPanelButtons,
  handleCancelTeamListScreen,
  handleCancelTeamSelect,
  handleCancelTeamModalSubmit,
  handleCancelTeamConfirm,
  handleDashboardNavigationInteraction,
} from '../tournamentService.js';
import { guildSettingsCache } from '../index.js';

describe('Cancel Team Feature Unit & Integration Tests', () => {
  const guildId = 'test-guild-cancel-team';
  const tournamentId = 'tour-cancel-123';

  beforeEach(() => {
    guildSettingsCache[guildId] = {
      tournaments: {
        [tournamentId]: {
          tournamentId,
          guildId,
          tournamentTitle: 'MD Pro Invitational',
          roleId: 'tourney-role-1',
          tourneyModRoleId: 'role-mod-id',
          channels: {
            botCommandsId: 'bot-commands-channel',
            tournamentTeamsId: 'teams-channel',
          },
          verifiedRegistrations: {
            'reg-1': {
              registrationId: 'reg-1',
              teamName: 'Alpha Wolves',
              discordId: 'leader-1',
              discordMemberIds: ['leader-1', 'member-1a', 'member-1b'],
              captain: { ign: 'AlphaLead', discord_id: 'leader-1' },
              status: 'CONFIRMED',
            },
            'reg-2': {
              registrationId: 'reg-2',
              teamName: 'Beta Strikers',
              discordId: 'leader-2',
              discordMemberIds: ['leader-2', 'member-1a', 'member-2b'], // member-1a is also in Beta Strikers!
              captain: { ign: 'BetaLead', discord_id: 'leader-2' },
              status: 'CONFIRMED',
            },
            'reg-cancelled': {
              registrationId: 'reg-cancelled',
              teamName: 'Omega Ghosts',
              discordId: 'leader-3',
              discordMemberIds: ['leader-3'],
              status: 'CANCELLED',
            },
          },
          rounds: {
            'round-1': {
              roundId: 'round-1',
              name: 'Round 1',
              groups: [
                {
                  groupNumber: 1,
                  roleId: 'group-1-role',
                  channelId: 'group-1-ch',
                  idpChannelId: 'group-1-idp',
                  slots: [
                    {
                      slotNumber: 1,
                      status: 'OCCUPIED',
                      teamId: 'reg-1',
                      teamName: 'Alpha Wolves',
                      leaderId: 'leader-1',
                      memberIds: ['leader-1', 'member-1a', 'member-1b'],
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    };
  });

  test('1. canManageTournament server-side permission checks', () => {
    const guild = { ownerId: 'owner-id' };

    // Guild owner
    assert.equal(canManageTournament(guild, { id: 'owner-id' }), true);

    // Administrator
    assert.equal(
      canManageTournament(guild, {
        id: 'admin-id',
        permissions: { has: (p) => p === PermissionFlagsBits.Administrator },
      }),
      true
    );

    // ManageGuild (Manage Server)
    assert.equal(
      canManageTournament(guild, {
        id: 'manager-id',
        permissions: { has: (p) => p === PermissionFlagsBits.ManageGuild },
      }),
      true
    );

    // Tourney-mod role by ID
    assert.equal(
      canManageTournament(
        guild,
        {
          id: 'mod-id',
          roles: {
            cache: {
              has: (id) => id === 'role-mod-id',
              some: () => false,
            },
          },
        },
        { tourneyModRoleId: 'role-mod-id' }
      ),
      true
    );

    // Tourney-mod role by Name
    assert.equal(
      canManageTournament(
        guild,
        {
          id: 'mod-name-id',
          roles: {
            cache: {
              has: () => false,
              some: (cb) => cb({ name: 'Tourney-mod' }),
            },
          },
        },
        {}
      ),
      true
    );

    // Regular unauthorized member
    assert.equal(
      canManageTournament(guild, {
        id: 'user-id',
        permissions: { has: () => false },
        roles: { cache: { has: () => false, some: () => false } },
      }),
      false
    );
  });

  test('2. getConfirmedTeamsFromDb returns confirmed teams, excludes cancelled, and attaches group allocation', async () => {
    const guild = { id: guildId, ownerId: 'owner-id' };
    const saved = guildSettingsCache[guildId].tournaments[tournamentId];
    const teams = await getConfirmedTeamsFromDb(guild, tournamentId, saved);

    assert.equal(teams.length, 2);
    assert.equal(teams[0].teamName, 'Alpha Wolves');
    assert.equal(teams[0].allocatedRound, 'Round 1');
    assert.equal(teams[0].allocatedGroup, 1);
    assert.equal(teams[0].allocatedSlotNumber, 1);

    assert.equal(teams[1].teamName, 'Beta Strikers');
    assert.equal(teams[1].allocatedRound, undefined);

    // Ensure cancelled team 'Omega Ghosts' was omitted
    assert.equal(teams.find((t) => t.teamName === 'Omega Ghosts'), undefined);
  });

  test('3. buildTournamentControlPanelButtons includes Cancel Team button', () => {
    const rows = buildTournamentControlPanelButtons(tournamentId);
    assert.ok(Array.isArray(rows));
    const allButtons = rows.flatMap((r) => r.components);
    const cancelBtn = allButtons.find((b) => b.data.custom_id === `dash:cancel_team:list:${tournamentId}:0`);
    assert.ok(cancelBtn, 'Cancel Team button must exist in dashboard');
    assert.equal(cancelBtn.data.label, 'Cancel Team');
  });

  test('4. handleCancelTeamListScreen enforces permissions and renders select menu', async () => {
    const guild = { id: guildId, ownerId: 'owner-id' };

    // Unauthorized member rejected
    let replyPayload = null;
    const unauthInteraction = {
      guild,
      member: { id: 'unauth-user', permissions: { has: () => false }, roles: { cache: { has: () => false, some: () => false } } },
      reply: async (p) => { replyPayload = p; },
    };
    await handleCancelTeamListScreen(unauthInteraction, tournamentId, 0);
    assert.ok(replyPayload.content.includes('Permission Denied'));

    // Authorized admin gets embed and select menu
    let updatePayload = null;
    const authInteraction = {
      guild,
      member: { id: 'owner-id', permissions: { has: () => true } },
      update: async (p) => { updatePayload = p; },
    };
    await handleCancelTeamListScreen(authInteraction, tournamentId, 0);
    assert.ok(updatePayload);
    assert.ok(updatePayload.embeds[0].data.title.includes('Cancel Confirmed Team'));
    assert.equal(updatePayload.components.length, 2); // Select menu row + Nav buttons row
    const selectMenu = updatePayload.components[0].components[0];
    assert.equal(selectMenu.data.custom_id, `dash:cancel_team:select:${tournamentId}:0`);
    assert.equal(selectMenu.options.length, 2);
  });

  test('5. handleCancelTeamSelect displays modal with 10 to 500 characters constraint', async () => {
    const guild = { id: guildId, ownerId: 'owner-id' };
    let modalShown = null;

    const interaction = {
      guild,
      member: { id: 'owner-id' },
      values: ['reg-1'],
      showModal: async (m) => { modalShown = m; },
    };

    await handleCancelTeamSelect(interaction, tournamentId);
    assert.ok(modalShown);
    assert.equal(modalShown.data.custom_id, `dash:cancel_team:modal:${tournamentId}:reg-1`);
    assert.equal(modalShown.data.title, 'Cancel Team Slot');
    const input = modalShown.components[0].components[0];
    assert.equal(input.data.custom_id, 'cancellation_reason');
    assert.equal(input.data.min_length, 10);
    assert.equal(input.data.max_length, 500);
    assert.equal(input.data.required, true);
  });

  test('6. handleCancelTeamModalSubmit validates reason and renders confirmation with warning', async () => {
    const guild = { id: guildId, ownerId: 'owner-id' };

    // Short reason rejected (< 10 chars)
    let replyPayload = null;
    const shortInteraction = {
      guild,
      member: { id: 'owner-id' },
      fields: { getTextInputValue: () => 'too short' },
      reply: async (p) => { replyPayload = p; },
    };
    await handleCancelTeamModalSubmit(shortInteraction, tournamentId, 'reg-1');
    assert.ok(replyPayload.content.includes('between 10 and 500 characters'));

    // Valid reason displays confirmation embed
    let updatePayload = null;
    const validInteraction = {
      guild,
      member: { id: 'owner-id' },
      user: { id: 'admin-id', tag: 'Admin#0001' },
      fields: { getTextInputValue: () => 'Rule violation: Failed to submit verified squad details before deadline.' },
      update: async (p) => { updatePayload = p; },
    };
    await handleCancelTeamModalSubmit(validInteraction, tournamentId, 'reg-1');
    assert.ok(updatePayload);
    const desc = updatePayload.embeds[0].data.description;
    assert.ok(desc.includes('Alpha Wolves'));
    assert.ok(desc.includes('Round 1 — Group 1')); // Shows allocation warning!
    assert.ok(desc.includes('Rule violation'));

    const buttons = updatePayload.components[0].components;
    assert.equal(buttons[0].data.custom_id, `dash:cancel_team:confirm:${tournamentId}:reg-1`);
    assert.equal(buttons[1].data.custom_id, `dash:cancel_team:list:${tournamentId}:0`);
  });

  test('7. handleCancelTeamConfirm halts when website call fails, allows retry', async () => {
    const guild = { id: guildId, ownerId: 'owner-id' };
    const saved = guildSettingsCache[guildId].tournaments[tournamentId];
    saved.pendingTeamCancellations = {
      'reg-1': {
        teamId: 'reg-1',
        teamName: 'Alpha Wolves',
        leaderId: 'leader-1',
        memberIds: ['leader-1', 'member-1a', 'member-1b'],
        reason: 'Rule violation',
      },
    };

    // Mock global.fetch to simulate website error
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Website database unavailable' }),
    });

    let updatePayload = null;
    const interaction = {
      guild,
      member: { id: 'owner-id' },
      user: { id: 'admin-id', tag: 'Admin#0001' },
      update: async (p) => { updatePayload = p; },
    };

    try {
      await handleCancelTeamConfirm(interaction, tournamentId, 'reg-1');
      assert.ok(updatePayload);
      assert.ok(updatePayload.embeds[0].data.title.includes('Team Cancellation Failed'));
      assert.ok(updatePayload.embeds[0].data.description.includes('Website database unavailable'));
      // Ensure registration was NOT marked cancelled locally
      assert.equal(saved.verifiedRegistrations['reg-1'].status, 'CONFIRMED');
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('8. handleCancelTeamConfirm succeeds: updates MongoDB, roles, slots, and DMs leader', async () => {
    const guild = {
      id: guildId,
      ownerId: 'owner-id',
      members: {
        fetch: async (id) => ({
          id,
          roles: { remove: async () => {} },
        }),
      },
      channels: {
        cache: new Map(),
        fetch: async () => null,
      },
    };

    const saved = guildSettingsCache[guildId].tournaments[tournamentId];
    saved.pendingTeamCancellations = {
      'reg-1': {
        teamId: 'reg-1',
        teamName: 'Alpha Wolves',
        leaderId: 'leader-1',
        memberIds: ['leader-1', 'member-1a', 'member-1b'],
        reason: 'Rule violation: Unsportsmanlike conduct.',
      },
    };

    let sentDmMessage = null;
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    });

    let updatePayload = null;
    const interaction = {
      guild,
      member: { id: 'owner-id' },
      user: { id: 'admin-id', tag: 'Admin#0001' },
      client: {
        users: {
          fetch: async (id) => ({
            id,
            send: async (msg) => { sentDmMessage = msg; },
          }),
        },
      },
      update: async (p) => { updatePayload = p; },
    };

    try {
      await handleCancelTeamConfirm(interaction, tournamentId, 'reg-1');
      assert.ok(updatePayload);
      assert.ok(updatePayload.embeds[0].data.title.includes('Team Cancelled Successfully'));
      assert.ok(updatePayload.embeds[0].data.description.includes('Alpha Wolves'));

      // 1. Verified registration status updated
      const reg = saved.verifiedRegistrations['reg-1'];
      assert.equal(reg.status, 'CANCELLED');
      assert.equal(reg.cancellationReason, 'Rule violation: Unsportsmanlike conduct.');

      // 2. Round slot freed
      const slot = saved.rounds['round-1'].groups[0].slots[0];
      assert.equal(slot.status, 'AVAILABLE');
      assert.equal(slot.teamId, undefined);

      // 3. Team leader received formatted DM
      assert.ok(sentDmMessage);
      assert.ok(sentDmMessage.content.includes('Your team **Alpha Wolves** has been removed from **MD Pro Invitational**'));
      assert.ok(sentDmMessage.content.includes('Reason: Rule violation: Unsportsmanlike conduct.'));
      assert.ok(sentDmMessage.content.includes('If you think this is a mistake, please contact the organisers.'));
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('9. handleDashboardNavigationInteraction routes cancel_team actions correctly', async () => {
    let listHandled = false;
    let confirmHandled = false;

    const listInteraction = {
      customId: `dash:cancel_team:list:${tournamentId}:0`,
      guild: { id: guildId, ownerId: 'owner-id' },
      member: { id: 'owner-id' },
      update: async () => { listHandled = true; },
    };

    const handled1 = await handleDashboardNavigationInteraction(listInteraction);
    assert.equal(handled1, true);
    assert.equal(listHandled, true);

    const backInteraction = {
      customId: `dash:cancel_team:back:${tournamentId}`,
      guild: {
        id: guildId,
        ownerId: 'owner-id',
        channels: {
          cache: {
            get: () => ({
              messages: {
                fetch: async () => ({
                  edit: async () => {},
                }),
              },
            }),
          },
        },
      },
      member: { id: 'owner-id' },
      update: async () => {},
    };

    const handledBack = await handleDashboardNavigationInteraction(backInteraction);
    assert.equal(handledBack, true);
  });
});
