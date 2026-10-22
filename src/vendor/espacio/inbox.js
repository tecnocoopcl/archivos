import {
  deleteFile,
  getContainedResourceUrlAll,
  getDatetime,
  getSolidDataset,
  getStringNoLocale,
  getThing,
  getThingAll,
  getUrl,
  getUrlAll,
  setUrl,
} from '@inrupt/solid-client'
import { displayName, looksLikeContainer } from './paths.js'
import { ArchivosError, ensureContainer } from '../../pod/errores.js'
import { editProfile } from './pods.js'

/**
 * "Compartidos conmigo" (ver ADR-014).
 *
 * Solid no tiene un índice de lo que otros comparten con uno. Lo estándar es
 * el buzón (`ldp:inbox`, Linked Data Notifications): quien comparte deja una
 * notificación `as:Offer` en el buzón de quien recibe, y éste la lee desde su
 * propio pod. Los perfiles de la cooperativa no traían buzón; espacio lo crea
 * la primera vez que el socio abre Archivos.
 *
 * Como `operations.js`, todo recibe su E/S inyectada.
 */

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const LDP_INBOX = 'http://www.w3.org/ns/ldp#inbox'
const LDP_CONTAINER = 'http://www.w3.org/ns/ldp#Container'
const AS = 'https://www.w3.org/ns/activitystreams#'

const ttlString = (value) => JSON.stringify(String(value))

/** URL del ACL de un recurso, por su cabecera `Link: <…>; rel="acl"`. */
async function aclUrlOf(url, { fetch }) {
  const res = await fetch(url, { method: 'HEAD' })
  const link = res.headers.get('link') ?? ''
  const match = /<([^>]+)>\s*;\s*rel="?acl"?/i.exec(link)
  if (!match) throw new ArchivosError('EspacioInbox', 'El servidor no anuncia dónde está el ACL del buzón.')
  return new URL(match[1], url).href
}

/**
 * ACL del buzón: el socio lo gestiona; cualquier usuario con sesión del
 * servidor puede dejar una notificación (Append), pero no leer ni borrar las
 * que hay. Las notificaciones heredan solo la regla del dueño (`acl:default`).
 */
export function inboxAcl(inboxUrl, webId) {
  return `@prefix acl: <http://www.w3.org/ns/auth/acl#>.

<#dueno> a acl:Authorization;
  acl:agent <${webId}>;
  acl:accessTo <${inboxUrl}>;
  acl:default <${inboxUrl}>;
  acl:mode acl:Read, acl:Write, acl:Append, acl:Control.

<#socios> a acl:Authorization;
  acl:agentClass acl:AuthenticatedAgent;
  acl:accessTo <${inboxUrl}>;
  acl:mode acl:Append.
`
}

/**
 * Asegura que el socio tenga buzón: el contenedor `inbox/` de su pod
 * principal, con su ACL, declarado en el perfil como `ldp:inbox`. Si el
 * perfil ya declara uno, se usa ése tal cual.
 *
 * @returns {Promise<string>} la URL del buzón
 */
export async function ensureInbox(webId, { fetch, primaryUrl }) {
  const profile = await getSolidDataset(webId.split('#')[0], { fetch })
  const me = getThing(profile, webId)
  const declared = me ? getUrl(me, LDP_INBOX) : null
  if (declared) return declared

  const inboxUrl = new URL('inbox/', primaryUrl).href
  await ensureContainer(inboxUrl, { fetch })
  const aclUrl = await aclUrlOf(inboxUrl, { fetch })
  const res = await fetch(aclUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/turtle' },
    body: inboxAcl(inboxUrl, webId),
  })
  if (!res.ok) throw new ArchivosError('EspacioInbox', `No se pudo preparar tu buzón (${res.status}).`)

  await editProfile(webId, { fetch }, (thing) => setUrl(thing, LDP_INBOX, inboxUrl))
  return inboxUrl
}

/**
 * El buzón de otra persona, según su perfil público. `null` si no tiene —o
 * declara uno fuera de su servidor, que no se acepta: la notificación se
 * manda con la sesión del socio y no debe salir de la cooperativa.
 *
 * `fetch` es el global, sin sesión: el perfil ajeno es público.
 */
export async function findInbox(webId, { fetch }) {
  const profile = await getSolidDataset(webId.split('#')[0], { fetch })
  const person = getThing(profile, webId)
  const inbox = person ? getUrl(person, LDP_INBOX) : null
  if (!inbox) return null
  return new URL(inbox).origin === new URL(webId).origin ? inbox : null
}

/** Notificación `as:Offer`: `actor` le comparte `entry` a `target`. */
export function offerTurtle({ actor, target, entry, published = new Date() }) {
  const type = entry.isContainer ? `<${LDP_CONTAINER}>` : `<${AS}Document>`
  return `@prefix as: <${AS}>.
@prefix xsd: <http://www.w3.org/2001/XMLSchema#>.

<> a as:Offer;
  as:actor <${actor}>;
  as:target <${target}>;
  as:object <${entry.url}>;
  as:published ${ttlString(published.toISOString())}^^xsd:dateTime.

<${entry.url}> a ${type};
  as:name ${ttlString(entry.name)}.
`
}

/**
 * Avisa a `target` que se le compartió `entry`. Devuelve `false` si esa
 * persona todavía no tiene buzón (no ha abierto una versión de espacio que lo
 * cree): quien comparte lo reintenta más tarde (ver `shared.js`).
 *
 * @param {object} deps
 * @param {typeof fetch} deps.publicFetch - para leer el perfil ajeno
 * @param {(inboxUrl: string, turtle: string) => Promise<Response>} deps.post - POST con la sesión
 */
export async function notifyShare({ actor, target, entry }, { publicFetch, post }) {
  const inbox = await findInbox(target, { fetch: publicFetch })
  if (!inbox) return false
  const res = await post(inbox, offerTurtle({ actor, target, entry }))
  if (!res.ok) throw new ArchivosError('EspacioNotify', `No se pudo avisar (${res.status}).`)
  return true
}

/**
 * ¿Puede espacio pedir `object` con la sesión del socio? Solo dentro del
 * servidor de la cooperativa: una notificación la puede dejar cualquiera, y
 * una URL a otro servidor se llevaría el token del socio.
 */
function acceptable(object, issuer) {
  try {
    const url = new URL(object)
    return url.protocol === 'https:' && url.origin === new URL(issuer).origin
  } catch {
    return false
  }
}

/** Lee una notificación. `null` si no es un `as:Offer` válido. */
export function parseOffer(dataset, notificationUrl, issuer) {
  const offer = getThingAll(dataset).find((thing) => getUrlAll(thing, RDF_TYPE).includes(`${AS}Offer`))
  if (!offer) return null
  const object = getUrl(offer, `${AS}object`)
  const actor = getUrl(offer, `${AS}actor`)
  if (!object || !actor || !acceptable(object, issuer)) return null
  const described = getThing(dataset, object)
  const types = described ? getUrlAll(described, RDF_TYPE) : []
  return {
    notification: notificationUrl,
    url: object,
    name: (described && getStringNoLocale(described, `${AS}name`)) || displayName(object),
    isContainer: types.includes(LDP_CONTAINER) || looksLikeContainer(object),
    from: actor,
    sharedAt: getDatetime(offer, `${AS}published`)?.toISOString(),
  }
}

/**
 * Lo compartido con el socio, leído de su buzón: lo más reciente primero, una
 * vez por recurso aunque se haya avisado varias veces. Lo que no se puede
 * leer o no es un `as:Offer` se ignora.
 */
export async function listSharedWithMe(inboxUrl, { fetch, issuer }) {
  const inbox = await getSolidDataset(inboxUrl, { fetch })
  const urls = getContainedResourceUrlAll(inbox)
  const offers = await Promise.all(
    urls.map(async (url) => {
      try {
        return parseOffer(await getSolidDataset(url, { fetch }), url, issuer)
      } catch {
        return null
      }
    }),
  )
  const byUrl = new Map()
  for (const offer of offers) {
    if (!offer) continue
    const { notification, ...item } = offer
    const known = byUrl.get(item.url)
    const notifications = [...(known?.notifications ?? []), notification]
    // De varios avisos por lo mismo manda el más reciente (nombre y fecha).
    const newest = !known || (item.sharedAt ?? '') > (known.sharedAt ?? '') ? item : known
    byUrl.set(item.url, { ...newest, notifications })
  }
  return [...byUrl.values()].sort((a, b) => (b.sharedAt ?? '').localeCompare(a.sharedAt ?? ''))
}

/** Quita algo de "Compartidos conmigo": borra sus notificaciones del buzón. */
export async function dismissShared(notifications, { fetch }) {
  for (const url of notifications) await deleteFile(url, { fetch })
}
