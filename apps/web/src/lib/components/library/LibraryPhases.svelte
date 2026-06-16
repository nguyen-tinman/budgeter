<script lang="ts">
  type Phase = "browse" | "preview" | "confirm";

  interface Props {
    phase: Phase;
    onphase: (next: Phase) => void;
    browseCount: number;
    previewCount: number | null;
    confirmCount: number | null;
  }
  const { phase, onphase, browseCount, previewCount, confirmCount }: Props = $props();
</script>

<div class="lib-phases" role="tablist" data-testid="lib-phases">
  <button
    type="button"
    class="lib-phase"
    role="tab"
    aria-current={phase === "browse"}
    data-testid="lib-phase-browse"
    onclick={() => onphase("browse")}
  >
    <span class="lib-phase-num">i.</span>
    <span>Browse</span>
    <span class="lib-phase-count">{browseCount}</span>
  </button>
  <button
    type="button"
    class="lib-phase"
    role="tab"
    aria-current={phase === "preview"}
    disabled={previewCount == null}
    data-testid="lib-phase-preview"
    onclick={() => previewCount != null && onphase("preview")}
  >
    <span class="lib-phase-num">ii.</span>
    <span>Preview candidates</span>
    <span class="lib-phase-count">{previewCount == null ? "—" : previewCount}</span>
  </button>
  <button
    type="button"
    class="lib-phase"
    role="tab"
    aria-current={phase === "confirm"}
    disabled={confirmCount == null || confirmCount === 0}
    data-testid="lib-phase-confirm"
    onclick={() => confirmCount != null && confirmCount > 0 && onphase("confirm")}
  >
    <span class="lib-phase-num">iii.</span>
    <span>Confirm</span>
    <span class="lib-phase-count">{confirmCount == null ? "—" : confirmCount}</span>
  </button>
</div>
