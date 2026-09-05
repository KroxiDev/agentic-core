export const PRODUCT = "@kroxidev/agentic-core";
export const GITHUB_SPEC = "github:KroxiDev/agentic-core";
export const RUNTIME_FORMAT = "self-contained-v1";
export const RUNTIME_MANIFEST = "runtime-manifest.json";
export const RUNTIME_PAYLOAD_MANIFEST = "payload-manifest.json";

export const RUNTIME_BINS = Object.freeze({
  "agentic-core": "agentic-core.mjs",
  "agentic-quality": "agentic-core.mjs",
});

export const HOST_RESOURCE_SPECS = [
  { source: "src/runtime-launcher.mjs", target: ".agentic-core/runtime-launcher.mjs" },
  ...["read", "production", "tests", "docs"].flatMap((profile) => [
    { source: `adapters/codex/agents/agentic-${profile}.toml`, target: `.codex/agents/agentic-${profile}.toml` },
    { source: `adapters/claude/agents/agentic-${profile}.md`, target: `.claude/agents/agentic-${profile}.md` },
  ]),
  ...["orquestar", "agentic-tdd", "agentic-grilling"].flatMap((skill) => [
    { source: `skills/${skill}/SKILL.md`, target: `.agents/skills/${skill}/SKILL.md` },
    { source: `adapters/claude/skills/${skill}/SKILL.md`, target: `.claude/skills/${skill}/SKILL.md` },
  ]),
];

const runtimeResources = [
  "golden-rules.md",
  ...HOST_RESOURCE_SPECS.map(({ source }) => source),
].map((source) => ({ source, target: `resources/${source}` }));

export const RUNTIME_PAYLOAD_COPIES = [
  ...["dry4python-0.1.0-py3-none-any.whl", "crap4py-0.1.1-py3-none-any.whl", "mutate4py-0.1.4-py3-none-any.whl", "coverage-7.13.4-py3-none-any.whl", "NOTICE.md"].map((name) => ({
    source: `third_party/python/${name}`, target: `third_party/python/${name}`,
  })),
  { source: "src/quality/python-helper.py", target: "python-helper.py" },
  { source: "src/quality/agentic_pytest.py", target: "agentic_pytest.py" },
  { source: "LICENSE", target: "LICENSE" },
  { source: "THIRD_PARTY_NOTICES.md", target: "THIRD_PARTY_NOTICES.md" },
  { source: "node_modules/typescript/LICENSE.txt", target: "third_party/typescript/LICENSE.txt" },
  { source: "node_modules/typescript/ThirdPartyNoticeText.txt", target: "third_party/typescript/ThirdPartyNoticeText.txt" },
  { source: "node_modules/@jridgewell/trace-mapping/LICENSE", target: "third_party/@jridgewell/trace-mapping/LICENSE" },
  { source: "node_modules/@jridgewell/resolve-uri/LICENSE", target: "third_party/@jridgewell/resolve-uri/LICENSE" },
  { source: "node_modules/@jridgewell/sourcemap-codec/LICENSE", target: "third_party/@jridgewell/sourcemap-codec/LICENSE" },
  ...runtimeResources,
];
