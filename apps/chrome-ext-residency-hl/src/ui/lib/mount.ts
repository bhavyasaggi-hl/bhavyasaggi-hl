/** Resolves the React mount point, failing loudly if the page markup changed. */

export function mount(id = 'root'): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`Missing #${id} mount point`);
  }
  // The shell ships a static skeleton with a status role; React owns the node
  // from here, and each surface announces its own loading state.
  node.removeAttribute('role');
  node.removeAttribute('aria-label');
  return node;
}
