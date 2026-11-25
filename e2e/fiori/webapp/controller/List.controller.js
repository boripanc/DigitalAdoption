sap.ui.define(['sap/ui/core/mvc/Controller', 'sap/m/MessageToast', 'sap/ui/core/UIComponent'], (Controller, MessageToast, UIComponent) =>
  Controller.extend('po.controller.List', {
    onOpen(e) {
      const id = e.getSource().getBindingContext().getProperty('id');
      UIComponent.getRouterFor(this).navTo('detail', { id });
    },
    onCreate() { MessageToast.show('Create pressed'); },
  }));
