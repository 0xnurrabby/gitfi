import crypto from "node:crypto";
import { db, nowIso, withTransaction } from "./db.js";
import { appendReceipt, oracleKey, sha256Hex, signBytes } from "./ledger.js";
import { generateLogo } from "./logo.js";
import { config, log } from "./config.js";
import {
  BPS,
  CURVE_SUPPLY_MICRO,
  FEE_BPS,
  GRADUATION_SOLD_MICRO,
  MILESTONE_RESERVE_MICRO,
  TIERS,
  TOTAL_SUPPLY_MICRO,
  curveCostBetween,
  curveCostFromZero,
  curveLaunchPriceMicro,
  curvePriceMicro,
  feeParts,
  graduationBurnMicro,
  graduationPoolTokensMicro,
  maxWalletMicro,
  targetPriceMicro,
  tierForStars,
  type Tier,
} from "../shared/economics.js";
import { VIP_THRESHOLD_BPS } from "../shared/constants.js";

interface SeedUser {
  id: string;
  address: string;
  displayName: string;
  xp: number;
  usdMicro: number;
}

interface TokenSeed {
  repo: {
    fullName: string;
    stars: number;
    forks: number;
    openIssues: number;
    language: string;
    topics: string[];
    description: string;
    createdAt: string;
    pushedAt: string;
    commits: number;
    sizeKb: number;
    health: number;
    starVelocity1h: number;
    starVelocity24h: number;
    license: string;
    homepage?: string;
  };
  name: string;
  ticker: string;
  description: string;
  owner?: { address: string; display: string };
  status: "bonding" | "graduated";
  progressPct: number;
  ageDays: number;
  graduationDaysAgo?: number;
  website?: string;
  twitter?: string;
  summary: [string, string, string];
  readmeExtra: string;
}

const OWNER_USERS = [
  { address: "jarred.gitfi.near", display: "jarred" },
  { address: "simonw.gitfi.near", display: "simonw" },
  { address: "jq.gitfi.near", display: "jq" },
  { address: "opencode.gitfi.near", display: "opencode" },
  { address: "astro.gitfi.near", display: "astro" },
  { address: "gena.gitfi.near", display: "gena" },
  { address: "glow.gitfi.near", display: "glow" },
  { address: "tldraw.gitfi.near", display: "tldraw" },
  { address: "rauchg.gitfi.near", display: "rauchg" },
  { address: "guestbook.gitfi.near", display: "guestbook" },
  { address: "near.create.gitfi.near", display: "near-create" },
  { address: "hello.gitfi.near", display: "hello" },
  { address: "marketplace.gitfi.near", display: "near-market" },
];

const TRADER_NAMES = [
  "lin", "noah", "mika", "tess", "oded", "ravi", "sana", "kuan",
  "iris", "arlo", "nina", "yuki", "zane", "mira", "elle", "finn",
  "juno", "cato", "remy", "sora", "vera", "wren", "aiko", "bruno",
  "cove", "dara", "eden", "faye", "gio", "hana", "ivan", "jade",
  "kai", "luca", "moss", "noor", "opal", "pax", "quinn", "rue",
  "sol", "taro", "uma", "vale", "xen", "yara", "zoe", "ash",
  "bo", "cam", "dee", "eli", "fox", "gray", "hope", "ines",
];

const TOKEN_SEEDS: TokenSeed[] = [
  {
    repo: {
      fullName: "oven-sh/bun",
      stars: 83240,
      forks: 3370,
      openIssues: 2840,
      language: "Zig",
      topics: ["javascript", "runtime", "bundler", "zig", "nodejs"],
      description: "Incredibly fast JavaScript runtime, bundler, test runner, and package manager — all in one.",
      createdAt: "2021-04-14T00:00:00.000Z",
      pushedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
      commits: 9821,
      sizeKb: 182400,
      health: 96,
      starVelocity1h: 9,
      starVelocity24h: 7,
      license: "MIT",
      homepage: "https://bun.sh",
    },
    name: "Bun Runtime",
    ticker: "BUN",
    description: "Own a verified stake in the runtime that is compressing the JavaScript toolchain into a single, absurdly fast binary.",
    owner: { address: "jarred.gitfi.near", display: "jarred" },
    status: "graduated",
    progressPct: 100,
    ageDays: 54,
    graduationDaysAgo: 9,
    website: "https://bun.sh",
    twitter: "https://x.com/bunjavascript",
    summary: [
      "Replaces Node, npm, Jest and esbuild with one fast runtime, bundler, test runner and package manager.",
      "Built for JavaScript and TypeScript teams that care about cold starts, CI minutes and local feedback loops.",
      "The public benchmark surface makes adoption measurable — every performance gain compounds across thousands of projects.",
    ],
    readmeExtra: "Bun is designed as a drop-in replacement for Node.js. It starts fast, ships a native bundler and test runner, and removes an entire layer of tooling from the JavaScript stack.\n\n```bash\nbun install\nbun run index.ts\n```\n\nThe repository is one of the most active infrastructure projects in open source, with daily commits across the runtime, package manager and test runner.",
  },
  {
    repo: {
      fullName: "simonw/llm",
      stars: 8231,
      forks: 724,
      openIssues: 112,
      language: "Python",
      topics: ["llm", "cli", "ai", "sqlite", "python"],
      description: "Access large language models from the command-line and store the results in SQLite.",
      createdAt: "2023-04-08T00:00:00.000Z",
      pushedAt: new Date(Date.now() - 11 * 3600_000).toISOString(),
      commits: 812,
      sizeKb: 1280,
      health: 91,
      starVelocity1h: 2,
      starVelocity24h: 2,
      license: "Apache-2.0",
      homepage: "https://llm.datasette.io",
    },
    name: "LLM CLI",
    ticker: "LLM",
    description: "A terminal-native key to frontier language models, with every prompt and completion captured in a queryable local database.",
    owner: { address: "simonw.gitfi.near", display: "simonw" },
    status: "graduated",
    progressPct: 100,
    ageDays: 38,
    graduationDaysAgo: 12,
    website: "https://llm.datasette.io",
    twitter: "https://x.com/simonw",
    summary: [
      "Turns dozens of language models into one composable CLI and stores every response in SQLite for retrieval and analysis.",
      "Built for developers, researchers and data journalists who want scriptable model access without a platform dependency.",
      "Local-first logs make AI workflows inspectable and reproducible while plugins keep the surface open to any provider.",
    ],
    readmeExtra: "LLM is a command-line tool and Python library for running prompts against large language models. Logs are stored in SQLite, so every output is immediately available for search, export and downstream tooling.\n\n```bash\nllm 'explain this code' -s\nllm logs\n```\n\nInstall plugins for OpenAI, Anthropic, Gemini, local models and more.",
  },
  {
    repo: {
      fullName: "jqlang/jq",
      stars: 33810,
      forks: 1541,
      openIssues: 390,
      language: "C",
      topics: ["json", "cli", "c", "jq"],
      description: "Command-line JSON processor used across nearly every modern software stack.",
      createdAt: "2013-03-13T00:00:00.000Z",
      pushedAt: new Date(Date.now() - 26 * 3600_000).toISOString(),
      commits: 3224,
      sizeKb: 12480,
      health: 89,
      starVelocity1h: 3,
      starVelocity24h: 2,
      license: "MIT",
      homepage: "https://jqlang.github.io/jq/",
    },
    name: "jq",
    ticker: "JQ",
    description: "The small, sharp language that made JSON programmable. A verified slice of the pipe every developer already trusts.",
    owner: { address: "jq.gitfi.near", display: "jq" },
    status: "graduated",
    progressPct: 100,
    ageDays: 44,
    graduationDaysAgo: 16,
    website: "https://jqlang.github.io/jq/",
    twitter: "https://x.com/jqlang",
    summary: [
      "A declarative language and zero-dependency CLI for slicing, transforming and validating JSON streams.",
      "Built for shell users, SREs and data engineers who need predictable structured-data manipulation in every pipeline.",
      "Its grammar is already embedded in millions of scripts; tokenized utility makes that invisible infrastructure visible and supportable.",
    ],
    readmeExtra: "jq is a lightweight and flexible command-line JSON processor. It is a filter language: you describe the transformation and jq streams the result.\n\n```bash\ncat data.json | jq '.items[] | {id, name}'\n```\n\nIt is a standard dependency in shell scripts, CI systems and data pipelines worldwide.",
  },
  {
    repo: {
      fullName: "sst/opencode",
      stars: 30411,
      forks: 2310,
      openIssues: 720,
      language: "TypeScript",
      topics: ["ai", "cli", "agents", "typescript"],
      description: "An open-source, provider-agnostic coding agent built for the terminal.",
      createdAt: "2024-06-01T00:00:00.000Z",
      pushedAt: new Date(Date.now() - 90 * 60_000).toISOString(),
      commits: 5412,
      sizeKb: 35200,
      health: 93,
      starVelocity1h: 6,
      starVelocity24h: 5,
      license: "MIT",
      homepage: "https://opencode.ai",
    },
    name: "OpenCode Agent",
    ticker: "CODE",
    description: "A terminal-native coding agent with open provider routing, live repository context and a fast-growing developer community.",
    owner: { address: "opencode.gitfi.near", display: "opencode" },
    status: "graduated",
    progressPct: 100,
    ageDays: 29,
    graduationDaysAgo: 5,
    website: "https://opencode.ai",
    twitter: "https://x.com/opencode",
    summary: [
      "Puts an open, model-agnostic coding agent directly in the terminal with deep repository awareness.",
      "Built for developers who want strong agentic workflows without locking prompts, tools or model choices to one vendor.",
      "An aggressively shipping public codebase creates a real feedback loop between daily users, contributors and provider competition.",
    ],
    readmeExtra: "OpenCode is an AI coding agent built for the terminal. It connects to the providers you choose and works directly inside your repository.\n\n```bash\nnpm i -g opencode-ai\nopencode\n```\n\nEvery layer is open: providers, tools, prompts and the orchestration loop.",
  },
  {
    repo: {
      fullName: "withastro/starlight",
      stars: 7412,
      forks: 861,
      openIssues: 204,
      language: "TypeScript",
      topics: ["documentation", "astro", "static-site", "typescript"],
      description: "Build beautiful, high-performance documentation websites with Astro.",
      createdAt: "2023-02-17T00:00:00.000Z",
      pushedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
      commits: 2140,
      sizeKb: 19620,
      health: 90,
      starVelocity1h: 1,
      starVelocity24h: 2,
      license: "MIT",
      homepage: "https://starlight.astro.build",
    },
    name: "Starlight Docs",
    ticker: "STAR",
    description: "The docs framework quietly powering thousands of developer products, now with a liquid market for its maintenance.",
    owner: { address: "astro.gitfi.near", display: "astro" },
    status: "graduated",
    progressPct: 100,
    ageDays: 21,
    graduationDaysAgo: 2,
    website: "https://starlight.astro.build",
    twitter: "https://x.com/astrodotbuild",
    summary: [
      "Gives open-source projects a batteries-included documentation theme with search, i18n and accessibility built in.",
      "Built for maintainers and developer-relations teams who need excellent docs without designing a site from scratch.",
      "Better documentation measurably improves adoption, and a token gives users a direct way to fund the layer they rely on.",
    ],
    readmeExtra: "Starlight is a documentation theme built on Astro. Bring Markdown or MDX, get navigation, search, dark mode and a polished default design.\n\n```bash\nnpm create astro@latest -- --template starlight\n```\n\nIt is designed to stay out of the way of the content.",
  },
  {
    repo: {
      fullName: "microsoft/genaiscript",
      stars: 2761,
      forks: 318,
      openIssues: 146,
      language: "TypeScript",
      topics: ["ai", "scripting", "typescript", "llm"],
      description: "A programmable AI scripting language and tooling for composable LLM workflows.",
      createdAt: "2023-06-26T00:00:00.000Z",
      pushedAt: new Date(Date.now() - 5 * 3600_000).toISOString(),
      commits: 1938,
      sizeKb: 30800,
      health: 87,
      starVelocity1h: 1,
      starVelocity24h: 1,
      license: "MIT",
      homepage: "https://microsoft.github.io/genaiscript",
    },
    name: "GenAIScript",
    ticker: "GENA",
    description: "Scriptable AI workflows with real files, typed context and repeatable prompts — built for teams that want code, not chat history.",
    owner: { address: "gena.gitfi.near", display: "gena" },
    status: "bonding",
    progressPct: 72,
    ageDays: 16,
    website: "https://microsoft.github.io/genaiscript",
    twitter: "https://x.com/genaiscript",
    summary: [
      "Makes LLM workflows programmable with JavaScript, typed file context and reusable scripts that run in CI.",
      "Built for engineers automating code review, documentation, data extraction and repository analysis at scale.",
      "Bringing software discipline to AI workflows makes automations reproducible instead of trapped in one-off chat threads.",
    ],
    readmeExtra: "GenAIScript is a scripting language for AGI tasks. It provides a familiar JavaScript environment, file access, tool calls and repeatable runs.\n\n```bash\nnpm install -g genaiscript\ngena run review.genai.mts\n```\n\nUse it for repo analysis, content generation and agentic CI jobs.",
  },
  {
    repo: {
      fullName: "charmbracelet/glow",
      stars: 22611,
      forks: 483,
      openIssues: 92,
      language: "Go",
      topics: ["markdown", "cli", "terminal", "go"],
      description: "A terminal-first Markdown reader with style, speed and a serious appreciation for the command line.",
      createdAt: "2020-01-15T00:00:00.000Z",
      pushedAt: new Date(Date.now() - 38 * 3600_000).toISOString(),
      commits: 472,
      sizeKb: 4100,
      health: 80,
      starVelocity1h: 0,
      starVelocity24h: 1,
      license: "MIT",
      homepage: "https://github.com/charmbracelet/glow",
    },
    name: "Glow",
    ticker: "GLOW",
    description: "Markdown for the terminal, rendered beautifully. A small utility with an outsized place in the developer's daily loop.",
    owner: { address: "glow.gitfi.near", display: "glow" },
    status: "bonding",
    progressPct: 66,
    ageDays: 13,
    summary: [
      "Renders Markdown beautifully in the terminal, including syntax highlighting, lists, tables and remote READMEs.",
      "Built for terminal-first developers who read documentation, changelogs and notes without leaving the shell.",
      "Small utilities create constant, quiet leverage; a token lets the people who use it every day support its upkeep.",
    ],
    readmeExtra: "Glow reads Markdown on the command line and renders it with a proper pager, theme and navigation.\n\n```bash\nglow README.md\nglow github.com/charmbracelet/glow\n```\n\nIt is part of a family of small, composable terminal tools.",
  },
  {
    repo: {
      fullName: "tldraw/tldraw",
      stars: 43810,
      forks: 2774,
      openIssues: 460,
      language: "TypeScript",
      topics: ["canvas", "react", "drawing", "typescript"],
      description: "A tiny, powerful React canvas for drawing, diagramming and infinite multiplayer collaboration.",
      createdAt: "2021-04-21T00:00:00.000Z",
      pushedAt: new Date(Date.now() - 7 * 3600_000).toISOString(),
      commits: 4622,
      sizeKb: 102400,
      health: 91,
      starVelocity1h: 3,
      starVelocity24h: 2,
      license: "Apache-2.0",
      homepage: "https://tldraw.dev",
    },
    name: "tldraw canvas",
    ticker: "TDRW",
    description: "An infinite React canvas with real multiplayer primitives — the rare design tool whose code is as considered as its surfaces.",
    owner: { address: "tldraw.gitfi.near", display: "tldraw" },
    status: "bonding",
    progressPct: 76,
    ageDays: 9,
    website: "https://tldraw.dev",
    twitter: "https://x.com/tldraw",
    summary: [
      "Provides a production-ready infinite canvas and multiplayer drawing primitives as a React library.",
      "Built for product teams embedding whiteboards, diagramming or spatial interfaces into their own applications.",
      "Its permissive SDK turns a hard interaction problem into a dependency, while the repo's velocity keeps it ahead of copycats.",
    ],
    readmeExtra: "tldraw is a React library for creating infinite canvas experiences. It ships with drawing tools, multiplayer sync primitives and a thoughtfully designed editor.\n\n```bash\nnpm install tldraw\n```\n\nUse it as a complete whiteboard or as a foundation for a new spatial product.",
  },
  {
    repo: {
      fullName: "vercel/ai",
      stars: 18342,
      forks: 3120,
      openIssues: 740,
      language: "TypeScript",
      topics: ["ai", "sdk", "react", "nextjs", "typescript"],
      description: "The open-source TypeScript toolkit for building AI-native applications and streaming interfaces.",
      createdAt: "2023-05-23T00:00:00.000Z",
      pushedAt: new Date(Date.now() - 70 * 60_000).toISOString(),
      commits: 6120,
      sizeKb: 68900,
      health: 92,
      starVelocity1h: 4,
      starVelocity24h: 3,
      license: "Apache-2.0",
      homepage: "https://sdk.vercel.ai",
    },
    name: "AI SDK",
    ticker: "AISDK",
    description: "The TypeScript interface between models and product surfaces — streaming, tools, structured output and edge deployment in one toolkit.",
    owner: { address: "rauchg.gitfi.near", display: "rauchg" },
    status: "bonding",
    progressPct: 49,
    ageDays: 11,
    website: "https://sdk.vercel.ai",
    twitter: "https://x.com/vercel",
    summary: [
      "Unifies text, structured objects, tool calls and streaming across model providers behind a typed TypeScript API.",
      "Built for product engineers shipping AI interfaces with React, Next.js and edge runtimes.",
      "A stable, open interface layer reduces provider lock-in and makes model experiments cheaper to turn into products.",
    ],
    readmeExtra: "The AI SDK is a TypeScript toolkit for building AI applications with React, Next.js, Vue, Svelte and Node.\n\n```bash\nnpm install ai @ai-sdk/openai\n```\n\nIt provides streaming helpers, tool calling, structured generation and hooks for UI integration.",
  },
  {
    repo: {
      fullName: "karpathy/nanoGPT",
      stars: 52118,
      forks: 7024,
      openIssues: 381,
      language: "Python",
      topics: ["gpt", "llm", "pytorch", "education"],
      description: "The simplest, fastest repository for training and fine-tuning medium-sized GPTs.",
      createdAt: "2022-12-28T00:00:00.000Z",
      pushedAt: new Date(Date.now() - 18 * 3600_000).toISOString(),
      commits: 183,
      sizeKb: 1820,
      health: 82,
      starVelocity1h: 12,
      starVelocity24h: 8,
      license: "MIT",
      homepage: "https://github.com/karpathy/nanoGPT",
    },
    name: "nanoGPT",
    ticker: "NGPT",
    description: "The canonical minimal GPT trainer. A public education asset with enormous mindshare and no verified maintainer yet on GitFi.",
    status: "bonding",
    progressPct: 41,
    ageDays: 6,
    summary: [
      "A compact, readable PyTorch implementation for training and fine-tuning medium-sized GPT models from scratch.",
      "Built for ML learners, researchers and engineers who want to understand the full training loop without framework archaeology.",
      "It is one of the most-forked AI education repositories in the world, making it a high-signal discovery surface for new talent.",
    ],
    readmeExtra: "nanoGPT is the simplest repository for training medium-sized GPTs. The code is intentionally minimal and legible.\n\n```bash\npython train.py config/train_shakespeare_char.py\n```\n\nIt includes data preparation, training, sampling and fine-tuning examples. The repository is widely used in courses and self-study.",
  },
  {
    repo: {
      fullName: "near-examples/guest-book",
      stars: 214,
      forks: 97,
      openIssues: 12,
      language: "JavaScript",
      topics: ["near", "smart-contracts", "react", "examples"],
      description: "The classic NEAR guest book example: a complete contract-plus-frontend introduction to the network.",
      createdAt: "2020-05-11T00:00:00.000Z",
      pushedAt: new Date(Date.now() - 6 * 86_400_000).toISOString(),
      commits: 286,
      sizeKb: 1560,
      health: 78,
      starVelocity1h: 0,
      starVelocity24h: 0,
      license: "MIT",
    },
    name: "NEAR Guest Book",
    ticker: "BOOK",
    description: "The first contract many NEAR developers deploy. A small, legible public good with a long educational tail.",
    owner: { address: "guestbook.gitfi.near", display: "guestbook" },
    status: "bonding",
    progressPct: 58,
    ageDays: 18,
    summary: [
      "Demonstrates a complete NEAR smart contract with a React frontend that reads and writes state on-chain.",
      "Built for new NEAR developers who want one working reference before building their own first dApp.",
      "Reference examples determine how quickly an ecosystem onboarding path works; a token aligns maintenance with adoption.",
    ],
    readmeExtra: "A complete guest book example for NEAR. The repository contains a Rust contract and a React frontend.\n\n```bash\nnpm install\nnpm run deploy\nnpm run start\n```\n\nUse it as a starting point for your first NEAR application.",
  },
  {
    repo: {
      fullName: "near/create-near-app",
      stars: 178,
      forks: 68,
      openIssues: 8,
      language: "TypeScript",
      topics: ["near", "cli", "developer-tools", "typescript"],
      description: "The fastest path from an empty directory to a working NEAR application.",
      createdAt: "2022-02-10T00:00:00.000Z",
      pushedAt: new Date(Date.now() - 12 * 86_400_000).toISOString(),
      commits: 362,
      sizeKb: 2980,
      health: 73,
      starVelocity1h: 1,
      starVelocity24h: 0,
      license: "MIT",
    },
    name: "Create NEAR App",
    ticker: "NCA",
    description: "The front door to NEAR development. Scaffolding, sensible defaults and a fast first success, funded by the people who use it.",
    owner: { address: "near.create.gitfi.near", display: "near-create" },
    status: "bonding",
    progressPct: 34,
    ageDays: 8,
    summary: [
      "Generates a working NEAR dApp scaffold with a contract, frontend and sensible deployment defaults.",
      "Built for developers evaluating NEAR who want a first transaction before committing to a larger build.",
      "A great first-run experience is an ecosystem's most leveraged growth channel, and this repo owns that surface.",
    ],
    readmeExtra: "Create NEAR App scaffolds a complete NEAR project in one command.\n\n```bash\nnpx create-near-app@latest\n```\n\nChoose a contract language and frontend, then deploy to testnet in under a minute.",
  },
  {
    repo: {
      fullName: "near-examples/hello-near",
      stars: 92,
      forks: 41,
      openIssues: 4,
      language: "Rust",
      topics: ["near", "rust", "smart-contracts", "education"],
      description: "The smallest useful NEAR contract: one state variable, one getter, one setter.",
      createdAt: "2021-01-08T00:00:00.000Z",
      pushedAt: new Date(Date.now() - 21 * 86_400_000).toISOString(),
      commits: 91,
      sizeKb: 420,
      health: 67,
      starVelocity1h: 0,
      starVelocity24h: 0,
      license: "MIT",
    },
    name: "Hello NEAR",
    ticker: "HELLO",
    description: "A 30-line smart contract that has taught thousands of developers what state on NEAR feels like. Minimal, honest infrastructure.",
    owner: { address: "hello.gitfi.near", display: "hello" },
    status: "bonding",
    progressPct: 21,
    ageDays: 5,
    summary: [
      "Shows the smallest complete stateful contract on NEAR — deploy, call a setter, read the getter.",
      "Built for absolute beginners who need a working mental model before adding accounts, tokens or frontends.",
      "The easiest examples carry the most teaching weight; even tiny repos deserve observable, community-funded maintenance.",
    ],
    readmeExtra: "The minimal NEAR smart contract example. It stores a greeting and exposes two methods.\n\n```rust\n#[near(contract_state)]\npub struct Contract { greeting: String }\n```\n\nDeploy it, call `set_greeting`, then read it back.",
  },
  {
    repo: {
      fullName: "near-examples/near-marketplace",
      stars: 126,
      forks: 52,
      openIssues: 6,
      language: "TypeScript",
      topics: ["near", "nft", "marketplace", "examples"],
      description: "A complete NFT marketplace reference implementation on NEAR, from minting to royalties.",
      createdAt: "2021-09-02T00:00:00.000Z",
      pushedAt: new Date(Date.now() - 9 * 86_400_000).toISOString(),
      commits: 184,
      sizeKb: 5400,
      health: 72,
      starVelocity1h: 2,
      starVelocity24h: 1,
      license: "MIT",
    },
    name: "NEAR Marketplace",
    ticker: "MKT",
    description: "A full NFT marketplace reference on NEAR — contracts, storage, royalties and a working buyer flow in one public repository.",
    owner: { address: "marketplace.gitfi.near", display: "near-market" },
    status: "bonding",
    progressPct: 89,
    ageDays: 22,
    summary: [
      "Implements NFT minting, sales, bids and royalty distribution as a readable NEAR reference application.",
      "Built for developers and studios who need a real marketplace starting point instead of disconnected contract snippets.",
      "NFT utility lives or dies on reference implementations; funding this repo makes the next thousand marketplaces cheaper to build.",
    ],
    readmeExtra: "A complete NFT marketplace example for NEAR. Includes an NEP-171 contract, sale mechanics, royalties and a React frontend.\n\n```bash\nnpm install\nnpm run test\n```\n\nUse it as a reference for minting and trading digital assets.",
  },
];

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashId(prefix: string, value: string): string {
  return `${prefix}${crypto.createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

function readmeFor(def: TokenSeed): string {
  return `# ${def.repo.fullName.split("/")[1]}

${def.repo.description}

[![stars](https://img.shields.io/github/stars/${def.repo.fullName}?style=flat-square)](https://github.com/${def.repo.fullName})

${def.readmeExtra}

## Why it exists

Open-source infrastructure is load-bearing, but most of the value it creates is captured elsewhere. This repository is indexed on GitFi.fun so its users and maintainers can price its utility in public.

## Status

- Repository: [${def.repo.fullName}](https://github.com/${def.repo.fullName})
- License: ${def.repo.license}
- Active development: yes

## Contributing

Read the contribution guide, open an issue with a minimal reproduction, and keep patches small.
`;
}

interface SimTrade {
  id: string;
  user: SeedUser;
  side: "buy" | "sell";
  phase: "curve" | "dex";
  tokens: bigint;
  base: bigint;
  fee: bigint;
  time: number;
  priceMicro: number;
  parts: ReturnType<typeof feeParts>;
  noise?: boolean;
}

interface TokenSimulation {
  tokenId: string;
  sold: bigint;
  reserve: bigint;
  price: bigint;
  poolQuote: bigint;
  poolToken: bigint;
  burned: bigint;
  milestoneReserve: bigint;
  volumeTotal: bigint;
  volume24h: bigint;
  devFees: bigint;
  dividendFees: bigint;
  trades: SimTrade[];
  holdings: Map<string, { amount: bigint; cost: bigint; realized: bigint }>;
  userBalances: Map<string, number>;
  starBurns: Array<{ stars: number; milestone: number; burn: number; time: number }>;
  graduatedAt: number | null;
}

async function seedToken(
  def: TokenSeed,
  tokenIndex: number,
  users: SeedUser[],
  owners: Map<string, SeedUser>,
  rng: () => number,
  now: number,
): Promise<void> {
  const fullName = def.repo.fullName;
  const repoId = hashId("repo_", fullName);
  const tokenId = hashId("tok_", fullName);
  const slug = `${def.ticker.toLowerCase()}-${fullName.split("/")[1]!.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const tier: Tier = tierForStars(def.repo.stars);
  const tierConfig = TIERS[tier];
  const createdAt = now - def.ageDays * 86_400_000;
  const launchTime = createdAt + Math.floor(rng() * 2 * 3_600_000);
  const curveEnd =
    def.status === "graduated"
      ? now - (def.graduationDaysAgo ?? 8) * 86_400_000
      : now - Math.floor((20 + rng() * 90) * 60_000);
  const owner = def.owner ? owners.get(def.owner.address) : undefined;
  if (def.owner && !owner) throw new Error(`Missing seed owner ${def.owner.address}`);
  const logo = await generateLogo(def.ticker, fullName);
  const readme = readmeFor(def);
  const starStep = tierConfig.starStep;
  const lastMilestone = Math.floor(def.repo.stars / starStep) * starStep;
  const milestoneCount = Math.min(3, Math.floor(lastMilestone / starStep));
  const starBurns: TokenSimulation["starBurns"] = [];
  let starReserve = MILESTONE_RESERVE_MICRO;
  let starsBurned = 0n;
  for (let i = milestoneCount; i > 0; i -= 1) {
    const milestone = lastMilestone - (i - 1) * starStep;
    if (milestone <= 0) continue;
    const burn = BigInt(Math.min(tierConfig.burnPerMilestoneMicro, starReserve));
    if (burn <= 0n) break;
    starBurns.push({
      stars: milestone,
      milestone,
      burn: Number(burn),
      time: Math.max(
        launchTime + 3_600_000,
        now - Math.floor((1 + rng() * Math.max(1, def.ageDays - 1)) * 86_400_000),
      ),
    });
    starReserve -= Number(burn);
    starsBurned += burn;
  }
  void starBurns;

  const gradTargetSold = BigInt(GRADUATION_SOLD_MICRO);
  const finalSold =
    def.status === "graduated"
      ? gradTargetSold
      : (gradTargetSold * BigInt(Math.max(5, Math.min(94, def.progressPct)))) / 100n;
  const cap = maxWalletMicro(tier);
  const capAllowance = cap;
  const investorPool = users.filter((u) => u.id !== owner?.id);
  const plans = new Map<string, bigint>();
  if (owner) {
    const target = (finalSold * BigInt(2 + Math.floor(rng() * 3))) / 100n;
    plans.set(owner.id, target < capAllowance / 5n ? target : capAllowance / 5n);
  }
  let allocatedByOwner = 0n;
  for (const value of plans.values()) allocatedByOwner += value;
  let remainingAllocation = finalSold - allocatedByOwner;
  const holderCountTarget = tier === "viral" ? 42 : tier === "rising" ? 24 : 16;
  const people = investorPool
    .slice()
    .sort(() => rng() - 0.5)
    .slice(0, Math.min(holderCountTarget, investorPool.length));
  const share = remainingAllocation / BigInt(people.length);
  for (const person of people) {
    if (remainingAllocation <= 0n) break;
    const jitter = BigInt(55 + Math.floor(rng() * 75));
    let amount = (share * jitter) / 100n;
    if (amount > capAllowance) amount = capAllowance;
    if (amount > remainingAllocation) amount = remainingAllocation;
    plans.set(person.id, (plans.get(person.id) ?? 0n) + amount);
    remainingAllocation -= amount;
  }
  if (remainingAllocation > 0n) {
    for (const person of investorPool) {
      if (remainingAllocation <= 0n) break;
      const held = plans.get(person.id) ?? 0n;
      const room = capAllowance - held;
      if (room <= 0n) continue;
      const add = room < remainingAllocation ? room : remainingAllocation;
      plans.set(person.id, held + add);
      remainingAllocation -= add;
    }
  }
  if (remainingAllocation > 0n) throw new Error(`Seed allocation failed for ${fullName}`);

  const simulation: TokenSimulation = {
    tokenId,
    sold: 0n,
    reserve: 0n,
    price: curveLaunchPriceMicro(tier),
    poolQuote: 0n,
    poolToken: 0n,
    burned: starsBurned,
    milestoneReserve: BigInt(starReserve),
    volumeTotal: 0n,
    volume24h: 0n,
    devFees: 0n,
    dividendFees: 0n,
    trades: [],
    holdings: new Map(),
    userBalances: new Map(users.map((u) => [u.id, u.usdMicro])),
    starBurns,
    graduatedAt: null,
  };
  const userById = new Map(users.map((u) => [u.id, u]));
  const addTrade = (
    user: SeedUser,
    side: "buy" | "sell",
    phase: "curve" | "dex",
    tokens: bigint,
    base: bigint,
    fee: bigint,
    time: number,
    feePartsLocal = feeParts(fee),
    noise = false,
  ) => {
    const priceMicro =
      phase === "curve"
        ? Number(curvePriceMicro(tier, simulation.sold))
        : Number(simulation.price);
    simulation.trades.push({
      id: hashId("trd_", `${fullName}-${simulation.trades.length}-${time}`),
      user,
      side,
      phase,
      tokens,
      base,
      fee,
      time,
      priceMicro,
      parts: feePartsLocal,
      noise,
    });
    simulation.volumeTotal += base;
    if (time >= now - 86_400_000) simulation.volume24h += base;
    simulation.devFees += feePartsLocal.developer;
    simulation.dividendFees += feePartsLocal.dividend;
    const balance = simulation.userBalances.get(user.id) ?? user.usdMicro;
    simulation.userBalances.set(
      user.id,
      balance + (side === "buy" ? -Number(base + fee) : Number(base - fee)),
    );
    user.xp += Math.max(1, Math.floor(Number(base + fee) / 100_000));
  };

  // Expand holder allocations into a sequence of purchases.
  const buyPlans: Array<{ user: SeedUser; amount: bigint }> = [];
  for (const [userId, amount] of plans) {
    const user = userById.get(userId)!;
    let left = amount;
    const chunks = 1 + Math.floor(rng() * 3);
    for (let i = 0; i < chunks; i += 1) {
      const part =
        i === chunks - 1
          ? left
          : (amount * BigInt(18 + Math.floor(rng() * 24))) / 100n;
      left -= part;
      if (part > 0n) buyPlans.push({ user, amount: part });
    }
    if (left > 0n) buyPlans.push({ user, amount: left });
  }
  // Chronological timestamps, weighted toward recent activity.
  buyPlans.sort(() => rng() - 0.5);
  const curveStart = launchTime + 15 * 60_000;
  const curveEndForBuys = curveEnd - 15 * 60_000;
  for (let i = 0; i < buyPlans.length; i += 1) {
    const fraction = (i + 1) / buyPlans.length;
    const time =
      curveStart +
      Math.floor((curveEndForBuys - curveStart) * Math.pow(fraction, 1.35)) +
      Math.floor(rng() * 900_000);
    const plan = buyPlans[i]!;
    let q = plan.amount;
    if (simulation.sold + q > finalSold) q = finalSold - simulation.sold;
    if (q <= 0n) continue;
    const base = curveCostBetween(tier, simulation.sold, q);
    const fee = (base * BigInt(FEE_BPS) + BigInt(BPS) - 1n) / BigInt(BPS);
    simulation.sold += q;
    simulation.reserve += base;
    simulation.price = curvePriceMicro(tier, simulation.sold);
    const holding = simulation.holdings.get(plan.user.id) ?? { amount: 0n, cost: 0n, realized: 0n };
    holding.amount += q;
    holding.cost += base + fee;
    simulation.holdings.set(plan.user.id, holding);
    addTrade(plan.user, "buy", "curve", q, base, fee, Math.min(time, now - 5 * 60_000));
  }
  // Add sell/rebuy volatility so the chart contains both directions.
  const holderIds = [...simulation.holdings.keys()].filter((id) => id !== owner?.id);
  const dipCount = def.status === "graduated" ? 7 : 9;
  for (let d = 0; d < dipCount; d += 1) {
    const userId = holderIds[Math.floor(rng() * holderIds.length)];
    if (!userId) continue;
    const holding = simulation.holdings.get(userId)!;
    if (holding.amount <= 1_000_000n) continue;
    const q = holding.amount / BigInt(12 + Math.floor(rng() * 15));
    if (q <= 0n || simulation.sold <= q) continue;
    const sellBase = curveCostBetween(tier, simulation.sold - q, q);
    const sellFee = (sellBase * BigInt(FEE_BPS) + BigInt(BPS) - 1n) / BigInt(BPS);
    const costReduction = (holding.cost * q) / holding.amount;
    holding.amount -= q;
    holding.cost -= costReduction;
    holding.realized += sellBase - sellFee - costReduction;
    simulation.sold -= q;
    simulation.reserve -= sellBase;
    simulation.price = curvePriceMicro(tier, simulation.sold);
    const baseTime =
      def.status === "graduated"
        ? curveEnd - (dipCount - d) * 3 * 3_600_000
        : now - (dipCount - d) * 2.4 * 3_600_000;
    addTrade(userById.get(userId)!, "sell", "curve", q, sellBase, sellFee, baseTime);
    const bounceBase = curveCostBetween(tier, simulation.sold, q);
    const bounceFee = (bounceBase * BigInt(FEE_BPS) + BigInt(BPS) - 1n) / BigInt(BPS);
    simulation.sold += q;
    simulation.reserve += bounceBase;
    simulation.price = curvePriceMicro(tier, simulation.sold);
    holding.amount += q;
    holding.cost += bounceBase + bounceFee;
    addTrade(userById.get(userId)!, "buy", "curve", q, bounceBase, bounceFee, baseTime + 120_000);
  }
  // Ensure final state is exactly at target.
  const finalPrice = curvePriceMicro(tier, simulation.sold);
  simulation.price = finalPrice;
  if (simulation.sold !== finalSold) {
    throw new Error(`Seed sold mismatch for ${fullName}: ${simulation.sold} vs ${finalSold}`);
  }

  if (def.status === "graduated") {
    const at = curveEnd;
    simulation.graduatedAt = at;
    simulation.poolQuote = simulation.reserve;
    simulation.poolToken = graduationPoolTokensMicro();
    simulation.burned += graduationBurnMicro();
    simulation.price = targetPriceMicro(tier);
    const dexStart = at + 8 * 3_600_000;
    const dexTradeCount = 8 + Math.floor(rng() * 5);
    for (let i = 0; i < dexTradeCount; i += 1) {
      const buyer = investorPool[Math.floor(rng() * investorPool.length)]!;
      let base = (simulation.poolQuote * BigInt(8 + Math.floor(rng() * 36))) / 1000n;
      if (i === dexTradeCount - 1 && ["BUN", "CODE", "JQ"].includes(def.ticker)) {
        base = (simulation.poolQuote * 32n) / 1000n;
      }
      if (base < 500_000n) base = 500_000n;
      const fee = (base * BigInt(FEE_BPS) + BigInt(BPS) - 1n) / BigInt(BPS);
      const tokensOut = (simulation.poolToken * base) / (simulation.poolQuote + base);
      if (tokensOut <= 0n) continue;
      const time =
        dexStart +
        Math.floor(((now - 15 * 60_000 - dexStart) * (i + 1)) / dexTradeCount) +
        Math.floor(rng() * 600_000);
      simulation.poolQuote += base;
      simulation.poolToken -= tokensOut;
      simulation.price = (simulation.poolQuote * 1_000_000n) / simulation.poolToken;
      const holding = simulation.holdings.get(buyer.id) ?? { amount: 0n, cost: 0n, realized: 0n };
      holding.amount += tokensOut;
      holding.cost += base + fee;
      simulation.holdings.set(buyer.id, holding);
      addTrade(buyer, "buy", "dex", tokensOut, base, fee, Math.min(time, now - 5 * 60_000));
    }
    // Recent micro-flow for a rich 24-hour candle series.
    const flowCount = 14;
    for (let i = 0; i < flowCount; i += 1) {
      const time = now - (flowCount - i) * 95 * 60_000 + Math.floor(rng() * 300_000);
      if (i % 4 === 1) {
        const sellerId = [...simulation.holdings.entries()].find(([, h]) => h.amount > 1_000_000n)?.[0];
        if (!sellerId) continue;
        const holding = simulation.holdings.get(sellerId)!;
        const q = holding.amount / BigInt(40 + Math.floor(rng() * 40));
        if (q <= 0n) continue;
        const gross = (simulation.poolQuote * q) / (simulation.poolToken + q);
        if (gross <= 0n) continue;
        const fee = (gross * BigInt(FEE_BPS) + BigInt(BPS) - 1n) / BigInt(BPS);
        const costReduction = (holding.cost * q) / holding.amount;
        holding.amount -= q;
        holding.cost -= costReduction;
        holding.realized += gross - fee - costReduction;
        simulation.poolQuote -= gross;
        simulation.poolToken += q;
        simulation.price = (simulation.poolQuote * 1_000_000n) / simulation.poolToken;
        addTrade(userById.get(sellerId)!, "sell", "dex", q, gross, fee, time);
      } else {
        const buyer = investorPool[Math.floor(rng() * investorPool.length)]!;
        const base = (simulation.poolQuote * BigInt(3 + Math.floor(rng() * 9))) / 10_000n;
        if (base < 300_000n) continue;
        const fee = (base * BigInt(FEE_BPS) + BigInt(BPS) - 1n) / BigInt(BPS);
        const tokensOut = (simulation.poolToken * base) / (simulation.poolQuote + base);
        if (tokensOut <= 0n) continue;
        simulation.poolQuote += base;
        simulation.poolToken -= tokensOut;
        simulation.price = (simulation.poolQuote * 1_000_000n) / simulation.poolToken;
        const holding = simulation.holdings.get(buyer.id) ?? { amount: 0n, cost: 0n, realized: 0n };
        holding.amount += tokensOut;
        holding.cost += base + fee;
        simulation.holdings.set(buyer.id, holding);
        addTrade(buyer, "buy", "dex", tokensOut, base, fee, time);
      }
    }
  }

  // Recent microstructure: paired sell/re-buy flow gives the 24h candle series
  // realistic body density without changing the inventory held by users.
  const noiseHolder = [...simulation.holdings.entries()]
    .filter(([userId, h]) => h.amount > 10_000_000n && userId !== owner?.id)
    .sort((a, b) => Number(b[1].amount - a[1].amount))[0];
  if (noiseHolder) {
    const [noiseId, noiseHolding] = noiseHolder;
    const noiseUser = userById.get(noiseId)!;
    const pairCount = 40;
    const stepMs = (23 * 3_600_000 - 15 * 60_000) / pairCount;
    for (let i = 0; i < pairCount; i += 1) {
      const time = now - 23 * 3_600_000 + i * stepMs + Math.floor(rng() * 180_000);
      const holding = simulation.holdings.get(noiseId)!;
      const q = holding.amount / BigInt(38 + (i % 19));
      if (q <= 0n) break;
      if (simulation.graduatedAt) {
        if (simulation.poolToken <= q) continue;
        const gross = (simulation.poolQuote * q) / (simulation.poolToken + q);
        const fee = (gross * BigInt(FEE_BPS) + BigInt(BPS) - 1n) / BigInt(BPS);
        const costReduction = (holding.cost * q) / holding.amount;
        holding.amount -= q;
        holding.cost -= costReduction;
        holding.realized += gross - fee - costReduction;
        simulation.poolQuote -= gross;
        simulation.poolToken += q;
        simulation.price = (simulation.poolQuote * 1_000_000n) / simulation.poolToken;
        addTrade(noiseUser, "sell", "dex", q, gross, fee, time, feeParts(fee), true);
        const buyBase = (simulation.poolQuote * q) / (simulation.poolToken - q);
        const buyFee = (buyBase * BigInt(FEE_BPS) + BigInt(BPS) - 1n) / BigInt(BPS);
        simulation.poolQuote += buyBase;
        simulation.poolToken -= q;
        simulation.price = (simulation.poolQuote * 1_000_000n) / simulation.poolToken;
        holding.amount += q;
        holding.cost += buyBase + buyFee;
        addTrade(noiseUser, "buy", "dex", q, buyBase, buyFee, time + 180_000 + Math.floor(rng() * 180_000), feeParts(buyFee), true);
      } else {
        if (simulation.sold <= q) continue;
        const gross = curveCostBetween(tier, simulation.sold - q, q);
        const fee = (gross * BigInt(FEE_BPS) + BigInt(BPS) - 1n) / BigInt(BPS);
        const costReduction = (holding.cost * q) / holding.amount;
        holding.amount -= q;
        holding.cost -= costReduction;
        holding.realized += gross - fee - costReduction;
        simulation.sold -= q;
        simulation.price = curvePriceMicro(tier, simulation.sold);
        addTrade(noiseUser, "sell", "curve", q, gross, fee, time, feeParts(fee), true);
        const buyBase = curveCostBetween(tier, simulation.sold, q);
        const buyFee = (buyBase * BigInt(FEE_BPS) + BigInt(BPS) - 1n) / BigInt(BPS);
        simulation.sold += q;
        simulation.price = curvePriceMicro(tier, simulation.sold);
        holding.amount += q;
        holding.cost += buyBase + buyFee;
        addTrade(noiseUser, "buy", "curve", q, buyBase, buyFee, time + 180_000 + Math.floor(rng() * 180_000), feeParts(buyFee), true);
      }
    }
  }

  const holderCount = [...simulation.holdings.values()].filter((h) => h.amount > 0n).length;
  const vipThreshold = Math.floor((TOTAL_SUPPLY_MICRO * VIP_THRESHOLD_BPS) / 10_000);
  const tokenMeta = {
    spec: "ft-1.0.0",
    schema: "gitfi-token/1.0",
    name: def.name,
    symbol: def.ticker,
    ticker: def.ticker,
    description: def.description,
    icon: `${config.appUrl.replace(/\/$/, "")}${logo.logoUrl}`,
    image: `${config.appUrl.replace(/\/$/, "")}${logo.logoUrl}`,
    reference: `${config.appUrl.replace(/\/$/, "")}/token/${slug}`,
    repo: fullName,
    tier,
    total_supply: "1000000000",
    decimals: 6,
    owner: owner?.address ?? null,
    verified_repository: Boolean(owner),
  };
  const nftMeta = {
    title: `GitFi Repo Deed · ${fullName}`,
    description: `The unique protocol deed for the ${fullName} repository token ($${def.ticker}), staked to the GitFi vault.`,
    media: `${config.appUrl.replace(/\/$/, "")}${logo.logoUrl}`,
    image: `${config.appUrl.replace(/\/$/, "")}${logo.logoUrl}`,
    reference: `${config.appUrl.replace(/\/$/, "")}/token/${slug}`,
    copies: 1,
    repo: fullName,
    tokenId,
    owner: owner?.address ?? null,
    attributes: { repo: fullName, tier, github_stars: def.repo.stars, ticker: def.ticker },
  };
  const deedPayload = {
    standard: "gitfi-repo-deed/1.0",
    repo: fullName,
    tokenId,
    owner: owner?.address ?? null,
    metadataUri: `/api/nft/${tokenId}/metadata`,
    nonce: crypto.randomBytes(16).toString("hex"),
    issuedAt: iso(createdAt),
  };
  const deedSig = signBytes(JSON.stringify(deedPayload));
  const nftId = hashId("nft_", fullName);

  withTransaction(() => {
    db.prepare(
      `INSERT INTO repos(
        id, full_name, full_name_lc, owner, name, description, homepage, stars, forks, watchers,
        open_issues, language, topics_json, license, default_branch, github_created_at, pushed_at,
        commit_count, last_commit_at, size_kb, is_fork, is_private, is_archived, health_score,
        star_velocity_1h, star_velocity_24h, sync_state, last_synced_at, readme_md, readme_sha,
        readme_fetched_at, summary_json, summary_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'main', ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, 'ok', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      repoId,
      fullName,
      fullName.toLowerCase(),
      fullName.split("/")[0]!,
      fullName.split("/")[1]!,
      def.repo.description,
      def.repo.homepage ?? null,
      def.repo.stars,
      def.repo.forks,
      Math.floor(def.repo.forks * 0.62),
      def.repo.openIssues,
      def.repo.language,
      JSON.stringify(def.repo.topics),
      def.repo.license,
      def.repo.createdAt,
      def.repo.pushedAt,
      def.repo.commits,
      def.repo.pushedAt,
      def.repo.sizeKb,
      def.repo.health,
      def.repo.starVelocity1h,
      def.repo.starVelocity24h,
      iso(now),
      readme,
      sha256Hex(readme),
      iso(now),
      JSON.stringify(def.summary),
      iso(now),
      iso(createdAt),
      iso(now),
    );
    db.prepare(
      `INSERT INTO star_snapshots(repo_id, stars, taken_at) VALUES (?, ?, ?)`,
    ).run(repoId, def.repo.stars, iso(now));
    db.prepare(
      `INSERT INTO star_snapshots(repo_id, stars, taken_at) VALUES (?, ?, ?)`,
    ).run(
      repoId,
      Math.max(0, def.repo.stars - def.repo.starVelocity1h),
      iso(now - 3_600_000),
    );

    const initialPrice = Number(curveLaunchPriceMicro(tier));
    db.prepare(
      `INSERT INTO tokens(
        id, repo_id, slug, name, ticker, description, logo_url, metadata_json, website, twitter,
        owner_wallet, creator_wallet, verification, status, tier, target_market_cap_micro,
        total_supply_micro, curve_supply_micro, milestone_reserve_micro, sold_micro, reserve_micro,
        pool_quote_micro, pool_token_micro, burned_micro, last_price_micro, volume_24h_micro,
        volume_total_micro, holder_count, unclaimed_dev_vault_micro, vip_threshold_micro,
        launch_at, launched_at, graduated_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      tokenId,
      repoId,
      slug,
      def.name,
      def.ticker,
      def.description,
      logo.logoUrl,
      JSON.stringify(tokenMeta),
      def.website ?? def.repo.homepage ?? null,
      def.twitter ?? null,
      owner?.address ?? null,
      owner?.address ?? users[(tokenIndex + 2) % users.length]!.address,
      owner ? "verified" : "community",
      def.status,
      tier,
      tierConfig.targetMarketCapMicro,
      TOTAL_SUPPLY_MICRO,
      CURVE_SUPPLY_MICRO,
      Number(simulation.milestoneReserve),
      Number(simulation.sold),
      Number(simulation.reserve),
      Number(simulation.poolQuote),
      Number(simulation.poolToken),
      Number(simulation.burned),
      initialPrice,
      0,
      0,
      0,
      0,
      vipThreshold,
      iso(launchTime),
      iso(launchTime),
      simulation.graduatedAt ? iso(simulation.graduatedAt) : null,
      iso(createdAt),
      iso(now),
    );
    if (owner) {
      db.prepare(
        `INSERT INTO repo_verifications(id, repo_id, user_id, wallet, readme_sha, verified_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(hashId("rvf_", fullName), repoId, owner.id, owner.address, sha256Hex(readme), iso(createdAt));
    }
    db.prepare(
      `INSERT INTO price_points(token_id, time, price_micro, volume_micro, type, label)
       VALUES (?, ?, ?, 0, 'launch', 'Curve launch')`,
    ).run(tokenId, launchTime, initialPrice);
    for (const trade of simulation.trades) {
      db.prepare(
        `INSERT INTO trades(id, token_id, user_id, wallet, side, phase, token_micro, usd_micro, fee_micro, price_micro, tx_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        trade.id,
        tokenId,
        trade.user.id,
        trade.user.address,
        trade.side,
        trade.phase,
        Number(trade.tokens),
        Number(trade.base),
        Number(trade.fee),
        trade.priceMicro,
        sha256Hex(`${trade.id}|seed`),
        iso(trade.time),
      );
      db.prepare(
        `INSERT INTO fee_events(id, trade_id, token_id, dev_fee_micro, platform_gross_micro, dividend_micro, platform_net_micro, referral_micro, dev_to_vault, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(
        hashId("fee_", trade.id),
        trade.id,
        tokenId,
        Number(trade.parts.developer),
        Number(trade.parts.platformGross),
        Number(trade.parts.dividend),
        Number(trade.parts.platformNet),
        owner ? 0 : 1,
        iso(trade.time),
      );
      db.prepare(
        `INSERT INTO price_points(token_id, time, price_micro, volume_micro, type, trade_id)
         VALUES (?, ?, ?, ?, 'trade', ?)`,
      ).run(
        tokenId,
        trade.time,
        trade.priceMicro,
        Number(trade.base),
        trade.id,
      );
    }
    if (simulation.graduatedAt) {
      db.prepare(
        `INSERT INTO price_points(token_id, time, price_micro, volume_micro, type, label)
         VALUES (?, ?, ?, 0, 'graduation', 'DEX graduation')`,
      ).run(tokenId, simulation.graduatedAt, Number(targetPriceMicro(tier)));
      db.prepare(
        `INSERT INTO activities(id, token_id, type, actor_wallet, message, metadata_json, created_at)
         VALUES (?, ?, 'graduation', NULL, ?, '{}', ?)`,
      ).run(
        hashId("act_", `${fullName}-grad`),
        tokenId,
        `$${def.ticker} graduated with $${(Number(simulation.reserve) / 1_000_000).toLocaleString("en-US")} of investor-funded liquidity`,
        iso(simulation.graduatedAt),
      );
    }
    for (const event of simulation.starBurns) {
      db.prepare(
        `INSERT INTO star_events(id, token_id, repo_id, stars, milestone, burn_micro, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        hashId("str_", `${tokenId}-${event.milestone}`),
        tokenId,
        repoId,
        event.stars,
        event.milestone,
        event.burn,
        iso(event.time),
      );
      db.prepare(
        `INSERT INTO activities(id, token_id, type, actor_wallet, message, metadata_json, created_at)
         VALUES (?, ?, 'star', NULL, ?, ?, ?)`,
      ).run(
        hashId("act_", `${fullName}-star-${event.milestone}`),
        tokenId,
        `${fullName} crossed ${event.stars.toLocaleString()} GitHub stars — ${(event.burn / 1_000_000).toLocaleString()} $${def.ticker} burned`,
        JSON.stringify({ stars: event.stars, burnMicro: event.burn }),
        iso(event.time),
      );
    }
    for (const [userId, holding] of simulation.holdings) {
      if (holding.amount <= 0n) continue;
      const isDev = owner?.id === userId;
      const vestingActive = Boolean(isDev && def.status === "bonding");
      db.prepare(
        `INSERT INTO holdings(user_id, token_id, amount_micro, cost_micro, realized_pnl_micro, vesting_locked_micro, vesting_until, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        userId,
        tokenId,
        Number(holding.amount),
        Number(holding.cost),
        Number(holding.realized),
        vestingActive ? Number(holding.amount) : 0,
        vestingActive
          ? new Date(now + tierConfig.vestingDays * 86_400_000).toISOString()
          : null,
        iso(now),
      );
    }
    // Stakes and dividend accrual.
    const stakers = [...simulation.holdings.entries()]
      .filter(([userId, h]) => h.amount > 0n && userId !== owner?.id)
      .sort((a, b) => Number(b[1].amount - a[1].amount))
      .slice(0, 4);
    let totalStaked = 0n;
    for (const [userId, holding] of stakers) {
      const amount = (holding.amount * 18n) / 100n;
      if (amount <= 0n) continue;
      totalStaked += amount;
      const lockDays = [7, 30, 90][Math.floor(rng() * 3)]!;
      const multiplier = lockDays === 7 ? 10_000 : lockDays === 30 ? 12_500 : 15_000;
      const started = now - Math.floor(2 + rng() * 10) * 86_400_000;
      db.prepare(
        `INSERT INTO stakes(id, user_id, token_id, amount_micro, lock_days, multiplier_bps, reward_debt_scaled, started_at, unlock_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '0', ?, ?, ?)`,
      ).run(
        hashId("stk_", `${tokenId}-${userId}`),
        userId,
        tokenId,
        Number(amount),
        lockDays,
        multiplier,
        iso(started),
        new Date(now + Math.floor(1 + rng() * 30) * 86_400_000).toISOString(),
        iso(started),
      );
    }
    let acc = "0";
    if (simulation.dividendFees > 0n && totalStaked > 0n) {
      acc = String((simulation.dividendFees * 1_000_000_000_000_000_000n) / totalStaked);
      db.prepare(
        `INSERT INTO dividend_events(id, token_id, trade_id, amount_micro, created_at)
         VALUES (?, ?, NULL, ?, ?)`,
      ).run(
        hashId("dvd_", tokenId),
        tokenId,
        Number(simulation.dividendFees),
        iso(now - 3_600_000),
      );
    }
    const unclaimedVault = !owner ? simulation.devFees : 0n;
    if (owner && simulation.devFees > 0n) {
      db.prepare(
        `INSERT INTO earnings(id, user_id, wallet, token_id, source, amount_micro, created_at)
         VALUES (?, ?, ?, ?, 'developer', ?, ?)`,
      ).run(
        hashId("ern_", `${tokenId}-${owner.id}`),
        owner.id,
        owner.address,
        tokenId,
        Number(simulation.devFees),
        iso(now - 4 * 3_600_000),
      );
    }
    db.prepare(
      `UPDATE tokens SET sold_micro = ?, reserve_micro = ?, pool_quote_micro = ?, pool_token_micro = ?,
        burned_micro = ?, milestone_reserve_micro = ?, last_price_micro = ?, volume_24h_micro = ?,
        volume_total_micro = ?, holder_count = ?, unclaimed_dev_vault_micro = ?,
        dividend_acc_scaled = ?, total_staked_micro = ?, pending_yield_micro = ?,
        status = ?, graduated_at = ?, updated_at = ? WHERE id = ?`,
    ).run(
      Number(simulation.sold),
      Number(simulation.reserve),
      Number(simulation.poolQuote),
      Number(simulation.poolToken),
      Number(simulation.burned),
      Number(simulation.milestoneReserve),
      Number(simulation.price),
      Number(simulation.volume24h),
      Number(simulation.volumeTotal),
      holderCount,
      Number(unclaimedVault),
      acc,
      Number(totalStaked),
      simulation.dividendFees > 0n && totalStaked === 0n ? Number(simulation.dividendFees) : 0,
      def.status,
      simulation.graduatedAt ? iso(simulation.graduatedAt) : null,
      iso(now),
      tokenId,
    );
    for (const [userId, balance] of simulation.userBalances) {
      const user = userById.get(userId);
      if (!user) continue;
      user.usdMicro = Math.max(0, Math.round(balance));
      db.prepare("UPDATE users SET usd_micro = ?, xp = ? WHERE id = ?").run(
        user.usdMicro,
        user.xp,
        userId,
      );
    }
    db.prepare(
      `INSERT INTO repo_nfts(id, repo_id, token_id, owner_wallet, status, metadata_uri, metadata_json, tx_hash, oracle_signature, oracle_public_key, minted_at, claimed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      nftId,
      repoId,
      tokenId,
      owner?.address ?? null,
      owner ? "staked" : "escrowed",
      `/api/nft/${tokenId}/metadata`,
      JSON.stringify(nftMeta),
      sha256Hex(JSON.stringify(deedPayload)),
      deedSig,
      oracleKey().publicKeyHex,
      iso(createdAt),
      owner ? iso(createdAt) : null,
      iso(now),
    );
    db.prepare(
      `INSERT INTO activities(id, token_id, type, actor_wallet, message, metadata_json, created_at)
       VALUES (?, ?, 'launch', ?, ?, ?, ?)`,
    ).run(
      hashId("act_", `${fullName}-launch`),
      tokenId,
      owner?.address ?? null,
      owner
        ? `launched $${def.ticker} for ${fullName}`
        : `community-indexed $${def.ticker} for ${fullName}`,
      JSON.stringify({ tier, mode: owner ? "owner" : "community" }),
      iso(launchTime),
    );
    // A few recent trade activities make the live feed legible.
    const recentTrades = simulation.trades
      .filter((t) => !t.noise && t.time > now - 18 * 3_600_000)
      .slice(-3);
    for (const trade of recentTrades) {
      db.prepare(
        `INSERT INTO activities(id, token_id, type, actor_wallet, message, metadata_json, created_at)
         VALUES (?, ?, 'trade', ?, ?, ?, ?)`,
      ).run(
        hashId("act_", `${fullName}-recent-${trade.id}`),
        tokenId,
        trade.user.address,
        `${trade.side === "buy" ? "bought" : "sold"} ${(Number(trade.tokens) / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 0 })} $${def.ticker} for $${(Number(trade.base) / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 })}`,
        JSON.stringify({ side: trade.side, usdMicro: Number(trade.base) }),
        iso(trade.time),
      );
    }
    appendReceipt("repo.nft.mint", repoId, {
      nftId,
      repo: fullName,
      tokenId,
      owner: owner?.address ?? null,
      status: owner ? "staked" : "escrowed",
      deedSignature: deedSig,
    });
    appendReceipt("token.mint", tokenId, {
      tokenId,
      repo: fullName,
      ticker: def.ticker,
      tier,
      targetMarketCapMicro: tierConfig.targetMarketCapMicro,
    });
    if (simulation.graduatedAt) {
      appendReceipt("token.graduate", tokenId, {
        tokenId,
        graduatedAt: iso(simulation.graduatedAt),
        poolTokensMicro: Number(simulation.poolToken),
        reserveMicro: Number(simulation.reserve),
      });
    }
  });
}

export async function seedDemoData(force = false): Promise<void> {
  const existing = (db.prepare("SELECT COUNT(*) AS count FROM tokens").get() as { count: number }).count;
  if (existing > 0 && !force) {
    log("seed skipped: database already contains markets");
    return;
  }
  if (existing > 0) throw new Error("Database is already populated. Delete data/gitfi.db to reseed.");
  const rng = mulberry32(0x671f1);
  const now = Date.now();
  const users: SeedUser[] = [];
  const owners = new Map<string, SeedUser>();
  for (const [index, owner] of OWNER_USERS.entries()) {
    const user: SeedUser = {
      id: hashId("usr_", owner.address),
      address: owner.address,
      displayName: owner.display,
      xp: 900 + Math.floor(rng() * 4200),
      usdMicro: 500_000_000_000,
    };
    owners.set(owner.address, user);
    users.push(user);
    db.prepare(
      `INSERT OR IGNORE INTO users(id, address, display_name, xp, usd_micro, referral_code, is_sandbox, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      user.id,
      user.address,
      user.displayName,
      user.xp,
      user.usdMicro,
      `SEED${String(index + 1).padStart(3, "0")}`,
      iso(now - 180 * 86_400_000),
      iso(now),
    );
  }
  for (let i = 0; i < TRADER_NAMES.length; i += 1) {
    const name = TRADER_NAMES[i]!;
    const address = `${name}${100 + i}.gitfi.near`;
    const user: SeedUser = {
      id: hashId("usr_", address),
      address,
      displayName: name,
      xp: Math.floor(80 + rng() * 9200),
      usdMicro: 250_000_000_000,
    };
    users.push(user);
    db.prepare(
      `INSERT OR IGNORE INTO users(id, address, display_name, xp, usd_micro, referral_code, is_sandbox, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      user.id,
      user.address,
      user.displayName,
      user.xp,
      user.usdMicro,
      `TRD${String(i + 1).padStart(3, "0")}`,
      iso(now - Math.floor(30 + rng() * 180) * 86_400_000),
      iso(now),
    );
  }
  for (const [index, def] of TOKEN_SEEDS.entries()) {
    await seedToken(def, index, users, owners, rng, now);
  }

  // Seed social surface: proposals, bounties and gated chat.
  const byTicker = new Map<string, { tokenId: string; repoId: string; owner?: SeedUser }>();
  for (const def of TOKEN_SEEDS) {
    byTicker.set(def.ticker, {
      tokenId: hashId("tok_", def.repo.fullName),
      repoId: hashId("repo_", def.repo.fullName),
      owner: def.owner ? owners.get(def.owner.address) : undefined,
    });
  }
  const tokenOwnerWallet = (ticker: string) => byTicker.get(ticker)?.owner?.address ?? null;
  const tokenInfo = (ticker: string) => {
    const row = db
      .prepare("SELECT * FROM tokens WHERE ticker = ?")
      .get(ticker) as
      | {
          id: string;
          slug: string;
          name: string;
          owner_wallet: string | null;
          vip_threshold_micro: number;
          sold_micro: number;
          total_supply_micro: number;
        }
      | undefined;
    return row;
  };

  // Bounties: escrowed from the verified developer's purchased inventory.
  const bounties: Array<{ ticker: string; title: string; description: string; reward: number; status: "open" | "review" | "paid" }> = [
    {
      ticker: "BUN",
      title: "Reproduce HTTP/2 stream reset edge case",
      description: "A minimal reproduction for premature RST_STREAM on long-lived fetches behind a proxy. Include a failing test in the Bun test runner.",
      reward: 180_000,
      status: "open",
    },
    {
      ticker: "CODE",
      title: "Add a repository-map tool",
      description: "Build a read-only tool that summarizes a monorepo into a symbol graph an agent can query. Must include tests and docs.",
      reward: 95_000,
      status: "review",
    },
    {
      ticker: "JQ",
      title: "Harden jq play ground escaping",
      description: "Audit the playground HTML renderer for injection edge cases and ship a regression harness.",
      reward: 42_000,
      status: "open",
    },
  ];
  for (const b of bounties) {
    const info = tokenInfo(b.ticker);
    if (!info?.owner_wallet) continue;
    const owner = db
      .prepare("SELECT * FROM users WHERE address = ?")
      .get(info.owner_wallet) as SeedUser | undefined;
    if (!owner) continue;
    const holding = db
      .prepare("SELECT * FROM holdings WHERE user_id = ? AND token_id = ?")
      .get(owner.id, info.id) as { amount_micro: number; vesting_locked_micro: number } | undefined;
    if (!holding || holding.amount_micro < b.reward * 1_000_000 + holding.vesting_locked_micro) continue;
    db.prepare(
      "UPDATE holdings SET amount_micro = amount_micro - ?, updated_at = ? WHERE user_id = ? AND token_id = ?",
    ).run(b.reward * 1_000_000, iso(now), owner.id, info.id);
    const id = hashId("bnt_", `${b.ticker}-${b.title}`);
    db.prepare(
      `INSERT INTO bounties(id, token_id, creator_wallet, title, description, reward_micro, status, claimant_wallet, submission_url, created_at, updated_at, paid_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL)`,
    ).run(
      id,
      info.id,
      owner.address,
      b.title,
      b.description,
      b.reward * 1_000_000,
      b.status,
      iso(now - 2 * 86_400_000),
      iso(now),
    );
    if (b.status === "review") {
      const claimant = users.find((u) => u.id !== owner.id)!;
      db.prepare(
        `INSERT INTO bounty_submissions(id, bounty_id, user_id, wallet, url, note, created_at, selected)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      ).run(
        hashId("bsb_", id),
        id,
        claimant.id,
        claimant.address,
        "https://github.com/opencode-ai/opencode/pull/seed-demo",
        "Implementation and regression tests attached. Ready for review.",
        iso(now - 5 * 3_600_000),
      );
      db.prepare("UPDATE bounties SET claimant_wallet = ? WHERE id = ?").run(claimant.address, id);
    }
  }

  // Proposals and votes.
  const proposalSeeds: Array<{ ticker: string; title: string; kind: "pr" | "issue" | "feature"; url: string }> = [
    {
      ticker: "CODE",
      title: "Adopt the repository-map tool as a core command",
      kind: "pr",
      url: "https://github.com/sst/opencode/pulls",
    },
    {
      ticker: "BUN",
      title: "Prioritize native Windows ARM64 builds",
      kind: "issue",
      url: "https://github.com/oven-sh/bun/issues",
    },
    {
      ticker: "STAR",
      title: "Ship first-class versioned docs presets",
      kind: "feature",
      url: "https://github.com/withastro/starlight/discussions",
    },
  ];
  for (const [i, proposal] of proposalSeeds.entries()) {
    const info = tokenInfo(proposal.ticker);
    if (!info) continue;
    const proposer = byTicker.get(proposal.ticker)?.owner ?? users[20 + i]!;
    const proposalId = hashId("prp_", `${proposal.ticker}-${proposal.title}`);
    db.prepare(
      `INSERT INTO proposals(id, token_id, creator_wallet, title, url, kind, status, closes_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    ).run(
      proposalId,
      info.id,
      proposer.address,
      proposal.title,
      proposal.url,
      proposal.kind,
      iso(now + 5 * 86_400_000),
      iso(now - 2 * 86_400_000),
    );
    const voters = users.slice(16 + i * 3, 22 + i * 3);
    for (const voter of voters) {
      const holding = db
        .prepare("SELECT amount_micro FROM holdings WHERE user_id = ? AND token_id = ?")
        .get(voter.id, info.id) as { amount_micro: number } | undefined;
      if (!holding?.amount_micro) continue;
      const choice = voter.id.charCodeAt(5) % 5 === 0 ? "no" : "yes";
      db.prepare(
        `INSERT INTO proposal_votes(proposal_id, user_id, wallet, weight_micro, choice, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        proposalId,
        voter.id,
        voter.address,
        holding.amount_micro,
        choice,
        iso(now - 3_600_000),
      );
    }
  }

  // Chat messages.
  const chatSeeds: Array<{ ticker: string; house: string; text: string }> = [
    {
      ticker: "BUN",
      house: "jarred.gitfi.near",
      text: "Draft build of the new bundler cache is in the VIP room files. Looking for Windows repros before Friday.",
    },
    {
      ticker: "BUN",
      house: "lin100.gitfi.near",
      text: "Ran it against our 240k-module monorepo. Cold install dropped from 41s to 26s.",
    },
    {
      ticker: "BUN",
      house: "tess103.gitfi.near",
      text: "The lockfile diff is much smaller too. I'll post the benchmark script.",
    },
    {
      ticker: "CODE",
      house: "opencode.gitfi.near",
      text: "Next alpha drops the polling loop entirely. Holders get the beta channel first — post your OS + provider here.",
    },
    {
      ticker: "CODE",
      house: "mika102.gitfi.near",
      text: "macOS arm64 + local Qwen working perfectly. Tool call latency feels down by half.",
    },
    {
      ticker: "STAR",
      house: "astro.gitfi.near",
      text: "The versioned docs preset RFC is open for holder vote. This is the closest to shipping a real design partner loop.",
    },
    {
      ticker: "NGPT",
      house: "nina108.gitfi.near",
      text: "Community room, no maintainer yet. If you're the repo owner, paste the sync line in the README and this entire vault is yours.",
    },
  ];
  for (const msg of chatSeeds) {
    const info = tokenInfo(msg.ticker);
    if (!info) continue;
    const user = users.find((u) => u.address === msg.house);
    if (!user) continue;
    db.prepare(
      `INSERT INTO chat_messages(id, token_id, user_id, wallet, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      hashId("cht_", `${msg.ticker}-${msg.text}`),
      info.id,
      user.id,
      user.address,
      msg.text,
      iso(now - Math.floor(10 + Math.random() * 400) * 60_000),
    );
  }

  // Additional recent protocol activity.
  const extraActivity = [
    {
      type: "claim",
      wallet: "near.create.gitfi.near",
      message: "claimed $NCA and unlocked developer royalties",
      minutesAgo: 28,
    },
    {
      type: "verify",
      wallet: "opencode.gitfi.near",
      message: "refreshed the README proof for sst/opencode",
      minutesAgo: 74,
    },
    {
      type: "dividend",
      wallet: "lin100.gitfi.near",
      message: "claimed holder dividends from $BUN",
      minutesAgo: 118,
    },
    {
      type: "stake",
      wallet: "mika102.gitfi.near",
      message: "staked $LLM for 90 days",
      minutesAgo: 164,
    },
  ];
  for (const [i, item] of extraActivity.entries()) {
    db.prepare(
      `INSERT INTO activities(id, type, actor_wallet, message, metadata_json, created_at)
       VALUES (?, ?, ?, ?, '{}', ?)`,
    ).run(
      hashId("act_", `extra-${i}`),
      item.type,
      item.wallet,
      item.message,
      iso(now - item.minutesAgo * 60_000),
    );
  }

  log(`seed complete: ${TOKEN_SEEDS.length} markets, ${users.length} demo identities`);
  db.prepare(
    `UPDATE users SET realized_pnl_micro = COALESCE(
       (SELECT SUM(realized_pnl_micro) FROM holdings WHERE holdings.user_id = users.id), 0
     )`,
  ).run();
}

export async function seedDemo(): Promise<void> {
  await seedDemoData();
}
