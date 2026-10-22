import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as pod from '../pod/archivos.js'
import { irA, leerRuta } from '../ruta.js'
import { displayName, extensionForMediaType, fileExtension, formatBytes } from '../vendor/espacio/paths.js'
import { resultado } from './resultado.js'
import ShareDialog, { personLabel } from './ShareDialog.jsx'
import Sidebar from './Sidebar.jsx'
import Viewer, { previewKind } from './Viewer.jsx'

const formatDate = (iso) => (iso ? new Date(iso).toLocaleDateString('es-CL') : '—')

/** ¿`url` está dentro de `root`? (`root` es un contenedor, con barra final). */
const isUnder = (url, root) => url.startsWith(root)

/** Las notas de notas.aebn.cl viven en `<pod>/Documentos/`; ahí se abre un `.md`. */
const NOTAS = 'https://notas.aebn.cl/nota/'

let uploadSeq = 0

/**
 * Gestor de archivos sobre el pod del socio: la vista de Archivos de espacio
 * (packages/archivos/src/renderer/ArchivosView.jsx) llevada al navegador.
 *
 * A la izquierda, la barra lateral: pods, lo compartido y los favoritos. A la
 * derecha, una de tres secciones: una carpeta (propia, o compartida por otro
 * socio y entonces de solo lectura), "Compartidos conmigo" o "Compartido por
 * mí". Lo que no trae del escritorio: sincronizar carpetas con el equipo y
 * abrir con las apps del sistema.
 */
export default function ArchivosView({ cuenta }) {
  const pods = cuenta.pods
  const primaryUrl = pods[0].url
  const [section, setSection] = useState(/** @type {'pod'|'shared-with-me'|'shared-by-me'} */ ('pod'))
  const [stack, setStack] = useState(/** @type {{url:string, name:string}[]} */ ([]))
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(/** @type {string|null} */ (null))
  const [dragOver, setDragOver] = useState(false)
  const [newFolder, setNewFolder] = useState(/** @type {string|null} */ (null))
  const [renaming, setRenaming] = useState(/** @type {{url:string, value:string}|null} */ (null))
  const [uploads, setUploads] = useState(/** @type {Record<string, {name:string, error?:string}>} */ ({}))
  const [downloads, setDownloads] = useState(/** @type {Record<string, {name:string, received:number, total?:number}>} */ ({}))
  const [sharingEntry, setSharingEntry] = useState(null)
  const [viewing, setViewing] = useState(null)
  const [viewerExpanded, setViewerExpanded] = useState(false)
  const [favorites, setFavorites] = useState([])
  const [sharedWithMe, setSharedWithMe] = useState(null)
  const [sharedByMe, setSharedByMe] = useState(null)
  const [libraryError, setLibraryError] = useState(/** @type {string|null} */ (null))
  const [sideOpen, setSideOpen] = useState(false)
  const fileInputRef = useRef(/** @type {HTMLInputElement|null} */ (null))

  const current = stack.at(-1) ?? null
  /** La carpeta abierta ahora, para lo que termina después (una tanda de subidas). */
  const stackRef = useRef(stack)
  stackRef.current = stack

  /** El pod propio que contiene `url`, o null si es de otro socio. */
  const podOf = useCallback((url) => pods.find((p) => isUnder(url, p.url)) ?? null, [pods])

  /**
   * Lo que no está en un pod propio es algo que otro socio compartió: se ve
   * y se baja, pero no se sube, renombra, borra ni comparte desde aquí.
   */
  const readOnly = Boolean(stack[0] && !podOf(stack[0].url))

  /** Protege contra una respuesta vieja que llega tarde y pisa una más nueva. */
  const requestIdRef = useRef(0)

  /**
   * Migas hasta `containerUrl`: desde la raíz del pod si es propio; si es de
   * otro socio, desde la carpeta compartida (más arriba no hay acceso).
   */
  const stackFor = useCallback(
    (containerUrl, name) => {
      const p = podOf(containerUrl)
      if (!p) return [{ url: containerUrl, name: name ?? displayName(containerUrl) }]
      const crumbs = [{ url: p.url, name: p.label }]
      let url = p.url
      for (const segment of containerUrl.slice(p.url.length).split('/').filter(Boolean)) {
        url = `${url}${segment}/`
        crumbs.push({ url, name: decodeURIComponent(segment) })
      }
      return crumbs
    },
    [podOf],
  )

  /** Muestra la carpeta del final de `nextStack`. */
  const show = useCallback(
    async (nextStack, { history = 'push' } = {}) => {
      const id = (requestIdRef.current += 1)
      const url = nextStack.at(-1).url
      if (history) irA({ section: 'pod', url }, primaryUrl, { replace: history === 'replace' })
      setSection('pod')
      setSideOpen(false)
      setStack(nextStack)
      setViewing(null)
      setLoading(true)
      setError(null)
      setNewFolder(null)
      setRenaming(null)
      const result = await resultado(() => pod.listar(url))
      if (id !== requestIdRef.current) return
      setLoading(false)
      if (!result.ok) {
        setError(result.error?.message ?? 'No se pudo leer esta carpeta.')
        setEntries([])
        return
      }
      setEntries(result.value ?? [])
    },
    [primaryUrl],
  )

  const refreshLibrary = useCallback(async () => {
    setLibraryError(null)
    const [fav, withMe, byMe] = await Promise.all([
      resultado(pod.favoritos),
      resultado(pod.compartidosConmigo),
      resultado(pod.compartidoPorMi),
    ])
    if (fav.ok) setFavorites(fav.value ?? [])
    if (withMe.ok) setSharedWithMe(withMe.value ?? [])
    if (byMe.ok) setSharedByMe(byMe.value ?? [])
    const failed = [fav, withMe, byMe].find((r) => !r.ok)
    if (failed) setLibraryError(failed.error?.message ?? 'No se pudo leer lo compartido.')
  }, [])

  const selectSection = useCallback(
    (next, { history = 'push' } = {}) => {
      requestIdRef.current += 1
      if (history) irA({ section: next }, primaryUrl, { replace: history === 'replace' })
      setSection(next)
      setSideOpen(false)
      setViewing(null)
      setError(null)
      void refreshLibrary()
    },
    [primaryUrl, refreshLibrary],
  )

  /** Abre lo que diga la URL: al cargar y con atrás/adelante del navegador. */
  const fromLocation = useCallback(
    (history) => {
      const route = leerRuta(primaryUrl)
      if (route.section !== 'pod') return selectSection(route.section, { history })
      return show(stackFor(route.url), { history })
    },
    [primaryUrl, selectSection, show, stackFor],
  )

  useEffect(() => {
    // La biblioteca después del pod: crear el buzón la primera vez no debe
    // demorar el listado.
    void Promise.resolve(fromLocation('replace')).then(refreshLibrary)
    const onPop = () => void fromLocation(null)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const goToCrumb = useCallback(
    (index) => {
      if (stack[index]) void show(stack.slice(0, index + 1))
    },
    [stack, show],
  )

  const refresh = useCallback(() => {
    if (current) void show(stack, { history: null })
  }, [current, stack, show])

  /**
   * Sube de a uno, en orden: varias subidas en paralelo de 90 MB compiten
   * por la misma conexión y ninguna avanza más rápido.
   */
  const uploadFiles = useCallback(
    (all) => {
      if (!current || readOnly || all.length === 0) return
      const tooLarge = all.filter((file) => file.size > pod.MAX_UPLOAD_BYTES)
      const files = all.filter((file) => file.size <= pod.MAX_UPLOAD_BYTES)
      if (tooLarge.length > 0) {
        const list = tooLarge.map((file) => `• ${file.name} (${formatBytes(file.size)})`).join('\n')
        window.alert(
          `${tooLarge.length === 1 ? 'Este archivo es demasiado grande' : 'Estos archivos son demasiado grandes'} para subirlo${tooLarge.length === 1 ? '' : 's'}:\n\n${list}\n\n` +
            `Por ahora el máximo es ${formatBytes(pod.MAX_UPLOAD_BYTES)} por archivo.`,
        )
      }
      if (files.length === 0) return
      const known = new Set(entries.map((entry) => entry.name))
      const repeated = files.filter((file) => known.has(file.name))
      if (
        repeated.length > 0 &&
        !window.confirm(
          `${repeated.length === 1 ? `Ya existe «${repeated[0].name}»` : `Ya existen ${repeated.length} de estos archivos`} en esta carpeta. ¿Reemplazar${repeated.length === 1 ? 'lo' : 'los'}?`,
        )
      ) {
        return
      }
      const target = current.url
      const ids = files.map(() => `u${(uploadSeq += 1)}`)
      setUploads((prev) => {
        const next = { ...prev }
        files.forEach((file, i) => {
          next[ids[i]] = { name: file.name }
        })
        return next
      })
      void (async () => {
        for (const [i, file] of files.entries()) {
          const result = await resultado(() => pod.subir(target, file))
          setUploads((prev) => {
            const next = { ...prev }
            if (result.ok) delete next[ids[i]]
            else next[ids[i]] = { ...next[ids[i]], error: result.error?.message ?? 'Error al subir' }
            return next
          })
        }
        if (stackRef.current.at(-1)?.url === target) refresh()
      })()
    },
    [current, readOnly, entries, refresh],
  )

  const canDrop = section === 'pod' && current !== null && !readOnly

  const onDrop = useCallback(
    (event) => {
      event.preventDefault()
      setDragOver(false)
      if (!canDrop) return
      // Una carpeta arrastrada llega como un File sin tipo ni contenido legible.
      const items = [...(event.dataTransfer.items ?? [])]
      if (items.some((item) => item.webkitGetAsEntry?.()?.isDirectory)) {
        window.alert('Por ahora se suben archivos sueltos, no carpetas. Crea la carpeta y arrastra su contenido.')
        return
      }
      uploadFiles([...event.dataTransfer.files])
    },
    [canDrop, uploadFiles],
  )

  const onPickFiles = useCallback(
    (event) => {
      const files = [...(event.target.files ?? [])]
      event.target.value = ''
      uploadFiles(files)
    },
    [uploadFiles],
  )

  const createFolder = useCallback(
    async (event) => {
      event.preventDefault()
      const name = newFolder?.trim()
      setNewFolder(null)
      if (!current || !name) return
      const result = await resultado(() => pod.crearCarpeta(current.url, name))
      if (!result.ok) {
        setError(result.error?.message ?? 'No se pudo crear la carpeta.')
        return
      }
      refresh()
    },
    [current, newFolder, refresh],
  )

  const submitRename = useCallback(
    async (entry, event) => {
      event.preventDefault()
      const name = renaming?.url === entry.url ? renaming.value.trim() : null
      setRenaming(null)
      if (!current || !name || name === entry.name) return
      const result = await resultado(() => pod.renombrar(entry, current.url, name))
      if (!result.ok) {
        setError(result.error?.message ?? 'No se pudo renombrar.')
        return
      }
      refresh()
    },
    [current, renaming, refresh],
  )

  const remove = useCallback(
    async (entry) => {
      const kind = entry.isContainer ? 'la carpeta' : 'el archivo'
      if (!window.confirm(`¿Borrar ${kind} "${entry.name}"? No se puede deshacer.`)) return
      const result = await resultado(() => pod.borrar(entry))
      if (!result.ok) {
        setError(result.error?.message ?? 'No se pudo borrar.')
        return
      }
      refresh()
    },
    [refresh],
  )

  /**
   * Nombre a mostrar, con extensión aunque el recurso no la tenga (el
   * `README` que CSS deja sin extensión en la raíz de cada pod).
   */
  const nameWithExtension = useCallback((entry) => {
    if (entry.isContainer || fileExtension(entry.name)) return entry.name
    const ext = entry.mediaType ? extensionForMediaType(entry.mediaType) : null
    return ext ? `${entry.name}.${ext}` : entry.name
  }, [])

  const download = useCallback(
    async (entry) => {
      const id = entry.url
      const name = nameWithExtension(entry)
      setDownloads((prev) => ({ ...prev, [id]: { name, received: 0 } }))
      const result = await resultado(() =>
        pod.descargar(entry.url, name, (received, total) =>
          setDownloads((prev) => (id in prev ? { ...prev, [id]: { name, received, total } } : prev)),
        ),
      )
      setDownloads((prev) => {
        const { [id]: _, ...rest } = prev
        return rest
      })
      if (!result.ok) setError(result.error?.message ?? 'No se pudo descargar.')
    },
    [nameWithExtension],
  )

  /** Un `.md` en Documentos/ del pod principal es una nota: se ofrece abrirlo en Notas. */
  const notasUrl = useCallback(
    (entry) => {
      const docs = `${primaryUrl}Documentos/`
      const isMd = fileExtension(nameWithExtension(entry)) === 'md'
      return !entry.isContainer && isMd && isUnder(entry.url, docs) ? NOTAS + entry.url.slice(docs.length) : null
    },
    [primaryUrl, nameWithExtension],
  )

  /** Los archivos de la carpeta, para recorrerlos con ↑/↓ desde el panel. */
  const files = useMemo(() => (section === 'pod' ? entries.filter((entry) => !entry.isContainer) : []), [section, entries])
  const viewingIndex = viewing ? files.findIndex((entry) => entry.url === viewing.url) : -1

  /** Abre cualquier cosa por su URL: una carpeta (propia o compartida) o un archivo. */
  const openItem = useCallback(
    (item) => {
      if (item.isContainer) return show(stackFor(item.url, item.name))
      return setViewing(item)
    },
    [show, stackFor],
  )

  const favoriteUrls = useMemo(() => new Set(favorites.map((item) => item.url)), [favorites])

  const toggleFavorite = useCallback(
    async (entry) => {
      const result = await resultado(() =>
        pod.alternarFavorito({ url: entry.url, name: nameWithExtension(entry), isContainer: entry.isContainer }),
      )
      if (!result.ok) {
        setError(result.error?.message ?? 'No se pudo guardar el favorito.')
        return
      }
      setFavorites(result.value ?? [])
    },
    [nameWithExtension],
  )

  const dismissShared = useCallback(
    async (item) => {
      if (!window.confirm(`¿Quitar «${item.name}» de tu lista?\n\nNo se borra nada: sigue en el pod de quien lo compartió.`)) return
      const result = await resultado(() => pod.quitarCompartido(item))
      if (!result.ok) {
        setLibraryError(result.error?.message ?? 'No se pudo quitar de la lista.')
        return
      }
      void refreshLibrary()
    },
    [refreshLibrary],
  )

  const uploadList = useMemo(() => Object.entries(uploads), [uploads])
  const downloadList = useMemo(() => Object.entries(downloads), [downloads])

  const star = (entry) => {
    const on = favoriteUrls.has(entry.url)
    return (
      <button
        className={`archivos__star${on ? ' is-on' : ''}`}
        onClick={() => toggleFavorite(entry)}
        title={on ? 'Quitar de favoritos' : 'Agregar a favoritos'}
        aria-label={on ? 'Quitar de favoritos' : 'Agregar a favoritos'}
        aria-pressed={on}
      >
        {on ? '★' : '☆'}
      </button>
    )
  }

  const sharedRoot = readOnly ? sharedWithMe?.find((item) => item.url === stack[0]?.url) : null
  const menuButton = (
    <button className="archivos__icon-btn archivos__menu" onClick={() => setSideOpen((on) => !on)} aria-label="Menú">
      ☰
    </button>
  )

  return (
    <div
      className={`archivos archivos--layout${viewing ? ' is-viewing' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        if (canDrop) setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(/** @type {Node} */ (e.relatedTarget))) setDragOver(false)
      }}
      onDrop={onDrop}
    >
      <Sidebar
        pods={pods}
        section={section}
        currentPodUrl={stack[0]?.url}
        favorites={favorites}
        open={sideOpen}
        sharedWithMeCount={sharedWithMe?.length ?? 0}
        sharedByMeCount={sharedByMe?.length ?? 0}
        onSelectPod={(p) => show([{ url: p.url, name: p.label }])}
        onOpenFavorite={openItem}
        onSelectSection={selectSection}
      />
      {sideOpen && <div className="archivos-side__scrim" onClick={() => setSideOpen(false)} />}

      <div className="archivos__main">
        {section === 'pod' ? (
          <div className="archivos__toolbar">
            {menuButton}
            <div className="archivos__crumbs">
              {readOnly && <span className="archivos__badge">Compartido{sharedRoot ? ` por ${personLabel(sharedRoot.from)}` : ''}</span>}
              {stack.map((crumb, i) => (
                <span key={crumb.url} style={{ display: 'contents' }}>
                  {i > 0 && <span className="archivos__crumb-sep">/</span>}
                  <button className="archivos__crumb" onClick={() => goToCrumb(i)}>
                    {crumb.name}
                  </button>
                </span>
              ))}
            </div>
            <button className="archivos__icon-btn" onClick={refresh} disabled={!current}>
              Actualizar
            </button>
            {!readOnly && (
              <>
                <button className="archivos__icon-btn" onClick={() => setNewFolder('')} disabled={!current}>
                  Nueva carpeta
                </button>
                <button className="archivos__icon-btn archivos__icon-btn--accent" onClick={() => fileInputRef.current?.click()} disabled={!current}>
                  Subir…
                </button>
                {current && stack.length > 1 && (
                  <button
                    className="archivos__icon-btn"
                    onClick={() => setSharingEntry({ url: current.url, name: current.name, isContainer: true })}
                  >
                    Compartir carpeta
                  </button>
                )}
              </>
            )}
            <input ref={fileInputRef} type="file" multiple hidden onChange={onPickFiles} />
          </div>
        ) : (
          <div className="archivos__toolbar">
            {menuButton}
            <div className="archivos__crumbs">
              <span className="archivos__title">{section === 'shared-with-me' ? 'Compartidos conmigo' : 'Compartido por mí'}</span>
            </div>
            <button className="archivos__icon-btn" onClick={refreshLibrary}>
              Actualizar
            </button>
          </div>
        )}

        {section === 'pod' && error && <div className="archivos__notice">{error}</div>}
        {section !== 'pod' && libraryError && <div className="archivos__notice">{libraryError}</div>}

        <div className="archivos__body">
          {dragOver && <div className="archivos__drop">Suelta aquí para subir a esta carpeta</div>}

          {section === 'shared-with-me' ? (
            sharedWithMe === null ? (
              <div className="archivos__empty">Cargando…</div>
            ) : sharedWithMe.length === 0 ? (
              <div className="archivos__empty">
                Nadie te ha compartido nada todavía.
                <br />
                Cuando otro socio comparta un archivo o una carpeta contigo, aparecerá aquí.
              </div>
            ) : (
              <table className="archivos__table">
                <thead>
                  <tr>
                    <th>Nombre</th>
                    <th className="archivos__col-opt">De</th>
                    <th className="archivos__col-opt">Compartido</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sharedWithMe.map((item) => (
                    <tr key={item.url} className="archivos__row">
                      <td>
                        <div className="archivos__name-cell">
                          {star(item)}
                          <span className="archivos__icon">{item.isContainer ? '📁' : '📄'}</span>
                          <button className="archivos__name-btn" onClick={() => openItem(item)} title={item.url}>
                            {item.name}
                          </button>
                        </div>
                      </td>
                      <td className="archivos__meta archivos__col-opt" title={item.from}>
                        {personLabel(item.from)}
                      </td>
                      <td className="archivos__meta archivos__col-opt">{formatDate(item.sharedAt)}</td>
                      <td>
                        <div className="archivos__row-actions">
                          {!item.isContainer && (
                            <button className="archivos__icon-btn" onClick={() => download(item)}>
                              Descargar
                            </button>
                          )}
                          <button className="archivos__icon-btn" onClick={() => dismissShared(item)}>
                            Quitar de la lista
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : section === 'shared-by-me' ? (
            sharedByMe === null ? (
              <div className="archivos__empty">Cargando…</div>
            ) : sharedByMe.length === 0 ? (
              <div className="archivos__empty">
                Todavía no compartes nada.
                <br />
                Usa «Compartir» en un archivo o una carpeta de tu pod.
              </div>
            ) : (
              <table className="archivos__table">
                <thead>
                  <tr>
                    <th>Nombre</th>
                    <th className="archivos__col-opt">Con</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sharedByMe.map((item) => {
                    const people = Object.entries(item.to)
                    const pending = people.filter(([, state]) => !state.notified).length
                    return (
                      <tr key={item.url} className="archivos__row">
                        <td>
                          <div className="archivos__name-cell">
                            {star(item)}
                            <span className="archivos__icon">{item.isContainer ? '📁' : '📄'}</span>
                            <button className="archivos__name-btn" onClick={() => openItem(item)} title={item.url}>
                              {item.name}
                            </button>
                          </div>
                        </td>
                        <td className="archivos__meta archivos__col-opt">
                          {people.map(([webId]) => personLabel(webId)).join(', ')}
                          {pending > 0 && (
                            <span
                              className="archivos__pending"
                              title="Aún no tienen buzón para «Compartidos conmigo». Ya tienen acceso; se les avisará en cuanto abran Archivos."
                            >
                              {' '}
                              · {pending} sin avisar
                            </span>
                          )}
                        </td>
                        <td>
                          <div className="archivos__row-actions">
                            <button className="archivos__icon-btn" onClick={() => setSharingEntry(item)}>
                              Gestionar acceso
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )
          ) : loading ? (
            <div className="archivos__empty">Cargando…</div>
          ) : entries.length === 0 && newFolder === null ? (
            <div className="archivos__empty">
              {readOnly ? 'Esta carpeta está vacía.' : 'Esta carpeta está vacía. Arrastra archivos aquí para subirlos.'}
            </div>
          ) : (
            <table className="archivos__table">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th className="archivos__col-opt">Tamaño</th>
                  <th className="archivos__col-opt">Modificado</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {newFolder !== null && (
                  <tr className="archivos__row">
                    <td colSpan={4}>
                      <form className="archivos__inline-form" onSubmit={createFolder}>
                        <span className="archivos__icon">📁</span>
                        <input
                          autoFocus
                          className="archivos__inline-input"
                          value={newFolder}
                          onChange={(e) => setNewFolder(e.target.value)}
                          onBlur={() => setNewFolder(null)}
                          placeholder="Nombre de la carpeta"
                        />
                      </form>
                    </td>
                  </tr>
                )}
                {entries.map((entry) => (
                  <tr key={entry.url} className={`archivos__row${viewing?.url === entry.url ? ' is-selected' : ''}`}>
                    <td>
                      {renaming?.url === entry.url ? (
                        <form className="archivos__inline-form" onSubmit={(e) => submitRename(entry, e)}>
                          <span className="archivos__icon">{entry.isContainer ? '📁' : '📄'}</span>
                          <input
                            autoFocus
                            className="archivos__inline-input"
                            defaultValue={entry.name}
                            onChange={(e) => setRenaming({ url: entry.url, value: e.target.value })}
                            onBlur={() => setRenaming(null)}
                          />
                        </form>
                      ) : (
                        <div className="archivos__name-cell">
                          {star(entry)}
                          <span className="archivos__icon">{entry.isContainer ? '📁' : '📄'}</span>
                          <button
                            className="archivos__name-btn"
                            onClick={() => (entry.isContainer ? show([...stack, { url: entry.url, name: entry.name }]) : setViewing(entry))}
                            title={entry.isContainer ? 'Abrir' : 'Ver'}
                          >
                            {nameWithExtension(entry)}
                          </button>
                        </div>
                      )}
                    </td>
                    <td className="archivos__meta archivos__col-opt">{entry.isContainer ? '—' : formatBytes(entry.size)}</td>
                    <td className="archivos__meta archivos__col-opt">{formatDate(entry.modifiedAt)}</td>
                    <td>
                      <div className="archivos__row-actions">
                        {!entry.isContainer && (
                          <button className="archivos__icon-btn" onClick={() => download(entry)}>
                            Descargar
                          </button>
                        )}
                        {!readOnly && (
                          <>
                            <button className="archivos__icon-btn" onClick={() => setSharingEntry(entry)}>
                              Compartir
                            </button>
                            {!entry.isContainer && (
                              <button className="archivos__icon-btn" onClick={() => setRenaming({ url: entry.url, value: entry.name })}>
                                Renombrar
                              </button>
                            )}
                            <button className="archivos__icon-btn archivos__icon-btn--danger" onClick={() => remove(entry)}>
                              Borrar
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {(uploadList.length > 0 || downloadList.length > 0) && (
          <div className="archivos__uploads">
            {uploadList.map(([id, u]) => (
              <div key={id} className={`archivos__upload${u.error ? ' has-error' : ''}`}>
                <span className="archivos__upload-name">↑ {u.name}</span>
                <span className="archivos__upload-pct">
                  {u.error ? (
                    <button
                      className="archivos__link"
                      onClick={() =>
                        setUploads((prev) => {
                          const { [id]: _, ...rest } = prev
                          return rest
                        })
                      }
                    >
                      cerrar
                    </button>
                  ) : (
                    'subiendo'
                  )}
                </span>
                {u.error ? (
                  <span className="archivos__upload-error">{u.error}</span>
                ) : (
                  <div className="archivos__upload-bar">
                    <div className="archivos__upload-bar-fill is-indeterminate" />
                  </div>
                )}
              </div>
            ))}
            {downloadList.map(([id, d]) => {
              const pct = d.total ? Math.round((d.received / d.total) * 100) : null
              return (
                <div key={id} className="archivos__upload">
                  <span className="archivos__upload-name">↓ {d.name}</span>
                  <span className="archivos__upload-pct">{pct !== null ? `${pct}%` : formatBytes(d.received)}</span>
                  <div className="archivos__upload-bar">
                    <div className={`archivos__upload-bar-fill${pct === null ? ' is-indeterminate' : ''}`} style={pct !== null ? { width: `${pct}%` } : undefined} />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {sharingEntry && (
        <ShareDialog
          entry={sharingEntry}
          displayName={nameWithExtension(sharingEntry)}
          onClose={() => {
            setSharingEntry(null)
            void refreshLibrary()
          }}
        />
      )}

      {viewing && (
        <Viewer
          key={viewing.url}
          entry={viewing}
          fileName={nameWithExtension(viewing)}
          expanded={viewerExpanded}
          onToggleExpanded={() => setViewerExpanded((on) => !on)}
          onOpen={(target) => {
            if (target.isContainer || previewKind(target)) void openItem(target)
            else void download(target)
          }}
          onPrev={viewingIndex > 0 ? () => setViewing(files[viewingIndex - 1]) : undefined}
          onNext={viewingIndex >= 0 && viewingIndex < files.length - 1 ? () => setViewing(files[viewingIndex + 1]) : undefined}
          onDownload={() => download(viewing)}
          notasUrl={notasUrl(viewing)}
          onClose={() => {
            setViewing(null)
            setViewerExpanded(false)
          }}
        />
      )}
    </div>
  )
}
