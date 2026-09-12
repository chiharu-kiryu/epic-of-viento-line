import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReleaseVersion } from '../../desktop/version.mjs';

test('release numbers retain their letter and map optional patches to installer versions', () => {
  for (const [version, buildVersion] of [
    ['b.2.8', '2.8.0'],
    ['b.2.8.0', '2.8.0'],
    ['b.2.8.1', '2.8.1'],
    ['b.2.8.12', '2.8.12'],
    ['c.3.0', '3.0.0'],
  ]) {
    assert.deepEqual(parseReleaseVersion(version), { version, buildVersion });
  }
});

test('release numbers reject ambiguous, missing and extra components', () => {
  for (const version of ['', '2.8.1', 'B.2.8.1', 'beta.2.8.1', 'b.2', 'b.2.8.',
    'b.02.8.1', 'b.2.08.1', 'b.2.8.01', 'b.2.8.-1', 'b.2.8.1.0', 'b.2.8.1-beta']) {
    assert.throws(() => parseReleaseVersion(version), /VERSION must use the project release format/);
  }
});
