import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, PromptSubmitInput, ToolCallInput } from 'claude-code'

import { redact } from '../hooks/register'

// Fake values, built by concatenation so secret scanners leave this file alone.
const JWT = 'eyJhbGciOiJIUzI1NiJ9' + '.eyJzdWIiOiIxMjM0NTY3ODkwIn0' + '.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
const GHP = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
const AKIA = 'AKIA' + 'IOSFODNN7EXAMPLE'
const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG' + '/bPxRfiCYEXAMPLEKEY'
const DB_PASS = 'S3cr3tPass'
const ROOT_PASS = 'hunter2Hunter'
const SESSION = '9f86d081884c7d659a2f' + 'eaa0c55ad015'
const GH_SESS = 'abcdefABCDEF' + '0123456789xyz'
const SLACK = 'xoxb-' + '123456789012-abcdefghij'
const SK = 'sk-ant-' + 'api03-abcdefghijklmnopqrstuv'

const PROMPT = [
  `curl -H "Authorization: Bearer ${JWT}" https://api.example.com`,
  `gh token is ${GHP}`,
  `aws_access_key_id = ${AKIA}`,
  `aws_secret_access_key = ${AWS_SECRET}`,
  `DATABASE_URL=postgres://app:${DB_PASS}@db.internal:5432/app`,
  `ssh root@10.0.0.4 password: ${ROOT_PASS}`,
  `session_id=${SESSION}`,
  `Cookie: _gh_sess=${GH_SESS}; theme=dark`,
  `SLACK=${SLACK} ANTHROPIC=${SK}`,
].join('\n')

const SECRETS = [JWT, GHP, AKIA, AWS_SECRET, DB_PASS, ROOT_PASS, SESSION, GH_SESS, SLACK, SK]

const submit = (text: string): PromptSubmitInput => ({ text, wait: false, origin: { kind: 'composer' } })

// Stands in for the engine beneath the plugin: records what reached it.
function engine(on: On) {
  const prompts: PromptSubmitInput[] = []
  const calls: ToolCallInput[] = []
  const status: (string | undefined)[] = []
  let output = ''
  let isError = false

  on('prompt.submit', ($, e) => {
    prompts.push(e)
    return { text: e.text, context: e.context }
  })
  on('ui.status', ($, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  on('tool.call', ($, e) => {
    calls.push(e)
    return isError
      ? { isError: true as const, result: output, text: output }
      : { result: { stdout: output, stderr: '', interrupted: false }, text: output }
  })
  return {
    prompts,
    calls,
    status,
    answer: (text: string, asError = false) => {
      output = text
      isError = asError
    },
  }
}

describe('secret-vault', () => {
  test('every kind of pasted secret becomes a placeholder', () => {
    const { text, vault } = redact(PROMPT, { entries: [], issued: 0 })
    for (const secret of SECRETS) {
      expect(text).not.toContain(secret)
    }
    expect(vault.entries.map(e => e.kind)).toEqual([
      'jwt', 'github', 'aws-key-id', 'aws-secret', 'slack', 'api-key', 'url-password', 'password', 'token', 'cookie',
    ])
    expect(text).toContain('Bearer ⟨secret:1⟩')
    expect(text).toContain('postgres://app:⟨secret:7⟩@db.internal')
    expect(text).toContain('theme=dark')
  })

  test('ordinary text is left alone', () => {
    const plain = 'the password field is empty; see https://example.com/a and run pnpm test --filter api'
    expect(redact(plain, { entries: [], issued: 0 }).hits).toBe(0)
  })

  test('the model gets placeholders, a note on how to use them, and the status line counts them', async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(submit(PROMPT))

    const sent = seen.prompts[0]
    for (const secret of SECRETS) {
      expect(sent?.text).not.toContain(secret)
    }
    expect(sent?.context?.[0]).toContain('⟨secret:N⟩')
    expect(seen.status.at(-1)).toBe('vault: 10 secrets')
  })

  test('a value keeps its placeholder, even typed bare in a later prompt', async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(submit(`password=${ROOT_PASS}`))
    await $.prompt.submit(submit(`try ${ROOT_PASS} again`))

    expect(seen.prompts[0]?.text).toBe('password=⟨secret:1⟩')
    expect(seen.prompts[1]?.text).toBe('try ⟨secret:1⟩ again')
    expect(seen.status.at(-1)).toBe('vault: 1 secret')
  })

  test('a prompt with no secret passes untouched', async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(submit('fix the failing test'))
    expect(seen.prompts[0]?.text).toBe('fix the failing test')
    expect(seen.prompts[0]?.context).toBeUndefined()
  })

  test('Bash runs with the real value and its output comes back masked', async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(submit(`token: Bearer ${JWT}`))

    seen.answer(`{"auth":"${JWT}","ok":true}`)
    const ran = await $.tool.call({ tool: 'Bash', command: 'curl -H "Authorization: Bearer ⟨secret:1⟩" https://x' })

    expect(seen.calls[0]).toMatchObject({ command: `curl -H "Authorization: Bearer ${JWT}" https://x` })
    expect(JSON.stringify(ran)).not.toContain(JWT)
    expect(JSON.stringify(ran.result)).toContain('⟨secret:1⟩')
  })

  test('an errored result is masked too', async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(submit(`gh is ${GHP}`))

    seen.answer(`Exit code 1\nbad credentials for ${GHP}`, true)
    const ran = await $.tool.call({ tool: 'Bash', command: 'GH_TOKEN=⟨secret:1⟩ gh api user' })

    expect(seen.calls[0]).toMatchObject({ command: `GH_TOKEN=${GHP} gh api user` })
    expect(ran.isError).toBe(true)
    expect(ran.text).toBe('Exit code 1\nbad credentials for ⟨secret:1⟩')
  })

  test('file and agent tools keep the placeholder literal', async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(submit(`gh is ${GHP}`))
    seen.answer('ok')

    await $.tool.call({ tool: 'Write', file_path: '/tmp/brief.md', content: 'token: ⟨secret:1⟩' })
    expect(seen.calls[0]).toMatchObject({ content: 'token: ⟨secret:1⟩' })
  })

  test('a stored row has real values masked', async ($, on) => {
    engine(on)
    const session = mock.session(on)
    await $.prompt.submit(submit(`gh is ${GHP}`))

    await $.session.append({
      message: {
        type: 'user',
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: [{ type: 'text', text: `token ${GHP}` }] }],
      },
      door: 'tool-result',
      origin: { kind: 'tool', tool: 'Read' },
      uuid: 'row-1',
    })

    const row = session.appended().find(r => r.uuid === 'row-1')
    expect(JSON.stringify(row?.message.content)).not.toContain(GHP)
    expect(JSON.stringify(row?.message.content)).toContain('⟨secret:1⟩')
  })

  test('the system prompt explains placeholders only while the vault holds one', async ($, on) => {
    engine(on)
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))
    const compose = { model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] }

    expect((await $.prompt.compose(compose)).sections.map(s => s.id)).toEqual(['intro'])
    await $.prompt.submit(submit(`gh is ${GHP}`))
    expect((await $.prompt.compose(compose)).sections.map(s => s.id)).toEqual(['intro', 'secret-vault:placeholders'])
  })

  test('/vault lists placeholders with a masked hint and clears them', async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(submit(`gh is ${GHP}\npwd=Tr0ub4dor`))
    const run = (args: string) =>
      $.command.run({ command: 'vault', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

    const listed = (await run('list')).text ?? ''
    expect(listed).toContain('⟨secret:1⟩  github')
    expect(listed).toContain('ghp_… (40 chars)')
    expect(listed).toContain('⟨secret:2⟩  password')
    expect(listed).not.toContain(GHP)
    expect(listed).toContain('⟨secret:2⟩  password      … (9 chars)')
    expect(listed).not.toContain('Tr0u')

    await run('clear')
    expect((await run('')).text).toBe('The vault is empty.')
    expect(seen.status.at(-1)).toBeUndefined()

    await $.prompt.submit(submit(`again ${SLACK}`))
    expect(seen.prompts.at(-1)?.text).toBe('again ⟨secret:3⟩')
  })
})
