# Archivos

Los archivos del Solid Pod de cada socio, desde el navegador:
**archivos.aebn.cl**. Es la versión web de Archivos de **espacio**, para
cuando no se tiene el escritorio a mano (otro computador, el teléfono).

A diferencia de notas o música, esta app **no se aloja dentro de espacio**:
allá Archivos es una vista nativa del shell (ADR-005 de espacio), porque
ninguna mini-app en iframe recibe alcance sobre todo el pod. Aquí la app
tiene su propio login Solid y el socio le da ese alcance a sabiendas, como a
cualquier app Solid.

## Qué hace (v0.1)

- Navegar todo el pod desde la raíz (y los demás pods de la cuenta, si el
  perfil declara varios `pim:storage`).
- Subir (botón o arrastrando archivos), bajar, crear carpetas, renombrar
  archivos y borrar (una carpeta, solo si está vacía).
- Vista previa en un panel lateral: Markdown, texto, CSV/TSV como tabla,
  JSON, imágenes, fotos RAW (el JPEG incrustado), PDF, audio y video. ↑/↓
  recorren la carpeta, Esc cierra. Un `.md` dentro de `Documentos/` ofrece
  abrirse en Notas.
- Compartir con otros socios (ver o editar) y enlace público, sobre WAC.
- «Compartidos conmigo», «Compartido por mí» y favoritos.

Todo eso vive en el pod, no en el navegador: favoritos y lo compartido
(`Aplicaciones/archivos/`) y el buzón (`inbox/`) son los mismos que usa
espacio, así que se ve igual desde los dos lados.

**Lo que queda en el escritorio:** sincronizar carpetas con el equipo y abrir
con las apps del sistema (Quick Look para HEIC, documentos de oficina…).

### Límites del navegador

| Qué | Por qué |
|---|---|
| Subidas de hasta 90 MB | Cloudflare corta las peticiones de más de 100 MB (igual que en espacio). |
| La subida no muestra porcentaje | `fetch` no informa el progreso de lo que envía. |
| Audio, video y PDF se traen enteros (hasta 300 MB) | Un `<video>` no puede mandar la sesión Solid; en espacio se transmiten por rangos. |
| HEIC y TIFF solo se ven en Safari | Los demás navegadores no los decodifican. |
| No se suben carpetas arrastradas | Por ahora, solo archivos sueltos. |

## Rutas

| Ruta | Vista |
|---|---|
| `/` | Raíz del pod principal |
| `/Documentos/Fotos/` | Una carpeta del pod principal |
| `/?u=<url>` | Una carpeta de otro pod (propio o compartido) |
| `/?ver=conmigo` | Compartidos conmigo |
| `/?ver=por-mi` | Compartido por mí |

## Seguridad

La sesión Solid solo se manda a los orígenes del proveedor y de los pods
propios (`podFetch` en `src/pod/solid.js`). Un enlace de un Markdown o una
notificación del buzón pueden apuntar a cualquier lado; la sesión no sale de
la cooperativa. Los perfiles ajenos se leen sin sesión.

## Código

| Dónde | Qué |
|---|---|
| `src/pod/solid.js` | Login, sesión, perfil y pods |
| `src/pod/archivos.js` | Operaciones sobre el pod (lo que en espacio hace `ipc.js`) |
| `src/componentes/` | La interfaz, portada de `packages/archivos/src/renderer/` |
| `src/vendor/espacio/` | Lógica copiada de espacio, sin tocar |

### Lógica compartida con espacio

`src/vendor/espacio/` (y sus pruebas en `test/vendor/`) son copias de
`espacio/packages/archivos` (rutas, listado, RAW, compartir, buzón,
favoritos), de `solid-core/paths.js` y del lector CSV de hojas. **No se editan
aquí**: se corrigen en espacio y se vuelven a copiar.

```bash
npm run vendor   # espera espacio en ../../espacio; si no, ESPACIO=<ruta> npm run vendor
```

## Desarrollo

```bash
npm install
npm run dev     # http://localhost:5182
npm test
npm run lint
npm run build
```

El puerto es 5182: 5173 es del shell de espacio, 5180 de notas y 5181 de
archivador.

## Despliegue

GitHub Pages desde `main` (`.github/workflows/deploy.yml`), con dominio
`archivos.aebn.cl` (`public/CNAME`). El workflow copia `index.html` a
`404.html` para que `/<carpeta>/` cargue la app.
