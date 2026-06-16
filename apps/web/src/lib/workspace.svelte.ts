// Shared reactive workspace state. Svelte 5 rune-based — modules can export
// $state and re-import the live reference.

import { api, type Workspace } from "./api.js";

interface WorkspaceState {
  list: Workspace[];
  activeId: number | null;
  loading: boolean;
  error: string | null;
}

const state = $state<WorkspaceState>({
  list: [],
  activeId: null,
  loading: false,
  error: null,
});

export function workspaceState(): WorkspaceState {
  return state;
}

export async function refreshWorkspaces(): Promise<void> {
  state.loading = true;
  state.error = null;
  try {
    state.list = await api.listWorkspaces();
    if (state.activeId === null && state.list.length > 0) {
      state.activeId = state.list[0]!.id;
    }
  } catch (e) {
    state.error = (e as Error).message;
  } finally {
    state.loading = false;
  }
}

export function setActiveWorkspace(id: number): void {
  state.activeId = id;
}
