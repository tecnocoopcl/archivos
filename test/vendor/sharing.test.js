import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ArchivosError } from '../../src/pod/errores.js'
import { getSharing, resolveWebId, setPublic, shareWith, unshareWith } from '../../src/vendor/espacio/sharing.js'

const ISSUER = 'https://pods-rpi-tc.aebn.cl/'
const POD = `${ISSUER}usuario-aebn/`
const OWNER = `${POD}profile/card#me`
const BEA = `${ISSUER}bea/profile/card#me`
const FOTOS = new URL('Fotografías/', POD).href

/** ACL de la raíz del pod, como lo deja CSS al crear la cuenta. */
const ROOT_ACL = `
@prefix acl: <http://www.w3.org/ns/auth/acl#>.
<#owner> a acl:Authorization;
  acl:agent <${OWNER}>;
  acl:accessTo <${POD}>;
  acl:default <${POD}>;
  acl:mode acl:Read, acl:Write, acl:Append, acl:Control.
`

function turtle(body, url) {
  const res = new Response(body, { status: 200, headers: { 'Content-Type': 'text/turtle' } })
  Object.defineProperty(res, 'url', { value: url })
  return res
}

/**
 * Servidor WAC falso: cada recurso anuncia su `.acl` con `Link` y los ACL
 * existentes están en `acls`. Registra las escrituras en `writes`.
 */
function fakePod(acls = { [`${POD}.acl`]: ROOT_ACL }) {
  const writes = []
  const fetch = async (input, init = {}) => {
    const url = String(input)
    const method = init.method ?? 'GET'
    if (method === 'HEAD') {
      const res = new Response(null, {
        status: 200,
        headers: {
          Link: `<${url}.acl>; rel="acl"`,
          'WAC-Allow': 'user="read write append control"',
          'Content-Type': 'text/turtle',
        },
      })
      Object.defineProperty(res, 'url', { value: url })
      return res
    }
    if (method === 'GET') {
      if (acls[url]) return turtle(acls[url], url)
      return new Response(null, { status: 404 })
    }
    if (method === 'PUT' || method === 'PATCH') {
      writes.push({ url, method, body: String(init.body) })
      return new Response(null, { status: 201 })
    }
    throw new Error(`método inesperado: ${method}`)
  }
  fetch.writes = writes
  return fetch
}

describe('shareWith', () => {
  it('en una carpeta sin ACL propio crea uno con accessTo y default para la persona y el dueño', async () => {
    const fetch = fakePod()
    await shareWith(FOTOS, BEA, 'ver', { fetch, ownerWebId: OWNER, isContainer: true })
    assert.equal(fetch.writes.length, 1)
    const [write] = fetch.writes
    assert.equal(write.url, `${FOTOS}.acl`)
    assert.match(write.body, new RegExp(BEA.replace(/[.#/]/g, '\\$&')))
    assert.match(write.body, new RegExp(OWNER.replace(/[.#/]/g, '\\$&')))
    assert.match(write.body, /default/)
    assert.match(write.body, /Control/)
  })

  it('en un archivo da acceso solo al archivo, sin regla por defecto para la persona', async () => {
    const fetch = fakePod()
    const url = `${POD}foto.jpg`
    await shareWith(url, BEA, 'editar', { fetch, ownerWebId: OWNER, isContainer: false })
    // La única regla con acl:default es la del dueño, copiada de la raíz.
    assert.equal(fetch.writes[0].body.match(/acl#default>/g).length, 1)
    const sharing = await getSharing(url, { fetch: podWith(fetch, url), ownerWebId: OWNER })
    assert.deepEqual(sharing.agents, [{ webId: BEA, mode: 'editar' }])
  })

  it('rechaza un modo desconocido o compartir consigo mismo', async () => {
    const fetch = fakePod()
    await assert.rejects(
      shareWith(FOTOS, BEA, 'control', { fetch, ownerWebId: OWNER, isContainer: true }),
      (err) => err instanceof ArchivosError && err.name === 'EspacioInvalidMode',
    )
    await assert.rejects(
      shareWith(FOTOS, OWNER, 'ver', { fetch, ownerWebId: OWNER, isContainer: true }),
      (err) => err.name === 'EspacioInvalidPerson',
    )
    assert.equal(fetch.writes.length, 0)
  })

  it('no guarda si el dueño quedaría sin control', async () => {
    // Un ACL heredado donde el dueño no figura con control.
    const fetch = fakePod({
      [`${POD}.acl`]: ROOT_ACL.replace(', acl:Control', ''),
    })
    await assert.rejects(
      shareWith(FOTOS, BEA, 'ver', { fetch, ownerWebId: OWNER, isContainer: true }),
      (err) => err.name === 'EspacioShareUnsafe',
    )
    assert.equal(fetch.writes.length, 0)
  })
})

/**
 * Vuelve a servir lo último escrito para `url` como su `.acl`, para leer de
 * vuelta el resultado de una operación. Un ACL nuevo sale como un PATCH con
 * solo `INSERT DATA { … }`: su contenido es Turtle tal cual.
 */
function podWith(fetch, url) {
  const last = fetch.writes.at(-1)
  const match = /^\s*INSERT DATA \{([\s\S]*)\};\s*$/.exec(last.body)
  assert.ok(match, 'un ACL nuevo se escribe como una sola inserción')
  return fakePod({ [`${POD}.acl`]: ROOT_ACL, [`${url}.acl`]: match[1] })
}

describe('getSharing', () => {
  it('lista a las personas sin incluir al dueño y marca lo heredado', async () => {
    const fetch = fakePod()
    const sharing = await getSharing(FOTOS, { fetch, ownerWebId: OWNER })
    assert.deepEqual(sharing, { agents: [], isPublic: false, inherited: true })
  })

  it('lee el ACL propio tras compartir, y publicar agrega la clase pública', async () => {
    const fetch = fakePod()
    await shareWith(FOTOS, BEA, 'ver', { fetch, ownerWebId: OWNER, isContainer: true })
    const shared = podWith(fetch, FOTOS)
    await setPublic(FOTOS, true, { fetch: shared, ownerWebId: OWNER, isContainer: true })
    // Sobre un ACL existente solid-client manda un PATCH; se comprueba su contenido.
    const patch = shared.writes.at(-1)
    assert.equal(patch.method, 'PATCH')
    assert.match(patch.body, /agentClass/)
    assert.match(patch.body, /foaf\/0\.1\/Agent/)

    const sharing = await getSharing(FOTOS, { fetch: podWith(fetch, FOTOS), ownerWebId: OWNER })
    assert.deepEqual(sharing, { agents: [{ webId: BEA, mode: 'ver' }], isPublic: false, inherited: false })
  })

  it('quitar a la persona escribe un cambio que la elimina', async () => {
    const fetch = fakePod()
    await shareWith(FOTOS, BEA, 'ver', { fetch, ownerWebId: OWNER, isContainer: true })
    const shared = podWith(fetch, FOTOS)
    await unshareWith(FOTOS, BEA, { fetch: shared, ownerWebId: OWNER, isContainer: true })
    const patch = shared.writes.at(-1)
    assert.match(patch.body, /DELETE/)
    await assert.rejects(
      unshareWith(FOTOS, OWNER, { fetch: shared, ownerWebId: OWNER, isContainer: true }),
      (err) => err.name === 'EspacioShareUnsafe',
    )
  })
})

describe('otro pod de la misma cuenta', () => {
  // En `tecnocoop/` el ACL nombra al WebID de ese pod; el socio (OWNER)
  // gestiona por la cuenta de CSS y no figura en el ACL.
  const TECNO = `${ISSUER}tecnocoop/`
  const TECNO_WEBID = `${TECNO}profile/card#me`
  const DOCS = `${TECNO}docs/`
  const TECNO_ACL = ROOT_ACL.replaceAll(OWNER, TECNO_WEBID).replaceAll(POD, TECNO)
  const options = (fetch) => ({ fetch, ownerWebId: OWNER, isContainer: true })

  function readBack(fetch) {
    const match = /^\s*INSERT DATA \{([\s\S]*)\};\s*$/.exec(fetch.writes.at(-1).body)
    assert.ok(match)
    return fakePod({ [`${TECNO}.acl`]: TECNO_ACL, [`${DOCS}.acl`]: match[1] })
  }

  it('se puede compartir, y el dueño de ese pod conserva el control', async () => {
    const fetch = fakePod({ [`${TECNO}.acl`]: TECNO_ACL })
    await shareWith(DOCS, BEA, 'ver', options(fetch))
    const [write] = fetch.writes
    assert.match(write.body, new RegExp(TECNO_WEBID.replace(/[.#/]/g, '\\$&')))
    assert.match(write.body, /Control/)
  })

  it('su dueño no aparece entre las personas con acceso', async () => {
    const fetch = fakePod({ [`${TECNO}.acl`]: TECNO_ACL })
    await shareWith(DOCS, BEA, 'ver', options(fetch))
    const sharing = await getSharing(DOCS, { fetch: readBack(fetch), ownerWebId: OWNER })
    assert.deepEqual(sharing.agents, [{ webId: BEA, mode: 'ver' }])
  })

  it('no se puede quitar a su dueño', async () => {
    const fetch = fakePod({ [`${TECNO}.acl`]: TECNO_ACL })
    await shareWith(DOCS, BEA, 'ver', options(fetch))
    const shared = readBack(fetch)
    await assert.rejects(unshareWith(DOCS, TECNO_WEBID, options(shared)), (err) => err.name === 'EspacioShareUnsafe')
    assert.equal(shared.writes.length, 0)
  })
})

describe('resolveWebId', () => {
  const profile = (type) => (url) =>
    url === `${ISSUER}bea/profile/card`
      ? turtle(`<#me> a <${type}>.`, url)
      : new Response(null, { status: 404 })

  function profileFetch(plan) {
    return async (input) => plan(String(input))
  }

  it('arma el WebID desde el nombre de usuario y verifica que sea una persona', async () => {
    const fetch = profileFetch(profile('http://xmlns.com/foaf/0.1/Person'))
    assert.equal(await resolveWebId(' bea ', { issuer: ISSUER, fetch }), BEA)
    assert.equal(await resolveWebId(BEA, { issuer: ISSUER, fetch }), BEA)
  })

  it('rechaza nombres inválidos, usuarios que no existen y pods de servicio', async () => {
    const fetch = profileFetch(profile('https://www.w3.org/ns/activitystreams#Service'))
    await assert.rejects(resolveWebId('../otro', { issuer: ISSUER, fetch }), (e) => e.name === 'EspacioInvalidPerson')
    await assert.rejects(resolveWebId('', { issuer: ISSUER, fetch }), (e) => e.name === 'EspacioInvalidPerson')
    await assert.rejects(resolveWebId('nadie', { issuer: ISSUER, fetch }), /No existe el usuario "nadie"/)
    await assert.rejects(resolveWebId('bea', { issuer: ISSUER, fetch }), /no es el perfil de una persona/)
  })
})
