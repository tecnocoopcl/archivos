// Copia de detectDelimiter y parseCsv de espacio/packages/hojas/src/shared/sources.js.
// Excel en español exporta con ';'; el separador se deduce de la primera línea.

export function detectDelimiter(text) {
  const firstLine = text.slice(0, text.search(/\r?\n|$/))
  const counts = { ',': 0, ';': 0, '\t': 0 }
  let quoted = false
  for (const ch of firstLine) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && ch in counts) counts[ch]++
  }
  let best = ','
  for (const ch of [';', '\t']) if (counts[ch] > counts[best]) best = ch
  return best
}

export function parseCsv(input, delimiter = detectDelimiter(input)) {
  const text = input.startsWith('﻿') ? input.slice(1) : input
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  let i = 0

  while (i < text.length) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"' && field.length === 0) {
      quoted = true
      i++
      continue
    }
    if (ch === delimiter) {
      row.push(field)
      field = ''
      i++
      continue
    }
    if (ch === '\n' || ch === '\r') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1
      continue
    }
    field += ch
    i++
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  // Las líneas en blanco (típicamente la última) no son filas de datos.
  return { rows: rows.filter((r) => r.some((cell) => cell.trim().length > 0)), delimiter }
}
