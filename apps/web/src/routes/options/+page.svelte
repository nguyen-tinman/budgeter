<script lang="ts">
  import { onMount } from "svelte";
  import PageHead from "$lib/components/PageHead.svelte";
  import EdSection from "$lib/components/EdSection.svelte";
  import Badge from "$lib/components/Badge.svelte";
  import { shellState, setShellPref } from "$lib/appShellState.svelte.js";
  import { api, type LlamaModelsResponse } from "$lib/api.js";

  const shell = shellState();

  let models = $state<LlamaModelsResponse | null>(null);
  let modelBusy = $state(false);
  let modelError = $state<string | null>(null);

  function bumpFontScale(delta: number): void {
    const next = Math.max(0.85, Math.min(1.35, +(shell.fontScale + delta).toFixed(2)));
    setShellPref("fontScale", next);
  }

  async function refreshModels(): Promise<void> {
    try {
      models = await api.llama.models();
      modelError = null;
    } catch (e) {
      modelError = (e as Error).message;
    }
  }

  /** Switch inference onto a downloaded model: persists it + restarts. */
  async function selectModel(modelId: string): Promise<void> {
    modelError = null;
    modelBusy = true;
    try {
      await api.llama.select(modelId);
      await refreshModels();
    } catch (e) {
      modelError = (e as Error).message;
    } finally {
      modelBusy = false;
    }
  }

  onMount(() => {
    void refreshModels();
  });
</script>

<article class="ed-article">
  <a href="/" class="bk-btn bk-btn-sm" style="margin-bottom: 16px; display: inline-flex; align-items: center; gap: 6px" data-testid="opts-back">← Back to Dashboard</a>

  <PageHead
    section="Preferences"
    kicker="The Knobs"
    title="Options"
    rightLabel="Preferences"
    byline="Adjust how BudgetKit looks and reads. Settings persist to localStorage and survive reloads."
  />

  <EdSection num={1} title="Typography" deck="Text size and number style.">
    <div class="ed-cols" data-cols="2">
      <div>
        <div class="bk-eyebrow" style="margin-bottom: 8px">Text size</div>
        <div class="bk-toolbar" style="align-items: center">
          <button
            type="button"
            class="bk-btn bk-btn-sm"
            aria-label="Decrease text size"
            data-testid="opt-font-down"
            onclick={() => bumpFontScale(-0.05)}
          >A−</button>
          <input
            type="range"
            min="0.85"
            max="1.35"
            step="0.05"
            value={shell.fontScale}
            data-testid="opt-font-slider"
            aria-label="Text size scale"
            oninput={(e) =>
              setShellPref("fontScale", parseFloat((e.currentTarget as HTMLInputElement).value))}
            style="flex: 1; min-width: 160px"
          />
          <button
            type="button"
            class="bk-btn bk-btn-sm"
            aria-label="Increase text size"
            data-testid="opt-font-up"
            onclick={() => bumpFontScale(0.05)}
          >A+</button>
          <span class="bk-num" style="min-width: 56px; text-align: right" data-testid="opt-font-readout">
            {(shell.fontScale * 100).toFixed(0)}%
          </span>
        </div>
        <p class="bk-text-3" style="font-size: 12px; margin-top: 8px; font-style: italic">
          Base body size is 13px; scale multiplies everything.
        </p>
      </div>
      <div>
        <div class="bk-eyebrow" style="margin-bottom: 8px">Mono numerals</div>
        <label style="display: inline-flex; align-items: center; gap: 10px; cursor: pointer">
          <input
            type="checkbox"
            checked={shell.mono}
            data-testid="opt-mono-toggle"
            onchange={(e) => setShellPref("mono", (e.currentTarget as HTMLInputElement).checked)}
          />
          <span class="bk-text">Use JetBrains Mono for figures</span>
        </label>
        <p class="bk-text-3" style="font-size: 12px; margin-top: 8px; font-style: italic">
          Off falls back to the UI sans-serif for numbers (saves a font request).
        </p>
      </div>
    </div>
  </EdSection>

  <EdSection num={2} title="Theme" deck="Light or dark.">
    <div class="bk-toolbar">
      {#each ["dark", "light"] as t (t)}
        <label style="display: inline-flex; align-items: center; gap: 8px; cursor: pointer; padding: 6px 14px; border: 1px solid var(--border); border-radius: 999px; background: {shell.theme === t ? 'var(--surface)' : 'transparent'}">
          <input
            type="radio"
            name="theme"
            value={t}
            checked={shell.theme === t}
            data-testid={`opt-theme-${t}`}
            onchange={() => setShellPref("theme", t as "dark" | "light")}
          />
          <span class="bk-text" style="text-transform: capitalize">{t}</span>
        </label>
      {/each}
    </div>
  </EdSection>

  <EdSection num={3} title="Density" deck="How tightly rows and controls pack together.">
    <div class="bk-toolbar">
      {#each ["compact", "comfortable", "spacious"] as d (d)}
        <label style="display: inline-flex; align-items: center; gap: 8px; cursor: pointer; padding: 6px 14px; border: 1px solid var(--border); border-radius: 999px; background: {shell.density === d ? 'var(--surface)' : 'transparent'}">
          <input
            type="radio"
            name="density"
            value={d}
            checked={shell.density === d}
            data-testid={`opt-density-${d}`}
            onchange={() => setShellPref("density", d as "compact" | "comfortable" | "spacious")}
          />
          <span class="bk-text" style="text-transform: capitalize">{d}</span>
        </label>
      {/each}
    </div>
  </EdSection>

  <EdSection num={4} title="Assistant" deck="Show the assistant panel by default.">
    <label style="display: inline-flex; align-items: center; gap: 10px; cursor: pointer">
      <input
        type="checkbox"
        checked={shell.chatOpenOnLoad}
        data-testid="opt-chat-toggle"
        onchange={(e) => setShellPref("chatOpenOnLoad", (e.currentTarget as HTMLInputElement).checked)}
      />
      <span class="bk-text">Open the assistant panel on app load</span>
    </label>
    <p class="bk-text-3" style="font-size: 12px; margin-top: 8px; font-style: italic">
      Takes effect on the next page load. You can always toggle it from the chat icon in the top nav.
    </p>
  </EdSection>

  <EdSection num={5} title="Assistant model" deck="Which local model the assistant runs on. Download is managed from the Setup page.">
    {#if modelError}
      <p class="bk-text" style="color: var(--negative); margin: 0 0 10px" data-testid="opt-model-error">{modelError}</p>
    {/if}
    {#if models}
      <div style="display: flex; flex-direction: column; gap: 10px" data-testid="opt-model-picker">
        {#each models.models as m (m.id)}
          <label
            data-testid={`opt-model-row-${m.id}`}
            data-present={m.present}
            data-selected={models.selected === m.id}
            style="display: inline-flex; align-items: center; gap: 10px; cursor: {m.present ? 'pointer' : 'not-allowed'}; padding: 8px 14px; border: 1px solid var(--border); border-radius: 10px; background: {models.selected === m.id ? 'var(--surface)' : 'transparent'}"
          >
            <input
              type="radio"
              name="opt-llama-model"
              value={m.id}
              checked={models.selected === m.id}
              disabled={!m.present || modelBusy}
              data-testid={`opt-model-select-${m.id}`}
              onchange={() => selectModel(m.id)}
            />
            <span>
              <span class="bk-text" style="font-weight: 500">{m.label}</span>
              {#if m.sizeRank > 1}<Badge>smarter</Badge>{:else}<Badge>default</Badge>{/if}
              {#if !m.present}<span class="bk-text-3" style="font-size: 12px"> — not downloaded</span>{/if}
            </span>
          </label>
        {/each}
      </div>
      <p class="bk-text-3" style="font-size: 12px; margin-top: 10px; font-style: italic">
        Switching restarts the assistant and remembers your choice for next launch. To download a model, visit <a href="/setup" style="color: var(--accent)">Setup</a>.
      </p>
    {:else}
      <p class="bk-text" style="margin: 0">Loading models…</p>
    {/if}
  </EdSection>

  <div class="ed-footnotes">
    <div>
      <b>Where these live.</b> Settings persist to <code class="bk-mono">localStorage</code> under
      <code class="bk-mono">budgetkit.editorial.prefs.v1</code>. Clearing site data resets them to defaults.
    </div>
  </div>
</article>
