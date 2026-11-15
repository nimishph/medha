import { type ArgsDef, defineCommand } from 'citty';
import { currentEnvironment, type Environment } from './environment.ts';
import {
  type KeysCommonOptions,
  renderKeysList,
  renderKeysVerify,
  runKeysGenerate,
  runKeysList,
  runKeysMode,
  runKeysRevoke,
  runKeysRotate,
  runKeysVerify,
} from './keys.ts';
import { openHome } from './open.ts';
import { toJson } from './render.ts';

/** `medha keys …` — signing keys, keyring and signing mode (medha-nwf.4). */

const keysCommonArgs: ArgsDef = {
  dir: {
    type: 'string',
    description: 'Project directory whose .medha/ home to open. Default: cwd.',
  },
  home: {
    type: 'string',
    description: 'Engine home directory, overriding <dir>/.medha (e.g. an existing .sutra/medha).',
  },
  json: { type: 'boolean', description: 'Emit the report as JSON.', default: false },
};

function common(args: Record<string, unknown>): KeysCommonOptions {
  return {
    ...(args.dir === undefined ? {} : { dir: args.dir as string }),
    ...(args.home === undefined ? {} : { home: args.home as string }),
  };
}

function emit(environment: Environment, json: unknown, report: unknown, text: string): void {
  environment.stdout(json === true ? toJson(report) : text);
}

export interface KeysAdoptReport {
  readonly baselinesWritten: number;
  readonly folded: { readonly from: number; readonly to: number } | null;
  readonly remainingEpisodes: number;
}

/** Endorse a legacy log with maintainer-signed baselines, so `require` mode keeps its state. */
export async function runKeysAdopt(
  options: KeysCommonOptions,
  environment: Environment,
): Promise<KeysAdoptReport> {
  const opened = openHome(options.dir ?? environment.cwd, options.home, environment.env);
  try {
    return await opened.adminEngine.adopt({ now: environment.now() });
  } finally {
    await opened.adminEngine.close();
  }
}

export const keysGenerateCommand = defineCommand({
  meta: {
    name: 'generate',
    description:
      'Create an Ed25519 signing key: public half into keys/keyring.json, private half into your key directory (never the home).',
  },
  args: {
    ...keysCommonArgs,
    principal: {
      type: 'string',
      description: "The author id this key signs as (e.g. agent:ci or human:ada). No '/'.",
      required: true,
    },
    role: {
      type: 'string',
      description: 'Comma-separated roles: agent, human, maintainer. Default: agent.',
    },
    namespace: {
      type: 'string',
      description: 'Comma-separated namespaces this key may sign in. Default: all.',
    },
    comment: { type: 'string', description: 'Free-form note stored with the key record.' },
    default: {
      type: 'boolean',
      description: "Make this the home's default signing key (automatic for the first key).",
    },
  },
  async run({ args }) {
    const environment = currentEnvironment();
    const report = runKeysGenerate(
      {
        ...common(args),
        principal: args.principal as string,
        ...(args.role === undefined ? {} : { role: args.role as string }),
        ...(args.namespace === undefined ? {} : { namespace: args.namespace as string }),
        ...(args.comment === undefined ? {} : { comment: args.comment as string }),
        ...(args.default === true ? { setDefault: true } : {}),
      },
      environment,
    );
    emit(
      environment,
      args.json,
      report,
      `generated ${report.keyId} for ${report.principal} [${report.roles.join(',')}]${
        report.isDefault ? ' (default)' : ''
      }\n  public:  ${report.keyringPath}\n  private: ${report.privateKeyPath}\n`,
    );
  },
});

export const keysListCommand = defineCommand({
  meta: { name: 'list', description: 'List the keyring, the signing mode and the default key.' },
  args: keysCommonArgs,
  async run({ args }) {
    const environment = currentEnvironment();
    const report = runKeysList(common(args), environment);
    emit(environment, args.json, report, renderKeysList(report));
  },
});

export const keysRotateCommand = defineCommand({
  meta: {
    name: 'rotate',
    description:
      'Planned rotation: a new key for the same principal; the old one keeps its past episodes valid and its private key is deleted.',
  },
  args: {
    ...keysCommonArgs,
    keyId: { type: 'positional', description: 'The key id to rotate out.', required: true },
  },
  async run({ args }) {
    const environment = currentEnvironment();
    const report = runKeysRotate({ ...common(args), keyId: args.keyId as string }, environment);
    emit(
      environment,
      args.json,
      report,
      `rotated ${report.retired} -> ${report.keyId}\n  private: ${report.privateKeyPath}\n`,
    );
  },
});

export const keysRevokeCommand = defineCommand({
  meta: {
    name: 'revoke',
    description:
      'Compromise revocation: every episode the key signed stops counting (unless --trust-before keeps older ones). Nothing is deleted.',
  },
  args: {
    ...keysCommonArgs,
    keyId: { type: 'positional', description: 'The key id to revoke.', required: true },
    reason: { type: 'string', description: 'Why the key is revoked.', required: true },
    'trust-before': {
      type: 'string',
      description:
        'Epoch ms: keep episodes signed with at < this (only with out-of-band evidence).',
    },
  },
  async run({ args }) {
    const environment = currentEnvironment();
    const raw = args['trust-before'] as string | undefined;
    const report = runKeysRevoke(
      {
        ...common(args),
        keyId: args.keyId as string,
        reason: args.reason as string,
        ...(raw === undefined ? {} : { trustBefore: Number(raw) }),
      },
      environment,
    );
    emit(
      environment,
      args.json,
      report,
      `revoked ${report.keyId}${report.trustBefore === null ? '' : ` (episodes before ${report.trustBefore} kept)`}\n`,
    );
  },
});

export const keysVerifyCommand = defineCommand({
  meta: {
    name: 'verify',
    description: 'Verify every episode in the log against the keyring.',
  },
  args: keysCommonArgs,
  async run({ args }) {
    const environment = currentEnvironment();
    const report = await runKeysVerify(common(args), environment);
    emit(environment, args.json, report, renderKeysVerify(report));
  },
});

export const keysModeCommand = defineCommand({
  meta: {
    name: 'mode',
    description: "Set the signing mode: off | warn | require. Run 'keys adopt' before require.",
  },
  args: {
    ...keysCommonArgs,
    mode: { type: 'positional', description: 'off | warn | require', required: true },
  },
  async run({ args }) {
    const environment = currentEnvironment();
    const report = runKeysMode({ ...common(args), mode: args.mode as string }, environment);
    emit(environment, args.json, report, `signing mode: ${report.previous} -> ${report.mode}\n`);
  },
});

export const keysAdoptCommand = defineCommand({
  meta: {
    name: 'adopt',
    description:
      'Endorse the existing (unsigned) log: fold it into baselines signed by your maintainer key.',
  },
  args: keysCommonArgs,
  async run({ args }) {
    const environment = currentEnvironment();
    const report = await runKeysAdopt(common(args), environment);
    emit(
      environment,
      args.json,
      report,
      report.folded === null
        ? 'nothing to adopt\n'
        : `adopted seq ${report.folded.from}..${report.folded.to} into ${report.baselinesWritten} signed baseline(s); ${report.remainingEpisodes} episode(s) in the log\n`,
    );
  },
});

export const keysCommand = defineCommand({
  meta: {
    name: 'keys',
    description: 'Episode signing: keys, keyring, rotation, revocation and signing mode.',
  },
  subCommands: {
    generate: keysGenerateCommand,
    list: keysListCommand,
    rotate: keysRotateCommand,
    revoke: keysRevokeCommand,
    verify: keysVerifyCommand,
    mode: keysModeCommand,
    adopt: keysAdoptCommand,
  },
});
