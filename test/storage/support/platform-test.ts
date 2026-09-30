import { platform } from 'node:os';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { assertDurableRoot } from '../../../src/storage/durable-fs.ts';

const APFS_SKIP = 'Controlled durable transaction fixture requires validated local APFS; production storage remains fail-closed elsewhere.';
let localRootCheck: Promise<string | undefined> | undefined;

export function durableStorageTest(name: string, run: (context: TestContext) => void | Promise<void>): void {
  if (platform() !== 'darwin') {
    test.skip(name, { skip: APFS_SKIP }, run);
    return;
  }
  test(name, async (context) => {
    localRootCheck ??= assertDurableRoot(tmpdir()).then(() => undefined, (error: unknown) => {
      const code = (error as { code?: unknown }).code;
      return code === 'DURABILITY_FILESYSTEM_UNSUPPORTED' ? 'Controlled durable transaction fixture requires local APFS.' : 'Local APFS durability could not be established for the fixture root.';
    });
    const reason = await localRootCheck;
    if (reason) { context.skip(reason); return; }
    await run(context);
  });
}
