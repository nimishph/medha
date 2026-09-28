import { defineConfig } from 'vitepress';

const repo = 'https://github.com/nimishph/medha';

// Served from https://nimishph.github.io/medha/, so every asset and route is prefixed with the
// repository name. If the repo is renamed, this is the one line that has to change.
const base = '/medha/';

export default defineConfig({
  base,
  title: 'medha',
  description:
    'Evidential memory for the rules, recipes and tools your agents rely on. Medha records what happened and returns trust hints; it never decides for you.',
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: false,
  // The published surface is curated, not the repo: no "edit this page" links back into files that
  // are not part of the site.
  editLink: false,

  // site/README.md is the maintainer-facing note about what may and may not be published. It is a
  // README, not a page: publishing it would put the internal file map and the do-not-publish list on
  // the public site.
  srcExclude: ['README.md'],

  head: [
    ['link', { rel: 'icon', href: `${base}favicon.svg`, type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#0f172a' }],
  ],

  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'medha',

    socialLinks: [{ icon: 'github', link: repo }],

    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
      { text: 'Reference', link: '/cli', activeMatch: '/cli' },
      { text: 'Concepts', link: '/guide/concepts' },
    ],

    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'What medha is', link: '/overview' },
          { text: 'Getting started', link: '/guide/getting-started' },
        ],
      },
      {
        text: 'How it works',
        items: [
          { text: 'Concepts', link: '/guide/concepts' },
          { text: 'How trust is computed', link: '/guide/trust' },
          { text: 'Using it from an agent', link: '/guide/mcp' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'CLI', link: '/cli' },
          { text: 'Parameters and thresholds', link: '/guide/params' },
        ],
      },
      {
        text: 'Going further',
        items: [
          { text: 'Extending medha', link: '/guide/extending' },
          { text: 'Maintenance and sharing', link: '/guide/maintenance' },
          { text: 'Agent skill', link: '/agent-skill' },
        ],
      },
    ],

    outline: { level: [2, 3] },
    docFooter: { prev: 'Previous', next: 'Next' },
    lastUpdated: { text: 'Last updated' },

    search: { provider: 'local' },

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © Nimish Phalnikar',
    },
  },
});
