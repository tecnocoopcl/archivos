import React from 'react'
import ReactDOM from 'react-dom/client'

import './archivos.css'
import App from './App'
import { iniciarSesion } from './pod/solid'

// La sesión Solid se resuelve antes de montar: al volver del proveedor de
// identidad la URL trae el código de login, y hay que procesarlo una sola vez.
iniciarSesion().then((sesion) => {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App sesion={sesion} />
    </React.StrictMode>,
  )
})
