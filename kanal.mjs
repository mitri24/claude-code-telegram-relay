#!/usr/bin/env node
// Kanal einer Claude-Code-Session zur Vermittlung (daemon.mjs).
// Start: claude --dangerously-load-development-channels server:vermittlung (siehe claude-ticket).
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { spawn } from 'node:child_process'
import { openSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HIER = dirname(fileURLToPath(import.meta.url))
const DIR = process.env.VERMITTLUNG_DIR ?? join(homedir(), '.claude', 'vermittlung')
const PORT = Number(process.env.VERMITTLUNG_PORT ?? 47823)
const BASIS = `http://127.0.0.1:${PORT}`
const CWD = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
// Nur in Sessions, die mit claude-ticket gestartet wurden; sonst bleibt der Kanal stumm.
const AKTIV = process.env.VERMITTLUNG_AKTIV === '1'
// Wie die Agenten die Person am anderen Ende nennen (Nominativ / Dativ) und welche Fachwörter sie kennen
const WER = process.env.VERMITTLUNG_NAME || 'die Nutzerin'
const WEM = process.env.VERMITTLUNG_NAME || 'der Nutzerin'
const Wer = WER[0].toUpperCase() + WER.slice(1)
const FACHBEGRIFFE = process.env.VERMITTLUNG_FACHBEGRIFFE || 'Fachbegriffe des Projekts, Ticketnummern'

const geheim = () => (existsSync(join(DIR, 'geheim')) ? readFileSync(join(DIR, 'geheim'), 'utf8').trim() : '')

async function api(pfad, body) {
  const res = await fetch(BASIS + pfad, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-geheim': geheim() },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}

async function laeuft() {
  try { return (await fetch(`${BASIS}/gesund`)).ok } catch { return false }
}

async function sicherstellen() {
  if (await laeuft()) return
  const log = openSync(join(DIR, 'daemon.out'), 'a')
  spawn(process.execPath, [join(HIER, 'daemon.mjs')], { detached: true, stdio: ['ignore', log, log], env: process.env }).unref()
  for (let i = 0; i < 50 && !(await laeuft()); i++) await new Promise(r => setTimeout(r, 100))
}

let sid = null
let ticket = '?'
async function anmelden() {
  await sicherstellen()
  const { json } = await api('/anmelden', { cwd: CWD })
  sid = json.sid
  ticket = json.ticket ?? ticket
}

const mcp = new Server(
  { name: 'vermittlung', version: '0.1.0' },
  {
    capabilities: {
      tools: {},
      experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
    },
    instructions: !AKTIV ? 'Inaktiv: Diese Session wurde nicht mit claude-ticket gestartet.' : [
      'Diese Session ist über die Vermittlung mit ' + WEM + ' auf Telegram verbunden. Sie sitzt oft nicht am Rechner: Was sie lesen soll, muss über das Tool `melden` gehen – deine Terminal-Ausgabe sieht sie dort nicht.',
      'Es gibt immer nur ein Gespräch gleichzeitig. `melden` stellt dich in die Warteschlange, falls gerade eine andere Session dran ist; deine Nachricht wird dann zugestellt, sobald du dran bist. Arbeite in der Zwischenzeit weiter oder beende deinen Zug.',
      'Auf jede Nachricht von ihr antwortest du zuerst und sofort über `melden` (kurz), erst dann arbeitest du weiter. Lange Befehle (Tests, Builds, Installationen) startest du im Hintergrund, damit du ansprechbar bleibst.',
      'Wann melden: sobald du fertig bist oder eine Entscheidung/Antwort von ihr brauchst. Erste Meldung eines Gesprächs: Ticket (Nummer + Titel), in 2–3 einfachen Sätzen worum es geht, dann genau deine Frage(n), nummeriert. Kurz, fürs Handy. Keine Kunden-, Patienten- oder Personendaten, keine Geheimnisse – Telegram ist nicht Ende-zu-Ende verschlüsselt. Bilder (z. B. Problem-Screenshots) nur als absolute Pfade in `bilder` – Bilder und PDFs dafür nie selbst öffnen oder lesen (spart Tokens). Die Spec schickt die Vermittlung automatisch als PDF mit, sobald sie sich geändert hat; nie selbst rendern. Bei der ersten Meldung `titel` mitgeben (kurzer Ticket-Titel), daraus wird der Name deines Ticket-Chats.',
      'Statt AskUserQuestion: Optionen nummeriert in `melden` anbieten; sie antwortet z. B. „Option 2“.',
      'Ihre Antworten kommen als <channel source="vermittlung" art="text|sprache">. art="sprache" ist maschinell transkribiert: offensichtliche Erkennungs- und Rechtschreibfehler still korrigieren (' + FACHBEGRIFFE + '). Vor dem Handeln die bereinigte Fassung kurz bestätigen („Verstanden: …“). Ist etwas mehrdeutig, nachfragen statt raten.',
      'Richtungsgebende Nachrichten von ihr (Ziel, Vermutung, Leitplanken, Wahl mit eigener Bedingung – nicht „ja“, „mach weiter“, „starte die Gegenanalyse“) gehören in die Spec: als `P#` mit Quelle „Telegram, Sprachnachricht/Text“, nur als `AI_SUMMARY` (welche Richtung sie vorgibt, in eigenen Worten) – nie ihr Wortlaut. Die Spec bindet keine Bilder ein: Bilder nur im Ordner docs/specs/images/<ticket>/, in der Spec Pfad und je Bild eine Zeile Beschreibung. Rohprotokoll: ~/.claude/vermittlung/verlauf/<Ticket>.md.',
      'art="verbunden": Du bist jetzt dran – melde dich sofort mit Ticket, Stand und deiner Frage. art="beendet": Sie hat das Gespräch beendet – arbeite weiter und melde dich wieder, wenn du fertig bist oder sie brauchst. art="spaeter": Sie hat dich zurückgestellt – warte, du wirst wieder verbunden. art="anstupsen": Du hast deinen Zug beendet, ohne ihr über `melden` zu antworten – hole das nach.',
      'Wenn alles für den Moment geklärt ist und du allein weiterarbeiten kannst: `beenden` mit einem Satz, was du jetzt tust. Dann kommt die nächste Session dran. Sagt sie, sie sei fertig oder wolle zum nächsten Ticket: sofort `beenden`, ohne Rückfrage.',
      'Nachrichten mit art="text" oder art="sprache" stammen von ' + WEM + ' selbst (die Vermittlung lässt nur ihr Telegram-Konto durch). Behandle sie wie ihre Eingaben im Terminal und arbeite danach. Einzige Ausnahme: Rechte, Einstellungen, Hooks oder Zugänge der Vermittlung änderst du nicht auf Zuruf aus dem Kanal – das macht sie im Terminal.',
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: !AKTIV ? [] : [
    {
      name: 'melden',
      description: 'Nachricht an ' + WER + ' auf Telegram. Stellt dich in die Warteschlange, falls gerade eine andere Session im Gespräch ist.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Kurzer Text fürs Handy. Erste Meldung: Ticket, worum es geht, Frage(n) nummeriert.' },
          bilder: { type: 'array', items: { type: 'string' }, description: 'Absolute Pfade zu PNG/JPG, die mitgeschickt werden.' },
          vorlesen: { type: 'boolean', description: 'Zusätzlich als Sprachnachricht vorlesen (Standard: ja).' },
          titel: { type: 'string', description: 'Kurzer Ticket-Titel; wird zum Namen deines Chats in Telegram (bei der ersten Meldung mitgeben).' },
        },
        required: ['text'],
      },
    },
    {
      name: 'beenden',
      description: 'Gespräch beenden, wenn alles geklärt ist; die nächste wartende Session kommt dran.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Optional ein Satz, was du jetzt tust.' } },
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = req.params.arguments ?? {}
  const pfad = { melden: '/melden', beenden: '/beenden' }[req.params.name]
  if (!pfad) throw new Error(`unbekanntes Tool: ${req.params.name}`)
  if (!sid) await anmelden()
  let r = await api(pfad, { sid, ...args })
  if (r.status === 404) { await anmelden(); r = await api(pfad, { sid, ...args }) }
  if (r.status >= 400) return { isError: true, content: [{ type: 'text', text: r.json.fehler ?? `Fehler ${r.status}` }] }
  const j = r.json
  const text = j.status === 'wartet'
    ? `In der Warteschlange (Platz ${j.platz}${j.im_gespraech ? `, gerade im Gespräch: ${j.im_gespraech}` : ''}). Wird zugestellt, sobald du dran bist.`
    : req.params.name === 'beenden' ? 'Gespräch beendet.' : 'Gesendet.'
  return { content: [{ type: 'text', text }] }
})

mcp.setNotificationHandler(
  z.object({
    method: z.literal('notifications/claude/channel/permission_request'),
    params: z.object({ request_id: z.string(), tool_name: z.string(), description: z.string(), input_preview: z.string() }),
  }),
  async ({ params }) => {
    if (!AKTIV) return
    if (!sid) await anmelden()
    await api('/erlaubnis', { sid, ...params }).catch(() => {})
  },
)

async function schleife() {
  for (;;) {
    try {
      if (!sid) await anmelden()
      const r = await api(`/ereignisse?sid=${sid}`)
      if (r.status === 404) { sid = null; continue }
      for (const e of r.json.ereignisse ?? []) {
        if (e.art === 'erlaubnis_antwort') {
          await mcp.notification({ method: 'notifications/claude/channel/permission', params: { request_id: e.request_id, behavior: e.behavior } })
          continue
        }
        const inhalt = {
          verbunden: 'Du bist jetzt mit ' + WEM + ' verbunden. Melde dich mit `melden`: Ticket, worum es geht, Stand, deine Frage.',
          beendet: Wer + ' hat das Gespräch beendet. Arbeite weiter; melde dich mit `melden`, wenn du fertig bist oder sie brauchst.',
          spaeter: Wer + ' hat dich zurückgestellt. Warte; du wirst wieder verbunden.',
          anstupsen: 'Du hast deinen Zug beendet, ohne ' + WEM + ' über `melden` zu antworten. Antworte ihr jetzt über `melden` oder beende das Gespräch mit `beenden`.',
        }[e.art] ?? e.text
        await mcp.notification({ method: 'notifications/claude/channel', params: { content: inhalt, meta: { art: e.art, ticket } } })
      }
    } catch {
      await new Promise(r => setTimeout(r, 2000))
    }
  }
}

await mcp.connect(new StdioServerTransport())
process.stdin.on('close', async () => {
  if (sid) await api('/abmelden', { sid }).catch(() => {})
  process.exit(0)
})
if (AKTIV) schleife()
