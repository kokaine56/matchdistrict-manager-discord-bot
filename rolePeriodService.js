import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { getMongoDb, isMongoConnected } from './mongoService.js';
import { queueRoleAdd, queueRoleRemove } from './discordQueue.js';

export const ROLE_PERIOD_COLLECTION = 'discord_role_period_configs';
export const ROLE_PERIOD_MEMBERS_COLLECTION = 'discord_role_period_members';
export const ROLE_PERIOD_PREFIX = 'role_period:';

// In-memory cache for configs: Map<guildId, ConfigDoc>
export const rolePeriodConfigCache = new Map();

// In-memory wizard sessions: Map<sessionId, SessionState>
export const rolePeriodSessions = new Map();

// Lock to prevent simultaneous sync operations per guild: Set<guildId>
export const activeSyncOperations = new Set();

// Scheduler timer reference
let backgroundSchedulerTimer = null;
let isSchedulerRunning = false;

// Time conversion constants in milliseconds (fixed day/week constants)
export const DURATION_UNITS = {
  DAYS: 'days',
  WEEKS: 'weeks',
  MONTHS: 'months',
};

export const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const MS_PER_WEEK = 7 * MS_PER_DAY;

/**
 * Normalizes a duration unit into 'days', 'weeks', or 'months'.
 * @param {string} unit
 * @returns {'days'|'weeks'|'months'}
 */
export function normalizeDurationUnit(unit) {
  const u = String(unit || 'days').toLowerCase().trim();
  if (u.startsWith('week')) return 'weeks';
  if (u.startsWith('month')) return 'months';
  return 'days';
}

/**
 * Calculates the exact milestone Date for a member based on their joining date and duration.
 * Uses native UTC calendar arithmetic to accurately handle:
 * - 15 days = 15 actual calendar days
 * - 3 months = 3 calendar months (e.g. Jan 17 -> April 17)
 * - 6 months = 6 calendar months (e.g. Jan 17 -> July 17)
 * - 12 months = 12 calendar months / 1 year
 * - Month-end date adjustments (e.g. Jan 31 + 1 month = Feb 28 or Feb 29 in leap year)
 * - Leap years and variable month lengths
 *
 * @param {number|Date} joinedTimestamp Member's join timestamp or Date
 * @param {number} value Duration value (e.g. 0, 15, 3, 6)
 * @param {'days'|'weeks'|'months'} unit Duration unit
 * @returns {Date} The exact milestone Date
 */
export function calculateMilestoneDate(joinedTimestamp, value, unit) {
  const baseDate = new Date(joinedTimestamp);
  const num = Number(value);
  if (isNaN(num) || num <= 0) {
    return new Date(baseDate.getTime());
  }

  const cleanUnit = normalizeDurationUnit(unit);

  if (cleanUnit === 'days') {
    const target = new Date(baseDate.getTime());
    target.setUTCDate(target.getUTCDate() + num);
    return target;
  }

  if (cleanUnit === 'weeks') {
    const target = new Date(baseDate.getTime());
    target.setUTCDate(target.getUTCDate() + num * 7);
    return target;
  }

  if (cleanUnit === 'months') {
    const origYear = baseDate.getUTCFullYear();
    const origMonth = baseDate.getUTCMonth();
    const origDay = baseDate.getUTCDate();
    const origHours = baseDate.getUTCHours();
    const origMinutes = baseDate.getUTCMinutes();
    const origSeconds = baseDate.getUTCSeconds();
    const origMs = baseDate.getUTCMilliseconds();

    // Target year and month calculation
    const totalMonths = origMonth + num;
    const targetYear = origYear + Math.floor(totalMonths / 12);
    const targetMonth = ((totalMonths % 12) + 12) % 12;

    // Number of days in target month: (Day 0 of targetMonth + 1 gives last day of targetMonth)
    const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();

    // If original day exceeds days in target month (e.g. Jan 31 -> Feb), clamp to end of month (Feb 28/29)
    const targetDay = Math.min(origDay, daysInTargetMonth);

    return new Date(Date.UTC(targetYear, targetMonth, targetDay, origHours, origMinutes, origSeconds, origMs));
  }

  // Fallback
  return new Date(baseDate.getTime() + num * MS_PER_DAY);
}

/**
 * Formats duration in human-readable text.
 * e.g. "Immediately (0 days)", "15 days", "3 months", "6 months"
 * @param {number} durationMs Legacy / approximate ms (if value/unit absent)
 * @param {number} [value=null]
 * @param {string} [unit=null]
 * @returns {string}
 */
export function formatDurationText(durationMs, value = null, unit = null) {
  if (value === 0 || (value == null && durationMs === 0)) {
    return 'Immediately (0 days)';
  }
  if (value != null && unit != null && Number(value) > 0) {
    const cleanUnit = normalizeDurationUnit(unit).replace(/s$/, '');
    const num = Number(value);
    return `${num} ${cleanUnit}${num > 1 ? 's' : ''}`;
  }

  // Fallback if only legacy durationMs exists
  const approxDays = Math.round(durationMs / MS_PER_DAY);
  if (approxDays % 30 === 0 && approxDays >= 30) {
    const mos = Math.round(approxDays / 30);
    return `${mos} month${mos > 1 ? 's' : ''}`;
  }
  if (approxDays % 7 === 0 && approxDays >= 7) {
    const wks = Math.round(approxDays / 7);
    return `${wks} week${wks > 1 ? 's' : ''}`;
  }
  return `${approxDays} day${approxDays !== 1 ? 's' : ''}`;
}

/**
 * Formats remaining time in ms into human-readable string.
 * @param {number} msRemaining
 * @returns {string}
 */
export function formatTimeRemaining(msRemaining) {
  if (msRemaining <= 0) return 'Eligible now';
  const totalSeconds = Math.floor(msRemaining / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);

  return parts.join(' ');
}

/**
 * Converts a value and unit into representative milliseconds (used for sorting stages only).
 * @param {number} value
 * @param {'days'|'weeks'|'months'} unit
 * @returns {number}
 */
export function convertToMs(value, unit) {
  const num = Number(value);
  if (isNaN(num) || num < 0) return 0;
  const u = normalizeDurationUnit(unit);
  if (u === 'weeks') return num * MS_PER_WEEK;
  if (u === 'months') return num * 30 * MS_PER_DAY;
  return num * MS_PER_DAY;
}

/**
 * Checks if a member has Admin or Manage Server permission.
 * @param {import('discord.js').GuildMember} member
 * @param {import('discord.js').Guild} [guild]
 * @returns {boolean}
 */
export function canMemberManageRolePeriod(member, guild = null) {
  if (!member) return false;
  const effectiveGuild = guild || member.guild;
  if (effectiveGuild?.ownerId === member.id) return true;
  if (member.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;
  if (member.permissions?.has?.(PermissionFlagsBits.ManageGuild)) return true;
  if (typeof member.permissions?.has === 'function') {
    if (member.permissions.has('Administrator') || member.permissions.has('ManageGuild')) return true;
  }
  return false;
}

/**
 * Checks if the bot has Manage Roles permission.
 * @param {import('discord.js').Guild} guild
 * @returns {boolean}
 */
export function canBotManageRoles(guild) {
  if (!guild) return false;
  const botMember = guild.members?.me;
  if (!botMember) return false;
  if (botMember.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;
  if (botMember.permissions?.has?.(PermissionFlagsBits.ManageRoles)) return true;
  if (typeof botMember.permissions?.has === 'function') {
    return botMember.permissions.has('Administrator') || botMember.permissions.has('ManageRoles');
  }
  return false;
}

/**
 * Filters all assignable roles strictly below the bot's highest role.
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildMember} [member]
 * @returns {Array<import('discord.js').Role>}
 */
export function getAssignableProgressionRoles(guild, member = null) {
  if (!guild || !guild.roles?.cache) return [];

  const botMember = guild.members?.me;
  const botHighest = botMember?.roles?.highest?.position ?? -1;
  const memberHighest =
    member && guild.ownerId !== member.id
      ? (member.roles?.highest?.position ?? -1)
      : Infinity;

  const roles = Array.from(guild.roles.cache.values()).filter((role) => {
    if (role.id === guild.id) return false; // @everyone
    if (role.managed) return false; // Bot integrations
    if (botHighest !== -1 && role.position >= botHighest) return false;
    if (memberHighest !== Infinity && role.position >= memberHighest) return false;
    return true;
  });

  return roles.sort((a, b) => b.position - a.position);
}

/**
 * Ensures indexes exist in MongoDB for role progression configs and members.
 * @param {import('mongodb').Db} db
 */
export async function ensureRolePeriodIndexes(db) {
  if (!db) return;
  try {
    const configCol = db.collection(ROLE_PERIOD_COLLECTION);
    await configCol.createIndex({ guildId: 1 }, { unique: true });

    const memberCol = db.collection(ROLE_PERIOD_MEMBERS_COLLECTION);
    await memberCol.createIndex({ guildId: 1, userId: 1 }, { unique: true });
    await memberCol.createIndex({ guildId: 1, joinedTimestamp: 1 });
  } catch (err) {
    console.warn('[RolePeriod] ⚠️ Index creation warning:', err.message);
  }
}

/**
 * Loads all role period configs from MongoDB into memory cache.
 */
export async function loadAllRolePeriodConfigsFromDb() {
  rolePeriodConfigCache.clear();
  if (!isMongoConnected()) return;
  try {
    const db = getMongoDb();
    if (!db) return;
    const col = db.collection(ROLE_PERIOD_COLLECTION);
    const docs = await col.find({}).toArray();
    for (const doc of docs) {
      if (doc?.guildId) {
        rolePeriodConfigCache.set(String(doc.guildId), normalizeProgressionConfig(doc));
      }
    }
    console.log(`[RolePeriod] 📥 Loaded ${rolePeriodConfigCache.size} progression config(s) into cache.`);
  } catch (err) {
    console.warn('[RolePeriod] ⚠️ Error loading configs from MongoDB:', err.message);
  }
}

/**
 * Normalizes configuration schema and ensures stages are sorted ascending.
 * Preserves durationValue and durationUnit faithfully.
 * @param {object} doc
 * @returns {object}
 */
export function normalizeProgressionConfig(doc) {
  if (!doc) return null;
  const stages = Array.isArray(doc.stages)
    ? doc.stages.map((s, idx) => {
        const dUnit = normalizeDurationUnit(s.durationUnit);
        let dVal = s.durationValue;
        if (dVal == null) {
          // If durationValue was missing from legacy documents, infer from durationMs
          const ms = Number(s.durationMs || 0);
          if (ms === 0) dVal = 0;
          else if (dUnit === 'months') dVal = Math.round(ms / (30 * MS_PER_DAY));
          else if (dUnit === 'weeks') dVal = Math.round(ms / MS_PER_WEEK);
          else dVal = Math.round(ms / MS_PER_DAY);
        } else {
          dVal = Number(dVal);
        }

        const effectiveMs = Number(s.durationMs || convertToMs(dVal, dUnit));

        return {
          stageNumber: idx + 1,
          roleId: String(s.roleId),
          roleName: String(s.roleName || ''),
          durationMs: effectiveMs,
          durationValue: dVal,
          durationUnit: dUnit,
          description: s.description || (dVal === 0 ? 'Assigned immediately on joining' : `After ${formatDurationText(effectiveMs, dVal, dUnit)}`),
        };
      })
    : [];

  // Sort ascending by representative duration so Stage 1 is earliest milestone
  stages.sort((a, b) => a.durationMs - b.durationMs);
  // Re-index stageNumber 1..N
  stages.forEach((s, i) => {
    s.stageNumber = i + 1;
  });

  return {
    guildId: String(doc.guildId),
    enabled: doc.enabled !== false && stages.length > 0,
    stages,
    lastSyncedAt: doc.lastSyncedAt ? new Date(doc.lastSyncedAt) : null,
    lastSyncStats: doc.lastSyncStats || null,
    updatedAt: doc.updatedAt || new Date(),
    updatedBy: doc.updatedBy || null,
  };
}

/**
 * Gets progression config for a guild (cache with MongoDB fallback).
 * @param {string} guildId
 * @returns {Promise<object|null>}
 */
export async function getProgressionConfig(guildId) {
  if (!guildId) return null;
  const strId = String(guildId);
  if (rolePeriodConfigCache.has(strId)) {
    return rolePeriodConfigCache.get(strId);
  }
  if (!isMongoConnected()) return null;
  try {
    const db = getMongoDb();
    if (!db) return null;
    const col = db.collection(ROLE_PERIOD_COLLECTION);
    const doc = await col.findOne({ guildId: strId });
    if (doc) {
      const normalized = normalizeProgressionConfig(doc);
      rolePeriodConfigCache.set(strId, normalized);
      return normalized;
    }
  } catch (err) {
    console.warn(`[RolePeriod] ⚠️ Failed to fetch config for guild ${guildId}:`, err.message);
  }
  return null;
}

/**
 * Saves progression config to MongoDB and memory cache.
 * @param {string} guildId
 * @param {object} config
 * @returns {Promise<boolean>}
 */
export async function saveProgressionConfig(guildId, config) {
  if (!guildId) return false;
  const strId = String(guildId);
  const normalized = normalizeProgressionConfig({ ...config, guildId: strId, updatedAt: new Date() });
  rolePeriodConfigCache.set(strId, normalized);

  if (!isMongoConnected()) return true;
  try {
    const db = getMongoDb();
    if (!db) return true;
    const col = db.collection(ROLE_PERIOD_COLLECTION);
    await col.updateOne({ guildId: strId }, { $set: normalized }, { upsert: true });
    return true;
  } catch (err) {
    console.warn(`[RolePeriod] ⚠️ Failed to save config for guild ${guildId}:`, err.message);
    return false;
  }
}

/**
 * Deletes progression config from MongoDB and memory cache.
 * Note: Does NOT remove roles from server members.
 * @param {string} guildId
 * @returns {Promise<boolean>}
 */
export async function deleteProgressionConfig(guildId) {
  if (!guildId) return false;
  const strId = String(guildId);
  rolePeriodConfigCache.delete(strId);

  if (!isMongoConnected()) return true;
  try {
    const db = getMongoDb();
    if (!db) return true;
    const col = db.collection(ROLE_PERIOD_COLLECTION);
    await col.deleteOne({ guildId: strId });
    return true;
  } catch (err) {
    console.warn(`[RolePeriod] ⚠️ Failed to delete config for guild ${guildId}:`, err.message);
    return false;
  }
}

/**
 * Authoritatively retrieves the server join timestamp (in ms) directly from the Discord Guild Member object.
 * Uses member.joinedTimestamp or member.joinedAt.
 * Returns null if Discord does not provide a valid join date.
 * STRICTLY PROHIBITED: user.createdTimestamp, account creation date, bot installation date, server creation date.
 *
 * @param {import('discord.js').GuildMember} member
 * @returns {number|null} Server join timestamp in milliseconds or null if unverified
 */
export function getDiscordMemberJoinTimestamp(member) {
  if (!member) return null;

  if (typeof member.joinedTimestamp === 'number' && !isNaN(member.joinedTimestamp) && member.joinedTimestamp > 0) {
    return member.joinedTimestamp;
  }

  if (member.joinedAt instanceof Date && !isNaN(member.joinedAt.getTime())) {
    return member.joinedAt.getTime();
  }

  if (typeof member.joinedAt === 'string' || typeof member.joinedAt === 'number') {
    const parsed = new Date(member.joinedAt).getTime();
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }

  return null;
}

/**
 * Formats a membership duration string from join date to current date.
 * Accurately reports months and days elapsed.
 *
 * @param {number|Date} joinedTimestamp
 * @param {number|Date} [currentTimestamp=Date.now()]
 * @returns {string}
 */
export function formatMembershipDuration(joinedTimestamp, currentTimestamp = Date.now()) {
  const join = new Date(joinedTimestamp);
  const now = new Date(currentTimestamp);
  if (isNaN(join.getTime()) || isNaN(now.getTime()) || now < join) return '0 days';

  let months = (now.getUTCFullYear() - join.getUTCFullYear()) * 12 + (now.getUTCMonth() - join.getUTCMonth());
  let tempDate = new Date(Date.UTC(join.getUTCFullYear(), join.getUTCMonth() + months, join.getUTCDate(), join.getUTCHours(), join.getUTCMinutes(), join.getUTCSeconds()));
  if (tempDate > now) {
    months--;
    tempDate = new Date(Date.UTC(join.getUTCFullYear(), join.getUTCMonth() + months, join.getUTCDate(), join.getUTCHours(), join.getUTCMinutes(), join.getUTCSeconds()));
  }
  const remainingDays = Math.floor((now.getTime() - tempDate.getTime()) / (24 * 60 * 60 * 1000));
  const totalDays = Math.floor((now.getTime() - join.getTime()) / (24 * 60 * 60 * 1000));

  if (months > 0) {
    return `${months} month${months === 1 ? '' : 's'}${remainingDays > 0 ? `, ${remainingDays} day${remainingDays === 1 ? '' : 's'}` : ''} (${totalDays} day${totalDays === 1 ? '' : 's'})`;
  }
  return `${totalDays} day${totalDays === 1 ? '' : 's'}`;
}

/**
 * Records or updates a member's authentic server join timestamp in MongoDB.
 * Strictly uses Discord's member.joinedTimestamp / member.joinedAt as the source of truth for membership duration.
 * Overwrites any outdated or corrupted historical timestamps.
 *
 * @param {string} guildId
 * @param {string} userId
 * @param {number} joinedTimestamp Authentic Discord server join timestamp (ms)
 * @param {number|Date} [accountCreatedTimestamp=null] Discord account creation timestamp (ms, diagnostic only)
 * @returns {Promise<number|null>} Returns the effective server join timestamp (ms)
 */
export async function recordMemberJoinTimestamp(guildId, userId, joinedTimestamp, accountCreatedTimestamp = null) {
  if (!guildId || !userId || !joinedTimestamp) return Number(joinedTimestamp) || null;
  const effectiveJoin = Number(joinedTimestamp);

  if (!isMongoConnected()) return effectiveJoin;
  try {
    const db = getMongoDb();
    if (!db) return effectiveJoin;
    const col = db.collection(ROLE_PERIOD_MEMBERS_COLLECTION);

    const updateDoc = {
      $set: {
        serverJoinedTimestamp: effectiveJoin,
        serverJoinedAt: new Date(effectiveJoin),
        joinedTimestamp: effectiveJoin, // alias for backwards compatibility
        lastVerifiedAt: new Date(),
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      },
      $setOnInsert: {
        guildId: String(guildId),
        userId: String(userId),
        createdAt: new Date(),
      },
    };

    if (accountCreatedTimestamp) {
      updateDoc.$set.accountCreatedTimestamp = Number(new Date(accountCreatedTimestamp).getTime());
    }

    await col.findOneAndUpdate(
      { guildId: String(guildId), userId: String(userId) },
      updateDoc,
      { upsert: true, returnDocument: 'after' }
    );

    return effectiveJoin;
  } catch (err) {
    console.warn(`[RolePeriod] ⚠️ Failed to record join timestamp for user ${userId}:`, err.message);
    return effectiveJoin;
  }
}

/**
 * Gets a member's verified server join timestamp.
 * Strictly uses Discord's member.joinedTimestamp / member.joinedAt as the source of truth for membership duration.
 * Returns null if the join date cannot be verified so the caller can safely refuse role assignment.
 * NEVER uses member.user.createdTimestamp, Discord account creation date, server creation date, or bot installation/restart date.
 *
 * @param {string} guildId
 * @param {string} userId
 * @param {import('discord.js').GuildMember} [member]
 * @returns {Promise<number|null>}
 */
export async function getMemberEffectiveJoinTimestamp(guildId, userId, member = null) {
  // STRICT RULE 1: Direct authoritative check from Discord Guild Member object
  const liveJoinTs = getDiscordMemberJoinTimestamp(member);
  if (liveJoinTs) {
    return liveJoinTs;
  }

  // STRICT RULE 2: If member object was passed but lacks join date in cache, fetch fresh from Discord API
  if (member?.guild?.members?.fetch) {
    try {
      const fetched = await member.guild.members.fetch(userId);
      const fetchedTs = getDiscordMemberJoinTimestamp(fetched);
      if (fetchedTs) {
        return fetchedTs;
      }
    } catch {
      // Fallback to verified database record
    }
  }

  // STRICT RULE 3: Fallback to MongoDB verified server join record if present
  if (isMongoConnected()) {
    try {
      const db = getMongoDb();
      if (db) {
        const col = db.collection(ROLE_PERIOD_MEMBERS_COLLECTION);
        const doc = await col.findOne({ guildId: String(guildId), userId: String(userId) });
        const storedTs = doc?.serverJoinedTimestamp || doc?.joinedTimestamp;
        if (typeof storedTs === 'number' && !isNaN(storedTs) && storedTs > 0) {
          return storedTs;
        }
      }
    } catch {
      // fallback
    }
  }

  // Return null if server join date cannot be verified
  return null;
}

/**
 * Evaluates which stage a member is currently eligible for using calendar-based date calculations.
 * Compares currentTimestamp >= milestoneDate.
 *
 * @param {Array<object>} stages Sorted ascending by stageNumber / required duration
 * @param {number} joinedTimestamp Member's actual join timestamp in milliseconds
 * @param {number} [currentTimestamp=Date.now()]
 * @returns {{ currentStage: object|null, nextStage: object|null, msUntilNext: number, nextMilestoneDate: Date|null }}
 */
export function evaluateMemberStageCalendar(stages, joinedTimestamp, currentTimestamp = Date.now()) {
  if (!Array.isArray(stages) || stages.length === 0) {
    return { currentStage: null, nextStage: null, msUntilNext: 0, nextMilestoneDate: null };
  }

  const joinTime = Number(joinedTimestamp);
  const now = Number(currentTimestamp);

  let currentStage = null;
  let nextStage = null;
  let nextMilestoneDate = null;

  for (let i = 0; i < stages.length; i++) {
    const st = stages[i];
    const milestoneDate = calculateMilestoneDate(joinTime, st.durationValue, st.durationUnit);
    const milestoneTs = milestoneDate.getTime();

    // Condition: currentTimestamp >= milestoneTimestamp
    if (now >= milestoneTs) {
      currentStage = st;
    } else {
      nextStage = st;
      nextMilestoneDate = milestoneDate;
      break;
    }
  }

  const msUntilNext = nextMilestoneDate ? Math.max(0, nextMilestoneDate.getTime() - now) : 0;
  return { currentStage, nextStage, msUntilNext, nextMilestoneDate };
}

/**
 * Legacy wrapper for evaluateMemberStage to maintain backwards compatibility with existing callers.
 * If durationMs was supplied directly without a joinedTimestamp, calculates via evaluateMemberStageCalendar.
 */
export function evaluateMemberStage(stages, durationMsOrJoinedTs, maybeNow = null) {
  if (!Array.isArray(stages) || stages.length === 0) {
    return { currentStage: null, nextStage: null, msUntilNext: 0 };
  }

  // If called with (stages, durationMs) where durationMs < 1000000000000 (meaning it's an elapsed duration)
  if (maybeNow == null && typeof durationMsOrJoinedTs === 'number' && durationMsOrJoinedTs < 1000000000000) {
    const dummyNow = 1700000000000;
    const dummyJoin = dummyNow - durationMsOrJoinedTs;
    const res = evaluateMemberStageCalendar(stages, dummyJoin, dummyNow);
    return { currentStage: res.currentStage, nextStage: res.nextStage, msUntilNext: res.msUntilNext };
  }

  const joinTs = durationMsOrJoinedTs;
  const now = maybeNow || Date.now();
  const res = evaluateMemberStageCalendar(stages, joinTs, now);
  return { currentStage: res.currentStage, nextStage: res.nextStage, msUntilNext: res.msUntilNext };
}

/**
 * Upgrades or synchronizes a single member's progression role.
 * Ensures:
 * 1. Only ONE progression role is active per member.
 * 2. Never removes unrelated roles.
 * 3. Only assigns if member doesn't already have it.
 * 4. Removes previous progression roles cleanly.
 * 5. Uses calendar-based milestone calculation from member.joinedTimestamp.
 *
 * @param {import('discord.js').GuildMember} member
 * @param {object} config
 * @returns {Promise<{ changed: boolean, assignedRole: string|null, removedRoles: string[], error: boolean }>}
 */
export async function processMemberProgression(member, config, options = {}) {
  if (!member || !member.guild || !config?.stages || config.stages.length === 0) {
    return { changed: false, assignedRole: null, removedRoles: [], error: false };
  }

  if (member.user?.bot) {
    return { changed: false, assignedRole: null, removedRoles: [], error: false };
  }

  try {
    // Calculate actual duration in server strictly from member.joinedTimestamp / member.joinedAt
    const effectiveJoinMs = await getMemberEffectiveJoinTimestamp(member.guild.id, member.id, member);
    if (!effectiveJoinMs || isNaN(effectiveJoinMs) || effectiveJoinMs <= 0) {
      console.error(`[RolePeriod] ❌ Cannot verify authentic Discord server join date for member ${member.id} (${member.user?.tag || 'unknown'}). Skipping progression assignment.`);
      return {
        changed: false,
        assignedRole: null,
        removedRoles: [],
        error: true,
        reason: 'UNVERIFIED_SERVER_JOIN_DATE',
      };
    }

    const now = options.now || Date.now();
    const { currentStage, nextStage, nextMilestoneDate } = evaluateMemberStageCalendar(config.stages, effectiveJoinMs, now);
    let targetRoleId = currentStage?.roleId || null;

    // VALIDATION GUARD: Verify currentTimestamp >= joinedTimestamp + duration
    // Strictly enforced before assigning any progression stage or milestone
    if (targetRoleId && currentStage) {
      const requiredMilestoneDate = calculateMilestoneDate(effectiveJoinMs, currentStage.durationValue, currentStage.durationUnit);
      if (now < requiredMilestoneDate.getTime()) {
        console.warn(
          `[RolePeriod] 🚨 Guard blocked premature assignment of stage "${currentStage.roleName}" for member ${member.id}: ` +
          `current (${new Date(now).toISOString()}) < required milestone (${requiredMilestoneDate.toISOString()})`
        );
        targetRoleId = null;
      }
    }

    // Safeguard: Check whether target role still exists in guild
    if (targetRoleId && member.guild.roles?.cache && !member.guild.roles.cache.has(targetRoleId)) {
      console.warn(`[RolePeriod] ⚠️ Configured progression role ${targetRoleId} does not exist in guild ${member.guild.id}. Skipping.`);
      return { changed: false, assignedRole: null, removedRoles: [], error: true };
    }

    const allProgressionRoleIds = new Set(config.stages.map((s) => s.roleId));
    const memberRolesCache = member.roles?.cache;
    const currentMemberRoles = memberRolesCache ? Array.from(memberRolesCache.keys()) : [];

    const rolesToRemove = [];
    let needsAdd = false;
    let currentlyAssignedProgressionRoleName = 'None';

    for (const roleId of currentMemberRoles) {
      if (allProgressionRoleIds.has(roleId)) {
        const stageMatch = config.stages.find((s) => s.roleId === roleId);
        currentlyAssignedProgressionRoleName = stageMatch?.roleName || member.guild?.roles?.cache?.get(roleId)?.name || roleId;
        // If the member has a progression role that is NOT the target role, remove it!
        if (roleId !== targetRoleId) {
          rolesToRemove.push(roleId);
        }
      }
    }

    // Check if member already has target role
    if (targetRoleId && (!memberRolesCache || !memberRolesCache.has(targetRoleId))) {
      needsAdd = true;
    }

    // Determine Action Taken
    let actionTaken = 'None (Already Correct)';
    if (rolesToRemove.length > 0 && needsAdd) {
      actionTaken = `Removed [${rolesToRemove.map((r) => config.stages.find((s) => s.roleId === r)?.roleName || r).join(', ')}], Assigned [${currentStage?.roleName || targetRoleId}]`;
    } else if (rolesToRemove.length > 0) {
      actionTaken = `Removed [${rolesToRemove.map((r) => config.stages.find((s) => s.roleId === r)?.roleName || r).join(', ')}]`;
    } else if (needsAdd && targetRoleId) {
      actionTaken = `Assigned [${currentStage?.roleName || targetRoleId}]`;
    }

    // DIAGNOSTIC LOGGING (Requirement 6):
    // For every member processed, log:
    // - Discord Member ID.
    // - Discord Account Creation Date (diagnostic only).
    // - Actual Server Joined Date.
    // - Membership Duration.
    // - Next Milestone.
    // - Eligible Progression Role.
    // - Currently Assigned Progression Role.
    // - Action Taken.
    const accountCreatedDateStr = member.user?.createdAt
      ? member.user.createdAt.toISOString()
      : member.user?.createdTimestamp
        ? new Date(member.user.createdTimestamp).toISOString()
        : 'Unknown';
    const serverJoinDateStr = new Date(effectiveJoinMs).toISOString();
    const membershipDurationStr = formatMembershipDuration(effectiveJoinMs, now);
    const eligibleRoleStr = currentStage ? (currentStage.roleName || currentStage.roleId) : 'None';
    const currentRoleStr = currentlyAssignedProgressionRoleName || 'None';
    const nextMilestoneStr = nextStage
      ? `${formatDurationText(nextStage.durationMs, nextStage.durationValue, nextStage.durationUnit)} (${nextStage.roleName}) on ${nextMilestoneDate?.toISOString() || 'N/A'}`
      : 'Max Milestone Reached';

    console.log(
      `[RolePeriod] Member Processed:\n` +
      `  • Discord Member ID: ${member.id}\n` +
      `  • Discord Account Creation Date (diagnostic only): ${accountCreatedDateStr}\n` +
      `  • Actual Server Joined Date: ${serverJoinDateStr}\n` +
      `  • Membership Duration: ${membershipDurationStr}\n` +
      `  • Next Milestone: ${nextMilestoneStr}\n` +
      `  • Eligible Progression Role: ${eligibleRoleStr}\n` +
      `  • Currently Assigned Progression Role: ${currentRoleStr}\n` +
      `  • Action Taken: ${actionTaken}`
    );

    const diagnostic = {
      memberId: member.id,
      accountCreatedDate: accountCreatedDateStr,
      serverJoinDate: serverJoinDateStr,
      membershipDuration: membershipDurationStr,
      nextMilestone: nextMilestoneStr,
      eligibleRole: eligibleRoleStr,
      currentlyAssignedRole: currentRoleStr,
      actionTaken,
    };

    if (rolesToRemove.length === 0 && !needsAdd) {
      return { changed: false, assignedRole: null, removedRoles: [], error: false, diagnostic };
    }

    // Execute removals of previous or premature progression roles
    for (const rId of rolesToRemove) {
      try {
        await queueRoleRemove(member, rId, 'Role Progression Milestone Adjustment (Old/Premature Role Removal)');
      } catch (err) {
        console.warn(`[RolePeriod] ⚠️ Failed to remove old/premature progression role ${rId} from ${member.id}:`, err.message);
      }
    }

    // Assign current eligible milestone role
    if (needsAdd && targetRoleId) {
      try {
        await queueRoleAdd(member, targetRoleId, `Role Progression Milestone Upgrade (${currentStage?.roleName || 'Progression Role'})`);
      } catch (err) {
        console.warn(`[RolePeriod] ⚠️ Failed to add progression role ${targetRoleId} to ${member.id}:`, err.message);
      }
    }

    return {
      changed: true,
      assignedRole: needsAdd ? targetRoleId : null,
      removedRoles: rolesToRemove,
      error: false,
      diagnostic,
    };
  } catch (err) {
    console.warn(`[RolePeriod] ⚠️ Error evaluating progression for member ${member?.id}:`, err.message);
    return { changed: false, assignedRole: null, removedRoles: [], error: true };
  }
}

/**
 * Diagnostic audit to identify members who currently hold a progression role that they are NOT yet eligible for.
 * Reports findings without modifying member roles.
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} config
 * @returns {Promise<Array<{ memberId: string, memberTag: string, joinedTimestamp: number, joinDate: string, heldRole: string, heldRoleName: string, expectedRole: string|null, expectedRoleName: string|null, premature: boolean }>>}
 */
export async function auditIncorrectRoleAssignments(guild, config) {
  if (!guild || !config?.stages || config.stages.length === 0) return [];

  const allProgressionRoleIds = new Map(config.stages.map((s) => [s.roleId, s]));
  let members = guild.members?.cache;
  if (!members || members.size === 0) {
    try {
      members = await guild.members.fetch();
    } catch {
      return [];
    }
  }

  const now = Date.now();
  const discrepancies = [];

  for (const member of members.values()) {
    if (member.user?.bot) continue;
    const effectiveJoinMs = await getMemberEffectiveJoinTimestamp(guild.id, member.id, member);
    if (!effectiveJoinMs || isNaN(effectiveJoinMs) || effectiveJoinMs <= 0) continue;
    const { currentStage } = evaluateMemberStageCalendar(config.stages, effectiveJoinMs, now);

    const memberRolesCache = member.roles?.cache;
    if (!memberRolesCache) continue;

    for (const [rId, role] of memberRolesCache.entries()) {
      if (allProgressionRoleIds.has(rId)) {
        const stageConfig = allProgressionRoleIds.get(rId);
        // Calculate milestone date for the held role
        const milestoneDate = calculateMilestoneDate(effectiveJoinMs, stageConfig.durationValue, stageConfig.durationUnit);

        // Premature if now < milestoneDate
        if (now < milestoneDate.getTime()) {
          const accountCreatedStr = member.user?.createdAt
            ? member.user.createdAt.toUTCString()
            : member.user?.createdTimestamp
              ? new Date(member.user.createdTimestamp).toUTCString()
              : 'Unknown';

          discrepancies.push({
            memberId: member.id,
            memberTag: member.user?.tag || member.displayName,
            accountCreatedDate: accountCreatedStr,
            joinedTimestamp: effectiveJoinMs,
            joinDate: new Date(effectiveJoinMs).toUTCString(),
            membershipDuration: formatMembershipDuration(effectiveJoinMs, now),
            heldRole: rId,
            heldRoleName: role.name || stageConfig.roleName,
            expectedRole: currentStage?.roleId || null,
            expectedRoleName: currentStage?.roleName || 'None',
            premature: true,
            milestoneDate: milestoneDate.toUTCString(),
          });
        }
      }
    }
  }

  return discrepancies;
}

/**
 * Performs a full recalculation and synchronization across all server members.
 * Migrates existing data to the corrected calendar-based system:
 * - Fetches all current server members
 * - Reads actual Discord `joinedTimestamp` and records/overwrites in MongoDB (guaranteeing server join date)
 * - Evaluates every member with calendar calculations
 * - Corrects roles: removes outdated/premature progression roles and assigns the eligible role
 * - Preserves all unrelated roles
 * - Processes members in batches with rate-limit queueing
 * - Prevents multiple sync operations simultaneously
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} config
 * @returns {Promise<{ totalMembers: number, rolesCorrected: number, rolesRemoved: number, rolesAssigned: number, alreadyCorrect: number, errors: number }>}
 */
export async function executeProgressionSyncAndReconfigure(guild, config) {
  if (!guild || !config?.stages || config.stages.length === 0) {
    return { totalMembers: 0, rolesCorrected: 0, rolesRemoved: 0, rolesAssigned: 0, alreadyCorrect: 0, errors: 0, skippedUnverified: 0 };
  }

  // Prevent multiple sync operations simultaneously on the same guild
  if (activeSyncOperations.has(guild.id)) {
    throw new Error('A synchronization operation is already in progress for this server. Please wait until it completes.');
  }

  activeSyncOperations.add(guild.id);

  try {
    // 1. Fetch all current guild members directly from Discord using the Guild Members API
    let members;
    if (typeof guild.members?.fetch === 'function') {
      try {
        members = await guild.members.fetch();
      } catch (fetchErr) {
        console.warn(`[RolePeriod] ⚠️ Could not fetch full member list from Discord API, falling back to cache:`, fetchErr.message);
        members = guild.members?.cache || new Map();
      }
    } else {
      members = guild.members?.cache || new Map();
    }

    const memberList = Array.from(members.values()).filter((m) => !m.user?.bot);

    let totalMembers = 0;
    let rolesCorrected = 0;
    let rolesRemoved = 0;
    let rolesAssigned = 0;
    let alreadyCorrect = 0;
    let errors = 0;
    let skippedUnverified = 0;

    // Process members in small batches with slight yielding to avoid blocking event loop
    const BATCH_SIZE = 10;
    for (let i = 0; i < memberList.length; i += BATCH_SIZE) {
      const batch = memberList.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map(async (member) => {
          totalMembers++;
          try {
            // 2. Read each member's actual joinedAt / joinedTimestamp from Discord
            const serverJoinTs = getDiscordMemberJoinTimestamp(member);
            if (!serverJoinTs || isNaN(serverJoinTs) || serverJoinTs <= 0) {
              console.error(`[RolePeriod] ❌ Discord does not provide a valid joinedAt/joinedTimestamp for member ${member.id} (${member.user?.tag || 'unknown'}). Skipping member.`);
              errors++;
              skippedUnverified++;
              return;
            }

            // 3. Store the verified server membership timestamp in MongoDB for reference
            await recordMemberJoinTimestamp(guild.id, member.id, serverJoinTs, member.user?.createdTimestamp);

            // 4. Calculate duration, determine progression stage, correct premature roles
            const result = await processMemberProgression(member, config);
            if (result.error) {
              errors++;
            } else if (result.changed) {
              rolesCorrected++;
              rolesRemoved += result.removedRoles.length;
              if (result.assignedRole) rolesAssigned++;
            } else {
              alreadyCorrect++;
            }
          } catch (memErr) {
            errors++;
            console.warn(`[RolePeriod] ⚠️ Sync error for member ${member?.id}:`, memErr.message);
          }
        })
      );

      // Brief breather every batch if more members remain
      if (i + BATCH_SIZE < memberList.length) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    const stats = {
      totalMembers,
      rolesCorrected,
      rolesRemoved,
      rolesAssigned,
      alreadyCorrect,
      errors,
      skippedUnverified,
      syncedAt: new Date(),
    };

    // Update config in cache & MongoDB with last sync timestamp & stats
    config.lastSyncedAt = stats.syncedAt;
    config.lastSyncStats = stats;
    await saveProgressionConfig(guild.id, config);

    return stats;
  } finally {
    activeSyncOperations.delete(guild.id);
  }
}

/**
 * Background checker to evaluate all members across all configured guilds.
 * Runs periodically and immediately after bot startup.
 * @param {import('discord.js').Client} client
 */
export async function runRolePeriodAudit(client) {
  if (isSchedulerRunning || !client) return;
  isSchedulerRunning = true;

  try {
    for (const guild of client.guilds?.cache?.values?.() || []) {
      const config = await getProgressionConfig(guild.id);
      if (!config || !config.enabled || !config.stages || config.stages.length === 0) {
        continue;
      }

      if (!canBotManageRoles(guild)) {
        continue;
      }

      // Fetch or use cached members
      let members = guild.members?.cache;
      if (!members || members.size === 0) {
        try {
          members = await guild.members.fetch();
        } catch {
          continue;
        }
      }

      for (const member of members.values()) {
        if (member.user?.bot) continue;
        try {
          // Strictly verify authentic server join timestamp directly from Discord Guild Member object
          const serverJoinTs = getDiscordMemberJoinTimestamp(member);
          if (!serverJoinTs) {
            // Cannot verify server join date, skip
            continue;
          }
          await recordMemberJoinTimestamp(guild.id, member.id, serverJoinTs, member.user?.createdTimestamp);
          await processMemberProgression(member, config);
        } catch (memberErr) {
          // Keep looping gracefully across remaining members
        }
      }
    }
  } catch (err) {
    console.warn('[RolePeriod] ⚠️ Scheduler error during periodic audit:', err.message);
  } finally {
    isSchedulerRunning = false;
  }
}

/**
 * Starts the periodic background checker.
 * @param {import('discord.js').Client} client
 * @param {number} [intervalMs] Default: 5 minutes (300,000 ms)
 */
export function startRolePeriodScheduler(client, intervalMs = 5 * 60 * 1000) {
  stopRolePeriodScheduler();
  // Immediate run on startup to catch up on offline milestones
  setTimeout(() => {
    runRolePeriodAudit(client).catch((e) => console.warn('[RolePeriod] Startup audit warning:', e.message));
  }, 10_000);

  backgroundSchedulerTimer = setInterval(() => {
    runRolePeriodAudit(client).catch((e) => console.warn('[RolePeriod] Periodic audit warning:', e.message));
  }, intervalMs);
}

/**
 * Stops the background checker.
 */
export function stopRolePeriodScheduler() {
  if (backgroundSchedulerTimer) {
    clearInterval(backgroundSchedulerTimer);
    backgroundSchedulerTimer = null;
  }
}

/**
 * Builds the interactive setup panel for `.role period`.
 * Shows stages list, Example reference, and Action buttons:
 * Row 1: [Add Stage] [Edit Stage] [Remove Stage]
 * Row 2: [Sync & Reconfigure] [Save Configuration] [Cancel]
 *
 * @param {object} session
 * @param {import('discord.js').Guild} guild
 * @returns {{ embeds: EmbedBuilder[], components: ActionRowBuilder[] }}
 */
export function buildSetupPanelPayload(session, guild) {
  const stages = session.stages || [];
  const existingConfig = rolePeriodConfigCache.get(guild.id);
  const lastSyncStr = existingConfig?.lastSyncedAt
    ? `<t:${Math.floor(new Date(existingConfig.lastSyncedAt).getTime() / 1000)}:R>`
    : 'Not yet synced';

  const embed = new EmbedBuilder()
    .setTitle('⏳ Role Progression Setup')
    .setColor(0xF97316)
    .setDescription(
      `Configure automated role progression based on membership duration.\n` +
      `Members automatically unlock higher roles and have their previous stage role removed.\n\n` +
      `**Current Server:** ${guild.name}\n` +
      `**Status:** ${stages.length > 0 ? '🟢 Active' : '⚪ Not configured'}\n` +
      `**Last Synchronization:** ${lastSyncStr}`
    );

  if (stages.length === 0) {
    embed.addFields({
      name: '⚙️ Configured Stages (0)',
      value: `*No progression stages configured yet.*\nClick **➕ Add Stage** below to select a server role and configure your first milestone.`,
    });
  } else {
    const stageLines = stages.map((st, idx) => {
      const durText = formatDurationText(st.durationMs, st.durationValue, st.durationUnit);
      return `**Stage ${idx + 1}:** <@&${st.roleId}> (\`${st.roleName || st.roleId}\`)\n` +
             `└ **Duration:** \`${durText}\`\n` +
             `└ **Behavior:** ${idx === 0 ? 'Assigned upon reaching time milestone' : `Replaces Stage ${idx} role`}`;
    });

    embed.addFields({
      name: `⚙️ Configured Stages (${stages.length})`,
      value: stageLines.join('\n\n'),
    });
  }

  embed.addFields({
    name: '💡 How Role Progression Works',
    value:
      `• **Custom Roles:** You select any role directly from your server's role list.\n` +
      `• **Custom Durations:** Set any duration (e.g. 0 days for immediate, 15 days, 3 months, 1 year).\n` +
      `• **Sequential Upgrades:** As members reach each milestone, the bot assigns that stage's role and removes the previous tier role.\n` +
      `• **Single Active Progression Role:** Only one progression role remains active per member.\n` +
      `• **Preserves Server Roles:** Unrelated server roles are never modified or removed.`,
  });

  embed.setFooter({ text: 'Only 1 progression role will remain active per member • Unrelated roles are untouched' });

  // Buttons Row 1: Add Stage, Edit Stage, Remove Stage
  const addStageBtn = new ButtonBuilder()
    .setCustomId(`${ROLE_PERIOD_PREFIX}add_stage:${session.sessionId}`)
    .setLabel('Add Stage')
    .setEmoji('➕')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(stages.length >= 10); // sensible max limit

  const editStageBtn = new ButtonBuilder()
    .setCustomId(`${ROLE_PERIOD_PREFIX}edit_stage:${session.sessionId}`)
    .setLabel('Edit Stage')
    .setEmoji('✏️')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(stages.length === 0);

  const removeStageBtn = new ButtonBuilder()
    .setCustomId(`${ROLE_PERIOD_PREFIX}remove_stage:${session.sessionId}`)
    .setLabel('Remove Stage')
    .setEmoji('🗑️')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(stages.length === 0);

  // Buttons Row 2: Sync & Reconfigure, Save, Cancel
  const syncBtn = new ButtonBuilder()
    .setCustomId(`${ROLE_PERIOD_PREFIX}sync_prompt:${session.sessionId}`)
    .setLabel('Sync & Reconfigure')
    .setEmoji('🔄')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(stages.length === 0 || activeSyncOperations.has(guild.id));

  const saveBtn = new ButtonBuilder()
    .setCustomId(`${ROLE_PERIOD_PREFIX}save:${session.sessionId}`)
    .setLabel('Save Configuration')
    .setEmoji('💾')
    .setStyle(ButtonStyle.Success)
    .setDisabled(stages.length === 0);

  const cancelBtn = new ButtonBuilder()
    .setCustomId(`${ROLE_PERIOD_PREFIX}cancel:${session.sessionId}`)
    .setLabel('Cancel')
    .setEmoji('✖️')
    .setStyle(ButtonStyle.Danger);

  const row1 = new ActionRowBuilder().addComponents(addStageBtn, editStageBtn, removeStageBtn);
  const row2 = new ActionRowBuilder().addComponents(syncBtn, saveBtn, cancelBtn);

  return { embeds: [embed], components: [row1, row2] };
}

/**
 * Builds the confirmation payload for Sync & Reconfigure.
 * @param {object} session
 * @param {import('discord.js').Guild} guild
 * @returns {{ embeds: EmbedBuilder[], components: ActionRowBuilder[] }}
 */
export function buildSyncConfirmationPayload(session, guild) {
  const embed = new EmbedBuilder()
    .setTitle('🔄 Confirm Synchronization & Reconfiguration')
    .setColor(0xF97316)
    .setDescription(
      `**Recalculate all members using corrected calendar-based durations.**\n\n` +
      `This operation will:\n` +
      `• Fetch all current server members.\n` +
      `• Read their actual Discord \`joinedTimestamp\` as the source of truth.\n` +
      `• Recalculate each member's milestone eligibility using exact calendar calculations.\n` +
      `• Compare current progression roles against their eligible stage.\n` +
      `• Correct incorrectly assigned or premature progression roles.\n` +
      `• Remove outdated progression roles and assign the correct ones.\n` +
      `• **Preserve all unrelated server roles** (VIP, team, admin, etc.).\n\n` +
      `⚠️ **Notice:** Any members who currently hold higher-stage roles prematurely (before their actual milestone date) will be adjusted to their correct stage.`
    )
    .setFooter({ text: 'Original join dates and configurations are fully preserved' });

  const confirmBtn = new ButtonBuilder()
    .setCustomId(`${ROLE_PERIOD_PREFIX}sync_confirm:${session.sessionId}`)
    .setLabel('Confirm & Run Sync')
    .setEmoji('✅')
    .setStyle(ButtonStyle.Success);

  const cancelBtn = new ButtonBuilder()
    .setCustomId(`${ROLE_PERIOD_PREFIX}back_to_setup:${session.sessionId}`)
    .setLabel('Back to Setup')
    .setEmoji('↩️')
    .setStyle(ButtonStyle.Secondary);

  const row = new ActionRowBuilder().addComponents(confirmBtn, cancelBtn);
  return { embeds: [embed], components: [row] };
}

/**
 * Builds the Sync Results Summary Embed.
 * @param {import('discord.js').Guild} guild
 * @param {object} stats
 * @returns {EmbedBuilder}
 */
export function buildSyncResultsEmbed(guild, stats) {
  const embed = new EmbedBuilder()
    .setTitle('✅ Role Progression Synchronization Complete')
    .setColor(0x57F287)
    .setDescription(
      `All server members have been evaluated from their original server join date using the corrected calendar-based calculations.\n\n` +
      `**Server:** ${guild.name}`
    );

  embed.addFields({
    name: '📊 Synchronization Summary',
    value:
      `\`\`\`\n` +
      `Result          | Count\n` +
      `----------------+-------\n` +
      `Members checked | ${stats.totalMembers}\n` +
      `Roles corrected | ${stats.rolesCorrected}\n` +
      `Roles removed   | ${stats.rolesRemoved}\n` +
      `Roles assigned  | ${stats.rolesAssigned}\n` +
      `Already correct | ${stats.alreadyCorrect}\n` +
      `Errors          | ${stats.errors}\n` +
      `\`\`\``,
  });

  embed.setFooter({ text: 'All unrelated server roles remained completely untouched' });
  return embed;
}

/**
 * Builds the Role Selection dropdown payload for adding a new stage.
 * @param {object} session
 * @param {import('discord.js').Guild} guild
 * @param {number} [page=0]
 * @returns {{ embeds: EmbedBuilder[], components: ActionRowBuilder[] }}
 */
export function buildAddStageRoleSelectPayload(session, guild, page = 0) {
  const assignableRoles = getAssignableProgressionRoles(guild);
  const alreadySelected = new Set((session.stages || []).map((s) => s.roleId));
  const availableRoles = assignableRoles.filter((r) => !alreadySelected.has(r.id));

  const embed = new EmbedBuilder()
    .setTitle('➕ Add Progression Stage (Step 1/2: Select Role)')
    .setColor(0xF97316)
    .setDescription(
      `Select a Discord role for this progression milestone.\n\n` +
      `*Only assignable roles below the bot's highest role are displayed.*`
    );

  if (availableRoles.length === 0) {
    embed.setDescription('⚠️ **No available roles found.** Either all assignable roles are already in stages, or no roles exist below the bot.');
    const cancelBtn = new ButtonBuilder()
      .setCustomId(`${ROLE_PERIOD_PREFIX}back_to_setup:${session.sessionId}`)
      .setLabel('Back to Setup')
      .setStyle(ButtonStyle.Secondary);
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(cancelBtn)] };
  }

  const PAGE_SIZE = 25;
  const totalPages = Math.ceil(availableRoles.length / PAGE_SIZE);
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const pageRoles = availableRoles.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const options = pageRoles.map((r) => ({
    label: r.name.slice(0, 100),
    value: r.id,
    description: `Position: ${r.position} • Members: ${r.members?.size ?? 0}`,
  }));

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${ROLE_PERIOD_PREFIX}select_role:${session.sessionId}:${safePage}`)
    .setPlaceholder(`Choose a role (Page ${safePage + 1}/${totalPages})`)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);

  const components = [new ActionRowBuilder().addComponents(menu)];

  // Navigation row if multiple pages + back button
  const navButtons = [];
  if (safePage > 0) {
    navButtons.push(
      new ButtonBuilder()
        .setCustomId(`${ROLE_PERIOD_PREFIX}role_page:${session.sessionId}:${safePage - 1}`)
        .setLabel('◀ Previous')
        .setStyle(ButtonStyle.Secondary)
    );
  }
  if (safePage < totalPages - 1) {
    navButtons.push(
      new ButtonBuilder()
        .setCustomId(`${ROLE_PERIOD_PREFIX}role_page:${session.sessionId}:${safePage + 1}`)
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Secondary)
    );
  }
  navButtons.push(
    new ButtonBuilder()
      .setCustomId(`${ROLE_PERIOD_PREFIX}back_to_setup:${session.sessionId}`)
      .setLabel('Back to Setup')
      .setStyle(ButtonStyle.Secondary)
  );

  components.push(new ActionRowBuilder().addComponents(navButtons));

  return { embeds: [embed], components };
}

/**
 * Builds the Modal for Duration Input (Value + Unit: Days, Weeks, or Months).
 * @param {string} sessionId
 * @param {string} roleId
 * @param {string} [existingValue=""]
 * @param {string} [existingUnit="days"]
 * @param {boolean} [isEditing=false]
 * @param {number} [editIndex=-1]
 * @returns {ModalBuilder}
 */
export function buildDurationModal(sessionId, roleId, existingValue = '', existingUnit = 'days', isEditing = false, editIndex = -1) {
  const customId = isEditing
    ? `${ROLE_PERIOD_PREFIX}modal_edit_submit:${sessionId}:${editIndex}`
    : `${ROLE_PERIOD_PREFIX}modal_duration_submit:${sessionId}:${roleId}`;

  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle(isEditing ? 'Edit Stage Duration' : 'Set Stage Duration');

  const valueInput = new TextInputBuilder()
    .setCustomId('duration_value')
    .setLabel('Duration Number (e.g. 0, 15, 3, 6)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Enter 0 for immediately, or 15, 3, 6, etc.')
    .setValue(String(existingValue !== '' ? existingValue : ''))
    .setRequired(true)
    .setMaxLength(5);

  const unitInput = new TextInputBuilder()
    .setCustomId('duration_unit')
    .setLabel('Time Unit (days, weeks, or months)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('days, weeks, or months')
    .setValue(String(existingUnit || 'days'))
    .setRequired(true)
    .setMaxLength(10);

  modal.addComponents(
    new ActionRowBuilder().addComponents(valueInput),
    new ActionRowBuilder().addComponents(unitInput)
  );

  return modal;
}

/**
 * Builds Select Menu payload for removing a stage from session.
 * @param {object} session
 * @returns {{ embeds: EmbedBuilder[], components: ActionRowBuilder[] }}
 */
export function buildRemoveStagePayload(session) {
  const stages = session.stages || [];

  const embed = new EmbedBuilder()
    .setTitle('🗑️ Remove Progression Stage')
    .setColor(0xED4245)
    .setDescription('Select the stage you wish to remove from this configuration.');

  const options = stages.map((st, idx) => ({
    label: `Stage ${idx + 1}: ${st.roleName || st.roleId}`.slice(0, 100),
    value: String(idx),
    description: formatDurationText(st.durationMs, st.durationValue, st.durationUnit).slice(0, 100),
  }));

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${ROLE_PERIOD_PREFIX}remove_select:${session.sessionId}`)
    .setPlaceholder('Select stage to remove')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);

  const backBtn = new ButtonBuilder()
    .setCustomId(`${ROLE_PERIOD_PREFIX}back_to_setup:${session.sessionId}`)
    .setLabel('Back to Setup')
    .setStyle(ButtonStyle.Secondary);

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(menu),
      new ActionRowBuilder().addComponents(backBtn),
    ],
  };
}

/**
 * Builds Select Menu payload for choosing which stage to edit.
 * @param {object} session
 * @returns {{ embeds: EmbedBuilder[], components: ActionRowBuilder[] }}
 */
export function buildEditStageSelectPayload(session) {
  const stages = session.stages || [];

  const embed = new EmbedBuilder()
    .setTitle('✏️ Edit Progression Stage')
    .setColor(0x5865F2)
    .setDescription('Select the stage whose duration you wish to edit.');

  const options = stages.map((st, idx) => ({
    label: `Stage ${idx + 1}: ${st.roleName || st.roleId}`.slice(0, 100),
    value: String(idx),
    description: formatDurationText(st.durationMs, st.durationValue, st.durationUnit).slice(0, 100),
  }));

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${ROLE_PERIOD_PREFIX}edit_select:${session.sessionId}`)
    .setPlaceholder('Select stage to edit')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);

  const backBtn = new ButtonBuilder()
    .setCustomId(`${ROLE_PERIOD_PREFIX}back_to_setup:${session.sessionId}`)
    .setLabel('Back to Setup')
    .setStyle(ButtonStyle.Secondary);

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(menu),
      new ActionRowBuilder().addComponents(backBtn),
    ],
  };
}

/**
 * Builds view embed for `.role period view`.
 * @param {import('discord.js').Guild} guild
 * @param {object} config
 * @returns {EmbedBuilder}
 */
export function buildProgressionViewEmbed(guild, config) {
  const embed = new EmbedBuilder()
    .setTitle(`⏳ Role Progression Stages (${guild.name})`)
    .setColor(0xF97316);

  if (!config || !config.stages || config.stages.length === 0) {
    embed.setDescription('ℹ️ No role progression system is configured for this server.\nUse `.role period` to configure one.');
    return embed;
  }

  const lines = config.stages.map((st, idx) => {
    const role = guild.roles?.cache?.get?.(st.roleId);
    const roleDisplay = role ? `<@&${role.id}> (\`${role.name}\`)` : `\`${st.roleName || st.roleId}\` *(Role deleted)*`;
    const dur = formatDurationText(st.durationMs, st.durationValue, st.durationUnit);
    return `**Stage ${idx + 1}:** ${roleDisplay}\n` +
           `   • **Requirement:** \`${dur}\`\n` +
           `   • **Action:** ${idx === 0 ? 'Assigned immediately' : `Replaces Stage ${idx} role`}`;
  });

  const lastSyncStr = config.lastSyncedAt
    ? `<t:${Math.floor(new Date(config.lastSyncedAt).getTime() / 1000)}:R>`
    : 'Not yet synced';

  embed.setDescription(
    lines.join('\n\n') +
    `\n\n**Last Synchronization:** ${lastSyncStr}`
  );
  embed.setFooter({ text: `Total Stages: ${config.stages.length} • Status: ${config.enabled ? '🟢 Active' : '🔴 Disabled'}` });
  return embed;
}

/**
 * Builds user check embed for `.role period check @user`.
 * Uses calendar-based milestone calculation.
 * @param {import('discord.js').GuildMember} targetMember
 * @param {object} config
 * @param {number} joinedTimestamp
 * @returns {EmbedBuilder}
 */
export function buildMemberProgressionCheckEmbed(targetMember, config, joinedTimestamp) {
  const now = Date.now();
  const effectiveJoin = Number(joinedTimestamp || getDiscordMemberJoinTimestamp(targetMember) || 0);
  const userTag = targetMember.user?.tag || targetMember.user?.username || targetMember.displayName || 'Member';

  const embed = new EmbedBuilder()
    .setTitle(`📊 Role Progression Status: ${userTag}`)
    .setColor(0xF97316)
    .setThumbnail(targetMember.user?.displayAvatarURL?.() || null);

  if (!config || !config.stages || config.stages.length === 0) {
    embed.setDescription('ℹ️ No role progression system is configured in this server.');
    return embed;
  }

  const accountCreatedStr = targetMember.user?.createdAt
    ? targetMember.user.createdAt.toUTCString()
    : targetMember.user?.createdTimestamp
      ? new Date(targetMember.user.createdTimestamp).toUTCString()
      : 'Unknown';

  if (!effectiveJoin || effectiveJoin <= 0) {
    embed.setDescription(
      `❌ **Unverified Server Join Date**\n\n` +
      `Discord could not provide an authentic server join date for this member.\n` +
      `Progression evaluation is strictly blocked per server-membership verification rules.`
    );
    embed.addFields(
      { name: '📅 Server Join Date', value: '`Unavailable / Unverified`', inline: false },
      { name: '👤 Discord Account Created', value: `${accountCreatedStr} *(Diagnostic only)*`, inline: true },
      { name: '🎖️ Current Stage', value: '*Unverified*', inline: true },
      { name: '⏭️ Next Progression Milestone', value: '`N/A`', inline: false }
    );
    return embed;
  }

  const { currentStage, nextStage, msUntilNext, nextMilestoneDate } = evaluateMemberStageCalendar(config.stages, effectiveJoin, now);
  const joinDateStr = new Date(effectiveJoin).toUTCString();
  const membershipDurationStr = formatMembershipDuration(effectiveJoin, now);
  const totalDays = Math.floor(Math.max(0, now - effectiveJoin) / MS_PER_DAY);

  let currentRoleText = '*None (Pending first stage)*';
  if (currentStage) {
    const role = targetMember.guild.roles?.cache?.get?.(currentStage.roleId);
    currentRoleText = role ? `<@&${role.id}> (\`${role.name}\`)` : `\`${currentStage.roleName}\``;
  }

  let nextMilestoneText = '🏆 **Max Milestone Reached!**';
  if (nextStage) {
    const nextRole = targetMember.guild.roles?.cache?.get?.(nextStage.roleId);
    const nextRoleDisplay = nextRole ? `<@&${nextRole.id}>` : `\`${nextStage.roleName}\``;
    const durReq = formatDurationText(nextStage.durationMs, nextStage.durationValue, nextStage.durationUnit);
    const timeRemainingStr = formatTimeRemaining(msUntilNext);
    const milestoneDateStr = nextMilestoneDate ? nextMilestoneDate.toUTCString() : 'N/A';
    nextMilestoneText = `${nextRoleDisplay} (Requires: \`${durReq}\`)\n└ ⏳ **Time Remaining:** \`${timeRemainingStr}\`\n└ 📅 **Milestone Date:** \`${milestoneDateStr}\``;
  }

  embed.addFields(
    { name: '📅 Server Join Date', value: `${joinDateStr}\n*(Active for **${totalDays}** days • **${membershipDurationStr}**)*\n*(Eligibility calculated strictly from Server Join Date)*`, inline: false },
    { name: '👤 Discord Account Created', value: `${accountCreatedStr} *(Diagnostic only)*`, inline: true },
    { name: '🎖️ Current Stage', value: currentStage ? `**Stage ${currentStage.stageNumber}:** ${currentRoleText}` : currentRoleText, inline: true },
    { name: '⏭️ Next Progression Milestone', value: nextMilestoneText, inline: false }
  );

  return embed;
}

/**
 * Builds audit findings embed for `.role period audit`.
 * @param {import('discord.js').Guild} guild
 * @param {Array<object>} discrepancies
 * @returns {EmbedBuilder}
 */
export function buildProgressionAuditEmbed(guild, discrepancies) {
  const embed = new EmbedBuilder()
    .setTitle(`🔍 Role Progression Audit Report (${guild.name})`)
    .setColor(discrepancies.length > 0 ? 0xED4245 : 0x57F287);

  if (discrepancies.length === 0) {
    embed.setDescription('✅ **Audit Passed:** All server members holding progression roles are verified to have reached their required calendar milestones. No premature role assignments detected.');
    return embed;
  }

  embed.setDescription(
    `⚠️ **Found ${discrepancies.length} member(s) with premature progression roles!**\n` +
    `These members currently hold a role whose calendar milestone has not yet arrived based on their actual server join date.\n\n` +
    `*(Diagnostic report only: click **Sync & Reconfigure** in \`.role period\` to reconcile).*`
  );

  const lines = discrepancies.slice(0, 15).map((d, i) => {
    return `**${i + 1}.** <@${d.memberId}> (\`${d.memberTag}\`)\n` +
           `   • **Currently Holds:** <@&${d.heldRole}> (\`${d.heldRoleName}\`)\n` +
           `   • **Server Joined:** \`${d.joinDate}\`\n` +
           `   • **Account Created:** \`${d.accountCreatedDate || 'N/A'}\`\n` +
           `   • **Milestone Required:** \`${d.milestoneDate}\`\n` +
           `   • **Actual Eligible Role:** ${d.expectedRole ? `<@&${d.expectedRole}> (\`${d.expectedRoleName}\`)` : '`None`'}`;
  });

  embed.addFields({
    name: 'Discrepancy Details',
    value: lines.join('\n\n') + (discrepancies.length > 15 ? `\n\n*...and ${discrepancies.length - 15} more.*` : ''),
  });

  return embed;
}

/**
 * Handles the prefix command `.role period` and all its subcommands.
 *
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildMember} member
 * @param {import('discord.js').TextChannel} channel
 * @param {Array<string>} args
 * @param {Function} replyFn
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').Message} [message]
 */
export async function handleRolePeriodCommand(guild, member, channel, args, replyFn, client, message = null) {
  if (!guild || !member) return;

  const sub = (args[0] || '').toLowerCase();

  // 1. Check subcommand: `.role period check @user`
  if (sub === 'check') {
    const targetMember =
      message?.mentions?.members?.first?.() ||
      (args[1] ? guild.members?.cache?.get?.(args[1].replace(/[<@!>]/g, '')) : null) ||
      member;

    if (!targetMember) {
      return replyFn('⚠️ Member not found. Usage: `.role period check [@user]`');
    }

    const serverJoinTs = getDiscordMemberJoinTimestamp(targetMember);
    if (serverJoinTs) {
      await recordMemberJoinTimestamp(guild.id, targetMember.id, serverJoinTs, targetMember.user?.createdTimestamp);
    }

    const config = await getProgressionConfig(guild.id);
    const effectiveJoin = await getMemberEffectiveJoinTimestamp(guild.id, targetMember.id, targetMember);
    const embed = buildMemberProgressionCheckEmbed(targetMember, config, effectiveJoin);
    return replyFn({ embeds: [embed] });
  }

  // 2. View subcommand: `.role period view`
  if (sub === 'view') {
    const config = await getProgressionConfig(guild.id);
    const embed = buildProgressionViewEmbed(guild, config);
    return replyFn({ embeds: [embed] });
  }

  // Admin / Manage Server permission guard for remaining management commands
  if (!canMemberManageRolePeriod(member, guild)) {
    return replyFn('❌ **Permission Denied:** You need **Administrator** or **Manage Server** permission to configure role progression.');
  }

  // 3. Diagnostic Audit subcommand: `.role period audit`
  if (sub === 'audit') {
    const config = await getProgressionConfig(guild.id);
    if (!config || !config.stages || config.stages.length === 0) {
      return replyFn('ℹ️ There is no active role progression configuration to audit.');
    }

    const waitMsg = await replyFn('🔍 **Running calendar milestone audit across server members...**');
    const discrepancies = await auditIncorrectRoleAssignments(guild, config);
    const embed = buildProgressionAuditEmbed(guild, discrepancies);

    if (waitMsg && typeof waitMsg.edit === 'function') {
      return waitMsg.edit({ content: null, embeds: [embed] });
    }
    return replyFn({ embeds: [embed] });
  }

  // 4. Sync subcommand directly from command line: `.role period sync`
  if (sub === 'sync') {
    const config = await getProgressionConfig(guild.id);
    if (!config || !config.stages || config.stages.length === 0) {
      return replyFn('ℹ️ There is no active role progression configuration to synchronize.');
    }

    if (!canBotManageRoles(guild)) {
      return replyFn('❌ **Bot Permission Missing:** I need the **Manage Roles** permission to synchronize role progression.');
    }

    const sessionId = `rp_sync_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    rolePeriodSessions.set(sessionId, {
      sessionId,
      guildId: guild.id,
      userId: member.id,
      stages: config.stages,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    const payload = buildSyncConfirmationPayload({ sessionId }, guild);
    return replyFn(payload);
  }

  // 5. Remove subcommand: `.role period remove`
  if (sub === 'remove') {
    const config = await getProgressionConfig(guild.id);
    if (!config || !config.stages || config.stages.length === 0) {
      return replyFn('ℹ️ There is no active role progression configuration to remove.');
    }

    const sessionId = `rp_rm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    rolePeriodSessions.set(sessionId, {
      sessionId,
      guildId: guild.id,
      userId: member.id,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    const embed = new EmbedBuilder()
      .setTitle('⚠️ Remove Role Progression Configuration')
      .setColor(0xED4245)
      .setDescription(
        `Are you sure you want to remove the entire role progression system for **${guild.name}**?\n\n` +
        `**Note:** This only deletes the automated progression configuration. It **will not** remove any roles from current server members.`
      );

    const confirmBtn = new ButtonBuilder()
      .setCustomId(`${ROLE_PERIOD_PREFIX}confirm_remove_all:${sessionId}`)
      .setLabel('Yes, Remove Configuration')
      .setStyle(ButtonStyle.Danger);

    const cancelBtn = new ButtonBuilder()
      .setCustomId(`${ROLE_PERIOD_PREFIX}cancel:${sessionId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(confirmBtn, cancelBtn);
    return replyFn({ embeds: [embed], components: [row] });
  }

  // 6. Default: `.role period` -> Open Interactive Setup Panel
  if (!canBotManageRoles(guild)) {
    return replyFn('❌ **Bot Permission Missing:** I need the **Manage Roles** permission to manage role progression.');
  }

  const existingConfig = await getProgressionConfig(guild.id);
  const initialStages = existingConfig?.stages ? JSON.parse(JSON.stringify(existingConfig.stages)) : [];

  const sessionId = `rp_sess_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const session = {
    sessionId,
    guildId: guild.id,
    userId: member.id,
    stages: initialStages,
    expiresAt: Date.now() + 10 * 60 * 1000,
  };
  rolePeriodSessions.set(sessionId, session);

  const payload = buildSetupPanelPayload(session, guild);
  return replyFn(payload);
}

/**
 * Handles all button, select menu, and modal interactions for `.role period`.
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {import('discord.js').Client} client
 * @returns {Promise<boolean>}
 */
export async function handleRolePeriodInteraction(interaction, client) {
  if (!interaction || !interaction.customId?.startsWith(ROLE_PERIOD_PREFIX)) {
    return false;
  }

  const parts = interaction.customId.slice(ROLE_PERIOD_PREFIX.length).split(':');
  const action = parts[0];
  const sessionId = parts[1];

  const session = rolePeriodSessions.get(sessionId);

  // Authorization check: only original invoking admin can interact
  if (session && interaction.user.id !== session.userId) {
    await interaction.reply({
      content: '❌ Only the administrator who opened this setup panel can use these controls.',
      ephemeral: true,
    }).catch(() => {});
    return true;
  }

  // --- 1. Cancel Action ---
  if (action === 'cancel') {
    rolePeriodSessions.delete(sessionId);
    await interaction.update({
      content: '❌ **Role Progression setup cancelled.** No changes were applied.',
      embeds: [],
      components: [],
    }).catch(() => {});
    return true;
  }

  // --- 2. Remove All Confirmation ---
  if (action === 'confirm_remove_all') {
    if (!session) {
      await interaction.reply({ content: '⚠️ This session has expired. Please run `.role period remove` again.', ephemeral: true }).catch(() => {});
      return true;
    }
    await deleteProgressionConfig(session.guildId);
    rolePeriodSessions.delete(sessionId);
    await interaction.update({
      content: '✅ **Role Progression configuration has been completely removed.**\n*(Existing member roles were left untouched).*',
      embeds: [],
      components: [],
    }).catch(() => {});
    return true;
  }

  // Session check for remaining operations
  if (!session) {
    await interaction.reply({
      content: '⚠️ This setup session has expired. Please run `.role period` again.',
      ephemeral: true,
    }).catch(() => {});
    return true;
  }

  const guild = interaction.guild;
  if (!guild) return true;

  // --- 3. Back to Setup Panel ---
  if (action === 'back_to_setup') {
    const payload = buildSetupPanelPayload(session, guild);
    await interaction.update(payload).catch(() => {});
    return true;
  }

  // --- 4. Sync & Reconfigure Prompt (Confirmation Screen) ---
  if (action === 'sync_prompt') {
    if (!session.stages || session.stages.length === 0) {
      await interaction.reply({
        content: '⚠️ Configure and save at least one stage before syncing.',
        ephemeral: true,
      }).catch(() => {});
      return true;
    }

    if (activeSyncOperations.has(guild.id)) {
      await interaction.reply({
        content: '⚠️ A synchronization operation is already in progress. Please wait for it to complete.',
        ephemeral: true,
      }).catch(() => {});
      return true;
    }

    const payload = buildSyncConfirmationPayload(session, guild);
    await interaction.update(payload).catch(() => {});
    return true;
  }

  // --- 5. Sync & Reconfigure Confirm (Execution) ---
  if (action === 'sync_confirm') {
    if (activeSyncOperations.has(guild.id)) {
      await interaction.reply({
        content: '⚠️ A synchronization operation is already in progress.',
        ephemeral: true,
      }).catch(() => {});
      return true;
    }

    // Acknowledge interaction and show progress embed
    const progressEmbed = new EmbedBuilder()
      .setTitle('🔄 Synchronization in Progress...')
      .setColor(0xF97316)
      .setDescription(
        `Evaluating server members using corrected calendar calculations...\n` +
        `Please wait while members are processed in rate-limited batches.`
      );

    await interaction.update({ embeds: [progressEmbed], components: [] }).catch(() => {});

    try {
      const config = await getProgressionConfig(guild.id) || { stages: session.stages, enabled: true };
      const stats = await executeProgressionSyncAndReconfigure(guild, config);
      const resultEmbed = buildSyncResultsEmbed(guild, stats);

      const returnBtn = new ButtonBuilder()
        .setCustomId(`${ROLE_PERIOD_PREFIX}back_to_setup:${session.sessionId}`)
        .setLabel('Return to Setup Panel')
        .setStyle(ButtonStyle.Primary);

      const row = new ActionRowBuilder().addComponents(returnBtn);

      if (interaction.message && typeof interaction.message.edit === 'function') {
        await interaction.message.edit({ embeds: [resultEmbed], components: [row] }).catch(() => {});
      }
    } catch (err) {
      const errEmbed = new EmbedBuilder()
        .setTitle('❌ Synchronization Failed')
        .setColor(0xED4245)
        .setDescription(`An error occurred during synchronization: ${err.message}`);

      if (interaction.message && typeof interaction.message.edit === 'function') {
        await interaction.message.edit({ embeds: [errEmbed], components: [] }).catch(() => {});
      }
    }
    return true;
  }

  // --- 6. Add Stage: Show Role Selection Menu ---
  if (action === 'add_stage') {
    const payload = buildAddStageRoleSelectPayload(session, guild, 0);
    await interaction.update(payload).catch(() => {});
    return true;
  }

  // --- 7. Add Stage: Role Page Navigation ---
  if (action === 'role_page') {
    const targetPage = parseInt(parts[2] || '0', 10);
    const payload = buildAddStageRoleSelectPayload(session, guild, targetPage);
    await interaction.update(payload).catch(() => {});
    return true;
  }

  // --- 8. Add Stage: Role Selected -> Open Duration Modal ---
  if (action === 'select_role') {
    const selectedRoleId = interaction.values?.[0];
    if (!selectedRoleId) return true;

    // Show Duration Modal
    const modal = buildDurationModal(sessionId, selectedRoleId);
    await interaction.showModal(modal).catch((err) => {
      console.warn('[RolePeriod] ⚠️ showModal failed:', err.message);
    });
    return true;
  }

  // --- 9. Modal Submit for New Stage Duration ---
  if (action === 'modal_duration_submit') {
    const roleId = parts[2];
    const durationValRaw = interaction.fields.getTextInputValue('duration_value')?.trim();
    const durationUnitRaw = interaction.fields.getTextInputValue('duration_unit')?.trim()?.toLowerCase();

    const durationVal = parseFloat(durationValRaw);
    if (isNaN(durationVal) || durationVal < 0) {
      await interaction.reply({
        content: '⚠️ **Invalid duration number.** Please enter a positive number (e.g. 0 for immediately, 15, 3, 6).',
        ephemeral: true,
      }).catch(() => {});
      return true;
    }

    let unit = 'days';
    if (durationUnitRaw?.startsWith('week')) unit = 'weeks';
    else if (durationUnitRaw?.startsWith('month')) unit = 'months';
    else if (durationUnitRaw?.startsWith('day')) unit = 'days';
    else {
      await interaction.reply({
        content: '⚠️ **Invalid time unit.** Please enter `days`, `weeks`, or `months`.',
        ephemeral: true,
      }).catch(() => {});
      return true;
    }

    const durationMs = convertToMs(durationVal, unit);
    const role = guild.roles?.cache?.get?.(roleId);

    session.stages = session.stages || [];
    session.stages.push({
      roleId,
      roleName: role?.name || roleId,
      durationMs,
      durationValue: durationVal,
      durationUnit: unit,
      description: durationVal === 0 ? 'Assigned immediately on joining' : `After ${formatDurationText(durationMs, durationVal, unit)}`,
    });

    // Re-sort ascending by durationMs
    session.stages.sort((a, b) => a.durationMs - b.durationMs);
    session.stages.forEach((s, idx) => { s.stageNumber = idx + 1; });

    const payload = buildSetupPanelPayload(session, guild);
    await interaction.reply({
      content: `✅ Stage added: **${role?.name || roleId}** (${formatDurationText(durationMs, durationVal, unit)})`,
      ephemeral: true,
    }).catch(() => {});

    // Update the main message panel
    if (interaction.message && typeof interaction.message.edit === 'function') {
      await interaction.message.edit(payload).catch(() => {});
    }
    return true;
  }

  // --- 10. Remove Stage Menu ---
  if (action === 'remove_stage') {
    const payload = buildRemoveStagePayload(session);
    await interaction.update(payload).catch(() => {});
    return true;
  }

  // --- 11. Remove Stage Selected ---
  if (action === 'remove_select') {
    const indexToRemove = parseInt(interaction.values?.[0] || '-1', 10);
    if (indexToRemove >= 0 && indexToRemove < (session.stages || []).length) {
      session.stages.splice(indexToRemove, 1);
      session.stages.forEach((s, idx) => { s.stageNumber = idx + 1; });
    }
    const payload = buildSetupPanelPayload(session, guild);
    await interaction.update(payload).catch(() => {});
    return true;
  }

  // --- 12. Edit Stage Menu ---
  if (action === 'edit_stage') {
    const payload = buildEditStageSelectPayload(session);
    await interaction.update(payload).catch(() => {});
    return true;
  }

  // --- 13. Edit Stage Selected -> Show Modal with Existing Values ---
  if (action === 'edit_select') {
    const editIndex = parseInt(interaction.values?.[0] || '-1', 10);
    const targetStage = session.stages?.[editIndex];
    if (!targetStage) return true;

    const modal = buildDurationModal(
      sessionId,
      targetStage.roleId,
      targetStage.durationValue,
      targetStage.durationUnit,
      true,
      editIndex
    );
    await interaction.showModal(modal).catch((err) => {
      console.warn('[RolePeriod] ⚠️ showModal edit failed:', err.message);
    });
    return true;
  }

  // --- 14. Modal Submit for Stage Edit ---
  if (action === 'modal_edit_submit') {
    const editIndex = parseInt(parts[2] || '-1', 10);
    const targetStage = session.stages?.[editIndex];
    if (!targetStage) return true;

    const durationValRaw = interaction.fields.getTextInputValue('duration_value')?.trim();
    const durationUnitRaw = interaction.fields.getTextInputValue('duration_unit')?.trim()?.toLowerCase();

    const durationVal = parseFloat(durationValRaw);
    if (isNaN(durationVal) || durationVal < 0) {
      await interaction.reply({
        content: '⚠️ **Invalid duration number.** Please enter a positive number.',
        ephemeral: true,
      }).catch(() => {});
      return true;
    }

    let unit = 'days';
    if (durationUnitRaw?.startsWith('week')) unit = 'weeks';
    else if (durationUnitRaw?.startsWith('month')) unit = 'months';
    else if (durationUnitRaw?.startsWith('day')) unit = 'days';
    else {
      await interaction.reply({
        content: '⚠️ **Invalid time unit.** Please enter `days`, `weeks`, or `months`.',
        ephemeral: true,
      }).catch(() => {});
      return true;
    }

    targetStage.durationValue = durationVal;
    targetStage.durationUnit = unit;
    targetStage.durationMs = convertToMs(durationVal, unit);
    targetStage.description = durationVal === 0
      ? 'Assigned immediately on joining'
      : `After ${formatDurationText(targetStage.durationMs, durationVal, unit)}`;

    // Re-sort ascending by durationMs
    session.stages.sort((a, b) => a.durationMs - b.durationMs);
    session.stages.forEach((s, idx) => { s.stageNumber = idx + 1; });

    const payload = buildSetupPanelPayload(session, guild);
    await interaction.reply({
      content: `✅ Stage updated: **${targetStage.roleName}** (${formatDurationText(targetStage.durationMs, durationVal, unit)})`,
      ephemeral: true,
    }).catch(() => {});

    if (interaction.message && typeof interaction.message.edit === 'function') {
      await interaction.message.edit(payload).catch(() => {});
    }
    return true;
  }

  // --- 15. Save Configuration ---
  if (action === 'save') {
    if (!session.stages || session.stages.length === 0) {
      await interaction.reply({
        content: '⚠️ You must configure at least one stage before saving.',
        ephemeral: true,
      }).catch(() => {});
      return true;
    }

    await saveProgressionConfig(session.guildId, {
      stages: session.stages,
      enabled: true,
      updatedBy: interaction.user.id,
    });

    rolePeriodSessions.delete(sessionId);

    const embed = new EmbedBuilder()
      .setTitle('✅ Role Progression System Saved!')
      .setColor(0x57F287)
      .setDescription(
        `Automated role progression has been successfully configured for **${guild.name}**.\n\n` +
        `**Configured Stages (${session.stages.length}):**\n` +
        session.stages.map((st, i) => `• Stage ${i + 1}: <@&${st.roleId}> (\`${formatDurationText(st.durationMs, st.durationValue, st.durationUnit)}\`)`).join('\n') +
        `\n\n*The bot's background checker will now actively evaluate and upgrade member ranks as milestones are reached.*`
      );

    await interaction.update({ embeds: [embed], components: [] }).catch(() => {});

    // Trigger immediate progression evaluation across joined members
    runRolePeriodAudit(client).catch(() => {});
    return true;
  }

  return false;
}

/**
 * Handles member join event for role progression.
 * Records join timestamp and assigns Stage 1 (if immediate milestone exists).
 * @param {import('discord.js').GuildMember} member
 */
export async function handleRolePeriodMemberJoin(member) {
  if (!member || !member.guild || member.user?.bot) return;
  try {
    const serverJoinTs = getDiscordMemberJoinTimestamp(member) || Date.now();
    await recordMemberJoinTimestamp(member.guild.id, member.id, serverJoinTs, member.user?.createdTimestamp);

    const config = await getProgressionConfig(member.guild.id);
    if (!config || !config.enabled || !config.stages || config.stages.length === 0) {
      return;
    }

    await processMemberProgression(member, config);
  } catch (err) {
    console.warn(`[RolePeriod] ⚠️ Error on member join progression for ${member.id}:`, err.message);
  }
}
