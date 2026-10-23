import test from 'node:test'
import assert from 'node:assert/strict'
import plugin from './index.mjs'

const realFetch = globalThis.fetch

async function simulateLogin(t, upstream) {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(new URL(url).searchParams.get('functionId'), 'joycode_userInfo')
    assert.equal(init.headers.ptkey, 'test-ticket')
    assert.equal(init.headers.tenant, 'tenant_test')
    return upstream()
  })
  const hooks = await plugin.server({})
  const flow = await hooks.auth.methods[0].authorize()
  const loginUrl = new URL(flow.url)
  const callbackUrl = new URL(`http://127.0.0.1:${loginUrl.searchParams.get('authPort')}/`)
  for (const name of ['authPort', 'authKey']) {
    callbackUrl.searchParams.set(name, loginUrl.searchParams.get(name))
  }
  callbackUrl.searchParams.set('pt_key', 'test-ticket')
  callbackUrl.searchParams.set('loginType', 'PIN_JD_CLOUD')
  callbackUrl.searchParams.set('tenant', 'tenant_test')
  const response = await realFetch(callbackUrl, { signal: AbortSignal.timeout(2000) })
  const html = await response.text()
  return {
    html,
    async result() {
      let timer
      try {
        return await Promise.race([
          flow.callback(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('login callback did not settle')), 500)
          }),
        ])
      } finally { clearTimeout(timer) }
    },
  }
}

test('gateway code 0 and data.userId complete browser login and provide loader credentials', async (t) => {
  const login = await simulateLogin(t, () => Response.json({
    code: 0, data: { userId: 'test-account', userName: 'Test Account', pk: 'private-marker' },
  }))
  assert.match(login.html, /登录成功/)
  assert.doesNotMatch(login.html, /private-marker|test-ticket/)
  const result = await login.result()
  assert.equal(result.type, 'success')
  assert.equal(result.key, 'test-ticket')
  assert.equal(result.accountId, 'Test Account')
  assert.equal(result.metadata.loginType, 'PIN_JD_CLOUD')
  assert.equal(result.metadata.tenant, 'tenant_test')
  const hooks = await plugin.server({})
  const loader = await hooks.auth.loader(async () => ({ ...result, type: 'api' }))
  assert.equal(typeof loader.fetch, 'function')
})

for (const [name, upstream] of [
  ['business failure despite HTTP 200', () => Response.json({ code: 7, data: { userId: 'test-account', pk: 'private-marker' } })],
  ['missing user identity', () => Response.json({ code: 0, data: { pk: 'private-marker' } })],
  ['non-JSON response', () => new Response('<script>private-marker</script>')],
  ['HTTP failure despite success body', () => Response.json({ code: 0, data: { userId: 'test-account' } }, { status: 401 })],
  ['network failure', () => { throw new Error('private-marker') }],
]) {
  test(`${name} settles as failed without exposing upstream data`, async (t) => {
    const login = await simulateLogin(t, upstream)
    assert.match(login.html, /登录失败/)
    assert.doesNotMatch(login.html, /private-marker|test-ticket/)
    const result = await login.result()
    assert.equal(result.type, 'failed')
    assert.doesNotMatch(result.error, /private-marker|test-ticket/)
  })
}
