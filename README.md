# PNG squeeze entry

Deterministic lossless PNG compression in TypeScript for the make.fun PNG squeeze bounty.

The program decodes the stored RGBA input PNG, chooses exact colour representations (RGBA, RGB, grey, grey-alpha, or a palette when the screenshot has at most 256 distinct RGBA values), chooses per-row PNG filters with a deterministic heuristic plus fixed-filter candidates, and writes the smallest zlib level-9 stream among several deterministic zlib strategies. It uses only Node's standard library and writes byte-identical output on repeated runs.
