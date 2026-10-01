/**
 * Unit tests for .medha/config.json schema validation and IDE autocomplete support (§14.4, medha-168.1).
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CONFIG_KEYS,
  CONFIG_SCHEMA_URL,
  effectiveRegistriesFrom,
  readConfig,
  writeConfig,
} from './layout.ts';

const rootDir = resolve(import.meta.dir, '../..');
const schemaPath = join(rootDir, 'schemas', 'config.v1.json');

describe('config.v1.json Schema & IDE Autocomplete', () => {
  it('schema file exists and is valid JSON Schema Draft 2020-12', () => {
    const raw = readFileSync(schemaPath, 'utf8');
    const schema = JSON.parse(raw);

    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe(CONFIG_SCHEMA_URL);
    expect(schema.title).toContain('Medha Configuration Schema');
    expect(schema.properties.backend.enum).toEqual(['sqlite', 'file', 'memory']);
    expect(schema.properties.registries.required).toEqual(['kinds', 'signalSpecs', 'anchorKinds']);
  });

  it('guarantees zero-drift: strict bidirectional 1-to-1 match between CONFIG_KEYS and schemas/config.v1.json', () => {
    const raw = readFileSync(schemaPath, 'utf8');
    const schema = JSON.parse(raw);

    const kindSpecProps = Object.keys(
      schema.properties.registries.properties.kindSpecs.items.properties,
    );
    expect([...kindSpecProps].sort()).toEqual([...CONFIG_KEYS.kindSpec].sort());

    const thresholdsProps = Object.keys(
      schema.properties.registries.properties.kindSpecs.items.properties.thresholds.properties,
    );
    expect([...thresholdsProps].sort()).toEqual([...CONFIG_KEYS.thresholds].sort());

    const recencyProps = Object.keys(
      schema.properties.registries.properties.kindSpecs.items.properties.recency.properties,
    );
    expect([...recencyProps].sort()).toEqual([...CONFIG_KEYS.recency].sort());

    const signalLimitsProps = Object.keys(
      schema.properties.registries.properties.kindSpecs.items.properties.signalLimits.properties,
    );
    expect([...signalLimitsProps].sort()).toEqual([...CONFIG_KEYS.signalLimits].sort());

    const decisionPolicyProps = Object.keys(
      schema.properties.registries.properties.kindSpecs.items.properties.decisionPolicy.properties,
    );
    expect([...decisionPolicyProps].sort()).toEqual([...CONFIG_KEYS.decisionPolicy].sort());
  });

  it('writeConfig scaffolds $schema pointing to canonical github raw URI', () => {
    const tempDir = join(rootDir, 'target', 'test-schema-home');
    const path = writeConfig(tempDir, {
      layoutVersion: 1,
      backend: 'sqlite',
      path: join(tempDir, 'store.sqlite'),
      registries: {
        kinds: ['rule', 'tool'],
        signalSpecs: [{ name: 'APPLY', value: 1.0, countsAsTrial: true, countsAsSuccess: true }],
        anchorKinds: ['git-head'],
      },
    });

    const content = JSON.parse(readFileSync(path, 'utf8'));
    expect(content.$schema).toBe(CONFIG_SCHEMA_URL);
    expect(content.layoutVersion).toBe(1);
    expect(content.backend).toBe('sqlite');

    // readConfig preserves $schema
    const loaded = readConfig(tempDir);
    expect(loaded?.$schema).toBe(CONFIG_SCHEMA_URL);
  });

  it('allows $schema in host registries config without unknown key error', () => {
    const tempDir = join(rootDir, 'target', 'test-host-config');
    const configPath = join(tempDir, 'custom-registries.json');
    const { mkdirSync, writeFileSync } = require('node:fs');
    mkdirSync(tempDir, { recursive: true });

    writeFileSync(
      configPath,
      JSON.stringify({
        $schema: CONFIG_SCHEMA_URL,
        kinds: ['rule', 'custom-kind'],
        anchorKinds: ['git-head'],
      }),
      'utf8',
    );

    const registries = effectiveRegistriesFrom(configPath);
    expect(registries.kinds).toContain('custom-kind');
  });
});
