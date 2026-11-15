/** Keep quoted evidence readable without giving it live HTML-comment marker authority. */
export function neutralizeMarkers(text) {
  // Escape rather than delete: deletion can concatenate harmless pieces into a new marker.
  // Literal replacement also handles nested and unterminated markers in linear time.
  return String(text ?? '').replaceAll('<!--', '&lt;!--').replaceAll('-->', '--&gt;');
}
