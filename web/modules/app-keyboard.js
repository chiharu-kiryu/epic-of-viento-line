// Some input methods end composition before the confirming keydown. Keep the
// legacy 229 check as well as isComposing so Enter still belongs to the IME.
export const isComposingInput = (event) => Boolean(event.isComposing || event.keyCode === 229);
