import {
  login,
  logout,
  handleIncomingRedirect,
  getDefaultSession,
  fetch as solidFetch,
} from '@inrupt/solid-client-authn-browser'
import { getPodUrlAll, getSolidDataset, getThing, getUrl, getUrlAll } from '@inrupt/solid-client'
import { podLabel } from '../vendor/espacio/pods.js'

// Sesión Solid propia, como notas y música sueltas. A diferencia de ellas,
// Archivos no se aloja dentro de espacio: allá es una vista nativa del shell
// (ADR-005 de espacio), porque ninguna mini-app en iframe recibe alcance
// sobre todo el pod. Esta versión es para cuando no se tiene el escritorio.

export const PROVEEDOR_POR_DEFECTO = 'https://pods-rpi-tc.aebn.cl'

const SOLID_OIDC_ISSUER = 'http://www.w3.org/ns/solid/terms#oidcIssuer'
const VOLVER_KEY = 'archivos-volver-a'

/** Orígenes a los que se manda la sesión: el proveedor y los pods propios. */
const confiables = new Set()

/**
 * `fetch` con la sesión del socio, pero solo dentro de la cooperativa: una
 * notificación del buzón o un enlace de un Markdown pueden apuntar a
 * cualquier lado, y la sesión no debe salir de ahí. Es el equivalente web del
 * broker de espacio (más amplio: todo el servidor, no solo el pod propio,
 * porque también se leen las carpetas que comparten otros socios).
 */
export function podFetch(input, init) {
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.href)
  if (!confiables.has(url.origin)) {
    return Promise.reject(new Error(`${url.origin} está fuera del servidor de tu pod.`))
  }
  return solidFetch(input, init)
}

/** `fetch` sin sesión, para perfiles ajenos (son públicos). */
export const fetchPublico = (input, init) => window.fetch(input, init)

export function sesionActual() {
  const { info } = getDefaultSession()
  return { conectada: info.isLoggedIn, webId: info.isLoggedIn ? info.webId : null }
}

// Se llama una vez antes de montar la app: completa el login si volvemos del
// proveedor, o restaura la sesión anterior.
export async function iniciarSesion() {
  try {
    await handleIncomingRedirect({
      restorePreviousSession: true,
      onSessionRestore: (url) => volverA(new URL(url)),
    })
  } catch (err) {
    console.warn(`No se pudo restaurar la sesión Solid: ${err.message}`)
  }
  const pendiente = sessionStorage.getItem(VOLVER_KEY)
  if (pendiente) {
    sessionStorage.removeItem(VOLVER_KEY)
    volverA(new URL(pendiente, window.location.origin))
  }
  return sesionActual()
}

function volverA(url) {
  const destino = url.pathname + url.search
  if (destino !== window.location.pathname + window.location.search) window.history.replaceState(null, '', destino)
}

// Acepta un WebID (https://…/profile/card#me) o directamente la URL del
// proveedor. Con un WebID, el proveedor sale de solid:oidcIssuer del perfil.
export async function resolverProveedor(entrada) {
  const valor = entrada.trim()
  const url = new URL(valor.includes('://') ? valor : `https://${valor}`)
  if (!url.hash) return url.origin

  const perfil = await getSolidDataset(url.href, { fetch: fetchPublico })
  const yo = getThing(perfil, url.href)
  const [proveedor] = yo ? getUrlAll(yo, SOLID_OIDC_ISSUER) : []
  if (!proveedor) throw new Error('Ese WebID no declara un proveedor de identidad (solid:oidcIssuer).')
  return proveedor
}

export async function conectar(oidcIssuer) {
  // Siempre se vuelve a la raíz (es index.html en GitHub Pages) y desde ahí a
  // la carpeta en que estaba, para no depender de 404.html en el callback.
  sessionStorage.setItem(VOLVER_KEY, window.location.pathname + window.location.search)
  await login({
    oidcIssuer,
    redirectUrl: `${window.location.origin}/`,
    clientName: 'Archivos',
  })
}

export async function desconectar() {
  await logout()
}

const conBarra = (url) => (url.endsWith('/') ? url : `${url}/`)

/**
 * Lo que hace falta saber del socio para usar su pod: sus pods (pim:storage,
 * el primero es el principal) y el servidor de la cooperativa (su
 * solid:oidcIssuer), que es donde se buscan los usuarios al compartir.
 *
 * @returns {Promise<{ webId: string, issuer: string, pods: { url: string, label: string, primary: boolean }[] }>}
 */
export async function resolverCuenta(webId) {
  const perfil = await getSolidDataset(webId, { fetch: solidFetch })
  const yo = getThing(perfil, webId)
  const issuer = conBarra((yo && getUrl(yo, SOLID_OIDC_ISSUER)) || new URL(webId).origin)
  const urls = (await getPodUrlAll(webId, { fetch: solidFetch, webIdProfile: perfil })).map(conBarra)
  if (urls.length === 0) {
    throw new Error(`El perfil ${webId} no declara pim:storage; no se sabe dónde está tu pod.`)
  }
  confiables.clear()
  confiables.add(new URL(issuer).origin)
  for (const url of urls) confiables.add(new URL(url).origin)
  return {
    webId,
    issuer,
    pods: urls.map((url) => ({ url, label: podLabel(url, urls[0]), primary: url === urls[0] })),
  }
}
