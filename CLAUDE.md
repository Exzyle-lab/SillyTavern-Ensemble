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
- Zone 1 → Character card metadata + NPC Registry entry
- Zone 2 → Character card description/personality fields
- Zone 3 → Lorebook entries with `characterFilter`

## Model Tiering Strategy

Updated December 2025 based on Gemini 3 Flash benchmarks.

| Role | Model | Backend | Rationale |
|------|-------|---------|-----------|
| GM/Narrator | Claude Opus | Claude Code CLI | Narrative coherence, orchestration, tool calling |
| Storyteller | Claude Sonnet | Claude Code CLI | Prose quality for scene weaving |
| Major NPC | Claude Sonnet | Claude Code CLI | Personality depth, alignment safety |
| Minor NPC | Gemini 3 Flash | Gemini CLI | Speed (3x faster), 78% SWE-bench, disposable |
| Judge | Gemini 3 Flash (minimal thinking) | Gemini CLI | Fast stateless logic |
| Archivist | Gemini 3 Flash (minimal thinking) | Gemini CLI | Fast structured output |
| Guardian | Gemini 3 Flash (low thinking) | Gemini CLI | Quick validation |

### Why Gemini 3 Flash Dominates Utility Roles

- **Outperforms Pro on coding**: 78% SWE-bench vs Pro's 76.2%
- **3x faster** than 2.5 Pro at 1/4 the cost
- **Thinking levels**: minimal/low/medium/high—tune per task
- **30% fewer tokens** on average than 2.5 Pro
- **1M context window**, same as Pro

### Rate Limit Considerations (Google AI Pro Subscription)

- ~100 queries/day for Pro-tier models in Gemini app
- Gemini CLI: "Higher" limits with 5-hour refresh cycle
- Extension should track usage and gracefully degrade to sequential if limits hit

## Architecture Layers

```
┌─────────────────────────────────────────────────────────────┐
│                     FUNCTION TOOLS                          │
│  spawn_npcs | resolve_action | query_knowledge | audit      │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                     ORCHESTRATOR                            │
│  Parses GM tool calls → Spawns parallel requests → Aggregates│
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                   CONTEXT BUILDER                           │
│  Character card + Filtered lorebook + Scene state → Prompt  │
│  Knowledge hardening: unaware_of NEVER enters context       │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                    BACKEND ROUTER                           │
│  Model tier → Backend selection → Rate limit tracking       │
│  Claude (Opus/Sonnet) ←→ EasyCLI ←→ Gemini (Flash/Pro)     │
└─────────────────────────────────────────────────────────────┘
```

## File Structure

```
SillyTavern-Ensemble/
├── manifest.json              # Extension metadata
├── index.js                   # Extension entry, event hooks
├── src/
│   ├── router.js              # Backend selection, rate limiting
│   ├── context.js             # Prompt building, lorebook filtering
│   ├── orchestrator.js        # Parallel spawning, aggregation
│   ├── tools.js               # Function tool definitions
│   ├── registry.js            # NPC registry management
│   └── templates/
│       ├── npc.md             # NPC system prompt template
│       ├── judge.md           # Mechanical resolution template
│       └── guardian.md        # Audit template
├── settings.html              # Backend config UI
├── styles.css                 # Extension styles
└── README.md                  # User documentation
```

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

### NPC Registry

Stored in extension settings or as lorebook constant entry:

```javascript
{
  "harley_quinn": {
    "character_id": "abc123",     // ST character card reference
    "tier": "major",              // major | minor | boss
    "model_override": null,       // Override default model if needed
    "knowledge_tags": ["gotham", "joker", "arkham"],
    "voice_summary": "Playful Brooklyn accent, psychiatric terminology as dark humor"
  },
  "thug_1": {
    "character_id": "def456",
    "tier": "minor",
    "model_override": null,
    "knowledge_tags": ["street"],
    "voice_summary": "Generic frightened grunt"
  }
}
```

### Scene State

Injected to all participants:

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

SillyTavern's `generateRaw()` is async but **queues sequentially** due to shared state mutation. For true parallelism:

```javascript
// DON'T: Uses ST's sequential queue
const responses = await Promise.all(npcs.map(npc => generateRaw(prompt)));

// DO: Direct API calls
async function directAPICall(prompt, model, backend) {
  const endpoint = backend === 'claude' 
    ? '/api/backends/chat-completions/generate'
    : settings.geminiEndpoint;
    
  return fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, model })
  }).then(r => r.json());
}

const responses = await Promise.all(
  npcs.map(npc => directAPICall(buildPrompt(npc), getModel(npc), getBackend(npc)))
);
```

### EasyCLI Integration

User has EasyCLI (GUI fork of CLIProxyAPI) exposing both:
- Claude Code CLI as OpenAI-compatible endpoint
- Gemini CLI as OpenAI-compatible endpoint

Extension should allow configuring both endpoints in settings.

### ST Reverse Proxy Behavior

- Simple URL redirection, not queuing proxy
- Each request handled in separate async context
- **Concurrent passthrough supported**—no mutex or serialization
- Overhead: 5-20ms per request (negligible vs 2-30s generation)

## Development Phases

| Phase | Scope | Deliverable |
|-------|-------|-------------|
| 1 | Core plumbing | Extension scaffold, router, single tool (`spawn_npc_responses`), `Promise.all()` working |
| 2 | Context building | Lorebook filtering, knowledge hardening, dynamic prompts from character cards |
| 3 | Full orchestration | All 4 tools, model tiering, error handling, rate limit tracking |
| 4 | Integration | Settings UI, debug logging, documentation |

## Open Questions

1. **Lorebook API**: Is there `getFilteredWorldInfo(characterId)` or must we iterate entries manually checking `characterFilter`?

2. **Character Card Access**: Structure of `SillyTavern.getContext().characters[id]`?

3. **Group Chat Coexistence**: Supplement ST groups or replace entirely?

4. **Scene State Persistence**: Lorebook constant entry? Data Bank? Extension storage?

5. **GM Tool Awareness**: How does GM know available NPCs? Read registry via tool? User manages list?

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
2. `manifest.json` for extension metadata
3. `src/router.js` for backend selection logic
4. `src/context.js` for prompt building
5. `src/tools.js` for function tool implementations

## Commit Style

```
feat: Add spawn_npc_responses function tool
fix: Handle rate limit 429 with exponential backoff
refactor: Extract lorebook filtering to context.js
docs: Update README with setup instructions
```
