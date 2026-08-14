<script setup lang="ts">
import type { BuildMetadata } from '~/config/build-metadata'

const buildMetadata = useRuntimeConfig().public.buildMetadata as BuildMetadata
</script>

<template>
  <div py-2>
    <div class="mb-4 rounded-xl border border-blue-500/30 bg-blue-950/20 p-4 text-xs">
      <div class="font-semibold text-blue-300">Application Build</div>
      <div class="mt-2 grid grid-cols-1 gap-1 font-mono text-neutral-300 sm:grid-cols-3">
        <span>Version: {{ buildMetadata.version }}</span>
        <span>Build: {{ buildMetadata.buildSha }}</span>
        <span>Mode: {{ buildMetadata.mode }}</span>
      </div>
    </div>
    <AudioDiagnostics />
  </div>
</template>
