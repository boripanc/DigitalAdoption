sap.ui.define(['sap/ui/core/UIComponent'], (UIComponent) =>
  UIComponent.extend('po.Component', {
    metadata: { manifest: 'json' },
    init() {
      UIComponent.prototype.init.apply(this, arguments);
      this.getRouter().initialize();
    },
  }));
