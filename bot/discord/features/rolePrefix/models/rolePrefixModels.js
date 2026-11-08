import { getMongoDb, isMongoConnected } from '../../../../../mongoService.js';

export const ROLE_PREFIX_COLLECTION = 'role_prefixes';

// In-memory fallback / active cache: Map<guildId, Map<roleId, RolePrefixDoc>>
const guildPrefixCache = new Map();

/**
 * Clears the in-memory cache and test stores.
 */
export function clearRolePrefixMemoryCache() {
  guildPrefixCache.clear();
}

/**
 * Ensures indexes exist on MongoDB collection for fast lookups and unique constraints.
 * @param {import('mongodb').Db} db
 */
export async function ensureRolePrefixIndexes(db) {
  if (!db) return;
  try {
    const col = db.collection(ROLE_PREFIX_COLLECTION);
    await col.createIndex({ guildId: 1, roleId: 1 }, { unique: true });
    await col.createIndex({ guildId: 1, prefix: 1 });
    await col.createIndex({ guildId: 1, enabled: 1 });
  } catch (err) {
    console.warn('[RolePrefix] ⚠️ Index creation warning:', err?.message || err);
  }
}

/**
 * Initializes in-memory cache from MongoDB on bot startup.
 */
export async function initRolePrefixCache() {
  guildPrefixCache.clear();
  if (!isMongoConnected()) return;

  try {
    const col = getMongoDb().collection(ROLE_PREFIX_COLLECTION);
    const cursor = col.find({ enabled: true });
    const docs = await cursor.toArray();
    for (const doc of docs) {
      if (!guildPrefixCache.has(doc.guildId)) {
        guildPrefixCache.set(doc.guildId, new Map());
      }
      guildPrefixCache.get(doc.guildId).set(doc.roleId, doc);
    }
    console.log(`[RolePrefix] 🏷️ Loaded ${docs.length} role prefix configuration(s) across ${guildPrefixCache.size} guild(s).`);
  } catch (err) {
    console.warn('[RolePrefix] ⚠️ Failed to load configurations on startup:', err?.message || err);
  }
}

/**
 * Gets all active role prefix configurations for a guild.
 * @param {string} guildId
 * @returns {Array<object>}
 */
export function getGuildRolePrefixesFromCache(guildId) {
  if (!guildId) return [];
  const guildMap = guildPrefixCache.get(String(guildId));
  if (!guildMap) return [];
  return Array.from(guildMap.values()).filter((c) => c.enabled !== false);
}

/**
 * Gets a specific role prefix configuration by guild and role.
 * @param {string} guildId
 * @param {string} roleId
 * @returns {object|null}
 */
export function getRolePrefixFromCache(guildId, roleId) {
  if (!guildId || !roleId) return null;
  const guildMap = guildPrefixCache.get(String(guildId));
  if (!guildMap) return null;
  const doc = guildMap.get(String(roleId));
  return doc && doc.enabled !== false ? doc : null;
}

/**
 * Finds if a prefix is already configured for another role in the guild.
 * @param {string} guildId
 * @param {string} prefix
 * @param {string} [excludeRoleId]
 * @returns {object|null}
 */
export function findPrefixInGuild(guildId, prefix, excludeRoleId = null) {
  if (!guildId || !prefix) return null;
  const normalized = prefix.trim().toLowerCase();
  const configs = getGuildRolePrefixesFromCache(guildId);
  return configs.find(
    (c) => c.prefix.trim().toLowerCase() === normalized && (!excludeRoleId || c.roleId !== String(excludeRoleId))
  ) || null;
}

/**
 * Saves or updates a role prefix configuration in MongoDB and memory.
 * @param {object} param0
 * @returns {Promise<object>}
 */
export async function saveRolePrefix({
  guildId,
  roleId,
  roleName = '',
  prefix,
  enabled = true,
  createdBy = null,
  rolePosition = 0,
}) {
  const gId = String(guildId);
  const rId = String(roleId);
  const cleanPrefix = prefix.trim();

  const now = new Date();
  const record = {
    guildId: gId,
    roleId: rId,
    roleName: roleName || '',
    prefix: cleanPrefix,
    enabled: Boolean(enabled),
    rolePosition: Number(rolePosition) || 0,
    createdBy: createdBy || null,
    updatedAt: now,
  };

  if (isMongoConnected()) {
    const col = getMongoDb().collection(ROLE_PREFIX_COLLECTION);
    await col.updateOne(
      { guildId: gId, roleId: rId },
      {
        $set: record,
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );
  }

  // Update in-memory cache
  if (!guildPrefixCache.has(gId)) {
    guildPrefixCache.set(gId, new Map());
  }
  const existing = guildPrefixCache.get(gId).get(rId);
  const fullRecord = {
    createdAt: existing?.createdAt || now,
    ...record,
  };
  guildPrefixCache.get(gId).set(rId, fullRecord);

  return fullRecord;
}

/**
 * Deletes a role prefix configuration by guild and role.
 * @param {string} guildId
 * @param {string} roleId
 * @returns {Promise<boolean>}
 */
export async function deleteRolePrefix(guildId, roleId) {
  const gId = String(guildId);
  const rId = String(roleId);

  let deleted = false;

  if (isMongoConnected()) {
    const col = getMongoDb().collection(ROLE_PREFIX_COLLECTION);
    const res = await col.deleteOne({ guildId: gId, roleId: rId });
    deleted = (res?.deletedCount || 0) > 0;
  }

  const guildMap = guildPrefixCache.get(gId);
  if (guildMap && guildMap.has(rId)) {
    guildMap.delete(rId);
    deleted = true;
  }

  return deleted;
}

/**
 * Fetches all role prefix configurations from DB or cache for a guild.
 * @param {string} guildId
 * @returns {Promise<Array<object>>}
 */
export async function getGuildRolePrefixes(guildId) {
  const gId = String(guildId);
  if (isMongoConnected()) {
    try {
      const col = getMongoDb().collection(ROLE_PREFIX_COLLECTION);
      const docs = await col.find({ guildId: gId, enabled: true }).toArray();
      // Sync cache
      if (!guildPrefixCache.has(gId)) {
        guildPrefixCache.set(gId, new Map());
      }
      const gMap = guildPrefixCache.get(gId);
      gMap.clear();
      for (const d of docs) {
        gMap.set(d.roleId, d);
      }
      return docs;
    } catch (err) {
      console.warn('[RolePrefix] DB read fallback to cache:', err?.message || err);
    }
  }
  return getGuildRolePrefixesFromCache(gId);
}

