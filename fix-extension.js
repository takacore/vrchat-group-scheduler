const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, 'out');
const nextDir = path.join(outDir, '_next');
const assetsDir = path.join(outDir, 'assets');

if (!fs.existsSync(outDir)) {
    console.error('✗ out/ does not exist. Run `next build` first — or just use `npm run build`.');
    process.exit(1);
}

// Chrome extensions reject any path segment that starts with "_". Next.js emits
// every asset under out/_next, so the static export is NOT loadable until we
// rename out/_next -> out/assets and rewrite the references below.
if (fs.existsSync(nextDir)) {
    fs.renameSync(nextDir, assetsDir);
    console.log('Renamed out/_next to out/assets');
}

function processDirectory(directory) {
    const files = fs.readdirSync(directory);

    for (const file of files) {
        const fullPath = path.join(directory, file);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            processDirectory(fullPath);
        } else if (file.endsWith('.html') || file.endsWith('.js') || file.endsWith('.css') || file.endsWith('.json')) {
            let content = fs.readFileSync(fullPath, 'utf8');

            // Fix _next -> assets correctly, ensuring relative paths for HTML and replacing absolute ones

            // Step 1: Replace _next with assets everywhere
            let newContent = content.replace(/\/_next\//g, '/assets/');

            // Also handle string literals
            newContent = newContent.replace(/"_next\//g, '"assets/');
            newContent = newContent.replace(/'_next\//g, "'assets/");

            // Step 2: Make the asset paths relative for index.html (and other root htmls)
            if (file.endsWith('.html')) {
                // e.g. src="/assets/... -> src="./assets/...
                newContent = newContent.replace(/src="\/assets\//g, 'src="./assets/');
                newContent = newContent.replace(/href="\/assets\//g, 'href="./assets/');
            }

            // Next.js runtime also uses absolute paths for dynamic imports
            if (file.endsWith('.js')) {
                // Find strings that might be paths and make them relative context
                newContent = newContent.replace(/"\/assets\//g, '"./assets/');
                newContent = newContent.replace(/'\/assets\//g, "'./assets/");
            }

            if (content !== newContent) {
                fs.writeFileSync(fullPath, newContent, 'utf8');
            }
        }
    }
}

processDirectory(outDir);
console.log('Successfully updated references in all files for relative paths.');

// --- Verify the output is actually loadable as an unpacked Chrome extension. ---
// This is the guard that prevents the recurring "Cannot load extension with file
// or directory name _next" failure: if anything is wrong we fail LOUDLY here
// (non-zero exit) instead of silently emitting an out/ that Chrome rejects.
const problems = [];

for (const entry of fs.readdirSync(outDir)) {
    if (entry.startsWith('_')) {
        problems.push(`reserved path "out/${entry}" — Chrome rejects any name starting with "_"`);
    }
}
if (!fs.existsSync(path.join(outDir, 'manifest.json'))) {
    problems.push('out/manifest.json is missing');
}
if (!fs.existsSync(path.join(outDir, 'index.html'))) {
    problems.push('out/index.html is missing');
}

if (problems.length > 0) {
    console.error('\n✗ out/ is NOT a loadable Chrome extension:');
    for (const p of problems) console.error('  - ' + p);
    console.error('\n  Fix: run `npm run build` (it runs next build + this script).');
    console.error('  Never run `next build` / `npx next build` on its own — it re-creates out/_next.\n');
    process.exit(1);
}

console.log('✅ out/ is extension-ready — no "_"-prefixed paths, manifest.json + index.html present.');
console.log('   Load it via chrome://extensions → Developer mode → Load unpacked → select out/');
