// 临时工具：用真实代码路径把仓库文件（含壳源码）更新到本机 DSH_HOME，并打好待换的 app.asar
import fs from 'node:fs'
import path from 'node:path'
import { runRepoUpdate, readState, stateFilePath } from '../src/repo-update.mjs'
import { buildPatchedAsar } from '../src/shell-update.mjs'
import { parseAsar } from '../src/asar-patch.mjs'

const home = process.env.DSH_HOME
const resourcesPath = process.env.DSH_RES
const coords = { owner: 'cdbge', repo: 'dshdt', ref: process.env.DSH_REPO_REF ?? 'main' }
const log = (m) => console.log(m)

const r = await runRepoUpdate({ home, coords, profileName: 'web', log })
console.log('=== runRepoUpdate ===')
console.log(JSON.stringify({
  ok: r.ok, ref: r.ref, error: r.error ?? null,
  summary: r.plan?.summary ?? null,
  components: (r.plan?.components ?? []).map((c) => ({ id: c.id, kind: c.kind, upToDate: c.upToDate, missing: c.missing.length, changed: c.changed.length, remove: c.remove.length })),
  results: r.results.map((x) => ({ id: x.id, ok: x.ok, skipped: x.skipped ?? false, written: x.written?.length ?? 0, removed: x.removed?.length ?? 0, error: x.error ?? null })),
}, null, 2))

const st = readState(home)
console.log('=== ledger ===', stateFilePath(home))
console.log(Object.entries(st.components ?? {}).map(([id, v]) => `${id}: ${v.files?.length ?? 0} files @ ${v.appliedAt}`).join('\n'))

const shellFiles = (st.components?.shell?.files ?? []).map((f) => f.path)
console.log('=== shell staged files ===', shellFiles.length)
const built = buildPatchedAsar({ home, resourcesPath, files: shellFiles, log })
console.log('=== buildPatchedAsar ===', JSON.stringify({ ok: built.ok, error: built.error ?? null, stagedAsar: built.stagedAsar ?? null, written: built.written?.length ?? 0, bytes: built.bytes ?? 0 }))

if (built.ok) {
  const buf = fs.readFileSync(built.stagedAsar)
  const asar = parseAsar(buf)
  const names = []
  const walk = (node, prefix) => { for (const [k, v] of Object.entries(node.files || {})) { if (v.files) walk(v, `${prefix}${k}/`); else names.push(prefix + k) } }
  walk(asar.header, '')
  const pkgEntry = asar.header.files['package.json']
  const off = asar.dataStart + Number(pkgEntry.offset)
  const pkg = JSON.parse(buf.subarray(off, off + pkgEntry.size).toString('utf8'))
  console.log('=== staged asar ===')
  console.log(JSON.stringify({
    entries: names.length,
    version: pkg.version,
    main: pkg.main,
    deps: pkg.dependencies ?? null,
    hasRepoUpdate: names.includes('src/repo-update.mjs'),
    hasShellUpdate: names.includes('src/shell-update.mjs'),
    hasAsarPatch: names.includes('src/asar-patch.mjs'),
    srcCount: names.filter((n) => n.startsWith('src/')).length,
    stagedAt: path.join(home, 'repo-updates', 'shell-swap', 'app.asar.new'),
    size: buf.length,
  }, null, 2))
}
