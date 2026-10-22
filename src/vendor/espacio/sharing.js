import {
  createAclFromFallbackAcl,
  getAgentAccessAll,
  getAgentDefaultAccessAll,
  getAgentResourceAccessAll,
  getPublicAccess,
  getResourceAcl,
  getResourceInfoWithAcl,
  getSolidDataset,
  getThing,
  getUrlAll,
  hasAccessibleAcl,
  hasFallbackAcl,
  hasResourceAcl,
  saveAclFor,
  setAgentDefaultAccess,
  setAgentResourceAccess,
  setPublicDefaultAccess,
  setPublicResourceAccess,
} from '@inrupt/solid-client'
import { ArchivosError } from '../../pod/errores.js'

/**
 * Compartir un archivo o una carpeta del pod (ver ADR-009).
 *
 * El servidor habla WAC, y se usa la API WAC de solid-client directamente, no
 * `universalAccess`: en WAC éste solo escribe `acl:accessTo`, y compartir la
 * carpeta `Fotografías/` daría acceso a la lista de nombres pero no a las
 * fotos. En una carpeta hace falta además `acl:default`.
 *
 * Como `operations.js`, todo recibe `fetch` inyectado y nada decide aquí qué
 * URL puede tocarse.
 */

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const FOAF_PERSON = 'http://xmlns.com/foaf/0.1/Person'

const NONE = { read: false, append: false, write: false, control: false }

/** Modos que se ofrecen a terceros. `control` nunca: solo el dueño gestiona. */
export const MODES = {
  ver: { read: true, append: false, write: false, control: false },
  editar: { read: true, append: true, write: true, control: false },
}

const USERNAME = /^[a-z0-9][a-z0-9._-]*$/i

/**
 * Convierte lo que escribió el socio —un nombre de usuario o un WebID
 * completo— en un WebID verificado.
 *
 * `fetch` aquí es el global, sin sesión: el perfil de otro socio está fuera
 * del pod propio y es público por diseño.
 *
 * @returns {Promise<string>} el WebID
 */
export async function resolveWebId(input, { issuer, fetch }) {
  const text = String(input ?? '').trim()
  if (!text) throw new ArchivosError('EspacioInvalidPerson', 'Escribe un nombre de usuario.')

  let webId
  if (/^https:\/\//i.test(text)) {
    try {
      webId = new URL(text).href
    } catch {
      throw new ArchivosError('EspacioInvalidPerson', `"${text}" no es un WebID válido.`)
    }
  } else if (USERNAME.test(text)) {
    webId = new URL(`${text}/profile/card#me`, issuer).href
  } else {
    throw new ArchivosError('EspacioInvalidPerson', `"${text}" no es un nombre de usuario válido.`)
  }

  let profile
  try {
    profile = await getSolidDataset(webId.split('#')[0], { fetch })
  } catch (err) {
    const status = err?.response?.status ?? err?.statusCode
    if (status === 404) throw new ArchivosError('EspacioPersonNotFound', `No existe el usuario "${text}".`)
    throw new ArchivosError('EspacioPersonNotFound', `No se pudo leer el perfil de "${text}".`)
  }

  // Un pod de servicio no es alguien con quien compartir: solo personas.
  const person = getThing(profile, webId)
  if (!person || !getUrlAll(person, RDF_TYPE).includes(FOAF_PERSON)) {
    throw new ArchivosError('EspacioPersonNotFound', `"${text}" no es el perfil de una persona.`)
  }
  return webId
}

/** Traduce los modos WAC a lo que se muestra: `ver`, `editar` u `otro`. */
function modeOf(access) {
  if (access.write) return 'editar'
  if (access.read) return 'ver'
  return 'otro'
}

/**
 * Quién tiene acceso a `url`, sin contar a quienes lo gestionan.
 *
 * Los dueños son todos los agentes con `control`, no solo el socio: en otro
 * pod de su cuenta (p. ej. `tecnocoop/`) el `.acl` nombra al WebID de ese pod,
 * y el socio gestiona por la cuenta de CSS.
 *
 * `inherited` avisa que no hay ACL propio: lo que se ve viene de una carpeta
 * de más arriba, y cambiarlo aquí crea uno propio a partir de ése.
 */
export async function getSharing(url, { fetch, ownerWebId }) {
  const resource = await getResourceInfoWithAcl(url, { fetch })
  if (!hasAccessibleAcl(resource) || !(hasResourceAcl(resource) || hasFallbackAcl(resource))) {
    throw new ArchivosError('EspacioShareForbidden', 'No tienes permiso para gestionar el acceso a este recurso.')
  }
  const all = getAgentAccessAll(resource) ?? {}
  const agents = Object.entries(all)
    .filter(
      ([webId, access]) =>
        webId !== ownerWebId && !access.control && (access.read || access.append || access.write),
    )
    .map(([webId, access]) => ({ webId, mode: modeOf(access) }))
    .sort((a, b) => a.webId.localeCompare(b.webId))
  return {
    agents,
    isPublic: Boolean(getPublicAccess(resource)?.read),
    inherited: !hasResourceAcl(resource),
  }
}

/** Agentes con `control` sobre el recurso (y, en una carpeta, también por defecto). */
function controllers(acl, isContainer) {
  const onResource = Object.entries(getAgentResourceAccessAll(acl))
    .filter(([, access]) => access.control)
    .map(([webId]) => webId)
  if (!isContainer) return new Set(onResource)
  const byDefault = getAgentDefaultAccessAll(acl)
  return new Set(onResource.filter((webId) => byDefault[webId]?.control))
}

/**
 * Lee el ACL de `url` (o arma uno propio desde el heredado), le aplica
 * `change` y lo guarda — pero solo si nadie que lo gestionaba pierde el
 * `control`, y queda al menos alguien que lo gestione. Un ACL sin nadie con
 * `control` no tiene vuelta atrás desde la app.
 *
 * No se exige que el socio figure en el ACL: en otro pod de su cuenta el
 * dueño es el WebID de ese pod, y el socio gestiona por la cuenta de CSS.
 */
async function withAcl(url, { fetch, isContainer }, change) {
  const resource = await getResourceInfoWithAcl(url, { fetch })
  if (!hasAccessibleAcl(resource)) {
    throw new ArchivosError('EspacioShareForbidden', 'No tienes permiso para gestionar el acceso a este recurso.')
  }

  let acl
  if (hasResourceAcl(resource)) acl = getResourceAcl(resource)
  else if (hasFallbackAcl(resource)) acl = createAclFromFallbackAcl(resource)
  else {
    throw new ArchivosError('EspacioShareForbidden', 'No se pudo leer el acceso actual de este recurso.')
  }

  const updated = change(acl, {
    agent: (webId, access) => {
      let next = setAgentResourceAccess(acl, webId, access)
      if (isContainer) next = setAgentDefaultAccess(next, webId, access)
      return next
    },
  })

  const before = controllers(acl, isContainer)
  const after = controllers(updated, isContainer)
  if (after.size === 0 || [...before].some((webId) => !after.has(webId))) {
    throw new ArchivosError(
      'EspacioShareUnsafe',
      'El cambio dejaría sin control a quien gestiona este recurso; no se guardó.',
    )
  }

  await saveAclFor(resource, updated, { fetch })
}

function assertMode(mode) {
  if (!Object.hasOwn(MODES, mode)) throw new ArchivosError('EspacioInvalidMode', `Modo desconocido: ${mode}`)
}

/** Da acceso a una persona. En una carpeta, también a todo lo que contiene. */
export async function shareWith(url, webId, mode, options) {
  assertMode(mode)
  if (webId === options.ownerWebId) {
    throw new ArchivosError('EspacioInvalidPerson', 'Ya tienes acceso: es tu pod.')
  }
  await withAcl(url, options, (acl, { agent }) => agent(webId, MODES[mode]))
}

/** Quita todo acceso de una persona. */
export async function unshareWith(url, webId, options) {
  if (webId === options.ownerWebId) {
    throw new ArchivosError('EspacioShareUnsafe', 'No puedes quitarte el acceso a ti.')
  }
  await withAcl(url, options, (acl, { agent }) => agent(webId, NONE))
}

/**
 * Enlace público: lectura para cualquiera que tenga la URL. En una carpeta
 * eso incluye la lista de nombres de lo que contiene.
 */
export async function setPublic(url, isPublic, options) {
  const access = isPublic ? MODES.ver : NONE
  await withAcl(url, options, (acl) => {
    let next = setPublicResourceAccess(acl, access)
    if (options.isContainer) next = setPublicDefaultAccess(next, access)
    return next
  })
}
