const fs = require('node:fs');
fs.mkdirSync('public', { recursive: true });
for (const file of ['index.html', 'app.js', 'cloud.js', 'stories.js', 'style.css', 'analytics.js']) {
  fs.copyFileSync(file, `public/${file}`);
}
// Copy node_modules/@vercel/analytics/dist to public for module import
fs.cpSync('node_modules/@vercel/analytics/dist', 'public/node_modules/@vercel/analytics/dist', { recursive: true });
