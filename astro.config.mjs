import { defineConfig } from 'astro/config';

export default defineConfig({
  // The portal lives at cohort.tri-ai.org. Astro uses this for
  // generating canonical URLs, sitemap entries, and og:url meta tags.
  // For preview deploys Netlify overrides via context-based env if
  // needed, but the production value is authoritative.
  site: 'https://cohort.tri-ai.org',

  // No sitemap integration here intentionally — the portal isn't a
  // discoverable content site. Students arrive via direct links from
  // emails or the marketing site. Search engines should not index this.
  integrations: [],

  build: {
    inlineStylesheets: 'auto',
  },

  // Prefetch on hover only. The portal has few cross-page navigations
  // (most user time is spent on one form), so aggressive prefetching
  // wastes bandwidth on the mobile users who'll be most of the audience.
  prefetch: {
    defaultStrategy: 'hover',
  },
});
