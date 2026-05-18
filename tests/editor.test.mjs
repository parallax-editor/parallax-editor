import { SCHEMA_VERSION } from 'parallax-engine/schema'
import assert from 'node:assert'

assert.strictEqual(SCHEMA_VERSION, '1.0', 'SCHEMA_VERSION mismatch')
console.log('✓ editor smoke test passed — SCHEMA_VERSION:', SCHEMA_VERSION)
