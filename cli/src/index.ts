export { runCli } from './cli.ts';
export { commands } from './commands.ts';
export { type Environment, processEnvironment } from './environment.ts';
export {
  HomeExistsError,
  HomeNotInitializedError,
  RegistryDriftError,
  SnapshotFileError,
  StoreCorruptError,
  UpdaterForkError,
  UpdaterNotFoundError,
} from './errors.ts';
export { type InitOptions, type InitReport, normalizeBackend, runInit } from './init.ts';
export {
  type Backend,
  CONFIG_LAYOUT_VERSION,
  type SageConfigV1,
  storeForConfig,
} from './layout.ts';
export {
  type MaintainBackupOptions,
  type MaintainBackupReport,
  type MaintainCompactOptions,
  type MaintainCompactReport,
  type MaintainPreflightOptions,
  type MaintainPreflightReport,
  type MaintainRestoreOptions,
  type MaintainRestoreReport,
  readSnapshotFile,
  runMaintainBackup,
  runMaintainCompact,
  runMaintainPreflight,
  runMaintainRestore,
} from './maintain.ts';
export { createMcpServer, type ServeMcpOptions, serveMcp } from './mcp.ts';
export { type OpenedHome, openHome } from './open.ts';
export {
  LIFECYCLE_STATUSES,
  type ListReport,
  type ParamsReport,
  paramsReport,
  positiveInt,
  runDrift,
  runExplainThreshold,
  runList,
  runParams,
  runShow,
  runSimulate,
  runStatus,
} from './read.ts';
export {
  runUpdaterFork,
  runUpdaterList,
  runUpdaterShow,
  type UpdaterCommonOptions,
  type UpdaterForkOptions,
  type UpdaterForkReport,
  type UpdaterListOptions,
  type UpdaterListReport,
  type UpdaterShowOptions,
  type UpdaterShowReport,
} from './updater.ts';
export { VERSION } from './version.ts';
