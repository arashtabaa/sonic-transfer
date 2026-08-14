<script setup lang="ts">
import type { BuildMetadata } from '~/config/build-metadata'
import { useAcousticSessionStore } from '~/stores/acousticSession'

const store = useAcousticSessionStore()
const buildMetadata = useRuntimeConfig().public.buildMetadata as BuildMetadata
</script>

<template>
  <div class="max-w-full sm:max-w-4xl mx-auto w-full flex flex-col min-h-screen pb-24 sm:pb-12">
    <header class="flex flex-col gap-4 px-4 pt-4 pb-2">
      <nav class="flex items-center justify-between border-b border-neutral-800 pb-4">
        <!-- Brand Title -->
        <NuxtLink to="/" class="flex items-center gap-3 text-xl font-bold tracking-tight text-neutral-100 hover:text-blue-400 transition">
          <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600/20 text-blue-400 border border-blue-500/30">
            <span class="i-carbon-audio-console text-xl" />
          </div>
          <div class="flex flex-col">
            <span class="leading-none">Sonic Transfer</span>
            <span class="text-10px font-normal text-neutral-400 leading-tight mt-0.5">Direct file transfer through sound</span>
          </div>
        </NuxtLink>

        <!-- Desktop Navigation Links -->
        <div class="hidden sm:flex items-center gap-6 text-sm font-semibold">
          <NuxtLink op70 hover="text-blue-400" transition="all" to="/" active-class="!op100 text-blue-400" class="flex items-center gap-1.5">
            <span class="i-carbon-send-alt" />
            Send
          </NuxtLink>
          <NuxtLink op70 hover="text-blue-400" transition="all" to="/receive" active-class="!op100 text-blue-400" class="flex items-center gap-1.5">
            <span class="i-carbon-microphone" />
            Receive
          </NuxtLink>
          <NuxtLink op70 hover="text-blue-400" transition="all" to="/diagnostics" active-class="!op100 text-blue-400" class="flex items-center gap-1.5">
            <span class="i-carbon-meter" />
            Diagnostics
          </NuxtLink>
          <NuxtLink op70 hover="text-blue-400" transition="all" to="/settings" active-class="!op100 text-blue-400" class="flex items-center gap-1.5">
            <span class="i-carbon-settings" />
            Settings
          </NuxtLink>
        </div>

        <!-- Live Session Status Chip (Global) -->
        <div v-if="store.isTransmitting || store.isListening" class="flex items-center gap-2 rounded-full border border-neutral-700 bg-neutral-900 px-3 py-1 text-xs font-mono">
          <span class="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
          <span class="font-bold text-neutral-200">{{ store.isTransmitting ? 'Transmitting' : 'Listening' }}</span>
          <button
            class="ml-1 text-red-400 hover:text-red-300 font-bold px-1"
            @click="store.isTransmitting ? store.stopTransmission() : store.stopListening()"
          >
            Stop
          </button>
        </div>
      </nav>
    </header>

    <main class="h-full w-full flex-1 px-4 py-2">
      <slot />
    </main>

    <footer class="px-4 pt-3 text-center text-10px text-neutral-500 font-mono">
      Sonic Transfer v{{ buildMetadata.version }} · Build: {{ buildMetadata.buildSha }}
    </footer>

    <!-- Mobile Bottom Fixed Navigation Bar -->
    <div class="sm:hidden fixed bottom-0 left-0 right-0 z-50 bg-neutral-900/95 border-t border-neutral-800 backdrop-blur-lg px-4 py-2 flex justify-around items-center text-xs font-semibold text-neutral-400 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
      <NuxtLink to="/" active-class="text-blue-400 font-bold" class="flex flex-col items-center gap-1 py-1 px-3 rounded-lg">
        <span class="i-carbon-send-alt text-lg" />
        <span>Send</span>
      </NuxtLink>
      <NuxtLink to="/receive" active-class="text-blue-400 font-bold" class="flex flex-col items-center gap-1 py-1 px-3 rounded-lg">
        <span class="i-carbon-microphone text-lg" />
        <span>Receive</span>
      </NuxtLink>
      <NuxtLink to="/diagnostics" active-class="text-blue-400 font-bold" class="flex flex-col items-center gap-1 py-1 px-3 rounded-lg">
        <span class="i-carbon-meter text-lg" />
        <span>Diag</span>
      </NuxtLink>
      <NuxtLink to="/settings" active-class="text-blue-400 font-bold" class="flex flex-col items-center gap-1 py-1 px-3 rounded-lg">
        <span class="i-carbon-settings text-lg" />
        <span>Settings</span>
      </NuxtLink>
    </div>
  </div>
</template>
