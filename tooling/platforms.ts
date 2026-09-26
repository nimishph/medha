/**
 * The platforms the program is built for. The binary is compiled with `bun build --compile`, so
 * each is either built on its own runner (and smoke-tested there) or cross-compiled from one.
 */
export interface Platform {
  readonly os: 'linux' | 'darwin' | 'win32';
  readonly cpu: 'x64' | 'arm64';
  /** The GitHub Actions runner that builds it. */
  readonly runner: string;
  /** True when the binary is cross-compiled, so it cannot be run on the machine that built it. */
  readonly crossCompiled: boolean;
}

export const PLATFORMS: readonly Platform[] = [
  { os: 'linux', cpu: 'x64', runner: 'ubuntu-latest', crossCompiled: false },
  { os: 'linux', cpu: 'arm64', runner: 'ubuntu-24.04-arm', crossCompiled: false },
  { os: 'darwin', cpu: 'arm64', runner: 'macos-latest', crossCompiled: false },
  { os: 'darwin', cpu: 'x64', runner: 'macos-latest', crossCompiled: true },
  { os: 'win32', cpu: 'x64', runner: 'windows-latest', crossCompiled: false },
];

export const SCOPE = '@cntxt-labs';
/** The package a user installs; it holds only the launcher and depends on one platform package. */
export const MAIN_PACKAGE = `${SCOPE}/medha-cli`;
/** The prefix of the per-platform packages, which is the command's name and not the main package's. */
const PLATFORM_PREFIX = `${SCOPE}/medha`;

/** `@cntxt-labs/medha-linux-x64`: the package that holds the program for one platform. */
export const platformPackage = (platform: Pick<Platform, 'os' | 'cpu'>): string =>
  `${PLATFORM_PREFIX}-${platform.os}-${platform.cpu}`;
