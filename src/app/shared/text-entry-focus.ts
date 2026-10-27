const TEXT_INPUT_TYPES = new Set(['text', 'search', 'tel', 'url', 'email', 'password', 'number']);

/** Descend through open shadow roots rather than classifying the custom-element host. */
export function focusedElement(root: Document | ShadowRoot): Element | null {
  let active = root.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

export function isTextEntry(element: Element | null): boolean {
  if (element instanceof HTMLInputElement)
    return (
      !element.disabled &&
      !element.readOnly &&
      element.inputMode !== 'none' &&
      TEXT_INPUT_TYPES.has(element.type)
    );
  if (element instanceof HTMLTextAreaElement)
    return !element.disabled && !element.readOnly && element.inputMode !== 'none';
  if (!(element instanceof HTMLElement)) return false;
  const editor = element.closest<HTMLElement>('[contenteditable]');
  return (
    element.isContentEditable || (!!editor && editor.getAttribute('contenteditable') !== 'false')
  );
}
