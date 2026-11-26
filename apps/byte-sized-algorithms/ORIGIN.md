# Algo Lab Local Copy

Upstream: https://byte-sized-algorithms.vercel.app/

Original design and implementation: Dilum Sanjaya (@DilumSanjaya).

This directory contains the public static build, including 86 lessons, all
available translations, diagrams, and local fonts. The original download hashes
are recorded in `upstream-manifest.json`.

Local integration changes:

- Use relative entry, font and lazy preload URLs for GitHub Pages subdirectories.
- Keep only Learn in the top navigation; remove the author link from the header.
- Start in Simplified Chinese and inherit the blog theme on the first visit.
- Point sharing metadata to the local published page.

To refresh the upstream files and reapply these changes, run
`node tools/mirror-algorithms.mjs` from the blog repository. The script stops if
the upstream code no longer matches the known patch points. Review and run
`node tools/verify-algorithms.mjs` before publishing a refreshed build.
