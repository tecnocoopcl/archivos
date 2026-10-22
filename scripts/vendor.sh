#!/bin/sh
# Copia desde espacio la lógica de Archivos que no depende de Electron ni de
# Node: rutas, listado, vista previa de RAW, compartir (WAC), buzón,
# favoritos y lo compartido por mí. Esos archivos no se editan aquí: se
# corrigen en espacio y se vuelve a correr este script.
#
#   ESPACIO=../../espacio sh scripts/vendor.sh
set -eu
ESPACIO=${ESPACIO:-../../espacio}
ORIGEN="$ESPACIO/packages/archivos"
DESTINO=src/vendor/espacio
PRUEBAS=test/vendor

mkdir -p "$DESTINO" "$PRUEBAS"
cp "$ESPACIO/packages/solid-core/src/paths.js" "$DESTINO/paths.js"
cp "$ORIGEN/src/shared/listing.js" "$ORIGEN/src/shared/raw.js" "$DESTINO/"

# Los de main/ importan ArchivosError y ensureContainer de operations.js,
# que usa streams de Node; aquí salen de errores.js, que es de esta app.
for f in sharing inbox store pods; do
  sed -e "s#'\.\./shared/paths\.js'#'./paths.js'#" \
      -e "s#'\./operations\.js'#'../../pod/errores.js'#" \
      "$ORIGEN/src/main/$f.js" > "$DESTINO/$f.js"
done

for f in listing raw sharing inbox pods; do
  sed -e "s#'\.\./src/shared/\([a-z]*\)\.js'#'../../src/vendor/espacio/\1.js'#" \
      -e "s#'\.\./src/main/operations\.js'#'../../src/pod/errores.js'#" \
      -e "s#'\.\./src/main/\([a-z]*\)\.js'#'../../src/vendor/espacio/\1.js'#" \
      "$ORIGEN/test/$f.test.js" > "$PRUEBAS/$f.test.js"
done

# CSV de hojas: solo las dos funciones (sources.js trae más cosas de hojas).
{
  echo "// Copia de detectDelimiter y parseCsv de espacio/packages/hojas/src/shared/sources.js."
  echo "// Excel en español exporta con ';'; el separador se deduce de la primera línea."
  echo
  awk '/^export function detectDelimiter/,/^}/' "$ESPACIO/packages/hojas/src/shared/sources.js"
  echo
  awk '/^export function parseCsv/,/^}/' "$ESPACIO/packages/hojas/src/shared/sources.js"
} > "$DESTINO/csv.js"
