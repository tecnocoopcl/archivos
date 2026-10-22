// La carpeta abierta va en la URL, para poder recargar o compartir el enlace
// con uno mismo:
//
//   /                         raíz del pod principal
//   /Documentos/Fotos/        una carpeta del pod principal (segmentos tal como en el pod)
//   /?u=<url>                 una carpeta de otro pod (propio o compartido)
//   /?ver=conmigo | por-mi    «Compartidos conmigo» / «Compartido por mí»
//
// GitHub Pages sirve 404.html (una copia de index.html) para las rutas que no
// existen, así que cualquier /<carpeta>/ carga la app.

export const SECCIONES = { conmigo: 'shared-with-me', 'por-mi': 'shared-by-me' }

/** @returns {{ section: 'pod' } & { url?: string } | { section: 'shared-with-me' | 'shared-by-me' }} */
export function leerRuta(primaryUrl, location = window.location) {
  const params = new URLSearchParams(location.search)
  const ver = params.get('ver')
  if (ver && SECCIONES[ver]) return { section: SECCIONES[ver] }
  const u = params.get('u')
  if (u) {
    try {
      const url = new URL(u)
      if (url.protocol === 'https:') return { section: 'pod', url: conBarra(url.href) }
    } catch {
      // Una URL rota en el enlace: se abre la raíz.
    }
  }
  const path = location.pathname.replace(/^\/+/, '')
  return { section: 'pod', url: path ? conBarra(new URL(path, primaryUrl).href) : primaryUrl }
}

export function rutaDe(state, primaryUrl) {
  if (state.section === 'shared-with-me') return '/?ver=conmigo'
  if (state.section === 'shared-by-me') return '/?ver=por-mi'
  if (!state.url || state.url === primaryUrl) return '/'
  if (state.url.startsWith(primaryUrl)) return `/${state.url.slice(primaryUrl.length)}`
  return `/?u=${encodeURIComponent(state.url)}`
}

/** Cambia la URL si hace falta. `replace` para no llenar el historial (la primera carga). */
export function irA(state, primaryUrl, { replace = false } = {}) {
  const destino = rutaDe(state, primaryUrl)
  if (destino === window.location.pathname + window.location.search) return
  window.history[replace ? 'replaceState' : 'pushState'](null, '', destino)
}

const conBarra = (url) => (url.endsWith('/') ? url : `${url}/`)
