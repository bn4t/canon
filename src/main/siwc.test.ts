import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { verifyIDToken, SIWC, type Jwk } from './siwc.ts'

test('verifyIDToken: RS256 and ES256, rejects bad claims and signatures', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const keys = [{ ...rsa.publicKey.export({ format: 'jwk' }), kid: 'r1' }, { ...ec.publicKey.export({ format: 'jwk' }), kid: 'e1' }] as Jwk[]
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const mint = (claims: object, alg = 'RS256') => {
    const input = b64({ alg, kid: alg === 'RS256' ? 'r1' : 'e1' }) + '.' + b64(claims)
    const sig = alg === 'RS256' ? sign('sha256', Buffer.from(input), rsa.privateKey) : sign('sha256', Buffer.from(input), { key: ec.privateKey, dsaEncoding: 'ieee-p1363' })
    return input + '.' + sig.toString('base64url')
  }
  const exp = Math.floor(Date.now() / 1000) + 3600
  const good = { iss: SIWC.issuer, aud: ['oaiapp_x'], exp, nonce: 'n1' }
  verifyIDToken(keys, mint(good), 'oaiapp_x', 'n1')
  verifyIDToken(keys, mint({ ...good, aud: 'oaiapp_x' }, 'ES256'), 'oaiapp_x', 'n1')
  const bad: Record<string, object> = {
    issuer: { ...good, iss: 'https://evil' }, audience: { ...good, aud: 'oaiapp_other' },
    expired: { ...good, exp: exp - 7200 }, nonce: { ...good, nonce: 'other' },
  }
  for (const [name, c] of Object.entries(bad)) assert.throws(() => verifyIDToken(keys, mint(c), 'oaiapp_x', 'n1'), Error, name)
  const t = mint(good)
  assert.throws(() => verifyIDToken(keys, t.slice(0, -4) + 'AAAA', 'oaiapp_x', 'n1'), /signature/)
  assert.throws(() => verifyIDToken(keys, 'x.y', 'oaiapp_x', 'n1'), /malformed/)
})
