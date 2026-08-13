<template>
  <div max-w="full sm:250" mx-auto w-full flex flex-col pb-30>
    <header flex flex-col gap-4 px-4 pb-4 pt-4>
      <nav flex items-center justify-between border-b border-neutral-800 pb-4>
        <!-- Brand Title -->
        <NuxtLink to="/" flex items-center gap-3 text-xl font-bold tracking-tight text-neutral-100 hover:text-blue-400 transition>
          <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600/20 text-blue-400 border border-blue-500/30">
            <span i-carbon-audio-console inline-block text-xl />
          </div>
          <div flex flex-col>
            <span leading-none>Sonic Transfer</span>
            <span text-10px font-normal text-neutral-400 leading-tight mt-0.5>Direct file transfer through sound</span>
          </div>
        </NuxtLink>

        <!-- Navigation Links -->
        <div hidden sm:flex items-center gap-6 text-sm font-semibold>
          <NuxtLink op70 hover="text-blue-400" duration-200 transition="all" to="/" active-class="!op100 text-blue-400" flex="~ items-center gap-1.5">
            <span i-carbon-send-alt inline-block />
            Send
          </NuxtLink>
          <NuxtLink op70 hover="text-blue-400" duration-200 transition="all" to="/receive" active-class="!op100 text-blue-400" flex="~ items-center gap-1.5">
            <span i-carbon-microphone inline-block />
            Receive
          </NuxtLink>
          <NuxtLink op70 hover="text-blue-400" duration-200 transition="all" to="/diagnostics" active-class="!op100 text-blue-400" flex="~ items-center gap-1.5">
            <span i-carbon-meter inline-block />
            Diagnostics
          </NuxtLink>
          <NuxtLink op70 hover="text-blue-400" duration-200 transition="all" to="/settings" active-class="!op100 text-blue-400" flex="~ items-center gap-1.5">
            <span i-carbon-settings inline-block />
            Settings
          </NuxtLink>
        </div>
      </nav>
    </header>
    <main h-full w-full flex-1 px-4>
      <slot />
    </main>
  </div>
</template>
