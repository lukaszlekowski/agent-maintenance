import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseCodexSessionIndex, readCodexInventory, CODEX_SUPPORTED_VERSIONS } from '../../src/adapters/codex.ts';
import { parseCodexProjectTrust, readCodexProjectTrust } from '../../src/adapters/codex-trust.ts';
import { parseOpenCodeSessionList } from '../../src/adapters/opencode.ts';
import { buildInventory } from '../../src/inventory.ts';
import { serializeInventoryError, serializeInventoryJson } from '../../src/cli.ts';
import { MaintenanceError, sessionId } from '../../src/types.ts';

const FIXTURES = new URL('../fixtures/', import.meta.url);
const CODEx = new URL('codex-0.159.2/session-index.jsonl', FIXTURES);
const CODEX_TRUST = new URL('codex-0.159.2/config-trust.toml', FIXTURES);
const CODEX_TRUST_MALFORMED = new URL('codex-0.159.2/config-trust-malformed.toml', FIXTURES);
const OPENCODE = new URL('opencode-1.18.33/session-list.json', FIXTURES);
const OPENCODE_MALFORMED = new URL('opencode-1.18.33/session-list-malformed.json', FIXTURES);
const exec = promisify(execFile);

test('Codex 0.159.2 index parser accepts sanitized source-shaped JSONL and last update wins', async () => {
  const fixture = await readFile(CODEx, 'utf8');
  const repeated = `${fixture.trimEnd()}\n{"id":"00000000-0000-4000-8000-000000000001","thread_name":"Updated fixture title","updated_at":"2026-09-02T10:00:00.000Z"}\n`;
  const rows = parseCodexSessionIndex(repeated);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.thread_name, 'Updated fixture title');
});

test('Codex index rejects malformed JSON and schema drift with stable errors', () => {
  assert.throws(() => parseCodexSessionIndex('{bad json}\n'), (error: unknown) => error instanceof MaintenanceError && error.code === 'ADAPTER_MALFORMED_INDEX');
  assert.throws(() => parseCodexSessionIndex('{"id":"not-a-uuid","title":"x"}\n'), (error: unknown) => error instanceof MaintenanceError && error.code === 'ADAPTER_SCHEMA_DRIFT');
});

test('Codex 0.159.2 trust TOML extracts trusted, untrusted, and unknown project settings', async () => {
  const fixtureRoot = '/tmp/agent-maintenance-codex-fixture';
  const rows = parseCodexProjectTrust(await readFile(CODEX_TRUST, 'utf8'));
  assert.deepEqual(rows.map((row) => row.trustLevel), ['trusted', 'untrusted', 'unknown']);
  assert.deepEqual(rows.map((row) => row.path), [join(fixtureRoot, 'trusted'), join(fixtureRoot, 'untrusted'), join(fixtureRoot, 'unknown')]);
  assert.deepEqual(parseCodexProjectTrust(''), []);
  assert.throws(() => parseCodexProjectTrust('projects = 1979-05-27T07:32:00Z'), (error: unknown) => error instanceof MaintenanceError && error.code === 'ADAPTER_SCHEMA_DRIFT');
  assert.throws(() => parseCodexProjectTrust('projects = { "/tmp/example" = 1979-05-27T07:32:00Z }'), (error: unknown) => error instanceof MaintenanceError && error.code === 'ADAPTER_SCHEMA_DRIFT');
  const malformed = await readFile(CODEX_TRUST_MALFORMED, 'utf8');
  assert.throws(() => parseCodexProjectTrust(malformed), (error: unknown) => error instanceof MaintenanceError && error.code === 'ADAPTER_MALFORMED_CONFIG');
  assert.throws(() => parseCodexProjectTrust('[projects.relative]\ntrust_level="trusted"'), (error: unknown) => error instanceof MaintenanceError && error.code === 'ADAPTER_SCHEMA_DRIFT');
});

test('Codex config read distinguishes an inspected absent/empty config from malformed and inaccessible data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-maintenance-codex-config-'));
  try {
    assert.deepEqual(await readCodexProjectTrust(root), { entries: [], inspected: true });
    const config = join(root, 'config.toml');
    await writeFile(config, '', 'utf8');
    assert.deepEqual(await readCodexProjectTrust(root), { entries: [], inspected: true });
    await writeFile(config, '[projects]\nnot_a_table = 1\n', 'utf8');
    await assert.rejects(readCodexProjectTrust(root), (error: unknown) => error instanceof MaintenanceError && error.code === 'ADAPTER_SCHEMA_DRIFT');
    await writeFile(config, 'projects = [', 'utf8');
    await assert.rejects(readCodexProjectTrust(root), (error: unknown) => error instanceof MaintenanceError && error.code === 'ADAPTER_MALFORMED_CONFIG');
    await rm(config);
    await mkdir(config);
    await assert.rejects(readCodexProjectTrust(root), (error: unknown) => error instanceof MaintenanceError && error.code === 'ADAPTER_READ_FAILED');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Codex unknown version fails closed and exact supported version leaves ownership unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-maintenance-codex-'));
  try {
    await writeFixture(join(root, 'session_index.jsonl'), await readFile(CODEx, 'utf8'));
    await writeFixture(join(root, 'config.toml'), await readFile(CODEX_TRUST, 'utf8'));
    const indexBefore = await readFile(join(root, 'session_index.jsonl'));
    const configBefore = await readFile(join(root, 'config.toml'));
    assert.ok(CODEX_SUPPORTED_VERSIONS.includes('codex-cli 0.160.0'));
    const unsupported = await readCodexInventory(root, 'codex-cli 9.9.9');
    assert.equal(unsupported.sessions.length, 0);
    assert.equal(unsupported.status.capabilities.sessionRead.enabled, false);
    for (const version of CODEX_SUPPORTED_VERSIONS) {
      const supported = await readCodexInventory(root, version);
      assert.equal(supported.sessions.length, 2);
      assert.equal(supported.trustPaths.length, 3);
      assert.equal(supported.status.capabilities.sessionRead.enabled, true);
      assert.equal(supported.status.capabilities.trustRead.enabled, true);
      for (const capability of ['dormantStorage', 'restore', 'trustEdit', 'processTermination'] as const) {
        assert.equal(supported.status.capabilities[capability].enabled, false);
      }
      assert.ok(supported.sessions.every((session) => session.ownership === 'UNKNOWN' && session.workloadKind === 'unknown'));
    }
    assert.deepEqual(await readFile(join(root, 'session_index.jsonl')), indexBefore);
    assert.deepEqual(await readFile(join(root, 'config.toml')), configBefore);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('OpenCode 1.18.33 JSON parser accepts only the pinned list schema', async () => {
  const fixture = await readFile(OPENCODE, 'utf8');
  const malformed = await readFile(OPENCODE_MALFORMED, 'utf8');
  assert.equal(parseOpenCodeSessionList(fixture).length, 1);
  assert.throws(() => parseOpenCodeSessionList(malformed), (error: unknown) => error instanceof MaintenanceError && error.code === 'ADAPTER_SCHEMA_DRIFT');
});

test('inventory retains every supplied trust path classification, including unavailable volumes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-maintenance-trust-'));
  try {
    const valid = join(root, 'existing');
    await mkdir(valid);
    const absent = join(root, 'gone');
    const unavailable = '/Volumes/fixture-volume/workspace';
    const unknownMount = '/mnt/uncertain/workspace';
    const inventory = await buildInventory({
      sessions: [], adapters: [], generatedAt: '2026-09-30T12:00:00.000Z',
      trustPaths: [
        { agentId: 'codex_cli', path: valid, trustLevel: 'trusted' },
        { agentId: 'claude_code_cli', path: unavailable, trustLevel: 'unknown' },
        { agentId: 'agy_cli', path: unknownMount, trustLevel: 'unknown' },
        { agentId: 'opencode_cli', path: absent, trustLevel: 'untrusted' },
      ],
      mountProbe: async (path) => path === unavailable ? 'NOT_MOUNTED' : path === unknownMount ? 'UNKNOWN' : 'MOUNTED',
    });
    assert.deepEqual(inventory.trustEntries.map((entry) => entry.state), ['VALID', 'UNAVAILABLE_VOLUME', 'INACCESSIBLE', 'CONFIRMED_OBSOLETE']);
    assert.equal(inventory.trustEntries.length, 4);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('inventory treats missing trust paths as inaccessible when mount evidence is unavailable', async () => {
  const inventory = await buildInventory({ sessions: [], adapters: [], trustPaths: [{ agentId: 'codex_cli', path: '/Volumes/unknown/workspace', trustLevel: 'trusted' }] });
  assert.equal(inventory.trustEntries[0]?.state, 'INACCESSIBLE');
});

test('CLI wires disposable Codex trust config into JSON, leaves source config unchanged, and never lists OpenCode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-maintenance-cli-e2e-'));
  const bin = join(root, 'bin');
  const codexHome = join(root, 'codex');
  const workspace = join(root, 'workspace');
  await mkdir(bin);
  await mkdir(codexHome);
  await mkdir(workspace);
  try {
    const configPath = join(codexHome, 'config.toml');
    const originalConfig = `[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`;
    await writeFile(configPath, originalConfig, 'utf8');
    const openCodeProbe = join(root, 'opencode-invoked');
    const scripts: Record<string, string> = {
      codex: '#!/bin/sh\nprintf "codex-cli 0.160.0\\n"\n',
      claude: '#!/bin/sh\nprintf "2.1.277 (Claude Code)\\n"\n',
      agy: '#!/bin/sh\nprintf "agy 1.2.14\\n"\n',
      opencode: `#!/bin/sh\nif [ "$1" = "--version" ]; then printf "1.18.33\\n"; else touch '${openCodeProbe}'; exit 97; fi\n`,
    };
    for (const [name, body] of Object.entries(scripts)) {
      const path = join(bin, name);
      await writeFile(path, body, 'utf8');
      await chmod(path, 0o755);
    }
    const before = await readFile(configPath);
    const { stdout } = await exec(process.execPath, ['--experimental-strip-types', 'src/cli.ts', 'inventory', '--json', '--codex-home', codexHome], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }, encoding: 'utf8', maxBuffer: 1024 * 1024,
    });
    const json = JSON.parse(stdout) as { trustEntries: Array<{ agentId: string; path: string; trustLevel: string; state: string }>; adapters: Array<{ agentId: string; capabilities: { sessionRead: { enabled: boolean } } }> };
    assert.deepEqual(json.trustEntries.map(({ agentId, path, trustLevel, state }) => ({ agentId, path, trustLevel, state })), [{ agentId: 'codex_cli', path: workspace, trustLevel: 'trusted', state: 'VALID' }]);
    assert.equal(json.adapters.find((adapter) => adapter.agentId === 'opencode_cli')?.capabilities.sessionRead.enabled, false);
    assert.deepEqual(await readFile(configPath), before);
    await assert.rejects(readFile(openCodeProbe));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('headless serializer emits stable JSON for summaries and structured errors', () => {
  const summary = JSON.parse(serializeInventoryJson({ sessions: [], verifiedSubagents: [], trustEntries: [] })) as Record<string, unknown>;
  assert.deepEqual(summary, { sessions: [], verifiedSubagents: [], trustEntries: [] });
  assert.deepEqual(JSON.parse(serializeInventoryError(new MaintenanceError('ADAPTER_SCHEMA_DRIFT', 'schema changed'))), {
    error: { code: 'ADAPTER_SCHEMA_DRIFT', message: 'schema changed' },
  });
});

test('common inventory keeps verified logical subagents separate from unknown user workloads', async () => {
  const base = {
    agentId: 'opencode_cli' as const, title: 'synthetic', updatedAt: '2026-09-01T00:00:00.000Z',
    ownership: 'UNKNOWN' as const, ownershipExplanation: 'fixture has no process binding',
  };
  const inventory = await buildInventory({ sessions: [
    { ...base, id: sessionId('ses_root'), workloadKind: 'unknown' },
    { ...base, id: sessionId('ses_child'), workloadKind: 'logical-subagent' },
  ], adapters: [], generatedAt: '2026-09-30T12:00:00.000Z' });
  assert.equal(inventory.sessions.length, 1);
  assert.equal(inventory.sessions[0]?.workloadKind, 'unknown');
  assert.equal(inventory.verifiedSubagents.length, 1);
  assert.equal(inventory.verifiedSubagents[0]?.workloadKind, 'logical-subagent');
});

async function writeFixture(path: string, contents: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, contents, 'utf8');
}
