import { useEffect, useState } from 'react'
import ArchivosView from './componentes/ArchivosView.jsx'
import Conectar from './componentes/Conectar.jsx'
import { usarCuenta } from './pod/archivos.js'
import { desconectar, resolverCuenta } from './pod/solid.js'
import { personLabel } from './componentes/ShareDialog.jsx'

/**
 * Sin sesión, la portada para conectar. Con sesión, primero se lee el perfil
 * (pods y servidor de la cooperativa) y después se monta el gestor.
 */
export default function App({ sesion }) {
  const [cuenta, setCuenta] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!sesion.conectada) return
    let cancelado = false
    resolverCuenta(sesion.webId)
      .then((c) => {
        if (cancelado) return
        usarCuenta(c)
        setCuenta(c)
      })
      .catch((err) => !cancelado && setError(err.message || 'No se pudo leer tu perfil.'))
    return () => {
      cancelado = true
    }
  }, [sesion.conectada, sesion.webId])

  const salir = async () => {
    await desconectar()
    window.location.assign('/')
  }

  if (!sesion.conectada) return <Conectar />

  return (
    <div className="app">
      <header className="app__bar">
        <a className="app__brand" href="/">
          <img src="/favicon.svg" alt="" width="22" height="22" />
          Archivos
        </a>
        <span className="app__who" title={sesion.webId}>
          {personLabel(sesion.webId)}
        </span>
        <button className="archivos__icon-btn" onClick={salir}>
          Salir
        </button>
      </header>
      <main className="app__main">
        {error ? (
          <div className="archivos__empty">{error}</div>
        ) : !cuenta ? (
          <div className="archivos__empty">Cargando tu pod…</div>
        ) : (
          <ArchivosView cuenta={cuenta} />
        )}
      </main>
    </div>
  )
}
