# SillyTavern-Ensemble

Enables GM/Narrator characters to orchestrate **parallel NPC generation** via function calling, with **structural knowledge isolation** via lorebook filtering.

## The Problem

SillyTavern's group chat generates character responses **sequentially**. A scene with 4 NPCs takes ~20 seconds. The GM also lacks mechanical separation—it knows everything, making genuine NPC knowledge isolation impossible without prompt discipline that models routinely violate.

## The Solution

- GM calls function tools to spawn NPC responses
- Extension fires parallel API requests via `Promise.allSettled()`
- Each NPC receives only their filtered lorebook context (knowledge hardening)
- Responses aggregate back to GM for narrative weaving
- **Result**: 4 NPCs in ~3 seconds, with structural knowledge isolation

## Installation

1. Navigate to your SillyTavern extensions directory:
   ```
   SillyTavern/data/default-user/extensions/third-party/
   ```

2. Clone this repository:
   ```bash
   git clone https://github.com/your-repo/SillyTavern-Ensemble.git
   ```

3. Restart SillyTavern

4. Enable the extension in **Extensions** > **Ensemble**

## Quick Start

1. **Enable Extension**: Check "Enable Ensemble" in extension settings

2. **Configure Tier Profiles**: Assign ST Connection Profiles to each tier:
   - **orchestrator**: Your best model (Claude Opus, GPT-4)
   - **major**: High-quality model for important NPCs (Claude Sonnet)
   - **standard**: Balanced model for regular NPCs (Gemini Flash)
   - **minor**: Fast model for one-off NPCs (Gemini Flash minimal)
   - **utility**: Fast model for Judge/Guardian sub-agents

3. **Set Up Fallback Chains**: Add multiple profiles per tier for reliability:
   - Drag to reorder priority
   - If first profile is rate-limited, automatically tries next

4. **Use Slash Commands**:
   ```
   /ensemble spawn          - Generate responses from scene NPCs
   /ensemble spawn Harley   - Generate response from specific NPC
   /ensemble status         - Show rate limit status
   /ensemble stop           - Abort pending generation
   /ensemble clear          - Clear rate limit state
   ```

## Tier Configuration

### Fallback Chains

Configure multiple profiles per tier for graceful degradation:

```
Orchestrator: [Claude Opus] → [Claude Sonnet] → [GPT-4]
Major:        [Claude Sonnet] → [Gemini Pro]
Standard:     [Gemini Flash] → [OpenRouter Free]
Minor:        [Local LLM] → [OpenRouter Free]
Utility:      [Gemini Flash] → [Local LLM]
```

**Ordering Guidance**: Place models with larger context windows first. When rate-limited, the extension falls back to the next profile.

### Dynamic Tier Inference

Characters are automatically assigned tiers based on:
- Lorebook entry count (knowledge complexity)
- Character card length (backstory depth)
- Conversation history (recurring presence)

Override inference via:
- **Session override**: Use Tier Debugger (temporary, lost on refresh)
- **Card override**: Save to character card (permanent)

### Tier Debugger

Click **Inspect Tiers** in settings to:
- View all characters with their inferred tiers
- Override tiers temporarily (session) or permanently (card)
- See source of each tier assignment (inferred/session/card)

## Function Tools

The extension registers these function tools for the GM/Narrator:

### `spawn_npc_responses`

Generate dialogue/reactions from multiple NPCs in parallel.

```javascript
{
  npcs: ["Harley", "Thug1", "Thug2"],  // Character names
  situation: "The player reveals their true form",
  format: "full"  // "dialogue", "action", or "full"
}
```

### `query_npc_knowledge`

Check what a specific NPC knows about a topic (uses knowledge hardening).

```javascript
{
  npc_id: "Harley",
  topic: "symbiote"
}
```

### `resolve_action`

Resolve a mechanical action via the Judge sub-agent.

```javascript
{
  actor: "Player",
  action: "Attempt to intimidate the guards",
  context: { difficulty: "hard" }
}
```

### `audit_narrative`

Guardian audit of a narrative against a mechanical verdict.

```javascript
{
  verdict: { success: true, outcome: "Guards flee" },
  narrative: "The guards stand their ground..."
}
```

## Slash Commands

| Command | Description |
|---------|-------------|
| `/ensemble spawn [npcs...]` | Generate NPC responses (defaults to scene characters) |
| `/ensemble status` | Show rate limit status per profile |
| `/ensemble clear` | Clear all rate limit state |
| `/ensemble stop` | Abort pending generation (keeps completed) |

## Knowledge Hardening

NPCs only see lorebook entries they have access to. Use SillyTavern's **Character Filter** on lorebook entries:

### Example Setup

1. **Common Knowledge** (no filter):
   ```
   Entry: "The warehouse is abandoned"
   Character Filter: (empty)  // Everyone knows
   ```

2. **Restricted Knowledge** (include filter):
   ```
   Entry: "The secret passage behind the bookshelf"
   Character Filter: [Harley, Joker]  // Only these characters know
   ```

3. **False Beliefs**:
   ```
   Entry: "The player is just a human vigilante"
   Character Filter: [Thug1, Thug2]  // Thugs believe this (incorrectly)
   ```

### Scene State

Create a constant lorebook entry with key `ensemble_scene_state`:

```json
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

## Troubleshooting

### "No NPCs specified"

- Ensure characters exist in SillyTavern with matching names
- Check that `ensemble_scene_state` lorebook entry lists `present_npcs`

### Rate Limits

- Use `/ensemble status` to check which profiles are limited
- Use `/ensemble clear` to reset rate limit state
- Configure fallback chains for automatic failover

### Local Models

The extension supports local backends (Oobabooga, KoboldCPP, etc.):
- Configure them as ST Connection Profiles
- Assign to minor/utility tiers for cost savings
- No TTFT timeouts—local models with cold starts are supported

### Generation Aborted

- Use `/ensemble stop` to intentionally abort
- Completed responses are preserved
- Aborted NPCs are filtered from results (not shown as failures)

## Architecture

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
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                    BACKEND ROUTER                           │
│  Dynamic tier inference → Fallback chain iteration          │
│  Rate limit tracking per profile with exponential backoff   │
└─────────────────────────────────────────────────────────────┘
```

## License

MIT

## Credits

Ported from the **Riven-Eidolon** RPG framework sub-agent architecture.
