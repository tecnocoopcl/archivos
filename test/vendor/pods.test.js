import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { podLabel } from '../../src/vendor/espacio/pods.js'

const SERVER = 'https://pods-rpi-tc.aebn.cl/'
const PRIMARY = `${SERVER}usuario-aebn/`
const OTRO = `${SERVER}tecnocoop/`

describe('podLabel', () => {
  it('llama "Tu pod" al principal y a los demás por su carpeta', () => {
    assert.equal(podLabel(PRIMARY, PRIMARY), 'Tu pod')
    assert.equal(podLabel(OTRO, PRIMARY), 'tecnocoop')
    assert.equal(podLabel(`${SERVER}cooperativa%20norte/`, PRIMARY), 'cooperativa norte')
  })
})
