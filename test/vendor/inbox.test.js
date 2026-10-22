import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ensureInbox, inboxAcl, listSharedWithMe, notifyShare, offerTurtle } from '../../src/vendor/espacio/inbox.js'
import {
  markNotified,
  pendingNotifications,
  readFavorites,
  recordShare,
  recordUnshare,
  toggleFavorite,
  updateShared,
} from '../../src/vendor/espacio/store.js'

const SERVER = 'https://pods-rpi-tc.aebn.cl/'
const POD = `${SERVER}usuario-aebn/`
const OWNER = `${POD}profile/card#me`
const BEA_POD = `${SERVER}bea/`
const BEA = `${BEA_POD}profile/card#me`
const INBOX = `${POD}inbox/`
const CARPETA = `${BEA_POD}Presentación/`

const PROFILE = (webId, extra = '') => `
@prefix foaf: <http://xmlns.com/foaf/0.1/>.
@prefix ldp: <http://www.w3.org/ns/ldp#>.
<${webId}> a foaf:Person${extra}.
`

/**
 * Servidor falso: sirve los documentos de `docs` (Turtle o JSON, según la
 * extensión) y registra las escrituras. Un PUT queda servible después.
 */
function fakeServer(docs = {}) {
  const writes = []
  const fetch = async (input, init = {}) => {
    const url = String(input)
    const method = init.method ?? 'GET'
    if (method === 'HEAD') {
      return new Response(null, { status: 200, headers: { Link: `<${url}.acl>; rel="acl"` } })
    }
    if (method === 'GET') {
      if (!(url in docs)) return new Response(null, { status: 404 })
      const type = url.endsWith('.json') ? 'application/json' : 'text/turtle'
      const res = new Response(docs[url], { status: 200, headers: { 'Content-Type': type } })
      Object.defineProperty(res, 'url', { value: url })
      return res
    }
    writes.push({ url, method, body: String(init.body ?? '') })
    if (method === 'PUT') docs[url] = String(init.body)
    return new Response(null, { status: 201 })
  }
  fetch.writes = writes
  return fetch
}

function inboxListing(children) {
  return `@prefix ldp: <http://www.w3.org/ns/ldp#>.
<${INBOX}> a ldp:Container; ldp:contains ${children.map((c) => `<${c}>`).join(', ')}.`
}

describe('ensureInbox', () => {
  it('crea el buzón con su ACL y lo declara en el perfil', async () => {
    const fetch = fakeServer({ [OWNER.split('#')[0]]: PROFILE(OWNER) })
    assert.equal(await ensureInbox(OWNER, { fetch, primaryUrl: POD }), INBOX)

    const acl = fetch.writes.find((w) => w.url === `${INBOX}.acl`)
    assert.ok(acl, 'escribe el ACL del buzón')
    assert.equal(acl.body, inboxAcl(INBOX, OWNER))
    const profile = fetch.writes.find((w) => w.url === OWNER.split('#')[0])
    assert.match(profile.body, /ldp#inbox/)
  })

  it('el ACL deja dejar avisos a cualquier usuario con sesión, pero no leerlos', () => {
    const acl = inboxAcl(INBOX, OWNER)
    const socios = acl.slice(acl.indexOf('<#socios>'))
    assert.match(socios, /acl:AuthenticatedAgent/)
    assert.match(socios, /acl:mode acl:Append\./)
    assert.doesNotMatch(socios, /acl:default/)
  })

  it('si el perfil ya declara un buzón, no toca nada', async () => {
    const fetch = fakeServer({ [OWNER.split('#')[0]]: PROFILE(OWNER, `; ldp:inbox <${POD}buzon/>`) })
    assert.equal(await ensureInbox(OWNER, { fetch, primaryUrl: POD }), `${POD}buzon/`)
    assert.equal(fetch.writes.length, 0)
  })
})

describe('notifyShare', () => {
  const entry = { url: CARPETA, name: 'Presentación', isContainer: true }

  it('deja un as:Offer en el buzón que declara el perfil', async () => {
    const publicFetch = fakeServer({ [BEA.split('#')[0]]: PROFILE(BEA, `; ldp:inbox <${BEA_POD}inbox/>`) })
    const posts = []
    const post = async (url, body) => {
      posts.push({ url, body })
      return new Response(null, { status: 201 })
    }
    assert.equal(await notifyShare({ actor: OWNER, target: BEA, entry }, { publicFetch, post }), true)
    assert.equal(posts[0].url, `${BEA_POD}inbox/`)
    assert.match(posts[0].body, /as:Offer/)
  })

  it('sin buzón no avisa, y devuelve false para reintentar después', async () => {
    const publicFetch = fakeServer({ [BEA.split('#')[0]]: PROFILE(BEA) })
    const post = async () => assert.fail('no debe mandar nada')
    assert.equal(await notifyShare({ actor: OWNER, target: BEA, entry }, { publicFetch, post }), false)
  })

  it('no manda la sesión a un buzón fuera del servidor de la persona', async () => {
    const publicFetch = fakeServer({ [BEA.split('#')[0]]: PROFILE(BEA, '; ldp:inbox <https://evil.example/inbox/>') })
    const post = async () => assert.fail('no debe mandar nada')
    assert.equal(await notifyShare({ actor: OWNER, target: BEA, entry }, { publicFetch, post }), false)
  })
})

describe('listSharedWithMe', () => {
  const n1 = `${INBOX}a.ttl`
  const n2 = `${INBOX}b.ttl`
  const n3 = `${INBOX}c.ttl`
  const n4 = `${INBOX}d.ttl`
  const offer = (entry, published) => offerTurtle({ actor: BEA, target: OWNER, entry, published })

  it('lee los avisos, uno por recurso y lo más reciente primero', async () => {
    const informe = { url: `${BEA_POD}informe.md`, name: 'informe.md', isContainer: false }
    const fetch = fakeServer({
      [INBOX]: inboxListing([n1, n2, n3, n4]),
      [n1]: offer({ url: CARPETA, name: 'Presentación', isContainer: true }, new Date('2026-10-01')),
      [n2]: offer({ url: CARPETA, name: 'Presentación 2026', isContainer: true }, new Date('2026-10-03')),
      [n3]: offer(informe, new Date('2026-10-02')),
      [n4]: 'esto no es Turtle {',
    })
    const items = await listSharedWithMe(INBOX, { fetch, issuer: SERVER })
    assert.deepEqual(
      items.map((i) => [i.url, i.name, i.isContainer, i.from]),
      [
        [CARPETA, 'Presentación 2026', true, BEA],
        [informe.url, 'informe.md', false, BEA],
      ],
    )
    assert.deepEqual(items[0].notifications.toSorted(), [n1, n2])
  })

  it('ignora avisos que apuntan fuera del servidor de la cooperativa', async () => {
    const fetch = fakeServer({
      [INBOX]: inboxListing([n1]),
      [n1]: offer({ url: 'https://evil.example/robar', name: 'x', isContainer: false }, new Date()),
    })
    assert.deepEqual(await listSharedWithMe(INBOX, { fetch, issuer: SERVER }), [])
  })
})

describe('store: favoritos y compartidos', () => {
  const FAV = `${POD}Aplicaciones/archivos/favoritos.json`
  const SHARED = `${POD}Aplicaciones/archivos/compartidos.json`
  const entry = { url: CARPETA, name: 'Presentación', isContainer: true }

  it('marca y desmarca un favorito, guardándolo en el pod', async () => {
    const fetch = fakeServer()
    assert.deepEqual(await readFavorites(FAV, { fetch }), [])
    assert.deepEqual(await toggleFavorite(FAV, { ...entry, extra: 'no se guarda' }, { fetch }), [entry])
    assert.deepEqual(await readFavorites(FAV, { fetch }), [entry])
    assert.deepEqual(await toggleFavorite(FAV, entry, { fetch }), [])
  })

  it('anota con quién se compartió, reintenta los avisos pendientes y olvida lo que ya no tiene a nadie', async () => {
    const fetch = fakeServer()
    let items = await updateShared(SHARED, { fetch }, recordShare(entry, BEA, false))
    items = await updateShared(SHARED, { fetch }, recordShare(entry, OWNER, true))
    assert.deepEqual(
      pendingNotifications(items).map((p) => p.webId),
      [BEA],
    )
    items = await updateShared(SHARED, { fetch }, markNotified(CARPETA, BEA))
    assert.deepEqual(pendingNotifications(items), [])

    // Compartir de nuevo con alguien ya avisado no lo vuelve a dejar pendiente.
    items = await updateShared(SHARED, { fetch }, recordShare(entry, BEA, false))
    assert.equal(items[0].to[BEA].notified, true)

    items = await updateShared(SHARED, { fetch }, recordUnshare(CARPETA, BEA))
    items = await updateShared(SHARED, { fetch }, recordUnshare(CARPETA, OWNER))
    assert.deepEqual(items, [])
  })
})
