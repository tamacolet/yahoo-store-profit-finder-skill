// 外部スキル（Phi操作・買取スキャナ）の置き場所。環境変数で差し替えられる。

import { homedir } from 'node:os'
import { join } from 'node:path'

const SKILLS_DIR = join(homedir(), '.claude/skills')

export const PHI_SHADOW_PATH =
  process.env.PHI_SHADOW_PATH || join(SKILLS_DIR, 'phi-browser/lib/phi-shadow.mjs')
export const KAITORI_SCANNER_PATH =
  process.env.KAITORI_SCANNER_PATH || join(SKILLS_DIR, 'kaitori-app/scripts/kaitori-scanner.mjs')
