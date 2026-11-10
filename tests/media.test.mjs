import assert from 'node:assert/strict'
import { createCipheriv, randomBytes } from 'node:crypto'
import test from 'node:test'

import { _testing } from '../plugins/reading-inbox/wechat.js'

const { attachmentOf, decodeKey, decryptEcb } = _testing

function item(type, holderName, extra = {}) {
  return {
    type,
    [holderName]: {
      file_name: 'invoice.pdf',
      len: '2048',
      media: {
        encrypt_query_param: 'abc123',
        aes_key: Buffer.from('0123456789abcdef0123456789abcdef').toString('base64'),
      },
      ...extra,
    },
  }
}

test('a file item exposes a downloadable reference with its own key', () => {
  const ref = attachmentOf(item(4, 'file_item'))
  assert.equal(ref.kind, 'file')
  assert.equal(ref.name, 'invoice.pdf')
  assert.equal(ref.bytes, 2048)
  assert.ok(ref.aesKey)
  assert.equal(ref.media.encrypt_query_param, 'abc123')
})

test('an image prefers its own aeskey over the generic media key', () => {
  const ref = attachmentOf({
    type: 2,
    image_item: {
      aeskey: 'ffeeddccbbaa99887766554433221100',
      media: { encrypt_query_param: 'x', aes_key: 'generic' },
    },
  })
  assert.equal(ref.kind, 'image')
  assert.equal(ref.aesKey, 'ffeeddccbbaa99887766554433221100')
})

test('items without a media reference are ignored instead of throwing', () => {
  assert.equal(attachmentOf({ type: 1, text_item: { text: 'hi' } }), null)
  assert.equal(attachmentOf({ type: 4, file_item: { file_name: 'x.pdf' } }), null)
})

test('keys decode from base64 of raw bytes and base64 of a hex string', () => {
  const raw = Buffer.from('0123456789abcdef')
  assert.deepEqual(decodeKey(raw.toString('base64')), raw)
  // The hex form carries the key as 32 characters, i.e. 16 bytes once decoded.
  const hex = '0123456789abcdef0123456789abcdef'
  assert.deepEqual(decodeKey(Buffer.from(hex).toString('base64')), Buffer.from(hex, 'hex'))
  assert.equal(decodeKey(''), null)
  assert.equal(decodeKey('not-a-key'), null)
})

test('payloads decrypt as AES-128-ECB with PKCS#7 padding', () => {
  const key = randomBytes(16)
  const plain = Buffer.from('发票金额 128.00 元，行程 2026-11-10', 'utf8')
  const cipher = createCipheriv('aes-128-ecb', key, null)
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
  assert.deepEqual(decryptEcb(encrypted, key), plain)
})
