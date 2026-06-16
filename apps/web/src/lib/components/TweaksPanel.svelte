<script lang="ts">
  import Icon from "./Icon.svelte";

  interface Props {
    theme: "dark" | "light";
    density: "compact" | "comfortable" | "spacious";
    mono: boolean;
    fontScale: number;
    chatOpen: boolean;
    onchange: (key: "theme" | "density" | "mono" | "fontScale" | "chatOpen", value: unknown) => void;
  }
  const { theme, density, mono, fontScale, chatOpen, onchange }: Props = $props();

  let open = $state(false);
</script>

<div class="bk-tweaks">
  {#if open}
    <div class="bk-tweaks-panel">
      <div class="bk-tweaks-section">Theme</div>
      <div class="bk-tweak-row">
        <span>Mode</span>
        <div class="bk-tweak-options">
          {#each (["dark", "light"] as const) as t (t)}
            <button
              type="button"
              class="bk-tweak-opt"
              data-on={t === theme}
              onclick={() => onchange("theme", t)}
            >{t}</button>
          {/each}
        </div>
      </div>

      <div class="bk-tweaks-section">Layout</div>
      <div class="bk-tweak-row">
        <span>Density</span>
        <div class="bk-tweak-options">
          {#each (["compact", "comfortable", "spacious"] as const) as d (d)}
            <button
              type="button"
              class="bk-tweak-opt"
              data-on={d === density}
              onclick={() => onchange("density", d)}
            >{d}</button>
          {/each}
        </div>
      </div>
      <label class="bk-tweak-row">
        <span>Text size</span>
        <input
          type="range"
          min="0.85"
          max="1.35"
          step="0.05"
          value={fontScale}
          oninput={(e) => onchange("fontScale", Number.parseFloat((e.currentTarget as HTMLInputElement).value))}
        />
        <span class="bk-num" style="min-width: 40px; text-align: right">{fontScale.toFixed(2)}×</span>
      </label>

      <div class="bk-tweaks-section">Typography</div>
      <div class="bk-tweak-row">
        <span>Mono numerals</span>
        <button
          type="button"
          class="bk-tweak-opt"
          data-on={mono}
          onclick={() => onchange("mono", !mono)}
        >{mono ? "on" : "off"}</button>
      </div>

      <div class="bk-tweaks-section">Chrome</div>
      <div class="bk-tweak-row">
        <span>Assistant</span>
        <button
          type="button"
          class="bk-tweak-opt"
          data-on={chatOpen}
          onclick={() => onchange("chatOpen", !chatOpen)}
        >{chatOpen ? "on" : "off"}</button>
      </div>
    </div>
  {/if}
  <button class="bk-tweaks-toggle" onclick={() => (open = !open)} aria-expanded={open}>
    <Icon name="wand" size={14} /> Tweaks {open ? "↓" : "↗"}
  </button>
</div>
