<script lang="ts">
  import Overlay from "./Overlay.svelte";
  import Icon from "./Icon.svelte";
  import { HELP_TOPICS } from "$lib/helpers.js";

  interface Props {
    topic: string;
    onclose: () => void;
  }
  const { topic, onclose }: Props = $props();

  const def = $derived(HELP_TOPICS[topic]);
</script>

{#if def}
  <Overlay onclose={onclose} align="center">
    <div class="bk-modal" style="width: min(540px, 95vw)" data-testid="help-popover">
      <div class="bk-modal-hd">
        <h2 class="bk-h2">{def.title}</h2>
        <button class="bk-iconbtn" style="margin-left: auto" aria-label="Close" onclick={onclose}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <div class="bk-modal-body">
        <p class="bk-text" style="font-size: 14px; line-height: 1.55">{def.body}</p>
        {#if def.immediate}
          <div class="hp-block" data-testid="help-immediate">
            <div class="hp-label">How it's computed</div>
            <div class="hp-formula">{def.immediate}</div>
          </div>
        {/if}
        {#if def.final}
          <div class="hp-block" data-testid="help-final">
            <div class="hp-label">Where the inputs come from</div>
            <div class="hp-source">{def.final}</div>
          </div>
        {/if}
      </div>
      <div class="bk-modal-ft">
        <button class="bk-btn" onclick={onclose}>Got it</button>
      </div>
    </div>
  </Overlay>
{/if}

<style>
  .hp-block {
    margin-top: 16px;
    padding-top: 14px;
    border-top: 1px dotted var(--border);
  }
  .hp-label {
    font-family: var(--font-display);
    font-style: italic;
    font-size: 11.5px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-3);
    margin-bottom: 6px;
  }
  .hp-formula {
    font-family: var(--font-num);
    font-size: 13px;
    color: var(--text);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
    line-height: 1.5;
    word-break: break-word;
  }
  .hp-source {
    font-family: var(--font-display);
    font-style: italic;
    font-size: 13.5px;
    color: var(--text-2);
    line-height: 1.45;
  }
</style>
