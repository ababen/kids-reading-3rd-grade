import { inject } from './node_modules/@vercel/analytics/dist/index.mjs';

// Initialize Vercel Web Analytics
inject({
  mode: 'auto', // Automatically detect environment (production/development)
  debug: false  // Disable debug logging
});
