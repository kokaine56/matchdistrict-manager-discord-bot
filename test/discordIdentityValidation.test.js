import test from 'node:test';
import assert from 'node:assert/strict';

import {
  savePermanentDiscordIdentity,
  getPermanentDiscordIdentityByDiscordId,
  getPermanentDiscordIdentityByMatchDistrictId,
  saveCentralVerificationConfig,
  localPermanentIdentitiesByDiscordId,
  localPermanentIdentitiesByMDId,
  localPendingVerifications,
} from '../mongoService.js';

import {
  handleCentralVerificationMessage,
  handleCentralVerificationInteraction,
} from '../centralVerificationService.js';

function createMockGuild(guildId = 'guild-ident-test') {
  const members = new Map();
  const channels = new Map();
  const roles = new Map();

  const guild = {
    id: guildId,
    name: 'Identity Test Guild',
    members: {
      cache: members,
      fetch: async (id) => members.get(id) || null,
    },
    channels: {
      cache: channels,
      fetch: async (id) => channels.get(id) || null,
    },
    roles: {
      cache: roles,
      fetch: async (id) => roles.get(id) || null,
    },
  };
  return { guild, members, channels, roles };
}

test('Discord Identity Suite - 1. First-time link with valid code establishes permanent identity mapping', async () => {
  localPermanentIdentitiesByDiscordId.clear();
  localPermanentIdentitiesByMDId.clear();
  localPendingVerifications.clear();

  const { guild, members } = createMockGuild('guild-flow-01');
  const captainUser = { id: 'disc-capt-101', tag: 'CaptainFresh#0001', username: 'CaptainFresh' };
  members.set(captainUser.id, { id: captainUser.id, user: captainUser, roles: { add: async () => {} } });

  await saveCentralVerificationConfig(guild.id, {
    enabled: true,
    setupChannelId: 'setup-chan',
    verifyChannelId: 'verify-chan',
    serverInviteUrl: 'https://discord.gg/official-test',
  });

  // Backend mock returning first-time link success
  const originalFetch = globalThis.fetch;
  let savedBackendCheckPayload = null;

  globalThis.fetch = async (url, opts) => {
    if (url.includes('check-code')) {
      savedBackendCheckPayload = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          success: true,
          status: 'VERIFICATION_SUCCESS',
          identity_status: 'DISCORD_IDENTITY_UNLINKED',
          is_first_time_link: true,
          tournament_id: 't-solo-01',
          tournament_title: 'Solo Cup',
          tournament_format: 'solo',
          registration_id: 'reg-solo-101',
          team_name: 'Solo Fresh',
          match_district_user_id: 'usr-md-fresh-101',
          captain_user_id: 'usr-md-fresh-101',
          captain_uid: '5511223344',
          captain_name: 'FreshCaptain',
          squad: [{ ign: 'FreshCaptain', uid: '5511223344' }],
          teammates_needed: 0,
        })
      };
    }
    if (url.includes('complete')) {
      return {
        ok: true,
        json: async () => ({
          success: true,
          status: 'VERIFICATION_SUCCESS',
          registration_id: 'reg-solo-101',
          team_name: 'Solo Fresh',
          match_district_user_id: 'usr-md-fresh-101',
          captain_uid: '5511223344',
          discord_captain_id: captainUser.id,
        })
      };
    }
    return { ok: true, json: async () => ({}) };
  };

  try {
    const channelSentMessages = [];
    const mockChannel = {
      id: 'verify-chan',
      name: 'verify-here',
      guild,
      send: async (payload) => {
        channelSentMessages.push(payload);
        return { id: 'msg-' + Date.now(), delete: async () => {} };
      }
    };

    let messageDeleted = false;
    const mockMsg = {
      id: 'msg-code-01',
      guild,
      channel: mockChannel,
      author: { ...captainUser, bot: false },
      content: 'SOLO2345',
      delete: async () => { messageDeleted = true; }
    };

    const handled = await handleCentralVerificationMessage(mockMsg);
    assert.equal(handled, true);
    assert.equal(messageDeleted, true, 'User code message must be deleted');
    assert.ok(savedBackendCheckPayload);
    assert.equal(savedBackendCheckPayload.discord_user_id, captainUser.id);

    // Verify permanent identity was established with canonical matchDistrictUserId (usr-md-fresh-101), NOT captain_uid!
    const linked = await getPermanentDiscordIdentityByDiscordId(captainUser.id);
    assert.ok(linked, 'Permanent identity record must be created');
    assert.equal(linked.matchDistrictUserId, 'usr-md-fresh-101', 'Must store canonical Match District user ID');
    assert.notEqual(linked.matchDistrictUserId, '5511223344', 'Must NEVER store game character UID as user ID');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Discord Identity Suite - 2. Existing Discord link belongs to SAME Match District user -> verification allowed', async () => {
  localPermanentIdentitiesByDiscordId.clear();
  localPermanentIdentitiesByMDId.clear();
  localPendingVerifications.clear();

  const captainDiscordId = 'disc-capt-202';
  const mdUserId = 'usr-md-202';

  // Pre-establish identity
  await savePermanentDiscordIdentity({
    matchDistrictUserId: mdUserId,
    discordUserId: captainDiscordId,
    discordUsername: 'ExistingCapt#0001',
  });

  const { guild, members } = createMockGuild('guild-flow-02');
  const captainUser = { id: captainDiscordId, tag: 'ExistingCapt#0001', username: 'ExistingCapt' };
  members.set(captainDiscordId, { id: captainDiscordId, user: captainUser, roles: { add: async () => {} } });

  await saveCentralVerificationConfig(guild.id, {
    enabled: true,
    setupChannelId: 'setup-chan',
    verifyChannelId: 'verify-chan',
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('check-code')) {
      return {
        ok: true,
        json: async () => ({
          success: true,
          status: 'VERIFICATION_SUCCESS',
          tournament_id: 't-solo-02',
          tournament_title: 'Solo Cup 2',
          tournament_format: 'solo',
          registration_id: 'reg-solo-202',
          team_name: 'Solo Existing',
          match_district_user_id: mdUserId,
          captain_user_id: mdUserId,
          captain_uid: '5599887766',
          squad: [],
          teammates_needed: 0,
        })
      };
    }
    if (url.includes('complete')) {
      return {
        ok: true,
        json: async () => ({
          success: true,
          registration_id: 'reg-solo-202',
          team_name: 'Solo Existing',
          match_district_user_id: mdUserId,
          captain_uid: '5599887766',
          discord_captain_id: captainDiscordId,
        })
      };
    }
    return { ok: true, json: async () => ({}) };
  };

  try {
    const mockChannel = {
      id: 'verify-chan',
      name: 'verify-here',
      guild,
      send: async () => ({ id: 'msg-confirm', delete: async () => {} }),
    };

    const mockMsg = {
      id: 'msg-code-02',
      guild,
      channel: mockChannel,
      author: { ...captainUser, bot: false },
      content: 'EXIST234',
      delete: async () => {},
    };

    const handled = await handleCentralVerificationMessage(mockMsg);
    assert.equal(handled, true);

    const linked = await getPermanentDiscordIdentityByDiscordId(captainDiscordId);
    assert.equal(linked.matchDistrictUserId, mdUserId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Discord Identity Suite - 3. Existing Discord link belongs to DIFFERENT user -> rejected with DISCORD_IDENTITY_CONFLICT', async () => {
  localPermanentIdentitiesByDiscordId.clear();
  localPermanentIdentitiesByMDId.clear();
  localPendingVerifications.clear();

  const captainDiscordId = 'disc-capt-303';
  // User is permanently linked to User Alpha
  await savePermanentDiscordIdentity({
    matchDistrictUserId: 'usr-alpha-111',
    discordUserId: captainDiscordId,
    discordUsername: 'AlphaCapt#0001',
  });

  const { guild, members } = createMockGuild('guild-flow-03');
  const captainUser = { id: captainDiscordId, tag: 'AlphaCapt#0001', username: 'AlphaCapt' };
  members.set(captainDiscordId, { id: captainDiscordId, user: captainUser, roles: { add: async () => {} } });

  await saveCentralVerificationConfig(guild.id, {
    enabled: true,
    setupChannelId: 'setup-chan',
    verifyChannelId: 'verify-chan',
  });

  const originalFetch = globalThis.fetch;
  // Backend returns code belonging to User Beta
  globalThis.fetch = async (url) => {
    if (url.includes('check-code')) {
      return {
        ok: false,
        json: async () => ({
          success: false,
          error: 'DISCORD_IDENTITY_CONFLICT',
          reason: 'DISCORD_IDENTITY_CONFLICT',
          message: '❌ This Discord account is already linked to a different Match District account.',
        })
      };
    }
    return { ok: true, json: async () => ({}) };
  };

  try {
    let sentNotice = '';
    const mockChannel = {
      id: 'verify-chan',
      name: 'verify-here',
      guild,
      send: async (msg) => {
        sentNotice = msg.content;
        return { id: 'msg-notice', delete: async () => {} };
      }
    };

    const mockMsg = {
      id: 'msg-code-03',
      guild,
      channel: mockChannel,
      author: { ...captainUser, bot: false },
      content: 'BETAC0DE',
      delete: async () => {},
    };

    const handled = await handleCentralVerificationMessage(mockMsg);
    assert.equal(handled, true);
    assert.match(sentNotice, /already linked to a different Match District account/i);

    // Verify identity was NOT overwritten or corrupted
    const preserved = await getPermanentDiscordIdentityByDiscordId(captainDiscordId);
    assert.equal(preserved.matchDistrictUserId, 'usr-alpha-111');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Discord Identity Suite - 4. Registration already verified -> rejected with CODE_ALREADY_VERIFIED', async () => {
  localPermanentIdentitiesByDiscordId.clear();
  localPermanentIdentitiesByMDId.clear();
  localPendingVerifications.clear();

  const { guild, members } = createMockGuild('guild-flow-04');
  const captainUser = { id: 'disc-capt-404', tag: 'UsedCapt#0001', username: 'UsedCapt' };
  members.set(captainUser.id, { id: captainUser.id, user: captainUser, roles: { add: async () => {} } });

  await saveCentralVerificationConfig(guild.id, {
    enabled: true,
    setupChannelId: 'setup-chan',
    verifyChannelId: 'verify-chan',
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('check-code')) {
      return {
        ok: false,
        json: async () => ({
          success: false,
          error: 'CODE_ALREADY_VERIFIED',
          reason: 'CODE_ALREADY_VERIFIED',
          message: '❌ This tournament registration has already been verified on Discord.',
        })
      };
    }
    return { ok: true, json: async () => ({}) };
  };

  try {
    let sentNotice = '';
    const mockChannel = {
      id: 'verify-chan',
      name: 'verify-here',
      guild,
      send: async (msg) => {
        sentNotice = msg.content;
        return { id: 'msg-notice', delete: async () => {} };
      }
    };

    const mockMsg = {
      id: 'msg-code-04',
      guild,
      channel: mockChannel,
      author: { ...captainUser, bot: false },
      content: 'USEDCODE',
      delete: async () => {},
    };

    const handled = await handleCentralVerificationMessage(mockMsg);
    assert.equal(handled, true);
    assert.match(sentNotice, /already been verified on Discord/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Discord Identity Suite - 5. Concurrency & idempotency on savePermanentDiscordIdentity', async () => {
  localPermanentIdentitiesByDiscordId.clear();
  localPermanentIdentitiesByMDId.clear();

  const targetDiscordId = 'disc-race-505';
  const targetMdId = 'usr-race-505';

  const [res1, res2] = await Promise.all([
    savePermanentDiscordIdentity({
      matchDistrictUserId: targetMdId,
      discordUserId: targetDiscordId,
      discordUsername: 'Racer#1',
    }),
    savePermanentDiscordIdentity({
      matchDistrictUserId: targetMdId,
      discordUserId: targetDiscordId,
      discordUsername: 'Racer#1',
    }),
  ]);

  assert.equal(res1.matchDistrictUserId, targetMdId);
  assert.equal(res2.matchDistrictUserId, targetMdId);
  assert.equal(localPermanentIdentitiesByDiscordId.size, 1);
  assert.equal(localPermanentIdentitiesByMDId.size, 1);
});

test('Discord Identity Suite - 6. Duo Deferred Verification flow with first-time identity establishment', async () => {
  localPermanentIdentitiesByDiscordId.clear();
  localPermanentIdentitiesByMDId.clear();
  localPendingVerifications.clear();

  const { guild, members } = createMockGuild('guild-flow-06');
  const captainUser = { id: 'disc-duo-capt', tag: 'DuoCaptain#0001', username: 'DuoCaptain' };
  const teammateUser = { id: 'disc-duo-mate', tag: 'DuoMate#0002', username: 'DuoMate' };
  members.set(captainUser.id, { id: captainUser.id, user: captainUser, roles: { add: async () => {} } });
  members.set(teammateUser.id, { id: teammateUser.id, user: teammateUser, roles: { add: async () => {} } });

  await saveCentralVerificationConfig(guild.id, {
    enabled: true,
    setupChannelId: 'setup-chan',
    verifyChannelId: 'verify-chan',
    serverInviteUrl: 'https://discord.gg/matchdistrict',
  });

  const originalFetch = globalThis.fetch;
  let completePayload = null;

  globalThis.fetch = async (url, opts) => {
    if (url.includes('check-code')) {
      return {
        ok: true,
        json: async () => ({
          success: true,
          status: 'VERIFICATION_SUCCESS',
          tournament_id: 't-duo-flow',
          tournament_title: 'Duo Flow Tournament',
          tournament_format: 'duo',
          registration_id: 'reg-duo-flow',
          team_name: 'Duo Legends',
          match_district_user_id: 'usr-duo-capt-md',
          captain_uid: '5566778899',
          captain_name: 'DuoCaptain',
          squad: [],
          teammates_needed: 1,
        })
      };
    }
    if (url.includes('complete')) {
      completePayload = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          success: true,
          status: 'VERIFICATION_SUCCESS',
          registration_id: 'reg-duo-flow',
          team_name: 'Duo Legends',
          match_district_user_id: 'usr-duo-capt-md',
          captain_uid: '5566778899',
          discord_captain_id: captainUser.id,
          discord_member_ids: [teammateUser.id],
        })
      };
    }
    return { ok: true, json: async () => ({}) };
  };

  try {
    let sentPrompt = null;
    const mockChannel = {
      id: 'verify-chan',
      name: 'verify-here',
      guild,
      send: async (msg) => {
        sentPrompt = msg;
        return { id: 'msg-prompt-duo', delete: async () => {} };
      }
    };

    const mockMsg = {
      id: 'msg-code-duo',
      guild,
      channel: mockChannel,
      author: { ...captainUser, bot: false },
      content: 'DUOCODE1',
      delete: async () => {},
    };

    await handleCentralVerificationMessage(mockMsg);
    assert.ok(sentPrompt);

    // Captain selects 1 teammate via UserSelectMenu
    const pendingSession = Array.from(localPendingVerifications.values())[0];
    assert.ok(pendingSession);
    assert.equal(pendingSession.matchDistrictUserId, 'usr-duo-capt-md');

    let replyMsg = '';
    const mockSelectInteraction = {
      guild,
      channel: mockChannel,
      customId: `cver:select:${pendingSession.pendingId}`,
      user: captainUser,
      values: [teammateUser.id],
      isUserSelectMenu: () => true,
      deferUpdate: async () => {},
      followUp: async (opts) => { replyMsg = opts.content || ''; },
      reply: async (opts) => { replyMsg = opts.content || ''; },
    };

    const handledSelect = await handleCentralVerificationInteraction(mockSelectInteraction);
    assert.equal(handledSelect, true);
    assert.ok(completePayload);
    assert.equal(completePayload.captain_discord_id, captainUser.id);
    assert.deepEqual(completePayload.teammate_discord_ids, [teammateUser.id]);

    // Check permanent identity
    const linked = await getPermanentDiscordIdentityByDiscordId(captainUser.id);
    assert.equal(linked.matchDistrictUserId, 'usr-duo-capt-md');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Discord Identity Suite - 7. Squad Deferred Verification flow with 3 teammates and identity linking', async () => {
  localPermanentIdentitiesByDiscordId.clear();
  localPermanentIdentitiesByMDId.clear();
  localPendingVerifications.clear();

  const { guild, members } = createMockGuild('guild-flow-07');
  const captainUser = { id: 'disc-sq-capt', tag: 'SqCaptain#0001', username: 'SqCaptain' };
  const tm1 = { id: 'disc-sq-tm1', tag: 'SqTm1#0001', username: 'SqTm1' };
  const tm2 = { id: 'disc-sq-tm2', tag: 'SqTm2#0002', username: 'SqTm2' };
  const tm3 = { id: 'disc-sq-tm3', tag: 'SqTm3#0003', username: 'SqTm3' };

  for (const u of [captainUser, tm1, tm2, tm3]) {
    members.set(u.id, { id: u.id, user: u, roles: { add: async () => {} } });
  }

  await saveCentralVerificationConfig(guild.id, {
    enabled: true,
    setupChannelId: 'setup-chan',
    verifyChannelId: 'verify-chan',
  });

  const originalFetch = globalThis.fetch;
  let completePayload = null;

  globalThis.fetch = async (url, opts) => {
    if (url.includes('check-code')) {
      return {
        ok: true,
        json: async () => ({
          success: true,
          status: 'VERIFICATION_SUCCESS',
          tournament_id: 't-squad-flow',
          tournament_title: 'Squad Championship',
          tournament_format: 'squad',
          registration_id: 'reg-sq-flow',
          team_name: 'Squad Four Stars',
          match_district_user_id: 'usr-sq-capt-md',
          captain_uid: '5577889900',
          captain_name: 'SqCaptain',
          squad: [],
          teammates_needed: 3,
        })
      };
    }
    if (url.includes('complete')) {
      completePayload = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          success: true,
          status: 'VERIFICATION_SUCCESS',
          registration_id: 'reg-sq-flow',
          team_name: 'Squad Four Stars',
          match_district_user_id: 'usr-sq-capt-md',
          captain_uid: '5577889900',
          discord_captain_id: captainUser.id,
          discord_member_ids: [tm1.id, tm2.id, tm3.id],
        })
      };
    }
    return { ok: true, json: async () => ({}) };
  };

  try {
    const mockChannel = {
      id: 'verify-chan',
      name: 'verify-here',
      guild,
      send: async () => ({ id: 'msg-prompt-sq', delete: async () => {} }),
    };

    const mockMsg = {
      id: 'msg-code-sq',
      guild,
      channel: mockChannel,
      author: { ...captainUser, bot: false },
      content: 'SQUAD123',
      delete: async () => {},
    };

    await handleCentralVerificationMessage(mockMsg);

    const pendingSession = Array.from(localPendingVerifications.values())[0];
    assert.ok(pendingSession);
    assert.equal(pendingSession.teammatesNeeded, 3);

    const mockSelectInteraction = {
      guild,
      channel: mockChannel,
      customId: `cver:select:${pendingSession.pendingId}`,
      user: captainUser,
      values: [tm1.id, tm2.id, tm3.id],
      isUserSelectMenu: () => true,
      deferUpdate: async () => {},
      followUp: async () => {},
      reply: async () => {},
    };

    const handledSelect = await handleCentralVerificationInteraction(mockSelectInteraction);
    assert.equal(handledSelect, true);
    assert.deepEqual(completePayload.teammate_discord_ids, [tm1.id, tm2.id, tm3.id]);

    const linked = await getPermanentDiscordIdentityByDiscordId(captainUser.id);
    assert.equal(linked.matchDistrictUserId, 'usr-sq-capt-md');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Discord Identity Suite - 8. Invalid code returns CODE_INVALID error message', async () => {
  localPermanentIdentitiesByDiscordId.clear();
  localPermanentIdentitiesByMDId.clear();
  localPendingVerifications.clear();

  const { guild, members } = createMockGuild('guild-flow-08');
  const captainUser = { id: 'disc-capt-08', tag: 'BadCodeCapt#0001', username: 'BadCodeCapt' };
  members.set(captainUser.id, { id: captainUser.id, user: captainUser, roles: { add: async () => {} } });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('check-code')) {
      return {
        ok: false,
        json: async () => ({
          success: false,
          error: 'CODE_INVALID',
          reason: 'CODE_INVALID',
          message: 'Verification code not found.',
        })
      };
    }
    return { ok: true, json: async () => ({}) };
  };

  try {
    let sentNotice = '';
    const mockChannel = {
      id: 'verify-chan',
      name: 'verify-here',
      guild,
      send: async (msg) => {
        sentNotice = msg.content;
        return { id: 'msg-notice-08', delete: async () => {} };
      }
    };

    const mockMsg = {
      id: 'msg-code-08',
      guild,
      channel: mockChannel,
      author: { ...captainUser, bot: false },
      content: 'NOTEXIST',
      delete: async () => {},
    };

    const handled = await handleCentralVerificationMessage(mockMsg);
    assert.equal(handled, true);
    assert.match(sentNotice, /Verification code not found/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Discord Identity Suite - 9. Cancelled registration returns CODE_NOT_ELIGIBLE error message', async () => {
  localPermanentIdentitiesByDiscordId.clear();
  localPermanentIdentitiesByMDId.clear();
  localPendingVerifications.clear();

  const { guild, members } = createMockGuild('guild-flow-09');
  const captainUser = { id: 'disc-capt-09', tag: 'CancelledCapt#0001', username: 'CancelledCapt' };
  members.set(captainUser.id, { id: captainUser.id, user: captainUser, roles: { add: async () => {} } });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('check-code')) {
      return {
        ok: false,
        json: async () => ({
          success: false,
          error: 'CODE_NOT_ELIGIBLE',
          reason: 'CODE_NOT_ELIGIBLE',
          message: 'This verification code is no longer valid because the registration was rejected or cancelled.',
        })
      };
    }
    return { ok: true, json: async () => ({}) };
  };

  try {
    let sentNotice = '';
    const mockChannel = {
      id: 'verify-chan',
      name: 'verify-here',
      guild,
      send: async (msg) => {
        sentNotice = msg.content;
        return { id: 'msg-notice-09', delete: async () => {} };
      }
    };

    const mockMsg = {
      id: 'msg-code-09',
      guild,
      channel: mockChannel,
      author: { ...captainUser, bot: false },
      content: 'CANCLD01',
      delete: async () => {},
    };

    const handled = await handleCentralVerificationMessage(mockMsg);
    assert.equal(handled, true);
    assert.match(sentNotice, /rejected or cancelled/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Discord Identity Suite - 10. Database conflict returns IDENTITY_DATA_CONFLICT error message', async () => {
  localPermanentIdentitiesByDiscordId.clear();
  localPermanentIdentitiesByMDId.clear();
  localPendingVerifications.clear();

  const { guild, members } = createMockGuild('guild-flow-10');
  const captainUser = { id: 'disc-capt-10', tag: 'ConflictCapt#0001', username: 'ConflictCapt' };
  members.set(captainUser.id, { id: captainUser.id, user: captainUser, roles: { add: async () => {} } });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('check-code')) {
      return {
        ok: false,
        json: async () => ({
          success: false,
          error: 'IDENTITY_DATA_CONFLICT',
          reason: 'IDENTITY_DATA_CONFLICT',
          message: 'Identity database conflict detected. Please contact tournament support.',
        })
      };
    }
    return { ok: true, json: async () => ({}) };
  };

  try {
    let sentNotice = '';
    const mockChannel = {
      id: 'verify-chan',
      name: 'verify-here',
      guild,
      send: async (msg) => {
        sentNotice = msg.content;
        return { id: 'msg-notice-10', delete: async () => {} };
      }
    };

    const mockMsg = {
      id: 'msg-code-10',
      guild,
      channel: mockChannel,
      author: { ...captainUser, bot: false },
      content: 'DATACONF',
      delete: async () => {},
    };

    const handled = await handleCentralVerificationMessage(mockMsg);
    assert.equal(handled, true);
    assert.match(sentNotice, /Identity database conflict detected/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
