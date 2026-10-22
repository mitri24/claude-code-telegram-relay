#!/usr/bin/env node
// Vermittlung: ein Telegram-Bot für alle Claude-Code-Sessions.
// Immer nur ein Gespräch gleichzeitig; die anderen Sessions warten in einer Schlange.
import http from 'node:http'
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, appendFileSync, chmodSync, readdirSync, statSync } from 'node:fs'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { join, basename, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomInt } from 'node:crypto'
import { homedir } from 'node:os'

const run = promisify(execFile)
const HIER = dirname(fileURLToPath(import.meta.url))
const DIR = process.env.VERMITTLUNG_DIR ?? join(homedir(), '.claude', 'vermittlung')
const PORT = Number(process.env.VERMITTLUNG_PORT ?? 47823)
const API = process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org'
const ZUGANG = join(DIR, 'zugang.json')
const TMP = join(DIR, 'tmp')
const MODELL = process.env.VERMITTLUNG_MODELL ?? join(DIR, 'modelle', 'ggml-large-v3-turbo-q5_0.bin')
const STIMME = process.env.VERMITTLUNG_STIMME ?? 'Anna'
// Sprachnachrichten der Agenten sind aus (Wunsch der Nutzerin); mit VERMITTLUNG_VORLESEN=1 wieder an
const VORLESEN = process.env.VERMITTLUNG_VORLESEN === '1'
// Fachwörter, die die Spracherkennung kennen soll (eigene per VERMITTLUNG_WHISPER_PROMPT)
const WHISPER_PROMPT = process.env.VERMITTLUNG_WHISPER_PROMPT ?? 'Ticket, Branch, Worktree, Pull Request, Spec, Linear, DEV-123.'
const NAME = process.env.VERMITTLUNG_NAME || 'Nutzerin'
const BIN = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
const werkzeug = name => BIN.map(d => join(d, name)).find(existsSync) ?? name
const SESSION_WEG_MS = 90_000
// Langsames (Sprachausgabe, Spec-PDF) läuft mit niedriger CPU-Priorität
const nett = (befehl, args, opts) => run('/usr/bin/nice', ['-n', '10', befehl, ...args], opts)

mkdirSync(TMP, { recursive: true })

function log(...teile) {
  try { appendFileSync(join(DIR, 'vermittlung.log'), `${new Date().toISOString()} ${teile.join(' ')}\n`) } catch {}
}

function geheim() {
  const pfad = join(DIR, 'geheim')
  if (!existsSync(pfad)) { writeFileSync(pfad, randomBytes(24).toString('hex')); chmodSync(pfad, 0o600) }
  return readFileSync(pfad, 'utf8').trim()
}
const GEHEIM = geheim()

function token() {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN
  try {
    const m = /^TELEGRAM_BOT_TOKEN=(.+)$/m.exec(readFileSync(join(DIR, '.env'), 'utf8'))
    return m?.[1].trim()
  } catch { return undefined }
}
const TOKEN = token()

function zugang() {
  try { return JSON.parse(readFileSync(ZUGANG, 'utf8')) } catch { return {} }
}
function zugangSpeichern(z) { writeFileSync(ZUGANG, JSON.stringify(z, null, 2)); chmodSync(ZUGANG, 0o600) }

// ---------- Telegram ----------
// Kurze Netzwerkaussetzer („fetch failed“) zweimal wiederholen
async function mitWiederholung(fn) {
  for (let versuch = 0; ; versuch++) {
    try { return await fn() } catch (e) {
      if (versuch >= 2 || e.code || !/fetch failed|ECONNRESET|ETIMEDOUT|socket/i.test(`${e.message} ${e.cause?.code ?? ''}`)) throw e
      await new Promise(r => setTimeout(r, 1000 * (versuch + 1)))
    }
  }
}

async function tg(methode, body = {}) {
  if (methode !== 'getUpdates') return mitWiederholung(() => tgEinmal(methode, body))
  return tgEinmal(methode, body)
}

async function tgEinmal(methode, body) {
  const res = await fetch(`${API}/bot${TOKEN}/${methode}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await res.json()
  if (!j.ok) throw Object.assign(new Error(`${methode}: ${j.description}`), { code: j.error_code })
  return j.result
}

async function tgDatei(methode, feld, pfad, extra) {
  return mitWiederholung(() => tgDateiEinmal(methode, feld, pfad, extra))
}

async function tgDateiEinmal(methode, feld, pfad, extra) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(extra)) fd.append(k, String(v))
  fd.append(feld, new Blob([readFileSync(pfad)]), basename(pfad))
  const res = await fetch(`${API}/bot${TOKEN}/${methode}`, { method: 'POST', body: fd })
  const j = await res.json()
  if (!j.ok) throw new Error(`${methode}: ${j.description}`)
  return j.result
}

const chatId = () => zugang().chat_id

// ---------- Themen: ein eigener Unterchat pro Ticket (Telegram-Topics) ----------
const THEMEN = join(DIR, 'themen.json')
const themen = () => { try { return JSON.parse(readFileSync(THEMEN, 'utf8')) } catch { return {} } }
const themenSpeichern = t => writeFileSync(THEMEN, JSON.stringify(t, null, 2))
let themenAn = null
let themenGeprueft = 0
let themenPruefung = null

function themenPruefen() {
  if (themenAn === true) return Promise.resolve(true)
  if (themenPruefung) return themenPruefung
  if (Date.now() - themenGeprueft < 60_000) return Promise.resolve(themenAn)
  themenGeprueft = Date.now()
  themenPruefung = (async () => {
    try {
      const chat = await tg('getChat', { chat_id: chatId() })
      themenAn = chat.type === 'private' ? Boolean((await tg('getMe')).has_topics_enabled) : Boolean(chat.is_forum)
    } catch (e) { log('themen prüfen', e.message); themenAn = false }
    return themenAn
  })().finally(() => { themenPruefung = null })
  return themenPruefung
}

async function themaFuer(s) {
  if (s.thread || !TOKEN || !chatId()) return s.thread
  if (!(await themenPruefen())) return undefined
  const t = themen()
  if (t[s.ticket]) return (s.thread = t[s.ticket].thread)
  s.themaAnlegen ??= tg('createForumTopic', { chat_id: chatId(), name: s.ticket })
    .then(r => {
      const neu = themen(); neu[s.ticket] = { thread: r.message_thread_id, name: r.name }; themenSpeichern(neu)
      s.thread = r.message_thread_id
      log('thema', s.ticket)
    })
    .catch(e => log('thema anlegen', e.message))
    .finally(() => { s.themaAnlegen = null })
  await s.themaAnlegen
  return s.thread
}

// Sendet im Thema der Session; wurde das Thema gelöscht, wird es neu angelegt.
async function mitThema(s, senden) {
  const ort = async () => { const th = await themaFuer(s); return th ? { message_thread_id: th } : {} }
  try { return await senden(await ort()) } catch (e) {
    if (!s.thread || !/thread not found|TOPIC_ID_INVALID|TOPIC_DELETED|TOPIC_CLOSED/i.test(e.message)) throw e
    const t = themen(); delete t[s.ticket]; themenSpeichern(t); s.thread = undefined
    return senden(await ort())
  }
}

async function themaBenennen(s, titel) {
  if (!titel || !(await themaFuer(s))) return
  const rest = titel.replace(new RegExp(`^\\s*${s.ticket}\\s*[·:–-]?\\s*`, 'i'), '').trim() || titel
  const name = `${s.ticket} · ${rest}`.slice(0, 120)
  const t = themen()
  if (t[s.ticket]?.name === name) return
  await tg('editForumTopic', { chat_id: chatId(), message_thread_id: s.thread, name: s.themaZeichen ? `${s.themaZeichen} ${name}` : name })
  t[s.ticket] = { ...t[s.ticket], thread: s.thread, name }; themenSpeichern(t)
}

// Braucht die Session gerade eine Antwort von ihr? Wartend: hat eine Meldung offen. Im Gespräch: hat nach ihrer
// letzten Nachricht geschrieben und den Zug beendet (Sessions ohne Stop-Hook: hat zuletzt geschrieben).
function brauchtAntwort(s) {
  if (schlange.includes(s.sid)) return s.offen.length > 0
  if (aktiv !== s.sid || s.letzteAusgabe <= s.letzteEingabe) return false
  return s.letzterStopp === undefined || s.letzterStopp >= s.letzteEingabe
}

// Themenname trägt den Stand: ⏳ braucht deine Antwort · 🔧 arbeitet · ✅ beendet – lesbar, egal wie Telegram sortiert.
async function themaStatus(s, zeichen) {
  if (!(await themaFuer(s))) return
  const z = zeichen ?? (brauchtAntwort(s) ? '⏳' : '🔧')
  if (s.themaZeichen === z) return
  const name = `${z} ${themen()[s.ticket]?.name ?? s.ticket}`.slice(0, 128)
  await tg('editForumTopic', { chat_id: chatId(), message_thread_id: s.thread, name })
  s.themaZeichen = z
}

// ---------- Verlauf: Rohprotokoll jedes Ticket-Chats (lokal, nicht im Repo) ----------
const VERLAUF = join(DIR, 'verlauf')
function verlauf(s, wer, art, text) {
  try {
    mkdirSync(VERLAUF, { recursive: true })
    const datei = join(VERLAUF, `${s.ticket.replace(/\//g, '-')}.md`)
    if (!existsSync(datei)) writeFileSync(datei, `# Telegram-Verlauf ${s.ticket}\n\nRohprotokoll der Vermittlung. Sprachnachrichten: maschinelle Umschrift, unverändert.\n\n`)
    appendFileSync(datei, `### ${wer} · ${art}\n\n${String(text).split('\n').map(z => `> ${z}`).join('\n')}\n\n`)
  } catch (e) { log('verlauf', e.message) }
}

// ---------- Spec als PDF: immer mitschicken, wenn sie neu ist oder sich geändert hat ----------
function specFinden(s) {
  const nr = /DEV-(\d+)/.exec(s.ticket)?.[1]
  if (!nr) return undefined
  const dir = join(s.cwd, 'docs', 'specs')
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.md') && new RegExp(`dev-?${nr}(?!\\d)`, 'i').test(f))
      .map(f => ({ pfad: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((x, y) => y.mtime - x.mtime)[0]
  } catch { return undefined }
}

async function specSenden(s, ort, erzwingen = false) {
  const spec = specFinden(s)
  if (!spec) return
  const kopf = readFileSync(spec.pfad, 'utf8').slice(0, 2000)
  const status = /\b(VERIFIZIERT|UMGESETZT|GEPLANT|OFFEN)\b/.exec(kopf)?.[1] ?? 'Entwurf'
  // nur bei neuem Status schicken, nicht bei jeder Änderung (schont das Handy)
  if (!erzwingen && themen()[s.ticket]?.specStatus === status) return
  const pdf = join(TMP, `${basename(spec.pfad, '.md')}.pdf`)
  let datei = spec.pfad
  try { await nett(process.execPath, [join(HIER, 'spec-pdf.mjs'), spec.pfad, pdf], { timeout: 180_000 }); datei = pdf } catch (e) { log('spec-pdf', e.message) }
  const fertig = status === 'UMGESETZT' || status === 'VERIFIZIERT'
  try {
    await tgDatei('sendDocument', 'document', datei, { chat_id: chatId(), ...ort, caption: `${erzwingen ? '📄 Neue Spec (gekürzt) – ' : fertig ? '✅ Umgesetzt – ' : '📄 '}Spec ${s.ticket} · Status ${status}` })
    const t = themen(); t[s.ticket] = { ...t[s.ticket], specMtime: spec.mtime, specStatus: status }; themenSpeichern(t)
    log('spec gesendet', s.ticket, status)
  } finally { rmSync(pdf, { force: true }) }
}

async function sendeText(text, extra = {}) {
  const chat = chatId()
  if (!chat || !text) return
  for (let i = 0; i < text.length; i += 4000) await tg('sendMessage', { chat_id: chat, text: text.slice(i, i + 4000), ...extra })
}

async function sendeBild(pfad, ort = {}) {
  if (!existsSync(pfad)) return sendeText(`(Bild nicht gefunden: ${basename(pfad)})`, ort)
  const foto = ['.png', '.jpg', '.jpeg', '.webp'].includes(extname(pfad).toLowerCase())
  await tgDatei(foto ? 'sendPhoto' : 'sendDocument', foto ? 'photo' : 'document', pfad, {
    chat_id: chatId(),
    caption: basename(pfad),
    ...ort,
  })
}

function sprechbar(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, 'Link')
    .replace(/\bDEV-(\d+)/gi, 'Ticket $1')
    .replace(/[`*_#>|\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1500)
}

async function vorlesen(text, ort = {}) {
  const satz = sprechbar(text)
  if (!satz) return
  const stamm = join(TMP, `v-${Date.now()}-${randomInt(1e6)}`)
  try {
    await nett('/usr/bin/say', ['-v', STIMME, '-o', `${stamm}.aiff`, satz])
    await nett(werkzeug('ffmpeg'), ['-y', '-loglevel', 'error', '-i', `${stamm}.aiff`, '-c:a', 'libopus', '-b:a', '32k', `${stamm}.ogg`])
    await tgDatei('sendVoice', 'voice', `${stamm}.ogg`, { chat_id: chatId(), ...ort })
  } catch (e) {
    log('vorlesen fehlgeschlagen', e.message)
  } finally {
    rmSync(`${stamm}.aiff`, { force: true }); rmSync(`${stamm}.ogg`, { force: true })
  }
}

async function umschreiben(fileId) {
  const datei = await tg('getFile', { file_id: fileId })
  const stamm = join(TMP, `e-${Date.now()}-${randomInt(1e6)}`)
  try {
    const res = await fetch(`${API}/file/bot${TOKEN}/${datei.file_path}`)
    writeFileSync(`${stamm}.oga`, Buffer.from(await res.arrayBuffer()))
    await run(werkzeug('ffmpeg'), ['-y', '-loglevel', 'error', '-i', `${stamm}.oga`, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', `${stamm}.wav`])
    const { stdout } = await run(werkzeug('whisper-cli'), ['-m', MODELL, '-l', 'de', '-nt', '-np', '--prompt', WHISPER_PROMPT, '-f', `${stamm}.wav`], { maxBuffer: 4 << 20 })
    return stdout.replace(/\s+/g, ' ').trim()
  } finally {
    for (const e of ['.oga', '.wav']) rmSync(stamm + e, { force: true })
  }
}

const reagieren = (msg, emoji) =>
  tg('setMessageReaction', { chat_id: msg.chat.id, message_id: msg.message_id, reaction: [{ type: 'emoji', emoji }] }).catch(() => {})

// ---------- Was macht die Session gerade? (aus ihrem tmux-Terminal, 0 Tokens) ----------
function terminalStand(s) {
  try {
    const tmux = werkzeug('tmux')
    const panes = execFileSync(tmux, ['list-panes', '-a', '-F', '#{session_name}\t#{pane_current_path}'], { encoding: 'utf8', timeout: 2000 })
    const name = panes.split('\n').map(z => z.split('\t')).find(([, pfad]) => pfad === s.cwd)?.[0]
    if (!name) return undefined
    const zeilen = execFileSync(tmux, ['capture-pane', '-p', '-t', name, '-S', '-60'], { encoding: 'utf8', timeout: 2000 })
      .split('\n').map(z => z.trim()).filter(Boolean)
    const schritt = [...zeilen].reverse().find(z => z.startsWith('⏺'))?.replace(/^⏺\s*/, '')
    const laeuft = [...zeilen].reverse().find(z => /^Running .+\d+[ms]/.test(z) || /^\S+\s+\S+…\s+\(\d+[hms]/.test(z))
    const dauer = laeuft?.match(/\((\d+[hms][^·)]*?)\s*[·)]/)?.[1]
    return [schritt, dauer ? `läuft seit ${dauer}` : laeuft?.startsWith('Running') ? laeuft : undefined].filter(Boolean).map(z => z.slice(0, 220)).join('\n') || undefined
  } catch { return undefined }
}

// Antwortet der Agent nicht binnen 15 s, sagt die Vermittlung selbst, was los ist.
function antwortWaechter(s, seit) {
  setTimeout(() => {
    if (!sessions.has(s.sid) || s.letzteAusgabe >= seit || s.letzteEingabe !== seit) return
    const stand = terminalStand(s)
    const ort = s.thread ? { message_thread_id: s.thread } : {}
    sendeText(`⏳ ${s.ticket} ist gerade beschäftigt${stand ? `:\n${stand}` : '.'}\nDeine Nachricht ist angekommen, die Antwort kommt, sobald dieser Schritt fertig ist.`, ort).catch(() => {})
  }, 15_000)
}

const HINWEIS = '\n\n[Vermittlung: Antworte ihr zuerst sofort mit `melden` – kurz, auch mitten in einer Aufgabe. Lange Befehle (Tests, Builds, Installationen) im Hintergrund starten, damit du ansprechbar bleibst. Ihr Wortlaut ist nur der Text oben; richtungsgebend (nicht „ja“/„weiter“/„fix das“)? Dann als P# in ## Entscheidungen: 1–3 Sätze AI_SUMMARY, was sie inhaltlich vorgibt, ohne Kanal oder Form (kein „Telegram“/„Sprache“/„Text“); Herkunft USER_ORIGINATED wo sie die Richtung vorgibt oder formt; nie wörtlich. Commit/Push nur auf ihre ausdrückliche Anweisung. Spec extrem knapp: Problem → Fix, Entscheidungen, Bilder (nur Ordner + Zeile je Bild), Dateien.]'

// Langsame Ausgänge nacheinander im Hintergrund, damit Knöpfe und Nachrichten nie warten
let langsam = Promise.resolve()
function imHintergrund(name, fn) {
  langsam = langsam.then(fn).catch(e => log(name, e.message))
}

// ---------- Sessions und Schlange ----------
const sessions = new Map() // sid -> Session
const schlange = [] // sids, die auf ein Gespräch warten – immer nach Platz (Ankunft) sortiert
let aktiv = null // sid im Gespräch
let pause = false
// Feste Reihenfolge (FIFO): jede Session bekommt bei der Anmeldung einen Platz und behält ihn, auch wenn sie
// zwischendurch unterbrochen wird. Nur „später“ und Stille geben einen neuen Platz am Ende.
let naechsterPlatz = 1
// Wartende posten ihre Fragen nicht mehr vorab ins Thema, damit die Themenliste ruhig bleibt; mit VERMITTLUNG_VORAB=1 wieder an.
const VORAB = process.env.VERMITTLUNG_VORAB === '1'
// Standard-Chat für Nebensachen (Session mit VERMITTLUNG_TICKET=Stray, siehe claude-stray): bekommt Nachrichten
// aus dem Hauptchat, wenn gerade kein Gespräch offen ist.
const STRAY = 'Stray'

function anstellen(sid, ansEnde = false) {
  const s = sessions.get(sid)
  if (!s) return
  if (ansEnde || !s.platz) s.platz = naechsterPlatz++
  if (!schlange.includes(sid)) schlange.push(sid)
  schlange.sort((x, y) => (sessions.get(x)?.platz ?? 0) - (sessions.get(y)?.platz ?? 0))
}

// Warteschlange und noch nicht zugestellte Meldungen überleben einen Neustart (je Worktree).
const ZUSTAND = join(DIR, 'zustand.json')
let wiederher = {}
try { wiederher = JSON.parse(readFileSync(ZUSTAND, 'utf8')); rmSync(ZUSTAND, { force: true }) } catch {}
if (Number(wiederher._zaehler) > 0) naechsterPlatz = Number(wiederher._zaehler)
const START = Date.now()

function zustandSichern() {
  const z = { _zaehler: naechsterPlatz }
  for (const s of sessions.values()) {
    const wartet = schlange.includes(s.sid)
    const warAktiv = s.sid === aktiv
    if (wartet || warAktiv || s.offen.length) z[s.cwd] = { platz: s.platz, offen: s.offen, warAktiv, wartet }
  }
  try { writeFileSync(ZUSTAND, JSON.stringify(z)) } catch {}
}

function ticketAus(cwd) {
  let m = /projekt-dev(\d+)/i.exec(cwd) ?? /\bdev-?(\d+)/i.exec(basename(cwd))
  if (!m) {
    // Worktree ohne Nummer im Namen (z. B. projekt-kunde-verbinden): Nummer aus dem Branch
    try { m = /\bdev-?(\d+)/i.exec(execFileSync('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8', timeout: 3000 })) } catch {}
  }
  return m ? `DEV-${m[1]}` : basename(cwd)
}

function eindeutig(ticket) {
  const vergeben = new Set([...sessions.values()].map(s => s.ticket))
  if (!vergeben.has(ticket)) return ticket
  let n = 2
  while (vergeben.has(`${ticket}/${n}`)) n++
  return `${ticket}/${n}`
}

function ereignis(s, e) {
  s.ereignisse.push(e)
  if (s.warter) { const res = s.warter; s.warter = null; antwortJson(res, { ereignisse: s.ereignisse.splice(0) }) }
}

function wartende() { return schlange.length }

function danachZeile() {
  const danach = schlange.map(sid => sessions.get(sid)?.ticket).filter(Boolean)
  if (!danach.length) return 'danach: niemand'
  return `danach: ${danach.slice(0, 3).join(', ')}${danach.length > 3 ? ` +${danach.length - 3}` : ''}`
}

async function zustellen(s, item) {
  await mitThema(s, async ort => {
    const kopf = `${s.ticket} · ${danachZeile()}\n\n`
    if (item.art === 'text') {
      if (!item.vorab) {
        await sendeText(`${kopf}${item.text}`, { ...ort, reply_markup: { inline_keyboard: [[{ text: '➡️ Nächstes Ticket', callback_data: `w:${s.sid}` }]] } })
        verlauf(s, 'Agent', 'Nachricht', item.text)
        for (const b of item.bilder ?? []) await sendeBild(b, ort).catch(e => log('bild', e.message))
      }
      s.letzteAusgabe = Date.now()
      tafelPlanen()
      if (VORLESEN && item.vorlesen && aktiv === s.sid && !s.vorgelesen) { s.vorgelesen = true; imHintergrund('vorlesen', () => vorlesen(item.text, ort)) }
      imHintergrund('spec', () => specSenden(s, ort))
    } else if (item.art === 'erlaubnis' && !item.vorab) {
      await sendeText(
        `🔐 ${s.ticket} möchte ${item.tool_name}: ${item.description}\n\n${item.input_preview.slice(0, 1500)}\n\n` +
          `Antwort: „ja ${item.request_id}“ oder „nein ${item.request_id}“ – oder Knopf drücken.`,
        {
          ...ort,
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Erlauben', callback_data: `e:allow:${s.sid}:${item.request_id}` },
              { text: '❌ Ablehnen', callback_data: `e:deny:${s.sid}:${item.request_id}` },
            ]],
          },
        },
      )
    }
  })
}

async function gespraechStarten(s) {
  aktiv = s.sid
  s.gespraechSeit = Date.now()
  s.angestupst = false
  s.vorgelesen = false
  const offen = s.offen.splice(0)
  log('gespräch', s.ticket, `wartend=${wartende()}`)
  tafelPlanen()
  await mitThema(s, ort => sendeText(`📞 ${s.ticket} ist dran${wartende() ? ` · ${wartende()} warten` : ''}`, ort))
  if (offen.length === 0) ereignis(s, { art: 'verbunden' })
  for (const item of offen) await zustellen(s, item)
}

async function naechster() {
  if (aktiv || pause) return
  while (schlange.length) {
    const s = sessions.get(schlange.shift())
    if (s) return gespraechStarten(s).catch(e => log('start', e.message))
  }
}

// Die Nutzerin holt eine bestimmte Session dran (Knopf, „an DEV-x“, Schreiben im Thema).
// Die unterbrochene Session kehrt an ihren alten Platz zurück, nicht nach vorne.
async function anSession(ziel, leise = false) {
  if (aktiv === ziel.sid) return
  if (aktiv) anstellen(aktiv)
  const i = schlange.indexOf(ziel.sid); if (i >= 0) schlange.splice(i, 1)
  if (!leise) return gespraechStarten(ziel)
  aktiv = ziel.sid
  ziel.gespraechSeit = Date.now()
  ziel.vorgelesen = false
  ziel.angestupst = false
  log('gespräch', ziel.ticket, 'von nutzerin')
  tafelPlanen()
  for (const item of ziel.offen.splice(0)) await zustellen(ziel, item)
}

async function einreihen(s, item) {
  if (item) s.offen.push(item)
  if (aktiv === s.sid) {
    for (const i of s.offen.splice(0)) await zustellen(s, i)
    return { status: 'gesendet' }
  }
  anstellen(s.sid)
  await naechster()
  tafelPlanen()
  if (aktiv === s.sid) return { status: 'gesendet' }
  // Nur Freigaben wartender Sessions erscheinen vorab im Thema (sie blockieren die Session); Fragen warten, bis das Ticket dran ist.
  if (item && !item.vorab && (VORAB || item.art === 'erlaubnis')) await vorabZeigen(s, item).catch(e => log('vorab', e.message))
  return { status: 'wartet', platz: schlange.indexOf(s.sid) + 1, im_gespraech: sessions.get(aktiv)?.ticket ?? null }
}

// Wartende Tickets zeigen ihre Meldung schon jetzt in ihrem eigenen Chat – ohne Benachrichtigung.
async function vorabZeigen(s, item) {
  await mitThema(s, async ort => {
    if (!ort.message_thread_id) return // ohne eigene Chats nichts vorab, sonst wird der Hauptchat unruhig
    const still = { ...ort, disable_notification: true }
    const platz = schlange.indexOf(s.sid) + 1
    if (item.art === 'text') {
      await sendeText(`⏳ Wartet (Platz ${platz}) – du kannst hier schon antworten.\n\n${item.text}`, still)
      for (const b of item.bilder ?? []) await sendeBild(b, still).catch(e => log('bild', e.message))
      verlauf(s, 'Agent', 'Nachricht (wartend, still)', item.text)
    } else if (item.art === 'erlaubnis') {
      await sendeText(
        `🔐 Wartet (Platz ${platz}) – möchte ${item.tool_name}: ${item.description}\n\n${item.input_preview.slice(0, 1500)}\n\nAntwort: „ja ${item.request_id}“ oder „nein ${item.request_id}“ – oder Knopf drücken.`,
        { ...still, reply_markup: { inline_keyboard: [[
          { text: '✅ Erlauben', callback_data: `e:allow:${s.sid}:${item.request_id}` },
          { text: '❌ Ablehnen', callback_data: `e:deny:${s.sid}:${item.request_id}` },
        ]] } },
      )
    } else return
    item.vorab = true
  })
}

async function gespraechEnde(grund) {
  const s = sessions.get(aktiv)
  aktiv = null
  if (s) {
    log('ende', s.ticket, grund)
    if (grund === 'nutzerin') ereignis(s, { art: 'beendet' })
  }
  if (!pause) await naechster()
  tafelPlanen()
  const neu = sessions.get(aktiv)
  const ort = s?.thread ? { message_thread_id: s.thread } : {}
  await sendeText(neu ? `➡️ Weiter mit ${neu.ticket}${neu.thread ? ' – in dessen Chat' : ''}.` : pause ? '⏸ Pause.' : '✔️ Niemand wartet gerade.', ort).catch(() => {})
}

// ---------- Tafel: eine angeheftete Übersicht im Hauptchat, immer in fester Reihenfolge ----------
const TAFEL = join(DIR, 'tafel.json')
const tafelDatei = () => { try { return JSON.parse(readFileSync(TAFEL, 'utf8')) } catch { return {} } }
let tafelTimer = null
let tafelKette = Promise.resolve()

function tafelPlanen() {
  clearTimeout(tafelTimer)
  tafelTimer = setTimeout(() => { tafelKette = tafelKette.then(tafelAktualisieren).catch(e => log('tafel', e.message)) }, 1500)
}

const titelVon = s => themen()[s.ticket]?.name ?? s.ticket

function zustandVon(s) {
  if (s.offen.some(i => i.art === 'erlaubnis')) return '🔐 wartet auf Freigabe'
  if (brauchtAntwort(s)) return '⏳ wartet auf dich'
  if (schlange.includes(s.sid)) return '💬 meldet sich'
  if (s.ticket === STRAY && aktiv !== s.sid) return '💭 bereit für Nebensachen'
  return '🔧 arbeitet'
}

function liste() {
  if (sessions.size === 0) return '📋 Keine Session angemeldet.'
  const zeilen = ['📋 Reihenfolge (fest, nach Ankunft)']
  const a = sessions.get(aktiv)
  zeilen.push(a ? `📞 Du sprichst mit: ${titelVon(a)} – ${zustandVon(a)}` : '📞 Kein Gespräch offen')
  schlange.forEach((sid, i) => { const s = sessions.get(sid); if (s) zeilen.push(`${i + 1}. ${titelVon(s)} – ${zustandVon(s)}`) })
  for (const s of sessions.values()) if (aktiv !== s.sid && !schlange.includes(s.sid)) zeilen.push(`• ${titelVon(s)} – ${zustandVon(s)}`)
  if (pause) zeilen.push('⏸ Pause: niemand meldet sich, bis du „los“ sagst.')
  return zeilen.join('\n')
}

function tafelKnoepfe() {
  const reihen = []
  if (aktiv) reihen.push([{ text: '➡️ Weiter', callback_data: `w:${aktiv}` }])
  const andere = [...schlange, ...[...sessions.keys()].filter(sid => sid !== aktiv && !schlange.includes(sid))]
  for (let i = 0; i < andere.length; i += 2) {
    reihen.push(andere.slice(i, i + 2).map(sid => ({ text: `→ ${sessions.get(sid)?.ticket}`, callback_data: `a:${sid}` })))
  }
  return { inline_keyboard: reihen }
}

async function tafelAktualisieren() {
  const chat = chatId()
  if (!TOKEN || !chat) return
  await Promise.all([...sessions.values()].map(s => themaStatus(s).catch(e => log('thema status', e.message))))
  const text = `${liste()}\n\n⏳ braucht deine Antwort · 🔧 arbeitet · 💬 hat eine Meldung\nStand ${new Date().toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })} · Tippe ein Ticket, um es dranzunehmen.`
  const reply_markup = tafelKnoepfe()
  const alt = tafelDatei()
  if (alt.message_id) {
    try { await tg('editMessageText', { chat_id: chat, message_id: alt.message_id, text, reply_markup }); return } catch (e) {
      if (/not modified/i.test(e.message)) return
      log('tafel bearbeiten', e.message)
    }
  }
  const neu = await tg('sendMessage', { chat_id: chat, text, reply_markup, disable_notification: true })
  writeFileSync(TAFEL, JSON.stringify({ message_id: neu.message_id }))
  await tg('pinChatMessage', { chat_id: chat, message_id: neu.message_id, disable_notification: true }).catch(e => log('tafel anheften', e.message))
}

function sessionNach(name) {
  const n = name.toUpperCase().replace(/\s+/g, '').replace(/^DEV(\d)/, 'DEV-$1')
  const treffer = [...sessions.values()].filter(s => s.ticket.toUpperCase() === n || s.ticket.toUpperCase().startsWith(`${n}/`))
  return treffer.length === 1 ? treffer[0] : undefined
}

// ---------- Eingang von Telegram ----------
const ERLAUBNIS_RE = /^\s*(j|ja|y|yes|n|nein|no)\s+([a-km-z]{5})\s*$/i

const WEITER_RE = /^(?:\/?weiter|fertig|next|nächste[rsn]?|naechste[rsn]?|ich bin fertig|bin fertig|das wars|das war es|ok weiter|okay weiter|weiter bitte)$/
function istWeiter(n) {
  if (WEITER_RE.test(n)) return true
  return n.split(' ').length <= 9 && /(nächst|naechst|next)\w*.*\b(ticket|tick\w*|tock\w*|tok\w*|chat|thema|session|aufgabe)/.test(n)
}

function normal(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s/-]/gu, '').replace(/\s+/g, ' ').trim()
}

async function erlaubnisAntwort(s, requestId, behavior) {
  const rid = requestId.toLowerCase()
  if (!s?.erlaubnisse.has(rid)) return false
  s.erlaubnisse.delete(rid)
  ereignis(s, { art: 'erlaubnis_antwort', request_id: rid, behavior })
  return true
}

async function befehl(text, ort = {}) {
  const n = normal(text)
  if (n === '/liste' || n === 'liste' || n === '/start' || n === '/hilfe' || n === 'hilfe') {
    await sendeText(`${liste()}\n\nBefehle: weiter · später (ans Ende) · an DEV-123 · liste · pause · los\nIn einem Ticket-Chat schreibst du direkt dieser Session. Die angeheftete Tafel oben zeigt die Reihenfolge.`, ort)
    return true
  }
  if (istWeiter(n)) {
    if (aktiv) {
      // Ganze Sätze („Ich will das nächste Ticket …“) trotzdem zustellen, damit nichts verloren geht
      if (!/^\/?weiter$/.test(n)) {
        verlauf(sessions.get(aktiv), NAME, 'Text (beendet das Gespräch)', text)
        ereignis(sessions.get(aktiv), { art: 'text', text })
      }
      await gespraechEnde('nutzerin')
    } else await naechster()
    return true
  }
  if (n === 'später' || n === 'spaeter' || n === '/spaeter') {
    if (aktiv) { const sid = aktiv; aktiv = null; anstellen(sid, true); await naechster(); tafelPlanen() }
    return true
  }
  if (/^(wartet (noch )?(jemand|wer)|wer wartet( noch)?|wer ist dran|wie viele warten( noch)?|status|was ist los|(gibt es )?(irgendwelche )?neue nachrichten|irgendwas neues|gibt es (was|etwas) neues|was gibt es neues)$/.test(n)) {
    await sendeText(liste(), ort)
    return true
  }
  if (n === 'pause' || n === '/pause') { pause = true; tafelPlanen(); await sendeText('⏸ Pause. Ich halte alle zurück, bis du „los“ sagst.', ort); return true }
  if (n === 'los' || n === '/los') { pause = false; await sendeText('▶️ Los geht’s.', ort); await naechster(); tafelPlanen(); if (!aktiv) await sendeText('Niemand wartet gerade.', ort); return true }
  const an = /^\/?an\s+(dev\s*-?\s*\d+(?:\/\d+)?|\S+)$/.exec(n)
  if (an) {
    const ziel = sessionNach(an[1])
    if (!ziel) { await sendeText(`Keine eindeutige Session „${an[1]}“.\n\n${liste()}`, ort); return true }
    await anSession(ziel)
    return true
  }
  return false
}

async function eingang(msg) {
  const z = zugang()
  if (!['private', 'supergroup'].includes(msg.chat?.type)) return
  if (!z.user_id) {
    if (z.code && (msg.text ?? '').trim() === z.code) {
      zugangSpeichern({ user_id: String(msg.from.id), chat_id: String(msg.chat.id) })
      log('gekoppelt')
      await tg('sendMessage', { chat_id: msg.chat.id, text: '✅ Gekoppelt. Ab jetzt melden sich deine Sessions hier. „liste“ zeigt sie an.' })
    }
    return
  }
  if (String(msg.from?.id) !== z.user_id || String(msg.chat.id) !== z.chat_id) return
  const thread = msg.message_thread_id && (msg.is_topic_message || msg.chat.type === 'private') ? msg.message_thread_id : undefined
  const ort = thread ? { message_thread_id: thread } : {}

  let text = msg.text ?? msg.caption ?? ''
  let art = 'text'
  if (msg.voice || msg.audio) {
    art = 'sprache'
    await reagieren(msg, '👀')
    try {
      text = await umschreiben((msg.voice ?? msg.audio).file_id)
    } catch (e) {
      log('umschrift', e.message)
      await sendeText('⚠️ Umschrift fehlgeschlagen. Bitte noch einmal oder als Text.', ort)
      return
    }
    if (!text) { await sendeText('⚠️ Ich habe nichts verstanden. Bitte noch einmal.', ort); return }
  }
  if (!text) return

  const erl = ERLAUBNIS_RE.exec(text)
  if (erl) {
    const ok = [...sessions.values()].some(s => s.erlaubnisse.has(erl[2].toLowerCase()))
    for (const s of sessions.values()) await erlaubnisAntwort(s, erl[2], erl[1].toLowerCase().startsWith('j') || erl[1].toLowerCase().startsWith('y') ? 'allow' : 'deny')
    await reagieren(msg, ok ? '👌' : '🤷')
    return
  }
  const kurz = normal(text)
  const sThema = thread ? [...sessions.values()].find(x => x.thread === thread) : undefined
  const sAktiv = sessions.get(aktiv)
  const sZiel = sThema ?? sAktiv
  if (sZiel && sZiel.erlaubnisse.size === 1 && ['ja', 'nein', 'erlauben', 'ablehnen'].includes(kurz)) {
    const [rid] = sZiel.erlaubnisse.keys()
    await erlaubnisAntwort(sZiel, rid, kurz === 'ja' || kurz === 'erlauben' ? 'allow' : 'deny')
    await reagieren(msg, '👌')
    return
  }
  if (await befehl(text, ort)) return

  if (thread && !sThema) {
    const name = Object.entries(themen()).find(([, v]) => v.thread === thread)?.[0]
    if (name) { await sendeText(`${name} läuft gerade nicht. Starte die Session im Worktree mit claude-ticket.`, ort); return }
  }
  if (sThema && aktiv !== sThema.sid) {
    // Schreiben im Ticket-Chat holt diese Session ins Gespräch; die bisherige kehrt an ihren Platz zurück.
    await anSession(sThema, true)
  } else if (!sAktiv) {
    // Kein Gespräch offen: die einzige Session oder der Standard-Chat „Stray“ nimmt die Nachricht
    const ziel = sessions.size === 1 ? [...sessions.values()][0] : [...sessions.values()].find(x => x.ticket === STRAY)
    if (!ziel) {
      await sendeText(`Gerade ist kein Gespräch offen. Schreib im Chat des Tickets, „an DEV-123“ oder starte den Stray-Chat (claude-stray).\n\n${liste()}`, ort)
      return
    }
    await anSession(ziel, true)
  }
  const s = sessions.get(aktiv)
  s.letzteEingabe = Date.now()
  s.angestupst = false
  tafelPlanen()
  verlauf(s, NAME, art === 'sprache' ? 'Sprachnachricht (Umschrift)' : 'Text', text)
  ereignis(s, { art, text: text + HINWEIS })
  antwortWaechter(s, s.letzteEingabe)
  await reagieren(msg, '✍')
}

async function knopf(cq) {
  const z = zugang()
  if (String(cq.from?.id) !== z.user_id) return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Nicht erlaubt.' }).catch(() => {})
  const w = /^w:([a-z0-9]+)$/.exec(cq.data ?? '')
  if (w) {
    const jetzt = aktiv === w[1]
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: jetzt ? '➡️ Weiter' : 'Dieses Gespräch ist schon beendet.' }).catch(() => {})
    if (jetzt) await gespraechEnde('nutzerin')
    return
  }
  const a = /^a:([a-z0-9]+)$/.exec(cq.data ?? '')
  if (a) {
    const ziel = sessions.get(a[1])
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: ziel ? `→ ${ziel.ticket}` : 'Diese Session läuft nicht mehr.' }).catch(() => {})
    if (ziel) await anSession(ziel).catch(e => log('an', e.message))
    return
  }
  const m = /^e:(allow|deny):([a-z0-9]+):([a-km-z]{5})$/.exec(cq.data ?? '')
  const ok = m ? await erlaubnisAntwort(sessions.get(m[2]), m[3], m[1]) : false
  await tg('answerCallbackQuery', { callback_query_id: cq.id, text: ok ? (m[1] === 'allow' ? '✅ Erlaubt' : '❌ Abgelehnt') : 'Schon erledigt.' }).catch(() => {})
  if (ok && cq.message?.text) {
    await tg('editMessageText', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: `${cq.message.text}\n\n${m[1] === 'allow' ? '✅ Erlaubt' : '❌ Abgelehnt'}` }).catch(() => {})
  }
}

// Knöpfe sofort; Nachrichten in ihrer Reihenfolge, aber ohne die Abfrage von Telegram aufzuhalten
let eingangKette = Promise.resolve()
function verarbeiten(u) {
  if (u.callback_query) { knopf(u.callback_query).catch(e => log('knopf', e.message)); return }
  if (u.message) eingangKette = eingangKette.then(() => eingang(u.message)).catch(e => log('update', e.message))
}

async function telegramSchleife() {
  if (!TOKEN) { log('kein Token – Telegram aus'); return }
  const z = zugang()
  if (!z.user_id && !z.code) zugangSpeichern({ code: String(randomInt(100000, 999999)) })
  let offset = 0
  let fehler = 0
  for (;;) {
    try {
      const updates = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] })
      fehler = 0
      for (const u of updates) {
        offset = u.update_id + 1
        verarbeiten(u)
      }
    } catch (e) {
      fehler++
      log('getUpdates', e.message)
      await new Promise(r => setTimeout(r, Math.min(30_000, 1000 * 2 ** Math.min(fehler, 5))))
    }
  }
}

// ---------- lokale HTTP-Schnittstelle für Kanäle und Hook ----------
function antwortJson(res, obj, status = 200) {
  if (res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

async function lesen(req) {
  let body = ''
  for await (const teil of req) body += teil
  return body ? JSON.parse(body) : {}
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/gesund') return antwortJson(res, { ok: true, telegram: Boolean(TOKEN), gekoppelt: Boolean(zugang().user_id) })
    if (req.headers['x-geheim'] !== GEHEIM) return antwortJson(res, { fehler: 'verboten' }, 403)

    if (req.method === 'GET' && url.pathname === '/ereignisse') {
      const s = sessions.get(url.searchParams.get('sid'))
      if (!s) return antwortJson(res, { fehler: 'unbekannt' }, 404)
      s.gesehen = Date.now()
      if (s.ereignisse.length) return antwortJson(res, { ereignisse: s.ereignisse.splice(0) })
      if (s.warter) antwortJson(s.warter, { ereignisse: [] })
      s.warter = res
      const t = setTimeout(() => { if (s.warter === res) { s.warter = null; antwortJson(res, { ereignisse: [] }) } }, 25_000)
      req.on('close', () => { clearTimeout(t); if (s.warter === res) s.warter = null })
      return
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      return antwortJson(res, { aktiv: sessions.get(aktiv)?.ticket ?? null, pause, schlange: schlange.map(sid => sessions.get(sid)?.ticket), sessions: [...sessions.values()].map(s => ({ ticket: s.ticket, cwd: s.cwd, thema: s.thread ?? null })), themen: themenAn })
    }
    if (req.method !== 'POST') return antwortJson(res, { fehler: 'methode' }, 405)
    const b = await lesen(req)

    if (url.pathname === '/anmelden') {
      // Neustart derselben Session: alte Anmeldung ohne laufende Abfrage ersetzen
      for (const alt of [...sessions.values()]) if (alt.cwd === b.cwd && !alt.warter) await abmelden(alt, 'neu gestartet')
      const sid = randomBytes(4).toString('hex')
      const s = { sid, cwd: b.cwd, ticket: eindeutig(b.ticket ? String(b.ticket).slice(0, 40) : ticketAus(b.cwd ?? '')), ereignisse: [], offen: [], erlaubnisse: new Map(), warter: null, gesehen: Date.now(), letzteAusgabe: 0, letzteEingabe: 0, angestupst: false, platz: 0 }
      sessions.set(sid, s)
      log('angemeldet', s.ticket)
      themaFuer(s).catch(() => {})
      const alt = wiederher[s.cwd]
      if (alt) {
        delete wiederher[s.cwd]
        s.offen = alt.offen ?? []
        if (Number(alt.platz) > 0) { s.platz = Number(alt.platz); naechsterPlatz = Math.max(naechsterPlatz, s.platz + 1) }
        for (const i of s.offen) if (i.art === 'erlaubnis') s.erlaubnisse.set(i.request_id, true)
        if (alt.warAktiv && !aktiv) {
          aktiv = sid // Gespräch läuft nach dem Neustart einfach weiter
          s.letzteEingabe = Date.now() // offen annehmen, damit der Stop-Hook anstupst
          log('wiederhergestellt', s.ticket, 'im gespräch')
        } else if (alt.wartet || s.offen.length) {
          anstellen(sid)
          log('wiederhergestellt', s.ticket, `platz=${s.platz}`)
          // kurz warten, bis alle Sessions nach dem Neustart wieder angemeldet sind
          setTimeout(async () => {
            await naechster().catch(() => {})
            if (aktiv !== s.sid) for (const i of s.offen) if (!i.vorab && (VORAB || i.art === 'erlaubnis')) await vorabZeigen(s, i).catch(e => log('vorab', e.message))
          }, Math.max(0, 8000 - (Date.now() - START)))
        }
      }
      if (!s.platz) s.platz = naechsterPlatz++
      tafelPlanen()
      return antwortJson(res, { sid, ticket: s.ticket, telegram: Boolean(TOKEN), gekoppelt: Boolean(zugang().user_id) })
    }
    if (url.pathname === '/ereignis') {
      const s = [...sessions.values()].find(x => x.ticket === b.ticket)
      if (!s) return antwortJson(res, { fehler: 'unbekannt' }, 404)
      ereignis(s, { art: String(b.art ?? 'hinweis'), text: String(b.text ?? '') })
      return antwortJson(res, { ok: true })
    }
    if (url.pathname === '/spec-senden') {
      const s = [...sessions.values()].find(x => x.ticket === b.ticket)
      if (!s) return antwortJson(res, { fehler: 'unbekannt' }, 404)
      imHintergrund('spec', () => mitThema(s, ort => specSenden(s, ort, true)))
      return antwortJson(res, { ok: true })
    }
    if (url.pathname === '/stopp') {
      // Längster passender Pfad gewinnt, damit der Stray-Chat (Arbeitsordner über den Worktrees) nicht die Worktrees darunter abfängt
      const s = [...sessions.values()]
        .filter(x => b.cwd === x.cwd || String(b.cwd).startsWith(`${x.cwd}/`))
        .sort((x, y) => y.cwd.length - x.cwd.length)[0]
      if (!s) return antwortJson(res, { ok: true, ignoriert: 'keine Session' })
      log('stopp', s.ticket, b.ausloeser, Math.round(Number(b.dauer ?? 0)))
      s.letzterStopp = Date.now()
      tafelPlanen()
      if (aktiv === s.sid) {
        if (s.letzteEingabe > s.letzteAusgabe && !s.angestupst) { s.angestupst = true; ereignis(s, { art: 'anstupsen' }) }
        return antwortJson(res, { ok: true })
      }
      if (schlange.includes(s.sid)) return antwortJson(res, { ok: true })
      // Schon geantwortet oder beendet seit der letzten Eingabe → nicht erneut einreihen (sonst Ping-Pong zwischen zwei Sessions)
      if (['verbunden', 'text', 'sprache', 'anstupsen'].includes(b.ausloeser) && s.letzteAusgabe >= s.letzteEingabe) return antwortJson(res, { ok: true, ignoriert: 'schon geantwortet' })
      const kurz = Number(b.dauer ?? 0) < 120
      if (b.ausloeser === 'hinweis' || (['lokal', 'beendet', 'spaeter'].includes(b.ausloeser) && kurz)) return antwortJson(res, { ok: true, ignoriert: b.ausloeser })
      return antwortJson(res, await einreihen(s, null))
    }

    const s = sessions.get(b.sid)
    if (!s) return antwortJson(res, { fehler: 'unbekannt' }, 404)
    s.gesehen = Date.now()
    if (!TOKEN || !zugang().user_id) return antwortJson(res, { fehler: 'Vermittlung ist noch nicht eingerichtet (Bot-Token oder Kopplung fehlt). Melde dich im Terminal.' }, 409)

    if (url.pathname === '/melden') {
      const bilder = (b.bilder ?? []).filter(p => typeof p === 'string')
      if (b.titel) themaBenennen(s, String(b.titel)).catch(e => log('thema umbenennen', e.message))
      return antwortJson(res, await einreihen(s, { art: 'text', text: String(b.text ?? ''), bilder, vorlesen: b.vorlesen !== false }))
    }
    if (url.pathname === '/beenden') {
      if (b.text) await einreihen(s, { art: 'text', text: String(b.text), bilder: [], vorlesen: b.vorlesen !== false })
      const i = schlange.indexOf(s.sid); if (i >= 0) schlange.splice(i, 1)
      s.offen.length = 0
      s.letzteAusgabe = Date.now() // beenden zählt als Antwort
      if (aktiv === s.sid) { await sendeText(`✔️ ${s.ticket} arbeitet weiter.`); await gespraechEnde('agent') }
      return antwortJson(res, { ok: true })
    }
    if (url.pathname === '/erlaubnis') {
      s.erlaubnisse.set(b.request_id, true)
      return antwortJson(res, await einreihen(s, { art: 'erlaubnis', request_id: b.request_id, tool_name: String(b.tool_name), description: String(b.description), input_preview: String(b.input_preview ?? '') }))
    }
    if (url.pathname === '/abmelden') {
      await abmelden(s, 'beendet')
      return antwortJson(res, { ok: true })
    }
    antwortJson(res, { fehler: 'unbekannter Pfad' }, 404)
  } catch (e) {
    log('http', e.message)
    antwortJson(res, { fehler: e.message }, 500)
  }
})

async function abmelden(s, grund) {
  sessions.delete(s.sid)
  const i = schlange.indexOf(s.sid); if (i >= 0) schlange.splice(i, 1)
  log('abgemeldet', s.ticket, grund)
  if (grund === 'beendet') themaStatus(s, '✅').catch(e => log('thema status', e.message))
  tafelPlanen()
  if (aktiv === s.sid) {
    aktiv = null
    await sendeText(`📴 Session ${s.ticket} wurde ${grund}.`, s.thread ? { message_thread_id: s.thread } : {}).catch(() => {})
    await naechster()
  }
}

// Stilles Gespräch blockiert niemanden: Zug beendet, 3 min keine Nachricht, andere warten → hinten anstellen
const STILL_MS = 3 * 60_000
setInterval(() => {
  const s = sessions.get(aktiv)
  if (!s || pause || schlange.length === 0) return
  const zuletzt = Math.max(s.letzteEingabe, s.letzteAusgabe, s.gespraechSeit ?? 0, s.letzterStopp ?? 0)
  const arbeitet = (s.letzterStopp ?? 0) < s.letzteEingabe
  if (arbeitet || Date.now() - zuletzt < STILL_MS) return
  log('still', s.ticket)
  aktiv = null
  anstellen(s.sid, true)
  const ort = s.thread ? { message_thread_id: s.thread } : {}
  sendeText(`💤 ${s.ticket} ist still – ich stelle das Ticket ans Ende. Schreib hier, dann kommt es sofort wieder dran.`, ort).catch(() => {})
  naechster().catch(() => {})
  tafelPlanen()
}, 30_000)

setInterval(() => {
  for (const s of sessions.values()) if (!s.warter && Date.now() - s.gesehen > SESSION_WEG_MS) abmelden(s, 'geschlossen').catch(() => {})
}, 30_000)

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { zustandSichern(); process.exit(0) })

server.on('error', e => { log('server', e.message); process.exit(e.code === 'EADDRINUSE' ? 0 : 1) })
server.listen(PORT, '127.0.0.1', () => {
  writeFileSync(join(DIR, 'daemon.pid'), String(process.pid))
  log('gestartet', `port=${PORT}`, `telegram=${Boolean(TOKEN)}`)
  telegramSchleife()
})
