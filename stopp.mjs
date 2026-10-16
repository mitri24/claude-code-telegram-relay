#!/usr/bin/env node
// Stop-Hook der Vermittlungs-Sessions: meldet der Vermittlung, dass die Session ihren Zug beendet hat.
// Sie entscheidet, ob die Session sich bei der Nutzerin melden soll (Warteschlange).
import { readFileSync, existsSync, openSync, readSync, fstatSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DIR = process.env.VERMITTLUNG_DIR ?? join(homedir(), '.claude', 'vermittlung')
const PORT = Number(process.env.VERMITTLUNG_PORT ?? 47823)

function ende(pfad, bytes = 512 * 1024) {
  const fd = openSync(pfad, 'r')
  try {
    const groesse = fstatSync(fd).size
    const laenge = Math.min(groesse, bytes)
    const puffer = Buffer.alloc(laenge)
    readSync(fd, puffer, 0, laenge, groesse - laenge)
    return puffer.toString('utf8')
  } finally { closeSync(fd) }
}

// Letzte echte Eingabe (keine Tool-Ergebnisse): wer hat den Zug ausgelöst, und wann?
function ausloeser(transcript) {
  const zeilen = ende(transcript).split('\n').reverse()
  for (const zeile of zeilen) {
    let e
    try { e = JSON.parse(zeile) } catch { continue }
    let text = ''
    if (e.type === 'user') {
      const c = e.message?.content
      text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(t => t.type === 'text').map(t => t.text).join('\n') : ''
      if (e.isMeta && !text.includes('<channel')) continue
    } else if (e.type === 'attachment' && e.attachment?.type === 'queued_command') {
      text = String(e.attachment.prompt ?? '') // Eingabe, die mitten im Zug ankam
    }
    if (!text) continue
    const kanal = /<channel source="(?:server:)?vermittlung[\w-]*"[^>]*\bart="([a-z_]+)"/.exec(text)
    const art = kanal ? kanal[1] : text.trimStart().startsWith('<channel') ? 'andere' : 'lokal'
    return { ausloeser: art, dauer: (Date.now() - Date.parse(e.timestamp)) / 1000 }
  }
  return { ausloeser: 'unbekannt', dauer: 0 }
}

try {
  const eingabe = JSON.parse(readFileSync(0, 'utf8'))
  if (!eingabe.cwd || eingabe.stop_hook_active) process.exit(0)
  const info = eingabe.transcript_path && existsSync(eingabe.transcript_path) ? ausloeser(eingabe.transcript_path) : { ausloeser: 'unbekannt', dauer: 0 }
  const geheim = readFileSync(join(DIR, 'geheim'), 'utf8').trim()
  await fetch(`http://127.0.0.1:${PORT}/stopp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-geheim': geheim },
    body: JSON.stringify({ cwd: process.env.CLAUDE_PROJECT_DIR ?? eingabe.cwd, ...info }),
    signal: AbortSignal.timeout(1500),
  })
} catch {}
process.exit(0)
