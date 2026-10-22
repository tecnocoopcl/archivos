import { useEffect, useMemo, useState } from 'react'
import Markdown from 'react-markdown'
import { MAX_MEDIA_BYTES, MAX_PREVIEW_BYTES, leer, vistaRaw } from '../pod/archivos.js'
import { parseCsv } from '../vendor/espacio/csv.js'
import { fileExtension, formatBytes, isPlainText } from '../vendor/espacio/paths.js'

/** Lo que el navegador dibuja solo. HEIC y TIFF, solo Safari: si falla, se avisa. */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico', 'heic', 'heif', 'tif', 'tiff'])
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown'])
const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'wav', 'ogg', 'oga', 'flac', 'aac', 'opus'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'webm', 'mov'])

/**
 * Fotos RAW de cámara: se muestra el JPEG que la cámara guardó dentro,
 * sacado aquí mismo (ver `vendor/espacio/raw.js`), igual que en espacio.
 */
const RAW_EXTENSIONS = new Set([
  'arw', 'srf', 'sr2', 'cr2', 'cr3', 'nef', 'nrw', 'raf', 'orf', 'rw2', 'raw', 'pef', 'srw', 'rwl', '3fr', 'fff', 'iiq', 'dng',
])

/** Una tabla con más filas que esto deja de ser legible (y de ser rápida). */
const MAX_TABLE_ROWS = 2000

/**
 * Cómo se muestra un archivo en el panel: 'markdown', 'table', 'json',
 * 'text', 'image', 'raw', 'pdf', 'audio', 'video', o null si solo se puede
 * descargar.
 *
 * Es el `previewKind` de espacio sin la vista previa del sistema (Quick Look
 * no existe en el navegador): el PDF lo dibuja el propio navegador, y los
 * documentos de oficina se descargan.
 */
export function previewKind(entry, name = entry.name) {
  if (entry.isContainer) return null
  const ext = fileExtension(name)?.toLowerCase() ?? null
  const fits = typeof entry.size !== 'number' || entry.size <= MAX_PREVIEW_BYTES
  if ((ext && AUDIO_EXTENSIONS.has(ext)) || entry.mediaType?.startsWith('audio/')) return 'audio'
  if ((ext && VIDEO_EXTENSIONS.has(ext)) || entry.mediaType?.startsWith('video/')) return 'video'
  if (ext && RAW_EXTENSIONS.has(ext)) return 'raw'
  if (ext === 'pdf' || entry.mediaType === 'application/pdf') return 'pdf'
  if (!fits) return null
  if ((ext && IMAGE_EXTENSIONS.has(ext)) || entry.mediaType?.startsWith('image/')) return 'image'
  if ((ext && MARKDOWN_EXTENSIONS.has(ext)) || entry.mediaType === 'text/markdown') return 'markdown'
  if (ext === 'csv' || ext === 'tsv' || entry.mediaType === 'text/csv') return 'table'
  if (ext === 'json' || entry.mediaType === 'application/json') return 'json'
  if (isPlainText(name, entry.mediaType)) return 'text'
  return null
}

const MIME_BY_KIND = { pdf: 'application/pdf' }

function decode(data) {
  return new TextDecoder('utf-8').decode(data)
}

/** JSON con sangría; si no es JSON válido, tal cual. */
function prettyJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/** CSV/TSV como tabla: la primera fila de encabezados, igual que en hojas. */
function CsvTable({ text }) {
  const { rows } = useMemo(() => parseCsv(text), [text])
  if (rows.length === 0) return <div className="archivos__empty">El archivo está vacío.</div>
  const [headers, ...body] = rows
  const width = Math.max(...rows.slice(0, MAX_TABLE_ROWS + 1).map((row) => row.length))
  const pad = (row) => Array.from({ length: width }, (_, i) => row[i] ?? '')
  return (
    <div className="archivos-viewer__table-wrap">
      <table className="archivos-viewer__table">
        <thead>
          <tr>
            {pad(headers).map((cell, i) => (
              <th key={i}>{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.slice(0, MAX_TABLE_ROWS).map((row, r) => (
            <tr key={r}>
              {pad(row).map((cell, i) => (
                <td key={i}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length > MAX_TABLE_ROWS && (
        <p className="archivos-viewer__note">
          Se muestran las primeras {MAX_TABLE_ROWS.toLocaleString('es-CL')} de {body.length.toLocaleString('es-CL')}{' '}
          filas. Para verlo entero, descárgalo.
        </p>
      )}
    </div>
  )
}

/**
 * Imagen dentro de un documento del pod: se pide con la sesión y se muestra
 * como `blob:`. Una URL del pod puesta tal cual en `src` no llevaría la sesión.
 */
function PodImage({ src, alt, base }) {
  const [blobUrl, setBlobUrl] = useState(/** @type {string|null} */ (null))
  useEffect(() => {
    let url
    let cancelled = false
    try {
      url = new URL(src ?? '', base).href
    } catch {
      return
    }
    if (new URL(url).origin !== new URL(base).origin) return
    leer(url)
      .then((value) => {
        if (!cancelled) setBlobUrl(URL.createObjectURL(new Blob([value.data], { type: value.contentType })))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [src, base])
  useEffect(() => () => blobUrl && URL.revokeObjectURL(blobUrl), [blobUrl])
  return blobUrl ? <img src={blobUrl} alt={alt ?? ''} /> : <span className="archivos-viewer__missing">[{alt || 'imagen'}]</span>
}

/** Lo que hay que traer para mostrar `kind`. */
function load(kind, entry) {
  if (kind === 'raw') return vistaRaw(entry.url)
  if (kind === 'audio' || kind === 'video') {
    if (typeof entry.size === 'number' && entry.size > MAX_MEDIA_BYTES) {
      return Promise.reject(
        new Error(`Pesa ${formatBytes(entry.size)}: en el navegador se reproduce hasta ${formatBytes(MAX_MEDIA_BYTES)}. Descárgalo.`),
      )
    }
    return leer(entry.url, MAX_MEDIA_BYTES)
  }
  if (kind === 'pdf') return leer(entry.url, MAX_MEDIA_BYTES)
  return leer(entry.url)
}

/**
 * Gira la imagen según su orientación EXIF (3, 6 u 8) y devuelve un `blob:`.
 * Hace falta para la vista previa de un RAW: la orientación viene en el RAW,
 * no en el JPEG, así que el navegador no la aplica solo.
 */
async function orientedUrl(blob, orientation) {
  if (![3, 6, 8].includes(orientation)) return URL.createObjectURL(blob)
  const bitmap = await createImageBitmap(blob)
  const quarter = orientation !== 3
  const canvas = document.createElement('canvas')
  canvas.width = quarter ? bitmap.height : bitmap.width
  canvas.height = quarter ? bitmap.width : bitmap.height
  const ctx = canvas.getContext('2d')
  ctx.translate(canvas.width / 2, canvas.height / 2)
  ctx.rotate(orientation === 3 ? Math.PI : orientation === 6 ? Math.PI / 2 : -Math.PI / 2)
  ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2)
  bitmap.close()
  const rotated = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9))
  return URL.createObjectURL(rotated ?? blob)
}

const LOADING_LABEL = {
  raw: 'Preparando la foto…',
  audio: 'Trayendo el audio…',
  video: 'Trayendo el video…',
  pdf: 'Trayendo el PDF…',
}

/** Lo que se muestra como `blob:` (todo menos el texto). */
const AS_BLOB = new Set(['image', 'raw', 'pdf', 'audio', 'video'])

/**
 * Panel de vista previa, a la derecha de la lista: Markdown, texto, tablas
 * CSV, JSON, imágenes, fotos RAW, PDF, audio y video. Sirve igual para lo
 * propio y para lo que otro socio compartió.
 *
 * Con ↑/↓ se pasa al archivo anterior o siguiente de la carpeta; «Ampliar»
 * lo lleva a todo el ancho. Un enlace relativo a otro documento de la misma
 * carpeta se abre aquí mismo.
 */
export default function Viewer({
  entry,
  fileName = entry.name,
  expanded,
  onToggleExpanded,
  onOpen,
  onPrev,
  onNext,
  onDownload,
  notasUrl,
  onClose,
}) {
  const [content, setContent] = useState(/** @type {{contentType:string, data:Uint8Array, orientation?:number}|null} */ (null))
  const [error, setError] = useState(/** @type {string|null} */ (null))
  /** El navegador no supo dibujarlo (un HEIC en Chrome, un códec de video raro). */
  const [unsupported, setUnsupported] = useState(false)
  const kind = previewKind(entry, fileName)

  useEffect(() => {
    let cancelled = false
    setContent(null)
    setError(null)
    setUnsupported(false)
    if (!kind) return
    load(kind, entry)
      .then((value) => !cancelled && setContent(value))
      .catch((err) => !cancelled && setError(err?.message ?? 'No se pudo abrir.'))
    return () => {
      cancelled = true
    }
  }, [kind, entry])

  // Teclado: Esc cierra (o vuelve del modo ampliado), ↑/↓ recorren la carpeta.
  useEffect(() => {
    const onKey = (event) => {
      const target = /** @type {HTMLElement} */ (event.target)
      if (target.closest('input, textarea, select, [contenteditable="true"], dialog, audio, video')) return
      if (event.key === 'Escape') {
        event.preventDefault()
        if (expanded) onToggleExpanded()
        else onClose()
      } else if (event.key === 'ArrowDown' && onNext) {
        event.preventDefault()
        onNext()
      } else if (event.key === 'ArrowUp' && onPrev) {
        event.preventDefault()
        onPrev()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded, onToggleExpanded, onClose, onNext, onPrev])

  const asBlob = AS_BLOB.has(kind)
  const [blobUrl, setBlobUrl] = useState(/** @type {string|null} */ (null))
  useEffect(() => {
    if (!asBlob || !content) {
      setBlobUrl(null)
      return
    }
    let url = null
    let cancelled = false
    // El servidor puede no declarar el tipo (o declarar octet-stream): el
    // visor de PDF del navegador lo necesita.
    const type = MIME_BY_KIND[kind] ?? content.contentType
    orientedUrl(new Blob([content.data], { type }), content.orientation ?? 1).then((made) => {
      if (cancelled) return URL.revokeObjectURL(made)
      url = made
      setBlobUrl(made)
    })
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [asBlob, kind, content])

  const text = useMemo(() => (content && !asBlob ? decode(content.data) : ''), [content, asBlob])

  /** Enlaces del documento: los del pod se abren aquí; los demás, en otra pestaña. */
  const components = useMemo(
    () => ({
      a: ({ href, children }) => (
        <a
          href={href}
          onClick={(event) => {
            event.preventDefault()
            let target
            try {
              target = new URL(href ?? '', entry.url)
            } catch {
              return
            }
            if (target.origin === new URL(entry.url).origin) {
              const name = decodeURIComponent(target.pathname.split('/').filter(Boolean).at(-1) ?? '')
              onOpen({ url: target.href, name, isContainer: target.pathname.endsWith('/') })
            } else if (target.protocol === 'https:') {
              window.open(target.href, '_blank', 'noopener,noreferrer')
            }
          }}
        >
          {children}
        </a>
      ),
      img: ({ src, alt }) => <PodImage src={src} alt={alt} base={entry.url} />,
    }),
    [entry.url, onOpen],
  )

  let body
  if (!kind || unsupported) {
    body = (
      <div className="archivos-viewer__card">
        <div className="archivos-viewer__card-ext">{fileExtension(fileName)?.toUpperCase() ?? 'ARCHIVO'}</div>
        <p>{unsupported ? 'Este navegador no sabe mostrar este archivo.' : 'No hay vista previa para este tipo de archivo.'}</p>
        {typeof entry.size === 'number' && <p className="archivos-viewer__note">{formatBytes(entry.size)}</p>}
      </div>
    )
  } else if (error) {
    body = <div className="archivos__empty">{error}</div>
  } else if (!content || (asBlob && !blobUrl)) {
    body = <div className="archivos__empty">{LOADING_LABEL[kind] ?? 'Cargando…'}</div>
  } else if (kind === 'image' || kind === 'raw') {
    body = (
      <div className="archivos-viewer__picture">
        <img className="archivos-viewer__image" src={blobUrl} alt={fileName} onError={() => setUnsupported(true)} />
      </div>
    )
  } else if (kind === 'pdf') {
    body = <iframe className="archivos-viewer__pdf" src={blobUrl} title={fileName} />
  } else if (kind === 'audio') {
    body = (
      <div className="archivos-viewer__media">
        <audio src={blobUrl} controls autoPlay onError={() => setUnsupported(true)} />
      </div>
    )
  } else if (kind === 'video') {
    body = (
      <div className="archivos-viewer__media">
        <video src={blobUrl} controls autoPlay playsInline onError={() => setUnsupported(true)} />
      </div>
    )
  } else if (kind === 'table') {
    body = <CsvTable text={text} />
  } else if (kind === 'json') {
    body = <pre className="archivos-viewer__text">{prettyJson(text)}</pre>
  } else if (kind === 'markdown') {
    body = (
      <article className="archivos-viewer__md">
        <Markdown components={components}>{text}</Markdown>
      </article>
    )
  } else {
    body = <pre className="archivos-viewer__text">{text}</pre>
  }

  return (
    <aside className={`archivos-viewer${expanded ? ' is-expanded' : ''}`} aria-label={`Vista previa de ${fileName}`}>
      <header className="archivos-viewer__header">
        <h2 className="archivos-viewer__title" title={fileName}>
          {fileName}
        </h2>
        <button
          className="archivos__icon-btn archivos-viewer__expand"
          onClick={onToggleExpanded}
          title={expanded ? 'Volver al panel (Esc)' : 'Ver a todo el ancho'}
        >
          {expanded ? 'Reducir' : 'Ampliar'}
        </button>
        <button className="archivos__icon-btn" onClick={onClose} title="Cerrar (Esc)" aria-label="Cerrar">
          ✕
        </button>
      </header>
      <div className="archivos-viewer__body">{body}</div>
      <footer className="archivos-viewer__footer">
        {notasUrl && (
          <a className="btn" href={notasUrl} target="_blank" rel="noopener">
            Abrir en Notas
          </a>
        )}
        <button className="btn" onClick={onDownload}>
          Descargar
        </button>
      </footer>
    </aside>
  )
}
