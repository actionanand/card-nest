const locks = new Set<symbol>();
let previousBody = '';
let previousRoot = '';

/** Nested native dialogs can unmount in any order (for example when the app locks). */
export function lockDocumentScroll(): () => void {
  if (!locks.size) {
    previousBody = document.body.style.overflow;
    previousRoot = document.documentElement.style.overflow;
  }
  const token = Symbol('dialog-scroll-lock');
  locks.add(token);
  document.body.style.overflow = 'hidden';
  document.documentElement.style.overflow = 'hidden';
  return () => {
    if (!locks.delete(token) || locks.size) return;
    document.body.style.overflow = previousBody;
    document.documentElement.style.overflow = previousRoot;
  };
}
