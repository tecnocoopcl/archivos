import { useCallback, useEffect, useRef, useState } from 'react'
import { acceso, compartir, dejarDeCompartir, hacerPublico, resolverPersona } from '../pod/archivos.js'
import { resultado } from './resultado.js'

const MODE_LABEL = { ver: 'Puede ver', editar: 'Puede editar', otro: 'Acceso parcial' }

/** `…/bea/profile/card#me` → `bea`; cualquier otro WebID se muestra entero. */
export function personLabel(webId) {
  return /\/([^/]+)\/profile\/card#me$/.exec(webId)?.[1] ?? webId
}

/**
 * Diálogo para compartir un archivo o una carpeta: dar acceso a un socio por
 * su nombre de usuario, quitarlo, y activar el enlace público (ver ADR-009).
 */
export default function ShareDialog({ entry, displayName, onClose }) {
  const ref = useRef(/** @type {HTMLDialogElement|null} */ (null))
  const [sharing, setSharing] = useState(/** @type {{ agents: { webId: string, mode: string }[], isPublic: boolean, inherited: boolean } | null} */ (null))
  const [person, setPerson] = useState('')
  const [mode, setMode] = useState(/** @type {'ver'|'editar'} */ ('ver'))
  // Qué operación está en curso: 'public', 'share', el webId que se está
  // quitando, o null. Sirve para deshabilitar solo lo que corresponde y
  // mostrar una leyenda junto al control, no un `busy` global mudo.
  const [pending, setPending] = useState(/** @type {string|null} */ (null))
  const [error, setError] = useState(/** @type {string|null} */ (null))
  // Resultado del último "Compartir": a quién se avisó y a quién no todavía.
  const [notice, setNotice] = useState(/** @type {string|null} */ (null))
  const [copied, setCopied] = useState(false)
  // El enlace público tarda un rato en confirmarse (reescribe el ACL en el
  // servidor): el checkbox se adelanta a eso para no sentirse trabado, y se
  // corrige solo si el servidor termina diciendo otra cosa.
  const [optimisticPublic, setOptimisticPublic] = useState(/** @type {boolean|null} */ (null))

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  const reload = useCallback(async () => {
    const result = await resultado(() => acceso(entry))
    if (!result.ok) {
      setError(result.error?.message ?? 'No se pudo leer quién tiene acceso.')
      return
    }
    setSharing(result.value ?? null)
  }, [entry])

  useEffect(() => {
    reload()
  }, [reload])

  // Ya llegó la respuesta real del servidor: el optimismo del checkbox deja
  // de hacer falta (tanto si confirmó el cambio como si no había ninguno).
  useEffect(() => {
    setOptimisticPublic(null)
  }, [sharing?.isPublic])

  /**
   * Ejecuta un cambio de acceso y vuelve a leer el estado real del servidor.
   * `key` identifica qué fila/control queda deshabilitado mientras tanto.
   */
  const run = useCallback(
    async (action, failure, key) => {
      setPending(key)
      setError(null)
      const result = await action()
      if (!result.ok) setError(result.error?.message ?? failure)
      await reload()
      setPending(null)
      return result.ok
    },
    [reload],
  )

  /**
   * Comparte con una o varias personas a la vez ("bea, ana pedro"): así se
   * le presenta una carpeta a varios socios de una sola vez. Cada una se
   * resuelve y se comparte por separado; un nombre mal escrito no frena a
   * los demás.
   */
  const onShare = async (event) => {
    event.preventDefault()
    const names = [...new Set(person.split(/[\s,;]+/).filter(Boolean))]
    if (names.length === 0) return
    setPending('share')
    setError(null)
    setNotice(null)
    const notified = []
    const later = []
    const failed = []
    for (const name of names) {
      const resolved = await resultado(() => resolverPersona(name))
      if (!resolved.ok || !resolved.value) {
        failed.push(resolved.error?.message ?? `No se encontró a «${name}».`)
        continue
      }
      const result = await resultado(() => compartir(entry, resolved.value, mode))
      if (!result.ok) failed.push(`${name}: ${result.error?.message ?? 'no se pudo compartir.'}`)
      else if (result.value?.notified) notified.push(name)
      else later.push(name)
    }
    await reload()
    setPending(null)
    if (failed.length > 0) {
      setError(failed.join('\n'))
      setPerson(names.filter((name) => !notified.includes(name) && !later.includes(name)).join(', '))
    } else {
      setPerson('')
    }
    const parts = []
    if (notified.length > 0) parts.push(`${notified.join(', ')} ya ${notified.length === 1 ? 'lo ve' : 'lo ven'} en «Compartidos conmigo».`)
    if (later.length > 0) {
      parts.push(
        `${later.join(', ')} ya ${later.length === 1 ? 'tiene' : 'tienen'} acceso; le${later.length === 1 ? '' : 's'} aparecerá ` +
          'en «Compartidos conmigo» cuando abra Archivos (aquí o en espacio). Mientras, puedes mandarle el enlace.',
      )
    }
    setNotice(parts.length > 0 ? parts.join(' ') : null)
  }

  const onTogglePublic = async (event) => {
    const next = event.target.checked
    setOptimisticPublic(next)
    const ok = await run(() => resultado(() => hacerPublico(entry, next)), 'No se pudo cambiar el enlace público.', 'public')
    if (!ok) setOptimisticPublic(null)
  }

  const copyLink = async () => {
    const result = await resultado(() => navigator.clipboard.writeText(entry.url))
    if (!result.ok) {
      setError(result.error?.message ?? 'No se pudo copiar el enlace.')
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <dialog
      ref={ref}
      className="dialog archivos-share"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <h2 className="dialog__title">Compartir «{displayName}»</h2>
      {entry.isContainer && (
        <p className="archivos-share__hint">Se comparte también todo lo que contiene la carpeta.</p>
      )}

      <form className="archivos-share__add" onSubmit={onShare}>
        <input
          autoFocus
          className="archivos__inline-input archivos-share__person"
          placeholder="Usuarios, p. ej. bea, ana, pedro"
          value={person}
          onChange={(e) => setPerson(e.target.value)}
          disabled={pending === 'share'}
        />
        <select
          className="archivos__inline-input"
          value={mode}
          onChange={(e) => setMode(/** @type {'ver'|'editar'} */ (e.target.value))}
          disabled={pending === 'share'}
        >
          <option value="ver">Puede ver</option>
          <option value="editar">Puede editar</option>
        </select>
        <button className="btn btn--primary" type="submit" disabled={pending === 'share' || !person.trim()}>
          {pending === 'share' ? 'Compartiendo…' : 'Compartir'}
        </button>
      </form>

      {error && <div className="archivos__notice archivos-share__notice">{error}</div>}
      {notice && <div className="archivos-share__ok">{notice}</div>}

      <h3 className="archivos-share__heading">Personas con acceso</h3>
      {sharing === null ? (
        <p className="archivos-share__hint">Cargando…</p>
      ) : sharing.agents.length === 0 ? (
        <p className="archivos-share__hint">Solo tú.</p>
      ) : (
        <ul className="archivos-share__list">
          {sharing.agents.map((agent) => (
            <li key={agent.webId} className="archivos-share__item">
              <span className="archivos-share__who" title={agent.webId}>
                {personLabel(agent.webId)}
              </span>
              <span className="archivos-share__mode">{MODE_LABEL[agent.mode]}</span>
              <button
                className="archivos__icon-btn archivos__icon-btn--danger"
                disabled={pending === agent.webId}
                onClick={() =>
                  run(() => resultado(() => dejarDeCompartir(entry, agent.webId)), 'No se pudo quitar el acceso.', agent.webId)
                }
              >
                {pending === agent.webId ? 'Quitando…' : 'Quitar'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {sharing?.inherited && sharing.agents.length > 0 && (
        <p className="archivos-share__hint">Este acceso viene de una carpeta superior.</p>
      )}

      <label className="archivos-share__public">
        <input
          type="checkbox"
          checked={optimisticPublic ?? sharing?.isPublic ?? false}
          disabled={sharing === null}
          onChange={onTogglePublic}
        />
        <span>
          <strong>Enlace público</strong>
          {pending === 'public' && <span className="archivos-share__applying"> — Aplicando cambios…</span>}
          <br />
          <span className="archivos-share__hint">
            Cualquiera con el enlace puede ver esto
            {entry.isContainer ? ', incluida la lista de lo que contiene' : ''}.
          </span>
        </span>
      </label>

      <div className="dialog__actions archivos-share__actions">
        <button className="btn" onClick={copyLink}>
          {copied ? 'Enlace copiado' : 'Copiar enlace'}
        </button>
        <button className="btn btn--primary" onClick={onClose}>
          Listo
        </button>
      </div>
    </dialog>
  )
}
