#!/usr/bin/env node
// Verwaltung der Vermittlung: einrichten | status | neustart | stopp
import { readFileSync, writeFileSync, existsSync, chmodSync, openSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'

const HIER = dirname(fileURLToPath(import.meta.url))
const DIR = process.env.VERMITTLUNG_DIR ?? join(homedir(), '.claude', 'vermittlung')
const PORT = Number(process.env.VERMITTLUNG_PORT ?? 47823)
const API = process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org'
const ZUGANG = join(DIR, 'zugang.json')

const warte = ms => new Promise(r => setTimeout(r, ms))
const gesund = async () => { try { return await (await fetch(`http://127.0.0.1:${PORT}/gesund`)).json() } catch { return null } }

function verdeckt(frage) {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    rl._writeToOutput = s => { if (s.startsWith(frage)) process.stdout.write(s) }
    rl.question(frage, antwort => { rl.close(); process.stdout.write('\n'); resolve(antwort.trim()) })
  })
}

async function stoppen() {
  try {
    const pid = Number(readFileSync(join(DIR, 'daemon.pid'), 'utf8'))
    const { execFileSync } = await import('node:child_process')
    const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' })
    if (cmd.includes('daemon.mjs')) process.kill(pid, 'SIGTERM')
  } catch {}
  for (let i = 0; i < 30 && (await gesund()); i++) await warte(100)
}

async function starten() {
  const log = openSync(join(DIR, 'daemon.out'), 'a')
  spawn(process.execPath, [join(HIER, 'daemon.mjs')], { detached: true, stdio: ['ignore', log, log] }).unref()
  for (let i = 0; i < 50 && !(await gesund()); i++) await warte(100)
}

async function einrichten() {
  console.log('Vermittlung einrichten\n')
  console.log('1. In Telegram @BotFather öffnen, /newbot senden, Namen vergeben.')
  console.log('2. Den Token, den BotFather schickt, hier einfügen (wird nicht angezeigt).\n')
  const token = await verdeckt('Bot-Token: ')
  const me = await (await fetch(`${API}/bot${token}/getMe`)).json().catch(() => ({}))
  if (!me.ok) { console.error('Token ungültig – Telegram kennt ihn nicht.'); process.exit(1) }
  writeFileSync(join(DIR, '.env'), `TELEGRAM_BOT_TOKEN=${token}\n`)
  chmodSync(join(DIR, '.env'), 0o600)
  rmSync(ZUGANG, { force: true })
  await stoppen()
  await starten()
  let code
  for (let i = 0; i < 50 && !code; i++) { try { code = JSON.parse(readFileSync(ZUGANG, 'utf8')).code } catch {} ; if (!code) await warte(100) }
  console.log(`\n3. Schick deinem Bot @${me.result.username} in Telegram genau diese Nachricht: ${code}\n`)
  for (let i = 0; i < 300; i++) {
    try { if (JSON.parse(readFileSync(ZUGANG, 'utf8')).user_id) { console.log('✅ Gekoppelt. Fertig.'); return } } catch {}
    await warte(1000)
  }
  console.log('Noch nicht gekoppelt. Schick den Code später; „node vermittlung.mjs status“ zeigt den Stand.')
}

async function status() {
  const g = await gesund()
  if (!g) return console.log('Vermittlung läuft nicht (startet automatisch mit der ersten Session).')
  console.log(`läuft · Telegram ${g.telegram ? 'an' : 'aus (kein Token)'} · ${g.gekoppelt ? 'gekoppelt' : 'nicht gekoppelt'}`)
  const geheim = readFileSync(join(DIR, 'geheim'), 'utf8').trim()
  const s = await (await fetch(`http://127.0.0.1:${PORT}/status`, { headers: { 'x-geheim': geheim } })).json()
  console.log(`im Gespräch: ${s.aktiv ?? '–'} · Schlange: ${s.schlange.join(', ') || '–'}${s.pause ? ' · Pause' : ''}`)
  for (const x of s.sessions) console.log(`  ${x.ticket}  ${x.cwd}`)
}

const befehl = process.argv[2]
if (befehl === 'einrichten') await einrichten()
else if (befehl === 'status') await status()
else if (befehl === 'neustart') { await stoppen(); await starten(); await status() }
else if (befehl === 'stopp') { await stoppen(); console.log('gestoppt') }
else console.log('node vermittlung.mjs einrichten | status | neustart | stopp')
process.exit(0)
