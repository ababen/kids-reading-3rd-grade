const fs = require('node:fs');
fs.mkdirSync('public', { recursive: true });
for (const file of ['index.html', 'app.js', 'cloud.js', 'stories.js', 'style.css']) {
  fs.copyFileSync(file, `public/${file}`);
}
