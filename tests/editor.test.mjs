import { SCHEMA_VERSION } from 'parallax-engine/schema'
import assert from 'node:assert'

// Engine shipped schema v1.1 (independent desktop/mobile views, additive &
// backward-compat). The editor links the built engine, so this tracks it.
assert.strictEqual(SCHEMA_VERSION, '1.1', 'SCHEMA_VERSION mismatch')
console.log('✓ editor smoke test passed — SCHEMA_VERSION:', SCHEMA_VERSION)
