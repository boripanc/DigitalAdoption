sap.ui.define(['sap/ui/core/mvc/Controller', 'sap/m/MessageToast', 'sap/ui/core/UIComponent'], (Controller, MessageToast, UIComponent) =>
  Controller.extend('po.controller.Detail', {
    onInit() {
      UIComponent.getRouterFor(this).getRoute('detail').attachPatternMatched((e) => {
        const id = e.getParameter('arguments').id;
        const i = this.getView().getModel().getProperty('/orders').findIndex((o) => o.id === id);
        this.getView().bindElement(`/orders/${i}`);
      });
    },
    onBack() { UIComponent.getRouterFor(this).navTo('list'); },
    onApprove() { window.__approved = (window.__approved || 0) + 1; MessageToast.show('Order approved'); },
    onReject() { MessageToast.show('Order rejected'); },
  }));
