export {
  PathResolver,
  DEFAULT_PATH_CONFIG,
  findConfigRoot,
  findProjectRoot,
  setSessionProjectRoot,
  getSessionProjectRoot,
  getWorkingDirectory,
  requireConfigRoot,
  type PathConfig,
} from './path-resolver';
export {
  ConfigIO,
  createConfigIO,
  getSchemaUrlForVersion,
  setLegacyProjectMigrationReporter,
  type LegacyProjectMigrationInfo,
  type LegacyProjectMigrationReporter,
} from './config-io';
