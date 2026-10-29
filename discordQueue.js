/**
 * Shared Rate-Limiting Queue for Bulk Discord API Actions.
 *
 * Prevents hitting Discord rate limits by pacing bulk operations:
 * - Channel / Category / Role creation & deletion (300-500ms)
 * - Message posting / editing (~1000ms)
 * - Role assignment / removal (300-500ms)
 * - Automatic 429 Retry-After handling with backoff
 */

export const QUEUE_CONFIG = {
  // Configurable delays (easy to change in one place)
  ACTION_DELAY_MS: 400,   // Delay for creating/deleting channels, categories, roles (300-500ms)
  MESSAGE_DELAY_MS: 1000, // Delay for posting/editing messages in channels (~1 second)
  ROLE_DELAY_MS: 350,     // Delay for role assignment / removal
  MAX_RETRIES: 5,         // Max retries on rate limit (429)
  CONCURRENCY: 1,         // Concurrency limit (1 at a time, at most 2)
};

let globalRateLimitResetUntil = 0;
const queue = [];
let activeWorkers = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a task with rate limit (429) handling and backoff
 */
async function executeWithRetry(fn, retryCount = 0) {
  const now = Date.now();
  if (now < globalRateLimitResetUntil) {
    const waitTime = globalRateLimitResetUntil - now + 50;
    await sleep(waitTime);
  }

  try {
    return await fn();
  } catch (err) {
    const isRateLimited =
      err?.status === 429 ||
      err?.code === 429 ||
      err?.retryAfter != null ||
      err?.rawError?.retry_after != null;

    if (isRateLimited && retryCount < QUEUE_CONFIG.MAX_RETRIES) {
      const retryAfterSec =
        err.retryAfter ??
        err.rawError?.retry_after ??
        (err.headers?.get ? parseFloat(err.headers.get('retry-after')) : null) ??
        1;
      const retryAfterMs = Math.ceil(retryAfterSec * 1000) + 100;
      globalRateLimitResetUntil = Math.max(globalRateLimitResetUntil, Date.now() + retryAfterMs);
      console.warn(
        `[Discord Queue] ⚠️ Rate limit encountered. Waiting ${retryAfterMs}ms before retry (${retryCount + 1}/${QUEUE_CONFIG.MAX_RETRIES})...`
      );
      await sleep(retryAfterMs);
      return executeWithRetry(fn, retryCount + 1);
    }
    throw err;
  }
}

async function processQueue() {
  if (activeWorkers >= QUEUE_CONFIG.CONCURRENCY || queue.length === 0) {
    return;
  }

  activeWorkers++;
  const task = queue.shift();

  try {
    const result = await executeWithRetry(task.fn);
    task.resolve(result);
  } catch (err) {
    task.reject(err);
  } finally {
    const delay =
      task.type === 'message'
        ? QUEUE_CONFIG.MESSAGE_DELAY_MS
        : task.type === 'role'
        ? QUEUE_CONFIG.ROLE_DELAY_MS
        : QUEUE_CONFIG.ACTION_DELAY_MS;

    if (delay > 0) {
      await sleep(delay);
    }

    activeWorkers--;
    processQueue();
  }
}

/**
 * Enqueues a Discord API call
 * @param {() => Promise<any>} fn - The async function executing the API call
 * @param {'action'|'message'|'role'} type - The operation type determining the delay
 */
export function enqueueDiscordAction(fn, type = 'action') {
  return new Promise((resolve, reject) => {
    queue.push({ fn, type, resolve, reject });
    processQueue();
  });
}

/**
 * Convenient wrappers for Discord actions
 */
export async function queueChannelCreate(guild, options) {
  // Optimization: Skip creating if a channel with identical name and parent already exists in cache
  const nameLower = (options.name || '').toLowerCase();
  const existing = Array.from(guild.channels?.cache?.values?.() || []).find((c) => {
    const sameParent = options.parent ? (c.parentId === options.parent || c.parent?.id === options.parent) : true;
    const sameType = options.type != null ? c.type === options.type : true;
    return c.name?.toLowerCase() === nameLower && sameParent && sameType;
  });
  if (existing) {
    return existing;
  }
  return enqueueDiscordAction(() => guild.channels.create(options), 'action');
}

export async function queueChannelDelete(channel, reason = 'Cleanup') {
  if (!channel || channel.deleted) {
    return null;
  }
  // If cache exists and channel is not in cache, it's already gone
  if (channel.guild?.channels?.cache && !channel.guild.channels.cache.has(channel.id)) {
    return null;
  }
  return enqueueDiscordAction(async () => {
    try {
      return await channel.delete(reason);
    } catch (err) {
      if (err?.code === 10003) return null; // Unknown Channel (already deleted)
      throw err;
    }
  }, 'action');
}

export async function queueRoleCreate(guild, options) {
  // Optimization: Skip creating if identical role already exists in cache
  const nameLower = (options.name || '').toLowerCase();
  const existing = Array.from(guild.roles?.cache?.values?.() || []).find(
    (r) => r.name?.toLowerCase() === nameLower
  );
  if (existing) {
    return existing;
  }
  return enqueueDiscordAction(() => guild.roles.create(options), 'action');
}

export async function queueRoleDelete(role, reason = 'Cleanup') {
  if (!role || role.deleted) {
    return null;
  }
  if (role.guild?.roles?.cache && !role.guild.roles.cache.has(role.id)) {
    return null;
  }
  return enqueueDiscordAction(async () => {
    try {
      return await role.delete(reason);
    } catch (err) {
      if (err?.code === 10011) return null; // Unknown Role (already deleted)
      throw err;
    }
  }, 'action');
}

export async function queueRoleAdd(member, roleId, reason) {
  if (!member || member.roles?.cache?.has?.(roleId)) {
    return false; // Skip if already assigned
  }
  return enqueueDiscordAction(() => member.roles.add(roleId, reason), 'role');
}

export async function queueRoleRemove(member, roleId, reason) {
  if (!member || !member.roles?.cache?.has?.(roleId)) {
    return false; // Skip if already removed
  }
  return enqueueDiscordAction(() => member.roles.remove(roleId, reason), 'role');
}

export async function queueChannelSend(channel, payload) {
  if (!channel || typeof channel.send !== 'function') return null;
  return enqueueDiscordAction(() => channel.send(payload), 'message');
}

export async function queueMessageEdit(message, payload) {
  if (!message || typeof message.edit !== 'function') return null;
  return enqueueDiscordAction(() => message.edit(payload), 'message');
}

export async function queueMessageDelete(message) {
  if (!message || typeof message.delete !== 'function') return null;
  return enqueueDiscordAction(async () => {
    try {
      return await message.delete();
    } catch (err) {
      if (err?.code === 10008) return null; // Unknown Message
      throw err;
    }
  }, 'action');
}

export async function queueBulkDelete(channel, messages) {
  if (!channel || typeof channel.bulkDelete !== 'function') return null;
  return enqueueDiscordAction(() => channel.bulkDelete(messages, true).catch(() => null), 'action');
}
