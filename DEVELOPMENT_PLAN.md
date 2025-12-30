# SillyTavern-Ensemble Development Plan

Detailed implementation roadmap organized into 4 phases with specific deliverables.

---

## Phase 1: Core Plumbing

**Goal:** Extension scaffold with working parallel generation via a single function tool.

### Step 1.1: Extension Scaffold

Create basic extension structure that loads in SillyTavern.

**Files to create:**
```
SillyTavern-Ensemble/
├── manifest.json
├── index.js
├── styles.css (minimal)
└── src/
    └── logger.js
```

**manifest.json:**
```json
{
  "display_name": "Ensemble",
  "author": "SillyTavern-Ensemble",
  "js": "index.js",
  "css": "styles.css",
  "loading_order": 100,
  "auto_update": false
}
```

**index.js tasks:**
- Import from `src/` modules
- Hook into `APP_READY` event
- Initialize extension settings with defaults
- Log successful load with `[Ensemble]` prefix

**logger.js tasks:**
- Structured logging with correlation IDs
- Log levels: debug, info, warn, error
- Output format: `[Ensemble] [correlationId] message`

**Verification:**
- [ ] Extension appears in ST's Manage Extensions menu
- [ ] Console shows `[Ensemble] Loaded successfully` on startup

---

### Step 1.2: Settings Infrastructure

Create settings storage and basic UI.

**Files to create/modify:**
```
├── settings.html
└── src/
    └── settings.js
```

**settings.js tasks:**
- Define default settings structure:
  ```javascript
  {
    enabled: true,
    tierProfiles: {
      orchestrator: '',  // Empty = use current profile
      major: '',
      standard: '',
      minor: '',
      utility: ''
    },
    debug: false
  }
  ```
- Load/save to `extensionSettings.ensemble`
- Export `getSettings()` and `saveSettings()`

**settings.html tasks:**
- Minimal UI: Enable/disable toggle
- Tier-to-profile dropdowns (populate from `extension_settings.connectionManager.profiles`)
- Debug logging toggle
- Save button calls `saveSettingsDebounced()`

**Verification:**
- [ ] Settings persist across page reload
- [ ] Profile dropdowns show available ST connection profiles

---

### Step 1.3: Backend Router (Minimal)

Implement tier inference and profile lookup.

**Files to create:**
```
└── src/
    └── router.js
```

**router.js tasks:**
- `inferTier(characterId)` - Returns tier based on heuristics:
  - Check `card.data.extensions.ensemble.tier` override first
  - Calculate complexity score from lorebook entries + card length
  - Return 'major', 'standard', or 'minor'
- `getProfileForTier(tier)` - Returns ST connection profile object
  - Lookup from `extension_settings.connectionManager.profiles`
  - Fall back to current active profile if not configured
- `buildRequestHeaders(profile)` - Build fetch headers from profile

**Dependencies:**
- Access to `getContext().characters`
- Access to `extension_settings.connectionManager`

**Verification:**
- [ ] `inferTier()` returns expected tier for test character
- [ ] `getProfileForTier()` returns valid profile object

---

### Step 1.4: Direct API Call Implementation

Bypass ST's sequential queue with direct fetch.

**Files to modify:**
```
└── src/
    └── router.js (add directGenerate function)
```

**New functions:**
- `directGenerate(messages, profile, options)`:
  ```javascript
  async function directGenerate(messages, profile, options = {}) {
    const generate_data = {
      type: 'quiet',
      messages: messages,
      model: profile.model || options.model,
      temperature: options.temperature || 0.8,
      max_tokens: options.max_tokens || 500,
      stream: false,
      chat_completion_source: profile.api,
    };

    const response = await fetch('/api/backends/chat-completions/generate', {
      method: 'POST',
      headers: getRequestHeaders(),  // ST's built-in function
      body: JSON.stringify(generate_data),
    });

    if (!response.ok) {
      throw new Error(`[Ensemble] API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }
  ```

**Verification:**
- [ ] Direct call generates text without using ST's group chat loop
- [ ] Profile settings (model, API type) are respected
- [ ] Errors surface with actionable messages

---

### Step 1.5: spawn_npc_responses Function Tool

Register the primary function tool for GM to call.

**Files to create:**
```
└── src/
    └── tools.js
```

**tools.js tasks:**
- Register `spawn_npc_responses` tool via `registerFunctionTool()`:
  ```javascript
  {
    name: "spawn_npc_responses",
    displayName: "Spawn NPC Responses",
    description: "Generate dialogue/reactions from multiple NPCs in parallel. Use when you need responses from several NPCs at once.",
    parameters: {
      $schema: "http://json-schema.org/draft-04/schema#",
      type: "object",
      properties: {
        npcs: {
          type: "array",
          items: { type: "string" },
          description: "Array of NPC character names to generate responses from"
        },
        situation: {
          type: "string",
          description: "What happened that NPCs are reacting to"
        },
        format: {
          type: "string",
          enum: ["dialogue", "action", "full"],
          description: "Response format: dialogue only, actions only, or both"
        }
      },
      required: ["npcs", "situation"]
    },
    action: async (params) => {
      // Delegate to orchestrator
      return await spawnNPCResponses(params);
    },
    formatMessage: (params) => {
      return `Generating responses from ${params.npcs.length} NPCs...`;
    }
  }
  ```

**Verification:**
- [ ] Tool appears in function calling UI for supported providers
- [ ] GM can invoke tool with NPC list
- [ ] Action receives parameters correctly

---

### Step 1.6: Orchestrator (Parallel Spawning)

Implement parallel NPC generation.

**Files to create:**
```
└── src/
    └── orchestrator.js
```

**orchestrator.js tasks:**
- `spawnNPCResponses({ npcs, situation, format })`:
  - Generate correlation ID for logging
  - Map NPC names to character IDs
  - For each NPC:
    - Infer tier
    - Get profile for tier
    - Build minimal prompt (Phase 2 adds full context)
  - Execute `Promise.allSettled()` with all requests
  - Aggregate results with success/failure status
  - Return formatted response for GM

**Minimal prompt for Phase 1:**
```javascript
function buildMinimalPrompt(npc, situation) {
  return [
    { role: 'system', content: `You are ${npc.name}. ${npc.personality}` },
    { role: 'user', content: `React to: ${situation}` }
  ];
}
```

**Verification:**
- [ ] Multiple NPC requests fire in parallel (check network tab)
- [ ] All responses return within ~same timeframe
- [ ] Partial failures don't crash entire operation
- [ ] Results aggregated and returned to GM

---

### Phase 1 Checkpoint

**Complete when:**
- Extension loads and registers function tool
- GM can invoke `spawn_npc_responses` with NPC list
- Parallel API calls execute (visible in Network tab)
- Results aggregate and return to chat
- Settings UI allows tier-to-profile mapping

**Test scenario:**
1. Configure 2 different connection profiles in ST
2. Assign one to 'major', one to 'minor' tier
3. Create 4 test NPC characters
4. GM invokes `spawn_npc_responses` with all 4
5. Verify parallel execution in Network tab
6. Verify different endpoints used per tier

---

## Phase 2: Context Building

**Goal:** Full lorebook filtering and knowledge hardening.

### Step 2.1: Lorebook Access Layer

Abstract lorebook access for filtering.

**Files to create:**
```
└── src/
    └── context.js
```

**context.js tasks:**
- `getAllLorebookEntries()`:
  - Use `getSortedEntries()` or build from available sources
  - Normalize entry structure for filtering
- `getCharacterFilename(characterId)`:
  - Map character ID to filename for filter matching
  - Use ST's `getCharaFilename()` if available

**Verification:**
- [ ] Can retrieve all lorebook entries
- [ ] Entry characterFilter data accessible

---

### Step 2.2: Knowledge Hardening Filter

Implement per-NPC knowledge filtering.

**Files to modify:**
```
└── src/
    └── context.js (add filtering)
```

**New functions:**
- `filterEntriesForNPC(entries, npcFilename)`:
  ```javascript
  function filterEntriesForNPC(entries, npcFilename) {
    return entries.filter(entry => {
      // No filter = common knowledge
      if (!entry.characterFilter?.names?.length &&
          !entry.characterFilter?.tags?.length) {
        return true;
      }

      // Character name filter
      if (entry.characterFilter?.names?.length > 0) {
        const nameIncluded = entry.characterFilter.names.includes(npcFilename);
        // isExclude: true = exclude these names, false = include only these names
        if (entry.characterFilter.isExclude) {
          return !nameIncluded;  // Exclude if name is in list
        } else {
          return nameIncluded;   // Include only if name is in list
        }
      }

      return true;
    });
  }
  ```

**Verification:**
- [ ] NPC only sees entries where their name is in characterFilter
- [ ] NPC sees all entries with no characterFilter (common knowledge)
- [ ] `isExclude=true` entries correctly excluded

---

### Step 2.3: Scene State Reader

Read scene state from lorebook.

**Files to modify:**
```
└── src/
    └── context.js (add scene state)
```

**New functions:**
- `getSceneState()`:
  - Find lorebook entry with key `ensemble_scene_state`
  - Parse JSON content
  - Return default if not found:
    ```javascript
    {
      location: "Unknown",
      time: "Present",
      present_npcs: [],
      tension: 5,
      recent_events: []
    }
    ```

**Verification:**
- [ ] Scene state loads from lorebook entry
- [ ] Missing scene state uses sensible defaults

---

### Step 2.4: Full NPC Prompt Builder

Build complete prompts with character + knowledge + scene.

**Files to modify:**
```
└── src/
    └── context.js (add prompt builder)
```

**New functions:**
- `buildNPCContext(characterId, situation)`:
  - Get character card data
  - Get NPC filename
  - Get all lorebook entries
  - Filter entries for this NPC (knowledge hardening)
  - Get scene state
  - Assemble prompt:
    ```javascript
    {
      identity: card.description + card.personality,
      knowledge: filteredEntries.map(e => e.content).join('\n'),
      scene: sceneState,
      situation: situation
    }
    ```

- `buildNPCMessages(context, format)`:
  - Build messages array for API call
  - System prompt: identity + knowledge
  - User prompt: scene context + situation

**Files to create:**
```
└── src/
    └── templates/
        └── npc.md
```

**npc.md template:**
```markdown
# {{npc_name}}

## Identity
{{identity}}

## Your Knowledge
{{knowledge}}

## Current Scene
Location: {{scene.location}}
Time: {{scene.time}}
Present: {{scene.present_npcs}}
Recent events: {{scene.recent_events}}

---

Respond to the following situation in character.
Format: {{format}}

{{situation}}
```

**Verification:**
- [ ] Prompt includes character description/personality
- [ ] Only filtered lorebook entries appear in knowledge section
- [ ] Scene state included in context
- [ ] Template renders correctly with Handlebars

---

### Step 2.5: Update Orchestrator with Full Context

Replace minimal prompts with full context.

**Files to modify:**
```
└── src/
    └── orchestrator.js
```

**Changes:**
- Replace `buildMinimalPrompt()` with `buildNPCMessages()`
- Add context building step before parallel requests:
  ```javascript
  async function spawnNPCResponses({ npcs, situation, format }) {
    const correlationId = generateCorrelationId();
    logger.info({ correlationId, event: 'spawn_start', npcs });

    const requests = await Promise.all(
      npcs.map(async (npcName) => {
        const characterId = findCharacterByName(npcName);
        const tier = inferTier(characterId);
        const profile = getProfileForTier(tier);
        const context = await buildNPCContext(characterId, situation);
        const messages = buildNPCMessages(context, format);

        return { npcName, characterId, tier, profile, messages };
      })
    );

    const results = await Promise.allSettled(
      requests.map(req =>
        directGenerate(req.messages, req.profile)
          .then(response => ({ ...req, response }))
      )
    );

    return aggregateResults(results, correlationId);
  }
  ```

**Verification:**
- [ ] NPC responses reflect their character personality
- [ ] Knowledge isolation working (NPC doesn't reference info they shouldn't know)
- [ ] Scene context influences responses appropriately

---

### Phase 2 Checkpoint

**Complete when:**
- Lorebook entries filter correctly per-NPC
- Knowledge hardening prevents "audience winking"
- Scene state loads from lorebook entry
- Full character context in prompts

**Test scenario (knowledge isolation):**
1. Create lorebook entry "Secret Plot" with characterFilter including only NPC_A
2. Create lorebook entry "Common Knowledge" with no filter
3. Spawn responses from NPC_A and NPC_B about "the plot"
4. Verify NPC_A references Secret Plot details
5. Verify NPC_B only references Common Knowledge

---

## Phase 3: Full Orchestration

**Goal:** All 4 function tools, error handling, rate limiting.

### Step 3.1: resolve_action Tool

Add mechanical resolution via Judge sub-agent.

**Files to modify:**
```
└── src/
    └── tools.js (add tool)
```

**New tool registration:**
```javascript
{
  name: "resolve_action",
  displayName: "Resolve Action",
  description: "Mechanically resolve an action via Judge sub-agent. Returns verdict on success/failure with narrative impact.",
  parameters: {
    type: "object",
    properties: {
      actor: { type: "string", description: "Who is performing the action" },
      action: { type: "string", description: "What they are attempting" },
      context: { type: "object", description: "Relevant mechanical context" }
    },
    required: ["actor", "action"]
  },
  action: async (params) => resolveAction(params)
}
```

**Files to create:**
```
└── src/
    └── templates/
        └── judge.md
```

**judge.md template:**
```markdown
You are a neutral mechanical judge for an RPG system.

Evaluate this action and determine the outcome.

Actor: {{actor}}
Action: {{action}}
Context: {{context}}

Respond with a JSON object:
{
  "success": boolean,
  "degree": "critical_success" | "success" | "partial" | "failure" | "critical_failure",
  "consequences": ["string array of narrative consequences"],
  "mechanical_effects": {}
}
```

**Verification:**
- [ ] Tool returns structured verdict
- [ ] Uses 'utility' tier profile
- [ ] Verdict includes actionable consequences

---

### Step 3.2: query_npc_knowledge Tool

Check what specific NPC knows.

**Files to modify:**
```
└── src/
    └── tools.js (add tool)
```

**New tool:**
```javascript
{
  name: "query_npc_knowledge",
  displayName: "Query NPC Knowledge",
  description: "Check what a specific NPC knows about a topic. Returns their filtered knowledge.",
  parameters: {
    type: "object",
    properties: {
      npc_id: { type: "string", description: "NPC character name" },
      topic: { type: "string", description: "Topic to query about" }
    },
    required: ["npc_id", "topic"]
  },
  action: async (params) => queryNPCKnowledge(params)
}
```

**Implementation:**
- Get filtered lorebook entries for NPC
- Search entries for topic keywords
- Return matching entries (what NPC "knows")
- No LLM call needed - pure data lookup

**Verification:**
- [ ] Returns only entries NPC should see
- [ ] Topic filtering works with keyword matching
- [ ] Fast (no API call overhead)

---

### Step 3.3: audit_narrative Tool

Guardian audit of narrative against verdict.

**Files to modify:**
```
└── src/
    └── tools.js (add tool)
```

**Files to create:**
```
└── src/
    └── templates/
        └── guardian.md
```

**guardian.md template:**
```markdown
You are a QA auditor verifying narrative consistency.

Compare this narrative against the mechanical verdict.

Verdict:
{{verdict}}

Narrative:
{{narrative}}

Check for:
1. Contradictions between verdict and narrative
2. Knowledge violations (characters knowing things they shouldn't)
3. Mechanical inaccuracies

Respond with:
{
  "approved": boolean,
  "issues": ["list of problems if any"],
  "suggestions": ["optional improvements"]
}
```

**Verification:**
- [ ] Catches contradictions between verdict and narrative
- [ ] Uses 'utility' tier profile
- [ ] Returns actionable feedback

---

### Step 3.4: Rate Limit Tracking

Implement per-profile rate limit awareness.

**Files to create:**
```
└── src/
    └── ratelimit.js
```

**ratelimit.js tasks:**
- Track request counts per profile over time window
- Parse rate limit headers from responses:
  - `x-ratelimit-remaining`
  - `x-ratelimit-reset`
  - `retry-after`
- Implement `canMakeRequest(profile)` check
- Implement `recordRequest(profile, response)` to update state

**Verification:**
- [ ] Rate limit state persists across requests
- [ ] Headers parsed correctly
- [ ] `canMakeRequest` returns false when limit approaching

---

### Step 3.5: Exponential Backoff

Add retry logic with backoff for 429 errors.

**Files to modify:**
```
└── src/
    └── router.js (wrap directGenerate)
```

**New function:**
```javascript
async function directGenerateWithRetry(messages, profile, options = {}) {
  const maxRetries = 3;
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (!canMakeRequest(profile)) {
        // Proactively wait if we know we're rate limited
        const waitTime = getWaitTime(profile);
        await sleep(waitTime);
      }

      const response = await directGenerate(messages, profile, options);
      recordRequest(profile, response);
      return response;

    } catch (error) {
      lastError = error;

      if (error.status === 429) {
        const backoffMs = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
        logger.warn({
          event: 'rate_limit_backoff',
          profile: profile.name,
          attempt,
          backoffMs
        });
        await sleep(backoffMs);
      } else {
        throw error;  // Non-retryable error
      }
    }
  }

  throw lastError;
}
```

**Verification:**
- [ ] 429 errors trigger retry with increasing delay
- [ ] Non-429 errors surface immediately
- [ ] Max retries respected

---

### Step 3.6: Graceful Degradation

Fall back to sequential when parallelism fails.

**Files to modify:**
```
└── src/
    └── orchestrator.js
```

**Changes:**
- If all parallel requests fail, attempt sequential via ST's native queue
- Log degradation event
- Notify user via toast

```javascript
async function spawnWithFallback(requests) {
  const results = await Promise.allSettled(
    requests.map(req => directGenerateWithRetry(req.messages, req.profile))
  );

  const allFailed = results.every(r => r.status === 'rejected');

  if (allFailed) {
    logger.warn({ event: 'degrading_to_sequential' });
    toastr.warning('[Ensemble] Parallel generation failed, falling back to sequential');

    // Fall back to ST's native generation
    return await sequentialFallback(requests);
  }

  return results;
}
```

**Verification:**
- [ ] Total parallel failure triggers fallback
- [ ] User notified of degradation
- [ ] Sequential fallback completes successfully

---

### Phase 3 Checkpoint

**Complete when:**
- All 4 function tools registered and working
- Rate limits tracked per profile
- 429 errors handled with backoff
- Graceful degradation to sequential

**Test scenarios:**
1. Invoke each tool individually, verify correct behavior
2. Simulate 429 response, verify backoff and retry
3. Block all parallel requests, verify sequential fallback
4. Check rate limit state updates correctly

---

## Phase 4: Integration

**Goal:** Polish, documentation, testing.

### Step 4.1: Settings UI Enhancement

Complete the tier-to-profile mapping UI.

**Files to modify:**
```
├── settings.html
└── styles.css
```

**UI requirements:**
- Dropdown per tier showing available ST profiles
- Visual indicator of which tiers are configured
- "Test Connection" button per tier
- Debug log toggle
- Import/export settings

**Verification:**
- [ ] All tiers configurable via UI
- [ ] Settings persist correctly
- [ ] Test connection provides feedback

---

### Step 4.2: Slash Command

Add `/ensemble` command for triggering parallel generation.

**Files to modify:**
```
└── index.js (add slash command)
```

**Slash command:**
```javascript
SlashCommandParser.addCommandObject(SlashCommand.fromProps({
  name: 'ensemble',
  callback: async (namedArgs, unnamedArgs) => {
    // Parse NPC list from args
    const npcs = unnamedArgs.split(',').map(s => s.trim());
    const situation = namedArgs.situation || 'React naturally';
    const format = namedArgs.format || 'full';

    const result = await spawnNPCResponses({ npcs, situation, format });
    return formatResultForChat(result);
  },
  namedArgumentList: [
    { name: 'situation', description: 'What NPCs react to' },
    { name: 'format', description: 'dialogue, action, or full' }
  ],
  helpString: '/ensemble NPC1, NPC2, NPC3 situation="Something happened"'
}));
```

**Verification:**
- [ ] `/ensemble` appears in slash command list
- [ ] Command triggers parallel generation
- [ ] Results display in chat

---

### Step 4.3: UI Integration

Hook into ST's existing UI elements.

**Files to modify:**
```
└── index.js
```

**Integrations:**
- **Thinking tab:** Stream progress updates during generation
- **Timer:** Ensure ST's built-in timer tracks Ensemble operations
- **Error toasts:** Surface errors through ST's `toastr` system

```javascript
function showProgress(message) {
  // Hook into ST's thinking/streaming display if available
  // Otherwise fall back to console + toast
  const thinkingElement = document.querySelector('#thinking-output');
  if (thinkingElement) {
    thinkingElement.textContent += `\n${message}`;
  }
  console.log(`[Ensemble] ${message}`);
}

function showError(error) {
  toastr.error(error.message, 'Ensemble Error');
  console.error('[Ensemble]', error);
}
```

**Verification:**
- [ ] Progress visible in thinking tab (if supported)
- [ ] Errors display as toasts
- [ ] Timer shows during generation

---

### Step 4.4: Debug Logging Panel

Add debug panel for troubleshooting.

**Files to create:**
```
└── src/
    └── debug.js
```

**debug.js tasks:**
- Capture all logged events with correlation IDs
- Display in collapsible panel
- Filter by event type, NPC, tier
- Export logs as JSON

**Verification:**
- [ ] All correlation IDs traceable
- [ ] Filter by NPC works
- [ ] Export produces valid JSON

---

### Step 4.5: Documentation

Write user documentation.

**Files to create:**
```
└── README.md
```

**README.md sections:**
1. What is Ensemble
2. Installation
3. Configuration
   - Tier-to-profile mapping
   - Scene state setup
   - Knowledge isolation via lorebook
4. Usage
   - Slash command
   - Function tools for GM
5. Troubleshooting
   - Common errors
   - Debug logging
6. FAQ

**Verification:**
- [ ] Installation steps accurate
- [ ] Configuration explained clearly
- [ ] Troubleshooting covers common issues

---

### Step 4.6: Unit Tests

Add test coverage for critical paths.

**Files to create:**
```
└── tests/
    ├── context.test.js
    ├── router.test.js
    └── orchestrator.test.js
```

**Test coverage:**
- `context.test.js`:
  - Knowledge filtering with various characterFilter configs
  - Handling of isExclude flag
  - Missing/malformed lorebook entries
- `router.test.js`:
  - Tier inference with different complexity scores
  - Profile lookup fallback behavior
- `orchestrator.test.js`:
  - Parallel execution completes
  - Partial failure handling
  - Aggregation logic

**Verification:**
- [ ] Tests pass with `npm test`
- [ ] Critical paths covered
- [ ] Edge cases handled

---

### Phase 4 Checkpoint

**Complete when:**
- Settings UI fully functional
- `/ensemble` slash command working
- Progress/errors use ST's native UI
- README provides complete documentation
- Unit tests pass

---

## Development Notes

### Sub-Agent Workflow

Per CLAUDE.md, use sub-agents for implementation:

1. **Per-phase sub-agents:** Launch implementation sub-agent for each phase
2. **Code review:** Orchestrating agent reviews sub-agent output
3. **Parallel work:** Context building and rate limiting can develop in parallel

### Commit Discipline

```
feat: Add spawn_npc_responses function tool
fix: Handle rate limit 429 with exponential backoff
refactor: Extract lorebook filtering to context.js
docs: Update README with setup instructions
test: Add unit tests for tier inference
```

### Testing Checkpoints

Each phase has verification criteria. Don't proceed to next phase until current phase passes all checks.

### Critical Risks

| Risk | Mitigation |
|------|------------|
| ST API changes | Abstract all ST access behind facade functions |
| Profile format varies | Defensive parsing with fallbacks |
| Race conditions with other extensions | Implement concurrency lock during generation |
| Rate limit exhaustion | Backoff + degradation + user notification |

---

## Summary

| Phase | Effort | Dependencies |
|-------|--------|--------------|
| 1: Core Plumbing | High | None |
| 2: Context Building | Medium | Phase 1 |
| 3: Full Orchestration | Medium | Phase 2 |
| 4: Integration | Medium | Phase 3 |

Estimated file count: ~15 files
Estimated LOC: ~1500-2000

Ready to begin Phase 1.
