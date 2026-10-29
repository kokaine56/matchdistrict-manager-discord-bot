import { enqueueDiscordAction } from './discordQueue.js';

const MEMBER_LIST_FETCH_INTERVAL_MS = 10 * 60 * 1000;
const inFlightFetches = new Map();
const lastFetchAt = new Map();
const loggedFetchErrors = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRateLimitError(error) {
  return error?.status === 429 || error?.code === 429 || error?.retryAfter != null ||
    error?.rawError?.retry_after != null || /rate.?limit/i.test(error?.message || '');
}

function retryAfterMs(error) {
  const headerValue = error?.headers?.get?.('retry-after');
  const rawSeconds = Number(error?.rawError?.retry_after ?? error?.data?.retry_after ?? headerValue);
  const retryAfter = Number(error?.retryAfter);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.ceil(retryAfter);
  if (Number.isFinite(rawSeconds) && rawSeconds > 0) return Math.ceil(rawSeconds * 1000);
  return 1000;
}

function logFetchErrorOnce(guild, error) {
  if (loggedFetchErrors.has(guild.id)) return;
  loggedFetchErrors.add(guild.id);
  console.warn(`[Discord Bot] Full member cache fetch failed for guild ${guild.id}: ${error?.message || error}`, error);
}

/** Full member list fetch is startup-only, shared per guild, and throttled. */
export async function refreshGuildMemberCacheOnce(guild) {
  if (!guild?.members?.fetch) return guild?.members?.cache || null;
  if (inFlightFetches.has(guild.id)) return inFlightFetches.get(guild.id);
  if (Date.now() - (lastFetchAt.get(guild.id) || 0) < MEMBER_LIST_FETCH_INTERVAL_MS) {
    return guild.members.cache;
  }

  lastFetchAt.set(guild.id, Date.now());
  const fetchPromise = enqueueDiscordAction(async () => {
    try {
      return await guild.members.fetch();
    } catch (error) {
      if (!isRateLimitError(error)) {
        logFetchErrorOnce(guild, error);
        return guild.members.cache;
      }

      logFetchErrorOnce(guild, error);
      await sleep(retryAfterMs(error));
      try {
        return await guild.members.fetch();
      } catch (retryError) {
        return guild.members.cache;
      }
    }
  }, 'action').catch((error) => {
    logFetchErrorOnce(guild, error);
    return guild.members.cache;
  });
  inFlightFetches.set(guild.id, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    inFlightFetches.delete(guild.id);
  }
}

export function getCachedRoleMemberCount(role) {
  return role?.members?.size || 0;
}

export function updateGuildMemberCache(member) {
  if (member?.guild?.members?.cache && member.id) member.guild.members.cache.set(member.id, member);
}

export function removeGuildMemberFromCache(member) {
  if (member?.guild?.members?.cache && member.id) member.guild.members.cache.delete(member.id);
}
