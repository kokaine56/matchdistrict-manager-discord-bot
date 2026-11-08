/**
 * Match District Discord Bot – Dynamic Welcome Message Service
 * Resolves active invite events, open tournament registrations, and essential guild channels
 * to generate personalized, context-aware welcome DMs for new server members.
 */

import {
  CAMPAIGN_STATUS,
  COLLECTIONS,
  getCurrentGuildCampaign,
  getAllNonEndedCampaigns,
} from './bot/discord/features/inviteCampaign/models/inviteCampaignModels.js';
import {
  getAllConfigurableTournaments,
  getConfigurableRegistrationsForTournament,
} from './configurableTournamentData.js';
import { evaluateEffectiveRegistrationOpenState } from './configurableRegistrationService.js';
import {
  getAllTournamentsFromDb,
  getMongoDb,
  isMongoConnected,
} from './mongoService.js';

/**
 * Detects active invite campaigns in the guild.
 * Only returns campaigns where status === 'Active' and the invite channel exists in the guild.
 *
 * @param {object} guild
 * @returns {Promise<Array<{ id: string, name: string, channelId: string }>>}
 */
export async function resolveActiveInviteEvents(guild) {
  if (!guild?.id) return [];
  const guildId = String(guild.id);
  const activeEvents = [];

  try {
    const candidateCampaigns = [];

    if (isMongoConnected()) {
      try {
        const db = getMongoDb();
        const docs = await db
          .collection(COLLECTIONS.INVITE_CAMPAIGN)
          .find({
            guildId,
            status: CAMPAIGN_STATUS.ACTIVE,
          })
          .toArray();
        if (Array.isArray(docs)) {
          candidateCampaigns.push(...docs);
        }
      } catch (err) {
        console.warn(`[WelcomeService] ⚠️ Mongo error fetching active campaigns:`, err.message);
      }
    } else {
      const current = await getCurrentGuildCampaign(guildId);
      if (current && current.status === CAMPAIGN_STATUS.ACTIVE) {
        candidateCampaigns.push(current);
      }
      const allNonEnded = await getAllNonEndedCampaigns();
      for (const c of allNonEnded) {
        if (
          c.guildId === guildId &&
          c.status === CAMPAIGN_STATUS.ACTIVE &&
          !candidateCampaigns.some((x) => x.campaignId === c.campaignId)
        ) {
          candidateCampaigns.push(c);
        }
      }
    }

    const seenChannels = new Set();
    for (const campaign of candidateCampaigns) {
      if (!campaign || campaign.status !== CAMPAIGN_STATUS.ACTIVE) continue;
      const targetChannelId = campaign.inviteChannelId || campaign.announcementChannelId;
      if (!targetChannelId) continue;

      const strChannelId = String(targetChannelId);
      if (seenChannels.has(strChannelId)) continue;

      let ch = guild.channels?.cache?.get(strChannelId);
      if (!ch && typeof guild.channels?.fetch === 'function') {
        ch = await guild.channels.fetch(strChannelId).catch(() => null);
      }
      if (!ch) {
        // Handle missing or deleted channel gracefully by omitting
        continue;
      }

      seenChannels.add(strChannelId);
      activeEvents.push({
        id: campaign.campaignId || strChannelId,
        name: campaign.name || 'Invite Event',
        channelId: strChannelId,
      });
    }
  } catch (err) {
    console.warn(`[WelcomeService] ⚠️ Error resolving active invite campaigns for guild ${guildId}:`, err.message);
  }

  return activeEvents;
}

/**
 * Detects tournaments with open registration in the guild.
 * Excludes cancelled, completed, closed, unpublished, and deleting tournaments.
 * Checks both configurable tournaments and legacy tournaments.
 * Only returns registrations where the channel exists in the guild.
 *
 * @param {object} guild
 * @returns {Promise<Array<{ id: string, name: string, channelId: string }>>}
 */
export async function resolveOpenTournaments(guild) {
  if (!guild?.id) return [];
  const guildId = String(guild.id);
  const openTournaments = [];
  const seenChannels = new Set();

  try {
    // 1. Configurable Tournaments (primary tournament system)
    const configTournaments = await getAllConfigurableTournaments(guildId).catch(() => []);
    for (const tour of configTournaments) {
      if (!tour) continue;
      if (tour.isPublished === false) continue;
      if (tour.isDeleted === true || tour.status === 'DELETED') continue;

      const statusUpper = String(tour.status || '').toUpperCase();
      if (
        statusUpper === 'CANCELLED' ||
        statusUpper === 'COMPLETED' ||
        statusUpper === 'CLOSED'
      ) {
        continue;
      }
      if (
        tour.setupStatus === 'deleting' ||
        tour.deletionStatus === 'deletion_pending' ||
        tour.deletionStatus === 'deleting' ||
        tour.deletionStatus === 'deleted'
      ) {
        continue;
      }

      const registrations = await getConfigurableRegistrationsForTournament(tour.tournamentId).catch(() => []);
      for (const reg of registrations) {
        if (!reg || reg.isDeleted === true || reg.status === 'DELETED') continue;

        const effective = evaluateEffectiveRegistrationOpenState(reg);
        if (effective.status !== 'OPEN' && reg.status !== 'OPEN') continue;
        if (effective.status === 'CLOSED' || effective.status === 'FULL') continue;

        const regChannelId = reg.registrationChannelId;
        if (!regChannelId) continue;
        const strRegChId = String(regChannelId);
        if (seenChannels.has(strRegChId)) continue;

        let ch = guild.channels?.cache?.get(strRegChId);
        if (!ch && typeof guild.channels?.fetch === 'function') {
          ch = await guild.channels.fetch(strRegChId).catch(() => null);
        }
        if (!ch) continue; // Missing or deleted channel

        seenChannels.add(strRegChId);
        const tourTitle = (tour.name || tour.title || 'Tournament').trim();
        const regName = (reg.displayName || reg.name || '').trim();
        const displayName =
          regName && regName !== tourTitle && registrations.length > 1
            ? `${tourTitle} (${regName})`
            : tourTitle;

        openTournaments.push({
          id: reg.registrationId || tour.tournamentId,
          name: displayName,
          channelId: strRegChId,
        });
      }
    }

    // 2. Legacy Tournaments (from discord_tournaments)
    const legacyTournaments = await getAllTournamentsFromDb(guildId).catch(() => []);
    for (const tour of legacyTournaments) {
      if (!tour) continue;
      if (
        tour.setupStatus === 'deleted' ||
        tour.deletionStatus === 'deleting' ||
        tour.deletionStatus === 'deletion_pending'
      ) {
        continue;
      }
      const st = String(tour.status || '').toUpperCase();
      if (
        st === 'COMPLETED' ||
        st === 'CANCELLED' ||
        st === 'CLOSED' ||
        st === 'DELETED'
      ) {
        continue;
      }
      if (st !== 'OPEN' && st !== 'REGISTRATION_OPEN') continue;

      const regChannelId = tour.channels?.tournamentRegisterId;
      if (!regChannelId) continue;
      const strRegChId = String(regChannelId);
      if (seenChannels.has(strRegChId)) continue;

      let ch = guild.channels?.cache?.get(strRegChId);
      if (!ch && typeof guild.channels?.fetch === 'function') {
        ch = await guild.channels.fetch(strRegChId).catch(() => null);
      }
      if (!ch) continue;

      seenChannels.add(strRegChId);
      openTournaments.push({
        id: tour.tournamentId,
        name: (tour.title || tour.name || 'Tournament').trim(),
        channelId: strRegChId,
      });
    }
  } catch (err) {
    console.warn(`[WelcomeService] ⚠️ Error resolving open tournaments for guild ${guildId}:`, err.message);
  }

  return openTournaments;
}

/**
 * Resolves key channel IDs for rules, team recruitment, and general chat.
 * @param {object} guild
 * @returns {{ rules: string|null, findTeam: string|null, generalChat: string|null }}
 */
export function resolveImportantChannels(guild) {
  const result = {
    rules: null,
    findTeam: null,
    generalChat: null,
  };
  if (!guild || !guild.channels?.cache) return result;

  const channels = [...guild.channels.cache.values()].filter(
    (c) => c && (c.type === 0 || c.type === 'GUILD_TEXT' || typeof c.type === 'number')
  );

  // 1. Rules
  if (guild.rulesChannelId && guild.channels.cache.has(guild.rulesChannelId)) {
    result.rules = String(guild.rulesChannelId);
  } else {
    const rulesChannel = channels.find((c) => {
      const name = (c.name || '').toLowerCase();
      return (
        name === 'rules' ||
        name === 'server-rules' ||
        name === 'welcome-rules' ||
        name.includes('rules')
      );
    });
    if (rulesChannel) result.rules = String(rulesChannel.id);
  }

  // 2. Find a Team
  const findTeamChannel = channels.find((c) => {
    const name = (c.name || '').toLowerCase();
    return (
      name === 'find-a-team' ||
      name === 'find-team' ||
      name.includes('find-team') ||
      name.includes('find-a-team') ||
      name.includes('team-recruitment') ||
      name.includes('lfg')
    );
  });
  if (findTeamChannel) result.findTeam = String(findTeamChannel.id);

  // 3. General Chat
  const generalChannel = channels.find((c) => {
    const name = (c.name || '').toLowerCase();
    return (
      name === 'general' ||
      name === 'general-chat' ||
      name === 'main-chat' ||
      name === 'chat' ||
      name.includes('general')
    );
  });
  if (generalChannel) result.generalChat = String(generalChannel.id);

  return result;
}

/**
 * Formats the dynamic, mobile-friendly welcome message for a new member.
 * Adapts automatically based on active invite events and open tournaments.
 *
 * @param {object} params
 * @param {object} [params.member]
 * @param {string} [params.name]
 * @param {Array<{ id: string, name: string, channelId: string }>} [params.activeEvents]
 * @param {Array<{ id: string, name: string, channelId: string }>} [params.openTournaments]
 * @param {{ rules?: string|null, findTeam?: string|null, generalChat?: string|null }} [params.importantChannels]
 * @returns {string}
 */
export function buildDynamicWelcomeMessage({
  member = null,
  name: explicitName = null,
  activeEvents = [],
  openTournaments = [],
  importantChannels = {},
} = {}) {
  const name =
    explicitName ||
    member?.displayName ||
    member?.user?.globalName ||
    member?.user?.username ||
    'Player';

  const hasEvents = Array.isArray(activeEvents) && activeEvents.length > 0;
  const hasTournaments = Array.isArray(openTournaments) && openTournaments.length > 0;

  const sections = [];

  // Header
  sections.push(
    `WELCOME TO MATCH DISTRICT!\n\n` +
    `Welcome ${name}!\n` +
    `We're glad to have you in our gaming community.`
  );

  // Activities lead-in (only if at least one activity exists)
  if (hasEvents || hasTournaments) {
    sections.push(`Explore our latest activities:`);
  }

  // 1. Active Invite Event Section (omitted entirely if no active event)
  if (hasEvents) {
    let eventBody =
      `🎁 **Active Invite Event**\n` +
      `An invite event is currently live! Invite your friends and earn rewards.\n`;
    if (activeEvents.length === 1) {
      eventBody += `Join the event: <#${activeEvents[0].channelId}>`;
      if (activeEvents[0].name) {
        eventBody += `\n• ${activeEvents[0].name} – <#${activeEvents[0].channelId}>`;
      }
    } else {
      eventBody +=
        `Join the event:\n` +
        activeEvents.map((e) => `• ${e.name} – <#${e.channelId}>`).join('\n');
    }
    sections.push(eventBody);
  }

  // 2. Tournament Registrations Section (omitted entirely if none open)
  if (hasTournaments) {
    let tourBody =
      `🏆 **Tournament Registrations**\n` +
      `Tournament registrations are currently open!\n` +
      `Register your squad and compete for exciting prizes.\n`;
    if (openTournaments.length === 1) {
      tourBody +=
        `Register here: <#${openTournaments[0].channelId}>\n` +
        `• ${openTournaments[0].name} – <#${openTournaments[0].channelId}>`;
    } else {
      tourBody +=
        `Register here:\n` +
        openTournaments.map((t) => `• ${t.name} – <#${t.channelId}>`).join('\n');
    }
    sections.push(tourBody);
  }

  // If neither activity is active, include platform summary
  if (!hasEvents && !hasTournaments) {
    sections.push(
      `Match District is an esports platform where you can join tournaments, register your squad, follow live leaderboards and results, and get verified prize payouts.`
    );
  }

  // Important Channels Section
  const rulesLink = importantChannels?.rules ? `<#${importantChannels.rules}>` : '#rules';
  const findTeamLink = importantChannels?.findTeam ? `<#${importantChannels.findTeam}>` : '#find-a-team';
  const generalLink = importantChannels?.generalChat ? `<#${importantChannels.generalChat}>` : '#general-chat';

  sections.push(
    `📌 **Important Channels**\n\n` +
    `Rules: ${rulesLink}\n` +
    `Find a Team: ${findTeamLink}\n` +
    `General Chat: ${generalLink}`
  );

  // Footer
  sections.push(`Managed by Match District`);

  return sections.join('\n\n');
}

/**
 * Resolves server context asynchronously and formats the dynamic welcome message.
 *
 * @param {object} member
 * @returns {Promise<string>}
 */
export async function resolveDynamicWelcomeMessage(member) {
  if (!member) {
    return buildDynamicWelcomeMessage();
  }
  const guild = member.guild;
  if (!guild) {
    return buildDynamicWelcomeMessage({ member });
  }

  const [activeEvents, openTournaments, importantChannels] = await Promise.all([
    resolveActiveInviteEvents(guild).catch(() => []),
    resolveOpenTournaments(guild).catch(() => []),
    Promise.resolve(resolveImportantChannels(guild)),
  ]);

  return buildDynamicWelcomeMessage({
    member,
    activeEvents,
    openTournaments,
    importantChannels,
  });
}

