const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, 'out');
const nextDir = path.join(outDir, '_next');
const assetsDir = path.join(outDir, 'assets');

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

if (fs.existsSync(outDir)) {
    processDirectory(outDir);
    console.log('Successfully updated references in all files for relative paths.');
}
