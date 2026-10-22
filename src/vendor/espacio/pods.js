import { getSolidDataset, getThing, saveSolidDatasetAt, setThing } from '@inrupt/solid-client'
import { ArchivosError } from '../../pod/errores.js'

/**
 * Los pods que muestra Archivos: uno por cuenta del socio (ver ADR-015). Cuáles
 * son lo decide el shell, que tiene las sesiones; aquí solo se nombran.
 */

/** "Tu pod" para el principal; para los demás, el nombre de su carpeta raíz. */
export function podLabel(url, primaryUrl) {
  if (url === primaryUrl) return 'Tu pod'
  const segments = new URL(url).pathname.split('/').filter(Boolean)
  return decodeURIComponent(segments.at(-1) ?? new URL(url).host)
}

/** Lee el perfil del socio, le aplica `change` a su WebID y lo guarda si cambió. */
export async function editProfile(webId, { fetch }, change) {
  const doc = webId.split('#')[0]
  const profile = await getSolidDataset(doc, { fetch })
  const me = getThing(profile, webId)
  if (!me) throw new ArchivosError('EspacioProfile', 'No se encontró tu WebID en tu perfil.')
  const updated = change(me)
  if (updated === me) return
  await saveSolidDatasetAt(doc, setThing(profile, updated), { fetch })
}
