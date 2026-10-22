import { createContainerAt, deleteContainer, deleteFile } from '@inrupt/solid-client'
import { ArchivosError } from './errores.js'
import { fetchPublico, podFetch } from './solid.js'
import { listContainer } from '../vendor/espacio/listing.js'
import { childContainerUrl, formatBytes, mimeForName, resourceUrl, sortEntries, validateName } from '../vendor/espacio/paths.js'
import { extractRawPreview } from '../vendor/espacio/raw.js'
import { getSharing, resolveWebId, setPublic, shareWith, unshareWith } from '../vendor/espacio/sharing.js'
import { dismissShared, ensureInbox, listSharedWithMe, notifyShare } from '../vendor/espacio/inbox.js'
import {
  markNotified,
  pendingNotifications,
  readFavorites,
  readShared,
  recordShare,
  recordUnshare,
  storeUrls,
  toggleFavorite,
  updateShared,
} from '../vendor/espacio/store.js'

// Lo que en espacio hacen los canales IPC de Archivos (packages/archivos/src/
// main/ipc.js), pero en el navegador: misma lógica de pod —copiada en
// src/vendor/espacio/—, otra E/S. Los datos son los mismos: favoritos,
// buzón y «compartido por mí» viven en el pod, así que se ven igual desde el
// escritorio y desde aquí.

/**
 * Tamaño máximo de subida. El pod está detrás de Cloudflare, que corta
 * cualquier petición de más de 100 MB; 90 MB deja margen. Igual que en espacio.
 */
export const MAX_UPLOAD_BYTES = 90 * 1024 * 1024

/** Hasta dónde se trae un archivo entero a la memoria para verlo (texto, imágenes, PDF). */
export const MAX_PREVIEW_BYTES = 20 * 1024 * 1024

/**
 * Audio y video: en el escritorio se transmiten por rangos, pero un `<video>`
 * del navegador no puede mandar la sesión Solid, así que aquí se traen
 * enteros. Más que esto ya no cabe cómodo en la memoria de una pestaña.
 */
export const MAX_MEDIA_BYTES = 300 * 1024 * 1024

/**
 * Lecturas siempre al servidor. Los contenedores del pod responden con
 * Last-Modified pero sin Cache-Control, y con eso el navegador puede reusar
 * un listado viejo sin preguntar (lo mismo que se vio en notas).
 */
function fetchFresco(input, init = {}) {
  const headers = new Headers(init.headers)
  headers.set('Cache-Control', 'no-cache')
  return podFetch(input, { ...init, headers, cache: 'no-store' })
}

export async function listar(containerUrl) {
  return sortEntries(await listContainer(containerUrl, { fetch: fetchFresco }))
}

export async function crearCarpeta(containerUrl, name) {
  const check = validateName(name)
  if (!check.ok) throw new ArchivosError('EspacioInvalidName', check.reason)
  const url = childContainerUrl(containerUrl, name)
  const head = await fetchFresco(url, { method: 'HEAD' })
  if (head.ok) throw new ArchivosError('EspacioExists', `Ya existe «${name}».`)
  await createContainerAt(url, { fetch: podFetch })
}

/** Borra un archivo, o una carpeta si está vacía (LDP no garantiza borrado recursivo). */
export async function borrar(entry) {
  if (!entry.isContainer) return deleteFile(entry.url, { fetch: podFetch })
  const children = await listar(entry.url)
  if (children.length > 0) {
    throw new ArchivosError('EspacioNotEmpty', `"${entry.name}" no está vacía. Vacíala antes de borrarla.`)
  }
  await deleteContainer(entry.url, { fetch: podFetch })
}

/**
 * Renombra un archivo: leerlo, escribirlo en la URL nueva y recién entonces
 * borrar el viejo. Las carpetas no (habría que repetirlo con cada hijo).
 */
export async function renombrar(entry, containerUrl, newName) {
  if (entry.isContainer) throw new ArchivosError('EspacioNotSupported', 'Renombrar carpetas todavía no está disponible.')
  const check = validateName(newName)
  if (!check.ok) throw new ArchivosError('EspacioInvalidName', check.reason)
  const newUrl = resourceUrl(containerUrl, newName)
  if (newUrl === entry.url) return

  const head = await fetchFresco(newUrl, { method: 'HEAD' })
  if (head.ok) throw new ArchivosError('EspacioExists', `Ya existe «${newName}».`)
  const source = await fetchFresco(entry.url)
  if (!source.ok) throw new ArchivosError('EspacioFetchFailed', `No se pudo leer "${entry.name}" (${source.status})`)
  const contentType = source.headers.get('content-type') ?? mimeForName(newName)
  const put = await podFetch(newUrl, {
    method: 'PUT',
    headers: { 'content-type': contentType, 'If-None-Match': '*' },
    body: await source.blob(),
  })
  if (!put.ok) throw new ArchivosError('EspacioFetchFailed', `No se pudo crear "${newName}" (${put.status})`)
  await deleteFile(entry.url, { fetch: podFetch })
}

/**
 * Sube un `File` del navegador. `fetch` no informa el progreso de una subida
 * (en el escritorio se cuenta lo que pasa por el stream); aquí la barra solo
 * dice que está en curso.
 */
export async function subir(containerUrl, file) {
  const check = validateName(file.name)
  if (!check.ok) throw new ArchivosError('EspacioInvalidName', check.reason)
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new ArchivosError(
      'EspacioFileTooLarge',
      `"${file.name}" pesa ${formatBytes(file.size)}; por ahora el máximo es ${formatBytes(MAX_UPLOAD_BYTES)}.`,
    )
  }
  const url = resourceUrl(containerUrl, file.name)
  const res = await podFetch(url, {
    method: 'PUT',
    headers: { 'content-type': file.type || mimeForName(file.name) },
    body: file,
  })
  if (res.status === 413) throw new ArchivosError('EspacioFileTooLarge', `"${file.name}" es demasiado grande para el servidor.`)
  if (!res.ok) throw new ArchivosError('EspacioFetchFailed', `No se pudo subir "${file.name}" (${res.status})`)
}

/**
 * Descarga un archivo. Donde el navegador deja elegir dónde guardarlo
 * (Chromium), se escribe a disco a medida que llega, sin tenerlo entero en
 * memoria; en los demás se arma un `blob:` y se descarga como cualquier
 * enlace.
 */
export async function descargar(url, name, onProgress) {
  let handle = null
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      handle = await window.showSaveFilePicker({ suggestedName: name })
    } catch (err) {
      if (err?.name === 'AbortError') return false
      handle = null
    }
  }
  const res = await podFetch(url)
  if (!res.ok || !res.body) throw new ArchivosError('EspacioFetchFailed', `No se pudo descargar (${res.status})`)
  const total = Number(res.headers.get('content-length') ?? 0) || undefined
  let received = 0
  const counter = new TransformStream({
    transform(chunk, controller) {
      received += chunk.byteLength
      onProgress?.(received, total)
      controller.enqueue(chunk)
    },
  })
  const body = res.body.pipeThrough(counter)

  if (handle) {
    await body.pipeTo(await handle.createWritable())
    return true
  }
  const blob = await new Response(body).blob()
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(href), 60_000)
  return true
}

/** Trae un archivo entero para verlo: `{ contentType, data }`. */
export async function leer(url, max = MAX_PREVIEW_BYTES) {
  const res = await podFetch(url)
  if (!res.ok) throw new ArchivosError('EspacioFetchFailed', `No se pudo abrir (${res.status}).`)
  const tooLarge = () =>
    new ArchivosError('EspacioTooLarge', 'Es demasiado grande para verlo aquí; descárgalo.')
  if (Number(res.headers.get('content-length') ?? 0) > max) {
    await res.body?.cancel()
    throw tooLarge()
  }
  const data = new Uint8Array(await res.arrayBuffer())
  if (data.byteLength > max) throw tooLarge()
  return { contentType: res.headers.get('content-type') ?? '', data }
}

/**
 * Lector por rangos de un archivo del pod, para sacar la vista previa de un
 * RAW sin bajarlo entero. Si el servidor ignora el `Range` y manda todo, se
 * queda con eso y no vuelve a pedir.
 */
function podReader(url) {
  let full = null
  const all = async () => {
    if (full) return full
    const res = await podFetch(url)
    if (!res.ok) throw new ArchivosError('EspacioFetchFailed', `No se pudo abrir (${res.status}).`)
    full = new Uint8Array(await res.arrayBuffer())
    return full
  }
  const read = async (offset, length) => {
    if (full) return full.subarray(offset, offset + length)
    const res = await podFetch(url, { headers: { range: `bytes=${offset}-${offset + length - 1}` } })
    if (res.status === 416) return new Uint8Array()
    if (!res.ok) throw new ArchivosError('EspacioFetchFailed', `No se pudo abrir (${res.status}).`)
    const data = new Uint8Array(await res.arrayBuffer())
    if (res.status === 206) return data
    full = data
    return full.subarray(offset, offset + length)
  }
  return { read, all }
}

/** Hasta dónde se baja un RAW sin `Range` útil (un RAW de 60 MP ronda los 120 MB). */
const MAX_RAW_BYTES = 300 * 1024 * 1024

/** Foto RAW: el JPEG que la cámara guardó dentro (ver vendor/espacio/raw.js). */
export async function vistaRaw(url) {
  const head = await podFetch(url, { method: 'HEAD' })
  if (!head.ok) throw new ArchivosError('EspacioFetchFailed', `No se pudo abrir (${head.status}).`)
  if (Number(head.headers.get('content-length') ?? 0) > MAX_RAW_BYTES) {
    throw new ArchivosError('EspacioTooLarge', 'Es demasiado grande para verlo aquí; descárgalo.')
  }
  const preview = await extractRawPreview(podReader(url))
  if (!preview) throw new ArchivosError('EspacioNoPreview', 'Esta foto no trae una vista previa incrustada.')
  return { contentType: 'image/jpeg', data: preview.data.slice(), orientation: preview.orientation }
}

// --- Compartir (ADR-009 de espacio) -----------------------------------------

/**
 * La cuenta con la que se está trabajando: la fija App al resolver el perfil.
 * @type {{ webId: string, issuer: string, pods: { url: string }[] } | null}
 */
let cuenta = null
export function usarCuenta(c) {
  cuenta = c
  buzon = null
}

function sesion() {
  if (!cuenta) throw new ArchivosError('EspacioNotLoggedIn', 'Inicia sesión para compartir.')
  return cuenta
}

const aclOptions = (entry) => ({ fetch: podFetch, ownerWebId: sesion().webId, isContainer: Boolean(entry.isContainer) })
const almacen = () => storeUrls(sesion().pods[0].url)

export const acceso = (entry) => getSharing(entry.url, aclOptions(entry))
export const resolverPersona = (input) => resolveWebId(input, { issuer: sesion().issuer, fetch: fetchPublico })
export const hacerPublico = (entry, isPublic) => setPublic(entry.url, Boolean(isPublic), aclOptions(entry))

/** Deja una notificación en el buzón de otro socio: solo POST, solo dentro de la cooperativa. */
function alBuzon(inboxUrl, turtle) {
  if (new URL(inboxUrl).origin !== new URL(sesion().issuer).origin) {
    throw new Error('Ese buzón está fuera del servidor de la cooperativa.')
  }
  return podFetch(inboxUrl, { method: 'POST', headers: { 'Content-Type': 'text/turtle' }, body: turtle })
}
const notifyDeps = { publicFetch: fetchPublico, post: alBuzon }

/** Comparte y avisa: `{ notified: false }` si la persona aún no tiene buzón. */
export async function compartir(entry, webId, mode) {
  await shareWith(entry.url, webId, mode, aclOptions(entry))
  let notified = false
  try {
    notified = await notifyShare({ actor: sesion().webId, target: webId, entry }, notifyDeps)
  } catch {
    // El acceso ya está dado; el aviso queda pendiente y se reintenta.
  }
  await updateShared(almacen().shared, { fetch: podFetch }, recordShare(entry, webId, notified))
  return { notified }
}

export async function dejarDeCompartir(entry, webId) {
  await unshareWith(entry.url, webId, aclOptions(entry))
  await updateShared(almacen().shared, { fetch: podFetch }, recordUnshare(entry.url, webId))
}

// --- Favoritos y compartidos (ADR-014 de espacio) ----------------------------

export const favoritos = () => readFavorites(almacen().favorites, { fetch: fetchFresco })
export const alternarFavorito = (entry) => toggleFavorite(almacen().favorites, entry, { fetch: podFetch })

/** Buzón del socio, creado la primera vez (como en espacio). */
let buzon = null
async function urlBuzon() {
  const { webId, pods } = sesion()
  if (buzon?.webId !== webId) buzon = { webId, url: await ensureInbox(webId, { fetch: podFetch, primaryUrl: pods[0].url }) }
  return buzon.url
}

export async function compartidosConmigo() {
  return listSharedWithMe(await urlBuzon(), { fetch: fetchFresco, issuer: sesion().issuer })
}

export async function quitarCompartido(item) {
  const url = await urlBuzon()
  // Solo notificaciones del propio buzón.
  const notifications = (item?.notifications ?? []).map(String).filter((n) => n.startsWith(url))
  await dismissShared(notifications, { fetch: podFetch })
}

/** Lo que el socio compartió; de paso reintenta los avisos pendientes. */
export async function compartidoPorMi() {
  const actor = sesion().webId
  const url = almacen().shared
  let items = await readShared(url, { fetch: fetchFresco })
  const done = []
  for (const { item, webId } of pendingNotifications(items)) {
    try {
      if (await notifyShare({ actor, target: webId, entry: item }, notifyDeps)) done.push({ item, webId })
    } catch {
      // Se vuelve a intentar la próxima vez.
    }
  }
  if (done.length > 0) {
    items = await updateShared(url, { fetch: podFetch }, (list) =>
      done.reduce((acc, { item, webId }) => markNotified(item.url, webId)(acc), list),
    )
  }
  return items
}
