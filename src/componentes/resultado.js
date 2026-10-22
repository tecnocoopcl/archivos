/**
 * `{ ok, value }` o `{ ok: false, error }`: la misma forma que devuelven los
 * canales IPC de Archivos en espacio, así los componentes portados de allá
 * conservan su manejo de errores tal cual.
 */
export async function resultado(fn) {
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    return { ok: false, error: { name: err?.name ?? 'Error', message: err instanceof Error ? err.message : String(err) } }
  }
}
