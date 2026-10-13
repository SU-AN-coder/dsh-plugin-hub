/**
 * DSH-Plugin Hub — the community plugin marketplace for DeepSeek Harness.
 * Website: https://dsh-plugin.org
 * GitHub: https://github.com/dshplugin/dsh-plugin-hub
 *
 * 回归测试：分发文件解析（exports `./` 前缀、条件对象、main 回退、未声明入口，
 * 以及 dsh.bundle.patch 的字符串/数组两种写法）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requiredDistributionFiles, resolveBundlePatchFiles, resolvePackageEntry } from '../src/server/services/install/package-entry.ts'

test('resolvePackageEntry: strips the mandatory ./ prefix from exports string targets', () => {
  assert.equal(resolvePackageEntry({ exports: { '.': './lib/index.js' } }), 'lib/index.js')
  assert.equal(resolvePackageEntry({ exports: { '.': './lib/index.js' }, main: './other.js' }), 'lib/index.js')
})

test('resolvePackageEntry: reads condition objects via default/import/require', () => {
  assert.equal(resolvePackageEntry({ exports: { '.': { import: './lib/mjs.js', require: './lib/cjs.cjs' } } }), 'lib/mjs.js')
  assert.equal(resolvePackageEntry({ exports: { '.': { require: './lib/cjs.cjs' } } }), 'lib/cjs.cjs')
  assert.equal(resolvePackageEntry({ exports: { '.': { default: './lib/default.js', import: './lib/mjs.js' } } }), 'lib/default.js')
})

test('resolvePackageEntry: falls back to main when exports declares no root target', () => {
  assert.equal(resolvePackageEntry({ main: './lib/main.js' }), 'lib/main.js')
  assert.equal(resolvePackageEntry({ main: 'lib/main.js' }), 'lib/main.js')
})

test('resolvePackageEntry: a manifest that declares no entry has none', () => {
  assert.equal(resolvePackageEntry({}), null)
  assert.equal(resolvePackageEntry({ exports: { './sub': './sub.js' } }), null)
  assert.equal(resolvePackageEntry({ exports: { '.': { node: { import: './x.js' } } }, main: 42 }), null)
  assert.equal(resolvePackageEntry({ exports: ['./*'], main: null }), null)
})

test('resolveBundlePatchFiles: reads the string and the list form of dsh.bundle.patch', () => {
  assert.deepEqual(resolveBundlePatchFiles({ dsh: { bundle: { patch: './cordis.patch.yml' } } }), ['cordis.patch.yml'])
  assert.deepEqual(resolveBundlePatchFiles({ dsh: { bundle: { patch: ['./a.patch.yml', 'b.patch.yml'] } } }), ['a.patch.yml', 'b.patch.yml'])
  assert.deepEqual(resolveBundlePatchFiles({}), [])
  assert.deepEqual(resolveBundlePatchFiles({ dsh: {} }), [])
})

test('resolveBundlePatchFiles: a patch declaration that is not a path is left to dsh to reject', () => {
  assert.deepEqual(resolveBundlePatchFiles({ dsh: { bundle: { patch: 42 } } }), [])
  assert.deepEqual(resolveBundlePatchFiles({ dsh: { bundle: { patch: [{}, './a.yml', ''] } } }), ['a.yml'])
})

test('requiredDistributionFiles: the declared entry first, then the declared bundle patches', () => {
  assert.deepEqual(requiredDistributionFiles({}), [])
  assert.deepEqual(requiredDistributionFiles({ dsh: { bundle: { patch: './cordis.patch.yml' } } }), ['cordis.patch.yml'])
  assert.deepEqual(
    requiredDistributionFiles({ main: './lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    ['lib/index.js', 'cordis.patch.yml'],
  )
})
