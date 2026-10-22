import { createContainerAt } from '@inrupt/solid-client'

// En espacio esto vive en operations.js, junto a las subidas con streams de
// Node. Los módulos que se copian de allá (src/vendor/espacio/) lo importan
// de aquí.

export class ArchivosError extends Error {
  constructor(name, message) {
    super(message)
    this.name = name
  }
}

/** Asegura que un contenedor exista, creándolo si el servidor responde 404. */
export async function ensureContainer(url, { fetch }) {
  const res = await fetch(url, { method: 'GET' })
  if (res.ok) return
  if (res.status !== 404) {
    throw new ArchivosError('EspacioFetchFailed', `No se pudo comprobar "${url}" (${res.status})`)
  }
  await createContainerAt(url, { fetch })
}
