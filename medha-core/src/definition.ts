import { InvalidArgumentError } from './errors.ts';

/**
 * Host-authored, non-evidential definition of an entity, trust spec §11a.1: title, optional tags,
 * and rationale. Never folded as evidence — a `define` episode must never change `EntityState`,
 * so this has its own fold (`foldDefinitions`) entirely separate from `foldEpisode`'s trust fold.
 */
export interface EntityDefinition {
  readonly title: string;
  readonly tags?: readonly string[] | undefined;
  readonly rationale: string;
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
}
