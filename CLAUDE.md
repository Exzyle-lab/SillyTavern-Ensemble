# CLAUDE.md

This file provides guidance to Claude Code when working with the SillyTavern-Ensemble extension.

## Project Overview

**SillyTavern-Ensemble** is a SillyTavern extension enabling GM/Narrator characters to orchestrate **parallel NPC generation** via function calling, routing requests to Claude Code and Gemini CLI through EasyCLI, with **structural knowledge isolation** via lorebook filtering.

### The Problem

SillyTavern's group chat generates character responses **sequentially**. A scene with 4 NPCs takes ~20 seconds. The GM also lacks mechanical separation—it knows everything, making genuine NPC knowledge isolation impossible without prompt discipline that models routinely violate.

### The Solution

Port the **Riven-Eidolon sub-agent architecture** to SillyTavern:
- GM calls function tools to spawn NPC responses
- Extension fires parallel API requests via `Promise.all()`
- Each NPC receives only their filtered lorebook context (knowledge hardening)
- Responses aggregate back to GM for narrative weaving
- Result: 4 NPCs in ~3 seconds, with structural knowledge isolation

## Source Architecture: Riven-Eidolon

This extension ports concepts from the Riven-Eidolon RPG framework. Key patterns:

### Sub-Agent Coordination

```
Orchestrator (GM)
├── Judge (mechanical resolution)
├── Archivist (state management)
├── Storyteller (narrative generation)
├── Guardian (QA audit)
└── NPC Agents (spawned per-character)
```

### Knowledge Hardening Pattern

When building NPC prompts, knowledge is filtered structurally:

```python
# NPC receives:
# - confirmed_facts + false_beliefs → "known facts" (NPC believes both)
# - suspicions → stays as suspicions
# - unaware_of → STRIPPED ENTIRELY (prevents pink elephant effect)

all_believed_facts = confirmed_facts + false_beliefs
# unaware_of deliberately never included in prompt
```

This prevents LLMs from "winking at the audience" when acting on false beliefs.

### NPC Dossier Format (Three-Zone)

```
Zone 1 (YAML Frontmatter): id, disposition, tags, access_tiers
Zone 2 (Markdown Body): Voice, personality, background prose
Zone 3 (TOON Footer): Knowledge facts, observations log
```

In SillyTavern, this maps to:
- Zone 1 → Character card metadata + `card.data.extensions.ensemble` overrides
- Zone 2 → Character card description/personality fields
- Zone 3 → Lorebook entries with `characterFilter`

## Model Tiering Strategy

Updated December 2025 based on Gemini 3 Flash benchmarks.

| Tier | Suggested Model | Rationale |
|------|-----------------|-----------|
| `orchestrator` | Claude Opus | Narrative coherence, tool calling, response weaving |
| `major` | Claude Sonnet | Personality depth, alignment safety, recurring NPCs |
| `standard` | Gemini Flash (medium thinking) | Balanced speed/quality for moderate complexity |
| `minor` | Gemini Flash (minimal thinking) | Speed (3x faster), disposable NPCs |
| `utility` | Gemini Flash (minimal thinking) | Judge, Archivist, Guardian sub-agents |

### Dynamic Tier Inference

Rather than manual assignment, tiers are **inferred dynamically** from existing data:

```javascript
function inferTier(npcId, context) {
  const card = getCharacterCard(npcId);
  const knowledgeEntries = getEntriesForCharacter(npcId).length;
  const messageCount = getMessagesFromCharacter(npcId).length;

  // User override via character card extension data
  if (card.data?.extensions?.ensemble?.tier) {
    return card.data.extensions.ensemble.tier;
  }

  // Heuristic scoring
  const complexity = knowledgeEntries * 2 + messageCount + (card.description?.length > 500 ? 3 : 0);

  if (complexity > 10) return 'major';    // Complex backstory, recurring
  if (complexity > 3) return 'standard';  // Moderate presence
  return 'minor';                         // Thugs, shopkeepers, one-offs
}
```

**Signals used:**
- Lorebook entry count (knowledge complexity)
- Character card length (backstory depth)
- Conversation history (recurring presence)
- Explicit override via `card.data.extensions.ensemble.tier`

### Backend Configuration

Users select which **SillyTavern API Connection profile** to use for each tier in extension settings:

```javascript
{
  "tierProfiles": {
    "orchestrator": "Claude API",      // User's configured ST profile
    "major": "Claude API",
    "standard": "OpenRouter",          // Or any other configured backend
    "minor": "OpenRouter",
    "utility": "OpenRouter"
  }
}
```

This leverages ST's existing connection infrastructure—no additional endpoint configuration needed.

### Why Gemini Flash Dominates Utility Roles

- **Outperforms Pro on coding**: 78% SWE-bench vs Pro's 76.2%
- **3x faster** than 2.5 Pro at 1/4 the cost
- **Thinking levels**: minimal/low/medium/high—tune per task
- **30% fewer tokens** on average than 2.5 Pro
- **1M context window**, same as Pro

### Rate Limit Handling

- Track usage per backend profile
- Implement exponential backoff on 429 errors
- Gracefully degrade to sequential generation if limits exhausted
- Consider token bucket algorithm for proactive rate management

## Architecture Layers

```
┌─────────────────────────────────────────────────────────────┐
│                     FUNCTION TOOLS                          │
│  spawn_npcs | resolve_action | query_knowledge | audit      │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                     ORCHESTRATOR                            │
│  Parses GM tool calls → Spawns parallel requests            │
│  Uses Promise.allSettled() for resilience                   │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                   CONTEXT BUILDER                           │
│  Character card + Filtered lorebook + Scene state → Prompt  │
│  Knowledge hardening: unaware_of NEVER enters context       │
│  Scene state filtered per-NPC perspective                   │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                    BACKEND ROUTER                           │
│  Dynamic tier inference → ST API Connection profile lookup  │
│  Rate limit tracking per profile                            │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                   RESPONSE WEAVER                           │
│  Aggregates NPC responses → GM/Storyteller for narrative    │
│  Handles partial failures gracefully                        │
└─────────────────────────────────────────────────────────────┘
```

### Design Principles

1. **Work within ST, not around it**: Use existing UI (thinking tab, timer, error toasts), APIs, and data structures. Complexity lives in the backend, not user-facing.
2. **Lorebook-native**: All data lives in ST lorebooks. No parallel data structures.
3. **Extension ecosystem friendly**: Works with memory extensions (Vector Storage, ChromaDB, etc.) that populate lorebooks dynamically.
4. **Zero-config defaults**: Dynamic tier inference means it "just works" without manual NPC classification.
5. **Graceful degradation**: Partial failures don't collapse entire turns.

## File Structure

```
SillyTavern-Ensemble/
├── manifest.json              # Extension metadata
├── index.js                   # Extension entry, event hooks
├── src/
│   ├── router.js              # Backend selection, tier inference, rate limiting
│   ├── context.js             # Prompt building, lorebook filtering
│   ├── orchestrator.js        # Parallel spawning via Promise.allSettled()
│   ├── weaver.js              # Response aggregation, narrative assembly
│   ├── tools.js               # Function tool definitions
│   └── templates/
│       ├── npc.md             # NPC system prompt template
│       ├── judge.md           # Mechanical resolution template
│       └── guardian.md        # Audit template
├── settings.html              # Tier-to-profile mapping UI
├── styles.css                 # Extension styles
└── README.md                  # User documentation
```

Note: No `registry.js`—NPC data lives entirely in lorebooks and character cards.

## Function Tools

### `spawn_npc_responses`

```javascript
{
  name: "spawn_npc_responses",
  description: "Generate dialogue/reactions from NPCs present in scene",
  parameters: {
    npcs: { type: "array", items: { type: "string" } },  // NPC IDs
    situation: { type: "string" },  // What happened
    format: { type: "string", enum: ["dialogue", "action", "full"] }
  }
}
```

### `resolve_action`

```javascript
{
  name: "resolve_action",
  description: "Resolve mechanical action via Judge sub-agent",
  parameters: {
    actor: { type: "string" },
    action: { type: "string" },
    context: { type: "object" }
  }
}
```

### `query_npc_knowledge`

```javascript
{
  name: "query_npc_knowledge",
  description: "Check what specific NPC knows about a topic",
  parameters: {
    npc_id: { type: "string" },
    topic: { type: "string" }
  }
}
```

### `audit_narrative`

```javascript
{
  name: "audit_narrative",
  description: "Guardian audit of narrative against verdict",
  parameters: {
    verdict: { type: "object" },
    narrative: { type: "string" }
  }
}
```

## Data Structures

### Scene State (Lorebook Entry)

Stored as a constant lorebook entry with key `ensemble_scene_state`:

```javascript
{
  "location": "Ace Chemicals - Catwalk",
  "time": "Day 4 Night",
  "present_npcs": ["harley_quinn", "thug_1", "thug_2"],
  "tension": 7,
  "recent_events": [
    "Player revealed symbiote form",
    "Harley recognized the entity"
  ]
}
```

**Important**: Scene state is filtered per-NPC perspective. Each NPC receives only events they witnessed or would know about. Use `characterFilter` on `recent_events` lorebook entries for sensitive information.

### NPC Data (No Separate Registry)

NPC information lives in existing ST structures:

| Data | Location |
|------|----------|
| Identity, personality, voice | Character card (description, personality fields) |
| Knowledge, beliefs, memories | Lorebook entries with `characterFilter` |
| Tier override (optional) | `card.data.extensions.ensemble.tier` |
| Model override (optional) | `card.data.extensions.ensemble.model` |

This approach:
- Works with existing character cards without modification
- Benefits from memory extensions that populate lorebooks dynamically
- Requires no data migration or parallel structures

## Knowledge Isolation via Lorebook

### Entry Structure (ST Native Fields)

```
Entry: "Riven's true nature"
Keys: riven, symbiote, entity
Character Filter: [jordan, riven]  // Only these characters "know"
Content: "Riven is a cosmic entity bonded to Jordan..."
```

### Filtering Logic

```javascript
function buildNPCContext(npcId, sceneState) {
  const card = getCharacterCard(npcId);
  const allEntries = getLorebookEntries();
  
  // Knowledge hardening
  const entries = allEntries.filter(e => {
    // No filter = common knowledge
    if (!e.characterFilter || e.characterFilter.length === 0) return true;
    // Filter includes this NPC = they know it
    if (e.characterFilter.includes(npcId)) return true;
    // Filter excludes this NPC = they don't know it
    return false;
  });
  
  // false_beliefs tagged entries: include as facts (NPC believes sincerely)
  // unaware_of tagged entries: already filtered out above
  
  return {
    identity: card.description,
    voice: card.personality,
    knowledge: entries.map(e => e.content),
    scene: sceneState
  };
}
```

## Technical Constraints

### Bypass `generateRaw()`

SillyTavern's `generateRaw()` is async but **queues sequentially** due to shared state mutation. For true parallelism, use direct API calls via the selected ST API Connection profile:

```javascript
// DON'T: Uses ST's sequential queue
const responses = await Promise.all(npcs.map(npc => generateRaw(prompt)));

// DO: Direct API calls using ST connection profiles
async function directAPICall(prompt, npcId) {
  const tier = inferTier(npcId);
  const profile = getSTConnectionProfile(settings.tierProfiles[tier]);

  return fetch(profile.endpoint, {
    method: 'POST',
    headers: buildHeaders(profile),
    body: JSON.stringify({ prompt, model: profile.model })
  }).then(r => r.json());
}

// Use Promise.allSettled for resilience
const results = await Promise.allSettled(
  npcs.map(npc => directAPICall(buildPrompt(npc), npc.id))
);

// Handle partial failures
const responses = results.map((result, i) => ({
  npc: npcs[i],
  success: result.status === 'fulfilled',
  response: result.status === 'fulfilled' ? result.value : null,
  error: result.status === 'rejected' ? result.reason : null
}));
```

### Concurrency Lock

Implement a lock to prevent conflicts while parallel generation runs:
- Block new user actions during generation
- Manually manage UI loading states
- Test for race conditions with other extensions

### ST Reverse Proxy Behavior

- Simple URL redirection, not queuing proxy
- Each request handled in separate async context
- **Concurrent passthrough supported**—no mutex or serialization
- Overhead: 5-20ms per request (negligible vs 2-30s generation)

## Development Phases

| Phase | Scope | Deliverable | Status |
|-------|-------|-------------|--------|
| 1 | Core plumbing | Extension scaffold, router, single tool (`spawn_npc_responses`), `Promise.allSettled()` working | **Complete** |
| 2 | Context building | Lorebook filtering, knowledge hardening, dynamic prompts from character cards | **Complete** |
| 3 | Full orchestration | All 4 tools, model tiering, error handling, rate limit tracking | Pending |
| 4 | Integration | Slash command, debug logging, documentation | Pending |

### Phase 1 Implementation Notes

**Completed 2024-12-30**

Files created:
- `index.js` - Entry point, APP_READY hook, settings UI wiring, tool registration
- `src/logger.js` - `generateCorrelationId()`, structured `logger` object
- `src/settings.js` - `getSettings()`, `saveSettings()`, `getAvailableProfiles()`
- `src/router.js` - `inferTier()`, `getProfileForTier()`, `directGenerate()`
- `src/orchestrator.js` - `spawnNPCResponses()`, `findCharacterByName()`, `executeNPCRequest()`
- `src/context.js` - `buildNPCContext()`, `filterEntriesForNPC()`, knowledge hardening
- `src/tools.js` - `registerTools()`, `spawn_npc_responses` tool definition
- `settings.html` - Tier dropdown UI injected into `#extensions_settings2`

Key implementation details:
- Extension folder path: `scripts/extensions/third-party/SillyTavern-Ensemble`
- Settings stored in `extensionSettings.ensemble` namespace
- Tools register/unregister dynamically based on enabled state
- Tier dropdowns populate from `connectionManager.profiles[]`
- Phase 1 uses minimal prompts; Phase 2 adds full lorebook context

**Unit Testing:**
- 258 tests across 6 files: logger (23), router (38), orchestrator (40), settings (35), tools (32), context (90)
- Test infrastructure gitignored (package.json, tests/, node_modules/, coverage/)
- Run with `npm test` (requires `npm install` first)

### Phase 2 Implementation Notes

**Completed 2024-12-30**

Files created:
- `src/context.js` (609 LOC) - Lorebook filtering, knowledge hardening, context builder
- `src/templates/npc.md` - NPC prompt template with Handlebars-style placeholders

Files modified:
- `src/orchestrator.js` - Now uses `buildNPCPromptWithContext()` from context.js

**Key functions in context.js:**
- `getAllLorebookEntries()` - Access ST lorebook via `window.getSortedEntries()`
- `filterEntriesForNPC(entries, npcFilename, npcName)` - Knowledge hardening filter
- `getSceneState(entries)` - Read `ensemble_scene_state` lorebook entry
- `buildNPCContext(characterId, situation)` - Combine character + filtered lorebook + scene
- `buildNPCMessages(context, format)` - Format for API call
- `buildNPCPromptWithContext(characterId, situation, format)` - Convenience wrapper

**Knowledge Hardening Logic:**
```javascript
// No filter = common knowledge (visible to all)
// isExclude=false + names = include ONLY these characters
// isExclude=true + names = exclude these characters (visible to everyone else)
// Tag-only filters = excluded for safety (Phase 3)
```

## Open Questions

### Resolved

1. ~~**Lorebook API**~~: Assume manual filtering required. Abstract into `context.js` to insulate from ST API changes. Works with memory extensions that populate lorebooks dynamically.

2. ~~**Character Card Access**~~: Use ST's existing API. Flag as potentially brittle if undocumented—may need updates when ST changes.

3. ~~**Group Chat Coexistence**~~: **Supplement**, don't replace. Extension is a "power-up" triggered on demand to inject parallel-generated responses.

4. ~~**Scene State Persistence**~~: Constant lorebook entry with key `ensemble_scene_state`. User-editable, fits ST paradigm.

5. ~~**GM Tool Awareness**~~: GM prompt dynamically populated with NPC list from scene state. NPCs present in scene derived from lorebook/chat context.

### Resolved (from ST source analysis)

1. **Lorebook Filtering API** ✓
   - `loadWorldInfo(name)` returns `{ entries: { [uid]: entryObject } }`
   - `getSortedEntries()` returns all entries sorted by strategy
   - Entry structure includes `characterFilter: { names: string[], tags: string[], isExclude: boolean }`
   - Filter logic: if `isExclude=false`, only characters in `names[]` see entry
   - `WORLDINFO_SCAN_DONE` event provides activated entries (mutable)

2. **Character Card Extension Data** ✓
   - Path: `characters[id].data.extensions.ensemble`
   - Write: `await writeExtensionField(characterId, 'ensemble', { tier: 'major' })`
   - Persists to PNG metadata via `/api/characters/merge-attributes`

3. **Connection Profile Access** ✓
   - Profiles in: `extension_settings.connectionManager.profiles[]`
   - Find by name: `findProfileByName(name)` returns profile object
   - Profile structure: `{ id, name, mode, api, model, preset, proxy, 'api-url', 'secret-id', ... }`
   - Apply profile: `await applyConnectionProfile(profile)`
   - Get credentials: `await findSecret(key, profile['secret-id'])`

4. **Generation Queue** ✓
   - **No explicit queue in `generateRaw()`** — sequential behavior comes from group chat's `for...await` loop
   - Direct API endpoint: `/api/backends/chat-completions/generate`
   - Each fetch is independent — ST reverse proxy supports concurrent requests
   - Shared state (`abortController`, `is_group_generating`, `this_chid`) prevents overlapping group calls
   - **Solution**: Direct fetch calls bypass the sequential loop entirely

## ST Extension Hooks (Relevant)

| Event | Use Case |
|-------|----------|
| `GROUP_WRAPPER_STARTED` | Before per-character generation loop |
| `GROUP_WRAPPER_FINISHED` | After all characters complete |
| `GENERATION_AFTER_COMMANDS` | After slash commands, before API call |
| `WORLDINFO_SCAN_DONE` | Inspect activated lorebook entries |
| `registerFunctionTool()` | Register function tools for GM |

## Useful Slash Commands

- `/sendas name=NPCName (text)` — Add message as character
- `/inject id=myID position=chat depth=N (text)` — Inject at depth
- `/sys (text)` — Narrator/system message
- `/trigger [name]` — Force specific character reply

## Claude Haiku 4.5 Note

For computer-use scenarios (if needed later), Claude Haiku 4.5 has unmatched 50.7% on computer-use benchmarks. However, for NPC dialogue generation, Gemini 3 Flash is faster and cheaper with comparable quality for simple interactions.

## Key Files to Read

When starting work:
1. This file (CLAUDE.md)
2. `ST-API-REFERENCE.md` for SillyTavern API documentation
3. `DEVELOPMENT_PLAN.md` for detailed implementation steps

Implementation files (Phase 1 complete):
- `index.js` — Entry point, settings UI, tool registration
- `src/router.js` — Tier inference, profile lookup, `directGenerate()`
- `src/orchestrator.js` — Parallel spawning, `spawnNPCResponses()`
- `src/tools.js` — Function tool definitions
- `src/settings.js` — Settings management
- `src/context.js` — *(Phase 2)* Lorebook filtering, prompt building

### SillyTavern Source Reference

Local copy at `reference_materials/SillyTavern/` for API research:
- `public/scripts/world-info.js` — Lorebook/World Info APIs
- `public/scripts/characters.js` — Character card handling
- `public/scripts/extensions.js` — Extension system, getContext()
- `public/scripts/openai.js` — Chat completion generation
- `public/scripts/connection-profiles/` — Profile management

## UX Considerations

### Triggering Parallel Generation

- Slash command: `/ensemble` or `/spawn` to trigger parallel NPC responses
- Optional: Button in group chat UI for one-click activation

### Leverage Existing ST UI

| ST Feature | Ensemble Usage |
|------------|----------------|
| **Thinking tab** | Stream progress updates ("Spawning 4 NPCs...", "harley_quinn complete") |
| **Timer (left of output)** | Already tracks generation time—works automatically if we integrate properly |
| **Error toasts** | Surface actionable errors through ST's existing error handling |

On halt/failure: stop the timer, show error via ST's error UI.

### Actionable Error Messages

```javascript
// Bad: Generic error
throw new Error("NPC generation failed");

// Good: Actionable context
throw new Error(`[Ensemble] Failed to generate ${npcId} (tier: ${tier}): ${profile.name} returned 429. Rate limit exceeded—try again in 5 minutes or switch to a different backend profile.`);
```

Include: which NPC failed, which backend profile, actual API error, suggested fix.

## Testing Strategy

| Level | Scope | Tools |
|-------|-------|-------|
| Unit | Context Builder filtering logic, tier inference | Jest/Vitest |
| Integration | API pipeline with mocks | MSW (Mock Service Worker) |
| End-to-end | Full flow with real backends | Manual + screenshots |

### Key Test Cases

1. Knowledge hardening: Verify `unaware_of` entries never appear in NPC context
2. Tier inference: Validate heuristic produces expected tiers for sample NPCs
3. Partial failure: Confirm 3/4 successes don't crash, failures reported gracefully
4. Rate limit: Verify backoff and degradation behavior

## Logging

Implement structured logging with **correlation IDs** to trace requests across parallel sub-agent calls:

```javascript
const correlationId = generateId();
logger.info({ correlationId, event: 'spawn_start', npcs: ['harley', 'thug_1'] });

// Each parallel request logs with same correlationId
logger.info({ correlationId, npc: 'harley', event: 'request_sent', tier: 'major' });
logger.info({ correlationId, npc: 'harley', event: 'response_received', latency: 2340 });
```

Essential for debugging parallel execution issues.

## Development Workflow

### Sub-Agent Preference

**Sub-agents are the preferred method for large, complex tasks including development.** The orchestrating agent should:

1. **Launch sub-agents** to carry out implementation work
2. **Act as code reviewer** rather than manually writing code
3. **Coordinate multiple parallel sub-agents** when tasks are independent
4. **Synthesize findings** from exploration sub-agents into documentation

This approach:
- Reduces context window pressure on the main agent
- Enables parallel exploration/development
- Maintains consistent code review quality
- Scales better for complex multi-file changes

### Commit Style

```
feat: Add spawn_npc_responses function tool
fix: Handle rate limit 429 with exponential backoff
refactor: Extract lorebook filtering to context.js
docs: Update README with setup instructions
```
