import { execFileSync } from 'node:child_process'

// Tests run the CLI from dist/, so build it first to test what gets published
export default function setup() {
  execFileSync('pnpm', ['build'], { stdio: 'inherit' })
}
