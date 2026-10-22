import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { leerRuta, rutaDe } from '../src/ruta.js'

const POD = 'https://pods.example/ana/'
const at = (href) => new URL(href, 'https://archivos.example')

describe('ruta', () => {
  it('lleva una carpeta del pod principal a su ruta y de vuelta', () => {
    const url = `${POD}Documentos/Mis%20fotos/`
    const ruta = rutaDe({ section: 'pod', url }, POD)
    assert.equal(ruta, '/Documentos/Mis%20fotos/')
    assert.deepEqual(leerRuta(POD, at(ruta)), { section: 'pod', url })
  })

  it('la raíz es /', () => {
    assert.equal(rutaDe({ section: 'pod', url: POD }, POD), '/')
    assert.deepEqual(leerRuta(POD, at('/')), { section: 'pod', url: POD })
  })

  it('lo que está fuera del pod principal va en ?u=', () => {
    const url = 'https://pods.example/bea/Compartido/'
    const ruta = rutaDe({ section: 'pod', url }, POD)
    assert.deepEqual(leerRuta(POD, at(ruta)), { section: 'pod', url })
  })

  it('las secciones de compartidos', () => {
    assert.deepEqual(leerRuta(POD, at(rutaDe({ section: 'shared-with-me' }, POD))), { section: 'shared-with-me' })
    assert.deepEqual(leerRuta(POD, at(rutaDe({ section: 'shared-by-me' }, POD))), { section: 'shared-by-me' })
  })

  it('una ?u= que no es https se ignora', () => {
    assert.deepEqual(leerRuta(POD, at('/?u=javascript:alert(1)')), { section: 'pod', url: POD })
  })
})
