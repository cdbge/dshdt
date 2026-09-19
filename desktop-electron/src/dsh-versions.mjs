// dsh-versions.mjs — bundles 锁定的 DSH 版本（唯一一份，构建脚本共用）。
// 三者必须同进同退；改动后需重建 vendor 树（npm run build:host）。
export const VERSIONS = {
  '@deepseek-ai/dsh': '0.1.6-alpha.1',
  '@deepseek-ai/dsh-base': '0.1.6-alpha.1',
  '@deepseek-ai/dsh-web-app': '0.1.6-alpha.1',
}
