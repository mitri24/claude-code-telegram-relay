#!/usr/bin/env node
// Rendert eine Spec (Markdown mit Mermaid und Bildern) zu einem handytauglichen PDF.
// Aufruf: node spec-pdf.mjs <spec.md> <ausgabe.pdf>
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, dirname, basename, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const run = promisify(execFile)
const HIER = dirname(fileURLToPath(import.meta.url))
const CHROME = process.env.VERMITTLUNG_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const [spec, aus] = process.argv.slice(2).map(p => resolve(p))
if (!spec || !aus) { console.error('Aufruf: node spec-pdf.mjs <spec.md> <ausgabe.pdf>'); process.exit(2) }

// Spec ohne Bilder: eingebundene Bilder werden zu einer Textzeile (Bilder liegen im eigenen Ordner)
const md = readFileSync(spec, 'utf8')
  .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, alt, pfad) => `🖼 _${alt || basename(pfad)}_ (\`${basename(pfad)}\`)`)
  .replace(/!\[([^\]]*)\]\[([^\]]*)\]/g, (_, alt, ref) => `🖼 _${alt || ref}_`)
const basis = pathToFileURL(dirname(spec) + '/').href
// marked und mermaid kommen aus node_modules (npm install)
const vendor = name => pathToFileURL({
  'marked.min.js': join(HIER, 'node_modules', 'marked', 'marked.min.js'),
  'mermaid.min.js': join(HIER, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'),
}[name]).href

const html = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><base href="${basis}">
<title>${basename(spec, '.md')}</title>
<script src="${vendor('marked.min.js')}"></script>
<script src="${vendor('mermaid.min.js')}"></script>
<style>
  @page { size: A4; margin: 14mm 12mm; }
  body { font: 10.5pt/1.5 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #16212b; margin: 0; }
  h1 { font-size: 17pt; line-height: 1.25; margin: 0 0 8pt; }
  h2 { font-size: 13pt; margin: 18pt 0 6pt; padding-top: 6pt; border-top: 1px solid #d3dae0; break-after: avoid; }
  h3 { font-size: 11.5pt; margin: 12pt 0 4pt; break-after: avoid; }
  p, li { orphans: 2; widows: 2; }
  code { font: 9pt ui-monospace, Menlo, monospace; background: #eef1f4; padding: 0 3px; border-radius: 3px; word-break: break-word; }
  pre { background: #eef1f4; padding: 8pt; border-radius: 4px; white-space: pre-wrap; word-break: break-word; font-size: 8.5pt; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; font-size: 8.5pt; margin: 6pt 0; table-layout: auto; }
  th, td { border: 1px solid #d3dae0; padding: 3pt 4pt; vertical-align: top; text-align: left; overflow-wrap: anywhere; min-width: 4.5em; }
  td code { word-break: break-all; }
  th { background: #e9edf0; }
  tr { break-inside: avoid; }
  img { max-width: 100%; height: auto; border: 1px solid #d3dae0; border-radius: 3px; }
  .mermaid { text-align: center; margin: 8pt 0; break-inside: avoid; }
  .mermaid svg { max-width: 100%; height: auto; }
  details { margin: 6pt 0; } summary { font-weight: 600; }
  blockquote { margin: 6pt 0; padding: 2pt 10pt; border-left: 3px solid #0d6772; color: #3c4a56; }
</style></head>
<body><article id="a"></article>
<script>
  const md = ${JSON.stringify(md)};
  const a = document.getElementById('a');
  a.innerHTML = marked.parse(md);
  for (const c of a.querySelectorAll('pre > code.language-mermaid')) {
    const d = document.createElement('div'); d.className = 'mermaid'; d.textContent = c.textContent;
    c.parentElement.replaceWith(d);
  }
  for (const d of a.querySelectorAll('details')) d.open = true;
  mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'loose', flowchart: { useMaxWidth: true } });
  mermaid.run({ querySelector: '.mermaid' }).catch(e => { for (const d of a.querySelectorAll('.mermaid:not([data-processed])')) d.outerHTML = '<pre>' + d.textContent + '</pre>' });
</script></body></html>`

const tmp = mkdtempSync(join(tmpdir(), 'spec-pdf-'))
try {
  const seite = join(tmp, 'spec.html')
  writeFileSync(seite, html)
  await run(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${join(tmp, 'profil')}`, '--allow-file-access-from-files',
    '--no-pdf-header-footer', '--virtual-time-budget=20000', '--run-all-compositor-stages-before-draw',
    `--print-to-pdf=${aus}`, pathToFileURL(seite).href,
  ], { timeout: 90_000 })
  if (!existsSync(aus)) throw new Error('kein PDF erzeugt')
  console.log(aus)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
