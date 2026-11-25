// ?shift=N creates N throwaway controls before the app starts, so every generated UI5 id
// (__button0, __xmlview0, ...) and the component prefix come out different from a normal load.
// The end-to-end test uses it to prove recorded guides don't depend on generated ids.
sap.ui.define(['sap/ui/core/ComponentContainer', 'sap/m/Button', 'sap/m/Input'], (ComponentContainer, Button, Input) => {
  const shift = Number(new URLSearchParams(location.search).get('shift') || 0);
  for (let i = 0; i < shift; i++) { new Button(); new Input(); }
  new ComponentContainer({ name: 'po', async: true, manifest: true, height: '100%', settings: { id: shift ? `po${shift}` : 'po' } }).placeAt('content');
});
