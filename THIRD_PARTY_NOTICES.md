# Third-party notices

`@kroxidev/agentic-core` is licensed under MIT. Its production artifact bundles the reachable runtime implementation from the following third-party packages. The persisted runtime does not install their original `node_modules` trees; it keeps the corresponding license and notice files under `third_party/`:

| Package | Version | Relationship | License |
| --- | --- | --- | --- |
| `@jridgewell/resolve-uri` | `3.1.2` | Transitive through `@jridgewell/trace-mapping` | `MIT` |
| `@jridgewell/sourcemap-codec` | `1.5.5` | Transitive through `@jridgewell/trace-mapping` | `MIT` |
| `@jridgewell/trace-mapping` | `0.3.31` | Direct | `MIT` |
| `typescript` | `6.0.3` | Direct | `Apache-2.0` |

The reproducible build uses `esbuild` 0.28.2 as a development-only dependency. `esbuild` executes while preparing the package or building the repository, but its implementation and platform binary are not copied into the production artifact or persisted runtime.

## @jridgewell/trace-mapping 0.3.31

Copyright 2024 Justin Ridgewell <justin@ridgewell.name>

Licensed under the MIT License. The dependency package includes its complete `LICENSE` file.

## @jridgewell/resolve-uri 3.1.2

Copyright 2019 Justin Ridgewell <jridgewell@google.com>

Licensed under the MIT License. The dependency package includes its complete `LICENSE` file.

## @jridgewell/sourcemap-codec 1.5.5

Copyright 2024 Justin Ridgewell <justin@ridgewell.name>

Licensed under the MIT License. The dependency package includes its complete `LICENSE` file.

## TypeScript 6.0.3

TypeScript is authored by Microsoft Corp. and licensed under Apache License 2.0. The dependency package includes the complete `LICENSE.txt` and `ThirdPartyNoticeText.txt`, including the notices for incorporated third-party material.

## MIT license text used by the @jridgewell packages

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
