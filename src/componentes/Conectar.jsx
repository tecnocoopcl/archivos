import { useState } from 'react'
import { PROVEEDOR_POR_DEFECTO, conectar, resolverProveedor } from '../pod/solid.js'

/** Portada sin sesión: conectar con un WebID o un proveedor de identidad. */
export default function Conectar() {
  const [entrada, setEntrada] = useState(PROVEEDOR_POR_DEFECTO)
  const [estado, setEstado] = useState({ enviando: false, error: null })

  async function onSubmit(event) {
    event.preventDefault()
    setEstado({ enviando: true, error: null })
    try {
      await conectar(await resolverProveedor(entrada))
      // login() redirige al proveedor; si vuelve aquí, algo falló.
    } catch (err) {
      setEstado({ enviando: false, error: err.message || 'No se pudo conectar.' })
    }
  }

  return (
    <div className="portada">
      <form className="portada__card" onSubmit={onSubmit}>
        <img src="/favicon.svg" alt="" width="48" height="48" />
        <h1 className="portada__title">Archivos</h1>
        <p className="portada__text">
          Los archivos de <strong>tu propio Solid Pod</strong>, desde el navegador: navegar, subir, bajar, ver y
          compartir. Nada se guarda en este sitio.
        </p>
        <label className="portada__label" htmlFor="conectar-entrada">
          Tu WebID o proveedor de identidad
        </label>
        <input
          id="conectar-entrada"
          className="archivos__inline-input portada__input"
          type="text"
          inputMode="url"
          autoComplete="url"
          spellCheck="false"
          required
          value={entrada}
          onChange={(e) => setEntrada(e.target.value)}
        />
        {estado.error && (
          <p className="portada__error" role="alert">
            {estado.error}
          </p>
        )}
        <button type="submit" className="btn btn--primary portada__submit" disabled={estado.enviando}>
          {estado.enviando ? 'Conectando…' : 'Conectar'}
        </button>
        <p className="portada__hint">
          ¿Tienes espacio instalado? Ahí Archivos además sincroniza carpetas con tu equipo.
        </p>
      </form>
    </div>
  )
}
