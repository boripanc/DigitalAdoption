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
