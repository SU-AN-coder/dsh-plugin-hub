/**
 * DSH Plugin Hub — the community plugin marketplace for DeepSeek Harness.
 * Website: https://dsh-plugin.org
 * GitHub: https://github.com/dshplugin/dsh-plugin-hub
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { missingDistributionFileOfTarList, rootPackageEntryOfTarList } from '../src/server/services/install/preflight.ts'

test('rootPackageEntryOfTarList: finds the root manifest in GitHub codeload layout', () => {
  const listing = [
    'repo-deadbeef/',
    'repo-deadbeef/README.md',
    'repo-deadbeef/package.json',
    'repo-deadbeef/packages/helper/package.json',
  ].join('\n')
  assert.equal(rootPackageEntryOfTarList(listing), 'repo-deadbeef/package.json')
})

test('rootPackageEntryOfTarList: rejects ambiguous or missing archive roots', () => {
  assert.equal(rootPackageEntryOfTarList('repo-a/package.json\nrepo-b/package.json\n'), null)
  assert.equal(rootPackageEntryOfTarList('repo-a/packages/helper/package.json\n'), null)
})

test('missingDistributionFileOfTarList: reports the first declared file the distribution lacks', () => {
  const listing = ['repo-deadbeef/', 'repo-deadbeef/package.json', 'repo-deadbeef/cordis.patch.yml'].join('\n')
  assert.equal(missingDistributionFileOfTarList(listing, []), null)
  assert.equal(missingDistributionFileOfTarList(listing, ['repo-deadbeef/package.json']), null)
  assert.equal(missingDistributionFileOfTarList(listing, ['repo-deadbeef/cordis.patch.yml', 'repo-deadbeef/lib/index.js']), 'repo-deadbeef/lib/index.js')
  assert.equal(missingDistributionFileOfTarList(listing, ['repo-deadbeef/index.js']), 'repo-deadbeef/index.js')
})

test('missingDistributionFileOfTarList: an unreadable listing is treated as a missing file', () => {
  assert.equal(missingDistributionFileOfTarList(null, ['repo-deadbeef/lib/index.js']), 'repo-deadbeef/lib/index.js')
  assert.equal(missingDistributionFileOfTarList(null, []), null)
})
