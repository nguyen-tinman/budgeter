<script lang="ts">
  interface Props {
    section: string;
    kicker: string;
    title: string;
    rightLabel?: string;
    byline?: string;
  }
  const { section, kicker, title, rightLabel, byline }: Props = $props();
</script>

<div class="ed-pagehead">
  <div class="ed-page-kicker">
    <span>{section}</span>
    <em>{kicker}</em>
    {#if rightLabel}<span style="margin-left: auto">{rightLabel}</span>{/if}
  </div>
  <h1>{title}</h1>
  {#if byline}<div class="ed-byline">{byline}</div>{/if}
</div>
