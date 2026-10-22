/**
 * Nombres y rutas dentro de un contenedor del pod.
 *
 * Sin dependencias de red ni de Electron a propósito: es la lógica más fácil de
 * equivocarse (un nombre mal validado puede escapar del contenedor) y tiene que
 * poder probarse sola.
 */

const RESERVED_NAMES = new Set(['.', '..'])
// Separadores de ruta, en cualquiera de sus formas, y control chars: nada de
// esto puede aparecer en un nombre de archivo o carpeta. El broker ya impide
// escapar el contenedor a nivel de URL (ver @espacio/solid-core), pero esta es
// la primera línea de defensa, la que evita construir la URL peligrosa siquiera.
const FORBIDDEN_CHARS = /[/\\\0\r\n]/

/**
 * @param {string} name
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateName(name) {
  if (typeof name !== 'string') return { ok: false, reason: 'nombre inválido' }
  const trimmed = name.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'el nombre no puede estar vacío' }
  if (trimmed.length > 255) return { ok: false, reason: 'nombre demasiado largo' }
  if (RESERVED_NAMES.has(trimmed)) return { ok: false, reason: `"${trimmed}" no es un nombre válido` }
  if (FORBIDDEN_CHARS.test(trimmed)) return { ok: false, reason: 'el nombre no puede contener "/" ni caracteres de control' }
  return { ok: true }
}

/** Añade una barra final si no la tiene. Los contenedores siempre la llevan. */
function withTrailingSlash(url) {
  return url.endsWith('/') ? url : `${url}/`
}

/**
 * URL de un recurso (no contenedor) dentro de `containerUrl`.
 * @throws {Error} si el nombre no es válido
 */
export function resourceUrl(containerUrl, name) {
  const check = validateName(name)
  if (!check.ok) throw new Error(check.reason)
  return new URL(encodeURIComponent(name), withTrailingSlash(containerUrl)).href
}

/**
 * URL de un contenedor hijo dentro de `containerUrl`.
 * @throws {Error} si el nombre no es válido
 */
export function childContainerUrl(containerUrl, name) {
  return withTrailingSlash(resourceUrl(containerUrl, name))
}

/** ¿`url` es una URL de contenedor, por convención de nomenclatura? */
export function looksLikeContainer(url) {
  return url.endsWith('/')
}

/**
 * Contenedor padre de `url`, sin salir nunca de `rootUrl`.
 *
 * Devuelve `null` si `url` ya es la raíz: no hay "subir" desde ahí. El broker
 * es quien de verdad impide salir del pod; esto es para que la UI no ofrezca
 * un botón "subir" que luego el broker rechazaría con un 403 confuso.
 */
export function parentContainerUrl(url, rootUrl) {
  const root = withTrailingSlash(rootUrl)
  if (url === root) return null
  if (!url.startsWith(root)) {
    throw new Error(`${url} no está bajo ${root}`)
  }
  const withoutTrailingSlash = url.endsWith('/') ? url.slice(0, -1) : url
  const lastSlash = withoutTrailingSlash.lastIndexOf('/')
  const parent = `${withoutTrailingSlash.slice(0, lastSlash + 1)}`
  return parent.length < root.length ? root : parent
}

/** Nombre a mostrar de un recurso o contenedor: el último segmento, decodificado. */
export function displayName(url) {
  const withoutTrailingSlash = url.endsWith('/') ? url.slice(0, -1) : url
  const lastSlash = withoutTrailingSlash.lastIndexOf('/')
  const segment = withoutTrailingSlash.slice(lastSlash + 1)
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** Tamaño legible: "0 B", "42 KB", "3,4 MB"… */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10
  return `${String(rounded).replace('.', ',')} ${units[unit]}`
}

/** Ordena: contenedores primero, luego alfabético insensible a mayúsculas. */
export function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    if (a.isContainer !== b.isContainer) return a.isContainer ? -1 : 1
    return a.name.localeCompare(b.name, 'es', { sensitivity: 'base' })
  })
}

const EXT_MIME = {
  txt: 'text/plain', md: 'text/markdown', ttl: 'text/turtle', json: 'application/json',
  jsonld: 'application/ld+json', csv: 'text/csv', html: 'text/html', css: 'text/css',
  js: 'text/javascript', pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp',
  mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', mov: 'video/quicktime',
  zip: 'application/zip', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

/**
 * Extensión de un nombre de archivo, en minúsculas y sin el punto — o `null`
 * si no tiene ("README", una carpeta). Un punto inicial ("`.env`") no cuenta:
 * es la convención de archivo oculto, no una extensión.
 */
export function fileExtension(name) {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return name.slice(dot + 1).toLowerCase()
}

/** MIME por extensión, con `application/octet-stream` como respuesta honesta. */
export function mimeForName(name) {
  const ext = fileExtension(name)
  return (ext && EXT_MIME[ext]) ?? 'application/octet-stream'
}

// Reverso de EXT_MIME: la primera extensión insertada para cada MIME "gana",
// así "jpg" se prefiere a "jpeg" sin mantener una segunda tabla a mano.
const MIME_EXT = {}
for (const [ext, mime] of Object.entries(EXT_MIME)) {
  if (!(mime in MIME_EXT)) MIME_EXT[mime] = ext
}

/** Extensión convencional para un tipo MIME conocido, o `null`. */
export function extensionForMediaType(mediaType) {
  return MIME_EXT[mediaType] ?? null
}

// CSS declara el tipo real de un recurso sin extensión — el "README" que deja
// en la raíz de cada pod, por ejemplo — con una clase IANA en su rdf:type, no
// en el nombre: https://www.w3.org/ns/iana/media-types/<tipo>/<subtipo>#Resource
const IANA_MEDIA_TYPE = /^http:\/\/www\.w3\.org\/ns\/iana\/media-types\/([^/]+)\/([^#]+)#Resource$/

/** El primer tipo IANA de una lista de `rdf:type` ("text/markdown"…), o `null`. */
export function mediaTypeFromRdfTypes(types) {
  for (const type of types) {
    const match = IANA_MEDIA_TYPE.exec(type)
    if (match) return `${match[1]}/${match[2]}`
  }
  return null
}

/**
 * ¿Es texto plano, editable en escribir? El nombre manda; si no tiene
 * extensión (como el README de la raíz), se cae al tipo IANA del listado,
 * cuando lo hay — sin eso, un README markdown se vería como binario.
 */
export function isPlainText(name, mediaType = null) {
  const byName = mimeForName(name)
  const mime = byName === 'application/octet-stream' ? (mediaType ?? byName) : byName
  return mime.startsWith('text/') || mime === 'application/json' || mime === 'application/ld+json'
}
