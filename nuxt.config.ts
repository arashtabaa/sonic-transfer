import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import packageJson from './package.json'
import { createBuildMetadata } from './app/config/build-metadata'
import { pwa } from './app/config/pwa'
import { appDescription } from './app/constants/index'

function resolveBuildSha(): string | undefined {
  const configuredSha = process.env.GIT_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || process.env.COMMIT_SHA
  if (configuredSha?.trim()) return configuredSha

  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() || undefined
  } catch {
    return undefined
  }
}

const buildMetadata = createBuildMetadata(packageJson.version, resolveBuildSha(), process.env.NODE_ENV || 'production')

const baseURL = process.env.NUXT_APP_BASE_URL || (process.env.NODE_ENV === 'production' ? '/sonic-transfer/' : '/')

export default defineNuxtConfig({
  ssr: false,
  modules: [
    '@vueuse/nuxt',
    '@unocss/nuxt',
    '@pinia/nuxt',
    '@nuxtjs/color-mode',
    '@vite-pwa/nuxt',
    '@nuxt/eslint',
  ],
  typescript: {
    includeWorkspace: true,
  },
  alias: {
    'luby-transform': fileURLToPath(new URL('./packages/luby-transform/src/index.ts', import.meta.url)),
  },

  runtimeConfig: {
    public: {
      buildMetadata,
    },
  },

  experimental: {
    // when using generate, payload js assets included in sw precache manifest
    // but missing on offline, disabling extraction it until fixed
    payloadExtraction: false,
    renderJsonPayloads: true,
    typedPages: true,
  },

  css: [
    '@unocss/reset/tailwind.css',
  ],

  colorMode: {
    classSuffix: '',
  },

  nitro: {
    esbuild: {
      options: {
        target: 'esnext',
      },
    },
    prerender: {
      crawlLinks: true,
      routes: ['/', '/receive', '/settings', '/diagnostics'],
    },
  },

  app: {
    baseURL,
    head: {
      viewport: 'width=device-width,initial-scale=1',
      link: [
        { rel: 'icon', href: `${baseURL}favicon.ico`, sizes: 'any' },
        { rel: 'icon', type: 'image/svg+xml', href: `${baseURL}logo.svg` },
        { rel: 'apple-touch-icon', href: `${baseURL}apple-touch-icon.png` },
      ],
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1, maximum-scale=1' },
        { name: 'description', content: appDescription },
        { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
        { name: 'theme-color', media: '(prefers-color-scheme: light)', content: 'white' },
        { name: 'theme-color', media: '(prefers-color-scheme: dark)', content: '#222222' },
      ],
    },
  },

  pwa,

  devtools: {
    enabled: true,
  },

  features: {
    // For UnoCSS
    inlineStyles: false,
  },

  eslint: {
    config: {
      standalone: false,
    },
  },

  future: {
    compatibilityVersion: 4,
  },

  compatibilityDate: '2024-08-14',
})
