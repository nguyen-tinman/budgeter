<script lang="ts">
  import Overlay from "./Overlay.svelte";
  import Icon from "./Icon.svelte";
  import { goto } from "$app/navigation";
  import { workspaceState, setActiveWorkspace } from "$lib/workspace.svelte.js";

  interface Props {
    onclose: () => void;
    onmodal?: (m: string) => void;
    onchattoggle?: () => void;
    chatOpen?: boolean;
  }
  const { onclose, onmodal, onchattoggle, chatOpen = true }: Props = $props();

  const ws = workspaceState();

  interface CmdItem {
    group: string;
    icon: "dashboard" | "wallet" | "planning" | "settings" | "plus" | "wand" | "upload" | "doc" | "chat" | "globe";
    label: string;
    keys: string;
    run: () => void;
  }

  let q = $state("");
  let idx = $state(0);

  const allItems = $derived<CmdItem[]>([
    { group: "Navigate", icon: "dashboard", label: "Go to Dashboard", keys: "G D", run: () => void goto("/") },
    { group: "Navigate", icon: "wallet",    label: "Go to Budget",    keys: "G B", run: () => void goto("/budget") },
    { group: "Navigate", icon: "planning",  label: "Go to Planning",  keys: "G P", run: () => void goto("/planning") },
    { group: "Navigate", icon: "settings",  label: "Go to Setup",     keys: "G S", run: () => void goto("/setup") },
    { group: "Actions",  icon: "plus",      label: "Add expense…",    keys: "N E", run: () => { void goto("/budget"); setTimeout(() => document.querySelector<HTMLElement>('[data-testid="new-expense-label"]')?.focus(), 50); } },
    { group: "Actions",  icon: "plus",      label: "Add income…",     keys: "N I", run: () => { void goto("/budget"); setTimeout(() => document.querySelector<HTMLElement>('[data-testid="new-income-label"]')?.focus(), 50); } },
    { group: "Actions",  icon: "wand",      label: "New scenario…",   keys: "N S", run: () => onmodal?.("new-scenario") },
    { group: "Actions",  icon: "chat",      label: chatOpen ? "Hide assistant" : "Show assistant", keys: "⌥ A", run: () => onchattoggle?.() },
    { group: "Workspaces", icon: "globe", label: "Switch workspace…", keys: "W", run: () => {} },
    ...ws.list.map<CmdItem>((w) => ({
      group: "Workspaces" as const,
      icon: "wallet",
      label: `Switch to ${w.name}`,
      keys: w.kind === "current" ? "Live" : "Scenario",
      run: () => setActiveWorkspace(w.id),
    })),
  ]);

  const items = $derived(
    !q.trim()
      ? allItems
      : allItems.filter((i) => {
          const lq = q.toLowerCase();
          return i.label.toLowerCase().includes(lq) || i.group.toLowerCase().includes(lq);
        })
  );

  const grouped = $derived((() => {
    const out: Record<string, Array<CmdItem & { _i: number }>> = {};
    items.forEach((it, i) => {
      (out[it.group] ||= []).push({ ...it, _i: i });
    });
    return out;
  })());

  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      idx = Math.min(items.length - 1, idx + 1);
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      idx = Math.max(0, idx - 1);
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const pick = items[idx];
      if (pick) {
        pick.run();
        onclose();
      }
    }
  }
</script>

<Overlay onclose={onclose} align="top">
  <div class="bk-cmd">
    <input
      class="bk-cmd-input"
      data-testid="cmd-input"
      bind:value={q}
      oninput={() => (idx = 0)}
      onkeydown={onKey}
      placeholder="Search actions, pages, workspaces…"
      aria-label="Command palette"
    />
    <div class="bk-cmd-list" role="listbox">
      {#each Object.entries(grouped) as [group, list] (group)}
        <div>
          <div class="bk-cmd-group">{group}</div>
          {#each list as it (it.label)}
            <button
              class="bk-cmd-item"
              data-on={it._i === idx}
              role="option"
              aria-selected={it._i === idx}
              onmouseenter={() => (idx = it._i)}
              onclick={() => { it.run(); onclose(); }}
            >
              <span class="bk-cmd-icon"><Icon name={it.icon} size={16} /></span>
              <span>{it.label}</span>
              <span class="bk-cmd-desc"><span class="bk-kbd">{it.keys}</span></span>
            </button>
          {/each}
        </div>
      {/each}
      {#if items.length === 0}
        <div style="padding: 24px; text-align: center; color: var(--text-3)">No matches</div>
      {/if}
    </div>
    <div class="bk-cmd-foot">
      <span><span class="bk-kbd">↑↓</span> navigate</span>
      <span><span class="bk-kbd">⏎</span> select</span>
      <span><span class="bk-kbd">esc</span> dismiss</span>
    </div>
  </div>
</Overlay>
