/**
 * Vista previa de fotos RAW sin depender del sistema operativo.
 *
 * No se revela el RAW: casi toda cámara guarda dentro del archivo un JPEG ya
 * revelado (el que muestra en su pantalla), y eso es lo que se saca. Así se
 * ve igual en macOS, Windows y Linux, tenga o no el equipo una app de fotos.
 *
 * - **TIFF** (ARW, NEF, CR2, DNG, ORF, RW2, PEF, SRW…): se recorren sus
 *   directorios (IFD) buscando los JPEG que declaran, y se lee solo el más
 *   grande. Con `read(offset, length)` por rangos, de un ARW de 50 MB se
 *   bajan un par.
 * - **RAF** (Fujifilm): el encabezado dice dónde está el JPEG.
 * - **El resto** (CR3…): se busca en el archivo entero el JPEG más grande.
 *
 * En todos los casos se descarta un JPEG que Chromium no sabe dibujar: los
 * datos del sensor de un CR2 o un DNG van en JPEG *sin pérdida* (SOF3).
 */

/** Lo que se lee de una vez al empezar: ahí suelen estar todos los IFD. */
const HEAD_BYTES = 256 * 1024
/** Más que esto no es una vista previa, es otra cosa mal leída. */
const MAX_PREVIEW_BYTES = 64 * 1024 * 1024
const MAX_IFDS = 32

const TAG = {
  newSubfileType: 0x00fe,
  compression: 0x0103,
  stripOffsets: 0x0111,
  orientation: 0x0112,
  stripByteCounts: 0x0117,
  subIfds: 0x014a,
  jpegOffset: 0x0201,
  jpegLength: 0x0202,
  /** Panasonic RW2: el JPEG va entero como valor de esta etiqueta. */
  jpgFromRaw: 0x002e,
}

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 }

/**
 * @typedef {{ read: (offset: number, length: number) => Promise<Uint8Array>, all: () => Promise<Uint8Array> }} Reader
 * `read` puede devolver menos bytes si el archivo se acaba antes.
 */

/** Un lector sobre bytes que ya están en memoria (pruebas, archivo entero). */
export function bufferReader(bytes) {
  return {
    read: async (offset, length) => bytes.subarray(offset, offset + length),
    all: async () => bytes,
  }
}

/** Sirve de `head` lo que cae dentro de él; el resto, del lector. */
function withHead(reader, head) {
  return {
    read: (offset, length) =>
      offset + length <= head.length ? Promise.resolve(head.subarray(offset, offset + length)) : reader.read(offset, length),
    all: reader.all,
  }
}

function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/** ¿Es un JPEG que Chromium dibuja (base o progresivo)? Mira solo los marcadores del comienzo. */
export function isDisplayableJpeg(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false
  const dv = view(bytes)
  let i = 2
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return false
    const marker = bytes[i + 1]
    if (marker === 0xff) {
      i++
      continue
    }
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) return true
    // Otros SOF: sin pérdida, jerárquico o aritmético. Chromium no los dibuja.
    if (marker >= 0xc3 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return false
    if (marker === 0xda || marker === 0xd9) return false
    i += 2 + dv.getUint16(i + 2)
  }
  return false
}

/**
 * Lee la cadena de IFD de un TIFF y junta los JPEG que declara.
 *
 * @param {Reader} reader
 * @param {number} [base] - dónde empieza el TIFF (un EXIF dentro de un JPEG empieza más adelante)
 * @returns {Promise<{ orientation: number, candidates: { offset: number, length: number }[] } | null>}
 */
async function readTiff(reader, base = 0) {
  const header = await reader.read(base, 8)
  if (header.length < 8) return null
  const order = String.fromCharCode(header[0], header[1])
  if (order !== 'II' && order !== 'MM') return null
  const le = order === 'II'
  const u16 = (b, o) => view(b).getUint16(o, le)
  const u32 = (b, o) => view(b).getUint32(o, le)

  const candidates = []
  let orientation = 1
  const pending = [u32(header, 4)]
  const seen = new Set()

  while (pending.length > 0 && seen.size < MAX_IFDS) {
    const ifd = pending.shift()
    if (!ifd || seen.has(ifd)) continue
    seen.add(ifd)
    const countBytes = await reader.read(base + ifd, 2)
    if (countBytes.length < 2) continue
    const count = u16(countBytes, 0)
    if (count === 0 || count > 1000) continue
    const table = await reader.read(base + ifd + 2, count * 12 + 4)
    if (table.length < count * 12) continue

    /** @type {Map<number, { type: number, count: number, at: number }>} */
    const tags = new Map()
    for (let e = 0; e < count; e++) {
      const at = e * 12
      tags.set(u16(table, at), { type: u16(table, at + 2), count: u32(table, at + 4), at })
    }
    /** Valor escalar: SHORT o LONG, que va dentro de la entrada. */
    const scalar = (tag) => {
      const entry = tags.get(tag)
      if (!entry) return null
      return entry.type === 3 ? u16(table, entry.at + 8) : u32(table, entry.at + 8)
    }
    /** Lista de LONG (SubIFDs): dentro de la entrada si es uno, si no en otro lado. */
    const longs = async (tag) => {
      const entry = tags.get(tag)
      if (!entry) return []
      if (entry.count === 1) return [scalar(tag)]
      if (entry.count > 64) return []
      const data = await reader.read(base + u32(table, entry.at + 8), entry.count * 4)
      return Array.from({ length: Math.floor(data.length / 4) }, (_, k) => u32(data, k * 4))
    }

    if (seen.size === 1) orientation = scalar(TAG.orientation) ?? 1

    const jpegOffset = scalar(TAG.jpegOffset)
    const jpegLength = scalar(TAG.jpegLength)
    if (jpegOffset && jpegLength) candidates.push({ offset: base + jpegOffset, length: jpegLength })

    // Una sola tira comprimida en JPEG: la vista previa de CR2 y DNG (y,
    // con SOF3, sus datos del sensor, que isDisplayableJpeg descarta).
    const compression = scalar(TAG.compression)
    const strips = tags.get(TAG.stripOffsets)
    if ((compression === 6 || compression === 7) && strips?.count === 1) {
      const length = scalar(TAG.stripByteCounts)
      if (length) candidates.push({ offset: base + scalar(TAG.stripOffsets), length })
    }

    const fromRaw = tags.get(TAG.jpgFromRaw)
    if (fromRaw && fromRaw.count > 4) candidates.push({ offset: base + u32(table, fromRaw.at + 8), length: fromRaw.count })

    pending.push(...(await longs(TAG.subIfds)))
    if (table.length >= count * 12 + 4) pending.push(u32(table, count * 12))
  }

  return { orientation, candidates }
}

/** Orientación EXIF que trae el propio JPEG (1 si no trae). Chromium ya la aplica al dibujarlo. */
export async function jpegOrientation(bytes) {
  const dv = view(bytes)
  let i = 2
  while (i + 4 <= bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1]
    if (marker === 0xda) break
    const length = dv.getUint16(i + 2)
    const isExif =
      marker === 0xe1 && String.fromCharCode(...bytes.subarray(i + 4, i + 10)) === 'Exif\0\0'
    if (isExif) {
      const tiff = await readTiff(bufferReader(bytes.subarray(i + 10, i + 2 + length)))
      return tiff?.orientation ?? 1
    }
    i += 2 + length
  }
  return 1
}

/**
 * Dónde termina el JPEG que empieza en `start`, recorriendo sus segmentos y
 * los datos comprimidos (donde un `FF` va seguido de `00` o de un reinicio).
 * `null` si no es un JPEG bien formado.
 */
function jpegEnd(bytes, start) {
  const dv = view(bytes)
  let i = start + 2
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) return null
    const marker = bytes[i + 1]
    if (marker === 0xff) {
      i++
      continue
    }
    if (marker === 0xd9) return i + 2
    if (i + 4 > bytes.length) return null
    i += 2 + dv.getUint16(i + 2)
    if (marker !== 0xda) continue
    // Datos comprimidos hasta el siguiente marcador de verdad.
    while (i + 1 < bytes.length) {
      if (bytes[i] === 0xff) {
        const next = bytes[i + 1]
        if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7) && next !== 0xff) break
      }
      i++
    }
  }
  return null
}

/** El JPEG dibujable más grande dentro de `bytes`, buscándolo a ciegas. */
function largestEmbeddedJpeg(bytes) {
  let best = null
  let i = 0
  while (i + 3 < bytes.length) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) {
      const end = jpegEnd(bytes, i)
      if (end) {
        const jpeg = bytes.subarray(i, end)
        if ((!best || jpeg.length > best.length) && isDisplayableJpeg(jpeg)) best = jpeg
        i = end
        continue
      }
    }
    i++
  }
  return best
}

/**
 * La vista previa incrustada en una foto RAW, o `null` si no trae ninguna
 * que se pueda dibujar.
 *
 * `orientation` es la rotación EXIF (1, 3, 6 u 8) que falta aplicar; si el
 * JPEG ya trae la suya, es 1, porque Chromium la aplica solo.
 *
 * @param {Reader} source
 * @returns {Promise<{ data: Uint8Array, orientation: number } | null>}
 */
export async function extractRawPreview(source) {
  const head = await source.read(0, HEAD_BYTES)
  const reader = withHead(source, head)
  const finish = async (data, orientation) =>
    data ? { data, orientation: (await jpegOrientation(data)) !== 1 ? 1 : orientation } : null

  // Fujifilm: "FUJIFILMCCD-RAW", con el JPEG en 84 (posición) y 88 (largo).
  if (String.fromCharCode(...head.subarray(0, 15)) === 'FUJIFILMCCD-RAW' && head.length >= 92) {
    const dv = view(head)
    const jpeg = await reader.read(dv.getUint32(84), dv.getUint32(88))
    if (isDisplayableJpeg(jpeg)) return finish(jpeg, 1)
  }

  const tiff = await readTiff(reader).catch(() => null)
  if (tiff) {
    const ordered = tiff.candidates
      .filter((c) => c.length > 0 && c.length <= MAX_PREVIEW_BYTES)
      .sort((a, b) => b.length - a.length)
    for (const candidate of ordered) {
      const jpeg = await reader.read(candidate.offset, candidate.length)
      if (jpeg.length === candidate.length && isDisplayableJpeg(jpeg)) return finish(jpeg, tiff.orientation)
    }
  }

  // CR3 y cualquier RAW que no declare dónde está su JPEG.
  return finish(largestEmbeddedJpeg(await source.all()), tiff?.orientation ?? 1)
}
