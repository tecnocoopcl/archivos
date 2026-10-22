import { ArchivosError } from '../../pod/errores.js'

/**
 * Lo que Archivos recuerda del socio, en su propio pod (`Aplicaciones/archivos/`,
 * donde vive la configuración de cada app) y no en esta instalación: así lo
 * ve igual desde cualquier equipo.
 *
 * - `favoritos.json`: archivos y carpetas marcados, propios o compartidos.
 * - `compartidos.json`: lo que el socio compartió, con quién, y si ya se le
 *   avisó a cada persona. Es lo que alimenta "Compartido por mí" y permite
 *   reintentar el aviso a quien todavía no tenía buzón (ver ADR-014).
 *
 * Como `operations.js`, todo recibe `fetch` inyectado.
 */

export const storeUrls = (primaryUrl) => ({
  favorites: new URL('Aplicaciones/archivos/favoritos.json', primaryUrl).href,
  shared: new URL('Aplicaciones/archivos/compartidos.json', primaryUrl).href,
})

async function readJson(url, { fetch }) {
  const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } })
  if (res.status === 404) return null
  if (!res.ok) throw new ArchivosError('EspacioFetchFailed', `No se pudo leer ${url} (${res.status}).`)
  try {
    return await res.json()
  } catch {
    // Un archivo corrupto no debe dejar Archivos inservible: se parte de cero.
    return null
  }
}

async function writeJson(url, data, { fetch }) {
  // CSS crea los contenedores intermedios (`Aplicaciones/archivos/`) con el PUT.
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data, null, 2),
  })
  if (!res.ok) throw new ArchivosError('EspacioFetchFailed', `No se pudo guardar ${url} (${res.status}).`)
}

/** Solo lo que hace falta para mostrar y abrir algo: nunca lo que mande el renderer de más. */
const itemOf = (entry) => ({ url: String(entry.url), name: String(entry.name), isContainer: Boolean(entry.isContainer) })

export async function readFavorites(url, { fetch }) {
  const data = await readJson(url, { fetch })
  return Array.isArray(data?.items) ? data.items.map(itemOf) : []
}

/** Marca o desmarca `entry`. Devuelve la lista nueva. */
export async function toggleFavorite(url, entry, { fetch }) {
  const items = await readFavorites(url, { fetch })
  const next = items.some((item) => item.url === entry.url)
    ? items.filter((item) => item.url !== entry.url)
    : [...items, itemOf(entry)]
  await writeJson(url, { version: 1, items: next }, { fetch })
  return next
}

/**
 * @typedef {{ url: string, name: string, isContainer: boolean, to: Record<string, { notified: boolean }> }} SharedItem
 * @returns {Promise<SharedItem[]>}
 */
export async function readShared(url, { fetch }) {
  const data = await readJson(url, { fetch })
  if (!Array.isArray(data?.items)) return []
  return data.items.map((item) => ({ ...itemOf(item), to: { ...item.to } }))
}

/** Aplica `change` a la lista de compartidos y la guarda; deja fuera lo que ya no tiene a nadie. */
export async function updateShared(url, { fetch }, change) {
  const items = change(await readShared(url, { fetch }))
  const kept = items.filter((item) => Object.keys(item.to).length > 0)
  await writeJson(url, { version: 1, items: kept }, { fetch })
  return kept
}

/** Registra que `entry` se compartió con `webId`, y si ya se le avisó. */
export const recordShare = (entry, webId, notified) => (items) => {
  const known = items.find((item) => item.url === entry.url)
  if (known) {
    known.name = String(entry.name)
    known.to[webId] = { notified: Boolean(notified) || Boolean(known.to[webId]?.notified) }
    return items
  }
  return [...items, { ...itemOf(entry), to: { [webId]: { notified: Boolean(notified) } } }]
}

export const recordUnshare = (entryUrl, webId) => (items) =>
  items.map((item) => {
    if (item.url !== entryUrl) return item
    const { [webId]: _, ...to } = item.to
    return { ...item, to }
  })

export const markNotified = (entryUrl, webId) => (items) =>
  items.map((item) => (item.url === entryUrl && item.to[webId] ? { ...item, to: { ...item.to, [webId]: { notified: true } } } : item))

/** Los avisos que quedaron pendientes: `[{ item, webId }]`. */
export function pendingNotifications(items) {
  return items.flatMap((item) =>
    Object.entries(item.to)
      .filter(([, state]) => !state.notified)
      .map(([webId]) => ({ item, webId })),
  )
}
