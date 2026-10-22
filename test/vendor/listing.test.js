import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildThing,
  createSolidDataset,
  createThing,
  setThing,
  solidDatasetAsTurtle,
} from '@inrupt/solid-client'
import { listContainer } from '../../src/vendor/espacio/listing.js'

const CONTAINER = 'https://pods-rpi-tc.aebn.cl/usuario-aebn/archivos/'

/** Construye un contenedor de prueba con la API real de solid-client, y un
 * `fetch` falso que lo sirve como Turtle — así el test ejercita el mismo
 * parseo RDF que hablará con un servidor real. */
async function fakeContainer({ children = [], containerThings = [], resourceThings = [] } = {}) {
  let dataset = createSolidDataset()

  const containerThing = buildThing(createThing({ url: CONTAINER }))
  let built = containerThing
  for (const child of children) built = built.addUrl('http://www.w3.org/ns/ldp#contains', child)
  dataset = setThing(dataset, built.build())

  for (const thing of [...containerThings, ...resourceThings]) {
    dataset = setThing(dataset, thing)
  }

  const turtle = await solidDatasetAsTurtle(dataset)
  // getSolidDataset identifica el contenedor por `response.url`, como haría un
  // fetch real (y que puede diferir de la URL pedida si hubo redirección). Un
  // Response construido a mano no lo trae, así que se redefine para que el
  // fake se comporte como el fetch real que está sustituyendo.
  const fetch = async (requestedUrl) => {
    const response = new Response(turtle, { status: 200, headers: { 'content-type': 'text/turtle' } })
    Object.defineProperty(response, 'url', { value: String(requestedUrl), configurable: true })
    return response
  }
  return fetch
}

describe('listContainer', () => {
  it('distingue contenedores de recursos por rdf:type, no por la barra', async () => {
    const folderUrl = `${CONTAINER}fotos-especial`
    const fileUrl = `${CONTAINER}nota.txt`
    const folder = buildThing(createThing({ url: folderUrl }))
      .addUrl('http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'http://www.w3.org/ns/ldp#Container')
      .build()

    const fetch = await fakeContainer({
      children: [folderUrl, fileUrl],
      containerThings: [folder],
    })

    const entries = await listContainer(CONTAINER, { fetch })
    const byUrl = Object.fromEntries(entries.map((e) => [e.url, e]))

    // Sin barra final, pero tipado como Container: debe leerse correctamente.
    assert.equal(byUrl[folderUrl].isContainer, true)
    assert.equal(byUrl[fileUrl].isContainer, false)
  })

  it('cae a la barra final cuando no hay rdf:type declarado', async () => {
    const folderUrl = `${CONTAINER}sin-tipo/`
    const fetch = await fakeContainer({ children: [folderUrl] })
    const entries = await listContainer(CONTAINER, { fetch })
    assert.equal(entries[0].isContainer, true)
  })

  it('lee tamaño y fecha de modificación de un recurso', async () => {
    const fileUrl = `${CONTAINER}acta.pdf`
    const file = buildThing(createThing({ url: fileUrl }))
      .addInteger('http://www.w3.org/ns/posix/stat#size', 40231)
      .addDatetime('http://purl.org/dc/terms/modified', new Date('2026-09-01T10:00:00Z'))
      .build()

    const fetch = await fakeContainer({ children: [fileUrl], resourceThings: [file] })
    const [entry] = await listContainer(CONTAINER, { fetch })

    assert.equal(entry.size, 40231)
    assert.equal(entry.modifiedAt, '2026-09-01T10:00:00.000Z')
  })

  it('un contenedor no lleva tamaño ni fecha, aunque el documento los declare', async () => {
    const folderUrl = `${CONTAINER}fotos/`
    const folder = buildThing(createThing({ url: folderUrl }))
      .addUrl('http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'http://www.w3.org/ns/ldp#Container')
      .addInteger('http://www.w3.org/ns/posix/stat#size', 4096) // tamaño del propio nodo, sin sentido para el usuario
      .build()

    const fetch = await fakeContainer({ children: [folderUrl], containerThings: [folder] })
    const [entry] = await listContainer(CONTAINER, { fetch })

    assert.equal(entry.size, undefined)
  })

  it('el nombre mostrado es el último segmento, decodificado', async () => {
    const fileUrl = `${CONTAINER}${encodeURIComponent('acta de asamblea.pdf')}`
    const fetch = await fakeContainer({ children: [fileUrl] })
    const [entry] = await listContainer(CONTAINER, { fetch })
    assert.equal(entry.name, 'acta de asamblea.pdf')
  })

  it('expone el tipo IANA de un recurso sin extensión (el README de la raíz de un pod)', async () => {
    const fileUrl = `${CONTAINER}README`
    const file = buildThing(createThing({ url: fileUrl }))
      .addUrl('http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'http://www.w3.org/ns/iana/media-types/text/markdown#Resource')
      .addInteger('http://www.w3.org/ns/posix/stat#size', 1025)
      .build()

    const fetch = await fakeContainer({ children: [fileUrl], resourceThings: [file] })
    const [entry] = await listContainer(CONTAINER, { fetch })

    assert.equal(entry.mediaType, 'text/markdown')
  })

  it('un recurso con extensión no necesita el tipo IANA: no se expone si no está', async () => {
    const fileUrl = `${CONTAINER}acta.pdf`
    const file = buildThing(createThing({ url: fileUrl }))
      .addInteger('http://www.w3.org/ns/posix/stat#size', 40231)
      .build()

    const fetch = await fakeContainer({ children: [fileUrl], resourceThings: [file] })
    const [entry] = await listContainer(CONTAINER, { fetch })

    assert.equal(entry.mediaType, undefined)
  })

  it('un contenedor vacío da una lista vacía', async () => {
    const fetch = await fakeContainer({ children: [] })
    assert.deepEqual(await listContainer(CONTAINER, { fetch }), [])
  })
})
