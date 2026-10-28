import crypto from 'crypto';
import { MongoClient } from 'mongodb';
import { logTournamentAction } from './auditLogger.js';

let discordAuditClient = null;

export function setDiscordAuditClient(client) {
  discordAuditClient = client;
}

/**
 * MongoDB Service for MatchDistrict Discord Bot
 * Provides persistent storage for messages, tournaments, rounds, groups, roles,
 * audit logs, and guild settings to prevent duplicates and survive restarts.
 */

let mongoClient = null;
let mongoDb = null;
let isConnected = false;
let isConnecting = false;

const DEFAULT_DB_NAME = 'matchdistrict_discord';

/**
 * Safely masks a MongoDB URI to prevent leaking credentials in logs.
 * @param {string} uri
 * @returns {string}
 */
export function maskMongoUri(uri) {
  if (!uri) return '<empty>';
  try {
    return uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');
  } catch {
    return '***';
  }
}

/**
 * Checks if MongoDB connection is active and ready.
 * @returns {boolean}
 */
export function isMongoConnected() {
  return isConnected && mongoDb !== null;
}

/**
 * Returns the active MongoDB database instance.
 * @returns {import('mongodb').Db|null}
 */
export function getMongoDb() {
  return mongoDb;
}

/**
 * Ensures MongoDB is connected. Throws a user-friendly error if unavailable.
 */
export function ensurePersistenceAvailable() {
  if (!isMongoConnected()) {
    throw new Error(
      '⚠️ Database connection unavailable. State-changing operations requiring persistence are disabled. Please contact an administrator or verify MONGODB_URI.'
    );
  }
}

/**
 * Computes a deterministic SHA-256 hash of a message payload (content, embeds, components).
 * @param {object} payload
 * @returns {string}
 */
export function computeContentHash(payload) {
  if (!payload) return '';
  try {
    const normalized = {
      content: payload.content || '',
      embeds: Array.isArray(payload.embeds)
        ? payload.embeds.map((e) => (typeof e?.toJSON === 'function' ? e.toJSON() : e?.data || e))
        : [],
      components: Array.isArray(payload.components)
        ? payload.components.map((c) => (typeof c?.toJSON === 'function' ? c.toJSON() : c?.data || c))
        : [],
    };
    return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  } catch (err) {
    return crypto.createHash('sha256').update(String(Date.now())).digest('hex');
  }
}

/**
 * Connects to MongoDB, sets up database collections and required indexes.
 * @param {string} [connectionUri]
 * @returns {Promise<boolean>}
 */
export async function initMongo(connectionUri) {
  const uri = connectionUri || process.env.MONGODB_URI;

  if (!uri) {
    console.warn('[MongoDB] ⚠️ MONGODB_URI environment variable is not defined. Bot running without database persistence.');
    isConnected = false;
    return false;
  }

  if (isConnected && mongoDb) {
    return true;
  }

  if (isConnecting) {
    return false;
  }

  isConnecting = true;
  const maskedUri = maskMongoUri(uri);

  try {
    console.log(`[MongoDB] 🔄 Connecting to MongoDB at ${maskedUri}...`);

    mongoClient = new MongoClient(uri, {
      maxPoolSize: 10,
      minPoolSize: 2,
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000,
    });

    await mongoClient.connect();

    const dbName = process.env.MONGODB_DB_NAME || DEFAULT_DB_NAME;
    mongoDb = mongoClient.db(dbName);
    isConnected = true;
    isConnecting = false;

    console.log(`[MongoDB] 🚀 Connected successfully to database: "${mongoDb.databaseName}"`);

    // Initialize collections and create required indexes
    await ensureMongoIndexes();

    // Listen for client errors or disconnections
    mongoClient.on('error', (err) => {
      console.error('[MongoDB] ⚠️ Client error event:', err.message);
      isConnected = false;
    });

    mongoClient.on('close', () => {
      console.warn('[MongoDB] ⚠️ Connection closed.');
      isConnected = false;
    });

    return true;
  } catch (err) {
    isConnecting = false;
    isConnected = false;
    console.error(`[MongoDB] ❌ Failed to connect to MongoDB (${maskedUri}):`, err.message);
    return false;
  }
}

/**
 * Creates all required indexes for collections if they do not exist.
 */
async function ensureMongoIndexes() {
  if (!mongoDb) return;

  try {
    const msgCol = mongoDb.collection('discord_managed_messages');
    await msgCol.createIndex({ guildId: 1, logicalKey: 1 }, { unique: true });
    await msgCol.createIndex({ guildId: 1, messageType: 1 });
    await msgCol.createIndex({ guildId: 1, tournamentId: 1 });
    await msgCol.createIndex({ tournamentId: 1 });
    await msgCol.createIndex({ roundId: 1 });
    await msgCol.createIndex({ groupId: 1 });
    await msgCol.createIndex({ channelId: 1, messageId: 1 });
    await msgCol.createIndex({ status: 1 });

    const tourCol = mongoDb.collection('discord_tournaments');
    await tourCol.createIndex({ guildId: 1, tournamentId: 1 }, { unique: true });
    await tourCol.createIndex({ tournamentId: 1 });
    await tourCol.createIndex({ 'channels.botCommandsId': 1 });
    await tourCol.createIndex({ deletionStatus: 1 });
    await tourCol.createIndex({ "rounds.roundId": 1 });

    const guildCol = mongoDb.collection('discord_guild_settings');
    await guildCol.createIndex({ guildId: 1 }, { unique: true });

    const lockCol = mongoDb.collection('discord_locks');
    await lockCol.createIndex({ lockKey: 1 }, { unique: true });
    await lockCol.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

    const auditCol = mongoDb.collection('discord_audit_logs');
    await auditCol.createIndex({ guildId: 1, timestamp: -1 });
    await auditCol.createIndex({ tournamentId: 1, timestamp: -1 });
    await auditCol.createIndex({ action: 1 });

    const orgLinkCol = mongoDb.collection('discord_organiser_links');
    await orgLinkCol.createIndex({ guildId: 1 }, { unique: true });
    await orgLinkCol.createIndex({ organiserId: 1 });
    await orgLinkCol.createIndex({ status: 1 });

    console.log('[MongoDB] 🔒 Indexes verified across managed collections.');
  } catch (err) {
    console.warn('[MongoDB] ⚠️ Error creating indexes:', err.message);
  }
}

/**
 * Acquires a distributed atomic lock using the discord_locks collection with TTL.
 * @param {string} lockKey
 * @param {number} ttlSeconds
 * @param {number} maxWaitMs
 * @returns {Promise<boolean>}
 */
export async function acquireLock(lockKey, ttlSeconds = 15, maxWaitMs = 5000) {
  if (!isMongoConnected()) return true;

  const lockCol = mongoDb.collection('discord_locks');
  const startTime = Date.now();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  while (Date.now() - startTime < maxWaitMs) {
    try {
      await lockCol.updateOne(
        { lockKey },
        {
          $setOnInsert: {
            lockKey,
            lockedAt: new Date(),
            expiresAt,
          },
        },
        { upsert: true }
      );
      return true;
    } catch (err) {
      if (err.code === 11000) {
        // Lock currently held, check if expired
        const existing = await lockCol.findOne({ lockKey }).catch(() => null);
        if (existing && existing.expiresAt && new Date(existing.expiresAt) < new Date()) {
          // Expired lock, replace it
          try {
            await lockCol.deleteOne({ lockKey, expiresAt: existing.expiresAt });
            continue;
          } catch {
            // Ignore concurrent delete
          }
        }
        // Wait and retry
        await new Promise((r) => setTimeout(r, 250));
      } else {
        console.warn(`[MongoDB] Lock acquire error for ${lockKey}:`, err.message);
        return true;
      }
    }
  }

  return false;
}

/**
 * Releases a distributed atomic lock.
 * @param {string} lockKey
 */
export async function releaseLock(lockKey) {
  if (!isMongoConnected()) return;
  try {
    const lockCol = mongoDb.collection('discord_locks');
    await lockCol.deleteOne({ lockKey });
  } catch (err) {
    console.warn(`[MongoDB] Lock release error for ${lockKey}:`, err.message);
  }
}

/**
 * Upserts a managed Discord message idempotently.
 * 
 * 1. Checks MongoDB for existing message by stable logicalKey.
 * 2. Fetches message from Discord channel.
 * 3. If exists and content changed -> edits message in place.
 * 4. If exists and up to date -> does nothing.
 * 5. If manually deleted from Discord -> recreates message and updates stored messageId.
 * 6. If record does not exist -> creates message with concurrency lock and persists ID.
 *
 * @param {import('discord.js').Client} client
 * @param {object} options
 * @param {string} options.guildId
 * @param {string} options.channelId
 * @param {string} options.logicalKey
 * @param {string} options.messageType
 * @param {string} [options.tournamentId]
 * @param {string} [options.roundId]
 * @param {string} [options.groupId]
 * @param {number} [options.pageIndex]
 * @param {object} options.payload
 * @param {object} [options.extraMetadata]
 * @returns {Promise<{message: import('discord.js').Message|null, created: boolean, updated: boolean, unchanged: boolean, messageId: string|null}>}
 */
export async function upsertManagedMessage(client, options) {
  const {
    guildId,
    channelId,
    logicalKey,
    messageType,
    tournamentId = null,
    roundId = null,
    groupId = null,
    pageIndex = null,
    payload,
    extraMetadata = {},
  } = options;

  if (!guildId || !channelId || !logicalKey || !payload) {
    throw new Error('upsertManagedMessage requires guildId, channelId, logicalKey, and payload');
  }

  const payloadHash = computeContentHash(payload);

  if (!isMongoConnected()) {
    // If Mongo is offline, try fetching target channel and sending/editing as fallback
    const channel = client.channels.cache.get(channelId) || (await client.channels.fetch(channelId).catch(() => null));
    if (!channel) throw new Error(`Target channel ${channelId} not found`);
    const sentMsg = await channel.send(payload);
    return { message: sentMsg, created: true, updated: false, unchanged: false, messageId: sentMsg?.id || null };
  }

  const msgCol = mongoDb.collection('discord_managed_messages');

  // Step 1: Look up existing record in MongoDB
  const existingRecord = await msgCol.findOne({ guildId, logicalKey }).catch((err) => {
    console.warn(`[MongoDB] Error looking up managed message ${logicalKey}:`, err.message);
    return null;
  });

  if (existingRecord && existingRecord.status !== 'deleted' && existingRecord.messageId) {
    const targetChannelId = existingRecord.channelId || channelId;
    const channel = client.channels.cache.get(targetChannelId) || (await client.channels.fetch(targetChannelId).catch(() => null));

    if (channel && typeof channel.messages?.fetch === 'function') {
      let discordMsg = null;
      try {
        discordMsg = await channel.messages.fetch(existingRecord.messageId).catch((err) => {
          if (err.code === 10008) return null; // Unknown message (manually deleted)
          throw err;
        });
      } catch (fetchErr) {
        if (fetchErr.code === 10008) {
          discordMsg = null;
        } else {
          console.warn(`[MongoDB] Error fetching message ${existingRecord.messageId}:`, fetchErr.message);
        }
      }

      if (discordMsg) {
        // Message exists in Discord
        if (existingRecord.contentHash === payloadHash) {
          // Exactly identical content and components -> do nothing
          await msgCol.updateOne(
            { _id: existingRecord._id },
            { $set: { lastSyncedAt: new Date(), status: 'active' } }
          ).catch(() => {});

          return {
            message: discordMsg,
            created: false,
            updated: false,
            unchanged: true,
            messageId: discordMsg.id,
          };
        }

        // Content changed -> edit existing message in place
        try {
          await discordMsg.edit(payload);
          await msgCol.updateOne(
            { _id: existingRecord._id },
            {
              $set: {
                contentHash: payloadHash,
                channelId: channel.id,
                updatedAt: new Date(),
                lastSyncedAt: new Date(),
                status: 'active',
                metadata: { ...existingRecord.metadata, ...extraMetadata },
              },
            }
          ).catch((upErr) => {
            console.warn(`[MongoDB] Error updating managed message record ${logicalKey}:`, upErr.message);
          });

          return {
            message: discordMsg,
            created: false,
            updated: true,
            unchanged: false,
            messageId: discordMsg.id,
          };
        } catch (editErr) {
          if (editErr.code === 10008) {
            // Message was deleted during edit attempt
            discordMsg = null;
          } else {
            throw editErr;
          }
        }
      }
    }
  }

  // Step 2: Message does not exist or was deleted -> create replacement with concurrency lock
  const lockKey = `msg_lock:${guildId}:${logicalKey}`;
  const lockAcquired = await acquireLock(lockKey, 15);

  try {
    // Re-check after lock acquired to handle racing creations
    const doubleCheck = await msgCol.findOne({ guildId, logicalKey }).catch(() => null);
    if (doubleCheck && doubleCheck.status !== 'deleted' && doubleCheck.messageId) {
      const channel = client.channels.cache.get(doubleCheck.channelId || channelId) ||
        (await client.channels.fetch(doubleCheck.channelId || channelId).catch(() => null));
      if (channel && typeof channel.messages?.fetch === 'function') {
        const doubleMsg = await channel.messages.fetch(doubleCheck.messageId).catch(() => null);
        if (doubleMsg) {
          if (doubleCheck.contentHash === payloadHash) {
            return { message: doubleMsg, created: false, updated: false, unchanged: true, messageId: doubleMsg.id };
          }
          await doubleMsg.edit(payload);
          await msgCol.updateOne(
            { _id: doubleCheck._id },
            { $set: { contentHash: payloadHash, updatedAt: new Date(), lastSyncedAt: new Date(), status: 'active' } }
          ).catch(() => {});
          return { message: doubleMsg, created: false, updated: true, unchanged: false, messageId: doubleMsg.id };
        }
      }
    }

    const channel = client.channels.cache.get(channelId) || (await client.channels.fetch(channelId).catch(() => null));
    if (!channel) throw new Error(`Target channel ${channelId} not found`);

    // Send Discord message
    const createdMsg = await channel.send(payload);

    // Save record to MongoDB with upsert
    const recordId = existingRecord?._id || `msg_${guildId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await msgCol.updateOne(
      { guildId, logicalKey },
      {
        $set: {
          guildId,
          channelId: channel.id,
          messageId: createdMsg.id,
          messageType,
          tournamentId: tournamentId || null,
          roundId: roundId || null,
          groupId: groupId || null,
          pageIndex: pageIndex ?? null,
          contentHash: payloadHash,
          status: 'active',
          updatedAt: new Date(),
          lastSyncedAt: new Date(),
          metadata: extraMetadata || {},
        },
        $setOnInsert: {
          _id: recordId,
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );

    return {
      message: createdMsg,
      created: true,
      updated: false,
      unchanged: false,
      messageId: createdMsg.id,
    };
  } finally {
    if (lockAcquired) {
      await releaseLock(lockKey);
    }
  }
}

/**
 * Idempotently manages multi-page messages (such as tournament team lists and round allocation summaries).
 * 
 * - Updates or creates pages 1..N using pageIndex.
 * - Deletes any excess pages if the payload shrunk.
 * 
 * @param {import('discord.js').Client} client
 * @param {object} options
 * @param {string} options.guildId
 * @param {string} options.channelId
 * @param {string} options.logicalKeyPrefix
 * @param {string} options.messageType
 * @param {string} [options.tournamentId]
 * @param {string} [options.roundId]
 * @param {string} [options.groupId]
 * @param {Array<object>} options.pagesPayloads
 * @returns {Promise<Array<string>>} Array of Discord message IDs
 */
export async function upsertManagedMessageBatch(client, options) {
  const {
    guildId,
    channelId,
    logicalKeyPrefix,
    messageType,
    tournamentId = null,
    roundId = null,
    groupId = null,
    pagesPayloads = [],
  } = options;

  const messageIds = [];

  for (let i = 0; i < pagesPayloads.length; i++) {
    const pagePayload = pagesPayloads[i];
    const logicalKey = `${logicalKeyPrefix}:page:${i}`;

    const res = await upsertManagedMessage(client, {
      guildId,
      channelId,
      logicalKey,
      messageType,
      tournamentId,
      roundId,
      groupId,
      pageIndex: i,
      payload: pagePayload,
    });

    if (res.messageId) {
      messageIds.push(res.messageId);
    }
  }

  // Clean up excess pages if total pages decreased
  if (isMongoConnected()) {
    try {
      const msgCol = mongoDb.collection('discord_managed_messages');
      const escapedPrefix = logicalKeyPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const excessRecords = await msgCol.find({
        guildId,
        logicalKey: { $regex: `^${escapedPrefix}:page:` },
        pageIndex: { $gte: pagesPayloads.length },
        status: 'active',
      }).toArray();

      for (const rec of excessRecords) {
        try {
          const channel = client.channels.cache.get(rec.channelId) || (await client.channels.fetch(rec.channelId).catch(() => null));
          if (channel && typeof channel.messages?.fetch === 'function') {
            const oldMsg = await channel.messages.fetch(rec.messageId).catch(() => null);
            if (oldMsg) await oldMsg.delete().catch(() => {});
          }
          await msgCol.updateOne({ _id: rec._id }, { $set: { status: 'deleted', deletedAt: new Date() } });
        } catch (delErr) {
          console.warn(`[MongoDB] Error pruning excess page ${rec.logicalKey}:`, delErr.message);
        }
      }
    } catch (cleanErr) {
      console.warn(`[MongoDB] Error during excess page cleanup for ${logicalKeyPrefix}:`, cleanErr.message);
    }
  }

  return messageIds;
}

/**
 * Persistently deletes managed Discord messages and marks their database records as deleted.
 * Works reliably after bot restarts using stored message IDs.
 *
 * @param {import('discord.js').Client} client
 * @param {object} filter Query filter (e.g. guildId, tournamentId, roundId, groupId, messageType, logicalKey, messageId)
 * @param {object} [adminUser]
 * @returns {Promise<{deletedCount: number, messageIds: Array<string>}>}
 */
export async function deleteManagedMessages(client, filter, adminUser = null) {
  if (!filter || typeof filter !== 'object') {
    throw new Error('deleteManagedMessages requires a filter object');
  }

  const query = { status: { $ne: 'deleted' } };
  if (filter.guildId) query.guildId = filter.guildId;
  if (filter.tournamentId) query.tournamentId = filter.tournamentId;
  if (filter.roundId) query.roundId = filter.roundId;
  if (filter.groupId) query.groupId = filter.groupId;
  if (filter.messageType) query.messageType = filter.messageType;
  if (filter.logicalKey) query.logicalKey = filter.logicalKey;
  if (filter.messageId) query.messageId = filter.messageId;

  if (!isMongoConnected()) {
    return { deletedCount: 0, messageIds: [] };
  }

  const msgCol = mongoDb.collection('discord_managed_messages');
  const matchingRecords = await msgCol.find(query).toArray().catch((err) => {
    console.warn('[MongoDB] Error finding messages to delete:', err.message);
    return [];
  });

  const deletedIds = [];

  for (const record of matchingRecords) {
    try {
      if (record.channelId && record.messageId) {
        const channel = client.channels.cache.get(record.channelId) ||
          (await client.channels.fetch(record.channelId).catch(() => null));

        if (channel && typeof channel.messages?.fetch === 'function') {
          const msg = await channel.messages.fetch(record.messageId).catch((err) => {
            if (err.code === 10008 || err.code === 10003) return null; // Unknown message / channel
            throw err;
          });
          if (msg) {
            await msg.delete().catch((delErr) => {
              if (delErr.code !== 10008 && delErr.code !== 10003) {
                console.warn(`[MongoDB] Failed to delete Discord message ${record.messageId}:`, delErr.message);
              }
            });
          }
        }
      }

      await msgCol.updateOne(
        { _id: record._id },
        {
          $set: {
            status: 'deleted',
            deletedAt: new Date(),
            deletedBy: adminUser?.id || 'admin',
          },
        }
      );
      deletedIds.push(record.messageId);
    } catch (err) {
      console.warn(`[MongoDB] Error processing deletion for message ${record.messageId}:`, err.message);
      // Reconcile status to deleted anyway so we do not attempt repeatedly
      await msgCol.updateOne({ _id: record._id }, { $set: { status: 'deleted', deletedAt: new Date() } }).catch(() => {});
    }
  }

  // Audit log entry
  if (deletedIds.length > 0) {
    await recordAuditLog(filter.guildId || 'system', 'DELETE_MANAGED_MESSAGES', {
      filter,
      deletedCount: deletedIds.length,
      deletedIds,
      adminId: adminUser?.id || 'system',
    });
  }

  return { deletedCount: deletedIds.length, messageIds: deletedIds };
}

/**
 * Records an audit log event in the discord_audit_logs collection.
 * @param {string} guildId
 * @param {string} action
 * @param {object} details
 * @param {object} [adminUser]
 */
export async function recordAuditLog(guildId, action, details, adminUser = null) {
  if (isMongoConnected()) {
    try {
      const auditCol = mongoDb.collection('discord_audit_logs');
      await auditCol.insertOne({
        guildId,
        action,
        details,
        tournamentId: details?.tournamentId || null,
        adminId: adminUser?.id || details?.adminId || 'system',
        timestamp: new Date(),
      });
    } catch (err) {
      console.warn('[MongoDB] Error recording audit log:', err.message);
    }
  }

  // Unified Discord Embed Dispatch
  if (discordAuditClient && guildId && guildId !== 'system' && !details?.skipDiscordLog) {
    try {
      const guild = discordAuditClient.guilds?.cache?.get(guildId);
      if (guild) {
        await logTournamentAction(guild, action, {
          ...details,
          adminId: adminUser?.id || details?.adminId,
          adminTag: adminUser?.tag || details?.adminTag,
        });
      }
    } catch (auditErr) {
      console.warn('[Audit Logger] ⚠️ Error dispatching tournament audit embed:', auditErr.message);
    }
  }
}

/**
 * Saves a tournament record persistently in MongoDB.
 * @param {string} guildId
 * @param {string} tournamentId
 * @param {object} tournamentData
 */
export async function saveTournamentToDb(guildId, tournamentId, tournamentData) {
  if (!isMongoConnected() || !guildId || !tournamentId) return;
  try {
    const tourCol = mongoDb.collection('discord_tournaments');
    await tourCol.updateOne(
      { guildId, tournamentId },
      {
        $set: {
          ...tournamentData,
          guildId,
          tournamentId,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );
  } catch (err) {
    console.warn(`[MongoDB] Error saving tournament ${tournamentId} to MongoDB:`, err.message);
  }
}

/**
 * Retrieves a tournament record from MongoDB.
 * @param {string} guildId
 * @param {string} tournamentId
 * @returns {Promise<object|null>}
 */
export async function getTournamentFromDb(guildId, tournamentId) {
  if (!isMongoConnected() || !guildId || !tournamentId) return null;
  try {
    const tourCol = mongoDb.collection('discord_tournaments');
    return await tourCol.findOne({ guildId, tournamentId });
  } catch (err) {
    console.warn(`[MongoDB] Error reading tournament ${tournamentId}:`, err.message);
    return null;
  }
}

/**
 * Retrieves all tournaments for a guild from MongoDB.
 * @param {string} guildId
 * @returns {Promise<Array<object>>}
 */
export async function getAllTournamentsFromDb(guildId) {
  if (!isMongoConnected() || !guildId) return [];
  try {
    const tourCol = mongoDb.collection('discord_tournaments');
    return await tourCol.find({ guildId }).toArray();
  } catch (err) {
    console.warn(`[MongoDB] Error reading tournaments for guild ${guildId}:`, err.message);
    return [];
  }
}

/**
 * Removes a tournament record from MongoDB.
 * @param {string} guildId
 * @param {string} tournamentId
 */
export async function deleteTournamentFromDb(guildId, tournamentId) {
  if (!isMongoConnected() || !guildId || !tournamentId) return;
  try {
    const tourCol = mongoDb.collection('discord_tournaments');
    await tourCol.deleteOne({ guildId, tournamentId });
  } catch (err) {
    console.warn(`[MongoDB] Error deleting tournament ${tournamentId}:`, err.message);
  }
}

/**
 * Resolves a tournament associated with a specific #bot-commands channel from MongoDB.
 * @param {string} guildId
 * @param {string} channelId
 * @returns {Promise<object|null>}
 */
export async function findTournamentByBotCommandsChannel(guildId, channelId) {
  if (!isMongoConnected() || !guildId || !channelId) return null;
  try {
    const tourCol = mongoDb.collection('discord_tournaments');
    return await tourCol.findOne({
      guildId,
      'channels.botCommandsId': channelId,
    });
  } catch (err) {
    console.warn(`[MongoDB] Error looking up tournament for channel ${channelId}:`, err.message);
    return null;
  }
}

/**
 * Permanently deletes all database records belonging to a tournament across all collections.
 * @param {string} guildId
 * @param {string} tournamentId
 */
export async function purgeAllTournamentDataFromDb(guildId, tournamentId) {
  if (!isMongoConnected() || !guildId || !tournamentId) return;
  try {
    const tourCol = mongoDb.collection('discord_tournaments');
    await tourCol.deleteOne({ guildId, tournamentId });

    const msgCol = mongoDb.collection('discord_managed_messages');
    await msgCol.deleteMany({ guildId, tournamentId });

    console.log(`[MongoDB] 🗑️ Purged all records for tournament ${tournamentId} from MongoDB.`);
  } catch (err) {
    console.warn(`[MongoDB] Error purging tournament ${tournamentId} from database:`, err.message);
  }
}

/**
 * Retrieves all tournaments with pending or active deletion status for resume on restart.
 * @param {string} [guildId]
 * @returns {Promise<Array<object>>}
 */
export async function getPendingTournamentDeletions(guildId) {
  if (!isMongoConnected()) return [];
  try {
    const tourCol = mongoDb.collection('discord_tournaments');
    const query = {
      deletionStatus: { $in: ['deletion_pending', 'deleting'] },
    };
    if (guildId) query.guildId = guildId;
    return await tourCol.find(query).toArray();
  } catch (err) {
    console.warn('[MongoDB] Error querying pending tournament deletions:', err.message);
    return [];
  }
}

/**
 * Enforces that only one round is Active per tournament atomically in MongoDB.
 * @param {string} guildId
 * @param {string} tournamentId
 * @param {string} targetActiveRoundId
 */
export async function enforceSingleActiveRoundInDb(guildId, tournamentId, targetActiveRoundId) {
  if (!isMongoConnected()) return;
  try {
    const tourCol = mongoDb.collection('discord_tournaments');
    const tournament = await tourCol.findOne({ guildId, tournamentId });
    if (!tournament || !Array.isArray(tournament.rounds)) return;

    const updatedRounds = tournament.rounds.map((r) => {
      if (r.roundId === targetActiveRoundId) {
        return { ...r, status: 'Active' };
      } else if (r.status === 'Active') {
        return { ...r, status: 'Completed' };
      }
      return r;
    });

    await tourCol.updateOne(
      { guildId, tournamentId },
      { $set: { rounds: updatedRounds, updatedAt: new Date() } }
    );
  } catch (err) {
    console.warn(`[MongoDB] Error enforcing single active round for tournament ${tournamentId}:`, err.message);
  }
}

/**
 * Saves guild settings persistently to MongoDB.
 * @param {string} guildId
 * @param {object} settings
 */
export async function saveGuildSettingsToDb(guildId, settings) {
  if (!isMongoConnected() || !guildId) return;
  try {
    const guildCol = mongoDb.collection('discord_guild_settings');
    await guildCol.updateOne(
      { guildId },
      {
        $set: {
          ...settings,
          guildId,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );
  } catch (err) {
    console.warn(`[MongoDB] Error saving guild settings for ${guildId}:`, err.message);
  }
}

/**
 * Retrieves guild settings from MongoDB.
 * @param {string} guildId
 * @returns {Promise<object|null>}
 */
export async function getGuildSettingsFromDb(guildId) {
  if (!isMongoConnected() || !guildId) return null;
  try {
    const guildCol = mongoDb.collection('discord_guild_settings');
    return await guildCol.findOne({ guildId });
  } catch (err) {
    console.warn(`[MongoDB] Error reading guild settings for ${guildId}:`, err.message);
    return null;
  }
}

/**
 * Loads all guild settings from MongoDB into a keyed object.
 * @returns {Promise<Record<string, object>>}
 */
export async function loadAllGuildSettingsFromDb() {
  if (!isMongoConnected()) return {};
  try {
    const guildCol = mongoDb.collection('discord_guild_settings');
    const records = await guildCol.find({}).toArray();
    const result = {};
    for (const rec of records) {
      if (rec.guildId) {
        const { _id, ...cleanRec } = rec;
        result[rec.guildId] = cleanRec;
      }
    }
    return result;
  } catch (err) {
    console.warn('[MongoDB] Error loading all guild settings:', err.message);
    return {};
  }
}

/**
 * Asynchronously synchronizes the full guild settings cache to MongoDB.
 * @param {Record<string, object>} cache
 */
export async function syncGuildSettingsCacheToDb(cache) {
  if (!isMongoConnected() || !cache || typeof cache !== 'object') return;
  try {
    for (const [guildId, settings] of Object.entries(cache)) {
      if (!guildId || !settings) continue;
      const { tournaments, ...baseSettings } = settings;

      // 1. Save base guild settings
      await saveGuildSettingsToDb(guildId, baseSettings);

      // 2. Save individual tournaments
      if (tournaments && typeof tournaments === 'object') {
        for (const [tournamentId, tourData] of Object.entries(tournaments)) {
          if (tournamentId && tourData) {
            await saveTournamentToDb(guildId, tournamentId, tourData);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[MongoDB] Error syncing cache to database:', err.message);
  }
}

/**
 * Migrates existing data from guildSettings.json into MongoDB if not already migrated.
 * Preserves existing tournaments, channels, roles, and message IDs.
 *
 * @param {Record<string, object>} legacySettings
 */
export async function migrateJsonToMongo(legacySettings) {
  if (!isMongoConnected() || !legacySettings || typeof legacySettings !== 'object') return;

  try {
    const metaCol = mongoDb.collection('discord_guild_settings');
    const migrationDoc = await metaCol.findOne({ _id: 'migration_metadata' }).catch(() => null);

    if (migrationDoc && migrationDoc.legacyJsonImported) {
      // Already migrated
      return;
    }

    console.log('[MongoDB] 📦 Migrating legacy JSON settings into MongoDB...');

    const msgCol = mongoDb.collection('discord_managed_messages');

    for (const [guildId, settings] of Object.entries(legacySettings)) {
      if (!guildId || !settings || guildId === 'migration_metadata') continue;

      const { tournaments, ...baseSettings } = settings;
      await saveGuildSettingsToDb(guildId, baseSettings);

      if (tournaments && typeof tournaments === 'object') {
        for (const [tournamentId, tourData] of Object.entries(tournaments)) {
          if (!tournamentId || !tourData) continue;
          await saveTournamentToDb(guildId, tournamentId, tourData);

          // Register legacy message IDs in discord_managed_messages so they are remembered across restarts
          if (tourData.controlPanelMessageId && tourData.channels?.botCommandsId) {
            const logicalKey = `guild:${guildId}:tournament:${tournamentId}:control_panel`;
            await msgCol.updateOne(
              { guildId, logicalKey },
              {
                $setOnInsert: {
                  _id: `msg_legacy_${guildId}_${tournamentId}_cp`,
                  guildId,
                  logicalKey,
                  channelId: tourData.channels.botCommandsId,
                  messageId: tourData.controlPanelMessageId,
                  messageType: 'tournament_control_panel',
                  tournamentId,
                  status: 'active',
                  createdAt: new Date(),
                  updatedAt: new Date(),
                  lastSyncedAt: new Date(),
                },
              },
              { upsert: true }
            );
          }

          if (tourData.registrationMessageId && tourData.channels?.registrationId) {
            const logicalKey = `guild:${guildId}:tournament:${tournamentId}:registration_link`;
            await msgCol.updateOne(
              { guildId, logicalKey },
              {
                $setOnInsert: {
                  _id: `msg_legacy_${guildId}_${tournamentId}_reg`,
                  guildId,
                  logicalKey,
                  channelId: tourData.channels.registrationId,
                  messageId: tourData.registrationMessageId,
                  messageType: 'registration_link',
                  tournamentId,
                  status: 'active',
                  createdAt: new Date(),
                  updatedAt: new Date(),
                  lastSyncedAt: new Date(),
                },
              },
              { upsert: true }
            );
          }

          if (Array.isArray(tourData.teamListMessageIds) && tourData.channels?.tournamentTeamsId) {
            for (let i = 0; i < tourData.teamListMessageIds.length; i++) {
              const msgId = tourData.teamListMessageIds[i];
              if (!msgId) continue;
              const logicalKey = `guild:${guildId}:tournament:${tournamentId}:teams_roster:page:${i}`;
              await msgCol.updateOne(
                { guildId, logicalKey },
                {
                  $setOnInsert: {
                    _id: `msg_legacy_${guildId}_${tournamentId}_roster_${i}`,
                    guildId,
                    logicalKey,
                    channelId: tourData.channels.tournamentTeamsId,
                    messageId: msgId,
                    messageType: 'teams_roster',
                    tournamentId,
                    pageIndex: i,
                    status: 'active',
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    lastSyncedAt: new Date(),
                  },
                },
              { upsert: true }
            );
            }
          }

          if (Array.isArray(tourData.rounds)) {
            for (const round of tourData.rounds) {
              if (Array.isArray(round.summaryMessageIds) && tourData.channels?.roundAllocationsId) {
                for (let i = 0; i < round.summaryMessageIds.length; i++) {
                  const sId = round.summaryMessageIds[i];
                  if (!sId) continue;
                  const logicalKey = `guild:${guildId}:tournament:${tournamentId}:round:${round.roundId}:summary:page:${i}`;
                  await msgCol.updateOne(
                    { guildId, logicalKey },
                    {
                      $setOnInsert: {
                        _id: `msg_legacy_${guildId}_${tournamentId}_${round.roundId}_sum_${i}`,
                        guildId,
                        logicalKey,
                        channelId: tourData.channels.roundAllocationsId,
                        messageId: sId,
                        messageType: 'round_allocation_summary',
                        tournamentId,
                        roundId: round.roundId,
                        pageIndex: i,
                        status: 'active',
                        createdAt: new Date(),
                        updatedAt: new Date(),
                        lastSyncedAt: new Date(),
                      },
                    },
                    { upsert: true }
                  );
                }
              }

              if (Array.isArray(round.groups)) {
                for (const grp of round.groups) {
                  if (grp.submissionControlMessageId && grp.channelId) {
                    const logicalKey = `guild:${guildId}:tournament:${tournamentId}:round:${round.roundId}:group:${grp.groupId}:submission_control`;
                    await msgCol.updateOne(
                      { guildId, logicalKey },
                      {
                        $setOnInsert: {
                          _id: `msg_legacy_${guildId}_${tournamentId}_${round.roundId}_${grp.groupId}_sub`,
                          guildId,
                          logicalKey,
                          channelId: grp.channelId,
                          messageId: grp.submissionControlMessageId,
                          messageType: 'group_submission_control',
                          tournamentId,
                          roundId: round.roundId,
                          groupId: grp.groupId,
                          status: 'active',
                          createdAt: new Date(),
                          updatedAt: new Date(),
                          lastSyncedAt: new Date(),
                        },
                      },
                      { upsert: true }
                    );
                  }
                }
              }
            }
          }
        }
      }
    }

    // Mark migration completed
    await metaCol.updateOne(
      { _id: 'migration_metadata' },
      {
        $set: {
          _id: 'migration_metadata',
          legacyJsonImported: true,
          migratedAt: new Date(),
        },
      },
      { upsert: true }
    );

    console.log('[MongoDB] ✅ Successfully migrated legacy JSON settings into MongoDB.');
  } catch (err) {
    console.warn('[MongoDB] ⚠️ Error during JSON migration:', err.message);
  }
}

/**
 * Startup reconciliation: Validates and recovers managed Discord resources across restarts.
 * Ensures stored messages are intact, restores state, and avoids duplicate messages.
 *
 * @param {import('discord.js').Client} client
 * @param {string} officialGuildId
 */
export async function reconcileManagedBotState(client, officialGuildId) {
  if (!isMongoConnected() || !client) return;

  try {
    console.log('[MongoDB] 🔄 Reconciling managed bot state across Discord and MongoDB...');

    const guild = officialGuildId ? client.guilds.cache.get(officialGuildId) || (await client.guilds.fetch(officialGuildId).catch(() => null)) : null;

    if (!guild) {
      console.log('[MongoDB] ℹ️ Official guild not yet cached or configured for full reconciliation.');
      return;
    }

    const msgCol = mongoDb.collection('discord_managed_messages');
    const activeMessages = await msgCol.find({ guildId: guild.id, status: 'active' }).toArray();

    let verifiedCount = 0;
    let missingCount = 0;

    for (const record of activeMessages) {
      try {
        const channel = guild.channels.cache.get(record.channelId) || (await guild.channels.fetch(record.channelId).catch(() => null));
        if (!channel) {
          missingCount++;
          continue;
        }

        const msg = await channel.messages.fetch(record.messageId).catch((err) => {
          if (err.code === 10008) return null;
          return null;
        });

        if (!msg) {
          missingCount++;
          // Mark as missing/deleted so next panel refresh recreates cleanly
          await msgCol.updateOne({ _id: record._id }, { $set: { status: 'deleted', deletedAt: new Date() } });
        } else {
          verifiedCount++;
        }
      } catch {
        missingCount++;
      }
    }

    console.log(`[MongoDB] ✅ Reconciliation complete: ${verifiedCount} messages verified active, ${missingCount} missing/cleaned up.`);
  } catch (err) {
    console.warn('[MongoDB] ⚠️ Error during startup reconciliation:', err.message);
  }
}

/**
 * Saves or updates an active organiser-to-guild link in MongoDB.
 *
 * @param {string} guildId
 * @param {object} linkData
 * @returns {Promise<boolean>}
 */
export async function saveOrganiserLink(guildId, linkData) {
  if (!isMongoConnected() || !guildId || !linkData) return false;
  try {
    const orgLinkCol = mongoDb.collection('discord_organiser_links');
    const now = new Date().toISOString();
    await orgLinkCol.updateOne(
      { guildId },
      {
        $set: {
          guildId,
          organiserId: linkData.organiserId || linkData.organizerId,
          organiserName: linkData.organiserName || linkData.organizerName || 'Organiser',
          organiserHandle: linkData.organiserHandle || linkData.organizerHandle || '',
          guildName: linkData.guildName || 'Discord Server',
          status: 'linked',
          linkedBy: linkData.linkedBy || null,
          linkedAt: linkData.linkedAt || now,
          updatedAt: now,
          unlinkedAt: null,
          unlinkedBy: null,
        },
      },
      { upsert: true }
    );
    return true;
  } catch (err) {
    console.warn(`[MongoDB] ⚠️ Error saving organiser link for guild ${guildId}:`, err.message);
    return false;
  }
}

/**
 * Retrieves an active organiser link for a Discord guild from MongoDB.
 *
 * @param {string} guildId
 * @returns {Promise<object|null>}
 */
export async function getOrganiserLinkForGuild(guildId) {
  if (!isMongoConnected() || !guildId) return null;
  try {
    const orgLinkCol = mongoDb.collection('discord_organiser_links');
    const doc = await orgLinkCol.findOne({ guildId, status: 'linked' });
    if (!doc) return null;
    const { _id, ...cleanDoc } = doc;
    return cleanDoc;
  } catch (err) {
    console.warn(`[MongoDB] ⚠️ Error fetching organiser link for guild ${guildId}:`, err.message);
    return null;
  }
}

/**
 * Unlinks a Discord guild from an organiser in MongoDB.
 *
 * @param {string} guildId
 * @param {string} unlinkedBy Discord user ID
 * @returns {Promise<boolean>}
 */
export async function unlinkOrganiserGuild(guildId, unlinkedBy = null) {
  if (!isMongoConnected() || !guildId) return false;
  try {
    const orgLinkCol = mongoDb.collection('discord_organiser_links');
    const now = new Date().toISOString();
    await orgLinkCol.updateOne(
      { guildId },
      {
        $set: {
          status: 'unlinked',
          unlinkedAt: now,
          unlinkedBy,
          updatedAt: now,
        },
      }
    );
    return true;
  } catch (err) {
    console.warn(`[MongoDB] ⚠️ Error unlinking guild ${guildId}:`, err.message);
    return false;
  }
}

/**
 * Loads all active organiser links from MongoDB into a keyed map (by guildId).
 *
 * @returns {Promise<Record<string, object>>}
 */
export async function loadAllOrganiserLinksFromDb() {
  if (!isMongoConnected()) return {};
  try {
    const orgLinkCol = mongoDb.collection('discord_organiser_links');
    const records = await orgLinkCol.find({ status: 'linked' }).toArray();
    const result = {};
    for (const rec of records) {
      if (rec.guildId) {
        const { _id, ...cleanRec } = rec;
        result[rec.guildId] = cleanRec;
      }
    }
    return result;
  } catch (err) {
    console.warn('[MongoDB] ⚠️ Error loading all organiser links:', err.message);
    return {};
  }
}

/**
 * Checks whether a guild has an active organiser link in MongoDB.
 *
 * @param {string} guildId
 * @returns {Promise<boolean>}
 */
export async function isGuildLinkedToOrganiser(guildId) {
  if (!isMongoConnected() || !guildId) return false;
  try {
    const orgLinkCol = mongoDb.collection('discord_organiser_links');
    const count = await orgLinkCol.countDocuments({ guildId, status: 'linked' });
    return count > 0;
  } catch {
    return false;
  }
}

/**
 * Gracefully closes the MongoDB connection.
 */
export async function closeMongo() {
  if (mongoClient) {
    try {
      await mongoClient.close();
      isConnected = false;
      mongoDb = null;
      console.log('[MongoDB] 🔌 Connection closed gracefully.');
    } catch (err) {
      console.warn('[MongoDB] ⚠️ Error closing connection:', err.message);
    }
  }
}

