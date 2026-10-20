import { lockDocumentScroll } from './document-scroll-lock';
describe('Nested dialog scroll restoration', () => {
  afterEach(() => {
    document.body.style.overflow = '';
    document.documentElement.style.overflow = '';
  });
  it('restores scrolling even if a parent is removed before its nested picker', () => {
    const parent = lockDocumentScroll(),
      child = lockDocumentScroll();
    parent();
    expect(document.body.style.overflow).toBe('hidden');
    child();
    expect(document.body.style.overflow).toBe('');
    expect(document.documentElement.style.overflow).toBe('');
    child();
    expect(document.body.style.overflow).toBe('');
  });
  it('retains an external pre-existing scroll style and restores it after the final close', () => {
    document.body.style.overflow = 'clip';
    document.documentElement.style.overflow = 'hidden';
    const parent = lockDocumentScroll(),
      child = lockDocumentScroll();
    child();
    expect(document.body.style.overflow).toBe('hidden');
    parent();
    expect(document.body.style.overflow).toBe('clip');
    expect(document.documentElement.style.overflow).toBe('hidden');
  });
});
