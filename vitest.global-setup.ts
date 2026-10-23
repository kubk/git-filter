import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

// Tests run the CLI from dist/, so build it first to test what gets published
export default function setup() {
  execFileSync('pnpm', ['build'], { stdio: 'inherit' })
  // Tests create their git repos, configs and logs here
  fs.mkdirSync('fixtures', { recursive: true })
}
