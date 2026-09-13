import test from 'node:test';
import assert from 'node:assert/strict';
import { nextReleaseVersion, parseReleaseVersion } from '../../desktop/version.mjs';

test('beta release digits map below the first stable installer version', () => {
  for (const [version, buildVersion] of [
    ['b.0.0', '0.0.0'],
    ['b.2.8', '0.2.8'],
    ['b.2.9', '0.2.9'],
    ['b.9.9', '0.9.9'],
    ['1.0.0', '1.0.0'],
    ['2.4.9', '2.4.9'],
    ['10.0.0', '10.0.0'],
  ]) {
    assert.deepEqual(parseReleaseVersion(version), { version, buildVersion });
  }
});

test('release numbers reject extra patches, non-digit beta parts and invalid stable numbers', () => {
  for (const version of ['', 'B.2.8', 'beta.2.8', 'a.2.8', 'c.3.0', 'b.2', 'b.2.8.',
    'b.02.8', 'b.2.08', 'b.10.0', 'b.2.10', 'b.2.-1', 'b.2.8.1', 'b.2.8.9', 'b.2.8-beta',
    '0.2.9', '01.0.0', '1.00.0', '1.0.00', '1.10.0', '1.0.10', '1.0.0-beta', '1.0.0.0']) {
    assert.throws(() => parseReleaseVersion(version), /VERSION must use/);
    assert.throws(() => nextReleaseVersion(version), /VERSION must use/);
  }
});

test('all beta versions advance one digit and b.9.9 becomes 1.0.0', () => {
  for (let ordinal = 0; ordinal < 100; ordinal += 1) {
    const current = `b.${Math.floor(ordinal / 10)}.${ordinal % 10}`;
    const next = ordinal === 99 ? '1.0.0' : `b.${Math.floor((ordinal + 1) / 10)}.${(ordinal + 1) % 10}`;
    assert.equal(nextReleaseVersion(current), next);
    const before = parseReleaseVersion(current).buildVersion.split('.').map(Number);
    const after = parseReleaseVersion(next).buildVersion.split('.').map(Number);
    const changed = before.findIndex((part, index) => part !== after[index]);
    assert.ok(after[changed] > before[changed], `${current} → ${next} must increase the installer version`);
  }
});

test('stable release digits carry without losing precision in the leading number', () => {
  for (const [version, next] of [['1.0.0', '1.0.1'], ['1.0.9', '1.1.0'], ['1.9.9', '2.0.0'],
    ['9.9.9', '10.0.0'], ['9007199254740992.9.9', '9007199254740993.0.0']]) {
    assert.equal(nextReleaseVersion(version), next);
  }
});
