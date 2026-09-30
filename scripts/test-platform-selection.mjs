const WINDOWS_TESTS = new Set([
  'test/adapters/inventory.test.ts',
  'test/storage/schema.test.ts',
  'test/storage/platform-gate.test.ts',
  'test/mutations/capabilities.test.ts',
]);

export function selectPlatformTests(platform, files) {
  if (platform === 'darwin' || platform === 'linux') return [...files].sort();
  if (platform === 'win32') return [...files].filter((file) => WINDOWS_TESTS.has(file)).sort();
  throw new Error(`No validated test selection exists for platform ${platform}`);
}
