/**
 * Barra lateral de Archivos: el pod del socio, sus favoritos y lo compartido
 * —con él y por él—. Solo muestra y avisa; la navegación la decide
 * ArchivosView. Es la de espacio sin «En este equipo»: sincronizar carpetas
 * locales es cosa del escritorio.
 */
export default function Sidebar({
  pods,
  section,
  currentPodUrl,
  favorites,
  open,
  sharedWithMeCount,
  sharedByMeCount,
  onSelectPod,
  onOpenFavorite,
  onSelectSection,
}) {
  return (
    <nav className={`archivos-side${open ? ' is-open' : ''}`} aria-label="Archivos">
      <h3 className="archivos-side__heading">Mi pod</h3>
      {pods.map((pod) => (
        <button
          key={pod.url}
          className={`archivos-side__item${section === 'pod' && pod.url === currentPodUrl ? ' is-current' : ''}`}
          onClick={() => onSelectPod(pod)}
          title={pod.url}
        >
          <span className="archivos-side__icon">{pod.primary ? '🏠' : '🗄️'}</span>
          <span className="archivos-side__label">{pod.label}</span>
        </button>
      ))}

      <h3 className="archivos-side__heading">Compartido</h3>
      <button
        className={`archivos-side__item${section === 'shared-with-me' ? ' is-current' : ''}`}
        onClick={() => onSelectSection('shared-with-me')}
      >
        <span className="archivos-side__icon">📥</span>
        <span className="archivos-side__label">Compartidos conmigo</span>
        {sharedWithMeCount > 0 && <span className="archivos-side__count">{sharedWithMeCount}</span>}
      </button>
      <button
        className={`archivos-side__item${section === 'shared-by-me' ? ' is-current' : ''}`}
        onClick={() => onSelectSection('shared-by-me')}
      >
        <span className="archivos-side__icon">📤</span>
        <span className="archivos-side__label">Compartido por mí</span>
        {sharedByMeCount > 0 && <span className="archivos-side__count">{sharedByMeCount}</span>}
      </button>

      <h3 className="archivos-side__heading">Favoritos</h3>
      {favorites.length === 0 ? (
        <p className="archivos-side__hint">Marca con ☆ lo que abras seguido.</p>
      ) : (
        favorites.map((item) => (
          <button key={item.url} className="archivos-side__item" onClick={() => onOpenFavorite(item)} title={item.url}>
            <span className="archivos-side__icon">{item.isContainer ? '📁' : '📄'}</span>
            <span className="archivos-side__label">{item.name}</span>
          </button>
        ))
      )}
    </nav>
  )
}
