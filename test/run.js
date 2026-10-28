/**
 * 进程内测试运行器（worker 线程做文件级隔离）。
 *
 * Node 20+ 的 `node --test test/` 会为每个测试文件 spawn 一个子进程做隔离，
 * 受限沙箱拦截 child_process.spawn 后返回 EPERM。本脚本改为每个 *.test.js
 * 起一个 worker 线程：worker 内 import 该文件，node:test 会正常排队执行，
 * 失败时线程以非 0 退出码结束。worker 之间模块注册表与 process.env 相互
 * 独立，因此测试文件各自设置的 DSH_HOME 不会串到别的文件里。
 */
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

const here = dirname(fileURLToPath(import.meta.url))
const files = readdirSync(here).filter((f) => f.endsWith('.test.js')).sort()
if (files.length === 0) {
  console.error('test/run.js: 没有找到 *.test.js 文件')
  process.exit(1)
}

// eval 模式下的代码是 CommonJS，用动态 import 加载 ESM 测试文件。
// node:test 在 worker 内跑完整套用例后线程自然退出，失败时退出码为 1。
const WORKER_SRC = `
const { workerData } = require('node:worker_threads')
import(workerData.file).catch((err) => {
  console.error(err && err.stack ? err.stack : String(err))
  process.exit(1)
})
`

let failed = 0
for (const file of files) {
  console.log(`\n== ${file} ==`)
  const code = await new Promise((resolve) => {
    const worker = new Worker(WORKER_SRC, {
      eval: true,
      workerData: { file: pathToFileURL(join(here, file)).href },
    })
    let settled = false
    const finish = (c) => {
      if (settled) return
      settled = true
      resolve(c)
    }
    worker.on('error', (err) => {
      console.error(err && err.stack ? err.stack : String(err))
      finish(1)
    })
    worker.on('exit', (c) => finish(c))
  })
  if (code !== 0) failed += 1
}

if (failed > 0) {
  console.error(`\n${failed} 个测试文件失败`)
  process.exit(1)
}
console.log('\n全部测试文件通过')
