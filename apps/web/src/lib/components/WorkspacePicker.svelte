<script lang="ts">
  import Icon from "./Icon.svelte";
  import { onMount, tick } from "svelte";
  import type { Workspace } from "$lib/api.js";

  interface Props {
    workspaces: Workspace[];
    activeId: number | null;
    onpick: (id: number) => void;
    oncreaterequest: () => void;
    /** Optional. When provided, scenarios show a delete button. */
    ondelete?: (id: number) => Promise<void> | void;
    /** Optional. When provided, every workspace gets a rename pencil. The
     *  handler should refresh the workspaces list before resolving. */
    onrename?: (id: number, newName: string) => Promise<void>;
    /** Optional. When provided, every workspace gets a copy button that
     *  prompts for a destination name. The handler should refresh the
     *  workspaces list before resolving. */
    onclone?: (id: number, newName: string) => Promise<void>;
  }
  const { workspaces, activeId, onpick, oncreaterequest, ondelete, onrename, onclone }: Props = $props();

  let open = $state(false);
  let wrapEl: HTMLDivElement | null = $state(null);

  // Row id currently being renamed inline, plus its pending value + any
  // server error. null = not editing.
  let renamingId = $state<number | null>(null);
  let renameDraft = $state("");
  let renameError = $state<string | null>(null);
  let renameBusy = $state(false);
  let renameInputEl: HTMLInputElement | null = $state(null);

  const active = $derived(workspaces.find((w) => w.id === activeId));

  onMount(() => {
    function handler(e: MouseEvent) {
      if (wrapEl && !wrapEl.contains(e.target as Node)) {
        open = false;
        renamingId = null;
        renameError = null;
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  });

  async function startRename(w: Workspace): Promise<void> {
    renamingId = w.id;
    renameDraft = w.name;
    renameError = null;
    await tick();
    renameInputEl?.select();
  }

  async function commitRename(w: Workspace): Promise<void> {
    if (!onrename) return;
    const next = renameDraft.trim();
    if (next.length === 0) { renameError = "Name cannot be empty"; return; }
    if (next === w.name) { renamingId = null; return; }
    renameBusy = true;
    renameError = null;
    try {
      await onrename(w.id, next);
      renamingId = null;
    } catch (e) {
      renameError = (e as Error).message ?? String(e);
    } finally {
      renameBusy = false;
    }
  }

  function cancelRename(): void {
    renamingId = null;
    renameError = null;
  }

  async function handleClone(w: Workspace): Promise<void> {
    if (!onclone) return;
    // Browser prompt is the lightest UX here — a full modal would be more
    // polish than the picker pop deserves. Suggest a "Copy of …" default.
    const suggestion = `Copy of ${w.name}`;
    const name = window.prompt(`Clone "${w.name}" to a new scenario named:`, suggestion);
    if (name === null) return;
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    try {
      await onclone(w.id, trimmed);
      open = false;
    } catch (e) {
      // Surface the error via alert — the picker has nowhere natural to
      // display it inline once it closes.
      window.alert(`Clone failed: ${(e as Error).message ?? String(e)}`);
    }
  }
</script>

<div bind:this={wrapEl} style="position: relative">
  <button
    type="button"
    class="bk-ws-button"
    aria-haspopup="menu"
    aria-expanded={open}
    data-testid="ws-picker"
    onclick={() => (open = !open)}
  >
    <span class="bk-ws-dot" aria-hidden="true"></span>
    <span style="font-weight: 600">{active?.name ?? "—"}</span>
    <span class="bk-ws-kind">{active?.kind === "current" ? "Live" : "Scenario"}</span>
    <Icon name="chevron" size={14} />
  </button>
  {#if open}
    <div role="menu" class="bk-ws-pop">
      <div class="bk-eyebrow" style="padding: 6px 8px">Workspaces</div>
      {#each workspaces as w (w.id)}
        <div class="bk-ws-pop-row" data-testid={`ws-pop-row-${w.id}`}>
          {#if renamingId === w.id && onrename}
            <input
              bind:this={renameInputEl}
              bind:value={renameDraft}
              class="bk-input"
              style="flex: 1; min-width: 0; padding: 6px 8px"
              data-testid={`ws-rename-input-${w.id}`}
              disabled={renameBusy}
              aria-label={`New name for ${w.name}`}
              onkeydown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); void commitRename(w); }
                else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
              }}
            />
            <button
              type="button"
              class="bk-iconbtn"
              aria-label="Save rename"
              title="Save"
              data-testid={`ws-rename-save-${w.id}`}
              disabled={renameBusy}
              onclick={() => void commitRename(w)}
            >
              <Icon name="check" size={14} />
            </button>
            <button
              type="button"
              class="bk-iconbtn"
              aria-label="Cancel rename"
              title="Cancel"
              disabled={renameBusy}
              onclick={cancelRename}
            >
              <Icon name="close" size={14} />
            </button>
          {:else}
            <button
              type="button"
              role="menuitem"
              aria-current={w.id === activeId}
              data-testid={`ws-tab-${w.id}`}
              onclick={() => { onpick(w.id); open = false; }}
            >
              <span
                class="bk-ws-dot"
                style:background={w.kind === "current" ? "var(--accent)" : "var(--info)"}
              ></span>
              <span style="flex: 1">{w.name}</span>
              <span class="bk-ws-kind">{w.kind}</span>
            </button>
            {#if onrename}
              <button
                type="button"
                class="bk-iconbtn"
                aria-label={`Rename ${w.name}`}
                title="Rename"
                data-testid={`ws-rename-${w.id}`}
                onclick={() => void startRename(w)}
              >
                <Icon name="edit" size={14} />
              </button>
            {/if}
            {#if onclone}
              <button
                type="button"
                class="bk-iconbtn"
                aria-label={`Clone ${w.name}`}
                title="Clone to new scenario"
                data-testid={`ws-clone-${w.id}`}
                onclick={() => void handleClone(w)}
              >
                <Icon name="copy" size={14} />
              </button>
            {/if}
            {#if w.kind !== "current" && ondelete}
              <button
                type="button"
                class="bk-iconbtn"
                aria-label={`Delete ${w.name}`}
                title="Delete scenario"
                onclick={async () => {
                  // Close the picker BEFORE awaiting the delete. Otherwise a
                  // slow delete leaves the menu open with the deleted row still
                  // visible, and a second click on the same row stacks another
                  // delete request mid-flight. await ensures we propagate any
                  // upstream error correctly (the parent handler logs it).
                  open = false;
                  await ondelete(w.id);
                }}
              >
                <Icon name="trash" size={14} />
              </button>
            {/if}
          {/if}
        </div>
        {#if renamingId === w.id && renameError}
          <div
            role="alert"
            class="bk-text-3"
            style="color: var(--negative); font-size: 11px; padding: 0 8px 6px"
            data-testid={`ws-rename-error-${w.id}`}
          >
            {renameError}
          </div>
        {/if}
      {/each}
      <div style="border-top: 1px solid var(--border); margin: 6px 4px"></div>
      <button
        type="button"
        class="bk-btn bk-btn-sm"
        style="width: 100%; justify-content: center; margin-top: 4px"
        onclick={() => { oncreaterequest(); open = false; }}
      >
        <Icon name="plus" size={12} /> New scenario
      </button>
    </div>
  {/if}
</div>
