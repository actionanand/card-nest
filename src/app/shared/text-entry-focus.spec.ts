import { focusedElement, isTextEntry } from './text-entry-focus';

describe('Soft-keyboard text entry focus', () => {
  it.each(['text', 'search', 'tel', 'url', 'email', 'password', 'number'])(
    'recognizes editable %s inputs',
    (type) => {
      const input = document.createElement('input');
      input.type = type;
      expect(isTextEntry(input)).toBe(true);
      input.readOnly = true;
      expect(isTextEntry(input)).toBe(false);
      input.readOnly = false;
      input.disabled = true;
      expect(isTextEntry(input)).toBe(false);
    },
  );
  it.each(['radio', 'checkbox', 'button', 'submit', 'range', 'color', 'date', 'hidden'])(
    'does not classify %s as text entry',
    (type) => {
      const input = document.createElement('input');
      input.type = type;
      expect(isTextEntry(input)).toBe(false);
    },
  );
  it('recognizes textareas, nested contenteditable and open shadow-root focus without treating selects/buttons as keyboards', () => {
    expect(isTextEntry(document.createElement('textarea'))).toBe(true);
    expect(isTextEntry(document.createElement('button'))).toBe(false);
    expect(isTextEntry(document.createElement('select'))).toBe(false);
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    const child = document.createElement('span');
    editor.append(child);
    expect(isTextEntry(child)).toBe(true);
    child.setAttribute('contenteditable', 'false');
    expect(isTextEntry(child)).toBe(false);
    const host = document.createElement('div');
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    const input = document.createElement('input');
    root.append(input);
    input.focus();
    expect(focusedElement(document)).toBe(input);
    expect(isTextEntry(focusedElement(document))).toBe(true);
    host.remove();
    expect(isTextEntry(focusedElement(document))).toBe(false);
  });
});
