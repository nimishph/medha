import { InvalidArgumentError } from './errors.ts';

export interface ContextTargets {
  /** File glob patterns or filenames where this entity applies (e.g. ['src/components/**', 'Cargo.toml']). */
  readonly files?: readonly string[] | undefined;
  /** Programming language IDs (e.g. ['typescript', 'rust', 'python']). */
  readonly languages?: readonly string[] | undefined;
  /** Task query keywords or domain terms (e.g. ['migration', 'database', 'auth']). */
  readonly keywords?: readonly string[] | undefined;
}

/**
 * Host-authored, non-evidential definition of an entity, trust spec §11a.1: title, optional tags,
 * rationale, and context targets for selective agent prompt packing (medha-c8z.1).
 * Never folded as evidence — a `define` episode must never change `EntityState`,
 * so this has its own fold (`foldDefinitions`) entirely separate from `foldEpisode`'s trust fold.
 */
export interface EntityDefinition {
  readonly title: string;
  readonly tags?: readonly string[] | undefined;
  readonly rationale: string;
  readonly contextTargets?: ContextTargets | undefined;
}

/** Validate a definition before it enters the log, mirroring `validateEpisodeInput`'s style. */
export function validateEntityDefinition(definition: EntityDefinition): void {
  if (typeof definition.title !== 'string' || definition.title.trim() === '') {
    throw new InvalidArgumentError('definition.title', 'a non-empty string', definition.title);
  }
  if (typeof definition.rationale !== 'string' || definition.rationale.trim() === '') {
    throw new InvalidArgumentError(
      'definition.rationale',
      'a non-empty string',
      definition.rationale,
    );
  }
  if (definition.tags !== undefined) {
    if (!Array.isArray(definition.tags)) {
      throw new InvalidArgumentError('definition.tags', 'an array of strings', definition.tags);
    }
    for (const tag of definition.tags) {
      if (typeof tag !== 'string' || tag.trim() === '') {
        throw new InvalidArgumentError('definition.tags[]', 'a non-empty string', tag);
      }
    }
  }
  if (definition.contextTargets !== undefined) {
    const ct = definition.contextTargets;
    if (typeof ct !== 'object' || ct === null) {
      throw new InvalidArgumentError('definition.contextTargets', 'an object', ct);
    }
    for (const field of ['files', 'languages', 'keywords'] as const) {
      const list = ct[field];
      if (list !== undefined) {
        if (!Array.isArray(list)) {
          throw new InvalidArgumentError(
            `definition.contextTargets.${field}`,
            'an array of strings',
            list,
          );
        }
        for (const item of list) {
          if (typeof item !== 'string' || item.trim() === '') {
            throw new InvalidArgumentError(
              `definition.contextTargets.${field}[]`,
              'a non-empty string',
              item,
            );
          }
        }
      }
    }
  }
}
