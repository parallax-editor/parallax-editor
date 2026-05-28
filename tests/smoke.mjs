import { SCHEMA_VERSION, validateSite } from '@parallax-editor/parallax-engine/schema'
import assert from 'node:assert'

assert.strictEqual(SCHEMA_VERSION, '1.0', 'SCHEMA_VERSION mismatch')

const result = validateSite({
  schemaVersion: '1.0',
  meta: { title: 'Smoke test' },
  sections: [],
})
assert.strictEqual(result.ok, true, 'validateSite should pass for minimal site')

console.log('✓ smoke test passed — SCHEMA_VERSION:', SCHEMA_VERSION)
