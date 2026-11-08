export {
  ROLE_PREFIX_COLLECTION,
  ensureRolePrefixIndexes,
  initRolePrefixCache,
  clearRolePrefixMemoryCache,
  getGuildRolePrefixes,
  getGuildRolePrefixesFromCache,
  getRolePrefixFromCache,
  findPrefixInGuild,
  saveRolePrefix,
  deleteRolePrefix,
} from './models/rolePrefixModels.js';

export {
  isRoleAdmin,
  canBotManageNicknames,
  isMemberManageable,
  stripManagedPrefix,
  formatPrefixedNickname,
  resolveActivePrefixConfig,
  computeTargetNickname,
  applyRolePrefixToGuildMembers,
  removeRolePrefixFromGuildMembers,
  handleRoleCommand,
  handleRolePrefixInteraction,
  handleRolePrefixMemberUpdate,
} from './services/rolePrefixService.js';

