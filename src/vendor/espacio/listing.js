import {
  getContainedResourceUrlAll,
  getDatetime,
  getInteger,
  getSolidDataset,
  getThing,
  getUrlAll,
} from '@inrupt/solid-client'
import { displayName, looksLikeContainer, mediaTypeFromRdfTypes } from './paths.js'

const LDP = 'http://www.w3.org/ns/ldp#'
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const POSIX_SIZE = 'http://www.w3.org/ns/posix/stat#size'
const DCTERMS_MODIFIED = 'http://purl.org/dc/terms/modified'

/**
 * Lista el contenido de un contenedor del pod.
 *
 * Contenedor vs. recurso se decide por `rdf:type ldp:Container` en el propio
 * documento del contenedor — es lo que CSS incluye junto a cada `ldp:contains` —
 * y solo si esa información no está presente se cae a la convención de la barra
 * final. Fijarse solo en la barra sería más simple pero menos correcto: es una
 * convención, no una garantía del protocolo.
 *
 * @param {string} containerUrl
 * @param {{ fetch: typeof fetch }} options
 * @returns {Promise<import('./index.d.ts').Entry[]>}
 */
export async function listContainer(containerUrl, { fetch }) {
  const dataset = await getSolidDataset(containerUrl, { fetch })
  const childUrls = getContainedResourceUrlAll(dataset)

  return childUrls.map((url) => {
    const thing = getThing(dataset, url)
    const types = thing ? getUrlAll(thing, RDF_TYPE) : []
    const isContainer =
      types.includes(`${LDP}Container`) || types.includes(`${LDP}BasicContainer`) || looksLikeContainer(url)

    /** @type {import('./index.d.ts').Entry} */
    const entry = { url, name: displayName(url), isContainer }

    if (thing && !isContainer) {
      const size = getInteger(thing, POSIX_SIZE)
      if (size !== null) entry.size = size

      const modified = getDatetime(thing, DCTERMS_MODIFIED)
      if (modified) entry.modifiedAt = modified.toISOString()

      // Un recurso sin extensión — el README que CSS deja en la raíz de cada
      // pod, por ejemplo — puede declarar igual su tipo real por un rdf:type
      // IANA. Sin esto se vería como binario, tanto en la columna "Tipo" como
      // al decidir si se puede abrir en escribir.
      const mediaType = mediaTypeFromRdfTypes(types)
      if (mediaType) entry.mediaType = mediaType
    }

    return entry
  })
}
