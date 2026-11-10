import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from 'discord.js';
import { isAdmin } from './index.js';

export const HELP_ACCENT_COLOR = 0xF97316; // Match District Orange accent

export const COMMAND_CATEGORIES = {
  GENERAL: 'General Commands',
  TOURNAMENT: 'Tournament Commands',
  TDM: '1V1 TDM Commands',
  ROOM_MAKER: 'Room Maker Commands',
  MODERATION: 'Moderation Commands',
  ADMINISTRATION: 'Administration Commands',
  UTILITY: 'Utility Commands',
  CONFIGURATION: 'Configuration Commands',
};

export const CATEGORY_METADATA = {
  [COMMAND_CATEGORIES.GENERAL]: {
    emoji: 'ℹ️',
    description: 'Essential server information and community bot commands',
  },
  [COMMAND_CATEGORIES.TOURNAMENT]: {
    emoji: '🏆',
    description: 'Esports tournament control panel, rounds, and squad management',
  },
  [COMMAND_CATEGORIES.TDM]: {
    emoji: '⚔️',
    description: 'BGMI 1v1 TDM matchmaking, private matches, and dispute resolution',
  },
  [COMMAND_CATEGORIES.ROOM_MAKER]: {
    emoji: '🎮',
    description: 'Room Maker volunteer profiles, availability status, and match claims',
  },
  [COMMAND_CATEGORIES.MODERATION]: {
    emoji: '🛡️',
    description: 'Member moderation, audit logs, timeouts, bans, and message cleanup',
  },
  [COMMAND_CATEGORIES.ADMINISTRATION]: {
    emoji: '⚙️',
    description: 'Server management, thread controls, role prefixes, and invite events',
  },
  [COMMAND_CATEGORIES.UTILITY]: {
    emoji: '🛠️',
    description: 'Personal invite links, referral histories, and leaderboard metrics',
  },
  [COMMAND_CATEGORIES.CONFIGURATION]: {
    emoji: '🔧',
    description: 'Server setup, management channels, welcome DMs, and ticket panels',
  },
};

/**
 * Complete, single source-of-truth command directory.
 * Maps all registered bot commands, aliases, syntax, and permission requirements.
 */
export const COMMAND_DIRECTORY = [
  // --- General Commands ---
  {
    name: 'help',
    category: COMMAND_CATEGORIES.GENERAL,
    syntax: (p) => `${p}help [category]`,
    description: 'Show the complete interactive command directory.',
    aliases: (p) => [`${p}commands`],
    adminOnly: false,
    permission: null,
  },
  {
    name: 'ping',
    category: COMMAND_CATEGORIES.GENERAL,
    syntax: (p) => `${p}ping`,
    description: 'Check bot response latency and WebSocket heartbeat.',
    aliases: () => [],
    adminOnly: false,
    permission: null,
  },
  {
    name: 'status',
    category: COMMAND_CATEGORIES.GENERAL,
    syntax: (p) => `${p}status`,
    description: 'Check server audit setup, welcome onboarding, and bot status.',
    aliases: () => [],
    adminOnly: false,
    permission: null,
  },
  {
    name: 'website',
    category: COMMAND_CATEGORIES.GENERAL,
    syntax: (p) => `${p}website`,
    description: 'Get the official MatchDistrict esports platform link.',
    aliases: (p) => [`${p}site`],
    adminOnly: false,
    permission: null,
  },

  // --- Room Maker Commands ---
  {
    name: 'roommaker profile',
    category: COMMAND_CATEGORIES.ROOM_MAKER,
    syntax: (p) => `${p}roommaker profile`,
    description: 'View your Room Maker profile, match counts, and availability.',
    aliases: (p) => [`${p}volunteer profile`, `${p}roommaker stats`],
    adminOnly: false,
    permission: null,
  },
  {
    name: 'roommaker status',
    category: COMMAND_CATEGORIES.ROOM_MAKER,
    syntax: (p) => `${p}roommaker status`,
    description: 'Toggle your Room Maker availability status (AVAILABLE / UNAVAILABLE).',
    aliases: (p) => [`${p}volunteer status`],
    adminOnly: false,
    permission: null,
  },
  {
    name: 'mymatches',
    category: COMMAND_CATEGORIES.ROOM_MAKER,
    syntax: (p) => `${p}mymatches`,
    description: 'View active 1v1 matches currently assigned to you.',
    aliases: () => [],
    adminOnly: false,
    permission: null,
  },
  {
    name: 'leave',
    category: COMMAND_CATEGORIES.ROOM_MAKER,
    syntax: (p) => `${p}leave <matchId>`,
    description: 'Leave an assigned match before room credentials have been submitted.',
    aliases: (p) => [`${p}release <matchId>`],
    adminOnly: false,
    permission: null,
  },

  // --- Utility Commands ---
  {
    name: 'invite links',
    category: COMMAND_CATEGORIES.UTILITY,
    syntax: (p) => `${p}invite links`,
    description: 'View your personalized invite link and referral metrics.',
    aliases: (p) => [`${p}invite link`],
    adminOnly: false,
    permission: null,
  },
  {
    name: 'invite leaderboard',
    category: COMMAND_CATEGORIES.UTILITY,
    syntax: (p) => `${p}invite leaderboard`,
    description: 'View the live Invite & Earn campaign leaderboard rankings.',
    aliases: (p) => [`${p}invite lb`, `${p}invite eligible`],
    adminOnly: false,
    permission: null,
  },
  {
    name: 'invite history',
    category: COMMAND_CATEGORIES.UTILITY,
    syntax: (p) => `${p}invite history`,
    description: 'View your recent invite referrals and verification statuses.',
    aliases: (p) => [`${p}invite referrals`],
    adminOnly: false,
    permission: null,
  },

  // --- Tournament Commands (Admin/Organiser) ---
  {
    name: 'organiser',
    category: COMMAND_CATEGORIES.TOURNAMENT,
    syntax: (p) => `${p}organiser`,
    description: 'Connect this Discord server to your MatchDistrict organiser account.',
    aliases: (p) => [`${p}organizer`],
    adminOnly: true,
    permission: 'Admin / Organiser',
  },
  {
    name: 'organiser unlink',
    category: COMMAND_CATEGORIES.TOURNAMENT,
    syntax: (p) => `${p}organiser unlink`,
    description: 'Disconnect this Discord server from the linked organiser account.',
    aliases: (p) => [`${p}organizer unlink`],
    adminOnly: true,
    permission: 'Admin / Organiser',
  },
  {
    name: 'list tournament',
    category: COMMAND_CATEGORIES.TOURNAMENT,
    syntax: (p) => `${p}list tournament [all]`,
    description: 'List hosted tournaments & select one to open control panel in #bot-commands.',
    aliases: (p) => [`${p}list tournaments`],
    adminOnly: true,
    permission: 'Admin / Organiser',
  },
  {
    name: 'select tournament',
    category: COMMAND_CATEGORIES.TOURNAMENT,
    syntax: (p) => `${p}select tournament <id>`,
    description: 'Open or refresh tournament control panel in #bot-commands.',
    aliases: (p) => [`${p}manage tournament <id>`, `${p}select <id>`],
    adminOnly: true,
    permission: 'Admin / Organiser',
  },
  {
    name: 'dash',
    category: COMMAND_CATEGORIES.TOURNAMENT,
    syntax: (p) => `${p}dash`,
    description: 'Restore and resynchronize the tournament control panel in #bot-commands.',
    aliases: (p) => [`${p}dashboard`],
    adminOnly: true,
    permission: 'Admin / Organiser',
  },
  {
    name: 'fetch teams',
    category: COMMAND_CATEGORIES.TOURNAMENT,
    syntax: (p) => `${p}fetch teams <id>`,
    description: 'Provision tournament channels & sync live registered squads.',
    aliases: (p) => [`${p}fetch team <id>`],
    adminOnly: true,
    permission: 'Admin / Organiser',
  },
  {
    name: 'cred',
    category: COMMAND_CATEGORIES.TOURNAMENT,
    syntax: (p) => `${p}cred <room_id> <password>`,
    description: 'Publish match credentials inside a private group channel.',
    aliases: (p) => [`${p}credentials`, `${p}room`],
    adminOnly: true,
    permission: 'Admin / Organiser',
  },
  {
    name: 'submit',
    category: COMMAND_CATEGORIES.TOURNAMENT,
    syntax: (p) => `${p}submit`,
    description: 'Open match score and screenshot submission prompt in group channel.',
    aliases: () => [],
    adminOnly: true,
    permission: 'Admin / Organiser',
  },
  {
    name: 'sync roles',
    category: COMMAND_CATEGORIES.TOURNAMENT,
    syntax: (p) => `${p}sync roles [id]`,
    description: 'Synchronize participant access and tournament roles in the server.',
    aliases: (p) => [`${p}reconcile`],
    adminOnly: true,
    permission: 'Admin / Organiser',
  },
  {
    name: 'delete tournament',
    category: COMMAND_CATEGORIES.TOURNAMENT,
    syntax: (p) => `${p}delete tournament <id>`,
    description: 'Permanently delete tournament, channels, roles, and database records.',
    aliases: (p) => [`${p}delete tournaments <id>`],
    adminOnly: true,
    permission: 'Admin Only',
  },

  // --- 1V1 TDM Commands ---
  {
    name: 'arena setup',
    category: COMMAND_CATEGORIES.TDM,
    syntax: (p) => `${p}arena setup`,
    description: 'Idempotently set up 1V1 TDM categories, channels, and persistent panels.',
    aliases: (p) => [`${p}tdm setup`],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'arena delete',
    category: COMMAND_CATEGORIES.TDM,
    syntax: (p) => `${p}arena delete`,
    description: 'Completely delete all 1V1 TDM channels, categories, and database records.',
    aliases: (p) => [`${p}tdm delete`],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'arena active',
    category: COMMAND_CATEGORIES.TDM,
    syntax: (p) => `${p}arena active`,
    description: 'View open challenges and active in-progress 1v1 matches.',
    aliases: (p) => [`${p}tdm active`],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'arena matches',
    category: COMMAND_CATEGORIES.TDM,
    syntax: (p) => `${p}arena matches [status]`,
    description: 'List 1v1 TDM matches with optional status filter.',
    aliases: (p) => [`${p}tdm matches`],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'arena cancel',
    category: COMMAND_CATEGORIES.TDM,
    syntax: (p) => `${p}arena cancel <id> <reason>`,
    description: 'Cancel an active match or open challenge and free player locks.',
    aliases: (p) => [`${p}tdm cancel`],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'arena reassign',
    category: COMMAND_CATEGORIES.TDM,
    syntax: (p) => `${p}arena reassign <id> @roommaker`,
    description: 'Reassign an active match to another Room Maker.',
    aliases: (p) => [`${p}tdm reassign`],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'arena dispute',
    category: COMMAND_CATEGORIES.TDM,
    syntax: (p) => `${p}arena dispute`,
    description: 'List open match disputes and player screenshot evidence.',
    aliases: (p) => [`${p}tdm dispute`],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'arena result',
    category: COMMAND_CATEGORIES.TDM,
    syntax: (p) => `${p}arena result <id> <A|B> <reason>`,
    description: 'Finalize and resolve a disputed match (records winner BGMI IGN).',
    aliases: (p) => [`${p}tdm result`],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'arena roommaker',
    category: COMMAND_CATEGORIES.TDM,
    syntax: (p) => `${p}arena roommaker add|remove @user`,
    description: 'Register or deactivate a Room Maker profile.',
    aliases: (p) => [`${p}tdm roommaker`],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'arena roommaker limit',
    category: COMMAND_CATEGORIES.TDM,
    syntax: (p) => `${p}arena roommaker limit <n>`,
    description: 'Set active concurrent match limit per Room Maker (default 1).',
    aliases: (p) => [`${p}tdm roommaker limit`],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'arena suspend',
    category: COMMAND_CATEGORIES.TDM,
    syntax: (p) => `${p}arena suspend|unsuspend @player`,
    description: 'Suspend or restore a player from 1V1 TDM matchmaking.',
    aliases: (p) => [`${p}tdm suspend`, `${p}arena unsuspend`, `${p}tdm unsuspend`],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'arena resetuid',
    category: COMMAND_CATEGORIES.TDM,
    syntax: (p) => `${p}arena resetuid @player`,
    description: 'Clear registered BGMI details for player re-registration.',
    aliases: (p) => [`${p}tdm resetuid`],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'arena stats',
    category: COMMAND_CATEGORIES.TDM,
    syntax: (p) => `${p}arena stats`,
    description: 'View overall 1V1 TDM match, volunteer, and dispute statistics.',
    aliases: (p) => [`${p}tdm stats`],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'arena logs',
    category: COMMAND_CATEGORIES.TDM,
    syntax: (p) => `${p}arena logs [id]`,
    description: 'View recent 1V1 TDM audit activity logs.',
    aliases: (p) => [`${p}tdm logs`],
    adminOnly: true,
    permission: 'Admin Only',
  },

  // --- Moderation Commands ---
  {
    name: 'ban',
    category: COMMAND_CATEGORIES.MODERATION,
    syntax: (p) => `${p}ban @user [reason]`,
    description: 'Ban a member with role hierarchy checks and audit logging.',
    aliases: () => [],
    adminOnly: true,
    permission: 'Mod / Ban Members',
  },
  {
    name: 'mute',
    category: COMMAND_CATEGORIES.MODERATION,
    syntax: (p) => `${p}mute <@user|id> <minutes>`,
    description: 'Apply native Discord timeout to a member for specified minutes.',
    aliases: () => [],
    adminOnly: true,
    permission: 'Mod / Moderate Members',
  },
  {
    name: 'unmute',
    category: COMMAND_CATEGORIES.MODERATION,
    syntax: (p) => `${p}unmute <@user|id>`,
    description: 'Remove timeout from a timed-out member.',
    aliases: () => [],
    adminOnly: true,
    permission: 'Mod / Moderate Members',
  },
  {
    name: 'unban',
    category: COMMAND_CATEGORIES.MODERATION,
    syntax: (p) => `${p}unban <@user|id>`,
    description: 'Unban a previously banned user from the server.',
    aliases: () => [],
    adminOnly: true,
    permission: 'Mod / Ban Members',
  },
  {
    name: 'clear',
    category: COMMAND_CATEGORIES.MODERATION,
    syntax: (p) => `${p}clear <1-100>`,
    description: 'Bulk delete recent channel messages (excludes audit channels).',
    aliases: () => [],
    adminOnly: true,
    permission: 'Mod / Manage Messages',
  },

  // --- Administration Commands ---
  {
    name: 'remove threads',
    category: COMMAND_CATEGORIES.ADMINISTRATION,
    syntax: (p) => `${p}remove threads`,
    description: 'Disable thread creation permissions in this channel.',
    aliases: (p) => [`${p}removethreads`],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'role pre',
    category: COMMAND_CATEGORIES.ADMINISTRATION,
    syntax: (p) => `${p}role pre <prefix>`,
    description: 'Configure an automatic role-based nickname prefix with interactive role selector.',
    aliases: () => [],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'role pre list',
    category: COMMAND_CATEGORIES.ADMINISTRATION,
    syntax: (p) => `${p}role pre list`,
    description: 'Show all configured role nickname prefixes in this server.',
    aliases: () => [],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'role pre remove',
    category: COMMAND_CATEGORIES.ADMINISTRATION,
    syntax: (p) => `${p}role pre remove [role]`,
    description: 'Remove a role prefix configuration and revert managed member nicknames.',
    aliases: () => [],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'role pre refresh',
    category: COMMAND_CATEGORIES.ADMINISTRATION,
    syntax: (p) => `${p}role pre refresh`,
    description: 'Reapply configured prefixes to all eligible server members.',
    aliases: () => [],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'invite min',
    category: COMMAND_CATEGORIES.ADMINISTRATION,
    syntax: (p) => `${p}invite min <number>`,
    description: 'Set minimum successful invite threshold for the active campaign.',
    aliases: () => [],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'invite poster',
    category: COMMAND_CATEGORIES.ADMINISTRATION,
    syntax: (p) => `${p}invite poster`,
    description: 'Set or replace the campaign announcement poster image from an attachment.',
    aliases: () => [],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'invite poster remove',
    category: COMMAND_CATEGORIES.ADMINISTRATION,
    syntax: (p) => `${p}invite poster remove`,
    description: 'Remove campaign poster and restore the default embed on the panel.',
    aliases: () => [],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'invite set prize',
    category: COMMAND_CATEGORIES.ADMINISTRATION,
    syntax: (p) => `${p}invite set prize <rank> <amount>`,
    description: 'Configure leaderboard rank prize rewards.',
    aliases: () => [],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'invite set',
    category: COMMAND_CATEGORIES.ADMINISTRATION,
    syntax: (p) => `${p}invite set <start|end|channel> <val>`,
    description: 'Configure campaign schedule dates and target Discord channels.',
    aliases: () => [],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'invite start',
    category: COMMAND_CATEGORIES.ADMINISTRATION,
    syntax: (p) => `${p}invite start|pause|resume|end`,
    description: 'Manage campaign lifecycle transitions.',
    aliases: () => [],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'invite rewards',
    category: COMMAND_CATEGORIES.ADMINISTRATION,
    syntax: (p) => `${p}invite rewards`,
    description: 'View configured invite campaign prize tiers and reward distribution.',
    aliases: (p) => [`${p}invite config`],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'invite status',
    category: COMMAND_CATEGORIES.ADMINISTRATION,
    syntax: (p) => `${p}invite status`,
    description: 'View campaign metrics, active participants, and referral stats.',
    aliases: (p) => [`${p}invite stats`],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'invite disqualify',
    category: COMMAND_CATEGORIES.ADMINISTRATION,
    syntax: (p) => `${p}invite disqualify @user <reason>`,
    description: 'Disqualify a fraudulent participant and void their referrals.',
    aliases: (p) => [`${p}invite dq`],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'invite review',
    category: COMMAND_CATEGORIES.ADMINISTRATION,
    syntax: (p) => `${p}invite review`,
    description: 'Review flagged unattributed joins and referral audit integrity.',
    aliases: () => [],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'deletemsg',
    category: COMMAND_CATEGORIES.ADMINISTRATION,
    syntax: (p) => `${p}deletemsg <message_id>`,
    description: 'Delete a managed bot message record from DB and Discord.',
    aliases: (p) => [`${p}deletemessage`],
    adminOnly: true,
    permission: 'Admin Only',
  },

  // --- Configuration Commands ---
  {
    name: 'setup',
    category: COMMAND_CATEGORIES.CONFIGURATION,
    syntax: (p) => `${p}setup`,
    description: 'Create and configure server audit channels and member count.',
    aliases: () => [],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'setup remove',
    category: COMMAND_CATEGORIES.CONFIGURATION,
    syntax: (p) => `${p}setup remove`,
    description: 'Safely initiate 30-second confirmed removal of management channels.',
    aliases: () => [],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'setup confirm',
    category: COMMAND_CATEGORIES.CONFIGURATION,
    syntax: (p) => `${p}setup confirm`,
    description: 'Confirm pending removal of bot-managed audit channels.',
    aliases: () => [],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'setup cancel',
    category: COMMAND_CATEGORIES.CONFIGURATION,
    syntax: (p) => `${p}setup cancel`,
    description: 'Cancel pending channel removal request.',
    aliases: () => [],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'setup tournament',
    category: COMMAND_CATEGORIES.CONFIGURATION,
    syntax: (p) => `${p}setup tournament`,
    description: 'Launch interactive setup wizard to configure a custom tournament.',
    aliases: () => [],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'member count',
    category: COMMAND_CATEGORIES.CONFIGURATION,
    syntax: (p) => `${p}member count <text>`,
    description: 'Set custom text prefix for the member-count voice channel.',
    aliases: () => [],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'dm welcome on',
    category: COMMAND_CATEGORIES.CONFIGURATION,
    syntax: (p) => `${p}dm welcome on`,
    description: 'Enable welcome DMs for new members.',
    aliases: () => [],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'dm welcome off',
    category: COMMAND_CATEGORIES.CONFIGURATION,
    syntax: (p) => `${p}dm welcome off`,
    description: 'Disable welcome DMs for new members.',
    aliases: () => [],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'ticket setup',
    category: COMMAND_CATEGORIES.CONFIGURATION,
    syntax: (p) => `${p}ticket setup`,
    description: 'Deploy the interactive support ticket panel in this channel.',
    aliases: () => [],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'ticket delete',
    category: COMMAND_CATEGORIES.CONFIGURATION,
    syntax: (p) => `${p}ticket delete`,
    description: 'Delete the support ticket panel and clean up ticket records.',
    aliases: () => [],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'annc',
    category: COMMAND_CATEGORIES.CONFIGURATION,
    syntax: (p) => `${p}annc [channel|setup]`,
    description: 'Launch announcement manager to send channel announcements or configure DM delivery.',
    aliases: (p) => [`${p}announcement`],
    adminOnly: true,
    permission: 'Admin Only',
  },
  {
    name: 'annc setup',
    category: COMMAND_CATEGORIES.CONFIGURATION,
    syntax: (p) => `${p}annc setup`,
    description: 'Configure private announcement DM dispatch channel.',
    aliases: () => [],
    adminOnly: true,
    permission: 'Admin Only',
  },
];

/**
 * Returns available categories containing commands for the user.
 * @param {object} param0
 * @param {boolean} param0.isAdmin
 * @returns {Array<string>}
 */
export function getHelpCategories({ isAdmin = false } = {}) {
  const visibleCategories = new Set();
  for (const cmd of COMMAND_DIRECTORY) {
    if (!cmd.adminOnly || isAdmin) {
      visibleCategories.add(cmd.category);
    }
  }

  // Preserve defined order in COMMAND_CATEGORIES
  return Object.values(COMMAND_CATEGORIES).filter((cat) => visibleCategories.has(cat));
}

/**
 * Retrieves commands for a specific category.
 */
export function getCommandsByCategory(category, { isAdmin = false, prefix = '.' } = {}) {
  return COMMAND_DIRECTORY.filter(
    (cmd) => cmd.category === category && (!cmd.adminOnly || isAdmin)
  );
}

/**
 * Defines page groupings for paginated overview.
 * Ensures each page never exceeds Discord embed limits.
 */
export function getHelpPageGroups(isAdmin = false) {
  if (!isAdmin) {
    // Ordinary member commands: General, Room Maker, Utility fit nicely on 1 page
    return [
      [
        COMMAND_CATEGORIES.GENERAL,
        COMMAND_CATEGORIES.ROOM_MAKER,
        COMMAND_CATEGORIES.UTILITY,
      ],
    ];
  }

  // Admin pages:
  // Page 0: General, Room Maker, Utility (Member commands)
  // Page 1: Tournament, 1V1 TDM (Gaming operations)
  // Page 2: Moderation, Administration, Configuration (Management & Config)
  return [
    [
      COMMAND_CATEGORIES.GENERAL,
      COMMAND_CATEGORIES.ROOM_MAKER,
      COMMAND_CATEGORIES.UTILITY,
    ],
    [
      COMMAND_CATEGORIES.TOURNAMENT,
      COMMAND_CATEGORIES.TDM,
    ],
    [
      COMMAND_CATEGORIES.MODERATION,
      COMMAND_CATEGORIES.ADMINISTRATION,
      COMMAND_CATEGORIES.CONFIGURATION,
    ],
  ];
}

/**
 * Helper to add fields safely under Discord's 1024 character value limit.
 */
function addSafeFields(embed, categoryTitle, lines) {
  if (!lines || lines.length === 0) return;

  const chunks = [];
  let current = '';

  for (const line of lines) {
    if (current && (current.length + line.length + 1) > 950) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);

  chunks.forEach((chunk, idx) => {
    embed.addFields({
      name: idx === 0 ? categoryTitle : `${categoryTitle} (Cont.)`,
      value: chunk,
      inline: false,
    });
  });
}

/**
 * Builds the Discord Embed for a given page or single category.
 */
export function buildHelpEmbed({
  prefix = '.',
  isAdmin = false,
  pageIndex = 0,
  selectedCategory = null,
  guild = null,
} = {}) {
  const embed = new EmbedBuilder()
    .setColor(HELP_ACCENT_COLOR)
    .setTimestamp();

  if (selectedCategory) {
    const meta = CATEGORY_METADATA[selectedCategory] || { emoji: '📁', description: '' };
    embed.setTitle(`${meta.emoji} ${selectedCategory}`);
    if (meta.description) {
      embed.setDescription(`*${meta.description}*\n────────────────────────────────────────`);
    }

    const commands = getCommandsByCategory(selectedCategory, { isAdmin, prefix });
    if (commands.length === 0) {
      embed.addFields({ name: 'Commands', value: '*No commands available in this category for your permission level.*', inline: false });
    } else {
      const commandLines = commands.map((cmd) => {
        const syntaxStr = cmd.syntax(prefix);
        const permBadge = cmd.permission ? ` \`[${cmd.permission}]\`` : '';
        const aliasList = cmd.aliases(prefix);
        const aliasStr = aliasList.length > 0 ? ` *(Aliases: ${aliasList.map((a) => `\`${a}\``).join(', ')})*` : '';
        return `• **\`${syntaxStr}\`**${permBadge} — ${cmd.description}${aliasStr}`;
      });

      addSafeFields(embed, `${meta.emoji} ${selectedCategory}`, commandLines);
    }

    embed.setFooter({
      text: `Prefix: "${prefix}" • Use menu to switch category or return to All Pages`,
    });
    return embed;
  }

  // Multi-category page
  const pageGroups = getHelpPageGroups(isAdmin);
  const safePageIndex = Math.max(0, Math.min(pageIndex, pageGroups.length - 1));
  const activeCategories = pageGroups[safePageIndex] || [];
  const totalPages = pageGroups.length;

  embed.setTitle(`🎮 MatchDistrict Bot Commands ${totalPages > 1 ? `(${safePageIndex + 1}/${totalPages})` : ''}`);
  embed.setDescription(
    `Welcome to the **MatchDistrict** command directory!\n` +
    `• Command Prefix: **\`${prefix}\`**\n` +
    (isAdmin ? `• Role: **Administrator / Moderator** *(All commands visible)*\n` : `• Role: **Server Member**\n`) +
    `────────────────────────────────────────`
  );

  for (const cat of activeCategories) {
    const meta = CATEGORY_METADATA[cat] || { emoji: '📁', description: '' };
    const commands = getCommandsByCategory(cat, { isAdmin, prefix });
    if (commands.length === 0) continue;

    const commandLines = commands.map((cmd) => {
      const syntaxStr = cmd.syntax(prefix);
      const permBadge = cmd.permission ? ` \`[${cmd.permission}]\`` : '';
      return `• **\`${syntaxStr}\`**${permBadge} — ${cmd.description}`;
    });

    addSafeFields(embed, `${meta.emoji} ${cat}`, commandLines);
  }

  embed.setFooter({
    text: `Page ${safePageIndex + 1} of ${totalPages} • Use buttons below to paginate or menu to filter`,
  });

  return embed;
}

/**
 * Builds interactive pagination buttons and category select menu.
 */
export function buildHelpComponents({
  prefix = '.',
  isAdmin = false,
  pageIndex = 0,
  selectedCategory = null,
} = {}) {
  const pageGroups = getHelpPageGroups(isAdmin);
  const totalPages = pageGroups.length;
  const adminFlag = isAdmin ? '1' : '0';

  const components = [];

  // 1. Category Select Menu
  const categories = getHelpCategories({ isAdmin });
  if (categories.length > 0) {
    const options = [
      {
        label: '📖 All Commands (Overview)',
        description: 'View paginated command overview',
        value: 'all',
        default: !selectedCategory,
      },
    ];

    for (const cat of categories) {
      const meta = CATEGORY_METADATA[cat] || { emoji: '📁' };
      options.push({
        label: cat,
        description: meta.description ? meta.description.slice(0, 100) : `View ${cat}`,
        emoji: meta.emoji,
        value: cat,
        default: selectedCategory === cat,
      });
    }

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`help:cat:${adminFlag}:${pageIndex}`)
      .setPlaceholder('Filter by command category...')
      .addOptions(options.slice(0, 25));

    components.push(new ActionRowBuilder().addComponents(selectMenu));
  }

  // 2. Pagination Buttons (only if not in single category and more than 1 page)
  if (totalPages > 1 && !selectedCategory) {
    const prevBtn = new ButtonBuilder()
      .setCustomId(`help:p:${pageIndex - 1}:${adminFlag}`)
      .setLabel('Previous')
      .setEmoji('◀️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(pageIndex <= 0);

    const nextBtn = new ButtonBuilder()
      .setCustomId(`help:p:${pageIndex + 1}:${adminFlag}`)
      .setLabel('Next')
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(pageIndex >= totalPages - 1);

    components.push(new ActionRowBuilder().addComponents(prevBtn, nextBtn));
  } else if (selectedCategory) {
    const backBtn = new ButtonBuilder()
      .setCustomId(`help:p:0:${adminFlag}`)
      .setLabel('Back to All Pages')
      .setEmoji('🔙')
      .setStyle(ButtonStyle.Secondary);

    components.push(new ActionRowBuilder().addComponents(backBtn));
  }

  return components;
}

/**
 * Text representation builder for backwards compatibility and unit testing.
 * Ensures tests like `assert.match(help, /\.remove threads/)` pass seamlessly.
 */
export function buildHelpText(prefix = '.', { isAdmin = true } = {}) {
  const lines = [
    `🎮 **MatchDistrict Bot Commands**`,
    `Prefix: \`${prefix}\``,
    '',
  ];

  const categories = getHelpCategories({ isAdmin });
  for (const cat of categories) {
    const meta = CATEGORY_METADATA[cat] || { emoji: '📁' };
    lines.push(`**${meta.emoji} ${cat}:**`);
    const commands = getCommandsByCategory(cat, { isAdmin, prefix });
    for (const cmd of commands) {
      const syntaxStr = cmd.syntax(prefix);
      const permBadge = cmd.permission ? ` — *(${cmd.permission})*` : '';
      lines.push(`• \`${syntaxStr}\`${permBadge} — ${cmd.description}`);
    }
    lines.push('');
  }

  lines.push(`🌐 Visit our platform: https://matchdistrict.in`);
  lines.push(`— Team MatchDistrict`);

  return lines.join('\n');
}

/**
 * Backwards-compatible getHelpResponse function.
 * Returns a primitive string by default so that regex tests succeed,
 * or an object if options.asEmbed is true.
 */
export function getHelpResponse(prefix = '.', options = {}) {
  const isAdminUser = options?.isAdmin ?? true;
  const text = buildHelpText(prefix, { isAdmin: isAdminUser });
  if (options?.asEmbed) {
    const embed = buildHelpEmbed({ prefix, isAdmin: isAdminUser, pageIndex: 0 });
    const components = buildHelpComponents({ prefix, isAdmin: isAdminUser, pageIndex: 0 });
    return { content: text, embeds: [embed], components };
  }
  return text;
}

/**
 * Resolves a category name from partial user input (e.g. "tdm", "mod", "admin", "roommaker").
 */
export function resolveCategoryFromInput(input) {
  if (!input) return null;
  const lower = input.trim().toLowerCase();
  if (lower === 'tdm' || lower === 'arena' || lower === '1v1') return COMMAND_CATEGORIES.TDM;
  if (lower === 'tournament' || lower === 'tournaments' || lower === 'tourney') return COMMAND_CATEGORIES.TOURNAMENT;
  if (lower === 'roommaker' || lower === 'volunteer' || lower === 'room') return COMMAND_CATEGORIES.ROOM_MAKER;
  if (lower === 'mod' || lower === 'moderation') return COMMAND_CATEGORIES.MODERATION;
  if (lower === 'admin' || lower === 'administration') return COMMAND_CATEGORIES.ADMINISTRATION;
  if (lower === 'config' || lower === 'configuration' || lower === 'setup') return COMMAND_CATEGORIES.CONFIGURATION;
  if (lower === 'util' || lower === 'utility' || lower === 'invite') return COMMAND_CATEGORIES.UTILITY;
  if (lower === 'general' || lower === 'info') return COMMAND_CATEGORIES.GENERAL;

  return Object.values(COMMAND_CATEGORIES).find(
    (c) => c.toLowerCase() === lower || c.toLowerCase().includes(lower)
  ) || null;
}

/**
 * Handles .help command execution from message handler.
 */
export async function handleHelpCommand(guild, member, channel, args, replyFn, prefix = '.', message = null) {
  const isUserAdmin = isAdmin(member);
  const targetCategoryArg = args.join(' ').trim();
  const selectedCategory = targetCategoryArg ? resolveCategoryFromInput(targetCategoryArg) : null;

  const embed = buildHelpEmbed({
    prefix,
    isAdmin: isUserAdmin,
    pageIndex: 0,
    selectedCategory,
    guild,
  });

  const components = buildHelpComponents({
    prefix,
    isAdmin: isUserAdmin,
    pageIndex: 0,
    selectedCategory,
  });

  return replyFn({ embeds: [embed], components });
}

/**
 * Handles interactive button and select menu navigation for the help directory.
 * Works seamlessly across bot restarts (stateless customId encoding).
 */
export async function handleHelpInteraction(interaction, prefix = '.') {
  const customId = interaction.customId || '';
  if (!customId.startsWith('help:')) return false;

  const parts = customId.split(':');
  const type = parts[1]; // 'p' (page) or 'cat' (category)

  if (type === 'p') {
    const pageIndex = parseInt(parts[2], 10) || 0;
    const isAdminUser = parts[3] === '1';

    const embed = buildHelpEmbed({
      prefix,
      isAdmin: isAdminUser,
      pageIndex,
      selectedCategory: null,
      guild: interaction.guild,
    });

    const components = buildHelpComponents({
      prefix,
      isAdmin: isAdminUser,
      pageIndex,
      selectedCategory: null,
    });

    await interaction.update({
      embeds: [embed],
      components,
    }).catch(() => {});
    return true;
  }

  if (type === 'cat') {
    const isAdminUser = parts[2] === '1';
    const pageIndex = parseInt(parts[3], 10) || 0;
    const selectedValue = interaction.values?.[0];

    const selectedCategory = selectedValue === 'all' ? null : selectedValue;

    const embed = buildHelpEmbed({
      prefix,
      isAdmin: isAdminUser,
      pageIndex,
      selectedCategory,
      guild: interaction.guild,
    });

    const components = buildHelpComponents({
      prefix,
      isAdmin: isAdminUser,
      pageIndex,
      selectedCategory,
    });

    await interaction.update({
      embeds: [embed],
      components,
    }).catch(() => {});
    return true;
  }

  return false;
}
