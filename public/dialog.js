export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

export function dialogMarkup({ title, content, kind = 'dialog' }) {
  return `<div class="modal-heading"><div>${kind === 'sheet' ? '<p class="modal-eyebrow">词条资料</p>' : ''}<h2 id="modal-title" tabindex="-1">${escapeHtml(title)}</h2></div><button type="button" class="close-button" data-action="close-modal" aria-label="关闭"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>${content}<p class="modal-error" id="modal-error" role="alert"></p>`;
}

export function formSnapshot(form) {
  return form ? JSON.stringify([...form.querySelectorAll('input, textarea, select')].map(field => [field.name, field.value, field.checked === true])) : null;
}

export function createDialog({ element, fallbackFocus, isBusy = () => false }) {
  const document = element.ownerDocument;
  const select = selector => element.querySelector(selector);
  const currentValues = () => formSnapshot(select('[data-guard-unsaved]'));
  let returnFocus = null, initialValues = null, editingFocus = null;
  const isDirty = () => element.open && initialValues !== null && currentValues() !== initialValues;
  const focusInput = () => (select('form input:not([type=checkbox]):not(:disabled), form textarea:not(:disabled), form select:not(:disabled)') || select('#modal-title'))?.focus({ preventScroll: true });
  function close() { initialValues = null; element.close(); }
  function show({ title, content, kind = 'dialog' }) {
    if (!element.open) returnFocus = document.activeElement;
    element.dataset.kind = ['sheet', 'alert'].includes(kind) ? kind : 'dialog';
    element.setAttribute('role', kind === 'alert' ? 'alertdialog' : 'dialog');
    element.innerHTML = dialogMarkup({ title, content, kind });
    const description = select('.modal-description');
    if (description) {
      description.id = 'modal-description';
      element.setAttribute('aria-describedby', description.id);
    } else element.removeAttribute('aria-describedby');
    initialValues = currentValues();
    editingFocus = null;
    if (!element.open) element.showModal();
    element.scrollTop = 0;
    if (kind === 'alert') select('[data-action="close-modal"]:not(.close-button)')?.focus({ preventScroll: true });
    else focusInput();
  }
  function requestClose() {
    if (!isDirty()) return close();
    if (!select('#modal-discard')) {
      editingFocus = element.contains(document.activeElement) && document.activeElement.matches('input, textarea, select') ? document.activeElement : null;
      select('.modal-heading').insertAdjacentHTML('afterend', '<div id="modal-discard" class="modal-discard" role="alert"><strong>还有未保存的修改</strong><p>关闭后，这次输入将丢失。要继续编辑吗？</p><div class="actions"><button type="button" class="button primary" data-action="keep-editing">继续编辑</button><button type="button" class="button text danger" data-action="discard-modal">放弃修改</button></div></div>');
    }
    element.scrollTop = 0;
    select('[data-action="keep-editing"]').focus({ preventScroll: true });
  }
  function keepEditing() {
    select('#modal-discard')?.remove();
    document.defaultView.requestAnimationFrame(() => {
      if (!element.open) return;
      if (editingFocus?.isConnected && !editingFocus.disabled) editingFocus.focus();
      else focusInput();
    });
  }
  element.addEventListener('cancel', event => { event.preventDefault(); if (!isBusy()) requestClose(); });
  element.addEventListener('close', () => {
    if (element.open) return;
    initialValues = null;
    const target = returnFocus?.isConnected && !returnFocus.disabled ? returnFocus : fallbackFocus;
    returnFocus = null;
    target?.focus({ preventScroll: true });
  });
  return { show, close, requestClose, keepEditing, isDirty };
}
