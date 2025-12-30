# SillyTavern API Reference

Technical reference for extension development, compiled from official documentation.

## Sources

- [UI Extensions](https://docs.sillytavern.app/for-contributors/writing-extensions/)
- [Function Calling](https://docs.sillytavern.app/for-contributors/function-calling/)
- [World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)
- [Connection Profiles](https://docs.sillytavern.app/usage/core-concepts/connection-profiles/)
- [STscript Reference](https://docs.sillytavern.app/usage/st-script/)

---

## Extension manifest.json

```json
{
  "display_name": "Extension Name",
  "author": "Author Name",
  "js": "index.js",
  "css": "styles.css",
  "loading_order": 100,
  "auto_update": true,
  "generate_interceptor": "myInterceptorFunction",
  "dependencies": ["other-extension-folder"]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `display_name` | Yes | Shown in Manage Extensions menu |
| `js` | Yes | Main entry point file |
| `author` | Yes | Author name/contact |
| `css` | No | Stylesheet file |
| `loading_order` | No | Higher = loads later (affects interceptor order) |
| `generate_interceptor` | No | Global function name for generation hooks |
| `dependencies` | No | Array of required extension folder names |

---

## getContext() API

```javascript
const context = SillyTavern.getContext();
```

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `chat` | Array | Chat messages (mutable) |
| `characters` | Array | Available characters list |
| `characterId` | Number/undefined | Current character index (undefined in groups) |
| `groups` | Array | Group chat list |
| `groupId` | String/undefined | Current group ID |
| `extensionSettings` | Object | Persistent extension data storage |
| `chatMetadata` | Object | Current chat's arbitrary metadata |
| `eventSource` | Object | Event emission/listening system |
| `event_types` | Object | Available event constants |

### Functions

```javascript
// Persist extension settings
context.saveSettingsDebounced();

// Persist chat metadata
context.saveMetadata();

// Store data in character card
context.writeExtensionField(characterId, key, value);

// Access API preset data
context.getPresetManager();

// Background generation with chat context
const result = await context.generateQuietPrompt({
  quietPrompt: 'instruction text',
  jsonSchema: optionalSchema
});

// Raw generation without context
const result = await context.generateRaw({
  systemPrompt: 'system instruction',
  prompt: 'user prompt',
  prefill: 'assistant response start',
  jsonSchema: optionalSchema
});

// Custom macros
context.registerMacro(name, value);
context.unregisterMacro(name);

// Check function calling support
context.isToolCallingSupported();

// Register/unregister function tools
context.registerFunctionTool(toolConfig);
context.unregisterFunctionTool(toolName);
```

---

## Event System

```javascript
const { eventSource, event_types } = SillyTavern.getContext();

// Listen for events
eventSource.on(event_types.MESSAGE_RECEIVED, (data) => {
  console.log('New message:', data);
});

// Emit custom events
eventSource.emit('MY_CUSTOM_EVENT', data);
```

### Available Events

| Event | Description |
|-------|-------------|
| `APP_READY` | App fully loaded (auto-fires on new listeners) |
| `MESSAGE_RECEIVED` | LLM message generated, recorded but not rendered |
| `MESSAGE_SENT` | User message recorded but not rendered |
| `USER_MESSAGE_RENDERED` | User message displayed |
| `CHARACTER_MESSAGE_RENDERED` | LLM message displayed |
| `CHAT_CHANGED` | Active chat switched |
| `GENERATION_AFTER_COMMANDS` | Generation starting post-slash commands |
| `GENERATION_STOPPED` | User stopped generation |
| `GENERATION_ENDED` | Generation completed/errored |
| `SETTINGS_UPDATED` | App settings changed |
| `WORLDINFO_SCAN_DONE` | Lorebook scan complete (mutable state) |
| `GROUP_WRAPPER_STARTED` | Before group character generation loop |
| `GROUP_WRAPPER_FINISHED` | After all group characters complete |

---

## Accessing Character Data

```javascript
const { characters, characterId } = SillyTavern.getContext();

// Current character (undefined in group chats)
const currentChar = characters[characterId];

// Character extension data
const myData = currentChar?.data?.extensions?.my_extension_key;

// Write to character card
context.writeExtensionField(characterId, 'my_extension_key', { foo: 'bar' });
```

### Character Object Structure

```javascript
{
  name: "Character Name",
  description: "Character description text",
  personality: "Personality traits",
  scenario: "Scenario text",
  first_mes: "First message",
  mes_example: "Example dialogue",
  data: {
    extensions: {
      // Extension-specific data stored here
      ensemble: {
        tier: "major",
        model: "claude-sonnet"
      }
    }
  }
}
```

---

## Accessing Chat Messages

```javascript
const { chat } = SillyTavern.getContext();

chat.forEach(msg => {
  console.log(msg.mes);      // Message content
  console.log(msg.name);     // Speaker name
  console.log(msg.is_user);  // Boolean: user or character
});

// Messages are mutable - modifications affect chat history
```

---

## Function Tool Registration

```javascript
SillyTavern.getContext().registerFunctionTool({
  name: "uniqueToolName",
  displayName: "User-Facing Name",
  description: "What the tool does and when to use it",
  parameters: {
    $schema: "http://json-schema.org/draft-04/schema#",
    type: 'object',
    properties: {
      paramName: {
        type: 'string',
        description: 'Parameter description'
      }
    },
    required: ['paramName']
  },
  action: async (params) => {
    // Tool execution logic
    return result;
  },
  formatMessage: (params) => {
    // Optional toast message
    return `Processing ${params.paramName}...`;
  },
  shouldRegister: () => {
    // Conditional registration
    return true;
  },
  stealth: false  // true hides from chat history
});

// Deregister
SillyTavern.getContext().unregisterFunctionTool("toolName");
```

**Supported providers:** OpenAI, Claude, MistralAI, Groq, Cohere, OpenRouter, AI21, Google AI Studio, Google Vertex AI, DeepSeek

---

## World Info / Lorebook

### Entry Fields (via STscript)

| Field | Description |
|-------|-------------|
| `content` | The text inserted into prompt |
| `comment` | Entry title/memo |
| `key` | Primary trigger keywords |
| `keysecondary` | Secondary/optional filter keywords |
| `constant` | Always active (boolean) |
| `disable` | Entry disabled (boolean) |
| `order` | Insertion priority |
| `probability` | Activation chance (0-100) |
| `depth` | Chat depth for insertion |
| `position` | Insertion position |
| `characterFilterNames` | Character name filter list |
| `characterFilterExclude` | Invert filter (exclude mode) |
| `characterFilterTags` | Tag-based filtering |

### STscript Commands

```javascript
// Get chat-bound lorebook name
/getchatbook

// Find entry UID by field value
/findentry file=bookName field=key searchText

// Get entry field value
/getentryfield file=bookName field=content 123

// Set entry field value
/setentryfield file=bookName uid=123 field=content newValue

// Create new entry
/createentry file=bookName key=myKey content text here
```

### Programmatic Access (Extension)

World Info entries can be accessed via the `WORLDINFO_SCAN_DONE` event which provides mutable state:

```javascript
const { eventSource, event_types } = SillyTavern.getContext();

eventSource.on(event_types.WORLDINFO_SCAN_DONE, (activatedEntries) => {
  // activatedEntries contains entries that matched current context
  // This is mutable - can filter/modify before insertion
});
```

---

## Connection Profiles

### Slash Commands

```javascript
// Switch profile or get current name
/profile [name]

// Create new profile from current settings
/profile-create [name]

// List all profiles (returns JSON array)
/profile-list

// Get profile details as JSON
/profile-get [name]

// Update current profile with settings
/profile-update
```

### Profile Data Stored

- API type, model selection, server URL
- Authentication credentials
- Settings preset references
- Reply formatting options
- System prompt state, Instruct Mode template
- Context template, tokenizer selection

**Note:** Profiles store dropdown selections only, not underlying preset data.

---

## Prompt Interceptors

Define in manifest: `"generate_interceptor": "myInterceptor"`

```javascript
globalThis.myInterceptor = async function(chat, contextSize, abort, type) {
  // chat: mutable message array
  // contextSize: token count for generation
  // abort(stopOthers): function to prevent generation
  // type: 'quiet', 'regenerate', 'impersonate', etc.

  // Example: inject system message
  const systemMessage = {
    role: 'system',
    content: 'Additional context here'
  };
  chat.splice(chat.length - 1, 0, systemMessage);
};
```

Execution order determined by `loading_order` (lower runs first).

---

## Shared Libraries

```javascript
const {
  lodash,       // Utility functions
  localforage,  // IndexedDB abstraction
  Fuse,         // Fuzzy search
  DOMPurify,    // HTML sanitization
  Handlebars,   // Templating
  moment,       // Date/time
  showdown      // Markdown conversion
} = SillyTavern.libs;
```

---

## Slash Command Registration

```javascript
SlashCommandParser.addCommandObject(SlashCommand.fromProps({
  name: 'mycommand',
  callback: (namedArgs, unnamedArgs) => {
    // Command logic
    return result;
  },
  namedArgumentList: [
    SlashCommandNamedArgument.fromProps({
      name: 'argname',
      description: 'Argument description',
      typeList: [ARGUMENT_TYPE.STRING],
      isRequired: false
    })
  ],
  helpString: 'Command documentation'
}));
```

---

## Best Practices

### Security
- Never store API keys in `extensionSettings` (accessible to all extensions)
- Avoid `eval()` and `Function()` constructors
- Sanitize user input with `DOMPurify`

### Performance
- Use `localforage` for large data
- Clean up event listeners on unload
- Yield UI thread: `await new Promise(r => setTimeout(r, 0))`

### Compatibility
- Prefer `getContext()` over direct imports
- Use unique module names to prevent conflicts
- Check for feature support before using

### UX
- Use `toastr` for notifications
- Console log with module name prefix
- Integrate with existing ST UI patterns

---

## Ensemble-Specific Findings

### Remaining Questions Answered

1. **Lorebook Filtering API**: Use `WORLDINFO_SCAN_DONE` event for activated entries. For full iteration, may need to access via STscript commands or internal APIs (needs further research).

2. **Character Card Extension Data**: Confirmed path is `card.data.extensions.ensemble` - use `writeExtensionField()` to persist.

3. **Connection Profile Access**: Use `/profile-get [name]` slash command to retrieve profile as JSON. For programmatic switching, use `/profile [name]`.

### Generation Approach

For parallel generation bypassing `generateRaw()` queue:
- Use `generateRaw()` for single requests (respects ST's API handling)
- For true parallelism, need to make direct fetch calls to the API endpoints
- Connection profile data can be retrieved via `/profile-get` to get endpoint/model info
