<script lang="ts" setup>
import { appendFileHeaderMetaToBuffer } from 'luby-transform'
import { ModemProfileKey } from '~/acoustic'

enum ReadPhase {
  Idle,
  Reading,
  Ready,
}

const error = ref<any>()
const sliceSize = useLocalStorage<number>('sonic-slice-size', 200)
const selectedProfile = useLocalStorage<ModemProfileKey>('sonic-profile', ModemProfileKey.BALANCED)
const readPhase = ref<ReadPhase>(ReadPhase.Idle)

const filename = ref<string | undefined>()
const contentType = ref<string | undefined>()
const data = ref<Uint8Array | null>(null)

async function onFileChange(file?: File) {
  if (!file) {
    readPhase.value = ReadPhase.Idle
    data.value = null
    return
  }

  try {
    readPhase.value = ReadPhase.Reading

    filename.value = file.name
    contentType.value = file.type || 'application/octet-stream'

    const buffer = await file.arrayBuffer()
    data.value = appendFileHeaderMetaToBuffer(new Uint8Array(buffer), {
      filename: filename.value,
      contentType: contentType.value,
    })

    readPhase.value = ReadPhase.Ready
  }
  catch (e) {
    error.value = e
    readPhase.value = ReadPhase.Idle
    data.value = null
  }
}
</script>

<template>
  <div flex="~ col" h-full w-full gap-6 py-2>
    <!-- File Input Dropzone -->
    <div v-if="readPhase === ReadPhase.Idle" flex flex-col gap-4>
      <!-- Quick Test Banner -->
      <div class="rounded-xl border border-blue-500/30 bg-blue-950/20 p-4 text-xs">
        <h3 class="font-bold text-blue-400 mb-1 flex items-center gap-1.5">
          <span class="i-carbon-information text-sm" />
          Quick Test Guide (2 Devices)
        </h3>
        <ol class="list-decimal list-inside space-y-1 text-neutral-300">
          <li>Open this website on two devices (e.g. Laptop & Phone).</li>
          <li>On Device A, select a small file (1 KB – 10 KB recommended for initial test).</li>
          <li>Use <strong>Robust</strong> or <strong>Balanced</strong> mode.</li>
          <li>On Device B, open <strong>Receive</strong> and grant microphone access.</li>
          <li>Place devices near each other and click <strong>Start Transmission</strong>.</li>
        </ol>
      </div>

      <InputFile
        text="neutral-400"
        aspect-1 sm:aspect-auto sm:h-64 h-full w-full rounded-xl border="2 dashed neutral-800 hover:blue-500/50" transition-colors
        @file="onFileChange"
      />
      <DropZone text="Drop file here to send via sound" @file="onFileChange" />
    </div>

    <!-- Acoustic Transmitter Component -->
    <div v-else-if="readPhase === ReadPhase.Ready && data" flex flex-col gap-6>
      <div flex justify-between items-center border-b border-neutral-800 pb-3>
        <div>
          <h2 text-lg font-bold text-neutral-100>Acoustic File Transmitter</h2>
          <p text-xs text-neutral-400>Converting file into sound data stream</p>
        </div>
        <InputFile border="~ neutral-700" shadow="~" @file="onFileChange">
          <div text-xs text-neutral-300 flex items-center gap-1.5 px-3 py-1.5 font-semibold>
            <span i-carbon:document-add text-sm />
            Change File
          </div>
        </InputFile>
      </div>

      <AcousticSend
        :data="data"
        :filename="filename"
        :content-type="contentType"
        :slice-size="sliceSize"
        :profile-key="selectedProfile"
      />
    </div>
  </div>
</template>
