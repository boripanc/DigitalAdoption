// Types shared by the API, the extension and the dashboard.

export type Role = 'owner' | 'editor' | 'viewer';
export type FlowStatus = 'draft' | 'published';

export interface Step {
  /** CSS selector recorded for the target element. */
  selector: string;
  /** Visible text of the element, used as a fallback when the selector stops matching. */
  text: string;
  /** Lower-case tag name of the element, e.g. "button". */
  tag: string;
  /** Page URL where the step was recorded. */
  url: string;
  title: string;
  body: string;
  /**
   * Same-origin iframes to go through to reach the element, outermost first: one CSS selector per
   * iframe. Empty or missing when the element is in the top page. (Fiori launchpads often open apps in an iframe.)
   */
  frames?: string[];
  /** What the element is in SAPUI5 / OpenUI5 terms, recorded on UI5 apps such as SAP Fiori. */
  ui5?: Ui5Info;
}

/**
 * A UI5 control described by things that survive reloads, used to find it again when the
 * generated DOM ids (like "__button12" or "__xmlview0--save") change.
 */
export interface Ui5Info {
  /** Control class, e.g. "sap.m.Button". */
  type: string;
  /** Stable part of the control id, e.g. "list--save", when the developer gave it one. */
  id?: string;
  /** View the control lives in, e.g. "my.app.view.List". */
  view?: string;
  /** Text, title or placeholder. */
  text?: string;
  icon?: string;
  tooltip?: string;
  /** Text of the label pointing at the control. */
  label?: string;
  /** Model paths of bound properties, e.g. { value: "note" }. */
  bindings?: Record<string, string>;
  /** Binding context path, e.g. "/orders/1". */
  context?: string;
}

export interface Flow {
  id: string;
  workspaceId: string;
  name: string;
  /** Host the flow runs on, e.g. "app.example.com". */
  host: string;
  status: FlowStatus;
  steps: Step[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: string;
  email: string;
  role: Role;
  workspaceId: string;
}

export interface Workspace {
  id: string;
  name: string;
}

export interface AuthResponse {
  token: string;
  user: User;
  workspace: Workspace;
}

export type EventType = 'start' | 'step_view' | 'complete' | 'exit';

export interface TrackEvent {
  flowId: string;
  type: EventType;
  stepIndex?: number;
  /** Random id for one play of a flow, so a start and its completion can be tied together. */
  sessionId: string;
  at?: string;
}

export interface FlowStats {
  flowId: string;
  starts: number;
  completes: number;
  /** Views per step index. */
  stepViews: number[];
  /** Times users closed the flow at each step index. */
  exits: number[];
}

export const canEdit = (role: Role) => role === 'owner' || role === 'editor';
