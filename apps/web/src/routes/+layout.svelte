<script lang="ts">
  import "$lib/styles/editorial.css";
  import { page } from "$app/stores";
  import { onMount } from "svelte";
  import { api } from "$lib/api.js";
  import { refreshWorkspaces, setActiveWorkspace, workspaceState } from "$lib/workspace.svelte.js";
  import { hydrateShellState, shellState, setShellPref, setModal } from "$lib/appShellState.svelte.js";
  import { assistantMode, refreshAssistantSetup } from "$lib/assistantSetup.svelte.js";

  import Icon from "$lib/components/Icon.svelte";
  import WorkspacePicker from "$lib/components/WorkspacePicker.svelte";
  import ChatPanel from "$lib/components/ChatPanel.svelte";
  import CommandPalette from "$lib/components/CommandPalette.svelte";
  import HelpPopover from "$lib/components/HelpPopover.svelte";
  import NewScenarioModal from "$lib/components/NewScenarioModal.svelte";

  let { children } = $props();

  const ws = workspaceState();
  const shell = shellState();

  const NAV: Array<{ href: string; label: string; kicker: string }> = [
    { href: "/",         label: "Dashboard", kicker: "I"    },
    { href: "/budget",   label: "Budget",    kicker: "II"   },
    { href: "/library",  label: "Import",    kicker: "III"  },
    { href: "/planning", label: "Planning",  kicker: "IV"   },
    { href: "/trends",   label: "Trends",    kicker: "V"    },
    { href: "/custom",   label: "Custom",    kicker: "VI"   },
    { href: "/setup",    label: "Setup",     kicker: "VII"  },
    { href: "/options",  label: "Options",   kicker: "VIII" },
  ];

  /** Onboarding badge: the local model has never been downloaded, so the Setup
   *  tab (and the assistant toggle) carry a dot pointing the user at it. */
  const needsAssistantSetup = $derived(assistantMode() === "not_set_up");

  onMount(() => {
    hydrateShellState();
    void refreshWorkspaces();
    void refreshAssistantSetup();

    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setModal("cmd");
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  async function createScenarioFromModal(name: string): Promise<void> {
    await api.createScenario(name);
    await refreshWorkspaces();
  }

  async function handleDeleteScenario(id: number): Promise<void> {
    if (!confirm("Delete this scenario? Its data will be removed.")) return;
    await api.deleteWorkspace(id);
    await refreshWorkspaces();
  }

  async function handleRenameWorkspace(id: number, name: string): Promise<void> {
    await api.renameWorkspace(id, name);
    await refreshWorkspaces();
  }

  async function handleCloneWorkspace(id: number, name: string): Promise<void> {
    const r = await api.cloneWorkspace(id, name);
    await refreshWorkspaces();
    // Switch the active workspace to the newly-cloned one so the user lands
    // on the scenario they just created instead of staring at the source.
    setActiveWorkspace(r.id);
  }


</script>

<div
  class="bk-root bk-ed"
  data-direction="editorial"
  data-theme={shell.theme}
  data-density={shell.density}
  data-mono={shell.mono}
  data-testid="app-shell"
  style:--font-size-base="{13 * shell.fontScale}px"
  style:height="100vh"
  style:width="100vw"
  style:position="relative"
  style:overflow-x="auto"
  style:overflow-y="hidden"
>
  <a href="#bk-main" class="bk-skip">Skip to main content</a>

  <div class="bk-shell" data-chat={shell.chatOpen} style="height: 100vh">
    <nav class="bk-nav" aria-label="Primary" data-testid="topnav">
      <div class="bk-brand">
        <span class="bk-brand-mark" aria-hidden="true">B</span>
        <span>BudgetKit</span>
      </div>

      <div class="bk-nav-tabs">
        {#each NAV as item (item.href)}
          <a
            href={item.href}
            class="bk-nav-tab"
            data-testid={`nav-${item.label.toLowerCase()}`}
            aria-current={$page.url.pathname === item.href ? "page" : undefined}
          >
            <span class="bk-nav-kicker">{item.kicker}</span>
            <span>{item.label}</span>
            {#if needsAssistantSetup && item.href === "/setup"}
              <span
                class="bk-nav-dot"
                data-testid="nav-setup-badge"
                title="The local assistant model isn't set up yet"
              ></span>
            {/if}
          </a>
        {/each}
      </div>

      <div class="bk-nav-actions">
        <a
          class="bk-iconbtn"
          href="/options"
          aria-label="Preferences"
          title="Options"
          data-testid="nav-options"
          aria-current={$page.url.pathname === "/options" ? "page" : undefined}
        ><Icon name="settings" size={16} /></a>
        <span class="bk-nav-sep" aria-hidden="true"></span>
        <button
          class="bk-iconbtn"
          aria-label="Open command palette"
          title="Command palette  ⌘K"
          data-testid="cmd-open"
          onclick={() => setModal("cmd")}
        ><Icon name="search" size={16} /></button>

        {#if ws.loading}
          <span class="bk-text-3" style="font-size: 12px">loading…</span>
        {:else if ws.error}
          <span class="bk-text-3" style="color: var(--negative); font-size: 12px" data-testid="ws-error">{ws.error}</span>
          <button
            type="button"
            class="bk-btn bk-btn-sm"
            data-testid="ws-retry"
            onclick={() => void refreshWorkspaces()}
          >Retry</button>
        {:else}
          <WorkspacePicker
            workspaces={ws.list}
            activeId={ws.activeId}
            onpick={setActiveWorkspace}
            oncreaterequest={() => setModal("new-scenario")}
            ondelete={handleDeleteScenario}
            onrename={handleRenameWorkspace}
            onclone={handleCloneWorkspace}
          />
        {/if}

        {#if !shell.chatOpen}
          <button
            class="bk-iconbtn"
            style="position: relative"
            aria-label="Open assistant"
            title={needsAssistantSetup ? "Assistant — not set up yet" : "Assistant"}
            data-testid="chat-toggle"
            onclick={() => setShellPref("chatOpen", true)}
          >
            <Icon name="chat" size={16} />
            {#if needsAssistantSetup}
              <span class="bk-nav-dot" data-float="true" data-testid="chat-toggle-badge"></span>
            {/if}
          </button>
        {/if}
      </div>
    </nav>

    <div class="bk-body">
      <main
        id="bk-main"
        class="bk-main"
        data-testid="main"
        tabindex="-1"
      >
        <div class="bk-main-inner">
          {@render children()}
        </div>
      </main>

      {#if shell.chatOpen}
        <ChatPanel onclose={() => setShellPref("chatOpen", false)} />
      {/if}
    </div>
  </div>

  {#if shell.modal === "cmd"}
    <CommandPalette
      onclose={() => setModal(null)}
      onmodal={(m) => setModal(m)}
      onchattoggle={() => setShellPref("chatOpen", !shell.chatOpen)}
      chatOpen={shell.chatOpen}
    />
  {/if}
  {#if shell.modal === "new-scenario"}
    <NewScenarioModal
      onclose={() => setModal(null)}
      oncreate={createScenarioFromModal}
    />
  {/if}
  {#if shell.modal?.startsWith("help-")}
    <HelpPopover
      topic={shell.modal.slice(5)}
      onclose={() => setModal(null)}
    />
  {/if}
</div>

<style>
  :global(html, body) {
    margin: 0;
    height: 100%;
    background: #0c0b08;
  }
  :global(#app) {
    height: 100%;
  }
</style>
