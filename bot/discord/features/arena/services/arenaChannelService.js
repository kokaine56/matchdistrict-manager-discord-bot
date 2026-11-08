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
  getArenaConfig,
  saveArenaConfig,
} from '../models/arenaModels.js';
import { buildCreateChallengePanel } from './arenaNotificationService.js';

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

  // 1. Ensure Main Category: "1V1 CHALLENGE ARENA"
  let mainCategory = null;
  if (config.categoryId) {
    mainCategory =
      guild.channels.cache.get(config.categoryId) ||
      (await guild.channels.fetch(config.categoryId).catch(() => null));
  }
  if (!mainCategory) {
    mainCategory = findInCache(
      guild.channels?.cache,
      (c) => c.type === ChannelType.GuildCategory && c.name.toUpperCase() === '1V1 CHALLENGE ARENA'
    );
  }
  if (!mainCategory) {
    mainCategory = await queueChannelCreate(guild, {
      name: '1V1 CHALLENGE ARENA',
      type: ChannelType.GuildCategory,
      permissionOverwrites: [
        {
          id: guild.id, // @everyone
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
          deny: [PermissionFlagsBits.SendMessages],
        },
      ],
    });
  }

  // Helper to find or create channel in main category
  async function ensureChannel(storedId, name, options = {}) {
    let ch = null;
    if (storedId) {
      ch = guild.channels.cache.get(storedId) || (await guild.channels.fetch(storedId).catch(() => null));
    }
    if (!ch) {
      ch = findInCache(
        guild.channels?.cache,
        (c) => c.parentId === mainCategory.id && c.name.toLowerCase() === name.toLowerCase()
      );
    }
    if (!ch) {
      ch = await queueChannelCreate(guild, {
        name,
        type: ChannelType.GuildText,
        parent: mainCategory.id,
        ...options,
      });
    }
    return ch;
  }

  // 2. Channels inside main category:
  // #create-challenge (read only for @everyone)
  const createChannel = await ensureChannel(config.createChannelId, 'create-challenge', {
    permissionOverwrites: [
      {
        id: guild.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
        deny: [PermissionFlagsBits.SendMessages],
      },
    ],
  });

  // #available-challenges (read only for @everyone)
  const availableChannel = await ensureChannel(config.availableChannelId, 'available-challenges', {
    permissionOverwrites: [
      {
        id: guild.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
        deny: [PermissionFlagsBits.SendMessages],
      },
    ],
  });

  // #room-maker-panel (public visibility for all server members, read only for @everyone)
  let volunteerPanel = null;
  if (config.volunteerPanelId) {
    volunteerPanel = guild.channels?.cache?.get(config.volunteerPanelId) || (await guild.channels?.fetch?.(config.volunteerPanelId).catch(() => null));
    if (volunteerPanel && volunteerPanel.name !== 'room-maker-panel' && typeof volunteerPanel.setName === 'function') {
      await volunteerPanel.setName('room-maker-panel').catch(() => {});
    }
  }
  if (!volunteerPanel) {
    volunteerPanel = findInCache(
      guild.channels?.cache,
      (c) => c.parentId === mainCategory.id && (c.name.toLowerCase() === 'room-maker-panel' || c.name.toLowerCase() === 'volunteer-panel')
    );
    if (volunteerPanel && volunteerPanel.name !== 'room-maker-panel' && typeof volunteerPanel.setName === 'function') {
      await volunteerPanel.setName('room-maker-panel').catch(() => {});
    }
  }
  if (!volunteerPanel) {
    volunteerPanel = await queueChannelCreate(guild, {
      name: 'room-maker-panel',
      type: ChannelType.GuildText,
      parent: mainCategory.id,
      permissionOverwrites: [
        {
          id: guild.id, // @everyone
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
          deny: [PermissionFlagsBits.SendMessages],
        },
      ],
    });
  }

  // Ensure @everyone can view if overwrites were previously configured with denial
  if (typeof volunteerPanel.permissionOverwrites?.edit === 'function') {
    await volunteerPanel.permissionOverwrites.edit(guild.id, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false,
    }).catch(() => { });
  }

  // #match-results (read only for @everyone)
  const matchResults = await ensureChannel(config.matchResultsId, 'match-results', {
    permissionOverwrites: [
      {
        id: guild.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
        deny: [PermissionFlagsBits.SendMessages],
      },
    ],
  });

  // #challenge-support (normal public text channel with short pinned note, no bot logic)
  const supportChannel = await ensureChannel(config.supportChannelId, 'challenge-support', {
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
  });

  // Pin note in #challenge-support if not yet pinned
  try {
    const pins = typeof supportChannel.messages?.fetchPinned === 'function'
      ? await supportChannel.messages.fetchPinned().catch(() => null)
      : null;
    if (!pins || pins.size === 0) {
      const pinMsg = await queueChannelSend(supportChannel, {
        content:
          '📌 **1v1 Challenge Arena Support**\n' +
          'Need help with a match, dispute, or rule question? Mention a volunteer or an administrator here.',
      });
      if (pinMsg && typeof pinMsg.pin === 'function') {
        await pinMsg.pin().catch(() => { });
      }
    }
  } catch (err) {
    // Ignore pinning failure in mocks
  }

  // #arena-evidence (administrators only)
  const evidenceChannel = await ensureChannel(config.evidenceChannelId, 'arena-evidence', {
    permissionOverwrites: [
      {
        id: guild.id, // @everyone
        deny: [PermissionFlagsBits.ViewChannel],
      },
    ],
  });

  // 4. Matches Category: "ARENA MATCHES"
  const matchCategories = Array.isArray(config.matchCategories) ? [...config.matchCategories] : [];
  let firstMatchCategory = null;
  if (matchCategories.length > 0) {
    firstMatchCategory =
      guild.channels.cache.get(matchCategories[0]) ||
      (await guild.channels.fetch(matchCategories[0]).catch(() => null));
  }
  if (!firstMatchCategory) {
    firstMatchCategory = findInCache(
      guild.channels?.cache,
      (c) => c.type === ChannelType.GuildCategory && c.name.toUpperCase() === 'ARENA MATCHES'
    );
  }
  if (!firstMatchCategory) {
    firstMatchCategory = await queueChannelCreate(guild, {
      name: 'ARENA MATCHES',
      type: ChannelType.GuildCategory,
      permissionOverwrites: [
        {
          id: guild.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
      ],
    });
    matchCategories.unshift(firstMatchCategory.id);
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

  // Save updated config
  const savedConfig = await saveArenaConfig(guild.id, {
    categoryId: mainCategory.id,
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

  // If full or missing, create "ARENA MATCHES N"
  const nextNum = matchCategories.length + 1;
  const catName = nextNum === 1 ? 'ARENA MATCHES' : `ARENA MATCHES ${nextNum}`;
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
  if (!matchId) return 'match-0001';
  const clean = String(matchId).trim().toLowerCase();
  const digits = clean.match(/\d+/)?.[0];
  if (!digits) return `match-${clean}`;
  if (digits.length <= 4) {
    return `match-${digits.padStart(4, '0')}`;
  }
  const num = parseInt(digits, 10);
  if (num >= 10000 && num < 20000) {
    return `match-${String(num - 10000).padStart(4, '0')}`;
  }
  return `match-${digits.slice(-4).padStart(4, '0')}`;
}

export async function createMatchChannel(guild, match, config) {
  if (!guild || !match) return null;

  const category = await getOrCreateMatchCategory(guild, config);
  const channelName = formatMatchChannelName(match.matchId);

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
      ],
    },
  ];

  // If Room Maker is already assigned (e.g. during recovery), add permissions (read-only by default)
  if (match.volunteerId) {
    permissionOverwrites.push({
      id: match.volunteerId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
      ],
      deny: [
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.AttachFiles,
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

export async function addVolunteerToMatchChannel(channel, volunteerId) {
  if (!channel || !volunteerId) return;
  if (typeof channel.permissionOverwrites?.edit === 'function') {
    await channel.permissionOverwrites.edit(volunteerId, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false,
      AttachFiles: false,
    }).catch((err) => {
      console.warn(`[Arena] ⚠️ Failed to add Room Maker ${volunteerId} to channel ${channel.id}:`, err.message);
    });
  }
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
      if (catName === '1V1 CHALLENGE ARENA' || catName.startsWith('ARENA MATCHES')) {
        targetCategoryIds.add(String(c.id));
      }
    }
  }

  // 1. Collect all child channels to delete
  const channelsToDelete = new Map();

  // Known channel IDs from config
  const knownChannelIds = [
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
        const nameLower = (c.name || '').toLowerCase();
        if (
          nameLower === 'create-challenge' ||
          nameLower === 'available-challenges' ||
          nameLower === 'volunteer-panel' ||
          nameLower === 'room-maker-panel' ||
          nameLower === 'match-results' ||
          nameLower === 'challenge-support' ||
          nameLower === 'arena-evidence' ||
          nameLower.startsWith('match-')
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
