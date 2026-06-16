<script lang="ts">
  import Overlay from "./Overlay.svelte";
  import Icon from "./Icon.svelte";

  interface Props {
    onclose: () => void;
    oncreate: (name: string) => Promise<void> | void;
  }
  const { onclose, oncreate }: Props = $props();

  let name = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    busy = true;
    error = null;
    try {
      await oncreate(trimmed);
      onclose();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<Overlay onclose={onclose}>
  <div class="bk-modal" style="width: min(440px, 95vw)">
    <div class="bk-modal-hd">
      <h2 class="bk-h2">New scenario</h2>
      <button class="bk-iconbtn" style="margin-left: auto" aria-label="Close" onclick={onclose}>
        <Icon name="close" size={14} />
      </button>
    </div>
    <div class="bk-modal-body">
      <p class="bk-text">
        A scenario clones the current workspace so you can model what-ifs: a move,
        a raise, a new sub. Original Current stays untouched.
      </p>
      <form onsubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label class="bk-field" style="margin-top: 12px">
          <span class="bk-field-label">Scenario name <span class="bk-required" aria-hidden="true">*</span></span>
          <input
            class="bk-input"
            data-testid="new-scenario-name"
            bind:value={name}
            placeholder="Apartment-A, Job-Switch, Baby"
            aria-required="true"
          />
        </label>
      </form>
      {#if error}
        <p class="bk-text" style="color: var(--negative); margin-top: 8px" data-testid="scenario-error">{error}</p>
      {/if}
    </div>
    <div class="bk-modal-ft">
      <button class="bk-btn bk-btn-ghost" onclick={onclose}>Cancel</button>
      <button
        class="bk-btn bk-btn-primary"
        data-testid="create-scenario-btn"
        disabled={!name.trim() || busy}
        onclick={submit}
      >{busy ? "Creating…" : "Create scenario"}</button>
    </div>
  </div>
</Overlay>
