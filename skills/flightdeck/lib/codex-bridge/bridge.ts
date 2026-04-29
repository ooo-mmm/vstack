#!/usr/bin/env bun
// Vendored minimal JSON-RPC over WebSocket client for codex app-server.
// Phase 4 of flightdeck unified-comms migration.
//
// One codex app-server (`codex app-server --listen ws://127.0.0.1:<PORT>`)
// per flightdeck session; each per-pane `codex --remote ws://...` TUI
// becomes a "loaded thread". This client connects to the same WS and
// drives the threads via JSON-RPC.
//
// Subcommands:
//   list                            thread/loaded/list — print thread ids
//   state    --thread <id>          thread/read — metadata
//   turns    --thread <id>          thread/turns/list — content
//   send     --thread <id> -- <msg> turn/start — enqueue user message
//   steer    --thread <id> --expected-turn <tid> -- <msg>
//                                   turn/steer — mid-flight steer
//   interrupt --thread <id>          turn/interrupt — hard stop
//   stream                          subscribe + emit notifications JSONL
//
// Requires --url ws://host:port for every subcommand.

const argv = process.argv.slice(2)
const subcmd = argv[0]

function parseFlags(rest: string[]): { url?: string; thread?: string; expected?: string; message?: string } {
  const out: any = {}
  let positional: string[] = []
  let sawDoubleDash = false
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (sawDoubleDash) { positional.push(a); continue }
    if (a === '--') { sawDoubleDash = true; continue }
    if (a === '--url')           out.url = rest[++i]
    else if (a === '--thread')   out.thread = rest[++i]
    else if (a === '--expected-turn') out.expected = rest[++i]
    else if (a === '--message')  out.message = rest[++i]
    else positional.push(a)
  }
  if (positional.length > 0 && !out.message) out.message = positional.join(' ')
  return out
}

const flags = parseFlags(argv.slice(1))
if (!flags.url) {
  console.error('codex-bridge: --url ws://host:port required')
  process.exit(2)
}

const TIMEOUT_MS = Number(process.env.FD_CODEX_RPC_TIMEOUT_MS ?? 30000)

let ws: WebSocket
let nextId = 1
const pending = new Map<number, { resolve: (m: any) => void; reject: (e: any) => void; timer: any }>()

async function connect(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    ws = new WebSocket(flags.url!)
    let opened = false
    ws.onopen = () => { opened = true; resolve() }
    ws.onmessage = (ev) => handleMessage(ev.data)
    ws.onerror = (e) => { if (!opened) reject(e) }
    ws.onclose = () => {
      // Reject pending RPCs on close
      for (const [, p] of pending) {
        clearTimeout(p.timer)
        p.reject(new Error('ws closed'))
      }
      pending.clear()
      if (subcmd === 'stream') process.exit(0)
    }
  })
}

function handleMessage(raw: string | Buffer): void {
  let msg: any
  try { msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString()) }
  catch { return }
  if (msg.id != null && pending.has(msg.id)) {
    const p = pending.get(msg.id)!
    pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.error) p.reject(msg.error)
    else p.resolve(msg.result)
  } else {
    // Notification — emit JSONL on stream subcommand only
    if (subcmd === 'stream') {
      console.log(JSON.stringify(msg))
    }
  }
}

function rpc(method: string, params: any): Promise<any> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`RPC ${method} timeout after ${TIMEOUT_MS}ms`))
    }, TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    ws.send(JSON.stringify({ jsonrpc: '2.0', method, params, id }))
  })
}

await connect()

// initialize handshake — codex app-server expects this first.
try {
  await rpc('initialize', {
    capabilities: {},
    clientInfo: { name: 'flightdeck-codex-bridge', version: '0.0.1' },
  })
} catch (e) {
  console.error(`codex-bridge: initialize failed: ${e}`)
  process.exit(1)
}

try {
  switch (subcmd) {
    case 'list': {
      const r = await rpc('thread/loaded/list', {})
      console.log(JSON.stringify(r))
      break
    }
    case 'state': {
      if (!flags.thread) throw new Error('--thread required')
      const r = await rpc('thread/read', { threadId: flags.thread })
      console.log(JSON.stringify(r))
      break
    }
    case 'turns': {
      if (!flags.thread) throw new Error('--thread required')
      const r = await rpc('thread/turns/list', { threadId: flags.thread })
      console.log(JSON.stringify(r))
      break
    }
    case 'send': {
      if (!flags.thread || !flags.message) throw new Error('--thread and message required')
      const r = await rpc('turn/start', {
        threadId: flags.thread,
        input: [{ type: 'text', text: flags.message }],
      })
      console.log(JSON.stringify(r))
      break
    }
    case 'steer': {
      if (!flags.thread || !flags.expected || !flags.message) throw new Error('--thread, --expected-turn, and message required')
      const r = await rpc('turn/steer', {
        threadId: flags.thread,
        expectedTurnId: flags.expected,
        input: [{ type: 'text', text: flags.message }],
      })
      console.log(JSON.stringify(r))
      break
    }
    case 'interrupt': {
      if (!flags.thread) throw new Error('--thread required')
      const r = await rpc('turn/interrupt', { threadId: flags.thread })
      console.log(JSON.stringify(r))
      break
    }
    case 'stream': {
      // Notifications stream until ws closes (handled in onclose).
      await new Promise(() => {})
      break
    }
    default:
      console.error(`codex-bridge: unknown subcommand: ${subcmd}`)
      process.exit(2)
  }
} catch (e: any) {
  console.error(`codex-bridge: ${subcmd} failed: ${e?.message ?? e}`)
  process.exit(1)
}

ws.close()
process.exit(0)
