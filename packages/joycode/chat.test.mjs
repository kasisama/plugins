import test from 'node:test'
import assert from 'node:assert/strict'
import plugin from './index.mjs'

async function request(t, response) {
  t.mock.method(globalThis, 'fetch', async url => new URL(url).searchParams.get('functionId') === 'joycode_userInfo'
    ? Response.json({ code: 0, data: { userId: 'test-user', tenant: 'test-tenant', orgFullName: 'test-org' } })
    : response)
  const hooks = await plugin.server({})
  const loader = await hooks.auth.loader(async () => ({ type: 'api', key: 'fake-key' }))
  return loader.fetch('https://api-ai.jd.com/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'JoyAI-Code-1.6', messages: [{ role: 'user', content: 'OK' }], stream: true }),
  })
}
function chunks(parts) {
  return new ReadableStream({ start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close() } })
}
test('HTTP 200 raw gateway denial becomes actionable error, not empty SSE', async t => {
  const r = await request(t, new Response(chunks([' {"error":', '{"code":"AI_GRAY_ACCESS_DENIED","message":"访问受限，请联系管理员开通"}}']), { headers: { 'content-type': 'text/event-stream' } }))
  assert.equal(r.status, 403)
  assert.equal(r.headers.get('x-magpie-sign-in'), 'kept')
  assert.equal((await r.json()).error.code, 'AI_GRAY_ACCESS_DENIED')
})
test('valid SSE including tool deltas is preserved byte for byte', async t => {
  const text = ': heartbeat\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n'
  const r = await request(t, new Response(chunks([text.slice(0,4), text.slice(4)]), { headers: { 'content-type': 'text/event-stream' } }))
  assert.equal(r.status, 200)
  assert.equal(await r.text(), text)
})
test('empty upstream success becomes gateway error', async t => {
  const r = await request(t, new Response('', { headers: { 'content-type': 'text/event-stream' } }))
  assert.equal(r.status, 502)
})
test('chat adds authenticated account metadata while preserving tools and messages', async t => {
  let infoCalls = 0
  const payload = { model: 'JoyAI-Code-1.6', messages: [{ role: 'user', content: 'OK' }], tools: [{ type: 'function', function: { name: 'ping', parameters: { type: 'object' } } }], stream: true, userId: 'untrusted-user' }
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (new URL(url).searchParams.get('functionId') === 'joycode_userInfo') {
      infoCalls++
      return Response.json({ code: 0, data: { userId: 'test-user', tenant: 'test-tenant', orgFullName: 'test-org' } })
    }
    const sent = JSON.parse(init.body)
    assert.equal(sent.userId, 'test-user')
    assert.equal(sent.tenant, 'test-tenant')
    assert.equal(sent.orgFullName, 'test-org')
    assert.equal(sent.language, 'UNKNOWN')
    assert.deepEqual(sent.messages, payload.messages)
    assert.deepEqual(sent.tools, payload.tools)
    assert.equal(init.headers.get('tenant'), 'test-tenant')
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  const hooks = await plugin.server({})
  const loader = await hooks.auth.loader(async () => ({ type: 'api', key: 'fake-key' }))
  for (let i = 0; i < 2; i++) {
    const r = await loader.fetch('https://api-ai.jd.com/v1/chat/completions', { method: 'POST', body: JSON.stringify(payload) })
    await r.text()
  }
  assert.equal(infoCalls, 1)
})

test('HTTP 403 permission denial is not marked as expired credentials', async t => {
  const r = await request(t, Response.json({ error: { code: 'AI_GRAY_ACCESS_DENIED', message: 'denied' } }, { status: 403 }))
  assert.equal(r.status, 403)
  assert.equal(r.headers.get('x-magpie-sign-in'), 'kept')
})
