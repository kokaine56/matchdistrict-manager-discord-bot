import {
  ChannelType,
  PermissionFlagsBits,
} from 'discord.js';
import {
  queueChannelCreate,
  queueChannelDelete,
  queueChannelSend,
  queueMessageEdit,
} from '../../../../../discordQueue.js';
import {
  ARENA_STATUS,
  getArenaConfig,
  getArenaMatchesByStatus,
  saveArenaConfig,
  formatMatchId,
} from '../models/arenaModels.js';
import { buildCreateChallengePanel, buildArenaInfoPanel } from './arenaNotificationService.js';

export const ARENA_CHANNEL_PREFIX = '1V1-TDM | ';
export const ARENA_DYNAMIC_CHANNEL_PREFIX = '𝟏𝐕𝟏 𝐓𝐃𝐌｜';

export function formatArenaChannelName(slug) {
  return `${ARENA_CHANNEL_PREFIX}${slug}`;
}

function findInCache(cache, predicate) {
  if (!cache) return null;
  if (typeof cache.find === 'function') return cache.find(predicate) || null;
  if (typeof cache.values === 'function') return Array.from(cache.values()).find(predicate) || null;
  if (Array.isArray(cache)) return cache.find(predicate) || null;
  return null;
}

export async function setupArenaChannels(guild, adminUser) {
  if (!guild) throw new Error('Guild is required');

  const config = (await getArenaConfig(guild.id)) || { guildId: guild.id };

  // 1. Ensure Main Category: "1V1 TDM"
  let mainCategory = null;
  if (config.categoryId) {
    mainCategory =
      guild.channels.cache.get(config.categoryId) ||
      (await guild.channels.fetch(config.categoryId).catch(() => null));
  }
  if (!mainCategory) {
    mainCategory = findInCache(
      guild.channels?.cache,
      (c) => c.type === ChannelType.GuildCategory && (
        c.name.toUpperCase() === '1V1 TDM' ||
        c.name.toUpperCase() === '1V1 CHALLENGE ARENA' ||
        c.name.toUpperCase() === 'ARENA MATCHES'
      )
    );
  }
  if (!mainCategory) {
    mainCategory = await queueChannelCreate(guild, {
      name: '1V1 TDM',
      type: ChannelType.GuildCategory,
      permissionOverwrites: [
        {
          id: guild.id, // @everyone
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
          deny: [
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.CreatePublicThreads,
            PermissionFlagsBits.CreatePrivateThreads,
            PermissionFlagsBits.SendMessagesInThreads,
          ],
        },
      ],
    });
  } else if (mainCategory.name !== '1V1 TDM' && typeof mainCategory.setName === 'function') {
    await mainCategory.setName('1V1 TDM').catch(() => { });
    mainCategory.name = '1V1 TDM';
  }

  // Helper to find, create or rename channel in main category
  async function ensureChannel(storedId, slug, options = {}, aliases = []) {
    const targetName = formatArenaChannelName(slug);
    const lookupNames = new Set([
      targetName.toLowerCase(),
      slug.toLowerCase(),
      `1v1-tdm | ${slug.toLowerCase()}`,
      `𝟏𝐯𝟏 𝐭𝐝𝐦｜${slug.toLowerCase()}`,
      `𝟏𝐯𝟏｜${slug.toLowerCase()}`,
      ...aliases.map((a) => a.toLowerCase()),
      ...aliases.map((a) => formatArenaChannelName(a).toLowerCase()),
      ...aliases.map((a) => `1v1-tdm | ${a.toLowerCase()}`),
      ...aliases.map((a) => `𝟏𝐯𝟏 𝐭𝐝𝐦｜${a.toLowerCase()}`),
      ...aliases.map((a) => `𝟏𝐯𝟏｜${a.toLowerCase()}`),
    ]);

    let ch = null;
    if (storedId) {
      ch = guild.channels.cache?.get(storedId) || (await guild.channels?.fetch?.(storedId).catch(() => null));
    }
    if (!ch) {
      ch = findInCache(
        guild.channels?.cache,
        (c) => c.parentId === mainCategory.id && lookupNames.has((c.name || '').toLowerCase())
      );
    }
    if (!ch) {
      ch = findInCache(
        guild.channels?.cache,
        (c) => lookupNames.has((c.name || '').toLowerCase())
      );
    }
    if (!ch) {
      ch = await queueChannelCreate(guild, {
        name: targetName,
        type: ChannelType.GuildText,
        parent: mainCategory.id,
        ...options,
      });
    }

    if (ch && ch.name !== targetName && typeof ch.setName === 'function') {
      await ch.setName(targetName).catch((err) => {
        console.warn(`[Arena] ⚠️ Failed to rename channel ${ch.id} to ${targetName}:`, err.message);
      });
      ch.name = targetName;
    }

    return ch;
  }

  const lockedChannelDeny = [
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.CreatePublicThreads,
    PermissionFlagsBits.CreatePrivateThreads,
    PermissionFlagsBits.SendMessagesInThreads,
  ];

  // 2. Channels inside main category:
  // #info (read only for @everyone, no threads)
  const infoChannel = await ensureChannel(config.infoChannelId, 'info', {
    permissionOverwrites: [
      {
        id: guild.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
        deny: lockedChannelDeny,
      },
    ],
  }, ['arena-info', '1V1-TDM | info', '𝟏𝐕𝟏 𝐓𝐃𝐌｜info', '𝟏𝐕𝟏｜arena-info']);
  if (typeof infoChannel.permissionOverwrites?.edit === 'function') {
    await infoChannel.permissionOverwrites.edit(guild.id, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      SendMessagesInThreads: false,
    }).catch(() => { });
  }

  // #create (read only for @everyone, no threads)
  const createChannel = await ensureChannel(config.createChannelId, 'create', {
    permissionOverwrites: [
      {
        id: guild.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
        deny: lockedChannelDeny,
      },
    ],
  }, ['create-challenge', '1V1-TDM | create', '𝟏𝐕𝟏 𝐓𝐃𝐌｜create-challenge', '𝟏𝐕𝟏｜create-challenge']);
  if (typeof createChannel.permissionOverwrites?.edit === 'function') {
    await createChannel.permissionOverwrites.edit(guild.id, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      SendMessagesInThreads: false,
    }).catch(() => { });
  }

  // #available-matches (read only for @everyone, no threads)
  const availableChannel = await ensureChannel(config.availableChannelId, 'available-matches', {
    permissionOverwrites: [
      {
        id: guild.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
        deny: lockedChannelDeny,
      },
    ],
  }, ['available-challenges', '1V1-TDM | available-matches', '𝟏𝐕𝟏 𝐓𝐃𝐌｜available-challenges', '𝟏𝐕𝟏｜available-challenges']);
  if (typeof availableChannel.permissionOverwrites?.edit === 'function') {
    await availableChannel.permissionOverwrites.edit(guild.id, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      SendMessagesInThreads: false,
    }).catch(() => { });
  }

  // #room-maker-panel (public visibility for all server members, read only for @everyone, no threads)
  const volunteerPanel = await ensureChannel(
    config.volunteerPanelId,
    'room-maker-panel',
    {
      permissionOverwrites: [
        {
          id: guild.id, // @everyone
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
          deny: lockedChannelDeny,
        },
      ],
    },
    ['volunteer-panel', '1V1-TDM | room-maker-panel', '𝟏𝐕𝟏 𝐓𝐃𝐌｜room-maker-panel', '𝟏𝐕𝟏｜room-maker-panel']
  );

  // Ensure @everyone can view and thread creation is disabled idempotently
  if (typeof volunteerPanel.permissionOverwrites?.edit === 'function') {
    await volunteerPanel.permissionOverwrites.edit(guild.id, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      SendMessagesInThreads: false,
    }).catch(() => { });
  }

  // #match-results (read only for @everyone, no threads)
  const matchResults = await ensureChannel(config.matchResultsId, 'match-results', {
    permissionOverwrites: [
      {
        id: guild.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
        deny: lockedChannelDeny,
      },
    ],
  }, ['1V1-TDM | match-results', '𝟏𝐕𝟏 𝐓𝐃𝐌｜match-results', '𝟏𝐕𝟏｜match-results']);
  if (typeof matchResults.permissionOverwrites?.edit === 'function') {
    await matchResults.permissionOverwrites.edit(guild.id, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      SendMessagesInThreads: false,
    }).catch(() => { });
  }

  // #match-support (normal public text channel with short pinned note, no bot logic)
  const supportChannel = await ensureChannel(config.supportChannelId, 'match-support', {
    permissionOverwrites: [
      {
        id: guild.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
    ],
  }, ['challenge-support', 'arena-support', '1V1-TDM | match-support', '𝟏𝐕𝟏 𝐓𝐃𝐌｜challenge-support', '𝟏𝐕𝟏｜challenge-support']);

  // Pin note in #match-support if not yet pinned
  try {
    const pins = typeof supportChannel.messages?.fetchPinned === 'function'
      ? await supportChannel.messages.fetchPinned().catch(() => null)
      : null;
    if (!pins || pins.size === 0) {
      const pinMsg = await queueChannelSend(supportChannel, {
        content:
          '📌 **1v1 TDM Support**\n' +
          'Need help with a match, dispute, or rule question? Mention a Room Maker or an administrator here.',
      });
      if (pinMsg && typeof pinMsg.pin === 'function') {
        await pinMsg.pin().catch(() => { });
      }
    }
  } catch (err) {
    // Ignore pinning failure in mocks
  }

  // #evidence (administrators only, no threads for @everyone)
  const evidenceChannel = await ensureChannel(config.evidenceChannelId, 'evidence', {
    permissionOverwrites: [
      {
        id: guild.id, // @everyone
        deny: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.CreatePublicThreads,
          PermissionFlagsBits.CreatePrivateThreads,
          PermissionFlagsBits.SendMessagesInThreads,
        ],
      },
    ],
  }, ['arena-evidence', '1V1-TDM | evidence', '𝟏𝐕𝟏 𝐓𝐃𝐌｜evidence', '𝟏𝐕𝟏｜arena-evidence']);
  if (typeof evidenceChannel.permissionOverwrites?.edit === 'function') {
    await evidenceChannel.permissionOverwrites.edit(guild.id, {
      ViewChannel: false,
      SendMessages: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      SendMessagesInThreads: false,
    }).catch(() => { });
  }
  if (typeof evidenceChannel.permissionOverwrites?.edit === 'function') {
    await evidenceChannel.permissionOverwrites.edit(guild.id, {
      ViewChannel: false,
      SendMessages: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      SendMessagesInThreads: false,
    }).catch(() => { });
  }

  // Rename any active match channels to adhere to naming convention
  try {
    const activeStatuses = [
      ARENA_STATUS.WAITING_FOR_VOLUNTEER,
      ARENA_STATUS.VOLUNTEER_ASSIGNED,
      ARENA_STATUS.ROOM_READY,
      ARENA_STATUS.LIVE,
      ARENA_STATUS.RESULT_PENDING,
      ARENA_STATUS.UNDER_REVIEW,
    ];
    for (const status of activeStatuses) {
      const matches = await getArenaMatchesByStatus(status, guild.id).catch(() => []);
      for (const m of matches) {
        if (m.matchChannelId) {
          const ch = guild.channels?.cache?.get(m.matchChannelId) || (await guild.channels?.fetch?.(m.matchChannelId).catch(() => null));
          const targetName = formatMatchChannelName(m.matchId);
          if (ch && ch.name !== targetName && typeof ch.setName === 'function') {
            await ch.setName(targetName).catch(() => { });
            ch.name = targetName;
          }
        }
        const rmChId = m.roomMakerChannelId || m.roomChannelId;
        if (rmChId) {
          const ch = guild.channels?.cache?.get(rmChId) || (await guild.channels?.fetch?.(rmChId).catch(() => null));
          const targetName = formatRoomMakerChannelName(m.matchId);
          if (ch && ch.name !== targetName && typeof ch.setName === 'function') {
            await ch.setName(targetName).catch(() => { });
            ch.name = targetName;
          }
        }
      }
    }
  } catch (err) {
    // Non-fatal if active match query fails during setup
  }

  // 4. Matches Category: "1V1 TDM" (organised under 1V1 TDM category without creating duplicate)
  const matchCategories = Array.isArray(config.matchCategories) ? [...config.matchCategories] : [];
  let firstMatchCategory = null;
  if (matchCategories.length > 0) {
    firstMatchCategory =
      guild.channels.cache.get(matchCategories[0]) ||
      (await guild.channels.fetch(matchCategories[0]).catch(() => null));
    if (firstMatchCategory && typeof firstMatchCategory.setName === 'function') {
      const currentName = (firstMatchCategory.name || '').toUpperCase();
      if (currentName === 'ARENA MATCHES' || currentName === '1V1 CHALLENGE ARENA') {
        await firstMatchCategory.setName('1V1 TDM').catch(() => { });
        firstMatchCategory.name = '1V1 TDM';
      }
    }
  }
  if (!firstMatchCategory) {
    firstMatchCategory = mainCategory;
    if (!matchCategories.includes(mainCategory.id)) {
      matchCategories.unshift(mainCategory.id);
    }
  }

  // 5. Persistent Panel Message in #create-challenge
  let panelMessageId = config.panelMessageId || null;
  const panelPayload = buildCreateChallengePanel();
  if (panelMessageId) {
    let existingMsg = createChannel.messages?.cache?.get(panelMessageId) || null;
    if (!existingMsg && typeof createChannel.messages?.fetch === 'function') {
      existingMsg = await createChannel.messages.fetch(panelMessageId).catch(() => null);
    }
    if (existingMsg) {
      await queueMessageEdit(existingMsg, panelPayload).catch(() => { });
    } else {
      const newMsg = await queueChannelSend(createChannel, panelPayload);
      panelMessageId = newMsg?.id || null;
    }
  } else {
    const newMsg = await queueChannelSend(createChannel, panelPayload);
    panelMessageId = newMsg?.id || null;
  }

  // 6. Persistent Information Embed in #info
  let infoMessageId = config.infoMessageId || null;
  const infoPayload = buildArenaInfoPanel({
    createChannelId: createChannel.id,
    availableChannelId: availableChannel.id,
    matchResultsId: matchResults.id,
  });

  if (infoMessageId) {
    let existingInfoMsg = infoChannel.messages?.cache?.get(infoMessageId) || null;
    if (!existingInfoMsg && typeof infoChannel.messages?.fetch === 'function') {
      existingInfoMsg = await infoChannel.messages.fetch(infoMessageId).catch(() => null);
    }
    if (existingInfoMsg) {
      await queueMessageEdit(existingInfoMsg, infoPayload).catch(() => { });
    } else {
      const newMsg = await queueChannelSend(infoChannel, infoPayload);
      infoMessageId = newMsg?.id || null;
    }
  } else {
    let existingInfoMsg = null;
    try {
      const msgs = typeof infoChannel.messages?.fetch === 'function' ? await infoChannel.messages.fetch({ limit: 5 }).catch(() => null) : null;
      if (msgs && (msgs.size > 0 || msgs.length > 0)) {
        const msgList = Array.isArray(msgs) ? msgs : Array.from(msgs.values ? msgs.values() : []);
        existingInfoMsg = msgList.find((m) => m.embeds?.[0]?.title?.includes('MATCH DISTRICT – 1V1') || m.author?.bot) || null;
      }
    } catch (_) { }

    if (existingInfoMsg) {
      await queueMessageEdit(existingInfoMsg, infoPayload).catch(() => { });
      infoMessageId = existingInfoMsg.id;
    } else {
      const newMsg = await queueChannelSend(infoChannel, infoPayload);
      infoMessageId = newMsg?.id || null;
    }
  }

  // Save updated config
  const savedConfig = await saveArenaConfig(guild.id, {
    categoryId: mainCategory.id,
    infoChannelId: infoChannel.id,
    infoMessageId,
    createChannelId: createChannel.id,
    availableChannelId: availableChannel.id,
    volunteerPanelId: volunteerPanel.id,
    matchResultsId: matchResults.id,
    supportChannelId: supportChannel.id,
    evidenceChannelId: evidenceChannel.id,
    panelMessageId,
    matchCategories,
  });

  return {
    config: savedConfig,
    mainCategory,
    infoChannel,
    createChannel,
    availableChannel,
    volunteerPanel,
    matchResults,
    supportChannel,
    evidenceChannel,
  };
}

export async function getOrCreateMatchCategory(guild, config) {
  const matchCategories = Array.isArray(config.matchCategories) ? [...config.matchCategories] : [];

  for (let i = 0; i < matchCategories.length; i++) {
    const catId = matchCategories[i];
    const category = guild.channels.cache.get(catId) || (await guild.channels.fetch(catId).catch(() => null));
    if (category) {
      if (typeof category.setName === 'function') {
        const currentName = (category.name || '').toUpperCase();
        if (currentName === 'ARENA MATCHES' || currentName === '1V1 CHALLENGE ARENA') {
          const expectedName = i === 0 ? '1V1 TDM' : `1V1 TDM ${i + 1}`;
          await category.setName(expectedName).catch(() => { });
          category.name = expectedName;
        }
      }
      // Discord's limit is 50 channels per category
      const childCount =
        category.children?.cache?.size ??
        (typeof guild.channels.cache.filter === 'function'
          ? guild.channels.cache.filter((c) => c.parentId === catId).size
          : Array.from(guild.channels.cache.values()).filter((c) => c.parentId === catId).length);
      if (childCount < 48) {
        return category;
      }
    }
  }

  // If full or missing, create "1V1 TDM N"
  const nextNum = matchCategories.length + 1;
  const catName = nextNum === 1 ? '1V1 TDM' : `1V1 TDM ${nextNum}`;
  const newCat = await queueChannelCreate(guild, {
    name: catName,
    type: ChannelType.GuildCategory,
    permissionOverwrites: [
      {
        id: guild.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
    ],
  });

  matchCategories.push(newCat.id);
  await saveArenaConfig(guild.id, { matchCategories });
  return newCat;
}

export function formatMatchChannelName(matchId) {
  const digits = formatMatchId(matchId).replace('MD-', '');
  return `${ARENA_DYNAMIC_CHANNEL_PREFIX}match-${digits}`;
}

export function formatRoomMakerChannelName(matchId) {
  const digits = formatMatchId(matchId).replace('MD-', '');
  return `${ARENA_DYNAMIC_CHANNEL_PREFIX}roommaker-${digits}`;
}

export async function createMatchChannel(guild, match, config) {
  if (!guild || !match) return null;

  const category = await getOrCreateMatchCategory(guild, config);
  const channelName = formatMatchChannelName(match.matchId);

  // Challengers' Match Channel: Player A, Player B, Admins, Bot.
  // The Room Maker must NOT have access to this channel.
  const permissionOverwrites = [
    {
      id: guild.id, // @everyone
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: match.playerA.discordId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
      ],
      deny: [
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.CreatePrivateThreads,
      ],
    },
    {
      id: match.playerB.discordId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
      ],
      deny: [
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.CreatePrivateThreads,
      ],
    },
  ];

  const channel = await queueChannelCreate(guild, {
    name: channelName,
    type: ChannelType.GuildText,
    parent: category?.id || null,
    permissionOverwrites,
  });

  return channel;
}

export async function createRoomMakerChannel(guild, match, config, roomMakerId = null) {
  if (!guild || !match) return null;

  const category = await getOrCreateMatchCategory(guild, config);
  const channelName = formatRoomMakerChannelName(match.matchId);

  // Room Maker's Private Channel: Room Maker, Admins, Bot.
  // Players must NOT have access to this channel.
  const permissionOverwrites = [
    {
      id: guild.id, // @everyone
      deny: [PermissionFlagsBits.ViewChannel],
    },
  ];

  const assignedId = roomMakerId || match.volunteerId;
  if (assignedId) {
    permissionOverwrites.push({
      id: assignedId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
      ],
      deny: [
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.CreatePrivateThreads,
        PermissionFlagsBits.SendMessagesInThreads,
      ],
    });
  }

  const channel = await queueChannelCreate(guild, {
    name: channelName,
    type: ChannelType.GuildText,
    parent: category?.id || null,
    permissionOverwrites,
  });

  return channel;
}

export async function addRoomMakerToRoomMakerChannel(channel, roomMakerId) {
  if (!channel || !roomMakerId) return;
  if (typeof channel.permissionOverwrites?.edit === 'function') {
    await channel.permissionOverwrites.edit(roomMakerId, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false,
      AttachFiles: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      SendMessagesInThreads: false,
    }).catch((err) => {
      console.warn(`[Arena] ⚠️ Failed to add Room Maker ${roomMakerId} to channel ${channel.id}:`, err.message);
    });
  }
}

export async function removeRoomMakerFromRoomMakerChannel(channel, roomMakerId) {
  if (!channel || !roomMakerId) return;
  if (typeof channel.permissionOverwrites?.delete === 'function') {
    await channel.permissionOverwrites.delete(roomMakerId).catch((err) => {
      console.warn(`[Arena] ⚠️ Failed to delete Room Maker permissions in channel ${channel.id}:`, err.message);
    });
  } else if (typeof channel.permissionOverwrites?.edit === 'function') {
    await channel.permissionOverwrites.edit(roomMakerId, {
      ViewChannel: false,
    }).catch(() => { });
  }
}

export async function addVolunteerToMatchChannel(channel, volunteerId) {
  // Room Maker and challengers must remain completely separate.
  // Room Makers must NEVER be added or granted access to the challengers channel.
  console.warn(`[Arena] ⛔ addVolunteerToMatchChannel called for ${volunteerId} on ${channel?.id}. Operation blocked to preserve separation.`);
}

export async function grantVolunteerScreenshotPermission(channel, volunteerId) {
  if (!channel || !volunteerId) return;
  if (typeof channel.permissionOverwrites?.edit === 'function') {
    await channel.permissionOverwrites.edit(volunteerId, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: true,
      AttachFiles: true,
    }).catch((err) => {
      console.warn(`[Arena] ⚠️ Failed to grant screenshot permission to volunteer ${volunteerId}:`, err.message);
    });
  }
}

export async function revokeVolunteerScreenshotPermission(channel, volunteerId) {
  if (!channel || !volunteerId) return;
  if (typeof channel.permissionOverwrites?.edit === 'function') {
    await channel.permissionOverwrites.edit(volunteerId, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false,
      AttachFiles: false,
    }).catch((err) => {
      console.warn(`[Arena] ⚠️ Failed to revoke screenshot permission from volunteer ${volunteerId}:`, err.message);
    });
  }
}

export async function removeVolunteerFromMatchChannel(channel, volunteerId) {
  if (!channel || !volunteerId) return;
  if (typeof channel.permissionOverwrites?.delete === 'function') {
    await channel.permissionOverwrites.delete(volunteerId).catch((err) => {
      console.warn(`[Arena] ⚠️ Failed to delete volunteer permissions in channel ${channel.id}:`, err.message);
    });
  } else if (typeof channel.permissionOverwrites?.edit === 'function') {
    await channel.permissionOverwrites.edit(volunteerId, {
      ViewChannel: false,
    }).catch(() => { });
  }
}

export async function deleteMatchChannel(guild, channelId) {
  if (!guild || !channelId) return;
  const channel = guild.channels?.cache?.get(channelId) || (await guild.channels?.fetch?.(channelId).catch(() => null));
  if (!channel) return;
  await queueChannelDelete(channel, 'Arena match completed or expired');
}

export async function deleteArenaChannels(guild, config = null) {
  if (!guild) throw new Error('Guild is required');

  const cfg = config || (await getArenaConfig(guild.id)) || {};
  let deletedChannels = 0;
  let deletedCategories = 0;

  // Set of category IDs to identify child channels and categories to delete
  const targetCategoryIds = new Set();
  if (cfg.categoryId) targetCategoryIds.add(String(cfg.categoryId));
  if (Array.isArray(cfg.matchCategories)) {
    for (const catId of cfg.matchCategories) {
      if (catId) targetCategoryIds.add(String(catId));
    }
  }

  // Also discover any categories by name
  const allChannels = Array.from(guild.channels?.cache?.values?.() || []);
  for (const c of allChannels) {
    if (c.type === ChannelType.GuildCategory) {
      const catName = (c.name || '').toUpperCase();
      if (
        catName === '1V1 TDM' ||
        catName.startsWith('1V1 TDM') ||
        catName === '1V1 CHALLENGE ARENA' ||
        catName.startsWith('ARENA MATCHES')
      ) {
        targetCategoryIds.add(String(c.id));
      }
    }
  }

  // 1. Collect all child channels to delete
  const channelsToDelete = new Map();

  // Known channel IDs from config
  const knownChannelIds = [
    cfg.infoChannelId,
    cfg.createChannelId,
    cfg.availableChannelId,
    cfg.volunteerPanelId,
    cfg.matchResultsId,
    cfg.supportChannelId,
    cfg.evidenceChannelId,
  ].filter(Boolean);

  for (const chId of knownChannelIds) {
    const ch = guild.channels?.cache?.get(chId) || (await guild.channels?.fetch?.(chId).catch(() => null));
    if (ch && ch.type !== ChannelType.GuildCategory) {
      channelsToDelete.set(String(ch.id), ch);
    }
  }

  // Any channel whose parent is in targetCategoryIds or matching arena channel names
  for (const c of allChannels) {
    if (c.type !== ChannelType.GuildCategory) {
      if (c.parentId && targetCategoryIds.has(String(c.parentId))) {
        channelsToDelete.set(String(c.id), c);
      } else {
        const rawName = c.name || '';
        const nameLower = rawName.toLowerCase();
        const unPrefixed = rawName.startsWith(ARENA_CHANNEL_PREFIX)
          ? rawName.slice(ARENA_CHANNEL_PREFIX.length).toLowerCase()
          : (rawName.startsWith(ARENA_DYNAMIC_CHANNEL_PREFIX)
            ? rawName.slice(ARENA_DYNAMIC_CHANNEL_PREFIX.length).toLowerCase()
            : (rawName.startsWith('𝟏𝐕𝟏｜') ? rawName.slice(4).toLowerCase() : nameLower));
        if (
          unPrefixed === 'info' ||
          unPrefixed === 'arena-info' ||
          unPrefixed === 'create' ||
          unPrefixed === 'create-challenge' ||
          unPrefixed === 'available-matches' ||
          unPrefixed === 'available-challenges' ||
          unPrefixed === 'volunteer-panel' ||
          unPrefixed === 'room-maker-panel' ||
          unPrefixed === 'match-results' ||
          unPrefixed === 'match-support' ||
          unPrefixed === 'challenge-support' ||
          unPrefixed === 'evidence' ||
          unPrefixed === 'arena-evidence' ||
          unPrefixed.startsWith('match-') ||
          unPrefixed.startsWith('roommaker-') ||
          unPrefixed.startsWith('room-') ||
          nameLower.startsWith(ARENA_CHANNEL_PREFIX.toLowerCase()) ||
          nameLower.startsWith(ARENA_DYNAMIC_CHANNEL_PREFIX.toLowerCase()) ||
          nameLower.startsWith('1v1-tdm |') ||
          nameLower.startsWith('𝟏𝐯𝟏｜')
        ) {
          channelsToDelete.set(String(c.id), c);
        }
      }
    }
  }

  // Delete all child channels first
  for (const ch of channelsToDelete.values()) {
    try {
      await queueChannelDelete(ch, '1v1 Arena Deletion');
      deletedChannels++;
    } catch (err) {
      console.warn(`[Arena] ⚠️ Failed to delete channel ${ch.name || ch.id}:`, err.message);
    }
  }

  // 2. Delete all categories
  for (const catId of targetCategoryIds) {
    const cat = guild.channels?.cache?.get(catId) || (await guild.channels?.fetch?.(catId).catch(() => null));
    if (cat) {
      try {
        await queueChannelDelete(cat, '1v1 Arena Deletion');
        deletedCategories++;
      } catch (err) {
        console.warn(`[Arena] ⚠️ Failed to delete category ${cat.name || cat.id}:`, err.message);
      }
    }
  }

  return { deletedChannels, deletedCategories };
}
