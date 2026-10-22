import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { bufferReader, extractRawPreview, isDisplayableJpeg, jpegOrientation } from '../../src/vendor/espacio/raw.js'

/**
 * Un JPEG mínimo: los marcadores que miran el lector y Chromium, con datos
 * comprimidos de relleno. `sof` 0xc0 es uno normal; 0xc3, uno sin pérdida
 * como los datos del sensor de un CR2 o DNG.
 */
function jpeg(size, { sof = 0xc0, fill = 0x11, exifOrientation = null } = {}) {
  const parts = [[0xff, 0xd8]]
  if (exifOrientation) {
    // APP1 "Exif\0\0" + TIFF LE con una sola entrada: Orientation.
    const tiff = [0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, exifOrientation, 0, 0, 0, 0, 0, 0, 0]
    const body = [...Buffer.from('Exif\0\0', 'binary'), ...tiff]
    parts.push([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body])
  }
  parts.push([0xff, sof, 0, 11, 8, 0, 16, 0, 16, 1, 1, 0x11, 0])
  parts.push([0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0])
  const header = parts.flat()
  const out = new Uint8Array(size)
  out.set(header)
  out.fill(fill, header.length, size - 2)
  // Un FF dentro de los datos comprimidos va seguido de 00: no es un marcador.
  out[header.length + 1] = 0xff
  out[header.length + 2] = 0x00
  out.set([0xff, 0xd9], size - 2)
  return out
}

/**
 * Arma un TIFF con IFD encadenados y datos al final. Cada IFD es una lista
 * de [tag, tipo, valor]; un valor `{ data }` se coloca afuera y la entrada
 * apunta a él (o lleva su largo, para 0x202 y 0x117 vía `lengthOf`).
 */
function tiff(ifds, { bigEndian = false, filler = 0 } = {}) {
  const le = !bigEndian
  const blobs = []
  const fixed = 8 + ifds.reduce((n, entries) => n + 2 + entries.length * 12 + 4, 0)
  let cursor = fixed + filler
  const place = (data) => {
    const at = cursor
    blobs.push({ at, data })
    cursor += data.length
    return at
  }
  const buffer = new Uint8Array(1 << 22)
  const dv = new DataView(buffer.buffer)
  buffer.set(bigEndian ? [0x4d, 0x4d, 0, 42] : [0x49, 0x49, 42, 0])
  dv.setUint32(4, 8, le)

  const ifdOffsets = []
  let at = 8
  for (const entries of ifds) {
    ifdOffsets.push(at)
    at += 2 + entries.length * 12 + 4
  }
  ifds.forEach((entries, n) => {
    let p = ifdOffsets[n]
    dv.setUint16(p, entries.length, le)
    p += 2
    for (const [tag, type, value] of entries) {
      dv.setUint16(p, tag, le)
      dv.setUint16(p + 2, type, le)
      if (value?.ifd !== undefined) {
        dv.setUint32(p + 4, 1, le)
        dv.setUint32(p + 8, ifdOffsets[value.ifd], le)
      } else if (value?.data) {
        dv.setUint32(p + 4, type === 7 ? value.data.length : 1, le)
        dv.setUint32(p + 8, place(value.data), le)
      } else {
        dv.setUint32(p + 4, 1, le)
        if (type === 3) dv.setUint16(p + 8, value, le)
        else dv.setUint32(p + 8, value, le)
      }
      p += 12
    }
    // Encadenado solo si se pide con `next`; si no, 0.
    dv.setUint32(p, entries.next !== undefined ? ifdOffsets[entries.next] : 0, le)
  })
  for (const blob of blobs) buffer.set(blob.data, blob.at)
  return buffer.slice(0, cursor)
}

/** Entrada de 0x201 con su 0x202: el largo se completa al armar. */
function jpegEntries(data) {
  return [
    [0x0201, 4, { data }],
    [0x0202, 4, data.length],
  ]
}

function chain(entries, next) {
  return Object.assign(entries, { next })
}

/** Lector que cuenta cuánto se pidió, para ver que no baja el archivo entero. */
function countingReader(bytes) {
  const stats = { bytes: 0, all: 0 }
  return {
    stats,
    read: async (offset, length) => {
      const slice = bytes.subarray(offset, offset + length)
      stats.bytes += slice.length
      return slice
    },
    all: async () => {
      stats.all++
      return bytes
    },
  }
}

describe('isDisplayableJpeg', () => {
  it('acepta un JPEG base y uno progresivo', () => {
    assert.equal(isDisplayableJpeg(jpeg(64)), true)
    assert.equal(isDisplayableJpeg(jpeg(64, { sof: 0xc2 })), true)
  })
  it('rechaza uno sin pérdida (datos del sensor) y lo que no es JPEG', () => {
    assert.equal(isDisplayableJpeg(jpeg(64, { sof: 0xc3 })), false)
    assert.equal(isDisplayableJpeg(new Uint8Array([1, 2, 3, 4, 5])), false)
  })
})

describe('jpegOrientation', () => {
  it('lee la orientación del EXIF del propio JPEG', async () => {
    assert.equal(await jpegOrientation(jpeg(128, { exifOrientation: 6 })), 6)
    assert.equal(await jpegOrientation(jpeg(128)), 1)
  })
})

describe('extractRawPreview', () => {
  it('ARW: elige el JPEG más grande entre los IFD, con la orientación del RAW', async () => {
    const small = jpeg(200, { fill: 0x21 })
    const large = jpeg(900, { fill: 0x22 })
    const file = tiff([chain([[0x0112, 3, 6], ...jpegEntries(small)], 1), jpegEntries(large)])
    const preview = await extractRawPreview(bufferReader(file))
    assert.deepEqual(preview?.data, large)
    assert.equal(preview?.orientation, 6)
  })

  it('CR2/DNG: salta la tira sin pérdida aunque sea la más grande', async () => {
    const sensor = jpeg(3000, { sof: 0xc3, fill: 0x31 })
    const view = jpeg(700, { fill: 0x32 })
    const file = tiff([
      [
        [0x0103, 3, 7],
        [0x0111, 4, { data: sensor }],
        [0x0117, 4, sensor.length],
        [0x014a, 4, { ifd: 1 }],
      ],
      [[0x00fe, 4, 1], [0x0103, 3, 7], [0x0111, 4, { data: view }], [0x0117, 4, view.length]],
    ])
    const preview = await extractRawPreview(bufferReader(file))
    assert.deepEqual(preview?.data, view)
  })

  it('lee TIFF big-endian (NEF, PEF)', async () => {
    const view = jpeg(500, { fill: 0x41 })
    const file = tiff([[[0x0112, 3, 8], ...jpegEntries(view)]], { bigEndian: true })
    const preview = await extractRawPreview(bufferReader(file))
    assert.deepEqual(preview?.data, view)
    assert.equal(preview?.orientation, 8)
  })

  it('RW2: el JPEG va como valor de la etiqueta 0x2E', async () => {
    const view = jpeg(400, { fill: 0x45 })
    const file = tiff([[[0x002e, 7, { data: view }]]])
    assert.deepEqual((await extractRawPreview(bufferReader(file)))?.data, view)
  })

  it('si el JPEG trae su propia orientación, no se rota dos veces', async () => {
    const view = jpeg(500, { exifOrientation: 6 })
    const file = tiff([[[0x0112, 3, 6], ...jpegEntries(view)]])
    assert.equal((await extractRawPreview(bufferReader(file)))?.orientation, 1)
  })

  it('RAF: el encabezado dice dónde está el JPEG', async () => {
    const view = jpeg(600, { fill: 0x51 })
    const file = new Uint8Array(200 + view.length)
    file.set(Buffer.from('FUJIFILMCCD-RAW 0201FF383501', 'binary'))
    new DataView(file.buffer).setUint32(84, 200)
    new DataView(file.buffer).setUint32(88, view.length)
    file.set(view, 200)
    assert.deepEqual((await extractRawPreview(bufferReader(file)))?.data, view)
  })

  it('CR3 y otros: busca el JPEG más grande en el archivo entero', async () => {
    const thumb = jpeg(150, { fill: 0x61 })
    const view = jpeg(1200, { fill: 0x62 })
    const sensor = jpeg(2000, { sof: 0xc3, fill: 0x63 })
    const file = new Uint8Array(5000).fill(0x7a)
    file.set(Buffer.from('....ftypcrx ', 'binary'))
    file.set(thumb, 100)
    file.set(view, 400)
    file.set(sensor, 2000)
    assert.deepEqual((await extractRawPreview(bufferReader(file)))?.data, view)
  })

  it('sin vista previa dibujable devuelve null', async () => {
    const sensor = jpeg(800, { sof: 0xc3 })
    const file = tiff([[[0x0103, 3, 7], [0x0111, 4, { data: sensor }], [0x0117, 4, sensor.length]]])
    assert.equal(await extractRawPreview(bufferReader(file)), null)
  })

  it('de un TIFF grande lee solo los IFD y el JPEG, no el archivo entero', async () => {
    const view = jpeg(1000)
    // 3 MB de "datos del sensor" antes del JPEG.
    const file = tiff([jpegEntries(view)], { filler: 3 * 1024 * 1024 })
    const reader = countingReader(file)
    const preview = await extractRawPreview(reader)
    assert.deepEqual(preview?.data, view)
    assert.equal(reader.stats.all, 0)
    assert.ok(reader.stats.bytes < 300 * 1024, `leyó ${reader.stats.bytes} bytes`)
  })
})
